'use strict';

// ── Font Editor ────────────────────────────────────────────────────────────
// Converts a PNG font sheet to BASSM .bfnt format (1-bit glyph shapes).
// Opened via right-click → "Open as Font" on a PNG in the Project Tree,
// or by double-clicking a .bfnt file.
//
// .bfnt binary format (M1-T10, 16-byte header):
//   Offset  Size      Field
//   0       4         Magic "BFNT" (0x42, 0x46, 0x4E, 0x54)
//   4       2         charW  (BE word)
//   6       2         charH  (BE word)
//   8       2         charCount (BE word)
//   10      1         flags  (bit 0: 0 = ASCII 128-byte lookup, 1 = full 256-byte)
//   11      1         tracking (px, 0..255 — added to charW per non-space char)
//   12      2         spaceWidth (BE word, 0..4096 — 0 means "use charW")
//   14      2         reserved (must be 0 — used for v1-vs-v2 detection)
//   16      128|256   lookup table (charCode → glyph index; $FF = not in font)
//   16+N    C×charH   glyph data (1 byte per row, MSB-first packed bits)

// Default charset string (M1-T01) — Glyph-Reihenfolge im Sheet:
// Glyph 0 = '1', Glyph 1 = '2', …, Glyph N = letztes Zeichen im String.
// User kann erweitern oder kürzen. Auswertung (Lookup-Aufbau) folgt in M1-T02.
const FNT_DEFAULT_CHARSET =
    '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ,.-;:_<>|!"§$%&/()=?@\\}][{';

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
// M1-T04: Erkannter Hintergrund. Form: { r, g, b, a, source } oder null = "unklar".
// Sonderfall: a === 0 → "alpha-mode" (alle Pixel mit alpha < 128 = BG, egal welche RGB).
// Sonst: pixel == bg → BG.
let _fntBgColor    = null;
// M1-T04: Roh-PNG-Bytes für Palette-Erkennung (nur PNG; null bei BMP/JPG).
let _fntPngBytes   = null;
// M1-T04b: User-Override für die BG-Konvention. 'auto' = Fallback-Kette aus T04;
// 'index0'|'magenta'|'alpha'|'black' = explizite Konvention; 'pick' = nächster Sheet-Klick
// liest die Pixelfarbe.
let _fntPickArmed  = false;

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

// ── M1-T04: PNG palette + background detection ────────────────────────────

// Parse PNG chunks; returns { isIndexed, paletteIndex0 } or null if not a PNG.
// Wir lesen nur IHDR (color type) und PLTE (Palette-Triplets); keine CRC-Validierung,
// kein zlib-Decode, kein IDAT — wir wollen nur Index 0 für Indexed-PNGs.
function _fntParsePngPalette(bytes) {
    if (!bytes || bytes.length < 8) return null;
    const magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return null;

    let pos = 8;
    let isIndexed = false;
    let paletteIndex0 = null;

    while (pos + 12 <= bytes.length) {
        const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        const dataStart = pos + 8;
        if (dataStart + len + 4 > bytes.length) break;   // truncated / corrupt

        if (type === 'IHDR' && len >= 13) {
            isIndexed = (bytes[dataStart + 9] === 3);   // color type 3 = indexed
        } else if (type === 'PLTE' && len >= 3) {
            paletteIndex0 = { r: bytes[dataStart], g: bytes[dataStart + 1], b: bytes[dataStart + 2] };
        } else if (type === 'IEND') {
            break;
        }
        pos = dataStart + len + 4;   // skip data + CRC
    }
    return { isIndexed, paletteIndex0 };
}

// Detect background colour from imageData using the documented fallback chain:
//   1. Indexed PNG → palette index 0
//   2. Magic Magenta (#FF00FF) present in image
//   3. Any pixel with alpha < 128 → transparent-mode (a=0 sentinel)
//   4. Black (#000000) fallback
// Returns { r, g, b, a, source } or null if no convention fires (single-colour sheet).
function _fntDetectBackground(imageData, pngBytes) {
    // Step 1 — Indexed PNG
    const palInfo = _fntParsePngPalette(pngBytes);
    if (palInfo && palInfo.isIndexed && palInfo.paletteIndex0) {
        return { ...palInfo.paletteIndex0, a: 255, source: 'Index 0 (PLTE)' };
    }

    // Steps 2 + 3 require a single pixel scan.
    const d = imageData.data;
    let hasMagenta = false;
    let hasAlpha   = false;
    let hasBlack   = false;
    const colorSet = new Set();   // tracks distinct opaque colours; for single-colour detection
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 128) { hasAlpha = true; continue; }
        if (r === 255 && g === 0 && b === 255) hasMagenta = true;
        if (r === 0 && g === 0 && b === 0) hasBlack = true;
        if (colorSet.size < 3) colorSet.add((r << 16) | (g << 8) | b);
    }

    if (hasMagenta) return { r: 255, g: 0, b: 255, a: 255, source: 'Magic Magenta (#FF00FF)' };
    if (hasAlpha)   return { r: 0,   g: 0, b: 0,   a: 0,   source: 'Alpha < 128' };
    if (hasBlack)   return { r: 0,   g: 0, b: 0,   a: 255, source: 'Black fallback' };

    // Single-colour sheet: cannot determine BG without help → null
    if (colorSet.size <= 1) return null;
    // Multi-colour but no recognised BG → fall back to Black anyway, mark as "guess"
    return { r: 0, g: 0, b: 0, a: 255, source: 'Black fallback (guess)' };
}

// M1-T04b: Resolve the BG mode (Auto/Index0/Magenta/Alpha/Black/Pick) into a
// concrete _fntBgColor. Called from PNG-load and on mode-select change.
// 'pick' arms _fntPickArmed; the actual colour is set by the canvas-click listener.
function _fntApplyBgMode(mode) {
    if (!_fntData) return;
    _fntPickArmed = false;
    const cs = document.getElementById('fnt-canvas-sheet');
    if (cs) cs.style.cursor = '';

    if (mode === 'auto') {
        _fntBgColor = _fntDetectBackground(_fntData, _fntPngBytes);
    } else if (mode === 'index0') {
        const palInfo = _fntParsePngPalette(_fntPngBytes);
        if (palInfo && palInfo.isIndexed && palInfo.paletteIndex0) {
            _fntBgColor = { ...palInfo.paletteIndex0, a: 255, source: 'Index 0 (PLTE) — forced' };
        } else {
            _fntBgColor = null;
            if (window.logLine) window.logLine('[Font] BG-Override "Palette Index 0": kein indizierter PNG — Auswahl ignoriert, fallback Auto.', 'warn');
            _fntBgColor = _fntDetectBackground(_fntData, _fntPngBytes);
        }
    } else if (mode === 'magenta') {
        _fntBgColor = { r: 255, g: 0, b: 255, a: 255, source: 'Magic Magenta — forced' };
    } else if (mode === 'alpha') {
        _fntBgColor = { r: 0, g: 0, b: 0, a: 0, source: 'Transparent — forced' };
    } else if (mode === 'black') {
        _fntBgColor = { r: 0, g: 0, b: 0, a: 255, source: 'Black — forced' };
    } else if (mode === 'pick') {
        _fntPickArmed = true;
        if (cs) cs.style.cursor = 'crosshair';
        const statusEl = document.getElementById('fnt-status');
        if (statusEl) statusEl.textContent = 'Click on the font sheet to pick the background colour…';
        return;   // _fntBgColor unchanged until click
    }
    _fntUpdateBgStatus();
    _fntSchedulePreview();
}

// M1-T04b: Update the status line with the current BG source. Cheap helper to keep
// the message format consistent across PNG-load, mode-change and pick-click.
function _fntUpdateBgStatus() {
    const statusEl = document.getElementById('fnt-status');
    if (statusEl && _fntFilename) {
        const tag = _fntBgColor ? ` — BG: ${_fntBgColor.source}` : ' — BG: nicht erkannt';
        statusEl.textContent = `${_fntFilename.replace(/\.bfnt$/, '')} — ${_fntWidth} × ${_fntHeight} px${tag}`;
    }
    _fntUpdateBgProp();
}

// M1-T05: Sidebar property — small swatch + RGB hex + source label.
// Alpha-mode (bg.a === 0): swatch is the checkerboard transparency pattern (no rgb fill).
function _fntUpdateBgProp() {
    const propEl = document.getElementById('fnt-prop-bg');
    if (!propEl) return;
    if (!_fntBgColor) {
        propEl.textContent = '—';
        return;
    }
    const { r, g, b, a, source } = _fntBgColor;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('');
    const swatch = document.createElement('span');
    swatch.className = 'fnt-bg-swatch';
    if (a !== 0) swatch.style.backgroundColor = `rgb(${r},${g},${b})`;   // colour fill
    // a === 0 → leave checkerboard transparency pattern visible (CSS default)
    propEl.textContent = '';
    propEl.appendChild(swatch);
    propEl.appendChild(document.createTextNode(`${hex} (${source})`));
}

// ── Extract 1-bit glyphs from ImageData ────────────────────────────────────
// Each glyph: charH bytes, 1 byte per row, MSB = leftmost pixel.
// M1-T04: Pixel-Klassifikation gegen erkannte BG-Farbe statt fester Heuristik.
//   alpha-mode (bg.a === 0): pixel.a < 128 → off
//   colour-mode:             pixel == bg   → off
// In beiden Fällen: alles andere → on (Vordergrund-Farbe egal).

// M2-T02: bytesPerRow ableiten — 1 Byte für charW≤8, 2 Bytes für 9..16.
// Glyph-Layout: charCount × charH × bpr Bytes; pro Row erstes Byte = Pixel 0..7 MSB-first,
// letztes Byte padded mit 0 in den unteren Bits (Pixel ≥ charW sind off).
function _fntBpr(charW) { return (charW + 7) >> 3; }

function _fntExtractGlyphs(imageData, sheetW, sheetH, charW, charH, bgColor) {
    const d    = imageData.data;
    const cols = Math.floor(sheetW / charW);
    const rows = Math.floor(sheetH / charH);
    const charCount = cols * rows;
    const bpr       = _fntBpr(charW);
    const glyphs    = new Uint8Array(charCount * charH * bpr);
    const alphaMode = bgColor && bgColor.a === 0;

    for (let gi = 0; gi < charCount; gi++) {
        const cx = (gi % cols) * charW;
        const cy = Math.floor(gi / cols) * charH;

        for (let row = 0; row < charH; row++) {
            const rowBase = (gi * charH + row) * bpr;
            for (let b = 0; b < bpr; b++) {
                let byte = 0;
                const bitStart = b * 8;
                const bitEnd   = Math.min(bitStart + 8, charW);
                for (let bit = bitStart; bit < bitEnd; bit++) {
                    const px  = cx + bit;
                    const py  = cy + row;
                    const idx = (py * sheetW + px) * 4;
                    const a = d[idx + 3];
                    const r = d[idx];
                    const g = d[idx + 1];
                    const bl = d[idx + 2];
                    let isOn;
                    if (!bgColor) {
                        isOn = (a >= 128) && (r > 0 || g > 0 || bl > 0);
                    } else if (alphaMode) {
                        isOn = (a >= 128);
                    } else {
                        isOn = !(a >= 128 && r === bgColor.r && g === bgColor.g && bl === bgColor.b);
                    }
                    if (isOn) byte |= (0x80 >> (bit - bitStart));
                }
                glyphs[rowBase + b] = byte;
            }
        }
    }
    return { glyphs, charCount, cols, rows, bpr };
}

// ── Build lookup table ─────────────────────────────────────────────────────

// M1-T02: Build lookup from a user-defined charset string.
// String semantics: charsetString[i] = das Zeichen, dessen Glyph an Index i im Sheet liegt.
// → lookup[charCode(charsetString[i])] = i.
// Doppelte Zeichen im String: das ERSTE Vorkommen gewinnt (späteres Mapping wird ignoriert),
// damit Code-Konsumenten deterministisch den linken Glyph erhalten.
// Codes ≥ 128 erzwingen automatisch eine 256-Byte-Lookup-Tabelle (M1-T03 nutzt das gleiche
// Auto-Sizing für die Header-Flags).
function _fntBuildLookup(charsetString) {
    if (typeof charsetString !== 'string' || charsetString.length === 0) {
        charsetString = FNT_DEFAULT_CHARSET;
    }
    let needsFull = false;
    for (let i = 0; i < charsetString.length; i++) {
        if (charsetString.charCodeAt(i) >= 128) { needsFull = true; break; }
    }
    const size = needsFull ? 256 : 128;
    const lookup = new Uint8Array(size).fill(0xFF);
    for (let i = 0; i < charsetString.length && i < 256; i++) {
        const code = charsetString.charCodeAt(i);
        if (code >= size) continue;             // safety: should not happen given needsFull
        if (lookup[code] === 0xFF) lookup[code] = i;
    }
    return lookup;
}

// ── Render preview ─────────────────────────────────────────────────────────

function _fntRenderPreview() {
    if (!_fntData) return;

    const charWEl = document.getElementById('fnt-sel-charw');
    const charHEl = document.getElementById('fnt-sel-charh');
    let   charW   = parseInt(charWEl.value, 10);
    let   charH   = parseInt(charHEl.value, 10);
    if (!(charW >= 1 && charW <= 16)) charW = 8;
    if (!(charH >= 1 && charH <= 32)) charH = 8;
    _fntCharW = charW;
    _fntCharH = charH;

    // M2-T01: Sheet-Größe muss durch charW/charH teilbar sein. Pure UX-Hinweis;
    // _fntExtractGlyphs toleriert Reste durch Math.floor — User wird nur gewarnt.
    const statusEl = document.getElementById('fnt-status');
    const wMis = (_fntWidth  % charW) !== 0;
    const hMis = (_fntHeight % charH) !== 0;
    if (statusEl && (wMis || hMis)) {
        const parts = [];
        if (wMis) parts.push(`width ${_fntWidth} px nicht durch charW=${charW} teilbar`);
        if (hMis) parts.push(`height ${_fntHeight} px nicht durch charH=${charH} teilbar`);
        statusEl.textContent = `Sheet ${parts.join(', ')}`;
        statusEl.style.color = '#ff6b6b';
    } else if (statusEl) {
        statusEl.style.color = '';
    }

    const result  = _fntExtractGlyphs(_fntData, _fntWidth, _fntHeight, charW, charH, _fntBgColor);
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

    const bpr = _fntBpr(charW);
    for (let gi = 0; gi < Math.min(_fntCharCount, previewCols * previewRows); gi++) {
        const px = (gi % previewCols) * charW * scale;
        const py = Math.floor(gi / previewCols) * charH * scale;
        for (let row = 0; row < charH; row++) {
            const rowBase = (gi * charH + row) * bpr;
            for (let bit = 0; bit < charW; bit++) {
                const byte = _fntGlyphs[rowBase + (bit >> 3)];
                if ((byte >> (7 - (bit & 7))) & 1) {
                    ctxC.fillStyle = '#0f0';
                    ctxC.fillRect(px + bit * scale, py + row * scale, scale, scale);
                }
            }
        }
    }

    // ── Sidebar properties ──────────────────────────────────────────────
    // M1-T02: Lookup-Größe folgt dem aktuellen Charset-String (128 oder 256).
    const charsetStringEl = document.getElementById('fnt-charset-string');
    const previewLookup   = _fntBuildLookup(charsetStringEl ? charsetStringEl.value : '');
    const lookupSize      = previewLookup.length;
    const dataSize        = 16 + lookupSize + _fntCharCount * charH * bpr;

    document.getElementById('fnt-prop-file').textContent     = _fntFilename;
    document.getElementById('fnt-prop-sheet').textContent     = `${_fntWidth} \u00d7 ${_fntHeight} px`;
    document.getElementById('fnt-prop-charsize').textContent  = `${charW} \u00d7 ${charH} px`;
    document.getElementById('fnt-prop-chars').textContent     = String(_fntCharCount);
    document.getElementById('fnt-prop-chip').textContent      = `${(dataSize / 1024).toFixed(1)} KB`;
    document.getElementById('fnt-prop-pct').textContent       = `${(dataSize / (512 * 1024) * 100).toFixed(2)}%`;

    // M1-T09: Tracking + Space-Width-Anzeige (Werte sind bis M1-T10 nicht im File persistiert).
    const { tracking, spaceW } = _fntReadSpacing(charW);
    document.getElementById('fnt-prop-tracking').textContent = `${tracking} px`;
    document.getElementById('fnt-prop-spacew').textContent   = `${spaceW} px`;

    document.getElementById('fnt-btn-convert').disabled   = false;
    document.getElementById('fnt-btn-copy-code').disabled  = false;
}

// M1-T09: Read tracking + space-width from the toolbar inputs.
// Returns { tracking, spaceW } as integers. Empty input "Space W" means "use charW".
function _fntReadSpacing(charW) {
    const trackingEl = document.getElementById('fnt-sel-tracking');
    const spaceWEl   = document.getElementById('fnt-sel-spacew');
    const tracking   = trackingEl ? Math.max(0, parseInt(trackingEl.value, 10) || 0) : 1;
    const rawSpace   = spaceWEl ? spaceWEl.value.trim() : '';
    const spaceW     = rawSpace === '' ? charW : Math.max(0, parseInt(rawSpace, 10) || 0);
    return { tracking, spaceW };
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
        const rawBytes = new Uint8Array(bytes);
        const blob     = new Blob([rawBytes], { type: mime });
        const { imageData, width, height } = await _fntLoadBlob(blob);

        _fntData     = imageData;
        _fntWidth    = width;
        _fntHeight   = height;
        _fntFilename = name.replace(/\.[^.]+$/, '') + '.bfnt';
        // M1-T04: Roh-Bytes nur bei PNG f\u00fcr Palette-Erkennung; sonst null.
        _fntPngBytes = (ext === 'png') ? rawBytes : null;

        document.getElementById('fnt-placeholder').style.display = 'none';
        document.getElementById('fnt-workspace').style.display   = '';
        document.getElementById('fnt-content').classList.add('has-font');

        // M1-T04b: Mode-Select bei jedem neuen File auf "Auto" zur\u00fccksetzen \u2014 User muss
        // explizit picken/forcen, sonst l\u00e4uft die Detection-Cascade.
        const bgSelect = document.getElementById('fnt-sel-bg');
        if (bgSelect) bgSelect.value = 'auto';
        _fntApplyBgMode('auto');   // sets _fntBgColor + status + schedules render

        if (window.logLine) {
            const bgTag = _fntBgColor ? ` \u2014 BG: ${_fntBgColor.source}` : ' \u2014 BG: nicht erkannt';
            window.logLine(`[Font] Opened ${name} (${width}\u00d7${height})${bgTag}`, 'info');
        }
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

        // Validate magic "BFNT" + 16-byte header
        if (buf.length < 16 || buf[0] !== 0x42 || buf[1] !== 0x46 || buf[2] !== 0x4E || buf[3] !== 0x54) {
            throw new Error('Not a valid .bfnt file (bad magic)');
        }

        const charW     = (buf[4] << 8) | buf[5];
        const charH     = (buf[6] << 8) | buf[7];
        const charCount = (buf[8] << 8) | buf[9];
        const flags     = buf[10];
        const tracking  = buf[11];
        const spaceWPersist = (buf[12] << 8) | buf[13];
        const reserved  = (buf[14] << 8) | buf[15];

        // M1-T10 v1→v2 detection: alte 12-Byte-Header-Files starten direkt mit dem
        // Lookup ab Offset 12 → buf[12..15] sind Lookup-Bytes (typisch $FF für Codes 0..3).
        // Neuer Header: reserved (buf[14..15]) muss 0 sein, spaceW ≤ 64.
        if (reserved !== 0 || spaceWPersist > 4096) {
            throw new Error('Veraltetes .bfnt-Format (12-Byte-Header). Bitte das PNG erneut über "Open as Font" laden und neu speichern, oder die .bfnt-Datei verwerfen.');
        }

        const lookupSize    = (flags & 1) ? 256 : 128;
        const bpr           = _fntBpr(charW);
        const glyphDataSize = charCount * charH * bpr;

        if (buf.length < 16 + lookupSize + glyphDataSize) {
            throw new Error(`File too short: expected ${16 + lookupSize + glyphDataSize} bytes, got ${buf.length}`);
        }

        _fntCharW     = charW;
        _fntCharH     = charH;
        _fntCharCount = charCount;
        _fntGlyphs    = buf.slice(16 + lookupSize, 16 + lookupSize + glyphDataSize);
        _fntFilename  = name;
        _fntData      = null;   // no source image
        _fntWidth     = 0;
        _fntHeight    = 0;
        _fntPngBytes  = null;   // no source PNG → no palette detection
        _fntBgColor   = null;   // not applicable when loading already-converted .bfnt
        _fntPickArmed = false;
        const bgSelectEl = document.getElementById('fnt-sel-bg');
        if (bgSelectEl) bgSelectEl.value = 'auto';
        _fntUpdateBgProp();   // BFNT has no source image → show "—"

        // M1-T10: Restore tracking + space-width from header into the toolbar inputs.
        const trackingEl = document.getElementById('fnt-sel-tracking');
        const spaceWEl   = document.getElementById('fnt-sel-spacew');
        if (trackingEl) trackingEl.value = String(tracking);
        if (spaceWEl)   spaceWEl.value   = spaceWPersist === 0 ? '' : String(spaceWPersist);

        // M2-T01: charW/charH sind Number-Inputs — Wert direkt setzen.
        const charWEl   = document.getElementById('fnt-sel-charw');
        const charHEl   = document.getElementById('fnt-sel-charh');
        if (charWEl) charWEl.value = String(charW);
        if (charHEl) charHEl.value = String(charH);
        // M1-T01: Charset-Input bleibt beim aktuellen Wert. Reverse-Engineering der
        // Reihenfolge aus dem Lookup folgt in M1-T02 (oder: bewusst leerer Default,
        // weil .bfnt v1 die Reihenfolge nicht speichert).

        document.getElementById('fnt-placeholder').style.display = 'none';
        document.getElementById('fnt-workspace').style.display   = '';
        document.getElementById('fnt-content').classList.add('has-font');

        _fntRenderBfntPreview();

        // Properties
        const dataSize = 16 + lookupSize + glyphDataSize;
        document.getElementById('fnt-prop-file').textContent     = name;
        document.getElementById('fnt-prop-sheet').textContent     = '(binary)';
        document.getElementById('fnt-prop-charsize').textContent  = `${charW} \u00d7 ${charH} px`;
        document.getElementById('fnt-prop-chars').textContent     = String(charCount);
        document.getElementById('fnt-prop-chip').textContent      = `${(dataSize / 1024).toFixed(1)} KB`;
        document.getElementById('fnt-prop-pct').textContent       = `${(dataSize / (512 * 1024) * 100).toFixed(2)}%`;

        // M1-T09: Tracking + Space-Width-Anzeige aus aktuellen Toolbar-Werten.
        // Bis M1-T10 kein Header-Persistenz, Werte bleiben aus der UI-Session.
        const { tracking: trk, spaceW: sw } = _fntReadSpacing(charW);
        document.getElementById('fnt-prop-tracking').textContent = `${trk} px`;
        document.getElementById('fnt-prop-spacew').textContent   = `${sw} px`;

        // Re-Save erlaubt: User kann den Charset-String anpassen und das .bfnt
        // mit neuer Lookup-Reihenfolge zur\u00fcckschreiben (Glyph-Daten bleiben unver\u00e4ndert).
        document.getElementById('fnt-btn-convert').disabled   = false;
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
    const bpr   = _fntBpr(charW);
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
            const rowBase = (gi * charH + row) * bpr;
            for (let bit = 0; bit < charW; bit++) {
                const byte = _fntGlyphs[rowBase + (bit >> 3)];
                if ((byte >> (7 - (bit & 7))) & 1) {
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
            const rowBase = (gi * charH + row) * bpr;
            for (let bit = 0; bit < charW; bit++) {
                const byte = _fntGlyphs[rowBase + (bit >> 3)];
                if ((byte >> (7 - (bit & 7))) & 1) {
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
    // Glyphen sind die einzige zwingende Voraussetzung — sie können entweder aus dem
    // PNG-Pfad (_fntData != null) oder aus dem .bfnt-Re-Save-Pfad (_fntData == null,
    // _fntGlyphs aus dem geladenen Binary) stammen. Beide Pfade dürfen Re-Save.
    if (!_fntGlyphs) return;
    const btn = document.getElementById('fnt-btn-convert');
    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
        // M1-T02: Charset-String steuert die Lookup-Reihenfolge. Glyph 0 = erstes Zeichen
        // im String, …, Glyph N-1 = N-tes Zeichen. Reicht der String über die im Sheet
        // vorhandenen Glyphen hinaus, mappen die überschüssigen Codes auf $FF (= nicht im
        // Font). Fehlt ein gewünschtes Zeichen im Sheet, sieht der User das im Convert-Log.
        const charsetString = document.getElementById('fnt-charset-string').value || FNT_DEFAULT_CHARSET;
        const lookup        = _fntBuildLookup(charsetString);
        const lookupSize    = lookup.length;
        const flags         = lookupSize === 256 ? 1 : 0;

        // String länger als verfügbare Glyphen: alle Codes ab _fntCharCount auf $FF zurücksetzen.
        if (charsetString.length > _fntCharCount) {
            for (let i = _fntCharCount; i < charsetString.length; i++) {
                const code = charsetString.charCodeAt(i);
                if (code < lookupSize && lookup[code] === i) lookup[code] = 0xFF;
            }
            if (window.logLine) {
                window.logLine(`[Font] Charset-String hat ${charsetString.length} Zeichen, Sheet liefert nur ${_fntCharCount} Glyphen — überschüssige Zeichen sind nicht abgedeckt.`, 'warn');
            }
        }

        // M1-T10: Tracking + Space-Width werden im 16-Byte-Header persistiert.
        // SpaceW=0 im File bedeutet "use charW" (vom Compiler beim Laden gemappt).
        const { tracking: rawTracking, spaceW: rawSpaceW } = _fntReadSpacing(_fntCharW);
        const tracking      = Math.max(0, Math.min(255, rawTracking));
        // Wenn der User-Input leer war, hat _fntReadSpacing bereits charW eingesetzt.
        // Persistiert wird "0 = use charW", damit ein späterer charW-Wechsel automatisch
        // mitzieht. Heuristik: wenn der Input leer ist, schreibe 0; sonst den Roh-Wert.
        const spaceWInputEl = document.getElementById('fnt-sel-spacew');
        const spaceWInputRaw = spaceWInputEl ? spaceWInputEl.value.trim() : '';
        const spaceWPersist = spaceWInputRaw === '' ? 0 : Math.max(0, Math.min(65535, rawSpaceW));

        const headerSize    = 16;
        const bpr           = _fntBpr(_fntCharW);
        const glyphDataSize = _fntCharCount * _fntCharH * bpr;
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
        // flags + tracking
        out[10] = flags;
        out[11] = tracking;
        // spaceWidth (BE word) — 0 means "use charW"
        out[12] = (spaceWPersist >> 8) & 0xFF; out[13] = spaceWPersist & 0xFF;
        // reserved (BE word) — must be 0 (used for v1-vs-v2 detection on read)
        out[14] = 0; out[15] = 0;

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
    // M1-T07: Funktioniert auch im BFNT-Re-Open-Pfad, wo _fntData null ist.
    if (!_fntFilename) return;
    // Project-relativen Pfad rekonstruieren (sonst kompiliert LoadFont nicht für
    // Assets, die in Sub-Verzeichnissen liegen wie examples/breakout/images/font.bfnt).
    const relPath = _fntSourceDir ? `${_fntSourceDir}/${_fntFilename}` : _fntFilename;
    const code = `LoadFont 0, "${relPath}"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('fnt-btn-copy-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// M1-T09: Light-Updater für Tracking/SpaceW — refresht nur die zwei Sidebar-Felder.
// Funktioniert auch wenn _fntData null ist (BFNT-Open-Pfad), wo _fntRenderPreview Early-Exit macht.
function _fntUpdateSpacingProps() {
    if (!_fntCharCount) return;
    const { tracking, spaceW } = _fntReadSpacing(_fntCharW);
    const trkEl = document.getElementById('fnt-prop-tracking');
    const swEl  = document.getElementById('fnt-prop-spacew');
    if (trkEl) trkEl.textContent = `${tracking} px`;
    if (swEl)  swEl.textContent  = `${spaceW} px`;
}

// ── Event wiring ───────────────────────────────────────────────────────────

document.getElementById('fnt-sel-charw').addEventListener('input', _fntSchedulePreview);
document.getElementById('fnt-sel-charh').addEventListener('input', _fntSchedulePreview);
document.getElementById('fnt-charset-string').addEventListener('input', _fntSchedulePreview);
document.getElementById('fnt-sel-tracking').addEventListener('input', _fntUpdateSpacingProps);
document.getElementById('fnt-sel-spacew').addEventListener('input', _fntUpdateSpacingProps);
document.getElementById('fnt-btn-convert').addEventListener('click', _fntConvertAndSave);
document.getElementById('fnt-btn-copy-code').addEventListener('click', _fntCopyCode);

// M1-T04b: BG-Mode-Override + Click-Picker.
document.getElementById('fnt-sel-bg').addEventListener('change', (e) => _fntApplyBgMode(e.target.value));
document.getElementById('fnt-canvas-sheet').addEventListener('click', (e) => {
    if (!_fntPickArmed || !_fntData) return;
    const cs = e.currentTarget;
    const rect = cs.getBoundingClientRect();
    // Map CSS-pixel click to native canvas pixel (ImageData index space).
    const x = Math.floor((e.clientX - rect.left) * cs.width  / rect.width);
    const y = Math.floor((e.clientY - rect.top)  * cs.height / rect.height);
    if (x < 0 || y < 0 || x >= _fntWidth || y >= _fntHeight) return;
    const idx = (y * _fntWidth + x) * 4;
    const d = _fntData.data;
    const r = d[idx], g = d[idx + 1], b = d[idx + 2], a = d[idx + 3];
    _fntBgColor = { r, g, b, a, source: `Picked (${r},${g},${b}${a < 255 ? ',a' + a : ''})` };
    _fntPickArmed = false;
    cs.style.cursor = '';
    _fntUpdateBgStatus();
    _fntSchedulePreview();
});
