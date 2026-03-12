; ============================================================================
; box.s — BASSM Filled Rectangle (Blitter A→D)
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Box" command:
;
;     _Box  — fill a solid axis-aligned rectangle with the current Color
;
; BLITZ2D SYNTAX
;   Box x, y, w, h
;   Example: Box 10, 20, 100, 80
;
; HOW IT WORKS
;   For each bitplane, one Blitter operation fills the rectangle:
;
;   Blitter A→D mode — source is a constant chip-RAM pattern row, dest is the
;   bitplane region from (x,y) to (x+w-1, y+h-1).
;
;   Blitter register values per plane:
;
;     A = _blt_ones_row (mask: 1 inside box after BLTAFWM/BLTALWM, 0 outside)
;     C = D (the destination bitplane — read first, then written)
;
;     Ones-fill (colour bit = 1):
;       BLTCON0 = $0BFA  (USEA+USEC+USED, minterm $FA = D = A OR C)
;         inside box (A=1): D = 1  (set)
;         outside box (A=0): D = C (preserve — no corruption of adjacent pixels)
;
;     Zeros-fill (colour bit = 0):
;       BLTCON0 = $0B0A  (USEA+USEC+USED, minterm $0A = D = !A AND C)
;         inside box (A=1): D = 0  (clear)
;         outside box (A=0): D = C (preserve — no corruption of adjacent pixels)
;
;     Note: USEB=0 does NOT force B=1. BLTBDAT is uninitialized (hardware-
;     dependent: $FFFF from AROS, $0000 after cold boot on KS 1.3).
;     Minterms $FA and $0A give the correct result for ANY value of B.
;
;     BLTCON1 = $0000
;     BLTAFWM = $FFFF >> (x % 16)                     left-edge mask
;     BLTALWM = $FFFF XOR ($FFFF >> ((x+w-1)%16 + 1)) right-edge mask
;     BLTAPT  → _blt_ones_row  (always — serves as the box-region mask)
;     BLTAMOD = -(word_count × 2)  A-pointer resets to row start each line
;     BLTCPT  = BLTDPT  (C reads the same bitplane data as D will write)
;     BLTCMOD = BLTDMOD
;     BLTDPT  → &plane[y × GFXBPR + (x/16) × 2]      first dest word
;     BLTDMOD = GFXBPR − word_count × 2               bytes to skip per row
;     BLTSIZE = (h << 6) | word_count                  triggers blit
;
;   word_count = (x%16 + w + 15) / 16   (ceiling: number of words per dest row)
;
; PIXEL BIT ORDER (OCS)
;   In each 16-bit word, bit 15 = leftmost pixel, bit 0 = rightmost.
;   BLTAFWM zeros bits to the LEFT of the box's first pixel in the first word.
;   BLTALWM zeros bits to the RIGHT of the box's last pixel in the last word.
;
; MASK FORMULAS
;   left_shift  = x % 16
;   BLTAFWM     = $FFFF >> left_shift
;
;   r           = (x+w-1) % 16         right-edge pixel offset within its word
;   BLTALWM     = $FFFF XOR ($FFFF >> (r+1))
;
;   Corner case: if word_count=1 the Blitter applies both masks to the same
;   word — the effective mask is BLTAFWM AND BLTALWM, which is correct.
;
; CLIPPING
;   Not implemented: the Box origin and size must be within the screen.
;   Boxes that extend beyond the right edge produce undefined results.
;
; DEPENDENCY
;   cls.s must be included first (defines _blt_ones_row).
;   startup.s defines _WaitBlit and all Blitter register EQUs.
;   palette.s defines _draw_color (ds.w 1).
;   codegen.js defines GFXDEPTH, GFXPSIZE, GFXBPR.
;   _gfx_planes is defined by the generated code (BSS_C bitplane buffer).
;
; CODEGEN CONTRACT
;   Codegen pushes h, w, y on the stack, evaluates x into d0, then:
;         movem.l (sp)+,d1-d3     ; pop y→d1, w→d2, h→d3
;         jsr     _Box            ; d0=x, d1=y, d2=w, d3=h
;
; REGISTER MAP (after prologue — x,y,w free; h,color,counter kept)
;   d0-d2  free scratch (x,y,w no longer needed after dest-ptr computed)
;   d3     h            (needed for BLTSIZE)
;   d4     draw colour  (shifted right each plane; zero-extended on load)
;   d5     plane counter (GFXDEPTH-1 downto 0 via dbra)
;   d6     BLTAFWM      (computed once from x in prologue)
;   d7     BLTALWM      (computed once from x,w in prologue)
;   a0     destination plane base ptr (advances by GFXPSIZE each plane)
;   a1     A source ptr (_blt_ones_row or _blt_zero_row, set each iteration)
;   a2     word_count   (computed once from x,w in prologue; kept as address reg)
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION box_code,CODE


; ── _Box ──────────────────────────────────────────────────────────────────────
;
; Fills a solid rectangle using the Blitter.
; One Blitter operation per bitplane.
;
; Args:   d0.l = x,  d1.l = y  (top-left pixel, inclusive)
;         d2.l = w,  d3.l = h  (width, height in pixels)
; Trashes: nothing (saves/restores d0-d7/a0-a2)

        XDEF    _Box
_Box:
        movem.l d0-d7/a0-a2,-(sp)

        ; ════════════════════════════════════════════════════════════════════
        ;  SAFETY CLIPPING (Prevent Pixel-Müll & Crashes)
        ; ════════════════════════════════════════════════════════════════════
        tst.l   d0
        blt.w   .box_done               ; x < 0 -> Abbruch
        tst.l   d1
        blt.w   .box_done               ; y < 0 -> Abbruch
        cmp.l   #GFXWIDTH,d0
        bge.w   .box_done               ; x >= 320 -> Abbruch
        cmp.l   #GFXHEIGHT,d1
        bge.w   .box_done               ; y >= 256 -> Abbruch

        move.l  d0,d4
        add.l   d2,d4                   ; d4 = x + w
        cmp.l   #GFXWIDTH,d4
        ble.s   .no_clip_x
        move.l  #GFXWIDTH,d2
        sub.l   d0,d2                   ; w = 320 - x
.no_clip_x:

        move.l  d1,d4
        add.l   d3,d4                   ; d4 = y + h
        cmp.l   #GFXHEIGHT,d4
        ble.s   .no_clip_y
        move.l  #GFXHEIGHT,d3
        sub.l   d1,d3                   ; h = 256 - y
.no_clip_y:
        tst.l   d2
        ble.w   .box_done               ; Breite <= 0? -> Abbruch
        tst.l   d3
        ble.w   .box_done               ; Höhe <= 0? -> Abbruch

        ; ════════════════════════════════════════════════════════════════════
        ;  PROLOGUE — compute everything we need once, before the plane loop.
        ;  After the prologue, d0, d1, d2 (x, y, w) are free scratch.
        ; ════════════════════════════════════════════════════════════════════

        ; ── BLTAFWM: left-edge mask = $FFFF >> (x % 16) ─────────────────────
        ;
        ; Pixels in a word run MSB→LSB (bit 15 = leftmost).
        ; If x is word-aligned (x%16=0): no leading bits to mask → $FFFF.
        ; If x%16=4: the first 4 bits (15-12) belong to the column before
        ; our box → mask them out with $0FFF = $FFFF >> 4.
        ;
        move.l  d0,d4
        andi.l  #15,d4                  ; d4 = x % 16  (left-edge pixel offset)
        move.w  #$FFFF,d6
        lsr.w   d4,d6                   ; d6 = BLTAFWM = $FFFF >> (x%16)

        ; ── BLTALWM: right-edge mask ─────────────────────────────────────────
        ;
        ; r = (x+w-1) % 16  (right-edge pixel offset within the last word)
        ; BLTALWM = $FFFF XOR ($FFFF >> (r+1))
        ;         = keeps bits 15 down to (15-r) = covers right-edge pixel
        ;
        ; When r=15 (last pixel is at bit 0): r+1=16, LSR.W by 16 → 0,
        ;   EOR → $FFFF (all bits active). Correct: entire last word is inside.
        ;
        move.l  d0,d5
        add.l   d2,d5
        subq.l  #1,d5                   ; d5 = x+w-1
        andi.l  #15,d5                  ; d5 = r = (x+w-1) % 16
        addq.l  #1,d5                   ; d5 = r+1
        move.w  #$FFFF,d7
        lsr.w   d5,d7                   ; d7 = $FFFF >> (r+1)
        eor.w   #$FFFF,d7              ; d7 = BLTALWM

        ; ── word_count = (x%16 + w + 15) / 16 ───────────────────────────────
        ;
        ; The number of 16-bit destination words per row that the blit touches.
        ; Uses d4 (x%16) computed above.
        ;
        move.l  d4,d5                   ; d5 = x%16
        add.l   d2,d5                   ; d5 = x%16 + w
        add.l   #15,d5
        lsr.l   #4,d5                   ; d5 = word_count = ceil((x%16+w)/16)
        move.l  d5,a2                   ; save word_count in address register

        ; ── Destination plane base pointer ───────────────────────────────────
        ;
        ; First destination word for plane 0:
        ;   _gfx_planes + y*GFXBPR + (x/16)*2
        ;
        move.l  _back_planes_ptr,a0     ; a0 = back buffer base (double-buffering)
        move.l  d1,d5                   ; d5 = y
        lsl.l   #3,d5                   ; d5 = y * 8
        move.l  d5,d1                   ; d1 = y * 8 (use d1 as temp, d0 is x!)
        lsl.l   #2,d5                   ; d5 = y * 32
        add.l   d1,d5                   ; d5 = y * 40 (GFXBPR)
        add.l   d5,a0                   ; a0 += y*GFXBPR
        move.l  d0,d5                   ; d5 = x
        lsr.l   #4,d5                   ; d5 = x/16 (word index of first column)
        add.l   d5,d5                   ; d5 = (x/16)*2 (byte offset)
        add.l   d5,a0                   ; a0 = _gfx_planes + y*GFXBPR + (x/16)*2

        ; ── Precompute Blitter constants ─────────────────────────────────────
        move.l  a2,d0                   ; d0 = word_count
        add.l   d0,d0                   ; d0 = word_count * 2
        move.l  d0,d1                   ; d1 = word_count * 2
        neg.w   d1                      ; d1 = BLTAMOD
        
        move.w  #GFXBPR,d2
        sub.w   d0,d2                   ; d2 = BLTDMOD

        move.l  d3,d0                   ; d0 = h
        lsl.w   #6,d0                   ; d0 = h << 6
        add.l   a2,d0                   ; d0 = BLTSIZE (Legal: ADD.L An, Dn)
        move.l  d0,a2                   ; Store final BLTSIZE in a2 for the loop
        move.w  d1,d3                   ; Store BLTAMOD in d3.w

        ; ── Load draw colour ─────────────────────────────────────────────────
        ;
        ; _draw_color is ds.w 1 (palette index 0-31).
        ; moveq zeros d4 first so move.w zero-extends cleanly into d4.l.
        ;
        moveq   #0,d4
        move.w  _draw_color,d4          ; d4 = palette index (bits → per-plane pattern)

        ; ── Initial Blitter Setup (constant for all planes) ──────────────────
        ; BLTCON0 is set per-plane (ones vs zeros fill use different minterms).
        ; BLTCMOD = BLTDMOD because C tracks D through the destination bitplane.
        jsr     _WaitBlit
        clr.w   BLTCON1(a5)
        move.w  d6,BLTAFWM(a5)
        move.w  d7,BLTALWM(a5)
        move.w  d3,BLTAMOD(a5)          ; BLTAMOD (A-pointer rewinds each row)
        move.w  d2,BLTDMOD(a5)          ; BLTDMOD
        move.w  d2,BLTCMOD(a5)          ; BLTCMOD = BLTDMOD (C tracks D)

        ; ════════════════════════════════════════════════════════════════════
        ;  PLANE LOOP — one Blitter operation per bitplane
        ; ════════════════════════════════════════════════════════════════════

        moveq   #GFXDEPTH-1,d5         ; d5 = plane loop counter

.box_plane:
        ; ── Wait for previous blit ───────────────────────────────────────────
        jsr     _WaitBlit               ; trashes d0

        ; ── A is always _blt_ones_row — it acts as the box-region mask ────────
        ; BLTAFWM/BLTALWM trim A to 1 inside the box boundary, 0 outside.
        ; C reads the current destination data so pixels outside the box are
        ; preserved (not overwritten) regardless of fill direction.
        ;
        ; Minterms $FA and $0A are B-independent (correct for any BLTBDAT value):
        ;   Ones-fill  (colour bit = 1): minterm $FA = D = A OR C
        ;     A=0,C=0→D=0  A=0,C=1→D=1  A=1,C=0→D=1  A=1,C=1→D=1
        ;   Zeros-fill (colour bit = 0): minterm $0A = D = !A AND C
        ;     A=0,C=0→D=0  A=0,C=1→D=1  A=1,C=0→D=0  A=1,C=1→D=0
        lea     _blt_ones_row,a1

        ; ── Choose minterm based on colour bit ────────────────────────────────
        btst    #0,d4
        bne.s   .box_set_ones
        move.w  #$0B0A,BLTCON0(a5)      ; USEA+USEC+USED, minterm $0A (D=!A AND C)
        bra.s   .box_blit
.box_set_ones:
        move.w  #$0BFA,BLTCON0(a5)      ; USEA+USEC+USED, minterm $FA (D=A OR C)

.box_blit:
        ; ── Program Blitter ──────────────────────────────────────────────────

        ; A source pointer (high word first)
        move.l  a1,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; C source pointer = D destination pointer (same chip-RAM address).
        ; C and D point to the same bitplane so C reads what D will overwrite.
        move.l  a0,d0
        swap    d0
        move.w  d0,BLTCPTH(a5)
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTCPTL(a5)
        move.w  d0,BLTDPTL(a5)

        ; BLTSIZE write triggers the blit
        move.w  a2,BLTSIZE(a5)

        ; ── Advance to next plane ─────────────────────────────────────────────
        add.l   #GFXPSIZE,a0           ; next bitplane buffer
        lsr.l   #1,d4                   ; shift colour right: next bit → bit 0
        dbra    d5,.box_plane

        ; We NO LONGER wait for the last blit here. This allows the CPU to
        ; continue with BASIC logic while the Blitter finishes the last plane.
        ; _ScreenFlip or the next drawing command will call _WaitBlit.

.box_done:
        movem.l (sp)+,d0-d7/a0-a2
        rts
