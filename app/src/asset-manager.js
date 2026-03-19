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
    const zone = document.getElementById('image-drop-zone');
    zone.querySelector('.drop-label').textContent = `Loading ${item.name}\u2026`;
    zone.querySelector('.drop-sub').textContent   = '';
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
        zone.querySelector('.drop-label').textContent = `Error: ${err.message}`;
        console.error('[A-MGR] loadSourceImageFromProject:', err);
    }
}

async function onImageDropped(file) {
    if (!file) return;
    const zone = document.getElementById('image-drop-zone');
    zone.querySelector('.drop-label').textContent = `Loading ${file.name}\u2026`;
    zone.querySelector('.drop-sub').textContent   = '';

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

        zone.querySelector('.drop-label').textContent = file.name;
        zone.querySelector('.drop-sub').textContent   = `${width} \u00d7 ${height} px`;

        renderPreview();

        switchToTab('images');

    } catch (err) {
        zone.querySelector('.drop-label').textContent = `Error: ${err.message}`;
    }
}

// ── Convert & Save ────────────────────────────────────────────────────────────
async function onConvertAndSave() {
    if (!_imageData || !_lastIndices) return;
    const btn = document.getElementById('btn-convert-image');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const depth      = _lastDepth;
        const colorCount = 1 << depth;
        const planes     = toPlanarBitmap(_lastIndices, _imageWidth, _imageHeight, depth);

        // Prepend OCS palette: colorCount × 2-byte big-endian words ($0RGB).
        const raw = new Uint8Array(colorCount * 2 + planes.length);
        for (let i = 0; i < colorCount; i++) {
            raw[i * 2]     = (_palette[i] >> 8) & 0xFF;
            raw[i * 2 + 1] =  _palette[i]       & 0xFF;
        }
        raw.set(planes, colorCount * 2);

        const defaultPath = [
            _projectDir ? _projectDir.replace(/\\/g, '/') : null,
            _imageSourceDir || null,
            _imageFilename,
        ].filter(Boolean).join('/');

        const result = await window.assetAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'Amiga Raw', extensions: ['raw'] }],
            data:    Array.from(raw),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }
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
    const code = `LoadImage 0, "${_imageFilename}", ${_imageWidth}, ${_imageHeight}`;
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

// ── Drop zones ────────────────────────────────────────────────────────────────
function setupDropZone(id, onFile) {
    const zone = document.getElementById(id);
    if (!zone) return;
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
    });
}

setupDropZone('image-drop-zone', file => { _imageSourceDir = ''; onImageDropped(file); });
setupDropZone('sound-drop-zone', file => {
    const zone = document.getElementById('sound-drop-zone');
    zone.querySelector('.drop-label').textContent = file.name;
    zone.querySelector('.drop-sub').textContent   = `${(file.size / 1024).toFixed(1)} KB — conversion not yet implemented (A-MGR-3)`;
});

// ── Controls wiring ───────────────────────────────────────────────────────────
document.getElementById('sel-depth')   .addEventListener('change', () => { if (_imageData) schedulePreview(); });
document.getElementById('sel-dither')  .addEventListener('change', () => { if (_imageData) schedulePreview(); });
document.getElementById('btn-convert-image') .addEventListener('click', onConvertAndSave);
document.getElementById('btn-export-iff')    .addEventListener('click', onExportIFF);
document.getElementById('btn-copy-image-code').addEventListener('click', onCopyImageCode);

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

applyProject(null);
