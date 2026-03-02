; ============================================================================
; rect.s — BASSM Rectangle Outline
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Rect" command:
;
;     _Rect  — draw an axis-aligned rectangle outline at (x,y) with size w×h
;
; BLITZ2D SYNTAX
;   Rect x, y, w, h
;   Example: Rect 10, 10, 100, 80
;
; CODEGEN CONTRACT
;   Codegen pushes h, w, y on the stack, evaluates x into d0, then:
;         movem.l (sp)+,d1-d3          ; pop y→d1, w→d2, h→d3
;         jsr     _Rect                ; d0=x, d1=y, d2=w, d3=h
;
; HOW IT WORKS
;   Draws four sides by calling _Line:
;     Top    : (x,       y      ) → (x+w-1, y      )
;     Bottom : (x,       y+h-1  ) → (x+w-1, y+h-1  )
;     Left   : (x,       y      ) → (x,     y+h-1  )
;     Right  : (x+w-1,   y      ) → (x+w-1, y+h-1  )
;
;   _Line saves/restores d0-d7/a0-a2, so all working registers are intact
;   after each call.
;
; REGISTER MAP (inside _Rect)
;   a0 = x        a2 = x2 = x+w-1
;   a1 = y        d7 = y2 = y+h-1
;
; DEPENDENCY
;   line.s must be included before this fragment (defines _Line).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used by this routine)
; ============================================================================


        SECTION rect_code,CODE


; ── _Rect ─────────────────────────────────────────────────────────────────────
;
; Draws a rectangle outline.
; Clipping is handled per-pixel by _Plot (called from _Line).
;
; Args:   d0.l = x,  d1.l = y  (top-left corner)
;         d2.l = w,  d3.l = h  (width, height in pixels)
; Trashes: nothing (saves/restores d0-d7/a0-a2)

        XDEF    _Rect
_Rect:
        movem.l d0-d7/a0-a2,-(sp)

        ; ── Pre-compute corners ───────────────────────────────────────────────
        move.l  d0,a0                   ; a0 = x
        move.l  d1,a1                   ; a1 = y

        move.l  d0,a2
        add.l   d2,a2
        subq.l  #1,a2                   ; a2 = x2 = x+w-1

        move.l  d1,d7
        add.l   d3,d7
        subq.l  #1,d7                   ; d7 = y2 = y+h-1

        ; ── Top: Line(x, y, x2, y) ───────────────────────────────────────────
        move.l  a0,d0
        move.l  a1,d1
        move.l  a2,d2
        move.l  a1,d3                   ; y2 = y  (horizontal)
        jsr     _Line

        ; ── Bottom: Line(x, y2, x2, y2) ──────────────────────────────────────
        move.l  a0,d0
        move.l  d7,d1                   ; y1 = y2
        move.l  a2,d2
        move.l  d7,d3                   ; y2 = y2
        jsr     _Line

        ; ── Left: Line(x, y, x, y2) ──────────────────────────────────────────
        move.l  a0,d0
        move.l  a1,d1
        move.l  a0,d2                   ; x2 = x  (vertical)
        move.l  d7,d3
        jsr     _Line

        ; ── Right: Line(x2, y, x2, y2) ───────────────────────────────────────
        move.l  a2,d0                   ; x1 = x2
        move.l  a1,d1
        move.l  a2,d2                   ; x2 = x2
        move.l  d7,d3
        jsr     _Line

        movem.l (sp)+,d0-d7/a0-a2
        rts
