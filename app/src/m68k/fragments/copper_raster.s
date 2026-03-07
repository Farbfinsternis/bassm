; ============================================================================
; copper_raster.s — BASSM Copper Rasterbar Support
; ============================================================================
;
; PURPOSE
;   Provides runtime helpers for setting per-scanline COLOR00 entries in the
;   copper list at runtime, enabling the classic Amiga rasterbar effect:
;
;     _SetRasterColor    — set a copper COLOR00 entry (d0=y, d1=OCS word)
;     _SetRasterColorRGB — same but takes separate R, G, B components
;
; HOW IT WORKS
;   When a BASSM program uses CopperColor, codegen.js emits a raster section
;   in each copper list (before the END instruction):
;
;     _gfx_raster_a:                    ; raster entries for copper list A
;         dc.w  WAIT_0, $FF00           ; WAIT scanline 0
;         dc.w  $0180, $0000            ; MOVE COLOR00 = black
;         dc.w  WAIT_1, $FF00           ; WAIT scanline 1
;         dc.w  $0180, $0000            ; MOVE COLOR00 = black
;         ... (up to GFXRASTER entries)
;     _gfx_raster_b:                    ; same structure for copper list B
;         ...
;
;   Each entry is exactly 8 bytes:
;     Offset 0: WAIT hi word  = (vStart+y)<<8 | $01
;     Offset 2: WAIT lo word  = $FF00  (match any horizontal position)
;     Offset 4: MOVE reg      = $0180  (COLOR00)
;     Offset 6: MOVE value    = OCS colour word ($0RGB) — PATCHED AT RUNTIME
;
;   _SetRasterColor always patches the BACK copper list so the change takes
;   effect on the next ScreenFlip.
;
; BLITZ2D SYNTAX
;   CopperColor y, r, g, b
;       y     = screen scanline (0 = top of visible area, max GFXRASTER-1)
;       r,g,b = colour components (0..15 each, OCS 4-bit precision)
;
;   Typical use inside the main loop, before ScreenFlip:
;     For line = 0 To GFXRASTER-1
;         CopperColor line, line/16, 0, 15 - line/16
;     Next line
;     ScreenFlip
;
; CODEGEN CONTRACT
;   Compile-time (all four args are integer literals):
;         moveq   #y,d0
;         move.w  #$0RGB,d1
;         jsr     _SetRasterColor
;
;   Runtime (any arg is a variable or expression):
;         ; push b (arg3), push g (arg2), push r (arg1)
;         ; eval y (arg0) → d0
;         ; movem.l (sp)+,d1-d3     ; d1=r, d2=g, d3=b
;         jsr     _SetRasterColorRGB
;
; DEPENDENCY
;   _front_is_a         — BSS byte defined in startup.s (XDEF'd)
;   _gfx_raster_a/b     — DATA_C labels emitted by codegen.js when CopperColor
;                          is present in the BASSM source
;   All fragments are INCLUDEd into a single assembly source, so labels are
;   visible across fragments without XREF declarations.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION copper_raster_code,CODE


; ── _SetRasterColor ───────────────────────────────────────────────────────────
;
; Patches the MOVE COLOR00 word at scanline y in the BACK copper list.
; Call this each frame (before ScreenFlip) to animate raster colors.
;
; Args:   d0.l = screen y coordinate (0 = top, max GFXRASTER-1)
;         d1.w = OCS colour word ($0RGB, each nibble 0-F)
; Trashes: nothing (saves/restores d0/a0)

        XDEF    _SetRasterColor
_SetRasterColor:
        movem.l d0/a0,-(sp)

        ; ── Select the back raster table ─────────────────────────────────────
        ; _front_is_a = 0  →  copper A is front  →  back raster = _gfx_raster_b
        ; _front_is_a = 1  →  copper B is front  →  back raster = _gfx_raster_a
        tst.b   _front_is_a
        bne.s   .use_raster_a

        lea     _gfx_raster_b,a0
        bra.s   .do_patch

.use_raster_a:
        lea     _gfx_raster_a,a0

.do_patch:
        ; ── Calculate entry offset and patch MOVE value ───────────────────────
        ; Each entry = 8 bytes.  MOVE value word is at byte offset 6.
        lsl.l   #3,d0               ; d0 = y * 8
        add.l   d0,a0               ; a0 → entry for scanline y
        move.w  d1,6(a0)            ; patch MOVE COLOR00 value word

        movem.l (sp)+,d0/a0
        rts


; ── _SetRasterColorRGB ────────────────────────────────────────────────────────
;
; Runtime variant of _SetRasterColor — accepts separate R, G, B components
; and builds the OCS colour word at runtime.  Use when r/g/b are variables.
;
; Args:   d0.l = screen y coordinate (0..GFXRASTER-1)
;         d1.l = red   component (0..15, only low nibble used)
;         d2.l = green component (0..15, only low nibble used)
;         d3.l = blue  component (0..15, only low nibble used)
; Trashes: d1 (rebuilt as OCS word)
; Preserves: d0, d2, d3, all address registers

        XDEF    _SetRasterColorRGB
_SetRasterColorRGB:
        movem.l d2-d3,-(sp)
        andi.w  #$F,d1          ; clamp r to one nibble
        lsl.w   #8,d1           ; r → bits 8-11
        andi.w  #$F,d2          ; clamp g to one nibble
        lsl.w   #4,d2           ; g → bits 4-7
        or.w    d2,d1           ; combine R and G
        andi.w  #$F,d3          ; clamp b to one nibble
        or.w    d3,d1           ; d1 = $0RGB OCS colour word
        movem.l (sp)+,d2-d3
        jsr     _SetRasterColor ; d0=y, d1=OCS word
        rts
