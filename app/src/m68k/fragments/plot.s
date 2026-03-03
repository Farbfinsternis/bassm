; ============================================================================
; plot.s — BASSM Single Pixel Plot
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Plot" command:
;
;     _Plot  — set a single pixel at (x, y) using the current draw colour
;
; BLITZ2D SYNTAX
;   Plot x, y
;   Example: Plot 10, 20
;
; CODEGEN CONTRACT
;   Generated code evaluates args and calls:
;         move.l  <y_expr>,d1
;         move.l  <x_expr>,d0
;         jsr     _Plot
;
; PIXEL ADDRESSING  (OCS lores 320px, planar bitmap)
;   byte_offset = y * GFXBPR + (x >> 3)    ; which byte holds the pixel
;   bit_mask    = $80 >> (x AND 7)          ; Amiga stores MSB leftmost
;   plane_addr  = _gfx_planes + p*GFXPSIZE + byte_offset
;
;   For each plane p (0 .. GFXDEPTH-1):
;     bit p of _draw_color set   → OR  bit_mask into plane_addr  (set pixel)
;     bit p of _draw_color clear → AND NOT(bit_mask) into plane_addr  (clear)
;
; BOUNDS CHECKING
;   Pixels outside [0..GFXWIDTH-1] x [0..GFXHEIGHT-1] are silently discarded.
;
; REGISTER SAVE
;   Saves d0-d7/a0-a2 so that callers (including _Line) may freely use all.
;
; DEPENDENCY
;   palette.s must be included before this fragment (defines _draw_color).
;   codegen.js defines GFXBPR, GFXPSIZE, GFXDEPTH, GFXWIDTH, GFXHEIGHT as EQUs.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used by this routine)
; ============================================================================


        SECTION plot_code,CODE


; ── _Plot ─────────────────────────────────────────────────────────────────────
;
; Sets a single pixel at (x, y) in every bitplane as dictated by _draw_color.
;
; Args:   d0.l = x  (0 .. GFXWIDTH-1)
;         d1.l = y  (0 .. GFXHEIGHT-1)
; Trashes: nothing (saves/restores d0-d7/a0-a2)

        XDEF    _Plot
_Plot:
        movem.l d0-d7/a0-a2,-(sp)

        ; ── Bounds check ──────────────────────────────────────────────────────
        tst.l   d0
        blt.s   .plot_done              ; x < 0 → skip
        tst.l   d1
        blt.s   .plot_done              ; y < 0 → skip
        cmp.l   #GFXWIDTH,d0
        bge.s   .plot_done              ; x >= width → skip
        cmp.l   #GFXHEIGHT,d1
        bge.s   .plot_done              ; y >= height → skip

        ; ── byte_offset = y * GFXBPR + (x >> 3) ──────────────────────────────
        move.l  d1,d2                   ; d2 = y
        muls.w  #GFXBPR,d2              ; d2 = y * GFXBPR  (both fit in 16 bits)
        move.l  d0,d3
        lsr.l   #3,d3                   ; d3 = x >> 3
        add.l   d3,d2                   ; d2 = byte_offset

        ; ── bit_mask = $80 >> (x AND 7)  (MSB = leftmost pixel in byte) ──────
        move.l  d0,d4
        and.l   #7,d4                   ; d4 = x AND 7  (shift count 0-7)
        moveq   #0,d5
        move.b  #$80,d5                 ; d5 = $00000080
        lsr.b   d4,d5                   ; d5.b = $80 >> shift

        ; ── Loop over bitplanes ───────────────────────────────────────────────
        moveq   #GFXDEPTH-1,d6         ; d6 = outer loop counter
        move.w  _draw_color,d7          ; d7.w = current draw colour index
        move.l  _back_planes_ptr,a0     ; a0 = back buffer base (double-buffering)

.plot_plane:
        lea     (a0,d2.l),a1            ; a1 = byte addr for this pixel in plane
        btst    #0,d7                   ; is LSB of colour set for this plane?
        beq.s   .plot_clear_bit

        or.b    d5,(a1)                 ; set the pixel bit
        bra.s   .plot_advance

.plot_clear_bit:
        move.b  d5,d3
        not.b   d3                      ; d3.b = inverse mask
        and.b   d3,(a1)                 ; clear the pixel bit

.plot_advance:
        lea     GFXPSIZE(a0),a0        ; advance to next bitplane base
        lsr.w   #1,d7                   ; shift colour: next plane bit → LSB
        dbra    d6,.plot_plane

.plot_done:
        movem.l (sp)+,d0-d7/a0-a2
        rts
