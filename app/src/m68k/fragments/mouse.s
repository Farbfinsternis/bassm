; ============================================================================
; mouse.s — BASSM Mouse Input
; ============================================================================
;
; PURPOSE
;   Provides mouse position and button state for the Blitz2D mouse commands:
;
;     MouseX        — current X position (0..GFXW-1)
;     MouseY        — current Y position (0..GFXH-1)
;     MouseDown(n)  — -1 if button n is currently held, else 0
;     MouseHit(n)   — -1 if button n was clicked since last call, else 0
;
;   n = 0: left mouse button
;   n = 1: right mouse button
;
; HARDWARE
;   Position:     JOY0DAT ($DFF00A) — delta-encoded 8-bit counters, accumulated
;                   bits [15:8] = Y counter,  bits [7:0] = X counter
;   Left button:  CIAAPRA ($BFE001) bit 6 — active low (0 = pressed)
;   Right button: POTINP  ($DFF016) bit 10 — active low (0 = pressed)
;
; CODEGEN CONTRACT
;   jsr _MouseInit  — called after _setup_graphics in the Graphics command.
;   _mouse_vbl      — installed in _mouse_vbl_ptr (startup.s) for VBL update.
;
; DEPENDENCY
;   startup.s defines _mouse_vbl_ptr and calls it from _lev3_handler.
;   EQUs GFXWIDTH and GFXHEIGHT must be defined before this file is assembled.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000 is NOT valid inside _mouse_vbl (called from interrupt, where
;   _lev3_handler re-establishes a5 — but we read chip regs by absolute address).
; ============================================================================


        SECTION mouse_code,CODE

        XDEF    _MouseInit
        XDEF    _mouse_vbl
        XDEF    _mouse_x
        XDEF    _mouse_y
        XDEF    _mouse_down_0
        XDEF    _mouse_down_1
        XDEF    _mouse_hit_0
        XDEF    _mouse_hit_1


; ── _MouseInit ────────────────────────────────────────────────────────────────
;
; Called once after _setup_graphics to initialise mouse state:
;   • Write POTGO to enable right-button reading via POTINP.
;   • Read JOY0DAT to establish the delta baseline (first frame delta = 0).
;   • Place the cursor at the centre of the screen.
;   • Install _mouse_vbl as the per-VBL update callback.
;
; Args:   none
; Trashes: d0/a0

_MouseInit:
        ; Enable right mouse button reading via the POT port.
        ; POTGO $C000: bit15 = start pot counter, bit14 = OUTRY (output enable).
        ; With the output line driven high, POTINP bit 10 reflects button state.
        move.w  #$C000,$DFF034

        ; Snapshot JOY0DAT so the first _mouse_vbl call produces a zero delta.
        move.w  $DFF00A,_mouse_prev_joydat

        ; Place cursor at screen centre
        move.w  #GFXWIDTH/2,d0
        move.w  d0,_mouse_x
        move.w  #GFXHEIGHT/2,d0
        move.w  d0,_mouse_y

        ; Install per-VBL mouse update (startup.s _lev3_handler calls this)
        move.l  #_mouse_vbl,_mouse_vbl_ptr
        rts


; ── _mouse_vbl ────────────────────────────────────────────────────────────────
;
; Called from the Level-3 VBlank interrupt via _mouse_vbl_ptr (startup.s).
; Runs at 50 Hz PAL. Updates position and button state variables.
;
; Position update:
;   JOY0DAT accumulates 8-bit quadrature counts. Each frame we subtract the
;   previous value (as signed 8-bit), giving a delta regardless of wrap.
;   The delta is added to _mouse_x / _mouse_y and clamped to screen bounds.
;
; Button update:
;   _mouse_down_N: $FF while button N is held, 0 when released.
;   _mouse_hit_N:  set to $FF on the first press; NOT cleared here.
;                  Remains set until MouseHit(n) reads and clears it.
;
; Trashes: nothing (saves/restores d0-d3/a0)

_mouse_vbl:
        movem.l d0-d3/a0,-(sp)

        ; ── Read JOY0DAT and compute deltas ──────────────────────────────────
        ;
        move.w  $DFF00A,d0              ; d0.w: [15:8]=Ycnt  [7:0]=Xcnt  (current)
        move.w  _mouse_prev_joydat,d1  ; d1.w: previous JOY0DAT
        move.w  d0,_mouse_prev_joydat  ; store current for next frame

        ; X delta: low bytes only (8-bit signed subtraction wraps correctly)
        move.b  d0,d2                   ; d2.b = current X counter
        sub.b   d1,d2                   ; d2.b = X delta (signed 8-bit, wraps fine)
        ext.w   d2                      ; sign-extend to word
        add.w   d2,_mouse_x
        tst.w   _mouse_x
        bge.s   .clamp_x_hi
        clr.w   _mouse_x               ; clamp low to 0
        bra.s   .clamp_x_done
.clamp_x_hi:
        cmp.w   #GFXWIDTH-1,_mouse_x
        ble.s   .clamp_x_done
        move.w  #GFXWIDTH-1,_mouse_x   ; clamp high to GFXWIDTH-1
.clamp_x_done:

        ; Y delta: high bytes shifted down to low position
        lsr.w   #8,d0                   ; d0.b = current Y counter
        lsr.w   #8,d1                   ; d1.b = previous Y counter
        sub.b   d1,d0                   ; d0.b = Y delta (signed 8-bit)
        ext.w   d0                      ; sign-extend to word
        add.w   d0,_mouse_y
        tst.w   _mouse_y
        bge.s   .clamp_y_hi
        clr.w   _mouse_y               ; clamp low to 0
        bra.s   .clamp_y_done
.clamp_y_hi:
        cmp.w   #GFXHEIGHT-1,_mouse_y
        ble.s   .clamp_y_done
        move.w  #GFXHEIGHT-1,_mouse_y  ; clamp high to GFXHEIGHT-1
.clamp_y_done:

        ; ── Left button: CIAAPRA ($BFE001) bit 6, active low ─────────────────
        move.b  $BFE001,d0
        not.b   d0                      ; invert: bit 6 = 1 when pressed
        btst    #6,d0
        beq.s   .left_up               ; not pressed

        ; Button held: set hit flag only on the first press (transition 0→held)
        tst.b   _mouse_down_0
        bne.s   .left_vbl_done         ; was already held → no new hit
        st      _mouse_down_0          ; mark held ($FF)
        st      _mouse_hit_0           ; record hit ($FF)
        bra.s   .left_vbl_done
.left_up:
        clr.b   _mouse_down_0          ; clear held flag (hit flag persists until read)
.left_vbl_done:

        ; ── Right button: POTINP ($DFF016) bit 10, active low ────────────────
        move.w  $DFF016,d0
        not.w   d0                      ; invert: bit 10 = 1 when pressed
        btst    #10,d0
        beq.s   .right_up              ; not pressed

        tst.b   _mouse_down_1
        bne.s   .right_vbl_done
        st      _mouse_down_1
        st      _mouse_hit_1
        bra.s   .right_vbl_done
.right_up:
        clr.b   _mouse_down_1
.right_vbl_done:

        movem.l (sp)+,d0-d3/a0
        rts


; ── BSS — zero-filled mouse state variables ───────────────────────────────────

        SECTION mouse_bss,BSS

_mouse_x:           ds.w    1   ; current X position (0..GFXW-1)
_mouse_y:           ds.w    1   ; current Y position (0..GFXH-1)
_mouse_prev_joydat: ds.w    1   ; previous JOY0DAT word for delta calculation
_mouse_down_0:      ds.b    1   ; $FF while left button held,  0 when released
_mouse_hit_0:       ds.b    1   ; $FF on first press; cleared by MouseHit(0)
_mouse_down_1:      ds.b    1   ; $FF while right button held, 0 when released
_mouse_hit_1:       ds.b    1   ; $FF on first press; cleared by MouseHit(1)
        EVEN
