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
//
// SSOT (M2-T08):
//   - commands-map.json liefert die Liste aller bekannten Commands.
//   - budget-costs.json liefert pro Command einen Cost-Eintrag (`kind` +
//     entweder `cycles` für fixed-cost oder `factor` für skalierende blits).
//   Neue Commands ohne Eintrag in budget-costs.json fallen automatisch auf
//   den 15-Zyklen-Default — kein manueller Sync nötig, bis ein Command
//   explizit teurer als generisch wird.

import COMMANDS_MAP from './commands-map.json' with { type: 'json' };
import BUDGET_COSTS from './budget-costs.json' with { type: 'json' };

const CPU_HZ        = 7_090_000;
const FRAME_HZ      = 50;
export const CYCLES_FRAME   = Math.floor(CPU_HZ / FRAME_HZ);  // 141,800
export const CHIP_RAM_BYTES = 512 * 1024;                     // 524,288 bytes

const GENERIC_STMT_CYCLES = 15;

// ── Lookup tables derived from JSON SSOT ─────────────────────────────────────

const _COMMAND_LOWER = new Set(COMMANDS_MAP.map(c => c.name.toLowerCase()));

const _COSTS_LOWER = Object.fromEntries(
    Object.entries(BUDGET_COSTS)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k.toLowerCase(), v])
);

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

    // LoadImage: sizes live in the .iraw v2 header (compile-time read by codegen).
    // budget.js can't read binary headers, so any LoadImage flags assets+ as
    // "size unknown" and DrawImage/DrawBob fall back to a 32×32 default.
    const imageMap = {};
    const imgRE = /^\s*LoadImage\s+(\d+)\s*,\s*"[^"]*"/img;
    let m;
    while ((m = imgRE.exec(source)) !== null) {
        imageMap[parseInt(m[1])] = { w: 32, h: 32 };
        chipRamPlus = true;
    }

    // INCBIN-driven assets — chip RAM size unknown at parse time.
    if (/^\s*LoadSample\b/im.test(source))   chipRamPlus = true;
    if (/^\s*LoadTileset\b/im.test(source))  chipRamPlus = true;
    if (/^\s*LoadTilemap\b/im.test(source))  chipRamPlus = true;

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
            total += GENERIC_STMT_CYCLES + Math.round(avgBranch * probability);
            i = j;
            continue;
        }

        total += _estimateLineCycles(trim, imageMap, gfxW, gfxH, planes, activeFontCharH);
        i++;
    }
    return total;
}

/** Extract leading command identifier (or null for non-command statements). */
function _firstCommandToken(trim) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(trim);
    if (!m) return null;
    const lower = m[1].toLowerCase();
    return _COMMAND_LOWER.has(lower) ? lower : null;
}

function _estimateLineCycles(trim, imageMap, gfxW, gfxH, planes, activeFontCharH = 8) {
    if (!trim || /^;/.test(trim)) return 0;

    // ── Built-in expression calls (PeekB/PeekW/PeekL, *Overlap) ───────────────
    // These appear inside expressions, not as leading tokens — keep regex paths.
    if (/\bPeek[BWL]\s*\(/i.test(trim))       return 20;
    if (/RectsOverlap\s*\(/i.test(trim))      return 120;
    if (/ImageRectOverlap\s*\(/i.test(trim))  return 80;
    if (/ImagesOverlap\s*\(/i.test(trim))     return 80;

    // ── JSON-driven command dispatch ──────────────────────────────────────────
    const cmd = _firstCommandToken(trim);
    if (cmd) {
        const cost = _COSTS_LOWER[cmd];
        if (!cost) return GENERIC_STMT_CYCLES;       // command known but no override

        switch (cost.kind) {
            case 'init':
            case 'fixed':
                return cost.cycles ?? 0;

            case 'screen': {
                // D-only fill — cost scales with full screen size
                const wpl = Math.ceil(gfxW / 16);
                return planes * wpl * gfxH * cost.factor;
            }

            case 'rect': {
                // Box: filled rect blit, w/h are 3rd/4th args (literal-only)
                const m = /\s+[^,]+,[^,]+,\s*(\d+)\s*,\s*(\d+)/.exec(trim);
                const bw = m ? parseInt(m[1]) : 32, bh = m ? parseInt(m[2]) : 32;
                return planes * (Math.ceil(bw / 16) + 1) * bh * cost.factor;
            }

            case 'outline': {
                // Rect: outline only — ~2×(w+h) words per plane
                const m = /\s+[^,]+,[^,]+,\s*(\d+)\s*,\s*(\d+)/.exec(trim);
                const bw = m ? parseInt(m[1]) : 32, bh = m ? parseInt(m[2]) : 32;
                return planes * (bw + bh) * 2 * cost.factor;
            }

            case 'image': {
                // DrawImage — masked blit per plane, scales with image size
                const m = /\s+(\d+)/.exec(trim);
                const img = (m && imageMap[parseInt(m[1])]) || { w: 32, h: 32 };
                return planes * (Math.ceil(img.w / 16) + 1) * img.h * cost.factor;
            }

            case 'bob': {
                // DrawBob — restore + masked draw, ~2× DrawImage per plane
                const m = /\s+(\d+)/.exec(trim);
                const img = (m && imageMap[parseInt(m[1])]) || { w: 32, h: 32 };
                return planes * (Math.ceil(img.w / 16) + 1) * img.h * cost.factor;
            }

            case 'text': {
                // Text — CPU cost scales with chars × charH; 8px = 1× factor
                const strM  = /"([^"]*)"/.exec(trim);
                const chars = strM ? Math.max(strM[1].length, 4) : 12;
                return chars * Math.round(cost.factor * (activeFontCharH / 8));
            }

            default:
                return GENERIC_STMT_CYCLES;
        }
    }

    // Generic statement (assignment, condition, arithmetic, …)
    return GENERIC_STMT_CYCLES;
}
