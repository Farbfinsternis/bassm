; ============================================================================
; clscolor.s — BASSM ClsColor Subroutine
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "ClsColor" command:
;
;     _ClsColor  — sets the colour index used by subsequent Cls calls
;
; BLITZ2D SYNTAX
;   ClsColor n
;   Example: ClsColor 3    (subsequent Cls calls will fill the screen to colour 3)
;
; HOW IT WORKS
;   _ClsColor simply stores the colour index in _cls_color (defined in cls.s).
;   The actual fill happens when _Cls is called.
;
;   _cls_color holds a bit field: bit k = 1 means bitplane k is filled with
;   $FFFF when Cls runs; bit k = 0 means bitplane k is filled with $0000.
;   This maps colour index n to its binary representation across the planes:
;     colour 0 → all planes 0  (black)
;     colour 1 → plane 0 = 1, others 0
;     colour 5 (%101) → planes 0 and 2 = 1, plane 1 = 0  (for 3-plane mode)
;
; CODEGEN CONTRACT
;   Generated CODE for ClsColor n:
;         moveq  #n,d0
;         bsr    _ClsColor
;
;   If ClsColor is always followed immediately by Cls in Blitz2D source,
;   the two calls can be emitted back-to-back.
;
; DEPENDENCY
;   _cls_color is defined and XDEF'd in cls.s — cls.s must be included
;   before or after clscolor.s in the same assembly pass.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (not used by this subroutine)
; ============================================================================


        SECTION clscolor_code,CODE


; ── _ClsColor ─────────────────────────────────────────────────────────────────
;
; Sets the colour index for subsequent Cls calls.
;
; Args:   d0.l = colour index (0 .. GFXCOLORS-1)
; Trashes: nothing (d0 is the argument, not preserved)

        XDEF    _ClsColor
_ClsColor:
        move.l  d0,_cls_color           ; store colour index for _Cls to use
        rts
