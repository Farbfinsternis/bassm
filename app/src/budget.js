// ── BASSM Budget Analyser ──────────────────────────────────────────────────────
//
// Statische Analyse des BASSM-Quellcodes:
//   - Cycle-Verbrauch pro Frame (Blitter + CPU, geschätzt)
//   - Chip-RAM-Verbrauch (Screen-Buffer + Assets)
//
// Ergebnisse sind Näherungswerte (±30 %). Nützlich für relative Einschätzung
// und frühzeitige Erkennung von Overbudget-Situationen.
//
// Amiga OCS Rahmenbedingungen:
//   CPU:          7.09 MHz 68000
//   Frame budget: 141,800 Cycles @ 50 Hz PAL
//   Blitter:      ~1.8 MB/s effektiv (shared chip bus)
//   Chip RAM:     512 KB (A500 standard)

const CPU_HZ        = 7_090_000;
const FRAME_HZ      = 50;
export const CYCLES_FRAME  = Math.floor(CPU_HZ / FRAME_HZ);  // 141,800
export const CHIP_RAM_BYTES = 512 * 1024;                     // 524,288 bytes

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * @param {string} source  Raw BASSM source text
 * @returns {{ cyclesUsed, cyclesTotal, chipRamUsed, chipRamTotal, chipRamPlus }|null}
 *   null when no Graphics command is found.
 */
export function analyzeBudget(source) {
    const gfxM = /^\s*Graphics\s+(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/im.exec(source);
    if (!gfxM) return null;

    const gfxW   = parseInt(gfxM[1]);
    const gfxH   = parseInt(gfxM[2]);
    const planes = parseInt(gfxM[3]);

    // ── Chip RAM ──────────────────────────────────────────────────────────────

    // Double-buffered screen (2 × planes × bytes/plane)
    const bytesPerPlane = Math.ceil(gfxW / 16) * 2 * gfxH;
    let chipRam     = 2 * planes * bytesPerPlane;
    let chipRamPlus = false;  // true = unknown-size assets present

    // LoadImage assets (planar DATA_C in chip RAM)
    const imageMap = {};
    const imgRE = /^\s*LoadImage\s+(\d+)\s*,\s*"[^"]*"\s*,\s*(\d+)\s*,\s*(\d+)/img;
    let m;
    while ((m = imgRE.exec(source)) !== null) {
        const idx = parseInt(m[1]), w = parseInt(m[2]), h = parseInt(m[3]);
        imageMap[idx] = { w, h };
        chipRam += Math.ceil(w / 8) * h * planes;
    }

    // LoadSample — file size unknown at parse time
    if (/^\s*LoadSample\b/im.test(source)) chipRamPlus = true;

    // LoadFont — data goes into normal (fast) RAM, not chip RAM; no chip RAM cost.
    // Collect charH per font index for accurate Text cycle estimation.
    const fontMap = {};  // idx → charH
    const fontRE = /^\s*LoadFont\s+(\d+)\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*(\d+)\s*,\s*(\d+)/img;
    while ((m = fontRE.exec(source)) !== null) {
        fontMap[parseInt(m[1])] = { charW: parseInt(m[2]), charH: parseInt(m[3]) };
    }

    // ── Cycles (main loop) ────────────────────────────────────────────────────

    const lines      = source.split('\n');
    const loopLines  = _extractMainLoop(lines);
    const cyclesUsed = loopLines.length > 0
        ? _estimateCycles(loopLines, imageMap, fontMap, gfxW, gfxH, planes)
        : 0;

    return {
        cyclesUsed,
        cyclesTotal:  CYCLES_FRAME,
        chipRamUsed:  chipRam,
        chipRamTotal: CHIP_RAM_BYTES,
        chipRamPlus,
    };
}

// ── Loop extraction ───────────────────────────────────────────────────────────

function _extractMainLoop(lines) {
    // Find the outermost While/Repeat that contains ScreenFlip — that is the main
    // game loop. Inner loops (e.g. For…Next used for init) are skipped.
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*(while|repeat)\b/i.test(lines[i])) continue;

        let depth = 1, j = i + 1;
        const body = [];
        while (j < lines.length && depth > 0) {
            const t = lines[j].trim();
            if (/^(while|repeat)\b/i.test(t)) depth++;
            if (/^(wend|until)\b/i.test(t))   depth--;
            if (depth > 0) body.push(lines[j]);
            j++;
        }
        if (body.some(l => /^\s*ScreenFlip\b/i.test(l))) return body;
    }
    return [];
}

// ── Cycle estimation ──────────────────────────────────────────────────────────

function _estimateCycles(lines, imageMap, fontMap, gfxW, gfxH, planes) {
    let total = 0;
    let i = 0;
    let activeFontCharH = 8;  // built-in font default

    while (i < lines.length) {
        const line = lines[i];
        const trim = line.trim();

        // Track UseFont to update active charH for Text cost
        const useFontM = /^UseFont\s+(\d+)/i.exec(trim);
        if (useFontM) {
            const idx = parseInt(useFontM[1]);
            if (fontMap[idx]) activeFontCharH = fontMap[idx].charH;
        } else if (/^UseFont\s*$/i.test(trim)) {
            activeFontCharH = 8;  // reset to built-in
        }

        // For loop with literal bounds — multiply inner cost by iteration count
        const forM = /^For\s+\w+\s*=\s*(-?\d+)\s+To\s+(-?\d+)(?:\s+Step\s+(-?\d+))?/i.exec(trim);
        if (forM) {
            const from  = parseInt(forM[1]);
            const to    = parseInt(forM[2]);
            const step  = forM[3] ? Math.abs(parseInt(forM[3])) : 1;
            const count = Math.max(0, Math.floor((to - from) / step) + 1);

            let depth = 1, j = i + 1;
            const forBody = [];
            while (j < lines.length && depth > 0) {
                if (/^\s*For\b/i.test(lines[j]))  depth++;
                if (/^\s*Next\b/i.test(lines[j])) { depth--; if (depth === 0) { j++; break; } }
                if (depth > 0) forBody.push(lines[j]);
                j++;
            }
            total += count * _estimateCycles(forBody, imageMap, fontMap, gfxW, gfxH, planes);
            i = j;
            continue;
        }

        // Block-style If/ElseIf/Else/EndIf — probabilistic weighting.
        // Inline "If cond Then stmt" is counted as a regular statement (15 cycles).
        // Block-style: If body weighted at 50%; If/Else: average of branches (one always runs).
        const isBlockIf = /^If\b/i.test(trim) && !/^If\b.*\bThen\s+\S+/i.test(trim);
        if (isBlockIf) {
            const branches = [];
            let currentBranch = [];
            let hasTrailingElse = false;
            let depth = 1, j = i + 1;
            while (j < lines.length && depth > 0) {
                const t = lines[j].trim();
                if (/^If\b/i.test(t) && !/^If\b.*\bThen\s+\S+/i.test(t)) {
                    depth++;
                } else if (/^EndIf\b/i.test(t)) {
                    depth--;
                    if (depth === 0) { branches.push(currentBranch); j++; break; }
                } else if (depth === 1 && /^ElseIf\b/i.test(t)) {
                    branches.push(currentBranch); currentBranch = []; j++; continue;
                } else if (depth === 1 && /^Else\b/i.test(t)) {
                    branches.push(currentBranch); currentBranch = [];
                    hasTrailingElse = true; j++; continue;
                }
                if (depth > 0) currentBranch.push(lines[j]);
                j++;
            }
            const branchCosts = branches.map(b =>
                _estimateCycles(b, imageMap, fontMap, gfxW, gfxH, planes));
            const avgBranch  = branchCosts.reduce((a, b) => a + b, 0) / Math.max(branches.length, 1);
            // If with trailing Else: exactly one branch always runs → use average.
            // If without Else: condition may be false → weight body at 50%.
            const probability = hasTrailingElse ? 1.0 : 0.5;
            total += 15 + Math.round(avgBranch * probability);
            i = j;
            continue;
        }

        total += _estimateLineCycles(trim, imageMap, gfxW, gfxH, planes, activeFontCharH);
        i++;
    }
    return total;
}

function _estimateLineCycles(trim, imageMap, gfxW, gfxH, planes, activeFontCharH = 8) {
    if (!trim || /^;/.test(trim)) return 0;

    const wpl = Math.ceil(gfxW / 16);  // blitter words per scanline

    // ── Blitter commands ──────────────────────────────────────────────────────

    if (/^Cls\b/i.test(trim)) {
        // D-only fill, fastest blitter mode
        return planes * wpl * gfxH * 4;
    }

    if (/^Box\b/i.test(trim)) {
        // Match w/h as the 3rd and 4th comma-separated args; x and y may be expressions
        const m = /Box\s+[^,]+,[^,]+,\s*(\d+)\s*,\s*(\d+)/i.exec(trim);
        const bw = m ? parseInt(m[1]) : 32, bh = m ? parseInt(m[2]) : 32;
        return planes * (Math.ceil(bw / 16) + 1) * bh * 4;
    }

    if (/^Rect\b/i.test(trim)) {
        // Only the outline — 4 thin blits, roughly 2 × (w+h) words
        const m = /Rect\s+[^,]+,[^,]+,\s*(\d+)\s*,\s*(\d+)/i.exec(trim);
        const bw = m ? parseInt(m[1]) : 32, bh = m ? parseInt(m[2]) : 32;
        return planes * (bw + bh) * 2 * 4;
    }

    if (/^DrawImage\b/i.test(trim)) {
        const m = /DrawImage\s+(\d+)/i.exec(trim);
        const img = (m && imageMap[parseInt(m[1])]) || { w: 32, h: 32 };
        // Masked blit (A+C→D) — slightly more than plain copy
        return planes * (Math.ceil(img.w / 16) + 1) * img.h * 8;
    }

    if (/^DrawBob\b/i.test(trim)) {
        const m = /DrawBob\s+(\d+)/i.exec(trim);
        const img = (m && imageMap[parseInt(m[1])]) || { w: 32, h: 32 };
        // Bob = background restore blit + masked draw blit, both per plane
        return planes * (Math.ceil(img.w / 16) + 1) * img.h * 16;
    }

    if (/^Plot\b/i.test(trim))  return 50;
    if (/^Line\b/i.test(trim))  return 400;

    if (/^Text\b/i.test(trim)) {
        // Best-effort: measure the first string literal; fall back to 12 chars
        // Cost scales with charH: more rows per glyph = more CPU work
        const strM  = /"([^"]*)"/i.exec(trim);
        const chars = strM ? Math.max(strM[1].length, 4) : 12;
        return chars * Math.round(400 * (activeFontCharH / 8));
    }

    // ── Cheap commands ────────────────────────────────────────────────────────

    if (/^CopperColor\b/i.test(trim))   return 20;
    if (/^PaletteColor\b/i.test(trim))  return 20;
    if (/^Color\b/i.test(trim))         return 10;
    if (/^ClsColor\b/i.test(trim))      return 10;
    if (/^ScreenFlip\b/i.test(trim))    return 800;   // WaitBlit + copper swap
    if (/^PlaySample\b/i.test(trim))    return 200;
    if (/^PlaySampleOnce\b/i.test(trim)) return 300;
    if (/^StopSample\b/i.test(trim))    return 100;
    if (/^WaitKey\b/i.test(trim))       return 0;     // blocks — not in budget

    // ── Collision checks ──────────────────────────────────────────────────────
    // All three are inline-expanded (no JSR) but evaluate 6–8 args + AABB logic.

    if (/RectsOverlap\s*\(/i.test(trim))     return 120;
    if (/ImageRectOverlap\s*\(/i.test(trim)) return 80;
    if (/ImagesOverlap\s*\(/i.test(trim))    return 80;

    // ── Hardware access ───────────────────────────────────────────────────────
    // PeekB/W/L: move + optional ext.l; PokeB/W/L/Poke: move to absolute addr.

    if (/\bPeek[BWL]\s*\(/i.test(trim))                         return 20;
    if (/^\s*Poke[BWL]?\s+/i.test(trim))                        return 20;

    // Generic statement (assignment, condition, arithmetic, …)
    return 15;
}
