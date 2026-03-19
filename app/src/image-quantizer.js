'use strict';

// ── LAB color space ───────────────────────────────────────────────────────────

function _rgbToLab(r, g, b) {
    let r_ = r / 255, g_ = g / 255, b_ = b / 255;
    r_ = r_ > 0.04045 ? Math.pow((r_ + 0.055) / 1.055, 2.4) : r_ / 12.92;
    g_ = g_ > 0.04045 ? Math.pow((g_ + 0.055) / 1.055, 2.4) : g_ / 12.92;
    b_ = b_ > 0.04045 ? Math.pow((b_ + 0.055) / 1.055, 2.4) : b_ / 12.92;
    let x = (r_ * 0.4124 + g_ * 0.3576 + b_ * 0.1805) / 0.95047;
    let y = (r_ * 0.2126 + g_ * 0.7152 + b_ * 0.0722) / 1.00000;
    let z = (r_ * 0.0193 + g_ * 0.1192 + b_ * 0.9505) / 1.08883;
    x = x > 0.008856 ? Math.pow(x, 1 / 3) : 7.787 * x + 16 / 116;
    y = y > 0.008856 ? Math.pow(y, 1 / 3) : 7.787 * y + 16 / 116;
    z = z > 0.008856 ? Math.pow(z, 1 / 3) : 7.787 * z + 16 / 116;
    return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

function _labToRgb(l, a, b) {
    let y = (l + 16) / 116, x = a / 500 + y, z = y - b / 200;
    const x3 = x*x*x, y3 = y*y*y, z3 = z*z*z;
    x  = x3  > 0.008856 ? x3  : (x  - 16/116) / 7.787;
    y  = y3  > 0.008856 ? y3  : (y  - 16/116) / 7.787;
    z  = z3  > 0.008856 ? z3  : (z  - 16/116) / 7.787;
    x *= 0.95047; y *= 1.00000; z *= 1.08883;
    let r  = x * 3.2406  + y * -1.5372 + z * -0.4986;
    let g  = x * -0.9689 + y *  1.8758 + z *  0.0415;
    let bl = x * 0.0557  + y * -0.2040 + z *  1.0570;
    r  = r  > 0.0031308 ? 1.055 * Math.pow(r,  1/2.4) - 0.055 : 12.92 * r;
    g  = g  > 0.0031308 ? 1.055 * Math.pow(g,  1/2.4) - 0.055 : 12.92 * g;
    bl = bl > 0.0031308 ? 1.055 * Math.pow(bl, 1/2.4) - 0.055 : 12.92 * bl;
    return {
        r:  Math.max(0, Math.min(255, Math.round(r  * 255))),
        g:  Math.max(0, Math.min(255, Math.round(g  * 255))),
        b:  Math.max(0, Math.min(255, Math.round(bl * 255))),
    };
}

// ── CIEDE2000 color difference ────────────────────────────────────────────────

function _deltaE2000(lab1, lab2) {
    const D2R = Math.PI / 180;
    const { l: L1, a: A1, b: B1 } = lab1;
    const { l: L2, a: A2, b: B2 } = lab2;

    const C1 = Math.sqrt(A1*A1 + B1*B1), C2 = Math.sqrt(A2*A2 + B2*B2);
    const Cb = (C1 + C2) / 2;
    const G  = 0.5 * (1 - Math.sqrt(Math.pow(Cb,7) / (Math.pow(Cb,7) + Math.pow(25,7))));

    const a1p = (1+G)*A1, a2p = (1+G)*A2;
    const C1p = Math.sqrt(a1p*a1p + B1*B1), C2p = Math.sqrt(a2p*a2p + B2*B2);

    const toHue = (a, b_) => {
        const h = Math.atan2(b_, a) * (180 / Math.PI);
        return h >= 0 ? h : h + 360;
    };
    const h1d = (a1p === 0 && B1 === 0) ? 0 : toHue(a1p, B1);
    const h2d = (a2p === 0 && B2 === 0) ? 0 : toHue(a2p, B2);

    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
        const diff = h2d - h1d;
        dhp = Math.abs(diff) <= 180 ? diff : (diff > 180 ? diff - 360 : diff + 360);
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * D2R / 2);

    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = 0;
    if (C1p * C2p !== 0) {
        const diff = Math.abs(h1d - h2d);
        hbp = diff <= 180 ? (h1d+h2d)/2 : (h1d+h2d < 360 ? (h1d+h2d+360)/2 : (h1d+h2d-360)/2);
    }

    const T  = 1 - 0.17*Math.cos((hbp-30)*D2R)  + 0.24*Math.cos(2*hbp*D2R)
                 + 0.32*Math.cos((3*hbp+6)*D2R)  - 0.20*Math.cos((4*hbp-63)*D2R);
    const dt = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cbp,7) / (Math.pow(Cbp,7) + Math.pow(25,7)));
    const SL = 1 + 0.015 * Math.pow(Lbp-50,2) / Math.sqrt(20 + Math.pow(Lbp-50,2));
    const SC = 1 + 0.045 * Cbp;
    const SH = 1 + 0.015 * Cbp * T;
    const RT = -Math.sin(2 * dt * D2R) * Rc;

    return Math.sqrt(
        Math.pow(dLp/SL, 2) + Math.pow(dCp/SC, 2) + Math.pow(dHp/SH, 2) +
        RT * (dCp/SC) * (dHp/SH)
    );
}

// ── Redmean perceptual distance ───────────────────────────────────────────────
// More accurate than straight Euclidean for human colour perception.

function _colorDistSq(r1, g1, b1, r2, g2, b2) {
    const rm = (r1 + r2) / 2;
    const dr = r1-r2, dg = g1-g2, db = b1-b2;
    return (((512+rm)*dr*dr) >> 8) + 4*dg*dg + (((767-rm)*db*db) >> 8);
}

// ── OCS snap: round each 8-bit channel to nearest 4-bit value (×17) ──────────

function _snap4(v) { return Math.round(v / 17) * 17; }

// ── Median Cut VBox ───────────────────────────────────────────────────────────

function _createVBox(pixels) {
    let minR=255, maxR=0, minG=255, maxG=0, minB=255, maxB=0;
    for (const p of pixels) {
        if (p[0] < minR) minR=p[0]; if (p[0] > maxR) maxR=p[0];
        if (p[1] < minG) minG=p[1]; if (p[1] > maxG) maxG=p[1];
        if (p[2] < minB) minB=p[2]; if (p[2] > maxB) maxB=p[2];
    }
    const rR=maxR-minR, rG=maxG-minG, rB=maxB-minB;
    const maxRange = Math.max(rR, rG, rB);
    return { pixels, maxRange, axis: maxRange===rR ? 0 : maxRange===rG ? 1 : 2 };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an OCS palette using Priority Median Cut + CIEDE2000 perceptual merge.
 *
 * Returns an array of `colorCount` OCS words (0x000–0xFFF).
 * Slot 0 is always $000 (transparent / background).
 *
 * @param {ImageData} imageData
 * @param {number}    colorCount  palette size including slot 0 (max 32)
 * @param {number}    threshold   0–100: merge aggressiveness (default 50)
 */
function medianCutPalette(imageData, colorCount, threshold = 50) {
    const d = imageData.data;
    const pixels = [];
    for (let i = 0; i < d.length; i += 4) {
        if (d[i+3] < 128) continue;
        pixels.push([_snap4(d[i]), _snap4(d[i+1]), _snap4(d[i+2])]);
    }
    if (pixels.length === 0) return new Array(colorCount).fill(0);

    // Reserve slot 0 for black
    const effectiveCount = Math.max(1, colorCount - 1);
    const oversample     = 1.0 + threshold / 25;
    const targetCuts     = Math.min(256, Math.max(effectiveCount + 5,
                               Math.floor(effectiveCount * oversample)));

    const boxes = [_createVBox(pixels)];
    let iter = 0;
    while (boxes.length < targetCuts && iter++ < 10000) {
        let si = -1, best = -1;
        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].pixels.length <= 1) continue;
            if (boxes[i].maxRange > best) { best = boxes[i].maxRange; si = i; }
        }
        if (si === -1) break;
        const box = boxes[si];
        const ax  = box.axis;
        box.pixels.sort((a, b_) => a[ax] - b_[ax]);
        const mid = Math.floor(box.pixels.length / 2);
        boxes.splice(si, 1,
            _createVBox(box.pixels.slice(0, mid)),
            _createVBox(box.pixels.slice(mid)));
    }

    // Average each box → snapped OCS candidate
    let candidates = boxes.map(box => {
        let r = 0, g = 0, b = 0;
        for (const p of box.pixels) { r += p[0]; g += p[1]; b += p[2]; }
        r = _snap4(r / box.pixels.length);
        g = _snap4(g / box.pixels.length);
        b = _snap4(b / box.pixels.length);
        return { r, g, b, count: box.pixels.length, lab: _rgbToLab(r, g, b) };
    });

    // CIEDE2000 merge-down to effectiveCount
    while (candidates.length > effectiveCount) {
        let minD = Infinity, p1 = -1, p2 = -1;
        for (let i = 0; i < candidates.length; i++) {
            for (let j = i + 1; j < candidates.length; j++) {
                const dist = _deltaE2000(candidates[i].lab, candidates[j].lab);
                if (dist < minD) { minD = dist; p1 = i; p2 = j; }
            }
        }
        if (p1 === -1) break;
        const c1 = candidates[p1], c2 = candidates[p2];
        const tot = c1.count + c2.count;
        const nL  = (c1.lab.l*c1.count + c2.lab.l*c2.count) / tot;
        const nA  = (c1.lab.a*c1.count + c2.lab.a*c2.count) / tot;
        const nB  = (c1.lab.b*c1.count + c2.lab.b*c2.count) / tot;
        const rgb = _labToRgb(nL, nA, nB);
        c1.r = _snap4(rgb.r); c1.g = _snap4(rgb.g); c1.b = _snap4(rgb.b);
        c1.lab = _rgbToLab(c1.r, c1.g, c1.b);
        c1.count = tot;
        candidates.splice(p2, 1);
    }

    // Build OCS word array — slot 0 always $000
    const result = new Array(colorCount).fill(0);
    for (let i = 0; i < candidates.length && i < colorCount - 1; i++) {
        const { r, g, b } = candidates[i];
        result[i + 1] = ((Math.round(r / 17) & 0xF) << 8)
                      | ((Math.round(g / 17) & 0xF) << 4)
                      |  (Math.round(b / 17) & 0xF);
    }
    return result;
}

/**
 * Map pixels to palette indices using the selected dithering mode.
 * Uses Redmean distance for perceptually accurate colour matching.
 *
 * @param {ImageData} imageData
 * @param {number[]}  palette   OCS word array (0x000–0xFFF)
 * @param {number}    count     palette entries to use
 * @param {string}    mode      'none' | 'floyd-steinberg' | 'atkinson' | 'bayer'
 * @returns {Uint8Array}        palette index per pixel, row-major
 */
function quantizeWithDither(imageData, palette, count, mode) {
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const indices = new Uint8Array(w * h);

    // Expand palette from OCS words to R8/G8/B8 for Redmean distance
    const pr = new Uint8Array(count);
    const pg = new Uint8Array(count);
    const pb = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        pr[i] = ((palette[i] >> 8) & 0xF) * 17;
        pg[i] = ((palette[i] >> 4) & 0xF) * 17;
        pb[i] = ( palette[i]       & 0xF) * 17;
    }

    function nearest(r, g, b) {
        let best = 0, bestD = Infinity;
        for (let p = 0; p < count; p++) {
            if (pr[p]===r && pg[p]===g && pb[p]===b) return p;
            const d = _colorDistSq(r, g, b, pr[p], pg[p], pb[p]);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    // ── Bayer ordered dithering ───────────────────────────────────────────────
    if (mode === 'bayer') {
        const bayer = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y*w+x)*4;
                if (src[i+3] < 128) { indices[y*w+x] = 0; continue; }
                const thr = (bayer[y%4][x%4] - 8) * 4;
                indices[y*w+x] = nearest(
                    Math.max(0, Math.min(255, src[i]   + thr)),
                    Math.max(0, Math.min(255, src[i+1] + thr)),
                    Math.max(0, Math.min(255, src[i+2] + thr))
                );
            }
        }
        return indices;
    }

    // ── No dithering ─────────────────────────────────────────────────────────
    if (mode === 'none') {
        for (let i = 0; i < w*h; i++) {
            if (src[i*4+3] < 128) { indices[i] = 0; continue; }
            indices[i] = nearest(src[i*4], src[i*4+1], src[i*4+2]);
        }
        return indices;
    }

    // ── Error diffusion: Floyd-Steinberg or Atkinson ──────────────────────────
    const err = new Float32Array(src);  // working copy of pixel values

    const push = (ex, ey, er, eg, eb, f, div) => {
        if (ex < 0 || ex >= w || ey >= h) return;
        const j = (ey*w+ex)*4;
        err[j]   += er * f / div;
        err[j+1] += eg * f / div;
        err[j+2] += eb * f / div;
    };

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y*w+x)*4;
            if (src[i+3] < 128) { indices[y*w+x] = 0; continue; }
            const r = Math.max(0, Math.min(255, err[i]));
            const g = Math.max(0, Math.min(255, err[i+1]));
            const b = Math.max(0, Math.min(255, err[i+2]));
            const ni = nearest(r, g, b);
            indices[y*w+x] = ni;
            const er = r - pr[ni], eg = g - pg[ni], eb = b - pb[ni];
            if (mode === 'floyd-steinberg') {
                push(x+1, y,   er, eg, eb, 7, 16);
                push(x-1, y+1, er, eg, eb, 3, 16);
                push(x,   y+1, er, eg, eb, 5, 16);
                push(x+1, y+1, er, eg, eb, 1, 16);
            } else {  // atkinson
                push(x+1, y,   er, eg, eb, 1, 8);
                push(x+2, y,   er, eg, eb, 1, 8);
                push(x-1, y+1, er, eg, eb, 1, 8);
                push(x,   y+1, er, eg, eb, 1, 8);
                push(x+1, y+1, er, eg, eb, 1, 8);
                push(x,   y+2, er, eg, eb, 1, 8);
            }
        }
    }
    return indices;
}
