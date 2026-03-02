; ============================================================================
; palette.s — BASSM Palette Management
; ============================================================================
;
; PURPOSE
;   Manages the 32-entry OCS colour palette for BASSM programs:
;
;     _gfx_palette      — 32 OCS colour words in chip RAM (DATA_C)
;     _InitPalette      — copies palette to hardware COLOR00-COLOR31 at startup
;     _SetPaletteColor  — updates one palette entry in RAM and in hardware
;     _draw_color       — current drawing colour index (set by Color n command)
;
; BLITZ2D SYNTAX
;   Color n               — sets _draw_color to palette index n (0..31)
;   PaletteColor n,r,g,b  — sets palette entry n to OCS color (r,g,b each 0-15)
;
; DEFAULT PALETTE (inline, assembled into chip RAM as DATA_C)
;
;   Index  OCS word   Description
;   ─────  ─────────  ──────────────────
;     0    $0000      black   (background / Cls default)
;     1    $0FFF      white   (default drawing colour)
;     2    $0F00      red
;     3    $00F0      green
;     4    $000F      blue
;     5    $0FF0      yellow
;     6    $0F0F      magenta
;     7    $00FF      cyan
;     8    $0888      medium grey
;     9    $0444      dark grey
;    10    $0CCC      light grey
;    11    $0F80      orange
;    12    $0840      brown
;    13    $08F8      light green
;    14    $048F      sky blue
;    15    $0F88      pink
;   16-31  $0000      spare (black)
;
; NOTE: Palette loading from files or named palette definitions are not yet
;       implemented.  Future commands planned:
;         LoadPalette "filename.pal"  — load palette data from an IFF CMAP or
;                                       raw 32-word binary file at runtime
;         PaletteColor n,r,g,b        — already implemented (inline override)
;       Until then, programs use this default palette or override individual
;       entries with PaletteColor before drawing.
;
; CODEGEN CONTRACT
;   Generated CODE for Color n  (sets the current drawing colour index):
;         move.w  #n,_draw_color
;
;   Generated CODE for PaletteColor n,r,g,b  (all literal values):
;         moveq   #n,d0
;         move.w  #$0RGB,d1       ; codegen assembles the nibbles at compile time
;         jsr     _SetPaletteColor
;
;   _InitPalette is called from _setup_graphics (in codegen's gfx_init section).
;
; DEPENDENCY
;   COLOR00 ($180) is defined in startup.s — startup.s must be included first.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s)
; ============================================================================


; ── _gfx_palette — default colour table (chip RAM) ───────────────────────────

        SECTION palette_data,DATA_C

        XDEF    _gfx_palette
_gfx_palette:
        dc.w    $0000           ;  0  black          (background / Cls default)
        dc.w    $0FFF           ;  1  white           (default drawing colour)
        dc.w    $0F00           ;  2  red
        dc.w    $00F0           ;  3  green
        dc.w    $000F           ;  4  blue
        dc.w    $0FF0           ;  5  yellow
        dc.w    $0F0F           ;  6  magenta
        dc.w    $00FF           ;  7  cyan
        dc.w    $0888           ;  8  medium grey
        dc.w    $0444           ;  9  dark grey
        dc.w    $0CCC           ; 10  light grey
        dc.w    $0F80           ; 11  orange
        dc.w    $0840           ; 12  brown
        dc.w    $08F8           ; 13  light green
        dc.w    $048F           ; 14  sky blue
        dc.w    $0F88           ; 15  pink
        dc.w    $0000           ; 16  spare (black)
        dc.w    $0000           ; 17
        dc.w    $0000           ; 18
        dc.w    $0000           ; 19
        dc.w    $0000           ; 20
        dc.w    $0000           ; 21
        dc.w    $0000           ; 22
        dc.w    $0000           ; 23
        dc.w    $0000           ; 24
        dc.w    $0000           ; 25
        dc.w    $0000           ; 26
        dc.w    $0000           ; 27
        dc.w    $0000           ; 28
        dc.w    $0000           ; 29
        dc.w    $0000           ; 30
        dc.w    $0000           ; 31


; ── Code ──────────────────────────────────────────────────────────────────────

        SECTION palette_code,CODE


; ── _InitPalette ─────────────────────────────────────────────────────────────
;
; Copies all 32 entries from _gfx_palette to hardware COLOR00-COLOR31.
; Called once from _setup_graphics during program initialisation.
;
; Args:   none
; Trashes: d0, a0, a1  (preserved via movem)

        XDEF    _InitPalette
_InitPalette:
        movem.l d0/a0-a1,-(sp)
        lea     _gfx_palette,a0         ; source: palette table
        lea     COLOR00(a5),a1          ; dest: $DFF180  [disp16 LEA — safe]
        moveq   #31,d0                  ; 32 entries (indices 0-31)
.ipal_loop:
        move.w  (a0)+,(a1)+             ; copy one colour word to hardware
        dbra    d0,.ipal_loop
        movem.l (sp)+,d0/a0-a1
        rts


; ── _SetPaletteColor ──────────────────────────────────────────────────────────
;
; Updates one entry in _gfx_palette AND writes it to the hardware COLOR
; register immediately.
;
; Args:   d0.w = colour register index (0..31)
;         d1.w = OCS colour word ($0RGB, each nibble 0-F)
; Trashes: d0, a0  (preserved via movem)
;
; NOTE ON ADDRESSING
;   COLOR00 = $180.  The 68000's indexed mode (disp8,An,Dn) has only an 8-bit
;   signed displacement, so COLOR00(a5,d0.w) would overflow.  Instead we use
;   LEA with a 16-bit displacement to load the palette base, then index from
;   there with an implicit zero displacement.

        XDEF    _SetPaletteColor
_SetPaletteColor:
        movem.l d0/a0,-(sp)
        add.w   d0,d0                   ; index*2 = byte offset into table
        lea     _gfx_palette,a0
        move.w  d1,(a0,d0.w)            ; update _gfx_palette entry in chip RAM
        lea     COLOR00(a5),a0          ; a0 = $DFF180  [disp16 LEA — safe]
        move.w  d1,(a0,d0.w)            ; write to hardware COLOR register
        movem.l (sp)+,d0/a0
        rts


; ── BSS — current drawing colour index ───────────────────────────────────────

        SECTION palette_bss,BSS

; _draw_color — palette index selected by the last Color n command.
; Used by Text, Plot, Line, and other drawing subroutines to determine which
; palette entry to apply to pixels.
; Default 0 (black) via BSS zero-initialisation.

        XDEF    _draw_color
_draw_color:    ds.w    1               ; palette index (0..31), default 0
