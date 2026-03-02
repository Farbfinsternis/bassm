; ============================================================================
; color.s — BASSM Palette (Color) Subroutine
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Color" command:
;
;     _SetColor  — writes one OCS palette entry to the hardware color table
;
; BLITZ2D SYNTAX
;   Color r, g, b
;   Example: Color 15, 0, 7    (red=15, green=0, blue=7 → palette register 1)
;   Always targets palette register 1 (foreground drawing color).
;   Register 0 (background) is written by Cls/ClsColor.
;
; OCS COLOUR FORMAT
;   Each OCS palette register holds a 12-bit colour:
;     bits 11-8 = Red   (0-15)
;     bits  7-4 = Green (0-15)
;     bits  3-0 = Blue  (0-15)
;   Written as a word: $0RGB   (high nibble always 0)
;
; HOW IT WORKS
;   The 32 OCS palette registers start at $DFF180 (COLOR00).
;   Register n is at COLOR00 + n*2.
;   _SetColor multiplies the index by 2 and does a single MOVE.W to the
;   hardware register — no Blitter required.
;
; CODEGEN CONTRACT
;   Generated CODE for Color r, g, b  (all literal values):
;         moveq  #1,d0           ; always palette register 1
;         move.w #$0RGB,d1       ; codegen assembles the nibbles at compile time
;         bsr    _SetColor
;
;   The $0RGB word is assembled by codegen.js as:
;         (r & $F) << 8 | (g & $F) << 4 | (b & $F)
;
;   For dynamic colors (variables), codegen emits the same call but loads
;   d0/d1 from computed values at runtime.
;
; DEPENDENCY
;   COLOR00 ($180) is defined in startup.s — startup.s must be included
;   before color.s in the same assembly pass.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s)
; ============================================================================


        SECTION color_code,CODE


; ── _SetColor ─────────────────────────────────────────────────────────────────
;
; Writes a colour word into the OCS palette table.
;
; Args:   d0.w = colour register index (0 .. GFXCOLORS-1)
;         d1.w = OCS colour word ($0RGB, each nibble 0-F)
; Trashes: d0, a0
;
; NOTE ON ADDRESSING
;   COLOR00 = $180.  The 68000's indexed mode (disp8,An,Dn) has only an 8-bit
;   signed displacement (-128..+127), so COLOR00(a5,d0.w) would overflow.
;   Instead we load the palette base address via the 16-bit disp16(An) form
;   of LEA, then use (a0,d0.w) with an implicit zero displacement.

        XDEF    _SetColor
_SetColor:
        add.w   d0,d0                   ; index * 2 = byte offset into palette
        lea     COLOR00(a5),a0          ; a0 = $DFF180  [disp16 LEA — safe]
        move.w  d1,(a0,d0.w)            ; write to palette register
        rts
