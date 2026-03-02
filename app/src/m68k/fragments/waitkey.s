; ============================================================================
; waitkey.s — BASSM Keyboard Input: WaitKey
; ============================================================================
;
; PURPOSE
;   Provides the runtime helper that supports the Blitz2D "WaitKey" command:
;
;     _WaitKey  — halt the program until any key-down event is received
;
; BLITZ2D SYNTAX
;   WaitKey
;   Example: WaitKey
;
; CODEGEN CONTRACT
;   WaitKey takes no arguments:
;         jsr     _WaitKey
;
; HOW IT WORKS
;   Keyboard bytes are delivered asynchronously by _lev2_kbd_handler
;   (defined in startup.s) into the shared byte variable _kbd_pending.
;   This interrupt-driven approach is required for vAmiga compatibility:
;   vAmiga only injects keyboard events into the simulated CIA-A shift
;   register when INTENA.PORTS is enabled — which startup.s enables
;   together with the Level-2 handler.
;
;   1.  FLUSH: clear _kbd_pending on entry to discard any byte that
;       arrived before WaitKey was called (e.g. the key used to launch
;       the program).
;
;   2.  POLL loop: call _WaitVBL, then test _kbd_pending.
;       Yielding to the VBL is still important in vAmiga: it hands
;       control back to the browser event loop which processes host
;       keyboard events and ultimately drives _lev2_kbd_handler.
;
;   3.  When _kbd_pending is non-zero: consume the byte.
;
;   4.  DECODE: NOT + ROR #1 gives standard Amiga key code format:
;         bit 7 = 0 → key-down (accepted → return)
;         bit 7 = 1 → key-up  (discarded → loop back to step 2)
;
; AMIGA KEYBOARD DECODE  (applied to raw CIA byte)
;   The keyboard transmits the raw key code byte inverted and MSB-first.
;   _lev2_kbd_handler stores the raw CIASDR byte.  Standard transform:
;     NOT(raw)  = (scan_code << 1) | up_flag
;     ROR(result,1): bit 7 = up_flag,  bits 6:0 = scan_code
;
; DEPENDENCY
;   startup.s must be included before this fragment:
;     - _WaitVBL must be defined
;     - _lev2_kbd_handler must be installed at VEC_LEVEL2 ($68)
;     - _kbd_pending BSS variable must exist
;     - INTENA.PORTS must be enabled
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used by this routine)
; ============================================================================


        SECTION waitkey_code,CODE


; ── _WaitKey ──────────────────────────────────────────────────────────────────
;
; Halts execution until a key-down event is received from the keyboard.
; Key-up events are acknowledged (by _lev2_kbd_handler) but discarded here.
;
; Args:   none
; Trashes: nothing (saves/restores d0)

        XDEF    _WaitKey
_WaitKey:
        movem.l d0,-(sp)

        ; ── Step 1: Flush any byte that arrived before WaitKey was called ────
        ;
        ; Clears _kbd_pending so we wait for a fresh key press, not a stale
        ; byte from e.g. the key that triggered program execution.
        clr.b   _kbd_pending

        ; ── Step 2: Poll loop ─────────────────────────────────────────────────
        ;
        ; jsr _WaitVBL yields until the next 50 Hz vertical blank interrupt.
        ; This is essential: it gives control back to the emulator's event
        ; loop, which is where host keyboard events are processed and fed
        ; into _lev2_kbd_handler via the Level-2 interrupt.
.wk_poll:
        jsr     _WaitVBL                ; wait one VBL (~20 ms);  trashes d0
        tst.b   _kbd_pending            ; has _lev2_kbd_handler stored a byte?
        beq.s   .wk_poll               ; no → yield another VBL

        ; ── Step 3: Consume the byte ─────────────────────────────────────────
        move.b  _kbd_pending,d0         ; read the raw CIA key byte
        clr.b   _kbd_pending            ; mark slot as consumed

        ; ── Step 4: Decode and filter ─────────────────────────────────────────
        not.b   d0                      ; un-invert the received bits
        ror.b   #1,d0                   ; rotate: up/down flag → bit 7
        bmi.s   .wk_poll               ; bit 7 = 1 → key-up  → ignore

        ; Key-down event received → done
        movem.l (sp)+,d0
        rts
