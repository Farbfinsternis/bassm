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
;     BLTCON0 = $09F0  (USEA=1, USED=1, minterm $F0 = D→A)
;     BLTCON1 = $0000
;     BLTAFWM = $FFFF >> (x % 16)                     left-edge mask
;     BLTALWM = $FFFF XOR ($FFFF >> ((x+w-1)%16 + 1)) right-edge mask
;     BLTAPT  → _blt_ones_row  or  _blt_zero_row (per colour bit for this plane)
;     BLTAMOD = -(word_count × 2)  A-pointer resets to row start each line
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
;   cls.s must be included first (defines _blt_ones_row, _blt_zero_row).
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
        lea     _gfx_planes,a0          ; a0 = bitplane buffer base
        move.l  d1,d5                   ; d5 = y
        mulu.w  #GFXBPR,d5             ; d5 = y * GFXBPR  (fits in 32 bits for H≤256)
        add.l   d5,a0                   ; a0 += y*GFXBPR
        move.l  d0,d5                   ; d5 = x
        lsr.l   #4,d5                   ; d5 = x/16 (word index of first column)
        add.l   d5,d5                   ; d5 = (x/16)*2 (byte offset)
        add.l   d5,a0                   ; a0 = _gfx_planes + y*GFXBPR + (x/16)*2

        ; ── Load draw colour ─────────────────────────────────────────────────
        ;
        ; _draw_color is ds.w 1 (palette index 0-31).
        ; moveq zeros d4 first so move.w zero-extends cleanly into d4.l.
        ;
        moveq   #0,d4
        move.w  _draw_color,d4          ; d4 = palette index (bits → per-plane pattern)

        ; ════════════════════════════════════════════════════════════════════
        ;  PLANE LOOP — one Blitter operation per bitplane
        ; ════════════════════════════════════════════════════════════════════

        moveq   #GFXDEPTH-1,d5         ; d5 = plane loop counter

.box_plane:
        ; ── Wait for previous blit ───────────────────────────────────────────
        jsr     _WaitBlit               ; trashes d0

        ; ── Choose A-source based on colour bit for this plane ───────────────
        btst    #0,d4                   ; is this plane's colour bit set?
        beq.s   .box_use_zeros
        lea     _blt_ones_row,a1        ; yes → fill with $FFFF
        bra.s   .box_blit
.box_use_zeros:
        lea     _blt_zero_row,a1        ; no  → fill with $0000

.box_blit:
        ; ── Program Blitter ──────────────────────────────────────────────────
        move.w  #$09F0,BLTCON0(a5)     ; USEA=1, USED=1, minterm $F0 (D = A)
        clr.w   BLTCON1(a5)             ; no line mode, no fill mode
        move.w  d6,BLTAFWM(a5)         ; left-edge mask (computed in prologue)
        move.w  d7,BLTALWM(a5)         ; right-edge mask

        ; BLTAMOD = -(word_count × 2)
        ; After reading word_count words (= word_count×2 bytes) per row,
        ; the A pointer goes back word_count×2 bytes → net advance = 0.
        ; _blt_ones_row and _blt_zero_row are GFXBPR bytes wide, so re-reading
        ; from the start is always valid.
        move.l  a2,d0                   ; d0 = word_count
        add.l   a2,d0                   ; d0 = word_count × 2
        neg.l   d0                      ; d0 = -(word_count × 2) = BLTAMOD
        move.w  d0,BLTAMOD(a5)

        ; BLTDMOD = GFXBPR − word_count×2
        ; Bytes to skip at end of each destination row (= unused bytes in row).
        add.l   #GFXBPR,d0             ; d0 = GFXBPR - word_count×2 = BLTDMOD
        move.w  d0,BLTDMOD(a5)

        ; A source pointer (high word first)
        move.l  a1,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; D destination pointer
        move.l  a0,d0
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        ; BLTSIZE = (h << 6) | word_count — triggers blit immediately.
        ; bits 15:6 = height (scan lines), bits 5:0 = width in 16-bit words.
        move.l  d3,d1                   ; d1 = h  (d3 kept for all planes)
        lsl.w   #6,d1                   ; d1 = h << 6
        move.l  a2,d0                   ; d0 = word_count
        or.w    d0,d1                   ; d1 = BLTSIZE
        move.w  d1,BLTSIZE(a5)         ; write to BLTSIZE → blit starts

        ; ── Advance to next plane ─────────────────────────────────────────────
        add.l   #GFXPSIZE,a0           ; next bitplane buffer
        lsr.l   #1,d4                   ; shift colour right: next bit → bit 0
        dbra    d5,.box_plane

        ; Wait for the last blit to complete before returning.
        jsr     _WaitBlit

        movem.l (sp)+,d0-d7/a0-a2
        rts
