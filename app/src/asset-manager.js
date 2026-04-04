'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _projectDir    = null;
let _palette       = new Array(32).fill(0);   // OCS words 0x000–0xFFF
let _paletteIsSet  = false;
let _imageData     = null;    // current ImageData from loaded PNG
let _imageWidth    = 0;
let _imageHeight   = 0;
let _imageFilename = '';
let _imageSourceDir = '';     // project-relative dir of the source PNG ('' = project root)
let _lastIndices   = null;    // quantized pixel → palette index
let _lastDepth     = 3;

// ── Tileset state ──────────────────────────────────────────────────────────────
let _tsImageData   = null;
let _tsWidth       = 0;
let _tsHeight      = 0;
let _tsFilename    = '';
let _tsLastIndices = null;
let _tsLastDepth   = 3;
let _tsRafHandle   = null;

// ── Tilemap state ──────────────────────────────────────────────────────────────
let _tmDetectedW = 0;
let _tmDetectedH = 0;

// rAF handle for debounced preview re-render
let _rafHandle = null;
function schedulePreview() {
    if (_rafHandle) cancelAnimationFrame(_rafHandle);
    _rafHandle = requestAnimationFrame(() => { _rafHandle = null; renderPreview(); });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn')  .forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
});

// ── Asset-tree group toggle ───────────────────────────────────────────────────
document.querySelectorAll('.group-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
        const items  = hdr.nextElementSibling;
        const toggle = hdr.querySelector('.toggle');
        const open   = items.style.display !== 'none';
        items.style.display = open ? 'none' : '';
        toggle.innerHTML    = open ? '&#9654;' : '&#9660;';
    });
});

// ── OCS colour helpers ────────────────────────────────────────────────────────
function ocsToRgb(ocs) {
    return [((ocs >> 8) & 0xF) * 17, ((ocs >> 4) & 0xF) * 17, (ocs & 0xF) * 17];
}

function rgb24ToOcs(r, g, b) {
    return (Math.round(r / 255 * 15) << 8)
         | (Math.round(g / 255 * 15) << 4)
         |  Math.round(b / 255 * 15);
}

// ── Palette UI ────────────────────────────────────────────────────────────────
(function initPaletteGrid() {
    const grid = document.getElementById('palette-grid');
    for (let i = 0; i < 32; i++) {
        const slot = document.createElement('div');
        slot.className      = 'palette-slot';
        slot.dataset.index  = i;
        slot.title          = `Color ${i}`;
        const idx = document.createElement('span');
        idx.className   = 'slot-index';
        idx.textContent = i;
        slot.appendChild(idx);
        slot.addEventListener('click', () => openColorPicker(i));
        grid.appendChild(slot);
    }
    updatePaletteUI();
})();

function updatePaletteUI() {
    document.querySelectorAll('.palette-slot').forEach((slot, i) => {
        const [r, g, b] = ocsToRgb(_palette[i]);
        slot.style.background = `rgb(${r},${g},${b})`;
        const hex = _palette[i].toString(16).padStart(3, '0').toUpperCase();
        slot.title = `Color ${i} — $${hex}`;
    });
}

function updateActiveSlots(depth) {
    const count = 1 << depth;
    document.querySelectorAll('.palette-slot').forEach((slot, i) => {
        slot.classList.toggle('slot-inactive', i >= count);
    });
}

function openColorPicker(index) {
    const [r, g, b] = ocsToRgb(_palette[index]);
    const toHex = n => n.toString(16).padStart(2, '0');
    const picker = document.createElement('input');
    picker.type  = 'color';
    picker.value = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

    picker.addEventListener('input', () => {
        const v  = picker.value;
        _palette[index] = rgb24ToOcs(
            parseInt(v.slice(1, 3), 16),
            parseInt(v.slice(3, 5), 16),
            parseInt(v.slice(5, 7), 16)
        );
        updatePaletteUI();
        if (_imageData) schedulePreview();
    });
    picker.click();
}

// ── Image conversion ──────────────────────────────────────────────────────────
// Palette generation and pixel quantization are provided by image-quantizer.js
// (medianCutPalette, quantizeWithDither) loaded before this script.

/**
 * Convert palette-index array to non-interleaved Amiga planar bitmap.
 * Layout: plane 0 (all rows) · plane 1 (all rows) · …
 * rowbytes = ceil(width/16)*2  (word-aligned)
 */
function toPlanarBitmap(indices, width, height, depth) {
    const rowbytes  = Math.ceil(width / 16) * 2;
    const planeSize = rowbytes * height;
    const out       = new Uint8Array(planeSize * depth);

    for (let plane = 0; plane < depth; plane++) {
        const base = plane * planeSize;
        for (let y = 0; y < height; y++) {
            const row = base + y * rowbytes;
            for (let x = 0; x < width; x++) {
                if ((indices[y * width + x] >> plane) & 1) {
                    out[row + (x >> 3)] |= 0x80 >> (x & 7);
                }
            }
        }
    }
    return out;
}

/**
 * Convert palette-index array to interleaved Amiga planar bitmap (PERF-G Phase 2).
 * Layout: for each row y — plane 0 row y · plane 1 row y · … · plane depth-1 row y
 * This matches the interleaved screen layout; enables 1-blit BOBs in bobs.s / image.s.
 * rowbytes = ceil(width/16)*2  (word-aligned, same as non-interleaved)
 */
function toPlanarBitmapInterleaved(indices, width, height, depth) {
    const rowbytes = Math.ceil(width / 16) * 2;
    const out      = new Uint8Array(height * depth * rowbytes);

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

/**
 * Generate an interleaved 1bpp transparency mask (PERF-G Phase 2).
 * Palette index 0 = transparent (bit 0), all other indices = opaque (bit 1).
 * Each mask row is repeated `depth` times so that BLTAMOD=0 works correctly
 * in the 1-blit masked BOB path (A channel steps through all planes' rows).
 * Total size: height × depth × rowbytes bytes.
 */
function toMaskInterleaved(indices, width, height, depth) {
    const rowbytes = Math.ceil(width / 16) * 2;
    const out      = new Uint8Array(height * depth * rowbytes);
    const maskRow  = new Uint8Array(rowbytes);

    for (let y = 0; y < height; y++) {
        // Build one 1bpp mask row: index 0 → transparent, else opaque
        maskRow.fill(0);
        for (let x = 0; x < width; x++) {
            if (indices[y * width + x] !== 0) {
                maskRow[x >> 3] |= 0x80 >> (x & 7);
            }
        }
        // Write `depth` identical copies of this mask row
        for (let p = 0; p < depth; p++) {
            const base = (y * depth + p) * rowbytes;
            out.set(maskRow, base);
        }
    }
    return out;
}

// ── Preview ───────────────────────────────────────────────────────────────────
function renderPreview() {
    if (!_imageData) return;

    const depth      = parseInt(document.getElementById('sel-depth').value);
    const colorCount = Math.min(1 << depth, 32);
    const ditherMode = document.getElementById('sel-dither').value;

    _lastDepth   = depth;
    _lastIndices = quantizeWithDither(_imageData, _palette, colorCount, ditherMode);

    // ── Original
    const co = document.getElementById('canvas-original');
    co.width  = _imageWidth;
    co.height = _imageHeight;
    co.style.aspectRatio = `${_imageWidth} / ${_imageHeight}`;
    co.getContext('2d').putImageData(_imageData, 0, 0);

    // ── Quantised
    const cc = document.getElementById('canvas-converted');
    cc.width  = _imageWidth;
    cc.height = _imageHeight;
    cc.style.aspectRatio = `${_imageWidth} / ${_imageHeight}`;
    const ctx  = cc.getContext('2d');
    const out  = ctx.createImageData(_imageWidth, _imageHeight);
    for (let i = 0; i < _lastIndices.length; i++) {
        const [r, g, b]    = ocsToRgb(_palette[_lastIndices[i]]);
        out.data[i * 4]     = r;
        out.data[i * 4 + 1] = g;
        out.data[i * 4 + 2] = b;
        out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);

    // ── Fit quality
    let totalErr = 0;
    for (let i = 0; i < _lastIndices.length; i++) {
        const ocs = _palette[_lastIndices[i]];
        const pr  = (ocs >> 8) & 0xF;
        const pg  = (ocs >> 4) & 0xF;
        const pb  =  ocs       & 0xF;
        const r4  = Math.round(_imageData.data[i * 4]     / 255 * 15);
        const g4  = Math.round(_imageData.data[i * 4 + 1] / 255 * 15);
        const b4  = Math.round(_imageData.data[i * 4 + 2] / 255 * 15);
        totalErr += Math.sqrt((r4 - pr) ** 2 + (g4 - pg) ** 2 + (b4 - pb) ** 2);
    }
    const maxErr  = Math.sqrt(3 * 225) * _lastIndices.length;  // 225 = 15²
    const quality = Math.round((1 - totalErr / maxErr) * 100);
    document.getElementById('fit-quality').textContent = `Match: ${quality}%`;

    updateActiveSlots(depth);

    document.getElementById('btn-convert-image').disabled  = false;
    document.getElementById('btn-export-iff').disabled     = false;
    document.getElementById('btn-copy-image-code').disabled = false;
}

// ── Load PNG via Canvas API ───────────────────────────────────────────────────
// Accepts a Blob or File (File extends Blob).
function loadImageFile(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const c   = document.createElement('canvas');
            c.width   = img.naturalWidth;
            c.height  = img.naturalHeight;
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

// Load a source image (PNG/JPG/BMP) directly from the project directory by
// path, without requiring drag & drop. Reads the file via IPC, wraps the bytes
// in a Blob, then calls onImageDropped with a synthetic File object so the
// rest of the conversion pipeline is unchanged.
async function loadSourceImageFromProject(item) {
    if (!_projectDir) return;
    const status = document.getElementById('image-status');
    status.textContent = `Loading ${item.name}\u2026`;
    status.classList.remove('has-file');
    try {
        const bytes = await window.assetAPI.readAsset({ projectDir: _projectDir, path: item.path });
        // Record the project-relative directory so Convert & Save defaults there.
        const normalized = item.path.replace(/\\/g, '/');
        const slashIdx   = normalized.lastIndexOf('/');
        _imageSourceDir  = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';
        const blob  = new Blob([new Uint8Array(bytes)]);
        const file  = new File([blob], item.name);
        await onImageDropped(file);
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
        console.error('[A-MGR] loadSourceImageFromProject:', err);
    }
}

async function onImageDropped(file) {
    if (!file) return;
    const status = document.getElementById('image-status');
    status.textContent = `Loading ${file.name}\u2026`;
    status.classList.remove('has-file');

    try {
        const { imageData, width, height } = await loadImageFile(file);
        _imageData     = imageData;
        _imageWidth    = width;
        _imageHeight   = height;
        _imageFilename = file.name.replace(/\.[^.]+$/, '') + '.raw';

        // First image auto-generates palette using Median Cut + CIEDE2000
        if (!_paletteIsSet) {
            const depth      = parseInt(document.getElementById('sel-depth').value);
            const colorCount = Math.min(1 << depth, 32);
            const generated  = medianCutPalette(imageData, colorCount);
            for (let i = 0; i < 32; i++) _palette[i] = generated[i] ?? 0;
            _paletteIsSet = true;
            updatePaletteUI();
        }

        status.textContent = `${file.name} \u2014 ${width} \u00d7 ${height} px`;
        status.classList.add('has-file');

        renderPreview();

        switchToTab('images');

    } catch (err) {
        status.textContent = `Error: ${err.message}`;
    }
}

// ── Convert & Save ────────────────────────────────────────────────────────────
async function onConvertAndSave() {
    if (!_imageData || !_lastIndices) return;
    const btn        = document.getElementById('btn-convert-image');
    const interleaved = document.getElementById('chk-interleaved').checked;
    const genMask     = interleaved && document.getElementById('chk-genmask').checked;
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const depth      = _lastDepth;
        const colorCount = 1 << depth;

        // Choose planar layout: interleaved (.iraw) or classic non-interleaved (.raw)
        const planes = interleaved
            ? toPlanarBitmapInterleaved(_lastIndices, _imageWidth, _imageHeight, depth)
            : toPlanarBitmap(_lastIndices, _imageWidth, _imageHeight, depth);

        // Prepend OCS palette: colorCount × 2-byte big-endian words ($0RGB).
        const raw = new Uint8Array(colorCount * 2 + planes.length);
        for (let i = 0; i < colorCount; i++) {
            raw[i * 2]     = (_palette[i] >> 8) & 0xFF;
            raw[i * 2 + 1] =  _palette[i]       & 0xFF;
        }
        raw.set(planes, colorCount * 2);

        const ext         = interleaved ? 'iraw' : 'raw';
        const baseFilename = _imageFilename.replace(/\.[^.]+$/, '') + '.' + ext;
        const defaultPath  = [
            _projectDir ? _projectDir.replace(/\\/g, '/') : null,
            _imageSourceDir || null,
            baseFilename,
        ].filter(Boolean).join('/');

        const result = await window.assetAPI.saveAssetWithDialog({
            defaultPath,
            filters: interleaved
                ? [{ name: 'Amiga Interleaved Raw (PERF-G)', extensions: ['iraw'] }]
                : [{ name: 'Amiga Raw', extensions: ['raw'] }],
            data: Array.from(raw),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        // Auto-save companion .imask when "Interleaved + Generate Mask" is checked
        if (genMask && result.filePath) {
            const maskPath = result.filePath.replace(/\.[^.]+$/, '') + '.imask';
            const maskData = toMaskInterleaved(_lastIndices, _imageWidth, _imageHeight, depth);
            await window.assetAPI.saveAsset({ path: maskPath, data: Array.from(maskData) });
        }

        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
        if (_projectDir) window.assetAPI.listAssets({ projectDir: _projectDir }).then(renderAssetTree).catch(() => {});
    } catch (err) {
        btn.textContent = 'Error!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
        console.error('[A-MGR]', err);
    }
}

function onCopyImageCode() {
    if (!_imageData) return;
    const interleaved = document.getElementById('chk-interleaved').checked;
    const ext      = interleaved ? 'iraw' : 'raw';
    const filename = _imageFilename.replace(/\.[^.]+$/, '') + '.' + ext;
    const code     = `LoadImage 0, "${filename}"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('btn-copy-image-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

async function onExportIFF() {
    if (!_imageData || !_lastIndices) return;
    const btn = document.getElementById('btn-export-iff');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const iffData     = createIFF(_imageWidth, _imageHeight, _palette, _lastIndices, _lastDepth);
        const iffFilename = _imageFilename.replace(/\.raw$/, '.iff');
        const defaultPath = [
            _projectDir ? _projectDir.replace(/\\/g, '/') : null,
            _imageSourceDir || null,
            iffFilename,
        ].filter(Boolean).join('/');

        const result = await window.assetAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'Amiga IFF/ILBM', extensions: ['iff', 'ilbm', 'lbm'] }],
            data:    Array.from(iffData),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Export IFF'; return; }
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Export IFF'; btn.disabled = false; }, 1500);
        if (_projectDir) window.assetAPI.listAssets({ projectDir: _projectDir }).then(renderAssetTree).catch(() => {});
    } catch (err) {
        btn.textContent = 'Error!';
        setTimeout(() => { btn.textContent = 'Export IFF'; btn.disabled = false; }, 2000);
        console.error('[A-MGR IFF]', err);
    }
}

// ── Tilesets ──────────────────────────────────────────────────────────────────

/**
 * Slice a palette-index array (imgW×imgH) into row-major tiles and stack
 * them vertically into a new Uint8Array of size tileW × (nTiles × tileH).
 * Tile order: left→right, top→bottom.
 */
function sliceAndStackTiles(indices, imgW, imgH, tileW, tileH) {
    const cols   = Math.floor(imgW / tileW);
    const rows   = Math.floor(imgH / tileH);
    const nTiles = cols * rows;
    const stacked = new Uint8Array(tileW * nTiles * tileH);
    let dst = 0;
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            for (let py = 0; py < tileH; py++) {
                for (let px = 0; px < tileW; px++) {
                    stacked[dst++] = indices[(tr * tileH + py) * imgW + tc * tileW + px];
                }
            }
        }
    }
    return { stacked, nTiles, totalH: nTiles * tileH };
}

function renderTilesetPreview() {
    if (!_tsImageData) return;
    const depth      = parseInt(document.getElementById('sel-ts-depth').value);
    const tileW      = parseInt(document.getElementById('inp-ts-tw').value) || 16;
    const tileH      = parseInt(document.getElementById('inp-ts-th').value) || 16;
    const colorCount = Math.min(1 << depth, 32);

    _tsLastDepth   = depth;
    _tsLastIndices = quantizeWithDither(_tsImageData, _palette, colorCount, 'none');

    // ── Original
    const co = document.getElementById('canvas-ts-original');
    co.width  = _tsWidth;
    co.height = _tsHeight;
    co.style.aspectRatio = `${_tsWidth} / ${_tsHeight}`;
    co.getContext('2d').putImageData(_tsImageData, 0, 0);

    // ── Quantised + tile grid overlay
    const cc = document.getElementById('canvas-ts-converted');
    cc.width  = _tsWidth;
    cc.height = _tsHeight;
    cc.style.aspectRatio = `${_tsWidth} / ${_tsHeight}`;
    const ctx = cc.getContext('2d');
    const out = ctx.createImageData(_tsWidth, _tsHeight);
    for (let i = 0; i < _tsLastIndices.length; i++) {
        const [r, g, b]  = ocsToRgb(_palette[_tsLastIndices[i]]);
        out.data[i*4]    = r;
        out.data[i*4+1]  = g;
        out.data[i*4+2]  = b;
        out.data[i*4+3]  = 255;
    }
    ctx.putImageData(out, 0, 0);
    ctx.strokeStyle = 'rgba(255,0,255,0.5)';
    ctx.lineWidth   = 0.5;
    for (let x = tileW; x < _tsWidth; x += tileW) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, _tsHeight); ctx.stroke();
    }
    for (let y = tileH; y < _tsHeight; y += tileH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(_tsWidth, y); ctx.stroke();
    }

    // ── Tile info
    const cols   = Math.floor(_tsWidth / tileW);
    const rows   = Math.floor(_tsHeight / tileH);
    const nTiles = cols * rows;
    document.getElementById('ts-tile-info').textContent =
        `${cols}\u00d7${rows} = ${nTiles} tiles`;

    // ── Fit quality
    let totalErr = 0;
    for (let i = 0; i < _tsLastIndices.length; i++) {
        const ocs = _palette[_tsLastIndices[i]];
        const pr  = (ocs >> 8) & 0xF;
        const pg  = (ocs >> 4) & 0xF;
        const pb  =  ocs       & 0xF;
        const r4  = Math.round(_tsImageData.data[i*4]   / 255 * 15);
        const g4  = Math.round(_tsImageData.data[i*4+1] / 255 * 15);
        const b4  = Math.round(_tsImageData.data[i*4+2] / 255 * 15);
        totalErr += Math.sqrt((r4-pr)**2 + (g4-pg)**2 + (b4-pb)**2);
    }
    const maxErr  = Math.sqrt(3 * 225) * _tsLastIndices.length;
    const quality = Math.round((1 - totalErr / maxErr) * 100);
    document.getElementById('ts-fit-quality').textContent = `Match: ${quality}%`;

    updateActiveSlots(depth);
    document.getElementById('btn-convert-tileset').disabled   = false;
    document.getElementById('btn-copy-tileset-code').disabled = false;
}

function scheduleTilesetPreview() {
    if (_tsRafHandle) cancelAnimationFrame(_tsRafHandle);
    _tsRafHandle = requestAnimationFrame(() => { _tsRafHandle = null; renderTilesetPreview(); });
}

async function onTilesetDropped(file) {
    if (!file) return;
    const status = document.getElementById('ts-status');
    status.textContent = `Loading ${file.name}\u2026`;
    status.classList.remove('has-file');
    try {
        const { imageData, width, height } = await loadImageFile(file);
        _tsImageData = imageData;
        _tsWidth     = width;
        _tsHeight    = height;
        _tsFilename  = file.name.replace(/\.[^.]+$/, '') + '.tset';

        if (!_paletteIsSet) {
            const depth      = parseInt(document.getElementById('sel-ts-depth').value);
            const colorCount = Math.min(1 << depth, 32);
            const generated  = medianCutPalette(imageData, colorCount);
            for (let i = 0; i < 32; i++) _palette[i] = generated[i] ?? 0;
            _paletteIsSet = true;
            updatePaletteUI();
        }

        status.textContent = `${file.name} \u2014 ${width} \u00d7 ${height} px`;
        status.classList.add('has-file');
        renderTilesetPreview();
        switchToTab('tilesets');
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
    }
}

/**
 * Build a .tset binary (V1).
 * Phase 1: Header + PALETTE + IMAGE only (flags=0, no metadata sections).
 *
 * @param {number[]} palette    – OCS color words ($0RGB), length ≥ 2^depth
 * @param {Uint8Array} planes   – interleaved bitplane data from toPlanarBitmapInterleaved()
 * @param {number} tileSize     – tile edge length in pixels (8, 16 or 32)
 * @param {number} tileCount    – number of tiles
 * @param {number} depth        – bitplane count (1–5)
 * @returns {Uint8Array}        – complete .tset file content
 */
function buildTsetBinary(palette, planes, tileSize, tileCount, depth) {
    const colorCount   = 1 << depth;
    const paletteSize  = colorCount * 2;
    const imageSize    = planes.length;
    const totalSize    = 12 + paletteSize + imageSize;

    const buf  = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);

    // ── Header (12 bytes) ────────────────────────────────────────────────────
    buf[0] = 0x54; buf[1] = 0x53; buf[2] = 0x45; buf[3] = 0x54; // "TSET"
    buf[4] = 1;                         // version
    buf[5] = tileSize;                  // tile_size
    view.setUint16(6, tileCount, false); // tile_count (BE)
    buf[8] = depth;                     // depth
    buf[9] = 0;                         // flags (Phase 1: no optional sections)
    view.setUint16(10, 0, false);       // reserved

    // ── PALETTE ──────────────────────────────────────────────────────────────
    for (let i = 0; i < colorCount; i++) {
        view.setUint16(12 + i * 2, palette[i] & 0x0FFF, false);
    }

    // ── IMAGE (interleaved bitplanes) ────────────────────────────────────────
    buf.set(planes, 12 + paletteSize);

    return buf;
}

/**
 * Convert an existing .iraw buffer to .tset format.
 * .iraw layout: palette (2^depth × 2 bytes, BE) + interleaved bitplane data.
 *
 * @param {Uint8Array} irawBuf  – raw .iraw file content
 * @param {number} tileSize     – tile edge length (8, 16 or 32)
 * @param {number} depth        – bitplane count (1–5)
 * @returns {Uint8Array}        – complete .tset file content
 */
function irawToTset(irawBuf, tileSize, depth) {
    const colorCount  = 1 << depth;
    const paletteSize = colorCount * 2;
    const rowbytes    = Math.ceil(tileSize / 16) * 2;
    const imageSize   = irawBuf.length - paletteSize;
    const tileBytes   = tileSize * rowbytes * depth;
    const tileCount   = Math.floor(imageSize / tileBytes);

    // Extract palette as OCS word array
    const palette = new Array(colorCount);
    const view    = new DataView(irawBuf.buffer, irawBuf.byteOffset, irawBuf.byteLength);
    for (let i = 0; i < colorCount; i++) {
        palette[i] = view.getUint16(i * 2, false);
    }

    // Image data starts after palette
    const planes = irawBuf.slice(paletteSize, paletteSize + tileCount * tileBytes);

    return buildTsetBinary(palette, planes, tileSize, tileCount, depth);
}

async function onConvertAndSaveTileset() {
    if (!_tsImageData || !_tsLastIndices) return;
    const btn   = document.getElementById('btn-convert-tileset');
    const tileW = parseInt(document.getElementById('inp-ts-tw').value) || 16;
    const tileH = parseInt(document.getElementById('inp-ts-th').value) || 16;
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const depth = _tsLastDepth;

        const { stacked, nTiles, totalH } = sliceAndStackTiles(
            _tsLastIndices, _tsWidth, _tsHeight, tileW, tileH);
        const planes = toPlanarBitmapInterleaved(stacked, tileW, totalH, depth);
        const raw    = buildTsetBinary(_palette, planes, tileW, nTiles, depth);

        const defaultPath = [
            _projectDir ? _projectDir.replace(/\\/g, '/') : null,
            _tsFilename,
        ].filter(Boolean).join('/');

        const result = await window.assetAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'BASSM Tileset', extensions: ['tset'] }],
            data: Array.from(raw),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
        if (_projectDir) window.assetAPI.listAssets({ projectDir: _projectDir }).then(renderAssetTree).catch(() => {});
    } catch (err) {
        btn.textContent = 'Error!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
        console.error('[A-MGR Tileset]', err);
    }
}

function onCopyTilesetCode() {
    if (!_tsImageData) return;
    const code  = `LoadTileset 0, "${_tsFilename}"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('btn-copy-tileset-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// ── Tilemaps ──────────────────────────────────────────────────────────────────

function parseTilemapCSV(csvText) {
    if (!csvText.trim()) return null;
    const rows = csvText.trim().split(/\r?\n/).map(r =>
        r.split(',').map(v => parseInt(v.trim(), 10) || 0)
    );
    const mapH = rows.length;
    const mapW = Math.max(...rows.map(r => r.length));
    if (mapW < 1 || mapH < 1) return null;
    return { rows, mapW, mapH };
}

function csvToBmap(rows, mapW, mapH, tileW, tileH) {
    const buf  = new Uint8Array(8 + mapW * mapH * 2);
    const view = new DataView(buf.buffer);
    view.setUint16(0, mapW,  false);
    view.setUint16(2, mapH,  false);
    view.setUint16(4, tileW, false);
    view.setUint16(6, tileH, false);
    let off = 8;
    for (const row of rows) {
        for (let c = 0; c < mapW; c++) {
            view.setUint16(off, row[c] ?? 0, false);
            off += 2;
        }
    }
    return buf;
}

function onTilemapCSVInput() {
    const parsed  = parseTilemapCSV(document.getElementById('tm-csv').value);
    const info    = document.getElementById('tm-map-info');
    info.textContent = parsed
        ? `Detected: ${parsed.mapW} \u00d7 ${parsed.mapH} tiles`
        : '';
    document.getElementById('btn-convert-tilemap').disabled   = !parsed;
    document.getElementById('btn-copy-tilemap-code').disabled = !parsed;
}

async function onConvertAndSaveTilemap() {
    const csv    = document.getElementById('tm-csv').value;
    const tileW  = parseInt(document.getElementById('inp-tm-tw').value) || 16;
    const tileH  = parseInt(document.getElementById('inp-tm-th').value) || 16;
    const parsed = parseTilemapCSV(csv);
    if (!parsed) return;

    const btn = document.getElementById('btn-convert-tilemap');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const data        = csvToBmap(parsed.rows, parsed.mapW, parsed.mapH, tileW, tileH);
        const defaultPath = [
            _projectDir ? _projectDir.replace(/\\/g, '/') : null,
            'map.bmap',
        ].filter(Boolean).join('/');

        const result = await window.assetAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'BASSM Tilemap', extensions: ['bmap'] }],
            data: Array.from(data),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
    } catch (err) {
        btn.textContent = 'Error!';
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
        console.error('[A-MGR Tilemap]', err);
    }
}

function onCopyTilemapCode() {
    const code = `LoadTilemap 0, "map.bmap"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('btn-copy-tilemap-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// ── Global drag-and-drop (whole window, no fixed drop zone) ───────────────────
const _dropOverlay     = document.getElementById('drop-overlay');
const _dropOverlayHint = document.getElementById('drop-overlay-hint');
let   _dragDepth       = 0;

document.addEventListener('dragenter', e => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    if (++_dragDepth === 1) {
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        _dropOverlayHint.textContent = activeTab === 'sounds'
            ? 'Drop WAV / MP3 / OGG'
            : activeTab === 'tilesets'
            ? 'Drop PNG sprite sheet'
            : 'Drop PNG / JPEG / BMP';
        _dropOverlay.classList.add('active');
    }
});

document.addEventListener('dragleave', () => {
    if (--_dragDepth <= 0) { _dragDepth = 0; _dropOverlay.classList.remove('active'); }
});

document.addEventListener('dragover', e => e.preventDefault());

document.addEventListener('drop', e => {
    e.preventDefault();
    _dragDepth = 0;
    _dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (SOURCE_IMAGE_EXTS.has(ext)) {
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'tilesets') {
            onTilesetDropped(file);
        } else {
            _imageSourceDir = '';
            onImageDropped(file);
        }
    } else if (SOURCE_SOUND_EXTS.has(ext)) {
        onSoundDropped(file);
    }
});

function onSoundDropped(file) {
    document.getElementById('waveform-placeholder').textContent =
        `${file.name} \u2014 ${(file.size / 1024).toFixed(1)} KB \u2014 conversion not yet implemented (A-MGR-3)`;
    switchToTab('sounds');
}

// ── Controls wiring ───────────────────────────────────────────────────────────
document.getElementById('sel-depth')   .addEventListener('change', () => { if (_imageData) schedulePreview(); });
document.getElementById('sel-dither')  .addEventListener('change', () => { if (_imageData) schedulePreview(); });
document.getElementById('btn-convert-image') .addEventListener('click', onConvertAndSave);
document.getElementById('btn-export-iff')    .addEventListener('click', onExportIFF);
document.getElementById('btn-copy-image-code').addEventListener('click', onCopyImageCode);
document.getElementById('chk-interleaved').addEventListener('change', function () {
    document.getElementById('chk-genmask').disabled = !this.checked;
    if (!this.checked) document.getElementById('chk-genmask').checked = false;
});

// ── Period / Hz display ───────────────────────────────────────────────────────
const periodSlider  = document.getElementById('rng-period');
const periodDisplay = document.getElementById('period-display');
periodSlider.addEventListener('input', () => {
    const p  = parseInt(periodSlider.value);
    const hz = Math.round(3546895 / p);
    periodDisplay.innerHTML = `${p} &nbsp;\u2248&nbsp; ${hz.toLocaleString()} Hz`;
});
periodDisplay.innerHTML = `428 &nbsp;\u2248&nbsp; 8287 Hz`;

// ── Asset Tree ────────────────────────────────────────────────────────────────

const SOURCE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);
const SOURCE_SOUND_EXTS = new Set(['.wav', '.mp3', '.ogg', '.aiff']);

function renderAssetTree(assets) {
    renderGroup('list-palettes', assets.palettes || [], 'palette', null);
    renderGroup('list-images',   assets.images   || [], 'images',  (item) => {
        const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
        if (SOURCE_IMAGE_EXTS.has(ext)) {
            // Source image: load directly into the converter
            loadSourceImageFromProject(item);
        }
        switchToTab('images');
    });
    renderGroup('list-sounds',   assets.sounds   || [], 'sounds',  null);
}

// Switch the top tab bar to a named tab.
function switchToTab(tab) {
    document.querySelectorAll('.tab-btn')  .forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
}

// onClickItem: optional callback(item); if null, just switches the tab.
function renderGroup(listId, items, switchTab, onClickItem) {
    const el = document.getElementById(listId);
    el.innerHTML = '';
    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'group-empty';
        empty.textContent = 'none';
        el.appendChild(empty);
        return;
    }
    for (const item of items) {
        const ext        = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
        const isSource   = SOURCE_IMAGE_EXTS.has(ext) || SOURCE_SOUND_EXTS.has(ext);
        const row        = document.createElement('div');
        row.className    = 'asset-item' + (isSource ? ' asset-item-source' : ' asset-item-converted');
        row.textContent  = item.name;
        row.title        = isSource
            ? `${item.path}  —  click to open in converter`
            : item.path;
        row.addEventListener('click', () => {
            if (onClickItem) {
                onClickItem(item);
            } else {
                switchToTab(switchTab);
            }
        });
        el.appendChild(row);
    }
}

// ── Project IPC ───────────────────────────────────────────────────────────────
function applyProject(projectDir) {
    _projectDir   = projectDir;
    _paletteIsSet = false;
    const name = projectDir ? projectDir.split(/[/\\]/).pop() : 'No project open';
    document.getElementById('project-name').textContent = name;
    document.getElementById('btn-convert-image').disabled = !_imageData;
    document.getElementById('btn-export-iff').disabled    = !_imageData;

    if (projectDir) {
        window.assetAPI.listAssets({ projectDir }).then(renderAssetTree).catch(() => {});
    } else {
        renderAssetTree({ palettes: [], images: [], sounds: [] });
    }
}

if (window.assetAPI) {
    window.assetAPI.onSetProject(({ projectDir }) => applyProject(projectDir));

    // Pre-load a specific source image when opened via right-click → Convert.
    window.assetAPI.onPreloadFile(({ projectDir, preloadFile }) => {
        if (projectDir && projectDir !== _projectDir) applyProject(projectDir);
        const name = preloadFile.replace(/\\/g, '/').split('/').pop();
        switchToTab('images');
        loadSourceImageFromProject({ name, path: preloadFile });
    });

    // Refresh the asset tree whenever the project folder changes on disk
    // (file added, renamed, deleted, or saved by an external tool).
    window.assetAPI.onFilesChanged(() => {
        if (_projectDir) {
            window.assetAPI.listAssets({ projectDir: _projectDir })
                .then(renderAssetTree)
                .catch(() => {});
        }
    });
}

// ── Tileset controls wiring ───────────────────────────────────────────────────
document.getElementById('sel-ts-depth').addEventListener('change', () => { if (_tsImageData) scheduleTilesetPreview(); });
document.getElementById('inp-ts-tw')   .addEventListener('input',  () => { if (_tsImageData) scheduleTilesetPreview(); });
document.getElementById('inp-ts-th')   .addEventListener('input',  () => { if (_tsImageData) scheduleTilesetPreview(); });
document.getElementById('btn-convert-tileset')  .addEventListener('click', onConvertAndSaveTileset);
document.getElementById('btn-copy-tileset-code').addEventListener('click', onCopyTilesetCode);

// ── Tilemap controls wiring ───────────────────────────────────────────────────
document.getElementById('tm-csv')              .addEventListener('input', onTilemapCSVInput);
document.getElementById('btn-convert-tilemap')  .addEventListener('click', onConvertAndSaveTilemap);
document.getElementById('btn-copy-tilemap-code').addEventListener('click', onCopyTilemapCode);

applyProject(null);
