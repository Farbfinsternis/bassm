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
let _tseSelectedTile = -1;  // currently selected tile index (-1 = none)
let _tseTileTypes  = null;  // Uint8Array(tile_count), 0–255 per tile (T5.3)
let _tseTileLabels = [];    // string[] per tile, IDE-only (not saved to .tset)
let _tseTileColl   = null;  // Uint8Array(tile_count), collision bitmask per tile (T6.2)
let _tseAnimGroups = [];    // { startIndex, frameCount, speed }[] (T9.1)
let _tseAnimTimer  = null;  // setInterval id for animation preview
let _tseSlopeData  = new Map();  // Map<tileIndex, Uint8Array(tileSize)> — heightmaps (T10.2)
let _tseSlopeDrag  = false;

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

// T6.6: Draw a small directional arrow at (x,y) rotated by angle
function _tseDrawArrow(ctx, x, y, angle, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.6);
    ctx.lineTo(-size * 0.4, size * 0.3);
    ctx.lineTo(size * 0.4, size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

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

    // Reset type + collision + animation + slope state for new import
    _tseTileTypes  = new Uint8Array(nTiles);
    _tseTileLabels = new Array(nTiles).fill('');
    _tseTileColl   = new Uint8Array(nTiles);
    _tseAnimGroups = [];
    _tseSlopeData  = new Map();
    _tseSelectedTile = -1;
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

    // T6.6: Collision overlay
    if (_tseTileColl) {
        const cellW = ts * scale;
        const cellH = ts * scale;
        for (let i = 0; i < _tseTileCount; i++) {
            const c = _tseTileColl[i];
            if (!c) continue;
            const tc2 = i % cols;
            const tr2 = Math.floor(i / cols);
            const ox = gap + tc2 * (cellW + gap);
            const oy = gap + tr2 * (cellH + gap);

            if (c & 1) {
                // SOLID — red tint
                ctx.fillStyle = 'rgba(255,60,60,0.3)';
                ctx.fillRect(ox, oy, cellW, cellH);
                ctx.fillStyle = '#ff4444';
                ctx.font = `bold ${Math.max(8, cellW * 0.35)}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('S', ox + cellW / 2, oy + cellH / 2);
            } else {
                // PASS arrows (Bits 1–4)
                ctx.fillStyle = 'rgba(100,180,255,0.25)';
                if (c & 0x1E) ctx.fillRect(ox, oy, cellW, cellH);
                const arrowSize = Math.max(4, cellW * 0.22);
                const cx2 = ox + cellW / 2;
                const cy2 = oy + cellH / 2;
                ctx.fillStyle = '#66bbff';
                if (c & 2)  _tseDrawArrow(ctx, cx2, oy + arrowSize,          0, arrowSize); // UP
                if (c & 4)  _tseDrawArrow(ctx, cx2, oy + cellH - arrowSize,  Math.PI, arrowSize); // DOWN
                if (c & 8)  _tseDrawArrow(ctx, ox + arrowSize,          cy2, -Math.PI / 2, arrowSize); // LEFT
                if (c & 16) _tseDrawArrow(ctx, ox + cellW - arrowSize,  cy2,  Math.PI / 2, arrowSize); // RIGHT
            }

            if (c & 32) {
                // SLOPE — yellow diagonal line
                ctx.strokeStyle = '#ffcc00';
                ctx.lineWidth = Math.max(1, cellW * 0.08);
                ctx.beginPath();
                ctx.moveTo(ox + 1, oy + cellH - 1);
                ctx.lineTo(ox + cellW - 1, oy + 1);
                ctx.stroke();
            }
        }
    }

    // T5.2: Selection highlight
    if (_tseSelectedTile >= 0 && _tseSelectedTile < _tseTileCount) {
        const sc = _tseSelectedTile % cols;
        const sr = Math.floor(_tseSelectedTile / cols);
        const sx = gap + sc * (ts * scale + gap);
        const sy = gap + sr * (ts * scale + gap);
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth   = 2;
        ctx.strokeRect(sx - 1, sy - 1, ts * scale + 2, ts * scale + 2);
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

    _tseUpdateTypeUI();
}

// ── T5.1: Tile Type UI ──────────────────────────────────────────────────────

function _tseUpdateTypeUI() {
    const valInput   = document.getElementById('tse-type-value');
    const labelInput = document.getElementById('tse-type-label');
    const indexSpan  = document.getElementById('tse-prop-index');

    if (_tseSelectedTile < 0 || !_tseTileTypes) {
        valInput.disabled   = true;
        labelInput.disabled = true;
        valInput.value      = 0;
        labelInput.value    = '';
        indexSpan.textContent = '—';
        return;
    }

    indexSpan.textContent   = _tseSelectedTile;
    valInput.disabled       = false;
    labelInput.disabled     = false;
    valInput.value          = _tseTileTypes[_tseSelectedTile];
    labelInput.value        = _tseTileLabels[_tseSelectedTile] || '';

    _tseUpdateCollUI();
}

// ── T6.1: Collision Flags UI ────────────────────────────────────────────────

const _tseCollIds = [
    'tse-coll-solid',      // Bit 0
    'tse-coll-pass-up',    // Bit 1
    'tse-coll-pass-down',  // Bit 2
    'tse-coll-pass-left',  // Bit 3
    'tse-coll-pass-right', // Bit 4
    'tse-coll-slope',      // Bit 5
];

function _tseUpdateCollUI() {
    const noSel = _tseSelectedTile < 0 || !_tseTileColl;
    const val   = noSel ? 0 : _tseTileColl[_tseSelectedTile];
    const solid = !!(val & 1);

    for (let bit = 0; bit < _tseCollIds.length; bit++) {
        const cb    = document.getElementById(_tseCollIds[bit]);
        cb.checked  = !!(val & (1 << bit));
        cb.disabled = noSel;
        // PASS bits (1–4) disabled when SOLID is active
        const label = cb.parentElement;
        if (bit >= 1 && bit <= 4) {
            label.classList.toggle('tse-coll-disabled', solid && !noSel);
        }
    }

    // T10.1: Show slope heightmap editor only when SLOPE flag (bit 5) is set
    const showSlope = !noSel && !!(val & 32);
    document.getElementById('tse-slope-section').style.display = showSlope ? '' : 'none';
    if (showSlope) _tseSlopeRender();
}

// ── T10.2: Slope Heightmap Editor ───────────────────────────────────────────

function _tseSlopeRender() {
    const canvas = document.getElementById('tse-slope-canvas');
    const idx = _tseSelectedTile;
    if (idx < 0 || !_tseIndices) return;

    const ts    = _tseTileSize;
    const scale = ts <= 8 ? 16 : ts <= 16 ? 8 : 4;
    const size  = ts * scale;
    canvas.width  = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Draw tile enlarged
    const cols  = Math.floor(_tseWidth / ts);
    const tc    = idx % cols;
    const tr    = Math.floor(idx / cols);
    const imgBuf = new ImageData(ts, ts);
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
    const tmp = document.createElement('canvas');
    tmp.width = ts; tmp.height = ts;
    tmp.getContext('2d').putImageData(imgBuf, 0, 0);
    ctx.drawImage(tmp, 0, 0, size, size);

    // Column grid
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (let x = 1; x < ts; x++) {
        const px = x * scale + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, size);
        ctx.stroke();
    }

    // Heightmap overlay
    const hm = _tseSlopeData.get(idx);
    if (!hm) return;

    // Fill ground area
    ctx.fillStyle = 'rgba(255,204,0,0.3)';
    for (let col = 0; col < ts; col++) {
        const h = hm[col];
        if (h <= 0) continue;
        ctx.fillRect(col * scale, (ts - h) * scale, scale, h * scale);
    }

    // Surface line
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let col = 0; col < ts; col++) {
        const x = col * scale + scale / 2;
        const y = (ts - hm[col]) * scale;
        if (col === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function _tseSlopeSetColumn(e) {
    const canvas = document.getElementById('tse-slope-canvas');
    const idx = _tseSelectedTile;
    if (idx < 0 || !_tseIndices) return;

    const ts    = _tseTileSize;
    const rect  = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const my = (e.clientY - rect.top)  * (canvas.height / rect.height);

    const scale = canvas.width / ts;
    const col = Math.floor(mx / scale);
    if (col < 0 || col >= ts) return;

    const h = Math.max(0, Math.min(ts, ts - Math.floor(my / scale)));

    if (!_tseSlopeData.has(idx)) _tseSlopeData.set(idx, new Uint8Array(ts));
    _tseSlopeData.get(idx)[col] = h;
    _tseSlopeRender();
}

// ── T9.1: Animation Groups UI ───────────────────────────────────────────────

function _tseRenderAnimList() {
    const list = document.getElementById('tse-anim-list');
    list.innerHTML = '';
    const addBtn = document.getElementById('tse-anim-add');
    addBtn.disabled = !_tseTileCount;

    for (let i = 0; i < _tseAnimGroups.length; i++) {
        const g = _tseAnimGroups[i];
        const div = document.createElement('div');
        div.className = 'tse-anim-group';

        const header = document.createElement('div');
        header.className = 'tse-anim-group-header';
        header.innerHTML = `<span>Group ${i}</span>`;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'tse-anim-group-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
            _tseAnimGroups.splice(i, 1);
            _tseRenderAnimList();
            _tseRender();
        });
        header.appendChild(removeBtn);
        div.appendChild(header);

        // Start tile
        const startLabel = document.createElement('label');
        startLabel.textContent = 'Start ';
        const startInput = document.createElement('input');
        startInput.type = 'number';
        startInput.min = 0;
        startInput.max = _tseTileCount - 1;
        startInput.value = g.startIndex;
        startInput.addEventListener('change', (e) => {
            g.startIndex = Math.max(0, Math.min(_tseTileCount - 1, parseInt(e.target.value) || 0));
            e.target.value = g.startIndex;
        });
        startLabel.appendChild(startInput);
        div.appendChild(startLabel);

        // Frame count
        const countLabel = document.createElement('label');
        countLabel.textContent = 'Frames ';
        const countInput = document.createElement('input');
        countInput.type = 'number';
        countInput.min = 2;
        countInput.max = 255;
        countInput.value = g.frameCount;
        countInput.addEventListener('change', (e) => {
            const maxFrames = _tseTileCount - g.startIndex;
            g.frameCount = Math.max(2, Math.min(Math.min(255, maxFrames), parseInt(e.target.value) || 2));
            e.target.value = g.frameCount;
        });
        countLabel.appendChild(countInput);
        div.appendChild(countLabel);

        // Speed (VBlanks per frame)
        const speedLabel = document.createElement('label');
        speedLabel.textContent = 'Speed ';
        const speedInput = document.createElement('input');
        speedInput.type = 'number';
        speedInput.min = 1;
        speedInput.max = 255;
        speedInput.value = g.speed;
        speedInput.addEventListener('change', (e) => {
            g.speed = Math.max(1, Math.min(255, parseInt(e.target.value) || 5));
            e.target.value = g.speed;
        });
        speedLabel.appendChild(speedInput);
        div.appendChild(speedLabel);

        // Preview canvas
        const preview = document.createElement('div');
        preview.className = 'tse-anim-preview';
        const pCanvas = document.createElement('canvas');
        const pScale = _tseTileSize <= 8 ? 4 : _tseTileSize <= 16 ? 2 : 1;
        pCanvas.width  = _tseTileSize * pScale;
        pCanvas.height = _tseTileSize * pScale;
        pCanvas.dataset.groupIdx = i;
        preview.appendChild(pCanvas);
        div.appendChild(preview);

        list.appendChild(div);
    }

    _tseStartAnimPreview();
}

function _tseStartAnimPreview() {
    if (_tseAnimTimer) { clearInterval(_tseAnimTimer); _tseAnimTimer = null; }
    if (!_tseAnimGroups.length || !_tseIndices) return;

    const frameCounts = new Uint8Array(_tseAnimGroups.length); // current frame per group
    _tseAnimTimer = setInterval(() => {
        const canvases = document.querySelectorAll('.tse-anim-preview canvas');
        for (let gi = 0; gi < _tseAnimGroups.length; gi++) {
            const g = _tseAnimGroups[gi];
            const c = canvases[gi];
            if (!c) continue;

            frameCounts[gi] = (frameCounts[gi] + 1) % g.frameCount;
            const tileIdx = g.startIndex + frameCounts[gi];
            if (tileIdx >= _tseTileCount) continue;

            _tseDrawTileToCanvas(c, tileIdx);
        }
    }, 100); // ~10fps preview
}

function _tseDrawTileToCanvas(canvas, tileIdx) {
    const ts    = _tseTileSize;
    const cols  = Math.floor(_tseWidth / ts);
    const tc    = tileIdx % cols;
    const tr    = Math.floor(tileIdx / cols);
    const scale = ts <= 8 ? 4 : ts <= 16 ? 2 : 1;

    const imgBuf = new ImageData(ts, ts);
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
    const tmp = document.createElement('canvas');
    tmp.width = ts; tmp.height = ts;
    tmp.getContext('2d').putImageData(imgBuf, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, ts * scale, ts * scale);
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
            _tseRenderAnimList();
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

    // T5.4 / T6.3 / T9.3 / T10.4: Check if optional sections needed
    let flags = 0;
    const hasTypes = _tseTileTypes && _tseTileTypes.some(v => v !== 0);
    const hasColl  = _tseTileColl  && _tseTileColl.some(v => v !== 0);
    const hasAnim  = _tseAnimGroups.length > 0;
    // T10.4: Only include slopes for tiles that still have SLOPE flag (bit 5)
    const slopeEntries = [..._tseSlopeData.entries()].filter(([idx]) =>
        _tseTileColl && (_tseTileColl[idx] & 32));
    const hasSlopes = slopeEntries.length > 0;
    if (hasTypes)  flags |= 1;
    if (hasColl)   flags |= 2;
    if (hasAnim)   flags |= 4;
    if (hasSlopes) flags |= 8;

    const imageEnd   = 12 + paletteSize + planes.length;
    const typesPad   = hasTypes && (tileCount & 1) ? 1 : 0;
    const typesSize  = hasTypes ? tileCount + typesPad : 0;
    const collPad    = hasColl  && (tileCount & 1) ? 1 : 0;
    const collSize   = hasColl  ? tileCount + collPad : 0;
    const animSize   = hasAnim  ? 2 + _tseAnimGroups.length * 4 : 0;
    const slopesSize = hasSlopes ? 2 + slopeEntries.length * (2 + tileSize) : 0;
    const totalSize  = imageEnd + typesSize + collSize + animSize + slopesSize;

    const buf  = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);

    buf[0] = 0x54; buf[1] = 0x53; buf[2] = 0x45; buf[3] = 0x54; // "TSET"
    buf[4] = 1;                          // version
    buf[5] = tileSize;                   // tile_size
    view.setUint16(6, tileCount, false); // tile_count (BE)
    buf[8] = depth;                      // depth
    buf[9] = flags;                      // flags
    view.setUint16(10, 0, false);        // reserved

    for (let i = 0; i < colorCount; i++) {
        view.setUint16(12 + i * 2, palette[i] & 0x0FFF, false);
    }
    buf.set(planes, 12 + paletteSize);

    // T5.4: Append TYPES section
    if (hasTypes) {
        buf.set(_tseTileTypes.subarray(0, tileCount), imageEnd);
    }

    // T6.3: Append COLLISION section
    if (hasColl) {
        buf.set(_tseTileColl.subarray(0, tileCount), imageEnd + typesSize);
    }

    // T9.3: Append ANIMATION section
    if (hasAnim) {
        let off = imageEnd + typesSize + collSize;
        view.setUint16(off, _tseAnimGroups.length, false);
        off += 2;
        for (const g of _tseAnimGroups) {
            view.setUint16(off, g.startIndex, false);
            buf[off + 2] = g.frameCount;
            buf[off + 3] = g.speed;
            off += 4;
        }
    }

    // T10.4: Append SLOPES section
    if (hasSlopes) {
        let off = imageEnd + typesSize + collSize + animSize;
        view.setUint16(off, slopeEntries.length, false);
        off += 2;
        for (const [tileIdx, hm] of slopeEntries) {
            view.setUint16(off, tileIdx, false);
            off += 2;
            buf.set(hm.subarray(0, tileSize), off);
            off += tileSize;
        }
    }

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
    const flags     = buf[9];

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

    // T5.1/T5.3: Load TYPES section if present (flags Bit 0)
    _tseTileTypes  = new Uint8Array(tileCount);
    _tseTileLabels = new Array(tileCount).fill('');
    _tseTileColl   = new Uint8Array(tileCount);
    _tseAnimGroups = [];
    _tseSlopeData  = new Map();
    _tseSelectedTile = -1;
    let metaOffset = imgOffset + imageSize;
    if (flags & 1) {
        if (buf.length >= metaOffset + tileCount) {
            _tseTileTypes.set(buf.subarray(metaOffset, metaOffset + tileCount));
        }
        metaOffset += tileCount + (tileCount & 1 ? 1 : 0);
    }
    // T6.2: Load COLLISION section if present (flags Bit 1)
    if (flags & 2) {
        if (buf.length >= metaOffset + tileCount) {
            _tseTileColl.set(buf.subarray(metaOffset, metaOffset + tileCount));
        }
        metaOffset += tileCount + (tileCount & 1 ? 1 : 0);
    }
    // T9.1: Load ANIMATION section if present (flags Bit 2)
    if (flags & 4) {
        const view2 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (buf.length >= metaOffset + 2) {
            const groupCount = view2.getUint16(metaOffset, false);
            metaOffset += 2;
            for (let g = 0; g < groupCount && metaOffset + 4 <= buf.length; g++) {
                const startIndex = view2.getUint16(metaOffset, false);
                const frameCount = buf[metaOffset + 2];
                const speed      = buf[metaOffset + 3];
                _tseAnimGroups.push({ startIndex, frameCount, speed });
                metaOffset += 4;
            }
        }
    }

    // T10.3: Load SLOPES section if present (flags Bit 3)
    if (flags & 8) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (buf.length >= metaOffset + 2) {
            const slopeCount = dv.getUint16(metaOffset, false);
            metaOffset += 2;
            for (let s = 0; s < slopeCount; s++) {
                if (metaOffset + 2 + tileSize > buf.length) break;
                const tileIdx = dv.getUint16(metaOffset, false);
                metaOffset += 2;
                const hm = new Uint8Array(tileSize);
                hm.set(buf.subarray(metaOffset, metaOffset + tileSize));
                _tseSlopeData.set(tileIdx, hm);
                metaOffset += tileSize;
            }
        }
    }

    // Sync UI controls
    document.getElementById('tse-sel-tilesize').value = tileSize;
    document.getElementById('tse-sel-depth').value    = depth;

    document.getElementById('tse-status').textContent =
        `${filename} — ${tileCount} tiles, ${tileSize}×${tileSize}, ${depth}bpp`;

    _tseRender();
    _tseRenderAnimList();
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

// T9.1 — Add animation group
document.getElementById('tse-anim-add').addEventListener('click', () => {
    const start = _tseSelectedTile >= 0 ? _tseSelectedTile : 0;
    _tseAnimGroups.push({ startIndex: start, frameCount: 2, speed: 5 });
    _tseRenderAnimList();
});

// T5.1 — Type value + label inputs
document.getElementById('tse-type-value').addEventListener('change', (e) => {
    if (_tseSelectedTile < 0 || !_tseTileTypes) return;
    _tseTileTypes[_tseSelectedTile] = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
    e.target.value = _tseTileTypes[_tseSelectedTile];
});

document.getElementById('tse-type-label').addEventListener('input', (e) => {
    if (_tseSelectedTile < 0) return;
    _tseTileLabels[_tseSelectedTile] = e.target.value;
});

// T6.1 — Collision flag checkboxes
for (let bit = 0; bit < _tseCollIds.length; bit++) {
    document.getElementById(_tseCollIds[bit]).addEventListener('change', (e) => {
        if (_tseSelectedTile < 0 || !_tseTileColl) return;
        if (e.target.checked) {
            _tseTileColl[_tseSelectedTile] |= (1 << bit);
        } else {
            _tseTileColl[_tseSelectedTile] &= ~(1 << bit);
            // T10.3: Remove slope data when SLOPE flag (bit 5) is cleared
            if (bit === 5) _tseSlopeData.delete(_tseSelectedTile);
        }
        _tseUpdateCollUI();
    });
}

// T10.2 — Slope heightmap canvas: click/drag to draw
const _tseSlopeCanvas = document.getElementById('tse-slope-canvas');
_tseSlopeCanvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _tseSlopeDrag = true;
    _tseSlopeSetColumn(e);
});
_tseSlopeCanvas.addEventListener('mousemove', (e) => {
    if (!_tseSlopeDrag) return;
    _tseSlopeSetColumn(e);
});
window.addEventListener('mouseup', () => { _tseSlopeDrag = false; });

// T5.2 — Tile selection via click on canvas
document.getElementById('tse-canvas').addEventListener('click', (e) => {
    if (!_tseIndices || _tseTileCount === 0) return;
    const canvas = e.target;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;

    const ts    = _tseTileSize;
    const cols  = Math.floor(_tseWidth / ts);
    const scale = ts <= 8 ? 4 : ts <= 16 ? 2 : 1;
    const gap   = 1;
    const cellW = ts * scale + gap;
    const cellH = ts * scale + gap;

    const tc = Math.floor((cx - gap) / cellW);
    const tr = Math.floor((cy - gap) / cellH);
    if (tc < 0 || tr < 0 || tc >= cols) { _tseSelectedTile = -1; _tseUpdateTypeUI(); return; }

    const idx = tr * cols + tc;
    if (idx >= _tseTileCount) { _tseSelectedTile = -1; _tseUpdateTypeUI(); return; }

    _tseSelectedTile = idx;
    _tseRender();
});

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
    if (_tseImageData) { _tseQuantise(); _tseRender(); _tseRenderAnimList(); }
});

document.getElementById('tse-sel-depth').addEventListener('change', (e) => {
    _tseDepth = parseInt(e.target.value);
    if (_tseImageData) { _tseQuantise(); _tseRender(); _tseRenderAnimList(); }
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
