; ============================================================================
; rect.s — BASSM Rectangle Outline (Blitter-accelerated)
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
; HOW IT WORKS (Blitter A→D, via _Box)
;   Four Blitter fill operations — one per edge:
;     Top    : _Box(x,     y,     w,   1  )
;     Bottom : _Box(x,     y+h-1, w,   1  )   (skipped if h <= 1)
;     Left   : _Box(x,     y+1,   1,   h-2)   (skipped if h <= 2)
;     Right  : _Box(x+w-1, y+1,   1,   h-2)   (skipped if h <= 2)
;
;   _Box saves/restores d0-d7/a0-a2, so working registers survive each call.
;   Because _Box preserves all caller-visible registers, values stored in
;   a0 (x), a1 (y), a2 (w), d7 (h) remain valid across all four jsr _Box calls.
;
; REGISTER MAP (inside _Rect, between _Box calls)
;   a0 = x          (preserved across jsr _Box — _Box saves/restores a0)
;   a1 = y          (preserved across jsr _Box — _Box saves/restores a1)
;   a2 = w          (preserved across jsr _Box — _Box saves/restores a2)
;   d7 = h          (preserved across jsr _Box — _Box saves/restores d7)
;   d3 = h-2        (set once before side-edge calls; preserved by _Box)
;
; EDGE CASES
;   h = 1: only top edge drawn.
;   h = 2: top and bottom edges drawn; no side edges (h-2 = 0 → skipped).
;   w = 1: top/bottom are 1×1 pixels; sides coincide → single-column outline.
;
; DEPENDENCY
;   box.s must be included before this fragment (defines _Box).
;   _Box draws into _back_planes_ptr (set by double-buffering init).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used directly here)
; ============================================================================


        SECTION rect_code,CODE


; ── _Rect ─────────────────────────────────────────────────────────────────────
;
; Draws a rectangle outline using four Blitter fill operations.
;
; Args:   d0.l = x,  d1.l = y  (top-left corner)
;         d2.l = w,  d3.l = h  (width, height in pixels)
; Trashes: nothing (saves/restores d0-d7/a0-a2)

        XDEF    _Rect
_Rect:
        movem.l d0-d7/a0-a2,-(sp)

        ; ── Stash parameters in preserved registers ───────────────────────────
        move.l  d0,a0                   ; a0 = x
        move.l  d1,a1                   ; a1 = y
        move.l  d2,a2                   ; a2 = w
        move.l  d3,d7                   ; d7 = h

        ; ── Top edge: Box(x, y, w, 1) ────────────────────────────────────────
        move.l  a0,d0                   ; d0 = x
        move.l  a1,d1                   ; d1 = y
        move.l  a2,d2                   ; d2 = w
        moveq   #1,d3                   ; d3 = height 1
        jsr     _Box                    ; _Box saves/restores d0-d7/a0-a2

        ; ── Bottom edge: Box(x, y+h-1, w, 1) — only if h > 1 ────────────────
        cmp.l   #1,d7
        ble.s   .rect_done

        move.l  a0,d0                   ; d0 = x
        move.l  a1,d1                   ; d1 = y
        add.l   d7,d1
        subq.l  #1,d1                   ; d1 = y + h - 1
        move.l  a2,d2                   ; d2 = w
        moveq   #1,d3                   ; d3 = height 1
        jsr     _Box

        ; ── Side edges — only if h > 2 (side height = h-2 >= 1) ──────────────
        cmp.l   #2,d7
        ble.s   .rect_done

        move.l  d7,d3
        subq.l  #2,d3                   ; d3 = h-2 (side height, valid for both calls)

        ; ── Left edge: Box(x, y+1, 1, h-2) ──────────────────────────────────
        move.l  a0,d0                   ; d0 = x
        move.l  a1,d1
        addq.l  #1,d1                   ; d1 = y+1
        moveq   #1,d2                   ; d2 = width 1
        jsr     _Box                    ; d3 = h-2 preserved by _Box

        ; ── Right edge: Box(x+w-1, y+1, 1, h-2) ─────────────────────────────
        move.l  a0,d0
        add.l   a2,d0
        subq.l  #1,d0                   ; d0 = x+w-1
        move.l  a1,d1
        addq.l  #1,d1                   ; d1 = y+1
        moveq   #1,d2                   ; d2 = width 1
        ; d3 = h-2 (preserved by the previous jsr _Box)
        jsr     _Box

.rect_done:
        movem.l (sp)+,d0-d7/a0-a2
        rts
