'use strict';

// ── Binary writer (Big Endian, chunked to avoid stack overflow) ───────────────

class _BinaryWriter {
    constructor() { this._chunks = []; this._buf = []; }

    _flush() {
        if (this._buf.length > 0) {
            this._chunks.push(new Uint8Array(this._buf));
            this._buf = [];
        }
    }

    byte(v)  {
        this._buf.push(v & 0xFF);
        if (this._buf.length >= 16384) this._flush();
    }
    u16(v)   {
        this._buf.push((v >> 8) & 0xFF, v & 0xFF);
        if (this._buf.length >= 16384) this._flush();
    }
    u32(v)   {
        this._buf.push((v>>24)&0xFF, (v>>16)&0xFF, (v>>8)&0xFF, v&0xFF);
        if (this._buf.length >= 16384) this._flush();
    }
    str(s)   {
        for (let i = 0; i < s.length; i++) this._buf.push(s.charCodeAt(i));
        if (this._buf.length >= 16384) this._flush();
    }
    bytes(b) {
        this._flush();
        this._chunks.push(b instanceof Uint8Array ? b : new Uint8Array(b));
    }

    size() {
        return this._chunks.reduce((a, c) => a + c.length, 0) + this._buf.length;
    }
    get() {
        this._flush();
        const total = this._chunks.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of this._chunks) { out.set(c, off); off += c.length; }
        return out;
    }
}

// ── Amiga ByteRun1 RLE compression (per scanline row) ────────────────────────
// Encoding: byte n ∈ [0,127]  → copy next (n+1) literals
//           byte n ∈ [129,255] → replicate next byte (257-n) times
//           byte 128            → no-op (not emitted here)

function _compressRow(row) {
    const result = [];
    let i = 0;
    while (i < row.length) {
        // Scan for start of a run of ≥3 identical bytes
        let litLen = 0;
        while (i + litLen < row.length && litLen < 128) {
            if (i + litLen < row.length - 2 &&
                row[i + litLen] === row[i + litLen + 1] &&
                row[i + litLen] === row[i + litLen + 2]) break;
            litLen++;
        }
        if (litLen > 0) {
            result.push(litLen - 1);
            for (let k = 0; k < litLen; k++) result.push(row[i + k]);
            i += litLen;
            continue;
        }
        // Measure run length
        let repLen = 1;
        while (i + repLen < row.length && row[i + repLen] === row[i] && repLen < 128) repLen++;
        if (repLen >= 2) {
            // Signed −(repLen−1) stored as unsigned: 256 − (repLen−1)
            result.push(256 - (repLen - 1));
            result.push(row[i]);
            i += repLen;
        } else {
            result.push(0);
            result.push(row[i]);
            i++;
        }
    }
    return new Uint8Array(result);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an Amiga IFF/ILBM file (OCS indexed mode, ByteRun1 compressed).
 *
 * @param {number}     width
 * @param {number}     height
 * @param {number[]}   paletteOCS   OCS word array (0x000–0xFFF), length = colorCount
 * @param {Uint8Array} indexedData  palette index per pixel, row-major
 * @param {number}     depth        bitplanes (1–5)
 * @returns {Uint8Array}
 */
function createIFF(width, height, paletteOCS, indexedData, depth) {
    const colorCount = 1 << depth;
    const rowBytes   = Math.ceil(width / 16) * 2;

    const w = new _BinaryWriter();
    w.str('FORM'); w.u32(0); w.str('ILBM');

    // ── BMHD ─────────────────────────────────────────────────────────────────
    w.str('BMHD'); w.u32(20);
    w.u16(width); w.u16(height);
    w.u16(0); w.u16(0);           // x, y origin
    w.byte(depth);                // nPlanes
    w.byte(0);                    // masking: none
    w.byte(1);                    // compression: ByteRun1
    w.byte(0);                    // pad1
    w.u16(0);                     // transparentColor
    w.byte(10); w.byte(11);       // xAspect, yAspect
    w.u16(width); w.u16(height);  // pageWidth, pageHeight

    // ── CMAP ─────────────────────────────────────────────────────────────────
    const cmapLen = colorCount * 3;
    w.str('CMAP'); w.u32(cmapLen);
    for (let i = 0; i < colorCount; i++) {
        const ocs = paletteOCS[i] || 0;
        w.byte(((ocs >> 8) & 0xF) * 17);  // R: 4-bit → 8-bit
        w.byte(((ocs >> 4) & 0xF) * 17);  // G
        w.byte(( ocs       & 0xF) * 17);  // B
    }
    if (cmapLen & 1) w.byte(0);   // pad to even boundary

    // ── BODY ─────────────────────────────────────────────────────────────────
    w.str('BODY');
    const bodyW    = new _BinaryWriter();
    const planeRow = Array.from({ length: depth }, () => new Uint8Array(rowBytes));

    for (let y = 0; y < height; y++) {
        for (let p = 0; p < depth; p++) planeRow[p].fill(0);
        for (let x = 0; x < width; x++) {
            const ci  = indexedData[y * width + x];
            const pos = x >> 3;
            const bit = 1 << (7 - (x & 7));
            for (let p = 0; p < depth; p++) {
                if ((ci >> p) & 1) planeRow[p][pos] |= bit;
            }
        }
        for (let p = 0; p < depth; p++) bodyW.bytes(_compressRow(planeRow[p]));
    }

    w.u32(bodyW.size());
    w.bytes(bodyW.get());

    // Patch FORM size field
    const final = w.get();
    const sz    = final.length - 8;
    final[4] = (sz >> 24) & 0xFF;
    final[5] = (sz >> 16) & 0xFF;
    final[6] = (sz >>  8) & 0xFF;
    final[7] =  sz        & 0xFF;
    return final;
}
