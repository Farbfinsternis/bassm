'use strict';

// ── Font Editor ────────────────────────────────────────────────────────────
// Converts a PNG font sheet to BASSM .bfnt format (1-bit glyph shapes).
// Opened via right-click → "Open as Font" on a PNG in the Project Tree,
// or by double-clicking a .bfnt file.
//
// .bfnt binary format:
//   Offset  Size      Field
//   0       4         Magic "BFNT" (0x42, 0x46, 0x4E, 0x54)
//   4       2         charW  (BE word)
//   6       2         charH  (BE word)
//   8       2         charCount (BE word)
//   10      1         flags  (bit 0: 0 = ASCII 128-byte lookup, 1 = full 256-byte)
//   11      1         reserved (0)
//   12      128|256   lookup table (charCode → glyph index; $FF = not in font)
//   12+N    C×charH   glyph data (1 byte per row, MSB-first packed bits)

// ── State ──────────────────────────────────────────────────────────────────
let _fntData       = null;   // ImageData from loaded PNG
let _fntWidth      = 0;
let _fntHeight     = 0;
let _fntFilename   = '';     // output filename, e.g. "font.bfnt"
let _fntSourceDir  = '';
let _fntProjectDir = null;
let _fntCharW      = 8;
let _fntCharH      = 8;
let _fntGlyphs     = null;   // Uint8Array: charCount × charH bytes (1-bit packed)
let _fntCharCount  = 0;
let _fntRafHandle  = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function _fntLoadBlob(blob) {
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

// ── Extract 1-bit glyphs from ImageData ────────────────────────────────────
// Each glyph: charH bytes, 1 byte per row, MSB = leftmost pixel.
// Pixel is "on" (foreground) if alpha >= 128 AND at least one RGB channel > 0.

function _fntExtractGlyphs(imageData, sheetW, sheetH, charW, charH) {
    const d    = imageData.data;
    const cols = Math.floor(sheetW / charW);
    const rows = Math.floor(sheetH / charH);
    const charCount = cols * rows;
    const glyphs = new Uint8Array(charCount * charH);

    for (let gi = 0; gi < charCount; gi++) {
        const cx = (gi % cols) * charW;
        const cy = Math.floor(gi / cols) * charH;

        for (let row = 0; row < charH; row++) {
            let byte = 0;
            for (let bit = 0; bit < Math.min(charW, 8); bit++) {
                const px  = cx + bit;
                const py  = cy + row;
                const idx = (py * sheetW + px) * 4;
                const a = d[idx + 3];
                const r = d[idx];
                const g = d[idx + 1];
                const b = d[idx + 2];
                if (a >= 128 && (r > 0 || g > 0 || b > 0)) {
                    byte |= (0x80 >> bit);
                }
            }
            glyphs[gi * charH + row] = byte;
        }
    }
    return { glyphs, charCount, cols, rows };
}

// ── Build lookup table ─────────────────────────────────────────────────────

function _fntBuildLookup(charset, charCount) {
    if (charset === 'full') {
        const lookup = new Uint8Array(256).fill(0xFF);
        for (let i = 0; i < Math.min(charCount, 256); i++) lookup[i] = i;
        return lookup;
    }
    // ASCII 32–127 → glyph indices 0..95
    const lookup = new Uint8Array(128).fill(0xFF);
    for (let i = 32; i < 128 && (i - 32) < charCount; i++) lookup[i] = i - 32;
    return lookup;
}

// ── Render preview ─────────────────────────────────────────────────────────

function _fntRenderPreview() {
    if (!_fntData) return;

    const charW = parseInt(document.getElementById('fnt-sel-charw').value);
    const charH = parseInt(document.getElementById('fnt-sel-charh').value);
    _fntCharW = charW;
    _fntCharH = charH;

    const result  = _fntExtractGlyphs(_fntData, _fntWidth, _fntHeight, charW, charH);
    _fntGlyphs    = result.glyphs;
    _fntCharCount = result.charCount;

    // ── Sheet canvas with grid overlay ──────────────────────────────────
    const cs  = document.getElementById('fnt-canvas-sheet');
    cs.width  = _fntWidth;
    cs.height = _fntHeight;
    cs.style.aspectRatio = `${_fntWidth} / ${_fntHeight}`;
    const ctxS = cs.getContext('2d');
    ctxS.putImageData(_fntData, 0, 0);

    ctxS.strokeStyle = 'rgba(255, 255, 0, 0.3)';
    ctxS.lineWidth   = 1;
    for (let x = 0; x <= _fntWidth; x += charW) {
        ctxS.beginPath(); ctxS.moveTo(x + 0.5, 0); ctxS.lineTo(x + 0.5, _fntHeight); ctxS.stroke();
    }
    for (let y = 0; y <= _fntHeight; y += charH) {
        ctxS.beginPath(); ctxS.moveTo(0, y + 0.5); ctxS.lineTo(_fntWidth, y + 0.5); ctxS.stroke();
    }

    // ── Character preview (extracted glyphs rendered at 2×) ─────────────
    const previewCols = 16;
    const previewRows = Math.min(Math.ceil(_fntCharCount / previewCols), 16);
    const scale = 2;
    const cc  = document.getElementById('fnt-canvas-char');
    cc.width  = previewCols * charW * scale;
    cc.height = previewRows * charH * scale;
    cc.style.aspectRatio = `${cc.width} / ${cc.height}`;
    const ctxC = cc.getContext('2d');
    ctxC.fillStyle = '#000';
    ctxC.fillRect(0, 0, cc.width, cc.height);

    for (let gi = 0; gi < Math.min(_fntCharCount, previewCols * previewRows); gi++) {
        const px = (gi % previewCols) * charW * scale;
        const py = Math.floor(gi / previewCols) * charH * scale;
        for (let row = 0; row < charH; row++) {
            const byte = _fntGlyphs[gi * charH + row];
            for (let bit = 0; bit < charW; bit++) {
                if ((byte >> (7 - bit)) & 1) {
                    ctxC.fillStyle = '#0f0';
                    ctxC.fillRect(px + bit * scale, py + row * scale, scale, scale);
                }
            }
        }
    }

    // ── Sidebar properties ──────────────────────────────────────────────
    const charset    = document.getElementById('fnt-sel-charset').value;
    const lookupSize = charset === 'full' ? 256 : 128;
    const dataSize   = 12 + lookupSize + _fntCharCount * charH;

    document.getElementById('fnt-prop-file').textContent     = _fntFilename;
    document.getElementById('fnt-prop-sheet').textContent     = `${_fntWidth} \u00d7 ${_fntHeight} px`;
    document.getElementById('fnt-prop-charsize').textContent  = `${charW} \u00d7 ${charH} px`;
    document.getElementById('fnt-prop-chars').textContent     = String(_fntCharCount);
    document.getElementById('fnt-prop-chip').textContent      = `${(dataSize / 1024).toFixed(1)} KB`;
    document.getElementById('fnt-prop-pct').textContent       = `${(dataSize / (512 * 1024) * 100).toFixed(2)}%`;

    document.getElementById('fnt-btn-convert').disabled   = false;
    document.getElementById('fnt-btn-copy-code').disabled  = false;
}

function _fntSchedulePreview() {
    if (_fntRafHandle) cancelAnimationFrame(_fntRafHandle);
    _fntRafHandle = requestAnimationFrame(() => { _fntRafHandle = null; _fntRenderPreview(); });
}

// ── Open image as font sheet ───────────────────────────────────────────────

async function fntOpenFile(relativePath, projectDir) {
    _fntProjectDir = projectDir;
    const name       = relativePath.replace(/\\/g, '/').split('/').pop();
    const normalized = relativePath.replace(/\\/g, '/');
    const slashIdx   = normalized.lastIndexOf('/');
    _fntSourceDir    = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';

    const statusEl = document.getElementById('fnt-status');
    statusEl.textContent = `Loading ${name}\u2026`;

    try {
        const bytes    = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        const ext      = name.split('.').pop().toLowerCase();
        const mime     = { png: 'image/png', jpg: 'image/jpeg', bmp: 'image/bmp' }[ext] || 'image/png';
        const blob     = new Blob([new Uint8Array(bytes)], { type: mime });
        const { imageData, width, height } = await _fntLoadBlob(blob);

        _fntData     = imageData;
        _fntWidth    = width;
        _fntHeight   = height;
        _fntFilename = name.replace(/\.[^.]+$/, '') + '.bfnt';

        document.getElementById('fnt-placeholder').style.display = 'none';
        document.getElementById('fnt-workspace').style.display   = '';
        document.getElementById('fnt-content').classList.add('has-font');

        statusEl.textContent = `${name} \u2014 ${width} \u00d7 ${height} px`;

        _fntRenderPreview();

        if (window.logLine) window.logLine(`[Font] Opened ${name} (${width}\u00d7${height})`, 'info');
    } catch (err) {
        statusEl.textContent = `Error loading ${name}`;
        if (window.logLine) window.logLine(`[Font] Error: '${name}' \u2014 ${err.message}`, 'error');
    }
}

window.fntOpenFile = fntOpenFile;

// ── Open .bfnt binary ─────────────────────────────────────────────────────

async function fntOpenBfntFile(relativePath, projectDir) {
    _fntProjectDir = projectDir;
    const name       = relativePath.replace(/\\/g, '/').split('/').pop();
    const normalized = relativePath.replace(/\\/g, '/');
    const slashIdx   = normalized.lastIndexOf('/');
    _fntSourceDir    = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';

    const statusEl = document.getElementById('fnt-status');
    statusEl.textContent = `Loading ${name}\u2026`;

    try {
        const bytes = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        const buf   = new Uint8Array(bytes);

        // Validate magic "BFNT"
        if (buf.length < 12 || buf[0] !== 0x42 || buf[1] !== 0x46 || buf[2] !== 0x4E || buf[3] !== 0x54) {
            throw new Error('Not a valid .bfnt file (bad magic)');
        }

        const charW     = (buf[4] << 8) | buf[5];
        const charH     = (buf[6] << 8) | buf[7];
        const charCount = (buf[8] << 8) | buf[9];
        const flags     = buf[10];
        const lookupSize    = (flags & 1) ? 256 : 128;
        const glyphDataSize = charCount * charH;

        if (buf.length < 12 + lookupSize + glyphDataSize) {
            throw new Error(`File too short: expected ${12 + lookupSize + glyphDataSize} bytes, got ${buf.length}`);
        }

        _fntCharW     = charW;
        _fntCharH     = charH;
        _fntCharCount = charCount;
        _fntGlyphs    = buf.slice(12 + lookupSize, 12 + lookupSize + glyphDataSize);
        _fntFilename  = name;
        _fntData      = null;   // no source image
        _fntWidth     = 0;
        _fntHeight    = 0;

        // Sync dropdowns to match binary header
        const charWEl   = document.getElementById('fnt-sel-charw');
        const charHEl   = document.getElementById('fnt-sel-charh');
        const charsetEl = document.getElementById('fnt-sel-charset');
        for (const o of charWEl.options) { if (parseInt(o.value) === charW) { charWEl.value = o.value; break; } }
        for (const o of charHEl.options) { if (parseInt(o.value) === charH) { charHEl.value = o.value; break; } }
        charsetEl.value = (flags & 1) ? 'full' : 'ascii';

        document.getElementById('fnt-placeholder').style.display = 'none';
        document.getElementById('fnt-workspace').style.display   = '';
        document.getElementById('fnt-content').classList.add('has-font');

        _fntRenderBfntPreview();

        // Properties
        const dataSize = 12 + lookupSize + glyphDataSize;
        document.getElementById('fnt-prop-file').textContent     = name;
        document.getElementById('fnt-prop-sheet').textContent     = '(binary)';
        document.getElementById('fnt-prop-charsize').textContent  = `${charW} \u00d7 ${charH} px`;
        document.getElementById('fnt-prop-chars').textContent     = String(charCount);
        document.getElementById('fnt-prop-chip').textContent      = `${(dataSize / 1024).toFixed(1)} KB`;
        document.getElementById('fnt-prop-pct').textContent       = `${(dataSize / (512 * 1024) * 100).toFixed(2)}%`;

        document.getElementById('fnt-btn-convert').disabled   = true;   // already converted
        document.getElementById('fnt-btn-copy-code').disabled  = false;

        statusEl.textContent = `${name} \u2014 ${charW}\u00d7${charH}, ${charCount} chars`;
        if (window.logLine) window.logLine(`[Font] Opened ${name} (${charCount} chars, ${charW}\u00d7${charH})`, 'info');
    } catch (err) {
        statusEl.textContent = `Error loading ${name}`;
        if (window.logLine) window.logLine(`[Font] Error: '${name}' \u2014 ${err.message}`, 'error');
    }
}

function _fntRenderBfntPreview() {
    const charW = _fntCharW, charH = _fntCharH, charCount = _fntCharCount;
    const previewCols = 16;
    const previewRows = Math.ceil(charCount / previewCols);

    // ── Sheet canvas: reconstruct glyph grid from binary data ───────────
    const cs  = document.getElementById('fnt-canvas-sheet');
    cs.width  = previewCols * charW;
    cs.height = previewRows * charH;
    cs.style.aspectRatio = `${cs.width} / ${cs.height}`;
    const ctxS = cs.getContext('2d');
    ctxS.fillStyle = '#000';
    ctxS.fillRect(0, 0, cs.width, cs.height);

    for (let gi = 0; gi < charCount; gi++) {
        const px = (gi % previewCols) * charW;
        const py = Math.floor(gi / previewCols) * charH;
        for (let row = 0; row < charH; row++) {
            const byte = _fntGlyphs[gi * charH + row];
            for (let bit = 0; bit < charW; bit++) {
                if ((byte >> (7 - bit)) & 1) {
                    ctxS.fillStyle = '#fff';
                    ctxS.fillRect(px + bit, py + row, 1, 1);
                }
            }
        }
    }
    // Grid overlay
    ctxS.strokeStyle = 'rgba(255, 255, 0, 0.3)';
    ctxS.lineWidth   = 1;
    for (let x = 0; x <= cs.width; x += charW) {
        ctxS.beginPath(); ctxS.moveTo(x + 0.5, 0); ctxS.lineTo(x + 0.5, cs.height); ctxS.stroke();
    }
    for (let y = 0; y <= cs.height; y += charH) {
        ctxS.beginPath(); ctxS.moveTo(0, y + 0.5); ctxS.lineTo(cs.width, y + 0.5); ctxS.stroke();
    }

    // ── Character preview at 2× ─────────────────────────────────────────
    const scale   = 2;
    const maxRows = Math.min(previewRows, 16);
    const cc  = document.getElementById('fnt-canvas-char');
    cc.width  = previewCols * charW * scale;
    cc.height = maxRows * charH * scale;
    cc.style.aspectRatio = `${cc.width} / ${cc.height}`;
    const ctxC = cc.getContext('2d');
    ctxC.fillStyle = '#000';
    ctxC.fillRect(0, 0, cc.width, cc.height);

    for (let gi = 0; gi < Math.min(charCount, previewCols * maxRows); gi++) {
        const px = (gi % previewCols) * charW * scale;
        const py = Math.floor(gi / previewCols) * charH * scale;
        for (let row = 0; row < charH; row++) {
            const byte = _fntGlyphs[gi * charH + row];
            for (let bit = 0; bit < charW; bit++) {
                if ((byte >> (7 - bit)) & 1) {
                    ctxC.fillStyle = '#0f0';
                    ctxC.fillRect(px + bit * scale, py + row * scale, scale, scale);
                }
            }
        }
    }
}

window.fntOpenBfntFile = fntOpenBfntFile;

// ── Convert & Save (.bfnt) ─────────────────────────────────────────────────

async function _fntConvertAndSave() {
    if (!_fntData || !_fntGlyphs) return;
    const btn = document.getElementById('fnt-btn-convert');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        const charset    = document.getElementById('fnt-sel-charset').value;
        const lookup     = _fntBuildLookup(charset, _fntCharCount);
        const lookupSize = lookup.length;
        const flags      = charset === 'full' ? 1 : 0;

        const headerSize    = 12;
        const glyphDataSize = _fntCharCount * _fntCharH;
        const totalSize     = headerSize + lookupSize + glyphDataSize;
        const out = new Uint8Array(totalSize);

        // Magic "BFNT"
        out[0] = 0x42; out[1] = 0x46; out[2] = 0x4E; out[3] = 0x54;
        // charW (BE word)
        out[4] = (_fntCharW >> 8) & 0xFF; out[5] = _fntCharW & 0xFF;
        // charH (BE word)
        out[6] = (_fntCharH >> 8) & 0xFF; out[7] = _fntCharH & 0xFF;
        // charCount (BE word)
        out[8] = (_fntCharCount >> 8) & 0xFF; out[9] = _fntCharCount & 0xFF;
        // flags + reserved
        out[10] = flags;
        out[11] = 0;

        out.set(lookup, headerSize);
        out.set(_fntGlyphs.slice(0, glyphDataSize), headerSize + lookupSize);

        const defaultPath = [
            _fntProjectDir ? _fntProjectDir.replace(/\\/g, '/') : null,
            _fntSourceDir || null,
            _fntFilename,
        ].filter(Boolean).join('/');

        const result = await window.electronAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'BASSM Font', extensions: ['bfnt'] }],
            data: Array.from(out),
        });
        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        btn.textContent = 'Saved!';
        if (window.logLine) {
            window.logLine(`[Font] Converted ${_fntFilename} (${_fntCharCount} chars, ${(totalSize / 1024).toFixed(1)} KB)`, 'info');
        }
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
    } catch (err) {
        btn.textContent = 'Error!';
        if (window.logLine) window.logLine(`[Font] Save failed: '${_fntFilename}' \u2014 ${err.message}`, 'error');
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
    }
}

// ── Copy Code ──────────────────────────────────────────────────────────────

function _fntCopyCode() {
    if (!_fntData) return;
    const code = `LoadFont 0, "${_fntFilename}"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('fnt-btn-copy-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// ── Event wiring ───────────────────────────────────────────────────────────

document.getElementById('fnt-sel-charw').addEventListener('change', _fntSchedulePreview);
document.getElementById('fnt-sel-charh').addEventListener('change', _fntSchedulePreview);
document.getElementById('fnt-sel-depth').addEventListener('change', _fntSchedulePreview);
document.getElementById('fnt-sel-charset').addEventListener('change', _fntSchedulePreview);
document.getElementById('fnt-btn-convert').addEventListener('click', _fntConvertAndSave);
document.getElementById('fnt-btn-copy-code').addEventListener('click', _fntCopyCode);
