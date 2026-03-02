; ============================================================================
; line.s — BASSM Bresenham Line Drawing
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Line" command:
;
;     _Line  — draw a line from (x1,y1) to (x2,y2) via Bresenham's algorithm
;
; BLITZ2D SYNTAX
;   Line x1, y1, x2, y2
;   Example: Line 0,0, 319,255
;
; CODEGEN CONTRACT
;   Codegen pushes y2, x2, y1 on the stack, then evaluates x1 into d0, then:
;         movem.l (sp)+,d1-d3          ; pop y1→d1, x2→d2, y2→d3
;         jsr     _Line                ; d0=x1, d1=y1, d2=x2, d3=y2
;
; ALGORITHM  (Bresenham integer line, any octant)
;   dx = |x2-x1|,  sx = sign(x2-x1)
;   dy = |y2-y1|,  sy = sign(y2-y1)
;   err = dx - dy
;   loop:
;     Plot(x, y)
;     if x==x2 AND y==y2: done
;     e2 = 2 * err
;     if e2 + dy > 0:  err -= dy;  x += sx      (equivalent to: e2 > -dy)
;     if e2 - dx < 0:  err += dx;  y += sy      (equivalent to: e2 < dx)
;
; NOTE ON FLAG SAFETY
;   The x-check is implemented as (e2 + dy > 0) so the result register is
;   set and tested in a single ADD + BLE pair — no second NEG that would
;   overwrite the condition codes before the branch.
;
; REGISTER MAP (inside _Line)
;   a0 = x  (current x, address register used as signed integer)
;   a1 = y  (current y)
;   d2 = x2 (end x)
;   d3 = y2 (end y)
;   d4 = dx (positive)
;   d5 = dy (positive)
;   d6 = sx (+1 or -1)
;   d7 = sy (+1 or -1)
;   a2 = err
;
;   a0-a2 and d2-d7 survive the inner jsr _Plot because _Plot saves d0-d7/a0-a2.
;
; DEPENDENCY
;   plot.s must be included before this fragment (defines _Plot).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used by this routine)
; ============================================================================


        SECTION line_code,CODE


; ── _Line ─────────────────────────────────────────────────────────────────────
;
; Draws a line using Bresenham's integer algorithm.
; Pixel clipping is handled per-pixel by _Plot.
;
; Args:   d0.l = x1,  d1.l = y1  (start)
;         d2.l = x2,  d3.l = y2  (end)
; Trashes: nothing (saves/restores d0-d7/a0-a2)

        XDEF    _Line
_Line:
        movem.l d0-d7/a0-a2,-(sp)

        ; ── Compute dx, dy, sx, sy ────────────────────────────────────────────

        ; dx = x2 - x1
        move.l  d2,d4
        sub.l   d0,d4                   ; d4 = x2 - x1  (signed, may be negative)

        ; dy = y2 - y1
        move.l  d3,d5
        sub.l   d1,d5                   ; d5 = y2 - y1  (signed, may be negative)

        ; sx = sign(dx): +1 if dx >= 0, else -1
        moveq   #1,d6
        tst.l   d4
        bge.s   .line_sx_ok
        moveq   #-1,d6
.line_sx_ok:

        ; sy = sign(dy): +1 if dy >= 0, else -1
        moveq   #1,d7
        tst.l   d5
        bge.s   .line_sy_ok
        moveq   #-1,d7
.line_sy_ok:

        ; abs(dx)
        tst.l   d4
        bge.s   .line_absdx
        neg.l   d4
.line_absdx:

        ; abs(dy)
        tst.l   d5
        bge.s   .line_absdy
        neg.l   d5
.line_absdy:

        ; err = dx - dy  → stored in a2 as 32-bit signed integer
        move.l  d4,a2
        suba.l  d5,a2                   ; a2 = err = dx - dy

        ; Load (x1, y1) into address registers for the loop
        move.l  d0,a0                   ; a0 = x (current)
        move.l  d1,a1                   ; a1 = y (current)

        ; ── Main Bresenham loop ───────────────────────────────────────────────
.line_loop:
        ; Plot current pixel: d0=x, d1=y already set from a0/a1 below
        move.l  a0,d0                   ; d0 = x  (for _Plot)
        move.l  a1,d1                   ; d1 = y  (for _Plot)
        jsr     _Plot                   ; saves/restores d0-d7/a0-a2 → all intact

        ; Check end condition: done when x==x2 AND y==y2
        cmpa.l  d2,a0                   ; a0 - d2 = x - x2
        bne.s   .line_not_done
        cmpa.l  d3,a1                   ; a1 - d3 = y - y2
        beq.s   .line_done

.line_not_done:
        ; e2 = 2 * err
        move.l  a2,d0                   ; d0 = err
        add.l   d0,d0                   ; d0 = e2 = 2 * err

        ; if e2 > -dy:  err -= dy;  x += sx
        ;   equivalent to: e2 + dy > 0
        ;   Use d1 (free in loop) to avoid clobbering flags with a restore-neg.
        move.l  d0,d1                   ; d1 = e2  (preserve d0 for y-check)
        add.l   d5,d1                   ; d1 = e2 + dy  (flags set here)
        ble.s   .line_no_x              ; skip if e2 + dy <= 0  (i.e. e2 <= -dy)
        suba.l  d5,a2                   ; err -= dy
        adda.l  d6,a0                   ; x  += sx
.line_no_x:

        ; if e2 < dx:  err += dx;  y += sy
        ;   d0 = e2, d4 = dx
        cmp.l   d4,d0                   ; d0 - d4 = e2 - dx
        bge.s   .line_no_y              ; skip if e2 >= dx
        adda.l  d4,a2                   ; err += dx
        adda.l  d7,a1                   ; y   += sy
.line_no_y:

        bra.s   .line_loop

.line_done:
        movem.l (sp)+,d0-d7/a0-a2
        rts
