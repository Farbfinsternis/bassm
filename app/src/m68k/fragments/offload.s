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
;     1.  Disable ALL interrupts  (our VBlank handler must not fire anymore)
;     2.  Disable ALL DMA
;     3.  Restore the Level-3 autovector we replaced in startup.s
;     4.  Reinstall the null copper list  (safe parking point before DMA is
;         re-enabled; COP1LCH/COP1LCL are write-only so we cannot save and
;         restore the OS copper pointer — we park on the null list and let
;         the OS reinstall its own copper at the next VBlank)
;     5.  Re-enable the interrupt sources that were active on entry
;     6.  Re-enable the DMA channels that were active on entry
;         (copper now runs the null list, not our game copper)
;     7.  Permit() — unfreeze the AmigaOS scheduler
;     8.  Restore OS display:
;        A. graphics.library: LoadView(NULL) + WaitTOF×2 + LoadView(saved)
;        B. intuition.library: RethinkDisplay() — rebuild all screens/windows
;           (needed on AROS where LoadView alone does not refresh windows)
;     9.  Unwind stack and return to the CLI with exit code 0
;
; DEPENDENCIES (labels defined by startup.s, earlier in the output file)
;   _saved_sp, _saved_intena, _saved_dmacon, _saved_lev3vec, _null_copper
;   _saved_gfx_base, _saved_view
;   CUSTOM, INTENA, INTREQ, DMACON, COP1LCH, COP1LCL, COPJMP1, VEC_LEVEL3
;   INTF_SETCLR, DMAF_SETCLR, _LVOPermit, ABSEXECBASE
;
; CODEGEN OUTPUT ORDER
;   startup.s  →  [graphics.s, cls.s, …]  →  [user _main_program]  →  offload.s
;
; ============================================================================


; ── Graphics Library LVO Offsets ─────────────────────────────────────────────
_LVOLoadView        EQU -222    ; graphics.library: install a View (copper list)
_LVOWaitTOF         EQU -270    ; graphics.library: wait for top of frame (VBlank)
_LVOCloseLibrary    EQU -414    ; exec.library:     close / decrement open count
_LVORethinkDisplay  EQU -756    ; intuition.library: rebuild all screens and windows


        SECTION offload_code,CODE

; ── _exit — Entry point for all program termination paths ────────────────────
;
; Reachable via:
;   fall-through       from startup.s after jsr _main_program returns

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

; ── 2b. Zero BPLCON0 — stop bitplane DMA before it is re-enabled ─────────────
        ; BPLCON0 still holds our value (e.g. $5200, 5 bitplanes) written by
        ; the copper list.  When DMA is restored in step 6 the hardware would
        ; immediately start fetching from our bitplane buffers.  Those buffers
        ; are about to be freed by AmigaDOS, so DMA reads from them produce
        ; garbage on screen.
        ; Zeroing BPLCON0 now (while DMA is still off) disables bitplane DMA.
        ; Our null copper (step 4) does not touch BPLCON0, so it stays zero
        ; until AROS's VBlank handler reinstalls the OS copper list, which sets
        ; the correct BPLCON0 for the Workbench display.
        clr.w   BPLCON0(a5)

; ── 3. Restore the Level-2 and Level-3 exception vectors ─────────────────────
        ; Level-2 ($68) must be restored BEFORE INTENA is re-enabled (step 5),
        ; so that AROS's keyboard handler is back in place when INTF_PORTS goes live.
        move.l  _saved_lev2vec,VEC_LEVEL2.w
        ; Level-3 ($6C): puts back AROS/Exec's own VBlank dispatcher.
        move.l  _saved_lev3vec,VEC_LEVEL3.w

; ── 4. Reinstall the null copper list ────────────────────────────────────────
        ; COP1LCH/COP1LCL are write-only — we cannot restore the OS copper
        ; pointer directly.  Instead we park Copper 1 on the safe null list
        ; (defined in startup.s).  When DMA is restored (step 6) the copper
        ; runs the null list, which does nothing.  At the next VBlank, the
        ; restored OS VBlank handler (step 3) reinstalls the OS copper list,
        ; returning the Workbench display cleanly.
        move.l  #_null_copper,d0
        swap    d0
        move.w  d0,COP1LCH(a5)         ; Copper 1 pointer — high word
        swap    d0
        move.w  d0,COP1LCL(a5)         ; Copper 1 pointer — low word
        move.w  d0,COPJMP1(a5)         ; strobe: copper picks up new pointer now

; ── 5. Restore interrupts ────────────────────────────────────────────────────
        ; _saved_intena holds the raw INTENAR bits (without the SETCLR flag).
        ; OR-ing in INTF_SETCLR turns this into a "set these bits" write,
        ; which re-enables exactly the sources that were active on entry.
        move.w  _saved_intena,d0
        or.w    #INTF_SETCLR,d0
        move.w  d0,INTENA(a5)

; ── 6. Restore DMA ───────────────────────────────────────────────────────────
        ; The copper now runs the null list — no display interference.
        ; The OS VBlank handler (restored in step 3) will reinstall the OS
        ; copper list at the next VBlank, restoring the Workbench display.
        move.w  _saved_dmacon,d0
        or.w    #DMAF_SETCLR,d0
        move.w  d0,DMACON(a5)

; ── 7. Unfreeze AmigaOS scheduler ────────────────────────────────────────────
        move.l  ABSEXECBASE.w,a6
        jsr     _LVOPermit(a6)

; ── 8. Restore OS display ────────────────────────────────────────────────────
        ;
        ; A. graphics.library — clear hardware state, then reinstall AROS view:
        ;      LoadView(NULL)       parks the copper on an empty view
        ;      WaitTOF() × 2       lets both fields sync (ECS safety)
        ;      LoadView(saved)      reinstalls the copper list saved at startup
        ;                           (skipped if ActiView was NULL — some AROS builds)
        ;
        ; B. Intuition — force a full display + window refresh:
        ;      RethinkDisplay()     rebuilds all screen copper lists and redraws
        ;                           all windows.  Needed on AROS because LoadView
        ;                           alone does not trigger the display compositor.

        ; ── A: graphics.library ──────────────────────────────────────────────
        move.l  _saved_gfx_base,d0
        beq.s   .skip_loadview

        move.l  d0,a6
        sub.l   a1,a1                   ; LoadView(NULL) — clear hardware state
        jsr     _LVOLoadView(a6)
        jsr     _LVOWaitTOF(a6)         ; wait frame 1
        jsr     _LVOWaitTOF(a6)         ; wait frame 2

        move.l  _saved_view,a1          ; LoadView(saved) — reinstall AROS view
        beq.s   .skip_savedview         ;   skip if ActiView was NULL at startup
        jsr     _LVOLoadView(a6)
.skip_savedview:

        move.l  ABSEXECBASE.w,a6        ; CloseLibrary — matches startup.s open
        move.l  _saved_gfx_base,a1
        jsr     _LVOCloseLibrary(a6)
.skip_loadview:

        ; ── B: Intuition — RethinkDisplay ────────────────────────────────────
        move.l  ABSEXECBASE.w,a6
        lea     _intui_lib_name,a1
        moveq   #0,d0
        jsr     _LVOOpenLibrary(a6)
        tst.l   d0
        beq.s   .skip_rethink
        move.l  d0,a6
        jsr     _LVORethinkDisplay(a6)  ; rebuild all screens and windows
        ; (no CloseLibrary — program exits immediately, OS cleans up)
.skip_rethink:

; ── 9. Return to CLI ─────────────────────────────────────────────────────────
        move.l  _saved_sp,sp            ; restore stack to entry state
        move.l  (sp)+,a5               ; restore callee-saved a5
        moveq   #0,d0                   ; exit code 0 = success
        rts                             ; return to AmigaOS
