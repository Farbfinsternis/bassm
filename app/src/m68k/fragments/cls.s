; ============================================================================
; cls.s — BASSM Screen Clear Subroutines
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "Cls" command:
;
;     _Cls  — clears all bitplanes to the current ClsColor (default: 0 = black)
;
; BLITZ2D SYNTAX
;   Cls
;   Example: Cls       (clears the screen to colour 0 unless ClsColor was used)
;
; HOW IT WORKS
;   The Blitter hardware can fill chip-RAM rectangles at full DMA bandwidth
;   without CPU involvement. For a zero-fill (colour 0), it uses minterm $00;
;   for an all-ones fill (any colour bit = 1), it uses minterm $01.  Each
;   bitplane is cleared in a separate blit because the colour representation
;   spans multiple planes (1 bit per plane per pixel).
;
;   Clearing GFXDEPTH planes of GFXHEIGHT × GFXBPR bytes each:
;     BLTCON0 = $0100 | minterm   (D channel only — no A/B/C sources)
;     BLTCON1 = $0000              (ascending, no fill mode, no shift)
;     BLTDMOD = 0                  (contiguous rows — no gaps)
;     BLTSIZE = (GFXHEIGHT<<6) | (GFXBPR/2)   [assembly-time constant]
;
;   The Blitter must be idle before any new blit is started; this routine
;   polls DMACONR.BBUSY (bit 14 = bit 6 of the high byte at offset $002)
;   twice per plane to guard against the OCS blitter busy-flag glitch.
;
; COLOUR-TO-PLANE MAPPING
;   Colour index n has its binary representation spread across the bitplanes:
;     bit 0 of n → bitplane 0 (filled with $FFFF if set, $0000 if clear)
;     bit 1 of n → bitplane 1
;     ...
;     bit (GFXDEPTH-1) of n → top bitplane
;
; CODEGEN CONTRACT — what codegen.js must define for Cls to work:
;   Assembly-time constants (EQUs):
;     GFXDEPTH   — number of bitplanes
;     GFXHEIGHT  — screen height in pixels
;     GFXBPR     — bytes per row  (= GFXWIDTH/8)
;     GFXPSIZE   — bytes per plane (= GFXBPR*GFXHEIGHT)
;   Runtime label:
;     _gfx_planes — base address of bitplane chip-RAM buffer (BSS_C)
;
; Generated CODE for each Cls statement:
;         bsr  _Cls
;
; Generated CODE for ClsColor n (see clscolor.s):
;         moveq  #n,d0
;         bsr    _ClsColor
;         bsr    _Cls
;   (or split across the program as needed)
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s)
; ============================================================================


; ── Blitter Register Offsets (from $DFF000) ──────────────────────────────────

BLTCON0     EQU $040        ; Blitter control 0 (channel enables + minterm)
BLTCON1     EQU $042        ; Blitter control 1 (shift, line/fill modes)
BLTDPTH     EQU $054        ; Blitter destination pointer — high word
BLTDPTL     EQU $056        ; Blitter destination pointer — low word
BLTSIZE     EQU $058        ; Blitter size (height:10 | width:6) — STARTS BLIT
BLTDMOD     EQU $066        ; Blitter destination modulo (bytes skipped per row)

; ── Blitter Control Bits ──────────────────────────────────────────────────────

BLTF_USEA   EQU $0800       ; BLTCON0 bit 11 — enable A source channel
BLTF_USEB   EQU $0400       ; BLTCON0 bit 10 — enable B source channel
BLTF_USEC   EQU $0200       ; BLTCON0 bit  9 — enable C (destination read) channel
BLTF_USED   EQU $0100       ; BLTCON0 bit  8 — enable D destination channel

; Minterms for D-only fill (no A/B/C → all inputs = 0 → bit 0 of minterm)
BLTMT_ZERO  EQU $00         ; minterm $00 — D = 0 always (zero fill)
BLTMT_ONE   EQU $01         ; minterm $01 — D = 1 always (all-ones fill)

; ── DMACONR Blitter Busy ─────────────────────────────────────────────────────
; DMACONR ($002) is a word. BBUSY = bit 14 = bit 6 of the HIGH byte at $002.
; Use: btst #6,DMACONR(a5)   — byte access to high byte of the register word.
BBUSY_BIT   EQU 6           ; bit number within the DMACONR high byte


        SECTION cls_code,CODE


; ── _Cls ─────────────────────────────────────────────────────────────────────
;
; Clears all GFXDEPTH bitplanes to the current ClsColor (stored in _cls_color).
; Uses the Blitter for maximum throughput — CPU is not stalled.
;
; Args:   none
; Trashes: d0-d2, a0  (all preserved via movem)

        XDEF    _Cls
_Cls:
        movem.l d0-d2/a0,-(sp)

        lea     _gfx_planes,a0          ; a0 = base of bitplane data in chip RAM
        move.l  _cls_color,d2           ; d2 = colour index bit field
        moveq   #GFXDEPTH-1,d0         ; d0 = loop counter (GFXDEPTH planes)

.cls_plane:
        ; ── Wait for Blitter idle (poll twice — OCS BBUSY glitch workaround) ──
.bltwait1:
        btst    #BBUSY_BIT,DMACONR(a5) ; high byte of DMACONR, bit 6 = BBUSY
        bne.s   .bltwait1
.bltwait2:
        btst    #BBUSY_BIT,DMACONR(a5) ; second check — guards against glitch
        bne.s   .bltwait2

        ; ── Choose minterm: bit 0 of d2 determines fill value for this plane ─
        move.w  #(BLTF_USED|BLTMT_ZERO),d1  ; default: D-only, fill with 0
        btst    #0,d2                   ; is bit 0 of colour index set?
        beq.s   .set_bltcon0
        move.w  #(BLTF_USED|BLTMT_ONE),d1   ; yes: fill this plane with 1s
.set_bltcon0:
        move.w  d1,BLTCON0(a5)
        move.w  #$0000,BLTCON1(a5)      ; ascending, no special modes
        move.w  #$0000,BLTDMOD(a5)      ; no modulo — contiguous rows

        ; ── Point Blitter destination at this bitplane ────────────────────────
        move.l  a0,d1
        swap    d1
        move.w  d1,BLTDPTH(a5)         ; high word of plane address
        swap    d1
        move.w  d1,BLTDPTL(a5)         ; low word of plane address

        ; ── Trigger: writing BLTSIZE starts the blit immediately ─────────────
        ; BLTSIZE = (height in lines << 6) | (width in 16-bit words)
        ; Both GFXHEIGHT and GFXBPR are assembly-time EQUs from codegen.
        move.w  #((GFXHEIGHT<<6)|(GFXBPR/2)),BLTSIZE(a5)

        ; ── Advance to next plane ─────────────────────────────────────────────
        lsr.l   #1,d2                   ; shift colour right: next bit → bit 0
        add.l   #GFXPSIZE,a0            ; advance destination to next bitplane

        dbra    d0,.cls_plane

        movem.l (sp)+,d0-d2/a0
        rts


; ============================================================================
;  BSS — ClsColor storage
; ============================================================================
;
; _cls_color holds the colour index set by the last ClsColor command.
; Initialised to 0 (clear to black) — matches BSS zero-init semantics.
; XDEF'd so clscolor.s can write to it.

        SECTION cls_bss,BSS

        XDEF    _cls_color
_cls_color:     ds.l    1       ; colour index (0..GFXCOLORS-1), default 0
