; ============================================================================
; image.s — BASSM Blitter Image Drawing
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "DrawImage" command:
;
;     _DrawImage — blit a pre-converted planar image to the current back buffer
;
; BLITZ2D SYNTAX
;   LoadImage index, "file.raw", width, height
;   DrawImage index, x, y
;
;   Example:
;     LoadImage 0, "gfx/player.raw", 16, 16
;     DrawImage 0, px, py
;
; IMAGE FILE FORMAT
;   Raw binary — only planar bitplane data, NO embedded header.
;   The codegen prepends an 8-byte header (dc.w) before the INCBIN:
;
;     +0  dc.w  width     ; pixels
;     +2  dc.w  height    ; scanlines
;     +4  dc.w  GFXDEPTH ; bitplanes (equals the Graphics depth)
;     +6  dc.w  rowbytes  ; bytes per row, word-aligned = ((width+15)/16)*2
;     +8  data  ...       ; depth × height × rowbytes bytes, planar layout:
;                         ;   plane 0 rows, then plane 1 rows, …, plane N-1 rows
;
;   Planar layout (plane 0 first):
;     byte 0..(height*rowbytes-1)             ← plane 0
;     byte (height*rowbytes)..(2*…-1)         ← plane 1
;     …
;
;   Pixel bit order within each byte matches OCS hardware:
;     bit 7 = leftmost pixel, bit 0 = rightmost.
;
; HOW IT WORKS
;   _DrawImage reads the 4-word header, then runs one Blitter A→D operation per
;   bitplane.  Minterm $F0 (D = A) copies the source bits directly to the
;   destination, overwriting whatever was there.  First/last word masks are
;   $FFFF (full words), so x must be byte-aligned (x % 8 == 0).
;
;   Blitter per plane:
;     BLTCON0  = $09F0  (USEA | USED | minterm $F0: D = A)
;     BLTCON1  = $0000
;     BLTAFWM  = $FFFF  (no first-word masking)
;     BLTALWM  = $FFFF  (no last-word masking)
;     BLTAPT   = current source plane pointer
;     BLTDPT   = back buffer + plane_offset + y*GFXBPR + x/8
;     BLTAMOD  = 0      (source rows are packed, no gap)
;     BLTDMOD  = GFXBPR - rowbytes  (skip to same x-position in next dest row)
;     BLTSIZE  = (height << 6) | (rowbytes / 2)
;
; CLIPPING
;   Not implemented.  x and y must be within screen bounds, and
;   (x + width) must not exceed GFXWIDTH.
;
; DEPENDENCY
;   startup.s — defines all Blitter register EQUs, _WaitBlit, a5 = CUSTOM.
;   codegen.js — defines GFXBPR, GFXPSIZE, GFXDEPTH.
;   _back_planes_ptr defined by startup.s (BSS).
;
; CODEGEN CONTRACT
;   Eval y → d0 → push; eval x → d0; pop y → d1; lea _img_N,a0; jsr _DrawImage
;
;   On entry:   d0.l = x  (pixel x, must be byte-aligned: x%8 == 0)
;               d1.l = y  (pixel y)
;               a0   = pointer to image data (header + bitplane data)
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION image_code,CODE


; ── _DrawImage ────────────────────────────────────────────────────────────────
;
; Blits a planar image to the current back buffer using the Blitter (A→D copy).
;
; Args:   d0.l = x  (pixel position, must be byte-aligned)
;         d1.l = y
;         a0   = pointer to image data (8-byte header + bitplane data)
; Trashes: nothing (saves/restores d0-d7/a0-a3)

        XDEF    _DrawImage
_DrawImage:
        movem.l d0-d7/a0-a3,-(sp)

        ; ── Read header ───────────────────────────────────────────────────────
        ;   d3 = width  (pixels — not needed for blitter, skip)
        ;   d4 = height
        ;   d5 = depth
        ;   d6 = rowbytes
        move.w  (a0)+,d3            ; width (unused after this)
        move.w  (a0)+,d4            ; height
        move.w  (a0)+,d5            ; depth
        move.w  (a0)+,d6            ; rowbytes
        ; a0 now points to the first plane's data

        ; ── Source plane size = height * rowbytes ─────────────────────────────
        move.w  d4,d7
        mulu.w  d6,d7               ; d7.l = plane_size (fits 32-bit for h<1024, rb<64)

        ; ── BLTSIZE = (height << 6) | (rowbytes >> 1) ────────────────────────
        move.w  d4,d2
        lsl.w   #6,d2               ; d2 = height << 6
        move.w  d6,d3
        lsr.w   #1,d3               ; d3 = rowbytes / 2  (words per row)
        or.w    d3,d2               ; d2.w = BLTSIZE

        ; ── Destination pointer: _back_planes_ptr + y*GFXBPR + x/8 ───────────
        move.l  _back_planes_ptr,a2 ; a2 = back buffer base (plane 0)
        mulu.w  #GFXBPR,d1          ; d1 = y * GFXBPR  (≤ 255*40 = 10200, fits 32-bit)
        add.l   d1,a2               ; a2 += y * GFXBPR
        lsr.l   #3,d0               ; d0 = x / 8 (byte offset)
        add.l   d0,a2               ; a2 = dest in plane 0 at (x,y)

        ; ── BLTDMOD = GFXBPR - rowbytes ──────────────────────────────────────
        move.w  #GFXBPR,d3
        sub.w   d6,d3               ; d3.w = BLTDMOD

        ; ── Plane loop (depth planes) ─────────────────────────────────────────
        subq.w  #1,d5               ; depth - 1 for dbra
.plane_loop:
        jsr     _WaitBlit

        ; BLTCON0 = $09F0: USEA | USED | minterm $F0 (D = A — simple copy)
        move.w  #$09F0,BLTCON0(a5)
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        clr.w   BLTAMOD(a5)         ; source rows are packed — no gap
        move.w  d3,BLTDMOD(a5)      ; destination modulo

        ; A source pointer (write high word first, then low)
        move.l  a0,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; D destination pointer
        move.l  a2,d0
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        ; BLTSIZE write starts the blit
        move.w  d2,BLTSIZE(a5)

        ; Advance to next plane
        add.l   d7,a0               ; source: next plane data
        add.l   #GFXPSIZE,a2        ; destination: next screen plane

        dbra    d5,.plane_loop

        movem.l (sp)+,d0-d7/a0-a3
        rts
