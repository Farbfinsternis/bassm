'use strict';

// ── Image Editor ────────────────────────────────────────────────────────────
// Lives in the main renderer (index.html). Converts PNG/JPG/BMP to OCS .iraw.
// Opened via double-click or right-click → Open on an image in the Project Tree.

// ── State ────────────────────────────────────────────────────────────────────
let _imgData       = null;   // raw ImageData from loaded image
let _imgWidth      = 0;
let _imgHeight     = 0;
let _imgFilename   = '';     // e.g. "player.iraw"
let _imgSourceDir  = '';     // project-relative dir of the source image
let _imgPalette    = new Array(32).fill(0);   // OCS $0RGB words
let _imgIndices    = null;   // quantised pixel → palette index (Uint8Array)
let _imgDepth      = 3;
let _imgIsIndexed  = false;  // true when source PNG was 8-bit indexed with usable PLTE
let _imgAspectLock = true;   // aspect-ratio lock for resize
let _imgCropOrigin = 'mc';   // 3×3 origin: tl,tc,tr,ml,mc,mr,bl,bc,br
let _imgPoiMask    = null;   // Uint8Array, same size as image (w×h), 0=unmask, 255=masked
let _imgPoiDirty   = false;  // true when mask changed, triggers overlay re-render
let _imgPoiPainting = false; // true while mouse is held down for painting
let _imgPoiErasing  = false; // true when right-button is held (erase mode)
let _imgPoiRafId    = null;  // requestAnimationFrame handle for overlay render
let _imgPoiWeights  = null;  // Float32Array (0.0–1.0), feathered mask for palette weighting
let _imgPoiPipelineTimer = null; // debounce timer for full recalculation pipeline

// ── Helpers ──────────────────────────────────────────────────────────────────

function _imgOcsToRgb(ocs) {
    return [((ocs >> 8) & 0xF) * 17, ((ocs >> 4) & 0xF) * 17, (ocs & 0xF) * 17];
}

function _imgLoadBlob(blob) {
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
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image decode failed — file may be corrupted or not a supported format'));
        };
        img.src = url;
    });
}

// ── PNG metadata parsing ────────────────────────────────────────────────────

/**
 * Parse PNG binary to extract color type (IHDR) and palette (PLTE chunk).
 * @param {Uint8Array} bytes  raw PNG file bytes
 * @returns {{ colorType: number, plte: number[][]|null }}
 *          colorType: 2 = truecolor, 3 = indexed, 6 = truecolor+alpha, etc.
 *          plte: array of [R,G,B] triples if PLTE chunk present, else null
 */
function _parsePngMeta(bytes) {
    if (bytes.length < 29 ||
        bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47 ||
        bytes[4] !== 0x0D || bytes[5] !== 0x0A || bytes[6] !== 0x1A || bytes[7] !== 0x0A) {
        return { colorType: -1, plte: null };
    }

    let colorType = -1;
    let plte = null;
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                    (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5],
            bytes[offset + 6], bytes[offset + 7]
        );
        const dataStart = offset + 8;

        if (type === 'IHDR' && len >= 13) {
            // IHDR data: width(4) + height(4) + bitDepth(1) + colorType(1) + ...
            colorType = bytes[dataStart + 9];
        }

        if (type === 'PLTE' && len >= 3 && len % 3 === 0) {
            const count = len / 3;
            plte = [];
            for (let i = 0; i < count; i++) {
                plte.push([
                    bytes[dataStart + i * 3],
                    bytes[dataStart + i * 3 + 1],
                    bytes[dataStart + i * 3 + 2],
                ]);
            }
        }

        if (type === 'IEND') break;
        offset = dataStart + len + 4; // skip data + CRC
    }

    return { colorType, plte };
}

// ── Planar conversion ────────────────────────────────────────────────────────

function _imgToPlanarInterleaved(indices, width, height, depth) {
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

function _imgToMaskInterleaved(indices, width, height, depth) {
    const rowbytes = Math.ceil(width / 16) * 2;
    const out = new Uint8Array(height * depth * rowbytes);
    const maskRow = new Uint8Array(rowbytes);
    for (let y = 0; y < height; y++) {
        maskRow.fill(0);
        for (let x = 0; x < width; x++) {
            if (indices[y * width + x] !== 0) {
                maskRow[x >> 3] |= 0x80 >> (x & 7);
            }
        }
        for (let p = 0; p < depth; p++) {
            out.set(maskRow, (y * depth + p) * rowbytes);
        }
    }
    return out;
}

// ── Resize & Crop ───────────────────────────────────────────────────────────

function _imgUpdateDimInputs() {
    document.getElementById('img-dim-w').value = _imgWidth;
    document.getElementById('img-dim-h').value = _imgHeight;
    const canResize = _imgData !== null;
    document.getElementById('img-btn-resize').disabled = !canResize;
    document.getElementById('img-btn-crop').disabled   = !canResize;
}

function _imgResize(newW, newH) {
    if (!_imgData || newW < 1 || newH < 1) return;
    if (newW === _imgWidth && newH === _imgHeight) return;

    // Bilinear interpolation via temporary canvas
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width  = _imgWidth;
    srcCanvas.height = _imgHeight;
    srcCanvas.getContext('2d').putImageData(_imgData, 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width  = newW;
    dstCanvas.height = newH;
    const dctx = dstCanvas.getContext('2d');
    dctx.imageSmoothingEnabled    = true;
    dctx.imageSmoothingQuality    = 'high';
    dctx.drawImage(srcCanvas, 0, 0, newW, newH);

    _imgData   = dctx.getImageData(0, 0, newW, newH);
    _imgWidth  = newW;
    _imgHeight = newH;

    // Recalculate palette + preview
    if (!_imgIsIndexed) {
        const colorCount = Math.min(1 << _imgDepth, 32);
        const generated  = medianCutPalette(_imgData, colorCount);
        for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
    }

    _imgPoiMask = new Uint8Array(newW * newH);
    _imgPoiClearOverlay();
    _imgUpdateDimInputs();
    _imgRenderPreview();
    document.getElementById('img-status').textContent =
        `${_imgFilename.replace(/\.iraw$/, '')} — ${_imgWidth} \u00d7 ${_imgHeight} px (resized)`;
    if (window.logLine) window.logLine(`[Image] Resized to ${newW}\u00d7${newH}`, 'info');
}

function _imgCrop(targetW, targetH) {
    if (!_imgData || targetW < 1 || targetH < 1) return;
    const cropW = Math.min(targetW, _imgWidth);
    const cropH = Math.min(targetH, _imgHeight);
    if (cropW === _imgWidth && cropH === _imgHeight) return;

    // Calculate offset from origin
    const dxTotal = _imgWidth  - cropW;
    const dyTotal = _imgHeight - cropH;
    let ox = 0, oy = 0;
    const col = _imgCropOrigin[1]; // l, c, r
    const row = _imgCropOrigin[0]; // t, m, b
    if (col === 'c') ox = Math.floor(dxTotal / 2);
    else if (col === 'r') ox = dxTotal;
    if (row === 'm') oy = Math.floor(dyTotal / 2);
    else if (row === 'b') oy = dyTotal;

    // Extract sub-region
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width  = _imgWidth;
    srcCanvas.height = _imgHeight;
    srcCanvas.getContext('2d').putImageData(_imgData, 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width  = cropW;
    dstCanvas.height = cropH;
    const dctx = dstCanvas.getContext('2d');
    dctx.drawImage(srcCanvas, ox, oy, cropW, cropH, 0, 0, cropW, cropH);

    _imgData   = dctx.getImageData(0, 0, cropW, cropH);
    _imgWidth  = cropW;
    _imgHeight = cropH;

    if (!_imgIsIndexed) {
        const colorCount = Math.min(1 << _imgDepth, 32);
        const generated  = medianCutPalette(_imgData, colorCount);
        for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
    }

    _imgPoiMask = new Uint8Array(cropW * cropH);
    _imgPoiClearOverlay();
    _imgUpdateDimInputs();
    _imgRenderPreview();
    document.getElementById('img-status').textContent =
        `${_imgFilename.replace(/\.iraw$/, '')} — ${_imgWidth} \u00d7 ${_imgHeight} px (cropped)`;
    if (window.logLine) window.logLine(`[Image] Cropped to ${cropW}\u00d7${cropH} (origin: ${_imgCropOrigin})`, 'info');
}

// ── Palette UI ───────────────────────────────────────────────────────────────

function _imgInitPalette() {
    const bar = document.getElementById('img-palette-bar');
    bar.innerHTML = '';
    for (let i = 0; i < 32; i++) {
        const slot = document.createElement('div');
        slot.className = 'img-pal-slot';
        slot.dataset.index = i;
        slot.title = `Color ${i}`;
        bar.appendChild(slot);
    }
}

function _imgUpdatePalette() {
    const depth = _imgDepth;
    const count = 1 << depth;
    document.querySelectorAll('.img-pal-slot').forEach((slot, i) => {
        const [r, g, b] = _imgOcsToRgb(_imgPalette[i]);
        slot.style.background = `rgb(${r},${g},${b})`;
        slot.classList.toggle('slot-inactive', i >= count);
        const hex = _imgPalette[i].toString(16).padStart(3, '0').toUpperCase();
        slot.title = `Color ${i} — $${hex}`;
    });
}

// ── Preview render ───────────────────────────────────────────────────────────

function _imgRenderPreview() {
    if (!_imgData) return;

    const depth      = parseInt(document.getElementById('img-sel-depth').value);
    const colorCount = Math.min(1 << depth, 32);
    const ditherMode = document.getElementById('img-sel-dither').value;

    // Recalculate palette when depth changed (TrueColor sources only)
    if (depth !== _imgDepth && !_imgIsIndexed) {
        const weights = _imgPoiWeights || undefined;
        const generated = medianCutPalette(_imgData, colorCount, 50, weights);
        for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
    }

    _imgDepth   = depth;
    _imgIndices = quantizeWithDither(_imgData, _imgPalette, colorCount, ditherMode);

    // ── Original
    const co = document.getElementById('img-canvas-original');
    co.width  = _imgWidth;
    co.height = _imgHeight;
    co.getContext('2d').putImageData(_imgData, 0, 0);

    // ── Quantised
    const cc = document.getElementById('img-canvas-converted');
    cc.width  = _imgWidth;
    cc.height = _imgHeight;
    const ctx = cc.getContext('2d');
    const out = ctx.createImageData(_imgWidth, _imgHeight);
    for (let i = 0; i < _imgIndices.length; i++) {
        const [r, g, b]     = _imgOcsToRgb(_imgPalette[_imgIndices[i]]);
        out.data[i * 4]     = r;
        out.data[i * 4 + 1] = g;
        out.data[i * 4 + 2] = b;
        out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);

    // ── Fit quality
    let totalErr = 0;
    for (let i = 0; i < _imgIndices.length; i++) {
        const ocs = _imgPalette[_imgIndices[i]];
        const pr  = (ocs >> 8) & 0xF;
        const pg  = (ocs >> 4) & 0xF;
        const pb  =  ocs       & 0xF;
        const r4  = Math.round(_imgData.data[i * 4]     / 255 * 15);
        const g4  = Math.round(_imgData.data[i * 4 + 1] / 255 * 15);
        const b4  = Math.round(_imgData.data[i * 4 + 2] / 255 * 15);
        totalErr += Math.sqrt((r4 - pr) ** 2 + (g4 - pg) ** 2 + (b4 - pb) ** 2);
    }
    const maxErr  = Math.sqrt(3 * 225) * _imgIndices.length;
    const quality = Math.round((1 - totalErr / maxErr) * 100);

    _imgUpdatePalette();
    _imgUpdateProps(quality);

    document.getElementById('img-btn-convert').disabled    = false;
    document.getElementById('img-btn-export-iff').disabled  = false;
}

// ── Sidebar properties ───────────────────────────────────────────────────────

function _imgUpdateProps(quality) {
    document.getElementById('img-prop-file').textContent  = _imgFilename;
    document.getElementById('img-prop-size').textContent  = `${_imgWidth} × ${_imgHeight} px`;
    document.getElementById('img-prop-match').textContent = `${quality}%`;

    const depth     = _imgDepth;
    const rowbytes  = Math.ceil(_imgWidth / 16) * 2;
    const chipBytes = (1 << depth) * 2 + _imgHeight * depth * rowbytes;
    document.getElementById('img-prop-chip').textContent = `${(chipBytes / 1024).toFixed(1)} KB`;
    document.getElementById('img-prop-pct').textContent  = `${(chipBytes / (512 * 1024) * 100).toFixed(1)}%`;
}

// ── Open image from project tree ─────────────────────────────────────────────

let _imgProjectDir = null;
let _imgRafHandle  = null;

function _imgSchedulePreview() {
    if (_imgRafHandle) cancelAnimationFrame(_imgRafHandle);
    _imgRafHandle = requestAnimationFrame(() => { _imgRafHandle = null; _imgRenderPreview(); });
}

/**
 * Open a project-relative image file in the Image Editor.
 * Called from _openFile() in bassm.js.
 */
async function imgOpenFile(relativePath, projectDir) {
    _imgProjectDir = projectDir;
    const name = relativePath.replace(/\\/g, '/').split('/').pop();
    const normalized = relativePath.replace(/\\/g, '/');
    const slashIdx   = normalized.lastIndexOf('/');
    _imgSourceDir    = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';

    const statusEl = document.getElementById('img-status');
    statusEl.textContent = `Loading ${name}\u2026`;

    try {
        const bytes = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        const rawBytes = new Uint8Array(bytes);
        const ext   = name.split('.').pop().toLowerCase();
        const mime  = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' }[ext] || 'image/png';
        const blob  = new Blob([rawBytes], { type: mime });
        const { imageData, width, height } = await _imgLoadBlob(blob);

        _imgData     = imageData;
        _imgWidth    = width;
        _imgHeight   = height;
        _imgFilename = name.replace(/\.[^.]+$/, '') + '.iraw';

        // ── Detect indexed PNG and extract embedded palette ──────────
        let pngMeta = null;
        if (ext === 'png') pngMeta = _parsePngMeta(rawBytes);

        if (pngMeta && pngMeta.colorType === 3 && pngMeta.plte && pngMeta.plte.length <= 32) {
            // 8-bit Indexed PNG with OCS-compatible palette (≤32 colors)
            _imgIsIndexed = true;
            const palCount = pngMeta.plte.length;
            const autoDepth = Math.max(1, Math.ceil(Math.log2(palCount || 1)));
            const depthSel = document.getElementById('img-sel-depth');
            depthSel.value = String(Math.min(autoDepth, 5));
            document.getElementById('img-sel-dither').value = 'none';

            // Convert PLTE RGB → OCS $0RGB
            for (let i = 0; i < 32; i++) {
                if (i < palCount) {
                    const [r, g, b] = pngMeta.plte[i];
                    _imgPalette[i] = ((Math.round(r / 17) & 0xF) << 8)
                                   | ((Math.round(g / 17) & 0xF) << 4)
                                   |  (Math.round(b / 17) & 0xF);
                } else {
                    _imgPalette[i] = 0;
                }
            }
        } else {
            // 24-bit TrueColor (or non-PNG / indexed with >32 colors) → Median Cut
            _imgIsIndexed = false;
            const depth      = parseInt(document.getElementById('img-sel-depth').value);
            const colorCount = Math.min(1 << depth, 32);
            const generated  = medianCutPalette(imageData, colorCount);
            for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
        }

        // Show workspace, hide placeholder
        document.getElementById('img-placeholder').style.display = 'none';
        document.getElementById('img-workspace').style.display = '';
        document.getElementById('img-content').classList.add('has-image');

        const typeLabel = _imgIsIndexed ? 'Indexed' : 'TrueColor';
        statusEl.textContent = `${name} — ${width} \u00d7 ${height} px (${typeLabel})`;

        _imgUpdateDimInputs();
        _imgPoiMask = new Uint8Array(width * height);
        _imgPoiClearOverlay();
        _imgRenderPreview();

        if (window.logLine) {
            const palInfo = _imgIsIndexed ? `, indexed ${pngMeta.plte.length} colors` : '';
            window.logLine(`[Image] Opened ${name} (${width}\u00d7${height}${palInfo})`, 'info');
        }

    } catch (err) {
        statusEl.textContent = `Error loading ${name}`;
        if (window.logLine) {
            const dims = _imgWidth && _imgHeight ? ` (${_imgWidth}\u00d7${_imgHeight})` : '';
            window.logLine(`[Image] Error: '${name}'${dims} — ${err.message}`, 'error');
        }
    }
}

// Export for bassm.js
window.imgOpenFile = imgOpenFile;

// ── Convert & Save ───────────────────────────────────────────────────────────

async function _imgConvertAndSave() {
    if (!_imgData || !_imgIndices) return;
    const btn     = document.getElementById('img-btn-convert');
    const genMask = document.getElementById('img-chk-genmask').checked;
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const depth      = _imgDepth;
        const colorCount = 1 << depth;

        // Always interleaved (.iraw)
        const planes = _imgToPlanarInterleaved(_imgIndices, _imgWidth, _imgHeight, depth);

        // Prepend OCS palette: colorCount × 2-byte big-endian words ($0RGB)
        const raw = new Uint8Array(colorCount * 2 + planes.length);
        for (let i = 0; i < colorCount; i++) {
            raw[i * 2]     = (_imgPalette[i] >> 8) & 0xFF;
            raw[i * 2 + 1] =  _imgPalette[i]       & 0xFF;
        }
        raw.set(planes, colorCount * 2);

        const defaultPath = [
            _imgProjectDir ? _imgProjectDir.replace(/\\/g, '/') : null,
            _imgSourceDir || null,
            _imgFilename,
        ].filter(Boolean).join('/');

        const result = await window.electronAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'Amiga Interleaved Raw', extensions: ['iraw'] }],
            data: Array.from(raw),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        // Auto-save .pal alongside .iraw
        if (result.filePath) {
            const palPath = result.filePath.replace(/\.[^.]+$/, '') + '.pal';
            const palData = new Uint8Array(colorCount * 2);
            for (let i = 0; i < colorCount; i++) {
                palData[i * 2]     = (_imgPalette[i] >> 8) & 0xFF;
                palData[i * 2 + 1] =  _imgPalette[i]       & 0xFF;
            }
            await window.electronAPI.saveAsset({ path: palPath, data: Array.from(palData) });
        }

        // Auto-save .imask if requested
        if (genMask && result.filePath) {
            const maskPath = result.filePath.replace(/\.[^.]+$/, '') + '.imask';
            const maskData = _imgToMaskInterleaved(_imgIndices, _imgWidth, _imgHeight, depth);
            await window.electronAPI.saveAsset({ path: maskPath, data: Array.from(maskData) });
        }

        btn.textContent = 'Saved!';
        if (window.logLine) {
            const chipBytes = colorCount * 2 + planes.length;
            window.logLine(`[Image] Converted ${_imgFilename} (${(chipBytes/1024).toFixed(1)} KB Chip RAM)`, 'info');
        }
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
    } catch (err) {
        btn.textContent = 'Error!';
        if (window.logLine) window.logLine(`[Image] Save failed: '${_imgFilename}' (${_imgWidth}\u00d7${_imgHeight}) — ${err.message}`, 'error');
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
    }
}

// ── Export IFF ────────────────────────────────────────────────────────────────

async function _imgExportIFF() {
    if (!_imgData || !_imgIndices) return;
    const btn = document.getElementById('img-btn-export-iff');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const iffData     = createIFF(_imgWidth, _imgHeight, _imgPalette, _imgIndices, _imgDepth);
        const iffFilename = _imgFilename.replace(/\.iraw$/, '.iff');
        const defaultPath = [
            _imgProjectDir ? _imgProjectDir.replace(/\\/g, '/') : null,
            _imgSourceDir || null,
            iffFilename,
        ].filter(Boolean).join('/');

        const result = await window.electronAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'Amiga IFF/ILBM', extensions: ['iff', 'ilbm', 'lbm'] }],
            data: Array.from(iffData),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Export IFF'; return; }
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Export IFF'; btn.disabled = false; }, 1500);
    } catch (err) {
        btn.textContent = 'Error!';
        if (window.logLine) window.logLine(`[Image] IFF export failed: '${_imgFilename}' (${_imgWidth}\u00d7${_imgHeight}) — ${err.message}`, 'error');
        setTimeout(() => { btn.textContent = 'Export IFF'; btn.disabled = false; }, 2000);
    }
}

// ── Event wiring ─────────────────────────────────────────────────────────────

_imgInitPalette();

document.getElementById('img-sel-depth').addEventListener('change', _imgSchedulePreview);
document.getElementById('img-sel-dither').addEventListener('change', _imgSchedulePreview);
document.getElementById('img-btn-convert').addEventListener('click', _imgConvertAndSave);
document.getElementById('img-btn-export-iff').addEventListener('click', _imgExportIFF);

// ── 1:1 Toggle ───────────────────────────────────────────────────────────────

document.getElementById('img-btn-actual').addEventListener('click', () => {
    const ws  = document.getElementById('img-workspace');
    const btn = document.getElementById('img-btn-actual');
    ws.classList.toggle('img-view-actual');
    btn.classList.toggle('active');
});

// ── Resize / Crop wiring ────────────────────────────────────────────────────

// Aspect-ratio lock toggle
document.getElementById('img-dim-lock').addEventListener('click', () => {
    _imgAspectLock = !_imgAspectLock;
    const btn = document.getElementById('img-dim-lock');
    btn.classList.toggle('active', _imgAspectLock);
    btn.querySelector('i').className = _imgAspectLock ? 'codicon codicon-link' : 'codicon codicon-debug-disconnect';
});

// Width ↔ Height sync with aspect lock
document.getElementById('img-dim-w').addEventListener('input', () => {
    if (!_imgAspectLock || !_imgData) return;
    const w = parseInt(document.getElementById('img-dim-w').value) || 1;
    const ratio = _imgHeight / _imgWidth;
    document.getElementById('img-dim-h').value = Math.max(1, Math.round(w * ratio));
});
document.getElementById('img-dim-h').addEventListener('input', () => {
    if (!_imgAspectLock || !_imgData) return;
    const h = parseInt(document.getElementById('img-dim-h').value) || 1;
    const ratio = _imgWidth / _imgHeight;
    document.getElementById('img-dim-w').value = Math.max(1, Math.round(h * ratio));
});

// Resize button
document.getElementById('img-btn-resize').addEventListener('click', () => {
    const w = parseInt(document.getElementById('img-dim-w').value) || _imgWidth;
    const h = parseInt(document.getElementById('img-dim-h').value) || _imgHeight;
    _imgResize(w, h);
});

// Origin grid — select crop anchor
document.querySelectorAll('.img-origin-grid button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.img-origin-grid button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _imgCropOrigin = btn.dataset.origin;
    });
});

// Crop button
document.getElementById('img-btn-crop').addEventListener('click', () => {
    const w = parseInt(document.getElementById('img-dim-w').value) || _imgWidth;
    const h = parseInt(document.getElementById('img-dim-h').value) || _imgHeight;
    _imgCrop(w, h);
});

// ── Fullscreen OCS Preview ───────────────────────────────────────────────────

function _imgFsRender() {
    if (!_imgData) return;

    const depth      = parseInt(document.getElementById('img-fs-depth').value);
    const colorCount = Math.min(1 << depth, 32);
    const ditherMode = document.getElementById('img-fs-dither').value;

    // Recalculate palette when depth differs (TrueColor only)
    if (depth !== _imgDepth && !_imgIsIndexed) {
        const weights = _imgPoiWeights || undefined;
        const generated = medianCutPalette(_imgData, colorCount, 50, weights);
        for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
    }

    _imgDepth = depth;
    const indices = quantizeWithDither(_imgData, _imgPalette, colorCount, ditherMode);
    _imgIndices = indices;

    const c = document.getElementById('img-fs-canvas');
    c.width  = _imgWidth;
    c.height = _imgHeight;
    const ctx = c.getContext('2d');
    const out = ctx.createImageData(_imgWidth, _imgHeight);
    for (let i = 0; i < indices.length; i++) {
        const [r, g, b]     = _imgOcsToRgb(_imgPalette[indices[i]]);
        out.data[i * 4]     = r;
        out.data[i * 4 + 1] = g;
        out.data[i * 4 + 2] = b;
        out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);

    // Sync back to main toolbar
    document.getElementById('img-sel-depth').value  = String(depth);
    document.getElementById('img-sel-dither').value  = ditherMode;

    // Update main preview + palette
    _imgUpdatePalette();
}

function _imgFsOpen() {
    if (!_imgData) return;
    const overlay = document.getElementById('img-fullscreen-overlay');
    // Sync current main toolbar values into fullscreen dropdowns
    document.getElementById('img-fs-depth').value  = document.getElementById('img-sel-depth').value;
    document.getElementById('img-fs-dither').value = document.getElementById('img-sel-dither').value;
    overlay.style.display = 'flex';
    _imgFsRender();
}

function _imgFsClose() {
    document.getElementById('img-fullscreen-overlay').style.display = 'none';
    // Trigger main preview update to reflect any changes made in fullscreen
    _imgSchedulePreview();
}

document.getElementById('img-btn-fullscreen').addEventListener('click', _imgFsOpen);
document.getElementById('img-fs-close').addEventListener('click', _imgFsClose);
document.getElementById('img-fs-depth').addEventListener('change', _imgFsRender);
document.getElementById('img-fs-dither').addEventListener('change', _imgFsRender);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const overlay = document.getElementById('img-fullscreen-overlay');
        if (overlay.style.display !== 'none') {
            _imgFsClose();
            e.stopPropagation();
        }
    }
});

// ── POI (Point of Interest) ─────────────────────────────────────────────────

function _imgPoiClearOverlay() {
    const c = document.getElementById('img-canvas-mask-overlay');
    if (c) {
        c.width  = _imgWidth  || 1;
        c.height = _imgHeight || 1;
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
}

function _imgPoiClearMask() {
    if (_imgPoiMask) _imgPoiMask.fill(0);
    _imgPoiWeights = null;
    _imgPoiDirty = true;
    _imgPoiRenderOverlay();
    _imgPoiSchedulePipeline(100);
}

// Toggle POI mode
document.getElementById('img-btn-poi').addEventListener('click', () => {
    const panel = document.getElementById('image-editor-panel');
    const btn   = document.getElementById('img-btn-poi');
    const active = panel.classList.toggle('img-poi-active');
    btn.classList.toggle('active', active);
    if (!active) {
        _imgPoiPainting = false;
        _imgPoiHideCursor();
    }
});

// Clear mask — toolbar button
document.getElementById('img-btn-poi-clear').addEventListener('click', _imgPoiClearMask);
// Clear mask — sidebar button
document.getElementById('img-poi-sidebar-clear').addEventListener('click', _imgPoiClearMask);

// Slider ↔ Input sync: Brush Size
document.getElementById('img-poi-brush-range').addEventListener('input', (e) => {
    document.getElementById('img-poi-brush-num').value = e.target.value;
});
document.getElementById('img-poi-brush-num').addEventListener('input', (e) => {
    const v = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
    document.getElementById('img-poi-brush-range').value = v;
});

// Slider ↔ Input sync: Feather (+ trigger pipeline)
document.getElementById('img-poi-feather-range').addEventListener('input', (e) => {
    document.getElementById('img-poi-feather-num').value = e.target.value;
    _imgPoiSchedulePipeline(300);
});
document.getElementById('img-poi-feather-num').addEventListener('input', (e) => {
    const v = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
    document.getElementById('img-poi-feather-range').value = v;
    _imgPoiSchedulePipeline(300);
});

// ── T1b.6c: Pinsel-Werkzeug (Painting) ─────────────────────────────────────

function _imgPoiGetBrushSize() {
    return parseInt(document.getElementById('img-poi-brush-range').value) || 30;
}

/**
 * Map mouse event coordinates to image pixel coordinates.
 * The overlay canvas is CSS-scaled (object-fit: contain within .img-canvas-wrap),
 * so we need to map from DOM coordinates to actual image pixels.
 */
function _imgPoiMouseToPixel(e) {
    const overlay = document.getElementById('img-canvas-mask-overlay');
    const rect = overlay.getBoundingClientRect();

    // The overlay fills the wrap container. The actual image area within it
    // depends on the aspect ratio (object-fit: contain is on the underlying canvas,
    // but the overlay uses inset:0 / width:100% / height:100%).
    // We need to figure out where the image actually renders inside the wrap.
    const wrapW = rect.width;
    const wrapH = rect.height;
    const imgAspect = _imgWidth / _imgHeight;
    const wrapAspect = wrapW / wrapH;

    let renderW, renderH, offsetX, offsetY;
    if (imgAspect > wrapAspect) {
        // Image is wider than wrap → pillarbox (vertical bars)
        renderW = wrapW;
        renderH = wrapW / imgAspect;
        offsetX = 0;
        offsetY = (wrapH - renderH) / 2;
    } else {
        // Image is taller than wrap → letterbox (horizontal bars)
        renderH = wrapH;
        renderW = wrapH * imgAspect;
        offsetX = (wrapW - renderW) / 2;
        offsetY = 0;
    }

    const localX = e.clientX - rect.left - offsetX;
    const localY = e.clientY - rect.top  - offsetY;

    return {
        x: Math.floor((localX / renderW) * _imgWidth),
        y: Math.floor((localY / renderH) * _imgHeight),
    };
}

/**
 * Paint a circle of given radius onto _imgPoiMask at (cx, cy).
 * value: 255 = mask, 0 = erase.
 */
function _imgPoiPaintCircle(cx, cy, value) {
    if (!_imgPoiMask) return;
    const r = Math.max(1, Math.floor(_imgPoiGetBrushSize() / 2));
    const r2 = r * r;
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(_imgWidth  - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(_imgHeight - 1, cy + r);

    for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            if (dx * dx + dy * dy <= r2) {
                _imgPoiMask[y * _imgWidth + x] = value;
            }
        }
    }
    _imgPoiDirty = true;
}

// Mouse events on overlay canvas
const _poiOverlay = document.getElementById('img-canvas-mask-overlay');

_poiOverlay.addEventListener('mousedown', (e) => {
    if (!_imgPoiMask) return;
    e.preventDefault();
    _imgPoiPainting = true;
    _imgPoiErasing  = (e.button === 2);
    const { x, y } = _imgPoiMouseToPixel(e);
    _imgPoiPaintCircle(x, y, _imgPoiErasing ? 0 : 255);
    _imgPoiScheduleRender();
});

_poiOverlay.addEventListener('mousemove', (e) => {
    _imgPoiUpdateCursor(e);
    if (!_imgPoiPainting || !_imgPoiMask) return;
    const { x, y } = _imgPoiMouseToPixel(e);
    _imgPoiPaintCircle(x, y, _imgPoiErasing ? 0 : 255);
    _imgPoiScheduleRender();
});

_poiOverlay.addEventListener('mouseup',    () => {
    _imgPoiPainting = false;
    _imgPoiSchedulePipeline(200);
});
_poiOverlay.addEventListener('mouseleave', () => {
    const wasPainting = _imgPoiPainting;
    _imgPoiPainting = false;
    _imgPoiHideCursor();
    if (wasPainting) _imgPoiSchedulePipeline(200);
});

// Suppress context menu on overlay so right-click can erase
_poiOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

// ── T1b.6c: Custom brush cursor ─────────────────────────────────────────────

function _imgPoiUpdateCursor(e) {
    const overlay = document.getElementById('img-canvas-mask-overlay');
    const rect = overlay.getBoundingClientRect();
    const brushSize = _imgPoiGetBrushSize();

    // Calculate the display-scale of the brush circle
    const wrapW = rect.width;
    const wrapH = rect.height;
    const imgAspect = _imgWidth / _imgHeight;
    const wrapAspect = wrapW / wrapH;
    const renderW = imgAspect > wrapAspect ? wrapW : wrapH * imgAspect;
    const scale = renderW / _imgWidth;
    const displayRadius = Math.max(2, (brushSize / 2) * scale);

    // Position a CSS circle via a tiny canvas → data URL would be costly per-move.
    // Instead, use a floating div as cursor indicator.
    let cursor = document.getElementById('img-poi-cursor');
    if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'img-poi-cursor';
        cursor.style.cssText = 'position:fixed;pointer-events:none;border:1.5px solid rgba(122,197,255,0.8);border-radius:50%;z-index:600;box-sizing:border-box;';
        document.body.appendChild(cursor);
    }
    const d = displayRadius * 2;
    cursor.style.width  = d + 'px';
    cursor.style.height = d + 'px';
    cursor.style.left   = (e.clientX - displayRadius) + 'px';
    cursor.style.top    = (e.clientY - displayRadius) + 'px';
    cursor.style.display = 'block';
}

function _imgPoiHideCursor() {
    const cursor = document.getElementById('img-poi-cursor');
    if (cursor) cursor.style.display = 'none';
}

// ── T1b.6d: Masken-Visualisierung ───────────────────────────────────────────

function _imgPoiRenderOverlay() {
    _imgPoiDirty = false;
    const c = document.getElementById('img-canvas-mask-overlay');
    if (!c || !_imgPoiMask || !_imgWidth || !_imgHeight) return;

    c.width  = _imgWidth;
    c.height = _imgHeight;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(_imgWidth, _imgHeight);
    const d   = img.data;

    for (let i = 0; i < _imgPoiMask.length; i++) {
        const v = _imgPoiMask[i];
        const p = i * 4;
        if (v > 0) {
            // Masked area: orange/red tint, opacity ∝ mask value (max ~30%)
            d[p]     = 255;  // R
            d[p + 1] = 120;  // G
            d[p + 2] = 40;   // B
            d[p + 3] = Math.round((v / 255) * 76); // ~30% at v=255
        } else {
            // Non-masked area: slight black dim (~10%)
            d[p]     = 0;
            d[p + 1] = 0;
            d[p + 2] = 0;
            d[p + 3] = 25;   // ~10% black
        }
    }

    ctx.putImageData(img, 0, 0);
}

function _imgPoiScheduleRender() {
    if (_imgPoiRafId) return;
    _imgPoiRafId = requestAnimationFrame(() => {
        _imgPoiRafId = null;
        if (_imgPoiDirty) _imgPoiRenderOverlay();
    });
}

// ── T1b.6e: Feathering (Gauß-Blur auf Maske) ───────────────────────────────

/**
 * Separable 1D Gaussian blur on a Uint8Array mask.
 * Returns a Float32Array (0.0–1.0) of the same dimensions.
 */
function _imgGaussBlur(mask, width, height, radius) {
    if (radius <= 0) {
        // No blur — just normalize to 0.0–1.0
        const out = new Float32Array(mask.length);
        for (let i = 0; i < mask.length; i++) out[i] = mask[i] / 255;
        return out;
    }

    // Build 1D Gaussian kernel
    const sigma = Math.max(radius / 3, 0.5);
    const kSize = radius * 2 + 1;
    const kernel = new Float32Array(kSize);
    let sum = 0;
    for (let i = 0; i < kSize; i++) {
        const x = i - radius;
        kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
        sum += kernel[i];
    }
    for (let i = 0; i < kSize; i++) kernel[i] /= sum;

    // Horizontal pass: mask → tmp
    const tmp = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let k = 0; k < kSize; k++) {
                const sx = Math.min(width - 1, Math.max(0, x + k - radius));
                acc += mask[row + sx] * kernel[k];
            }
            tmp[row + x] = acc;
        }
    }

    // Vertical pass: tmp → out
    const out = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let acc = 0;
            for (let k = 0; k < kSize; k++) {
                const sy = Math.min(height - 1, Math.max(0, y + k - radius));
                acc += tmp[sy * width + x] * kernel[k];
            }
            out[y * width + x] = Math.min(1.0, acc / 255);
        }
    }
    return out;
}

/**
 * Recalculate _imgPoiWeights from _imgPoiMask + feather value,
 * then update the overlay to show the feathered mask.
 */
function _imgPoiUpdateWeights() {
    if (!_imgPoiMask || !_imgWidth || !_imgHeight) {
        _imgPoiWeights = null;
        return;
    }
    const feather = parseInt(document.getElementById('img-poi-feather-range').value) || 0;
    const radius  = Math.ceil(feather / 2);
    _imgPoiWeights = _imgGaussBlur(_imgPoiMask, _imgWidth, _imgHeight, radius);

    // Re-render overlay using feathered weights
    _imgPoiRenderOverlayFromWeights();
}

/**
 * Render overlay using feathered weights (Float32Array) instead of raw mask.
 * This gives a smooth visual representation of the feathered POI area.
 */
function _imgPoiRenderOverlayFromWeights() {
    const c = document.getElementById('img-canvas-mask-overlay');
    if (!c || !_imgPoiWeights || !_imgWidth || !_imgHeight) return;

    c.width  = _imgWidth;
    c.height = _imgHeight;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(_imgWidth, _imgHeight);
    const d   = img.data;

    for (let i = 0; i < _imgPoiWeights.length; i++) {
        const w = _imgPoiWeights[i];
        const p = i * 4;
        if (w > 0.001) {
            d[p]     = 255;  // R
            d[p + 1] = 120;  // G
            d[p + 2] = 40;   // B
            d[p + 3] = Math.round(w * 76); // ~30% at w=1.0
        } else {
            d[p]     = 0;
            d[p + 1] = 0;
            d[p + 2] = 0;
            d[p + 3] = 25;   // ~10% dim
        }
    }
    ctx.putImageData(img, 0, 0);
}

// ── T1b.6g: Echtzeit-Vorschau-Pipeline ──────────────────────────────────────

/**
 * Full recalculation pipeline: feathering → weights → palette → quantize → preview.
 * Called after mouseup (painting done) or feather-slider change.
 */
function _imgPoiRunPipeline() {
    if (!_imgData || !_imgPoiMask) return;

    const statusEl = document.getElementById('img-status');
    statusEl.textContent = 'Recalculating\u2026';

    // 1. Feathering → weights
    _imgPoiUpdateWeights();

    // 2. Check if any mask pixel is set — if not, skip weighted palette
    let hasMask = false;
    for (let i = 0; i < _imgPoiMask.length; i++) {
        if (_imgPoiMask[i] > 0) { hasMask = true; break; }
    }

    // 3. Recalculate palette (weighted if mask active, TrueColor only)
    if (!_imgIsIndexed) {
        const depth      = parseInt(document.getElementById('img-sel-depth').value);
        const colorCount = Math.min(1 << depth, 32);
        const weights    = hasMask ? _imgPoiWeights : undefined;
        const generated  = medianCutPalette(_imgData, colorCount, 50, weights);
        for (let i = 0; i < 32; i++) _imgPalette[i] = generated[i] ?? 0;
    }

    // 4. Re-render preview (quantize + display)
    _imgRenderPreview();

    const poiLabel = hasMask ? ', POI active' : '';
    const typeLabel = _imgIsIndexed ? 'Indexed' : 'TrueColor';
    statusEl.textContent =
        `${_imgFilename.replace(/\.iraw$/, '')} — ${_imgWidth} \u00d7 ${_imgHeight} px (${typeLabel}${poiLabel})`;
}

/**
 * Schedule a debounced pipeline run.
 * @param {number} delay  ms to wait before running (default 200)
 */
function _imgPoiSchedulePipeline(delay = 200) {
    if (_imgPoiPipelineTimer) clearTimeout(_imgPoiPipelineTimer);
    _imgPoiPipelineTimer = setTimeout(() => {
        _imgPoiPipelineTimer = null;
        _imgPoiRunPipeline();
    }, delay);
}
