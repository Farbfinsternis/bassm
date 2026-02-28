; ============================================================================
; offload.s — BASSM AmigaOS Restoration
; ============================================================================
;
; PURPOSE
;   Last fragment in every generated BASSM program.
;   Provides the _exit label that the startup.s entry point jumps to
;   after _main_program returns (or that generated code jumps to directly
;   when the user's program ends with "End").
;
;   Restores the Amiga to the exact hardware state it was in before our
;   program ran so that AmigaOS continues cleanly after us:
;
;     1.  Disable ALL interrupts (our VBlank handler must not fire anymore)
;     2.  Disable ALL DMA
;     3.  Restore the Level-3 autovector we replaced in startup.s
;     4.  Re-enable the interrupt sources that were active on entry
;     5.  Re-enable the DMA channels that were active on entry
;     6.  Permit() — unfreeze the AmigaOS scheduler
;     7.  Unwind stack and return to the CLI with exit code 0
;
; DEPENDENCIES (labels defined by startup.s, earlier in the output file)
;   _saved_sp, _saved_intena, _saved_dmacon, _saved_lev3vec
;   CUSTOM, INTENA, INTREQ, DMACON, VEC_LEVEL3
;   INTF_SETCLR, DMAF_SETCLR, _LVOPermit, ABSEXECBASE
;
; CODEGEN OUTPUT ORDER
;   startup.s  →  [graphics.s, cls.s, …]  →  [user _main_program]  →  offload.s
;
; ============================================================================


        SECTION offload_code,CODE

; ── _exit — Entry point for all program termination paths ────────────────────
;
; Reachable via:
;   jmp _exit          from generated "End" statement
;   fall-through       from startup.s after bsr _main_program returns

        XDEF    _exit
_exit:
        lea     CUSTOM,a5               ; re-establish custom base (callee may
                                        ; have trashed a5 if it called _exit)

; ── 1. Disable all interrupts ────────────────────────────────────────────────
        ; Our handler must be silenced before we remove its vector.
        ; If a VBlank fires between removing the vector and re-enabling the OS
        ; handler, the 68000 would jump to the old (now invalid) address.
        move.w  #$7FFF,INTENA(a5)       ; clear all interrupt enables

        ; Acknowledge any interrupt that fired during the last instruction.
        ; Doubled write for chipset bus settling reliability.
        move.w  #$7FFF,INTREQ(a5)
        move.w  #$7FFF,INTREQ(a5)

; ── 2. Disable all DMA ───────────────────────────────────────────────────────
        move.w  #$7FFF,DMACON(a5)

; ── 3. Restore the Level-3 exception vector ──────────────────────────────────
        ; Puts back whatever vector was there when our program started
        ; (normally Exec's own VBlank dispatcher).
        move.l  _saved_lev3vec,VEC_LEVEL3.w

; ── 4. Restore interrupts ────────────────────────────────────────────────────
        ; _saved_intena holds the raw INTENAR bits (without the SETCLR flag).
        ; OR-ing in INTF_SETCLR turns this into a "set these bits" write,
        ; which re-enables exactly the sources that were active on entry.
        move.w  _saved_intena,d0
        or.w    #INTF_SETCLR,d0
        move.w  d0,INTENA(a5)

; ── 5. Restore DMA ───────────────────────────────────────────────────────────
        move.w  _saved_dmacon,d0
        or.w    #DMAF_SETCLR,d0
        move.w  d0,DMACON(a5)

; ── 6. Unfreeze AmigaOS scheduler ────────────────────────────────────────────
        move.l  ABSEXECBASE.w,a6
        jsr     _LVOPermit(a6)

; ── 7. Return to CLI ─────────────────────────────────────────────────────────
        move.l  _saved_sp,sp            ; restore stack to entry state
        move.l  (sp)+,a5               ; restore callee-saved a5
        moveq   #0,d0                   ; exit code 0 = success
        rts                             ; return to AmigaOS
