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
;     8.  Restore OS display (standard KS 1.3 sequence):
;           LoadView(NULL)   — reset OS copper state / blank display
;           WaitTOF() × 2   — PAL/ECS interlace stability
;           LoadView(saved)  — reprograms copper with the saved Workbench view
;     9.  Unwind stack and return to the CLI with exit code 0
;
; DEPENDENCIES (labels defined by startup.s, earlier in the output file)
;   _saved_sp, _saved_intena, _saved_dmacon, _saved_lev2vec, _saved_lev3vec,
;   _saved_lev6vec, _null_copper, _saved_gfx_base, _saved_view
;   CUSTOM, INTENA, INTREQ, DMACON, COP1LCH, COP1LCL, COPJMP1,
;   VEC_LEVEL2, VEC_LEVEL3, VEC_LEVEL6
;   INTF_SETCLR, DMAF_SETCLR, _LVOPermit, ABSEXECBASE
;
; CODEGEN OUTPUT ORDER
;   startup.s  →  [graphics.s, cls.s, …]  →  [user _main_program]  →  offload.s
;
; ============================================================================


; ── Library LVO Offsets ──────────────────────────────────────────────────────
_LVOLoadView        EQU -222    ; graphics.library: install a View (copper list)
_LVOWaitTOF         EQU -270    ; graphics.library: wait for top of frame
_LVORethinkDisplay  EQU -390    ; intuition.library: rebuild the display from current views
_LVOCloseLibrary    EQU -414    ; exec.library:     close / decrement open count

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

; ── 3. Restore the Level-2, Level-3 and Level-6 exception vectors ───────────
        ; Level-2 ($68) must be restored BEFORE INTENA is re-enabled (step 5),
        ; so that AROS's keyboard handler is back in place when INTF_PORTS goes live.
        move.l  _saved_lev2vec,VEC_LEVEL2.w
        ; Level-3 ($6C): puts back AROS/Exec's own VBlank dispatcher.
        move.l  _saved_lev3vec,VEC_LEVEL3.w
        ; Level-6 ($78): CIA-B / EXTER autovector. KS 1.3 timer.device and
        ; audio.device hang their server lists on this. Without restoring it,
        ; an EXTER pending bit in INTREQ (Lev6) sees no handler — CPU stays
        ; in STOP, the input.device-Tick stops, and keyboard/mouse never wake.
        move.l  _saved_lev6vec,VEC_LEVEL6.w

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
        or.w    #INTF_SETCLR|$4000,d0   ; force INTEN (master) — guarantees interrupts on after restore
        move.w  d0,INTENA(a5)

; ── 6. Restore DMA ───────────────────────────────────────────────────────────
        move.w  _saved_dmacon,d0
        or.w    #DMAF_SETCLR,d0
        move.w  d0,DMACON(a5)

        ; Belt-and-suspenders: strobe COPJMP1 NOW that COPEN is active.
        ; The strobe in step 4 happened while COPEN=off; whether Agnus
        ; pre-loaded the copper PC at that point is chip-revision-dependent.
        ; A second strobe with COPEN=on guarantees the copper restarts from
        ; _null_copper immediately and cannot continue from our game copper list.
        ; (Any value written to COPJMP1 acts as a strobe; d0 value is irrelevant.)
        move.w  d0,COPJMP1(a5)

; ── 7. Restore OS display ────────────────────────────────────────────────────
        ;
        ; KS 1.3 sequence:
        ;   Permit()              ; unfreeze scheduler — LoadView needs it
        ;   LoadView(NULL)        ; tell graphics.library "we're done" — without
        ;                         ; this on KS 1.3, ActiView is unchanged and the
        ;                         ; VBlank server has no reason to reinstall the
        ;                         ; Workbench/CLI copper.  Empirically required.
        ;   WaitTOF × 2 (hw poll) ; let null view propagate
        ;   LoadView(saved_view)  ; reinstall Workbench/CLI view (skip if NULL)
        ;   WaitTOF × 2 (hw poll) ; let new copper take hold
        ;   RethinkDisplay()      ; tell Intuition to rebuild its views
        ;   WaitTOF × 2 (hw poll)
        ;   CloseLibrary(IntuitionBase)
        ;   CloseLibrary(GfxBase)
        ;
        ; AROS-Hinweis: LoadView(NULL) kann auf AROS hängen. Per project
        ; priority KS 1.3 = primary; AROS-Limitation akzeptiert.

        move.l  ABSEXECBASE.w,a6
        jsr     _LVOPermit(a6)              ; unfreeze scheduler FIRST

        move.l  _saved_gfx_base,d0
        beq     .skip_gfx                   ; OpenLibrary failed at startup

        ; LoadView(NULL) — required to wake graphics.library on KS 1.3
        move.l  d0,a6
        suba.l  a1,a1                       ; a1 = NULL
        jsr     _LVOLoadView(a6)

        jsr     _LVOWaitTOF(a6)             ; let null view propagate
        jsr     _LVOWaitTOF(a6)

        ; LoadView(saved_view) — only if we actually have a saved view
        move.l  _saved_view,d1              ; move.l→d1 sets CCR (move→An doesn't)
        beq.s   .skip_loadsaved
        move.l  d1,a1
        move.l  _saved_gfx_base,a6
        jsr     _LVOLoadView(a6)

        jsr     _LVOWaitTOF(a6)             ; let new copper take hold
        jsr     _LVOWaitTOF(a6)
.skip_loadsaved:

        ; RethinkDisplay — reorganises Intuition's view of the existing
        ; display.  Lighter than RemakeDisplay. Helps the library re-establish
        ; its VBlank-server hooks for input.device.
        move.l  _saved_intuition_base,d0
        beq.s   .skip_rethink
        move.l  d0,a6
        jsr     _LVORethinkDisplay(a6)

        move.l  _saved_gfx_base,a6
        jsr     _LVOWaitTOF(a6)             ; let rebuilt display propagate
        jsr     _LVOWaitTOF(a6)
.skip_rethink:

        ; ── 7b. MANUALLY RE-HOOK COPPER TO SYSTEM ────────────────────────────────
        ; The OS often optimizes Copper updates and may NOT reload COP1LC if it
        ; believes the View hasn't fundamentally changed. Since we changed COP1LC
        ; to _null_copper behind the OS's back, we MUST manually point it back
        ; to the OS copper list (GfxBase->copinit) before exit.
        ; Otherwise, the copper keeps running our _null_copper (which is freed)
        ; and executes random memory, causing the pixel garbage!
        move.l  _saved_gfx_base,a0
        move.l  38(a0),d0              ; d0 = GfxBase->copinit
        lea     CUSTOM,a5              ; a5 = $DFF000
        move.w  d0,COP1LCL(a5)
        swap    d0
        move.w  d0,COP1LCH(a5)
        move.w  d0,COPJMP1(a5)         ; Strobe Copper!

        move.l  ABSEXECBASE.w,a6            ; CloseLibrary — matches startup
        
        move.l  _saved_intuition_base,d1
        beq.s   .skip_close_intuition
        move.l  d1,a1
        jsr     _LVOCloseLibrary(a6)
.skip_close_intuition:

        move.l  _saved_gfx_base,a1
        jsr     _LVOCloseLibrary(a6)
.skip_gfx:

; ── 8. Return to CLI ─────────────────────────────────────────────────────────
        move.l  _saved_sp,sp                ; restore stack to entry state
        move.l  (sp)+,a5                    ; restore callee-saved a5
        moveq   #0,d0                       ; exit code 0 = success
        rts                                 ; return to AmigaOS



