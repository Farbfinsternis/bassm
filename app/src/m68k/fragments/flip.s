; ============================================================================
; flip.s — BASSM Screen Flip (Double-Buffering)
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "ScreenFlip" command:
;
;     _ScreenFlip  — synchronise with VBlank, swap front/back buffers
;
; BLITZ2D SYNTAX
;   ScreenFlip
;
; HOW IT WORKS
;   Double-buffering uses two identical bitplane sets in chip RAM:
;     Buffer A  = _gfx_planes   (first GFXPSIZE*GFXDEPTH bytes)
;     Buffer B  = _gfx_planes_b (second GFXPSIZE*GFXDEPTH bytes)
;   And two matching copper lists:
;     _gfx_copper_a  — copper list whose bitplane pointers point at buffer A
;     _gfx_copper_b  — copper list whose bitplane pointers point at buffer B
;
;   State variables (BSS, in startup.s):
;     _back_planes_ptr  — longword: chip-RAM address of the current back buffer
;     _front_is_a       — byte:     0 = copper A is front, 1 = copper B is front
;
;   On each ScreenFlip call:
;     1. Wait for VBlank  (_WaitVBL — synchronises swap with the raster beam)
;     2. Determine which copper is currently front:
;        _front_is_a = 0  →  Front is A, Back is B:
;            install _gfx_copper_b  (B becomes the new front)
;            _back_planes_ptr = _gfx_planes   (A becomes the new back)
;            _front_is_a = 1
;        _front_is_a = 1  →  Front is B, Back is A:
;            install _gfx_copper_a  (A becomes the new front)
;            _back_planes_ptr = _gfx_planes_b (B becomes the new back)
;            _front_is_a = 0
;
; RESULT
;   On return: the buffer the CPU/Blitter has been drawing into is now
;   the displayed (front) buffer.  The newly assigned back buffer is
;   ready for the next frame's drawing operations.
;
; TEARING PREVENTION
;   The swap is installed during VBlank so the copper reads the new list
;   starting from line 0 of the next frame — the beam never crosses a
;   mid-frame pointer change.
;
; CODEGEN CONTRACT
;   Generated code for ScreenFlip:   jsr _ScreenFlip
;
; DEPENDENCY
;   startup.s — defines _WaitVBL, _back_planes_ptr, _front_is_a.
;   graphics.s — defines _InstallCopper, _gfx_copper_a, _gfx_copper_b.
;   codegen.js — emits _gfx_planes and _gfx_planes_b as BSS_C labels.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION flip_code,CODE


; ── _ScreenFlip ───────────────────────────────────────────────────────────────
;
; Waits for VBlank then swaps front/back buffers.
;
; Args:   none
; Trashes: nothing (saves/restores d0/a0)

        XDEF    _ScreenFlip
_ScreenFlip:
        movem.l d0/a0,-(sp)

        ; ── Wait for Blitter ─────────────────────────────────────────────────
        ; Ensure all drawing operations (Cls, Box, etc.) are finished before
        ; we swap the buffers.
        jsr     _WaitBlit

        ; ── Check which copper is currently front ─────────────────────────────
        tst.b   _front_is_a
        bne.s   .flip_b_is_front

        ; ── Front = A, Back = B → install B as new front ─────────────────────
        lea     _gfx_copper_b,a0
        jsr     _InstallCopper
        lea     _gfx_planes,a0
        move.l  a0,_back_planes_ptr     ; A is now the back buffer
        move.b  #1,_front_is_a         ; B is now front
        bra.s   .flip_done

        ; ── Front = B, Back = A → install A as new front ─────────────────────
.flip_b_is_front:
        lea     _gfx_copper_a,a0
        jsr     _InstallCopper
        lea     _gfx_planes_b,a0
        move.l  a0,_back_planes_ptr     ; B is now the back buffer
        clr.b   _front_is_a            ; A is now front

.flip_done:
        ; ── Wait for VBlank AFTER the swap ───────────────────────────────────
        jsr     _WaitVBL

        movem.l (sp)+,d0/a0
        rts
