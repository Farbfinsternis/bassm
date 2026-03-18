// ============================================================================
// peephole.js — BASSM m68k Assembly Peephole Optimizer
// ============================================================================
//
// Fourth pass in the compile pipeline (after CodeGen, before vasm).
// Operates on the generated assembly text as a sliding window over lines.
// Runs in repeated passes until no rule fires.
//
// Rules (tried in priority order at each position):
//
//   R4 – Binop push-pop → direct memory source operand           (6-line)
//        move.l RHS,d0 / push / move.l LHS,d0 / pop,d1 /
//        {add|sub|or|and}.l d1,d0 / store LHS
//        → move.l LHS,d0 / op.l RHS,d0 / store LHS
//        Eliminates push/pop and register spill for compound assignments
//        like `b(i)\x = b(i)\x + b(i)\dx`.
//
//   R3 – For-loop double load                                     (4-line)
//        move.l X,d0 / cmp.l #N,d0 / b<cc> label / move.l X,d0
//        → delete 4th line
//        d0 still holds X after the comparison — the reload is redundant.
//
//   R5 – 2-arg push-pop                                           (4-line)
//        load A→d0 / push / load B→d0 / pop→d1
//        → load B→d0 / load A→d1
//        Direct register assignment instead of stack round-trip for
//        simple 2-argument calls (Text, DrawImage, Plot, …).
//
//   R1 – Store-reload                                             (2-line)
//        move.l d0,X / move.l X,d0  → delete reload
//        d0 still holds its value after the store.
//
//   R2 – cmp.l #0 → tst.l                                        (1-line)
//        cmp.l #0,Dn  →  tst.l Dn
//        Saves 10 cycles and 4 bytes; critical in tight loops (×212/frame
//        for the raster-bar inner loop).
//
// Safety invariants:
//   • A rule fires only when none of the lines being replaced or deleted
//     can be a branch target from outside the window.
//   • Branch targets are identified by preceding label-only lines
//     (in generated code, labels are always on their own line).
//   • Rules 1, 3, 4, 5 check _prevIsLabel() to guard the window start.
//   • All non-first lines in a window are checked with _isInstr() — an
//     instruction line starts with whitespace and therefore carries no
//     label (labels are at column 0 in the generated output).
// ============================================================================

export class Peephole {

    /**
     * Optimize a generated m68k assembly string.
     * Runs passes until stable (typically 1–2 passes).
     *
     * @param  {string} asm  Raw assembly from CodeGen
     * @returns {string}     Optimized assembly
     */
    optimize(asm) {
        let lines = asm.split('\n');
        let changed = true;
        let passes = 0;
        while (changed && passes++ < 8) {
            const r = this._pass(lines);
            changed  = r.changed;
            lines    = r.lines;
        }
        return lines.join('\n');
    }

    _pass(lines) {
        const out = [];
        let changed = false;
        let i = 0;
        const n = lines.length;

        while (i < n) {

            // ── R4: Binop push-pop → direct memory source operand ──────────
            // move.l RHS,d0
            // move.l d0,-(sp)
            // move.l LHS,d0
            // move.l (sp)+,d1
            // {add|sub|or|and}.l d1,d0
            // move.l d0,LHS               (LHS == line i+2 source)
            // → move.l LHS,d0 / op.l RHS,d0 / move.l d0,LHS
            if (i + 5 < n && !_prevIsLabel(lines, i)) {
                const rhs  = _memSrcD0(lines[i]);
                const lhs  = _memSrcD0(lines[i + 2]);
                const dest = _d0Dest  (lines[i + 5]);
                const op   = _binopD1D0(lines[i + 4]);
                if (rhs !== null && lhs !== null && dest !== null && op !== null &&
                    _isPush(lines[i + 1]) && _isPopD1(lines[i + 3])   &&
                    _isInstr(lines[i + 1]) && _isInstr(lines[i + 2])  &&
                    _isInstr(lines[i + 3]) && _isInstr(lines[i + 4])  &&
                    _isInstr(lines[i + 5]) && lhs === dest)
                {
                    const ind = _indent(lines[i]);
                    out.push(lines[i + 2]);                      // move.l LHS,d0
                    out.push(`${ind}${op}.l   ${rhs},d0`);       // op.l   RHS,d0
                    out.push(lines[i + 5]);                      // move.l d0,LHS
                    i += 6;
                    changed = true;
                    continue;
                }
            }

            // ── R3: For-loop double load ────────────────────────────────────
            // move.l X,d0 / cmp.l #N,d0 / b<cc> label / move.l X,d0
            // → keep first three, delete the redundant 4th load
            if (i + 3 < n && !_prevIsLabel(lines, i)) {
                const op1 = _memSrcD0(lines[i]);
                const op4 = _memSrcD0(lines[i + 3]);
                if (op1 !== null && op4 !== null && op1 === op4    &&
                    _isCmpD0(lines[i + 1]) && _isCondBranch(lines[i + 2]) &&
                    _isInstr(lines[i + 1]) && _isInstr(lines[i + 2])      &&
                    _isInstr(lines[i + 3]) && !_prevIsLabel(lines, i + 3))
                {
                    out.push(lines[i], lines[i + 1], lines[i + 2]);
                    i += 4;
                    changed = true;
                    continue;
                }
            }

            // ── R5: 2-arg push-pop ─────────────────────────────────────────
            // load A→d0 / push / load B→d0 / pop→d1
            // → load B→d0 / load A→d1
            if (i + 3 < n && !_prevIsLabel(lines, i)) {
                if (_isLoadD0(lines[i])    && _isPush(lines[i + 1]) &&
                    _isLoadD0(lines[i + 2]) && _isPopD1(lines[i + 3]) &&
                    _isInstr(lines[i + 1]) && _isInstr(lines[i + 2]) &&
                    _isInstr(lines[i + 3]))
                {
                    out.push(lines[i + 2]);        // B → d0 (unchanged)
                    out.push(_d0ToD1(lines[i]));   // A → d1
                    i += 4;
                    changed = true;
                    continue;
                }
            }

            // ── R1: Store-reload ───────────────────────────────────────────
            // move.l d0,X / move.l X,d0  → delete reload
            if (i + 1 < n) {
                const dest = _d0Dest  (lines[i]);
                const src  = _memSrcD0(lines[i + 1]);
                if (dest !== null && src !== null && dest === src &&
                    _isInstr(lines[i + 1]) && !_prevIsLabel(lines, i + 1))
                {
                    out.push(lines[i]);
                    i += 2;
                    changed = true;
                    continue;
                }
            }

            // ── R2: cmp.l #0,Dn → tst.l Dn ───────────────────────────────
            {
                const m = lines[i].match(/^(\s+)cmp\.l\s+#0,(d[0-7])(\s*(?:;.*)?)$/);
                if (m) {
                    out.push(`${m[1]}tst.l   ${m[2]}${m[3]}`);
                    i++;
                    changed = true;
                    continue;
                }
            }

            out.push(lines[i]);
            i++;
        }

        return { lines: out, changed };
    }
}

// ── Predicates & extractors ────────────────────────────────────────────────

/** True if line is an instruction line (starts with whitespace — no label). */
function _isInstr(line) {
    return line.length > 0 && (line[0] === ' ' || line[0] === '\t');
}

/** True if the line immediately before lines[i] is a label-only line. */
function _prevIsLabel(lines, i) {
    if (i === 0) return false;
    return /^[.\w_]+:\s*$/.test(lines[i - 1]);
}

/** Leading whitespace of line (for emitting new instructions). */
function _indent(line) {
    const m = line.match(/^(\s+)/);
    return m ? m[1] : '        ';
}

/**
 * If line is "move.l SRC,d0", return SRC (trimmed).
 * Returns null for register sources (d0–d7, a0–a7) and stack ops.
 */
function _memSrcD0(line) {
    const m = line.match(/^\s+move\.l\s+([^,\n]+?)\s*,d0(?:\s*(?:;.*))?$/);
    if (!m) return null;
    const src = m[1].trim();
    if (/^[da][0-7]$/.test(src)) return null;   // plain register
    if (src === '-(sp)' || src === '(sp)+') return null;
    return src;
}

/**
 * If line is "move.l d0,DEST", return DEST (trimmed).
 * Returns null for register destinations and stack ops.
 */
function _d0Dest(line) {
    const m = line.match(/^\s+move\.l\s+d0,([^,\n\s;]+)(?:\s*(?:;.*))?$/);
    if (!m) return null;
    const dst = m[1].trim();
    if (/^[da][0-7]$/.test(dst)) return null;
    if (dst.startsWith('-(')) return null;       // -(sp) / -(a7)
    return dst;
}

/** True if line is "move.l d0,-(sp)". */
function _isPush(line) {
    return /^\s+move\.l\s+d0,-\(sp\)/.test(line);
}

/** True if line is "move.l (sp)+,d1". */
function _isPopD1(line) {
    return /^\s+move\.l\s+\(sp\)\+,d1/.test(line);
}

/** Returns op mnemonic if line is "{add|sub|or|and}.l d1,d0", else null. */
function _binopD1D0(line) {
    const m = line.match(/^\s+(add|sub|or|and)\.l\s+d1,d0(?:\s*(?:;.*))?$/);
    return m ? m[1] : null;
}

/** True if line is "cmp.l #N,d0" for any N. */
function _isCmpD0(line) {
    return /^\s+cmp\.l\s+#[^,\n]+,d0/.test(line);
}

/** True if line is a conditional branch (excludes bra, bsr). */
function _isCondBranch(line) {
    return /^\s+b(?:eq|ne|gt|lt|ge|le|cc|cs|hi|ls|mi|pl|vc|vs)\.[ws]\s+\S+/.test(line);
}

/**
 * True if line is a single pure-write "load into d0" instruction
 * (moveq #N,d0 or move.l/move.w X,d0 where source doesn't read d0).
 * Excludes read-modify-write instructions like add.l, neg.l, ext.l.
 */
function _isLoadD0(line) {
    if (/^\s+moveq\s+[^,\n]+,d0(?:\s*(?:;.*))?$/.test(line)) return true;
    const m = line.match(/^\s+move\.[lw]\s+([^,\n]+?)\s*,d0(?:\s*(?:;.*))?$/);
    return !!(m && !m[1].includes('d0'));
}

/** Replace the trailing ",d0" with ",d1" (preserves optional comment). */
function _d0ToD1(line) {
    return line.replace(/(,d0)(\s*(?:;.*)?)$/, ',d1$2');
}
