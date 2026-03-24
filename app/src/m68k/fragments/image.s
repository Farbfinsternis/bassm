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
;   The codegen prepends an 8-byte header (dc.w) before the INCBIN:
;
;     +0  dc.w  width     ; pixels
;     +2  dc.w  height    ; scanlines
;     +4  dc.w  GFXDEPTH ; bitplanes (equals the Graphics depth)
;     +6  dc.w  rowbytes  ; bytes per row, word-aligned = ((width+15)/16)*2
;
;   The .raw file itself (from the Asset Manager) contains:
;     [0 .. (2^depth)*2-1]  OCS palette words (2 bytes each, big-endian $0RGB)
;     [(2^depth)*2 ..]      planar bitplane data:
;                             plane 0 rows, then plane 1 rows, …, plane depth-1 rows
;
;   _SetImagePalette reads the palette block and writes it to _gfx_palette +
;   hardware COLOR registers.  _DrawImage skips the palette block and blits
;   the bitplane data.
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
;   $FFFF (full words) and BLTCON1 shift is 0, so x must be WORD-aligned
;   (x % 16 == 0).  The OCS blitter clears bit 0 of BLTDPT (forces word
;   alignment), so byte-aligned-but-not-word-aligned x values (x%16==8) would
;   draw at (x & -16) — shifted 8px left — causing erase-position mismatch.
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
;   Full bounds check: silently discarded if any edge is outside screen.
;   Partial clipping (drawing only the visible portion) is not implemented;
;   images that straddle the screen border are skipped entirely.
;
; DEPENDENCY
;   startup.s — defines all Blitter register EQUs, _WaitBlit, a5 = CUSTOM.
;   codegen.js — defines GFXBPR, GFXPSIZE, GFXDEPTH.
;   _back_planes_ptr defined by startup.s (BSS).
;
; CODEGEN CONTRACT
;   Eval y → d0 → push; eval x → d0; pop y → d1; lea _img_N,a0; jsr _DrawImage
;   For animated images (frame ≠ 0): set d2=frame, then jsr _DrawImageFrame
;
;   On entry (_DrawImage):      d0.l=x, d1.l=y, a0=imgptr  (frame 0)
;   On entry (_DrawImageFrame): d0.l=x, d1.l=y, a0=imgptr, d2.l=frame
;
;   NOTE: frame_size = depth × height × rowbytes must be < 65536 bytes.
;   This holds for all practical animated sprites (e.g. 64×64×5 = 2560 bytes).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION image_code,CODE


; ── _DrawImage / _DrawImageFrame ─────────────────────────────────────────────
;
; Blits one frame of a planar image to the current back buffer (Blitter A→D).
;
; _DrawImage      — draws frame 0, backward-compatible (ignores d2)
; _DrawImageFrame — draws frame d2 (0 = first frame, same result as _DrawImage)
;
; Args:   d0.l = x  (pixel position, must be WORD-aligned: x%16 == 0)
;         d1.l = y
;         a0   = pointer to image data (8-byte header + palette + bitplane data)
;         d2.l = frame index  (_DrawImageFrame only; _DrawImage sets d2=0)
; Trashes: nothing (saves/restores d0-d7/a0-a3)

        XDEF    _DrawImage
        XDEF    _DrawImageFrame

_DrawImage:
        clr.l   d2                  ; frame 0 — fall through to _DrawImageFrame

_DrawImageFrame:
        movem.l d0-d7/a0-a3,-(sp)

        ; ── Read 8-byte header ────────────────────────────────────────────────
        ;   d3 = width  (scratch — will be reused for frame-offset computation)
        ;   d4 = height
        ;   d5 = depth
        ;   d6 = rowbytes
        move.w  (a0)+,d3            ; d3.w = width  (scratch; overwritten below)
        move.w  (a0)+,d4            ; d4.w = height
        move.w  (a0)+,d5            ; d5.w = depth  ($8000 flag set for .iraw interleaved format)
        move.w  (a0)+,d6            ; d6.w = rowbytes
        btst    #15,d5              ; test interleaved flag (bit 15 = .iraw)
        bne.w   .draw_interleaved   ; → 1-blit path for interleaved source data
        ; a0 now points to the embedded palette block — skip it (non-interleaved path).
        moveq   #1,d7
        lsl.l   d5,d7               ; d7 = 1 << depth
        add.l   d7,d7               ; d7 = palette bytes
        add.l   d7,a0               ; a0 = bitplane-0 data start (frame 0)

        ; ── Plane size = height × rowbytes ────────────────────────────────────
        move.w  d4,d7
        mulu.w  d6,d7               ; d7.l = plane_size

        ; ── Bounds check — skip if any edge is outside the overscan buffer ──────
        ; d3 (pixel width from header) is still valid here — the frame-offset
        ; section BELOW reuses d3 as scratch.  Check must come first.
        ; a1 is free at this point; use it as scratch for x+width / y+height.
        cmp.l   #-GFXBORDER,d0
        blt.w   .draw_done          ; x < -GFXBORDER
        cmp.l   #-GFXBORDER,d1
        blt.w   .draw_done          ; y < -GFXBORDER
        move.l  d0,a1
        add.w   d3,a1               ; a1 = x + pixel_width
        cmpa.l  #(GFXWIDTH+GFXBORDER),a1
        bgt.w   .draw_done          ; x + width > GFXWIDTH+GFXBORDER
        move.l  d1,a1
        add.w   d4,a1               ; a1 = y + height
        cmpa.l  #(GFXHEIGHT+GFXBORDER),a1
        bgt.w   .draw_done          ; y + height > GFXHEIGHT+GFXBORDER

        ; ── Frame offset = d2 × depth × plane_size ───────────────────────────
        ; Uses d3 (width no longer needed after bounds check above) as scratch.
        ; frame_size = depth × plane_size  (must fit in 16 bits — see note above)
        move.w  d5,d3               ; d3.w = depth
        mulu.w  d7,d3               ; d3.l = depth × plane_size = frame_size_bytes
        mulu.w  d2,d3               ; d3.l = frame × frame_size_bytes = frame_offset
        add.l   d3,a0               ; a0 = bitplane-0 data start for frame d2

        ; ── BLTSIZE = (height << 6) | (rowbytes >> 1) ────────────────────────
        move.w  d4,d2
        lsl.w   #6,d2               ; d2 = height << 6
        move.w  d6,d3
        lsr.w   #1,d3               ; d3 = rowbytes / 2
        or.w    d3,d2               ; d2.w = BLTSIZE

        ; ── Destination pointer: _back_planes_ptr + y*GFXBPR + x/8 ───────────
        move.l  _back_planes_ptr,a2
        muls.w  #GFXIBPR,d1         ; d1 = y × GFXIBPR (interleaved row stride)
        add.l   d1,a2
        asr.l   #3,d0               ; d0 = x / 8  (signed: handles negative x)
        add.l   d0,a2               ; a2 = dest in plane-0 at (x,y)

        ; ── BLTDMOD = GFXIBPR - rowbytes (interleaved: skip other planes' rows) ─
        move.w  #GFXIBPR,d3
        sub.w   d6,d3               ; d3.w = BLTDMOD

        ; ── Plane loop ────────────────────────────────────────────────────────
        subq.w  #1,d5               ; depth - 1 for dbra
.plane_loop:
        jsr     _WaitBlit

        move.w  #$09F0,BLTCON0(a5)  ; USEA | USED | minterm $F0 (D = A)
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        clr.w   BLTAMOD(a5)
        move.w  d3,BLTDMOD(a5)

        move.l  a0,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        move.l  a2,d0
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)

        add.l   d7,a0               ; advance: next source plane (non-interleaved image)
        add.l   #GFXBPR,a2         ; advance: next screen plane (interleaved)

        dbra    d5,.plane_loop

; ── _DrawImageFrame — interleaved 1-blit path (.iraw) ────────────────────────
;
; Entered when bit 15 of the header depth word is set (source is a .iraw file).
; All depth × height plane-rows are packed in interleaved order, so a single
; Blitter A→D operation copies all planes at once:
;
;   BLTSIZE  = (height × depth) << 6 | (rowbytes / 2)
;   BLTAMOD  = 0                 (source rows packed, no gap between planes)
;   BLTDMOD  = GFXBPR - rowbytes (advance to next plane-row in interleaved screen)
;
; Constraint: height × depth must be ≤ 1023 (BLTSIZE height field is 10 bits).
; At depth=5 this allows sprites up to ~200px tall — sufficient for all sprites.

.draw_interleaved:
        and.w   #$7FFF,d5           ; clear interleaved flag — d5 = actual depth

        ; Skip palette: (1 << depth) * 2 bytes
        moveq   #1,d7
        lsl.l   d5,d7               ; d7 = 1 << depth
        add.l   d7,d7               ; d7 = palette bytes
        add.l   d7,a0               ; a0 = interleaved plane data start (frame 0)

        ; Plane size for frame offset = height × rowbytes
        move.w  d4,d7
        mulu.w  d6,d7               ; d7.l = plane_size

        ; Bounds check (same conditions as non-interleaved path)
        cmp.l   #-GFXBORDER,d0
        blt.w   .draw_done
        cmp.l   #-GFXBORDER,d1
        blt.w   .draw_done
        move.l  d0,a1
        add.w   d3,a1               ; a1 = x + pixel_width
        cmpa.l  #(GFXWIDTH+GFXBORDER),a1
        bgt.w   .draw_done
        move.l  d1,a1
        add.w   d4,a1               ; a1 = y + height
        cmpa.l  #(GFXHEIGHT+GFXBORDER),a1
        bgt.w   .draw_done

        ; Frame offset = frame × depth × plane_size (same formula as non-interleaved)
        move.w  d5,d3               ; d3 = depth
        mulu.w  d7,d3               ; d3 = depth × plane_size = frame_size
        mulu.w  d2,d3               ; d3 = frame × frame_size = frame_offset
        add.l   d3,a0               ; a0 = frame N data start

        ; BLTSIZE = (height × depth) << 6 | (rowbytes / 2)
        move.w  d4,d2
        mulu.w  d5,d2               ; d2.l = height × depth
        lsl.w   #6,d2               ; d2 = (height × depth) << 6
        move.w  d6,d3
        lsr.w   #1,d3               ; d3 = rowbytes / 2
        or.w    d3,d2               ; d2.w = BLTSIZE

        ; BLTDMOD = GFXBPR - rowbytes
        ; After writing rowbytes bytes the pointer advances to the next plane-row
        ; in the interleaved screen (distance between adjacent plane-rows = GFXBPR).
        move.w  #GFXBPR,d3
        sub.w   d6,d3               ; d3.w = BLTDMOD

        ; Destination = _back_planes_ptr + y*GFXIBPR + x/8  (plane-0 of row y)
        move.l  _back_planes_ptr,a2
        muls.w  #GFXIBPR,d1         ; d1 = y × GFXIBPR
        add.l   d1,a2
        asr.l   #3,d0               ; d0 = x / 8
        add.l   d0,a2               ; a2 = screen plane-0 at (x, y)

        ; 1 single blit — copies all depth planes simultaneously
        jsr     _WaitBlit

        move.w  #$09F0,BLTCON0(a5)  ; USEA | USED, minterm $F0: D = A
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        clr.w   BLTAMOD(a5)         ; source packed: no gap between plane-rows
        move.w  d3,BLTDMOD(a5)      ; GFXBPR - rowbytes

        move.l  a0,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        move.l  a2,d0
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)      ; triggers the blit (all planes in one pass)

.draw_done:
        movem.l (sp)+,d0-d7/a0-a3
        rts


; ── _SetImagePalette ──────────────────────────────────────────────────────────
;
; Reads the OCS palette embedded in an image (immediately after the 8-byte
; header, before the bitplane data) and writes all entries to both _gfx_palette
; and the hardware COLOR00-COLOR(n) registers.
;
; Call this once per program to initialise the display palette from image 0.
; Codegen emits this automatically for every "LoadImage 0" statement.
;
; Args:   a0 = pointer to image data (8-byte header + palette + bitplane data)
; Trashes: nothing (saves/restores d0-d1/a0-a2)

        XDEF    _SetImagePalette
_SetImagePalette:
        movem.l d0-d1/a0-a2,-(sp)

        addq.l  #4,a0               ; skip width + height (2 words)
        move.w  (a0)+,d0            ; d0.w = depth
        addq.l  #2,a0               ; skip rowbytes
        ; a0 = start of palette data (offset 8 from image label)

        moveq   #1,d1
        lsl.l   d0,d1               ; d1 = 1 << depth  (number of colour entries)
        subq.l  #1,d1               ; d1 - 1 for dbra

        lea     _gfx_palette,a1     ; destination: palette RAM (chip)
        lea     COLOR00(a5),a2      ; destination: hardware COLOR registers

.sip_loop:
        move.w  (a0)+,d0            ; read one OCS colour word
        move.w  d0,(a1)+            ; write → _gfx_palette
        move.w  d0,(a2)+            ; write → hardware COLOR register
        dbra    d1,.sip_loop

        movem.l (sp)+,d0-d1/a0-a2
        rts
