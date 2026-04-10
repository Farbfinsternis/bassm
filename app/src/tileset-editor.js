'use strict';

// ── Tileset Editor (T4.3–T4.8) ──────────────────────────────────────────────
//
// Lives in the main renderer (index.html). Manages PNG import, tile-grid
// display, and .tset save/load.

// ── State ────────────────────────────────────────────────────────────────────
let _tseImageData  = null;   // raw ImageData from imported PNG
let _tseWidth      = 0;
let _tseHeight     = 0;
let _tsePalette    = new Array(32).fill(0);   // OCS $0RGB words
let _tseIndices    = null;   // quantised pixel → palette index (Uint8Array)
let _tseTileSize   = 16;
let _tseDepth      = 3;
let _tseTileCount  = 0;
let _tseFilename   = '';

// ── Zoom & Pan state ────────────────────────────────────────────────────────
let _tseZoom = 1;
let _tsePanX = 0;
let _tsePanY = 0;
let _tsePanning = false;
let _tsePanStartX = 0;
let _tsePanStartY = 0;
let _tsePanOriginX = 0;
let _tsePanOriginY = 0;

function _tseApplyTransform() {
    const canvas = document.getElementById('tse-canvas');
    canvas.style.transform = `translate(${_tsePanX}px, ${_tsePanY}px) scale(${_tseZoom})`;
}

function _tseResetView() {
    _tseZoom = 1;
    _tsePanX = 0;
    _tsePanY = 0;
    _tseApplyTransform();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _tseOcsToRgb(ocs) {
    return [((ocs >> 8) & 0xF) * 17, ((ocs >> 4) & 0xF) * 17, (ocs & 0xF) * 17];
}

function _tseLoadImageFile(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width  = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            resolve({
                imageData: c.getContext('2d').getImageData(0, 0, c.width, c.height),
                width:  img.naturalWidth,
                height: img.naturalHeight,
            });
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Decode failed')); };
        img.src = url;
    });
}

/**
 * Slice an indexed image into square tiles, stacked vertically.
 * Returns { stacked, nTiles, totalH }.
 */
function _tseSliceTiles(indices, imgW, imgH, tileSize) {
    const cols   = Math.floor(imgW / tileSize);
    const rows   = Math.floor(imgH / tileSize);
    const nTiles = cols * rows;
    const stacked = new Uint8Array(tileSize * nTiles * tileSize);
    let dst = 0;
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            for (let py = 0; py < tileSize; py++) {
                for (let px = 0; px < tileSize; px++) {
                    stacked[dst++] = indices[(tr * tileSize + py) * imgW + tc * tileSize + px];
                }
            }
        }
    }
    return { stacked, nTiles, totalH: nTiles * tileSize };
}

// ── Quantise + build tiles ───────────────────────────────────────────────────

function _tseQuantise() {
    if (!_tseImageData) return;
    const colorCount = Math.min(1 << _tseDepth, 32);

    // Generate OCS palette via median-cut (from image-quantizer.js, loaded globally)
    const generated = medianCutPalette(_tseImageData, colorCount);
    for (let i = 0; i < 32; i++) _tsePalette[i] = generated[i] ?? 0;

    // Quantise pixels to palette indices
    _tseIndices = quantizeWithDither(_tseImageData, _tsePalette, colorCount, 'none');

    // Slice into tiles
    const { nTiles } = _tseSliceTiles(_tseIndices, _tseWidth, _tseHeight, _tseTileSize);
    _tseTileCount = nTiles;
}

// ── Render tile grid on canvas ───────────────────────────────────────────────

function _tseRender() {
    if (!_tseIndices || _tseTileCount === 0) return;

    const canvas = document.getElementById('tse-canvas');
    const ts     = _tseTileSize;
    const cols   = Math.floor(_tseWidth / ts);
    const rows   = Math.floor(_tseHeight / ts);
    const gap    = 1;
    const scale  = ts <= 8 ? 4 : ts <= 16 ? 2 : 1;
    const cw     = cols * (ts * scale + gap) + gap;
    const ch     = rows * (ts * scale + gap) + gap;

    canvas.width  = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, cw, ch);

    // Draw each tile
    const imgBuf = ctx.createImageData(ts, ts);
    let tileIdx = 0;
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            // Fill tile ImageData from indices
            for (let py = 0; py < ts; py++) {
                for (let px = 0; px < ts; px++) {
                    const srcIdx = (tr * ts + py) * _tseWidth + tc * ts + px;
                    const [r, g, b] = _tseOcsToRgb(_tsePalette[_tseIndices[srcIdx]]);
                    const off = (py * ts + px) * 4;
                    imgBuf.data[off]     = r;
                    imgBuf.data[off + 1] = g;
                    imgBuf.data[off + 2] = b;
                    imgBuf.data[off + 3] = 255;
                }
            }
            // Draw tile to an offscreen canvas for scaling
            const tmp = document.createElement('canvas');
            tmp.width = ts; tmp.height = ts;
            tmp.getContext('2d').putImageData(imgBuf, 0, 0);

            const dx = gap + tc * (ts * scale + gap);
            const dy = gap + tr * (ts * scale + gap);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tmp, dx, dy, ts * scale, ts * scale);

            tileIdx++;
        }
    }

    _tseUpdateProps();
    _tseCenterCanvas();
}

function _tseCenterCanvas() {
    const area = document.getElementById('tse-canvas-area');
    const canvas = document.getElementById('tse-canvas');
    const rect = area.getBoundingClientRect();
    _tseZoom = 1;
    _tsePanX = Math.round((rect.width  - canvas.width)  / 2);
    _tsePanY = Math.round((rect.height - canvas.height) / 2);
    _tseApplyTransform();
}

// ── Update sidebar properties ────────────────────────────────────────────────

function _tseUpdateProps() {
    document.getElementById('tse-prop-count').textContent = _tseTileCount;

    const rowbytes    = Math.ceil(_tseTileSize / 16) * 2;
    const paletteSize = (1 << _tseDepth) * 2;
    const imageSize   = _tseTileCount * _tseTileSize * rowbytes * _tseDepth;
    const chipBytes   = paletteSize + imageSize;

    document.getElementById('tse-prop-imgsize').textContent = `${(chipBytes / 1024).toFixed(1)} KB`;
    document.getElementById('tse-budget-chip').textContent  = `${(chipBytes / 1024).toFixed(1)} KB`;
    document.getElementById('tse-budget-pct').textContent   = `${(chipBytes / (512 * 1024) * 100).toFixed(1)}%`;
}

// ── PNG Import ───────────────────────────────────────────────────────────────

async function _tseImportPng() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/bmp';
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const { imageData, width, height } = await _tseLoadImageFile(file);
            _tseImageData = imageData;
            _tseWidth     = width;
            _tseHeight    = height;
            _tseFilename  = file.name.replace(/\.[^.]+$/, '') + '.tset';

            document.getElementById('tse-status').textContent =
                `${file.name} — ${width} × ${height} px`;

            _tseQuantise();
            _tseRender();
            if (window.logLine) window.logLine(`[Tileset] Imported ${file.name} (${width}\u00d7${height}, ${_tseTileCount} tiles, ${_tseDepth}bpp)`, 'info');
        } catch (err) {
            document.getElementById('tse-status').textContent = `Error: ${err.message}`;
            if (window.logLine) window.logLine(`[Tileset] Import failed: ${err.message}`, 'error');
        }
    });
    input.click();
}

// ── Build .tset binary ───────────────────────────────────────────────────────

function _tseBuildBinary(palette, planes, tileSize, tileCount, depth) {
    const colorCount  = 1 << depth;
    const paletteSize = colorCount * 2;
    const totalSize   = 12 + paletteSize + planes.length;

    const buf  = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);

    buf[0] = 0x54; buf[1] = 0x53; buf[2] = 0x45; buf[3] = 0x54; // "TSET"
    buf[4] = 1;                          // version
    buf[5] = tileSize;                   // tile_size
    view.setUint16(6, tileCount, false); // tile_count (BE)
    buf[8] = depth;                      // depth
    buf[9] = 0;                          // flags
    view.setUint16(10, 0, false);        // reserved

    for (let i = 0; i < colorCount; i++) {
        view.setUint16(12 + i * 2, palette[i] & 0x0FFF, false);
    }
    buf.set(planes, 12 + paletteSize);

    return buf;
}

// ── toPlanarBitmapInterleaved (local copy) ───────────────────────────────────

function _tseToPlanar(indices, width, height, depth) {
    const rowbytes = Math.ceil(width / 16) * 2;
    const out = new Uint8Array(height * depth * rowbytes);
    for (let y = 0; y < height; y++) {
        for (let plane = 0; plane < depth; plane++) {
            const rowBase = (y * depth + plane) * rowbytes;
            for (let x = 0; x < width; x++) {
                if ((indices[y * width + x] >> plane) & 1) {
                    out[rowBase + (x >> 3)] |= 0x80 >> (x & 7);
                }
            }
        }
    }
    return out;
}

// ── Save .tset ───────────────────────────────────────────────────────────────

async function _tseSave() {
    if (!_tseIndices || _tseTileCount === 0) return;

    const { stacked, nTiles, totalH } = _tseSliceTiles(
        _tseIndices, _tseWidth, _tseHeight, _tseTileSize);
    const planes = _tseToPlanar(stacked, _tseTileSize, totalH, _tseDepth);
    const raw    = _tseBuildBinary(_tsePalette, planes, _tseTileSize, nTiles, _tseDepth);

    const result = await window.electronAPI.saveAssetWithDialog({
        defaultPath: _tseFilename,
        filters: [{ name: 'BASSM Tileset', extensions: ['tset'] }],
        data: Array.from(raw),
    });
    if (!result.saved) return;

    const savedName = result.filePath.replace(/.*[/\\]/, '');
    document.getElementById('tse-status').textContent = `Saved: ${savedName}`;
    if (window.logLine) {
        const rowbytes  = Math.ceil(_tseTileSize / 16) * 2;
        const chipBytes = (1 << _tseDepth) * 2 + nTiles * _tseTileSize * rowbytes * _tseDepth;
        window.logLine(`[Tileset] Saved ${savedName} (${nTiles} tiles, ${_tseTileSize}\u00d7${_tseTileSize}, ${_tseDepth}bpp, ${(chipBytes / 1024).toFixed(1)} KB)`, 'info');
    }
}

// ── Parse + apply .tset buffer ───────────────────────────────────────────────

function _tseApplyBuffer(buf, filename) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // Validate header
    if (buf.length < 12 ||
        buf[0] !== 0x54 || buf[1] !== 0x53 || buf[2] !== 0x45 || buf[3] !== 0x54) {
        throw new Error('Not a valid .tset file');
    }
    if (buf[4] !== 1) throw new Error(`Unsupported .tset version ${buf[4]}`);

    const tileSize  = buf[5];
    const tileCount = view.getUint16(6, false);
    const depth     = buf[8];

    if (![8, 16, 32].includes(tileSize)) throw new Error(`Invalid tile_size ${tileSize}`);
    if (depth < 1 || depth > 5) throw new Error(`Invalid depth ${depth}`);

    const colorCount  = 1 << depth;
    const paletteSize = colorCount * 2;
    const rowbytes    = Math.ceil(tileSize / 16) * 2;
    const imageSize   = tileCount * tileSize * rowbytes * depth;
    const palOffset   = 12;
    const imgOffset   = 12 + paletteSize;

    if (buf.length < imgOffset + imageSize) throw new Error('File truncated');

    // Extract palette
    for (let i = 0; i < 32; i++) _tsePalette[i] = 0;
    for (let i = 0; i < colorCount; i++) {
        _tsePalette[i] = view.getUint16(palOffset + i * 2, false);
    }

    // Decode interleaved planar → indexed pixels (one tile-wide column, all tiles stacked)
    const totalH = tileCount * tileSize;
    const indices = new Uint8Array(tileSize * totalH);
    for (let y = 0; y < totalH; y++) {
        for (let plane = 0; plane < depth; plane++) {
            const rowBase = imgOffset + (y * depth + plane) * rowbytes;
            for (let x = 0; x < tileSize; x++) {
                if ((buf[rowBase + (x >> 3)] >> (7 - (x & 7))) & 1) {
                    indices[y * tileSize + x] |= 1 << plane;
                }
            }
        }
    }

    // Reconstruct a grid-layout ImageData for display
    const gridCols = Math.max(1, Math.floor(Math.sqrt(tileCount)));
    const gridRows = Math.ceil(tileCount / gridCols);
    const imgW = gridCols * tileSize;
    const imgH = gridRows * tileSize;

    const gridIndices = new Uint8Array(imgW * imgH);
    for (let t = 0; t < tileCount; t++) {
        const gr = Math.floor(t / gridCols);
        const gc = t % gridCols;
        for (let py = 0; py < tileSize; py++) {
            for (let px = 0; px < tileSize; px++) {
                gridIndices[(gr * tileSize + py) * imgW + gc * tileSize + px] =
                    indices[t * tileSize * tileSize + py * tileSize + px];
            }
        }
    }

    // Build ImageData for _tseRender compatibility
    const imgData = new ImageData(imgW, imgH);
    for (let i = 0; i < gridIndices.length; i++) {
        const [r, g, b] = _tseOcsToRgb(_tsePalette[gridIndices[i]]);
        imgData.data[i * 4]     = r;
        imgData.data[i * 4 + 1] = g;
        imgData.data[i * 4 + 2] = b;
        imgData.data[i * 4 + 3] = 255;
    }

    // Update state
    _tseTileSize  = tileSize;
    _tseDepth     = depth;
    _tseTileCount = tileCount;
    _tseWidth     = imgW;
    _tseHeight    = imgH;
    _tseImageData = imgData;
    _tseIndices   = gridIndices;
    _tseFilename  = filename;

    // Sync UI controls
    document.getElementById('tse-sel-tilesize').value = tileSize;
    document.getElementById('tse-sel-depth').value    = depth;

    document.getElementById('tse-status').textContent =
        `${filename} — ${tileCount} tiles, ${tileSize}×${tileSize}, ${depth}bpp`;

    _tseRender();
}

// ── Load .tset (dialog) ──────────────────────────────────────────────────────

async function _tseLoad() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tset';
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const arrayBuf = await file.arrayBuffer();
            _tseApplyBuffer(new Uint8Array(arrayBuf), file.name);
            if (window.logLine) window.logLine(`[Tileset] Loaded ${file.name} (${_tseTileCount} tiles, ${_tseTileSize}\u00d7${_tseTileSize}, ${_tseDepth}bpp)`, 'info');
        } catch (err) {
            document.getElementById('tse-status').textContent = `Error: ${err.message}`;
            if (window.logLine) window.logLine(`[Tileset] Load failed: ${err.message}`, 'error');
        }
    });
    input.click();
}

// ── Open .tset from Project Tree ─────────────────────────────────────────────

async function tseOpenFromTree(relativePath, projectDir) {
    const name = relativePath.replace(/\\/g, '/').split('/').pop();
    document.getElementById('tse-status').textContent = `Loading ${name}\u2026`;

    // Hide Back button when opened standalone from tree
    document.getElementById('tse-btn-back-tilemap').style.display = 'none';

    try {
        const bytes = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        _tseApplyBuffer(new Uint8Array(bytes), name);
        if (window.logLine) window.logLine(`[Tileset] Opened ${name}`, 'info');
    } catch (err) {
        document.getElementById('tse-status').textContent = `Error: ${err.message}`;
        if (window.logLine) window.logLine(`[Tileset] Failed to load '${name}': ${err.message}`, 'error');
    }
}

window.tseOpenFromTree = tseOpenFromTree;

// ── Event wiring ─────────────────────────────────────────────────────────────

// Tileset editor is opened via double-click on .tset in the project tree
// (dispatched by _openFile → switchView('tileset-editor')).
// No dedicated toolbar button — will become a sub-view of the Tilemap Editor in Phase 4.

document.getElementById('tse-btn-import').addEventListener('click', _tseImportPng);
document.getElementById('tse-btn-load').addEventListener('click', _tseLoad);
document.getElementById('tse-btn-save').addEventListener('click', _tseSave);

// ── Back to Tilemap (Sub-View navigation) ────────────────────────────────────

function _tseGetCurrentTilesetData() {
    if (!_tseIndices || _tseTileCount === 0) return null;
    // Re-slice into stacked format for the tilemap editor
    const ts = _tseTileSize;
    const cols = Math.floor(_tseWidth / ts);
    const rows = Math.floor(_tseHeight / ts);
    const nTiles = cols * rows;
    const totalH = nTiles * ts;
    const stacked = new Uint8Array(ts * totalH);
    let dst = 0;
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            for (let py = 0; py < ts; py++) {
                for (let px = 0; px < ts; px++) {
                    stacked[dst++] = _tseIndices[(tr * ts + py) * _tseWidth + tc * ts + px];
                }
            }
        }
    }
    return {
        palette: [..._tsePalette],
        tileCount: nTiles,
        tileSize: ts,
        depth: _tseDepth,
        indices: stacked,
    };
}

document.getElementById('tse-btn-back-tilemap').addEventListener('click', () => {
    const data = _tseGetCurrentTilesetData();
    const name = _tseFilename || 'tileset.tset';
    if (window.tmapOnTilesetReturn) {
        window.tmapOnTilesetReturn(data, name);
    }
});

document.getElementById('tse-sel-tilesize').addEventListener('change', (e) => {
    _tseTileSize = parseInt(e.target.value);
    if (_tseImageData) { _tseQuantise(); _tseRender(); }
});

document.getElementById('tse-sel-depth').addEventListener('change', (e) => {
    _tseDepth = parseInt(e.target.value);
    if (_tseImageData) { _tseQuantise(); _tseRender(); }
});

// ── Zoom & Pan ──────────────────────────────────────────────────────────────

const _tseCanvasArea = document.getElementById('tse-canvas-area');

// Wheel zoom — zoom towards cursor position
_tseCanvasArea.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = _tseCanvasArea.getBoundingClientRect();
    // Cursor position relative to the container
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Point under cursor in pre-zoom canvas space
    const wx = (mx - _tsePanX) / _tseZoom;
    const wy = (my - _tsePanY) / _tseZoom;

    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    _tseZoom = Math.min(32, Math.max(0.1, _tseZoom * factor));

    // Adjust pan so the point under the cursor stays fixed
    _tsePanX = mx - wx * _tseZoom;
    _tsePanY = my - wy * _tseZoom;
    _tseApplyTransform();
}, { passive: false });

// Middle mouse pan
_tseCanvasArea.addEventListener('mousedown', e => {
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    _tsePanning = true;
    _tsePanStartX = e.clientX;
    _tsePanStartY = e.clientY;
    _tsePanOriginX = _tsePanX;
    _tsePanOriginY = _tsePanY;
    _tseCanvasArea.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', e => {
    if (!_tsePanning) return;
    _tsePanX = _tsePanOriginX + (e.clientX - _tsePanStartX);
    _tsePanY = _tsePanOriginY + (e.clientY - _tsePanStartY);
    _tseApplyTransform();
});

window.addEventListener('mouseup', e => {
    if (e.button !== 1 || !_tsePanning) return;
    _tsePanning = false;
    _tseCanvasArea.style.cursor = '';
});

// Prevent default middle-click scroll behavior in the canvas area
_tseCanvasArea.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
