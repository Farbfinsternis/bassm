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
;   Double-buffering uses two copper lists:
;     _gfx_copper_a  — copper list whose bitplane pointers point at buffer A
;     _gfx_copper_b  — copper list whose bitplane pointers point at buffer B
;
;   State variables (BSS, in startup.s):
;     _front_is_a       — byte:     0 = copper A is front, 1 = copper B is front
;
;   On each ScreenFlip call:
;     1. Wait for Blitter to finish
;     2. Determine which copper is currently front:
;        _front_is_a = 0  →  install _gfx_copper_b  (B becomes front), _front_is_a = 1
;        _front_is_a = 1  →  install _gfx_copper_a  (A becomes front), _front_is_a = 0
;     3. Wait for VBlank
;
;   The per-viewport back-pointer update (_vpN_back_ptr, _back_planes_ptr)
;   is emitted inline by codegen.js after the jsr _ScreenFlip call (T16).
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
;   Generated code for ScreenFlip:
;         jsr     _ScreenFlip
;         ; … inline VP back-pointer swap (emitted by codegen) …
;
; DEPENDENCY
;   startup.s — defines _WaitVBL, _front_is_a.
;   graphics.s — defines _InstallCopper, _gfx_copper_a, _gfx_copper_b.
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

        ; ── Front = A → install B as new front ───────────────────────────────
        lea     _gfx_copper_b,a0
        jsr     _InstallCopper
        move.b  #1,_front_is_a
        bra.s   .flip_done

        ; ── Front = B → install A as new front ───────────────────────────────
.flip_b_is_front:
        lea     _gfx_copper_a,a0
        jsr     _InstallCopper
        clr.b   _front_is_a

.flip_done:
        ; ── Wait for VBlank AFTER the swap ───────────────────────────────────
        jsr     _WaitVBL

        movem.l (sp)+,d0/a0
        rts
