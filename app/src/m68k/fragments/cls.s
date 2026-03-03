; ============================================================================
; cls.s — BASSM Screen Clear (Blitter A→D fill)
; ============================================================================
;
; PURPOSE
;   Provides the runtime helpers that support the Blitz2D "Cls" command:
;
;     _Cls  — fill all bitplanes to the current ClsColor (default 0 = black)
;
; BLITZ2D SYNTAX
;   Cls
;   Example: Cls       (clears screen to colour 0 unless ClsColor was used)
;
; HOW IT WORKS
;   Uses the Amiga Blitter (A→D mode) to fill each bitplane independently.
;   One Blitter operation per plane:
;
;     BLTCON0 = $09F0  USEA=1 (bit 11), USED=1 (bit 8), minterm $F0 (D = A)
;     BLTCON1 = $0000  normal copy mode (no line mode, no fill mode)
;     BLTAFWM = $FFFF  first-word mask: all bits active
;     BLTALWM = $FFFF  last-word mask:  all bits active
;     BLTAPT  → _blt_ones_row  (if plane bit = 1: fill with $FFFF)
;            or _blt_zero_row  (if plane bit = 0: fill with $0000)
;     BLTAMOD = -GFXBPR  A-pointer resets to start of row each line
;     BLTDPT  → start of the bitplane in chip RAM
;     BLTDMOD = 0       D plane is contiguous (no per-row padding)
;     BLTSIZE = (GFXHEIGHT << 6) | (GFXBPR/2)
;               bits 15:6 = height (scan lines), bits 5:0 = width (words)
;
;   BLTAMOD = -GFXBPR means: after reading GFXBPR/2 words (= GFXBPR bytes)
;   per row, the A pointer goes back GFXBPR bytes, so it always re-reads
;   from the start of the pattern row.  The pattern buffer is thus re-used
;   for every scan line without any DMA refresh.
;
; COLOUR-TO-PLANE MAPPING
;   Colour index n: bit b of n → bitplane b
;     bit 0 of n → plane 0  (filled with $FFFF if set, $0000 if clear)
;     bit 1 of n → plane 1 ... etc.
;
; PATTERN BUFFERS (chip RAM — shared with box.s)
;   _blt_ones_row  DATA_C  — one full row ($FFFF × GFXBPR/2 words)
;   _blt_zero_row  BSS_C   — one full row of zeros (BSS = zero-init)
;   Both are XDEF'd for use by box.s.
;
; CODEGEN CONTRACT
;   GFXDEPTH, GFXHEIGHT, GFXBPR, GFXPSIZE must be defined as EQUs.
;   _gfx_planes must label the chip-RAM bitplane buffer.
;   Generated code for Cls:   jsr _Cls
;
; DEPENDENCY
;   startup.s must be included first (defines _WaitBlit, Blitter register EQUs,
;   and _gfx_planes is defined by codegen in the generated file).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — used for all chip-reg accesses)
; ============================================================================


        SECTION cls_code,CODE


; ── _Cls ─────────────────────────────────────────────────────────────────────
;
; Fills all GFXDEPTH bitplanes with the pattern stored in _cls_color.
; One Blitter operation per plane.
;
; Args:   none
; Trashes: nothing (saves/restores d0-d5/a0-a1)

        XDEF    _Cls
_Cls:
        movem.l d0-d5/a0-a1,-(sp)

        move.l  _back_planes_ptr,a0     ; a0 = back buffer base (double-buffering)
        move.l  _cls_color,d4           ; d4 = colour index bitfield
        moveq   #GFXDEPTH-1,d5         ; d5 = plane loop counter (dbra = GFXDEPTH iters)

.cls_plane:
        ; ── Wait: previous blit must finish before we touch Blitter registers ──
        jsr     _WaitBlit               ; trashes d0

        ; ── Choose A-source: ones or zeros depending on this plane's colour bit ─
        btst    #0,d4                   ; is colour bit 0 set for this plane?
        beq.s   .cls_use_zeros
        lea     _blt_ones_row,a1        ; yes → fill plane with $FFFF
        bra.s   .cls_start_blit
.cls_use_zeros:
        lea     _blt_zero_row,a1        ; no  → fill plane with $0000

.cls_start_blit:
        ; ── Program Blitter ──────────────────────────────────────────────────
        ; BLTCON0: USEA=1 (bit 11), USED=1 (bit 8), minterm $F0 → D = A
        move.w  #$09F0,BLTCON0(a5)
        clr.w   BLTCON1(a5)             ; no line mode, no fill mode
        move.w  #$FFFF,BLTAFWM(a5)     ; first-word mask: all bits active
        move.w  #$FFFF,BLTALWM(a5)     ; last-word mask:  all bits active

        ; BLTAMOD = -GFXBPR: after reading one row (GFXBPR/2 words = GFXBPR bytes),
        ; A pointer net advance = GFXBPR + (-GFXBPR) = 0 → always re-reads row 0.
        move.w  #-GFXBPR,BLTAMOD(a5)

        ; BLTDMOD = 0: destination plane is contiguous (no inter-row skip bytes)
        clr.w   BLTDMOD(a5)

        ; A source pointer (high word first — Amiga bus convention)
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

        ; BLTSIZE write triggers the blit immediately.
        ; bits 15:6 = height in scan lines, bits 5:0 = width in 16-bit words.
        move.w  #(GFXHEIGHT<<6)|(GFXBPR/2),BLTSIZE(a5)

        ; ── Advance to next plane ─────────────────────────────────────────────
        add.l   #GFXPSIZE,a0            ; next bitplane buffer
        lsr.l   #1,d4                   ; shift colour right: next bit → bit 0
        dbra    d5,.cls_plane

        ; Wait for the last blit to finish before returning to caller.
        jsr     _WaitBlit

        movem.l (sp)+,d0-d5/a0-a1
        rts


; ============================================================================
;  Blitter pattern buffers — shared with box.s (XDEF'd)
; ============================================================================
;
; _blt_ones_row:
;   One full lores scan line of all-ones pixels in chip RAM (DATA_C).
;   Used for bitplane fill when the colour bit for that plane is 1.
;   GFXBPR/2 words wide (= GFXWIDTH/16 words = one full-width lores row).
;
; _blt_zero_row:
;   One full lores scan line of all-zeros in chip RAM (BSS_C = zero-filled).
;   Used for bitplane fill when the colour bit for that plane is 0.

        SECTION cls_pat,DATA_C

        XDEF    _blt_ones_row
_blt_ones_row:
        dcb.w   GFXBPR/2,$FFFF         ; GFXBPR/2 words of $FFFF (all pixels on)


        SECTION cls_zero,BSS_C

        XDEF    _blt_zero_row
_blt_zero_row:  ds.b    GFXBPR          ; GFXBPR bytes of $00  (all pixels off)


; ============================================================================
;  BSS — ClsColor storage
; ============================================================================
;
; _cls_color holds the colour index set by ClsColor.
; Initialised to 0 (clear to black) via BSS zero-init semantics.
; XDEF'd so clscolor.s can write to it.

        SECTION cls_bss,BSS

        XDEF    _cls_color
_cls_color:     ds.l    1       ; colour index (0..GFXCOLORS-1), default 0
