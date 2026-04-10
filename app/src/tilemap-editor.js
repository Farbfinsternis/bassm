'use strict';

// ── Tilemap Editor (T4.4) ───────────────────────────────────────────────────
//
// Visual tilemap editor in the main panel. Loads/saves .bmap files,
// imports CSV, renders a paintable tile grid, and shows a tile palette
// from a loaded .tset tileset.
//
// .bmap format (big-endian):
//   +0  dc.w  map_width      (tiles across)
//   +2  dc.w  map_height     (tiles down)
//   +4  dc.w  tile_w         (pixels)
//   +6  dc.w  tile_h         (pixels)
//   +8  dc.w  tile_index[0]  ... tile_index[map_w * map_h - 1]

// ── State ────────────────────────────────────────────────────────────────────

let _tmapMapW      = 0;       // tiles across
let _tmapMapH      = 0;       // tiles down
let _tmapTileW     = 16;      // px
let _tmapTileH     = 16;      // px
let _tmapGrid      = null;    // Uint16Array — map_w * map_h tile indices
let _tmapDirty     = false;

// Tileset state
let _tmapTsetPalette   = [];      // OCS $0RGB words (up to 32)
let _tmapTsetTileCount = 0;
let _tmapTsetTileSize  = 16;
let _tmapTsetDepth     = 3;
let _tmapTsetIndices   = null;    // Uint8Array — all tiles stacked vertically (tile_w × totalH)
let _tmapTsetFilename  = '';

let _tmapSelectedTile  = 0;       // currently selected tile index for painting
let _tmapPainting      = false;   // mouse is down on map canvas

let _tmapProjectDir    = null;
let _tmapFilename      = '';      // current .bmap filename (for save)
let _tmapSourceDir     = '';

// ── Map Zoom & Pan state ────────────────────────────────────────────────────
let _tmapZoom = 1;
let _tmapPanX = 0;
let _tmapPanY = 0;
let _tmapPanning = false;
let _tmapPanStartX = 0;
let _tmapPanStartY = 0;
let _tmapPanOriginX = 0;
let _tmapPanOriginY = 0;

// ── Tile Ghost (hover preview) state ────────────────────────────────────────
let _tmapGhostX = -1;
let _tmapGhostY = -1;

function _tmapApplyTransform() {
    const t = `translate(${_tmapPanX}px, ${_tmapPanY}px) scale(${_tmapZoom})`;
    document.getElementById('tmap-canvas-map').style.transform = t;
    document.getElementById('tmap-canvas-ghost').style.transform = t;
}

function _tmapCenterCanvas() {
    const area = document.getElementById('tmap-map-scroll');
    const canvas = document.getElementById('tmap-canvas-map');
    const rect = area.getBoundingClientRect();
    _tmapZoom = 1;
    _tmapPanX = Math.round((rect.width  - canvas.width)  / 2);
    _tmapPanY = Math.round((rect.height - canvas.height) / 2);
    _tmapApplyTransform();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _tmapOcsToRgb(ocs) {
    return [((ocs >> 8) & 0xF) * 17, ((ocs >> 4) & 0xF) * 17, (ocs & 0xF) * 17];
}

function _tmapLog(msg, level) {
    if (window.logLine) window.logLine(`[Tilemap] ${msg}`, level || 'info');
}

// ── Tileset Loading (.tset) ──────────────────────────────────────────────────

function _tmapParseTset(buf) {
    if (buf.length < 12) throw new Error('File too small for .tset header');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (buf[0] !== 0x54 || buf[1] !== 0x53 || buf[2] !== 0x45 || buf[3] !== 0x54)
        throw new Error('Not a valid .tset file (bad magic)');
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
    const palette = new Array(32).fill(0);
    for (let i = 0; i < colorCount; i++) {
        palette[i] = view.getUint16(palOffset + i * 2, false);
    }

    // Decode interleaved planar → indexed pixels (tiles stacked vertically)
    const totalH  = tileCount * tileSize;
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

    return { palette, tileCount, tileSize, depth, indices };
}

async function _tmapLoadTsetFromProject(relativePath) {
    if (!_tmapProjectDir) return;
    const bytes = await window.electronAPI.readAsset({
        projectDir: _tmapProjectDir, path: relativePath
    });
    const buf  = new Uint8Array(bytes);
    const name = relativePath.replace(/\\/g, '/').split('/').pop();
    _tmapApplyTileset(_tmapParseTset(buf), name);
}

async function _tmapLoadTsetDialog() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.tset';
    return new Promise(resolve => {
        input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) { resolve(false); return; }
            try {
                const arrayBuf = await file.arrayBuffer();
                const buf = new Uint8Array(arrayBuf);
                _tmapApplyTileset(_tmapParseTset(buf), file.name);
                resolve(true);
            } catch (err) {
                _tmapSetStatus(`Error: ${err.message}`);
                _tmapLog(`Load tileset failed: ${err.message}`, 'error');
                resolve(false);
            }
        });
        input.click();
    });
}

function _tmapApplyTileset(tset, filename) {
    _tmapTsetPalette   = tset.palette;
    _tmapTsetTileCount = tset.tileCount;
    _tmapTsetTileSize  = tset.tileSize;
    _tmapTsetDepth     = tset.depth;
    _tmapTsetIndices   = tset.indices;
    _tmapTsetFilename  = filename;
    _tmapSelectedTile  = 0;

    document.getElementById('tmap-tile-palette').classList.add('has-tileset');
    document.getElementById('tmap-btn-edit-tileset').disabled = false;

    _tmapRenderTilePalette();
    if (_tmapGrid) _tmapRenderMap();
    _tmapUpdateProps();
    _tmapSetStatus(`Tileset: ${filename} — ${tset.tileCount} tiles, ${tset.tileSize}×${tset.tileSize}, ${tset.depth}bpp`);
    _tmapLog(`Loaded tileset ${filename} (${tset.tileCount} tiles, ${tset.tileSize}px, ${tset.depth}bpp)`);
}

// ── Tile Palette Rendering ───────────────────────────────────────────────────

function _tmapTilePaletteLayout() {
    const ts  = _tmapTsetTileSize;
    const gap = 2;
    const cols = 2;
    // Scale so 2 tiles + 3 gaps fit the palette width
    const paletteEl = document.getElementById('tmap-tileset-drop');
    const availW = (paletteEl ? paletteEl.clientWidth : 148) - 8; // minus padding
    const scale = Math.max(1, Math.floor((availW - gap * (cols + 1)) / (cols * ts)));
    return { ts, gap, cols, scale };
}

function _tmapRenderTilePalette() {
    if (!_tmapTsetIndices || _tmapTsetTileCount === 0) return;

    const canvas = document.getElementById('tmap-canvas-tileset');
    const { ts, gap, cols, scale } = _tmapTilePaletteLayout();
    const rows   = Math.ceil(_tmapTsetTileCount / cols);
    const cw     = cols * (ts * scale + gap) + gap;
    const ch     = rows * (ts * scale + gap) + gap;

    canvas.width  = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, cw, ch);

    const tileBuf = new ImageData(ts, ts);
    const tmp     = document.createElement('canvas');
    tmp.width = ts; tmp.height = ts;
    const tmpCtx = tmp.getContext('2d');

    for (let t = 0; t < _tmapTsetTileCount; t++) {
        const tileBase = t * ts * ts;
        for (let py = 0; py < ts; py++) {
            for (let px = 0; px < ts; px++) {
                const idx = _tmapTsetIndices[tileBase + py * ts + px];
                const [r, g, b] = _tmapOcsToRgb(_tmapTsetPalette[idx] || 0);
                const off = (py * ts + px) * 4;
                tileBuf.data[off]     = r;
                tileBuf.data[off + 1] = g;
                tileBuf.data[off + 2] = b;
                tileBuf.data[off + 3] = 255;
            }
        }
        tmpCtx.putImageData(tileBuf, 0, 0);

        const col = t % cols;
        const row = Math.floor(t / cols);
        const dx  = gap + col * (ts * scale + gap);
        const dy  = gap + row * (ts * scale + gap);

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, dx, dy, ts * scale, ts * scale);

        // Highlight selected tile
        if (t === _tmapSelectedTile) {
            ctx.strokeStyle = '#7ac5ff';
            ctx.lineWidth   = 2;
            ctx.strokeRect(dx - 1, dy - 1, ts * scale + 2, ts * scale + 2);
        }
    }
}

function _tmapTilePaletteClick(e) {
    if (!_tmapTsetIndices || _tmapTsetTileCount === 0) return;
    const canvas = document.getElementById('tmap-canvas-tileset');
    const rect   = canvas.getBoundingClientRect();
    const mx     = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my     = (e.clientY - rect.top) * (canvas.height / rect.height);

    const { ts, gap, cols, scale } = _tmapTilePaletteLayout();
    const cell  = ts * scale + gap;

    const col = Math.floor((mx - gap) / cell);
    const row = Math.floor((my - gap) / cell);
    const idx = row * cols + col;

    if (idx >= 0 && idx < _tmapTsetTileCount) {
        _tmapSelectedTile = idx;
        _tmapRenderTilePalette();
    }
}

// ── Map Grid Rendering ───────────────────────────────────────────────────────

function _tmapRenderMap() {
    if (!_tmapGrid) return;

    const canvas = document.getElementById('tmap-canvas-map');
    const tw     = _tmapTileW;
    const th     = _tmapTileH;
    const mw     = _tmapMapW;
    const mh     = _tmapMapH;
    const cw     = mw * tw;
    const ch     = mh * th;

    canvas.width  = cw;
    canvas.height = ch;
    const ghost = document.getElementById('tmap-canvas-ghost');
    ghost.width  = cw;
    ghost.height = ch;
    _tmapGhostX = -1;
    _tmapGhostY = -1;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, cw, ch);

    const hasTileset = _tmapTsetIndices && _tmapTsetTileCount > 0;

    if (hasTileset) {
        // Render tiles from tileset
        const ts   = _tmapTsetTileSize;
        const tile = new ImageData(ts, ts);
        const tmp  = document.createElement('canvas');
        tmp.width = ts; tmp.height = ts;
        const tmpCtx = tmp.getContext('2d');

        ctx.imageSmoothingEnabled = false;

        for (let my = 0; my < mh; my++) {
            for (let mx = 0; mx < mw; mx++) {
                const tileIdx = _tmapGrid[my * mw + mx];
                if (tileIdx >= _tmapTsetTileCount) continue;

                const tileBase = tileIdx * ts * ts;
                for (let py = 0; py < ts; py++) {
                    for (let px = 0; px < ts; px++) {
                        const ci  = _tmapTsetIndices[tileBase + py * ts + px];
                        const [r, g, b] = _tmapOcsToRgb(_tmapTsetPalette[ci] || 0);
                        const off = (py * ts + px) * 4;
                        tile.data[off]     = r;
                        tile.data[off + 1] = g;
                        tile.data[off + 2] = b;
                        tile.data[off + 3] = 255;
                    }
                }
                tmpCtx.putImageData(tile, 0, 0);
                ctx.drawImage(tmp, mx * tw, my * th, tw, th);
            }
        }
    } else {
        // No tileset — render tile indices as numbers
        ctx.font      = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let my = 0; my < mh; my++) {
            for (let mx = 0; mx < mw; mx++) {
                const idx = _tmapGrid[my * mw + mx];
                if (idx > 0) {
                    ctx.fillStyle = '#334';
                    ctx.fillRect(mx * tw, my * th, tw, th);
                    ctx.fillStyle = '#8af';
                    ctx.fillText(idx, mx * tw + tw / 2, my * th + th / 2);
                }
            }
        }
    }

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (let x = 0; x <= mw; x++) {
        ctx.moveTo(x * tw + 0.5, 0);
        ctx.lineTo(x * tw + 0.5, ch);
    }
    for (let y = 0; y <= mh; y++) {
        ctx.moveTo(0, y * th + 0.5);
        ctx.lineTo(cw, y * th + 0.5);
    }
    ctx.stroke();
}

// ── Tile Ghost (hover preview) ───────────────────────────────────────────────

function _tmapRenderGhost(gx, gy) {
    const ghost = document.getElementById('tmap-canvas-ghost');
    const gctx  = ghost.getContext('2d');

    // Clear previous ghost
    if (_tmapGhostX >= 0 && _tmapGhostY >= 0) {
        gctx.clearRect(
            _tmapGhostX * _tmapTileW, _tmapGhostY * _tmapTileH,
            _tmapTileW, _tmapTileH
        );
    }

    _tmapGhostX = gx;
    _tmapGhostY = gy;

    if (gx < 0 || gy < 0) return;
    if (!_tmapTsetIndices || _tmapSelectedTile >= _tmapTsetTileCount) return;

    const ts       = _tmapTsetTileSize;
    const tileBase = _tmapSelectedTile * ts * ts;
    const tile     = new ImageData(ts, ts);

    for (let py = 0; py < ts; py++) {
        for (let px = 0; px < ts; px++) {
            const ci  = _tmapTsetIndices[tileBase + py * ts + px];
            const [r, g, b] = _tmapOcsToRgb(_tmapTsetPalette[ci] || 0);
            const off = (py * ts + px) * 4;
            tile.data[off]     = r;
            tile.data[off + 1] = g;
            tile.data[off + 2] = b;
            tile.data[off + 3] = 178; // ~70% opacity
        }
    }

    const tmp = document.createElement('canvas');
    tmp.width = ts; tmp.height = ts;
    tmp.getContext('2d').putImageData(tile, 0, 0);

    gctx.imageSmoothingEnabled = false;
    gctx.drawImage(tmp, gx * _tmapTileW, gy * _tmapTileH, _tmapTileW, _tmapTileH);
}

function _tmapClearGhost() {
    _tmapRenderGhost(-1, -1);
}

// ── Map Painting ─────────────────────────────────────────────────────────────

function _tmapMapCoords(e) {
    const canvas = document.getElementById('tmap-canvas-map');
    const rect   = canvas.getBoundingClientRect();
    const sx     = canvas.width / rect.width;
    const sy     = canvas.height / rect.height;
    const px     = (e.clientX - rect.left) * sx;
    const py     = (e.clientY - rect.top) * sy;
    const mx     = Math.floor(px / _tmapTileW);
    const my     = Math.floor(py / _tmapTileH);
    if (mx < 0 || mx >= _tmapMapW || my < 0 || my >= _tmapMapH) return null;
    return { mx, my };
}

function _tmapPaintTile(mx, my) {
    if (!_tmapGrid) return;
    const idx = my * _tmapMapW + mx;
    if (_tmapGrid[idx] === _tmapSelectedTile) return;
    _tmapGrid[idx] = _tmapSelectedTile;
    _tmapDirty = true;
    _tmapRenderMap();
    _tmapUpdateProps();
    _tmapEnableSave();
}

function _tmapOnMapMouseDown(e) {
    if (!_tmapGrid) return;
    if (e.button === 1) {
        // Middle-click: start panning
        e.preventDefault();
        _tmapPanning = true;
        _tmapPanStartX = e.clientX;
        _tmapPanStartY = e.clientY;
        _tmapPanOriginX = _tmapPanX;
        _tmapPanOriginY = _tmapPanY;
        document.getElementById('tmap-map-scroll').style.cursor = 'grabbing';
        return;
    }
    if (e.button === 2) {
        // Right-click: pick tile under cursor
        const c = _tmapMapCoords(e);
        if (c) {
            _tmapSelectedTile = _tmapGrid[c.my * _tmapMapW + c.mx];
            _tmapRenderTilePalette();
        }
        e.preventDefault();
        return;
    }
    if (e.button !== 0) return;
    _tmapPainting = true;
    const c = _tmapMapCoords(e);
    if (c) _tmapPaintTile(c.mx, c.my);
}

function _tmapOnMapMouseMove(e) {
    if (_tmapPanning) {
        _tmapPanX = _tmapPanOriginX + (e.clientX - _tmapPanStartX);
        _tmapPanY = _tmapPanOriginY + (e.clientY - _tmapPanStartY);
        _tmapApplyTransform();
        return;
    }
    const c = _tmapMapCoords(e);
    if (c) {
        if (c.mx !== _tmapGhostX || c.my !== _tmapGhostY) {
            _tmapRenderGhost(c.mx, c.my);
        }
        if (_tmapPainting) _tmapPaintTile(c.mx, c.my);
    } else {
        _tmapClearGhost();
    }
}

function _tmapOnMapMouseUp(e) {
    if (_tmapPanning && (!e || e.button === 1)) {
        _tmapPanning = false;
        document.getElementById('tmap-map-scroll').style.cursor = '';
        return;
    }
    _tmapPainting = false;
}

// ── New Tilemap ──────────────────────────────────────────────────────────────

function tmapNewMap() {
    _tmapMapW  = parseInt(document.getElementById('tmap-inp-mapw').value) || 20;
    _tmapMapH  = parseInt(document.getElementById('tmap-inp-maph').value) || 15;
    _tmapTileW = parseInt(document.getElementById('tmap-sel-tilew').value) || 16;
    _tmapTileH = parseInt(document.getElementById('tmap-sel-tileh').value) || 16;
    _tmapGrid  = new Uint16Array(_tmapMapW * _tmapMapH);
    _tmapDirty = false;
    _tmapFilename = '';

    document.getElementById('tmap-placeholder').style.display = 'none';
    document.getElementById('tmap-map-scroll').style.display  = '';

    _tmapRenderMap();
    _tmapCenterCanvas();
    _tmapUpdateProps();
    _tmapEnableSave();
    _tmapSetStatus(`New tilemap ${_tmapMapW}×${_tmapMapH} (${_tmapTileW}×${_tmapTileH}px tiles)`);
    _tmapLog(`Created new tilemap ${_tmapMapW}×${_tmapMapH}`);
}

// ── .bmap Load ───────────────────────────────────────────────────────────────

function _tmapParseBmap(buf) {
    if (buf.length < 8) throw new Error('File too small for .bmap header');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const mapW  = view.getUint16(0, false);
    const mapH  = view.getUint16(2, false);
    const tileW = view.getUint16(4, false);
    const tileH = view.getUint16(6, false);

    if (mapW === 0 || mapH === 0) throw new Error(`Invalid map dimensions ${mapW}×${mapH}`);
    if (tileW === 0 || tileH === 0) throw new Error(`Invalid tile dimensions ${tileW}×${tileH}`);

    const dataSize = mapW * mapH * 2;
    if (buf.length < 8 + dataSize) throw new Error('File truncated — expected ' + (8 + dataSize) + ' bytes');

    const grid = new Uint16Array(mapW * mapH);
    for (let i = 0; i < mapW * mapH; i++) {
        grid[i] = view.getUint16(8 + i * 2, false);
    }

    return { mapW, mapH, tileW, tileH, grid };
}

async function tmapOpenFile(relativePath, projectDir) {
    _tmapProjectDir = projectDir;
    const name       = relativePath.replace(/\\/g, '/').split('/').pop();
    const normalized = relativePath.replace(/\\/g, '/');
    const slashIdx   = normalized.lastIndexOf('/');
    _tmapSourceDir   = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';

    _tmapSetStatus(`Loading ${name}\u2026`);

    try {
        const bytes = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        const buf   = new Uint8Array(bytes);
        const bmap  = _tmapParseBmap(buf);

        _tmapMapW     = bmap.mapW;
        _tmapMapH     = bmap.mapH;
        _tmapTileW    = bmap.tileW;
        _tmapTileH    = bmap.tileH;
        _tmapGrid     = bmap.grid;
        _tmapDirty    = false;
        _tmapFilename = name;

        // Sync UI controls
        document.getElementById('tmap-inp-mapw').value    = bmap.mapW;
        document.getElementById('tmap-inp-maph').value    = bmap.mapH;
        document.getElementById('tmap-sel-tilew').value   = bmap.tileW;
        document.getElementById('tmap-sel-tileh').value   = bmap.tileH;

        document.getElementById('tmap-placeholder').style.display = 'none';
        document.getElementById('tmap-map-scroll').style.display  = '';

        _tmapRenderMap();
        _tmapCenterCanvas();
        _tmapUpdateProps();
        _tmapEnableSave();
        _tmapSetStatus(`${name} — ${bmap.mapW}×${bmap.mapH} tiles, ${bmap.tileW}×${bmap.tileH}px`);
        _tmapLog(`Opened ${name} (${bmap.mapW}×${bmap.mapH}, ${bmap.tileW}×${bmap.tileH}px)`);
    } catch (err) {
        _tmapSetStatus(`Error: ${err.message}`);
        _tmapLog(`Failed to load '${name}': ${err.message}`, 'error');
    }
}

// ── .bmap Save ───────────────────────────────────────────────────────────────

function _tmapBuildBmapBinary() {
    const size = 8 + _tmapMapW * _tmapMapH * 2;
    const buf  = new Uint8Array(size);
    const view = new DataView(buf.buffer);

    view.setUint16(0, _tmapMapW, false);
    view.setUint16(2, _tmapMapH, false);
    view.setUint16(4, _tmapTileW, false);
    view.setUint16(6, _tmapTileH, false);

    for (let i = 0; i < _tmapMapW * _tmapMapH; i++) {
        view.setUint16(8 + i * 2, _tmapGrid[i], false);
    }
    return buf;
}

async function _tmapSave() {
    if (!_tmapGrid) return;

    const raw = _tmapBuildBmapBinary();
    const defaultName = _tmapFilename || 'tilemap.bmap';
    const defaultPath = [
        _tmapProjectDir ? _tmapProjectDir.replace(/\\/g, '/') : null,
        _tmapSourceDir || null,
        defaultName,
    ].filter(Boolean).join('/');

    const result = await window.electronAPI.saveAssetWithDialog({
        defaultPath,
        filters: [{ name: 'BASSM Tilemap', extensions: ['bmap'] }],
        data: Array.from(raw),
    });

    if (!result.saved) return;

    _tmapFilename = result.filePath.replace(/.*[/\\]/, '');
    _tmapDirty = false;
    _tmapSetStatus(`Saved: ${_tmapFilename}`);
    _tmapLog(`Saved ${_tmapFilename} (${raw.length} bytes)`);
}

// ── CSV Import ───────────────────────────────────────────────────────────────

function _tmapParseCSV(text) {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    const rows  = lines.map(line =>
        line.split(/[,;\t]+/).map(v => parseInt(v.trim())).filter(v => !isNaN(v))
    );
    if (rows.length === 0) throw new Error('CSV is empty');

    const mapH = rows.length;
    const mapW = Math.max(...rows.map(r => r.length));
    if (mapW === 0) throw new Error('CSV has no valid columns');

    const grid = new Uint16Array(mapW * mapH);
    for (let y = 0; y < mapH; y++) {
        for (let x = 0; x < rows[y].length; x++) {
            grid[y * mapW + x] = Math.max(0, rows[y][x]);
        }
    }
    return { mapW, mapH, grid };
}

async function _tmapImportCSV() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.csv,.txt';
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const csv  = _tmapParseCSV(text);

            _tmapMapW  = csv.mapW;
            _tmapMapH  = csv.mapH;
            _tmapTileW = parseInt(document.getElementById('tmap-sel-tilew').value) || 16;
            _tmapTileH = parseInt(document.getElementById('tmap-sel-tileh').value) || 16;
            _tmapGrid  = csv.grid;
            _tmapDirty = true;
            _tmapFilename = file.name.replace(/\.[^.]+$/, '') + '.bmap';

            document.getElementById('tmap-inp-mapw').value = csv.mapW;
            document.getElementById('tmap-inp-maph').value = csv.mapH;

            document.getElementById('tmap-placeholder').style.display = 'none';
            document.getElementById('tmap-map-scroll').style.display  = '';

            _tmapRenderMap();
            _tmapCenterCanvas();
            _tmapUpdateProps();
            _tmapEnableSave();
            _tmapSetStatus(`Imported CSV: ${csv.mapW}×${csv.mapH} tiles from ${file.name}`);
            _tmapLog(`Imported CSV ${file.name} → ${csv.mapW}×${csv.mapH}`);
        } catch (err) {
            _tmapSetStatus(`CSV Error: ${err.message}`);
            _tmapLog(`CSV import failed: ${err.message}`, 'error');
        }
    });
    input.click();
}

// ── Copy Code ────────────────────────────────────────────────────────────────

function _tmapCopyCode() {
    if (!_tmapGrid) return;
    const name = _tmapFilename || 'tilemap.bmap';
    const code = [
        `LoadTileset 0, "tiles.tset", ${_tmapTileW}, ${_tmapTileH}`,
        `LoadTilemap 0, "${name}"`,
        `SetTilemap 0, 0`,
        `DrawTilemap 0, 0, scrollX, scrollY`,
    ].join('\n');
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('tmap-btn-copy-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// ── Properties & Budget ──────────────────────────────────────────────────────

function _tmapUpdateProps() {
    const el = (id) => document.getElementById(id);

    if (_tmapGrid) {
        el('tmap-prop-mapsize').textContent  = `${_tmapMapW} × ${_tmapMapH}`;
        el('tmap-prop-tilesize').textContent = `${_tmapTileW} × ${_tmapTileH} px`;

        // Count unique tile indices
        const unique = new Set(_tmapGrid).size;
        el('tmap-prop-unique').textContent = unique;

        // Map data size: 8-byte header + map_w * map_h * 2
        const mapBytes = 8 + _tmapMapW * _tmapMapH * 2;
        el('tmap-prop-mapdata').textContent = mapBytes < 1024
            ? `${mapBytes} B` : `${(mapBytes / 1024).toFixed(1)} KB`;
    } else {
        el('tmap-prop-mapsize').innerHTML  = '&mdash;';
        el('tmap-prop-tilesize').innerHTML = '&mdash;';
        el('tmap-prop-unique').innerHTML   = '&mdash;';
        el('tmap-prop-mapdata').innerHTML  = '&mdash;';
    }

    if (_tmapTsetFilename) {
        el('tmap-prop-tileset').textContent   = _tmapTsetFilename;
        el('tmap-prop-tilecount').textContent = _tmapTsetTileCount;

        // Chip RAM: tileset image data + palette
        const rowbytes    = Math.ceil(_tmapTsetTileSize / 16) * 2;
        const paletteSize = (1 << _tmapTsetDepth) * 2;
        const imageSize   = _tmapTsetTileCount * _tmapTsetTileSize * rowbytes * _tmapTsetDepth;
        const mapBytes    = _tmapGrid ? 8 + _tmapMapW * _tmapMapH * 2 : 0;
        const chipBytes   = paletteSize + imageSize + mapBytes;

        el('tmap-prop-chip').textContent = `${(chipBytes / 1024).toFixed(1)} KB`;
        el('tmap-prop-pct').textContent  = `${(chipBytes / (512 * 1024) * 100).toFixed(1)}%`;
    } else {
        el('tmap-prop-tileset').innerHTML   = '&mdash;';
        el('tmap-prop-tilecount').innerHTML = '&mdash;';
        el('tmap-prop-chip').innerHTML      = '&mdash;';
        el('tmap-prop-pct').innerHTML       = '&mdash;';
    }
}

// ── UI Helpers ───────────────────────────────────────────────────────────────

function _tmapSetStatus(msg) {
    document.getElementById('tmap-status').textContent = msg;
}

function _tmapEnableSave() {
    document.getElementById('tmap-btn-save').disabled      = !_tmapGrid;
    document.getElementById('tmap-btn-save-bmap').disabled  = !_tmapGrid;
    document.getElementById('tmap-btn-copy-code').disabled  = !_tmapGrid;
}

// ── Dimension Change (resize map) ────────────────────────────────────────────

function _tmapResizeMap() {
    if (!_tmapGrid) return;

    const newW = parseInt(document.getElementById('tmap-inp-mapw').value) || _tmapMapW;
    const newH = parseInt(document.getElementById('tmap-inp-maph').value) || _tmapMapH;
    if (newW === _tmapMapW && newH === _tmapMapH) return;

    const newGrid = new Uint16Array(newW * newH);
    const copyW   = Math.min(_tmapMapW, newW);
    const copyH   = Math.min(_tmapMapH, newH);
    for (let y = 0; y < copyH; y++) {
        for (let x = 0; x < copyW; x++) {
            newGrid[y * newW + x] = _tmapGrid[y * _tmapMapW + x];
        }
    }

    _tmapMapW  = newW;
    _tmapMapH  = newH;
    _tmapGrid  = newGrid;
    _tmapDirty = true;

    _tmapRenderMap();
    _tmapUpdateProps();
    _tmapSetStatus(`Resized to ${newW}×${newH}`);
}

function _tmapUpdateTileSize() {
    _tmapTileW = parseInt(document.getElementById('tmap-sel-tilew').value) || 16;
    _tmapTileH = parseInt(document.getElementById('tmap-sel-tileh').value) || 16;
    if (_tmapGrid) {
        _tmapRenderMap();
        _tmapUpdateProps();
    }
}

// ── Tileset Sub-View Navigation ──────────────────────────────────────────────

let _tmapOpenedFromTilemap = false;

function _tmapNewTileset() {
    if (!window.switchView) return;
    _tmapOpenedFromTilemap = true;
    const backBtn = document.getElementById('tse-btn-back-tilemap');
    if (backBtn) backBtn.style.display = '';
    // Open tileset editor empty — user imports a PNG from there
    window.switchView('tileset-editor');
}

function _tmapEditTileset() {
    if (!window.switchView) return;
    _tmapOpenedFromTilemap = true;
    // Show the "Back to Tilemap" button in the tileset editor
    const backBtn = document.getElementById('tse-btn-back-tilemap');
    if (backBtn) backBtn.style.display = '';
    window.switchView('tileset-editor');
}

/**
 * Called by tileset-editor.js when returning to the tilemap editor.
 * If tsetData is provided, the tileset is reloaded into the tilemap editor.
 */
function tmapOnTilesetReturn(tsetData, filename) {
    _tmapOpenedFromTilemap = false;
    const backBtn = document.getElementById('tse-btn-back-tilemap');
    if (backBtn) backBtn.style.display = 'none';

    if (tsetData && filename) {
        _tmapApplyTileset(tsetData, filename);
    }
    if (window.switchView) window.switchView('tilemap-editor');
}

// ── Context Menu Prevention ──────────────────────────────────────────────────

function _tmapPreventCtx(e) { e.preventDefault(); }

// ── Event Wiring ─────────────────────────────────────────────────────────────

function initTilemapEditor() {
    // Toolbar buttons
    document.getElementById('tmap-btn-new').addEventListener('click', tmapNewMap);
    document.getElementById('tmap-btn-import-csv').addEventListener('click', _tmapImportCSV);
    document.getElementById('tmap-btn-save').addEventListener('click', _tmapSave);
    document.getElementById('tmap-btn-save-bmap').addEventListener('click', _tmapSave);
    document.getElementById('tmap-btn-copy-code').addEventListener('click', _tmapCopyCode);
    document.getElementById('tmap-btn-new-tileset').addEventListener('click', _tmapNewTileset);
    document.getElementById('tmap-btn-load-tileset').addEventListener('click', _tmapLoadTsetDialog);
    document.getElementById('tmap-btn-edit-tileset').addEventListener('click', _tmapEditTileset);

    // Tile palette click
    document.getElementById('tmap-canvas-tileset').addEventListener('click', _tmapTilePaletteClick);

    // Map canvas painting + pan
    const mapScroll = document.getElementById('tmap-map-scroll');
    const mapCanvas = document.getElementById('tmap-canvas-map');
    mapCanvas.addEventListener('mousedown', _tmapOnMapMouseDown);
    mapCanvas.addEventListener('mousemove', _tmapOnMapMouseMove);
    mapCanvas.addEventListener('mouseup', _tmapOnMapMouseUp);
    mapCanvas.addEventListener('mouseleave', e => {
        if (!_tmapPanning) _tmapPainting = false;
        _tmapClearGhost();
    });
    mapCanvas.addEventListener('contextmenu', _tmapPreventCtx);

    // Global pan tracking (mouse can leave canvas during drag)
    window.addEventListener('mousemove', e => {
        if (!_tmapPanning) return;
        _tmapPanX = _tmapPanOriginX + (e.clientX - _tmapPanStartX);
        _tmapPanY = _tmapPanOriginY + (e.clientY - _tmapPanStartY);
        _tmapApplyTransform();
    });
    window.addEventListener('mouseup', e => {
        if (e.button !== 1 || !_tmapPanning) return;
        _tmapPanning = false;
        mapScroll.style.cursor = '';
    });

    // Wheel zoom on map — zoom towards cursor
    mapScroll.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = mapScroll.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - _tmapPanX) / _tmapZoom;
        const wy = (my - _tmapPanY) / _tmapZoom;

        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        _tmapZoom = Math.min(32, Math.max(0.1, _tmapZoom * factor));

        _tmapPanX = mx - wx * _tmapZoom;
        _tmapPanY = my - wy * _tmapZoom;
        _tmapApplyTransform();
    }, { passive: false });

    // Middle-mouse pan on the scroll container (when clicking outside canvas)
    mapScroll.addEventListener('mousedown', e => {
        if (e.button !== 1 || !_tmapGrid) return;
        e.preventDefault();
        _tmapPanning = true;
        _tmapPanStartX = e.clientX;
        _tmapPanStartY = e.clientY;
        _tmapPanOriginX = _tmapPanX;
        _tmapPanOriginY = _tmapPanY;
        mapScroll.style.cursor = 'grabbing';
    });

    // Prevent default middle-click scroll behavior
    mapScroll.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

    // Dimension / tile-size changes
    document.getElementById('tmap-inp-mapw').addEventListener('change', _tmapResizeMap);
    document.getElementById('tmap-inp-maph').addEventListener('change', _tmapResizeMap);
    document.getElementById('tmap-sel-tilew').addEventListener('change', _tmapUpdateTileSize);
    document.getElementById('tmap-sel-tileh').addEventListener('change', _tmapUpdateTileSize);
}

// ── Exports ──────────────────────────────────────────────────────────────────

window.tmapOpenFile        = tmapOpenFile;
window.tmapNewMap          = tmapNewMap;
window.tmapOnTilesetReturn = tmapOnTilesetReturn;
window.initTilemapEditor   = initTilemapEditor;

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTilemapEditor);
} else {
    initTilemapEditor();
}
