; ============================================================================
; startup.s — BASSM Amiga Game Preparation
; ============================================================================
;
; PURPOSE
;   First fragment in every generated BASSM program.
;   Runs as an AmigaOS CLI executable, then takes over the hardware and
;   brings the Amiga into a clean, defined state ready for a game to run:
;
;     1.  Enter as an AmigaOS process — save the return stack
;     2.  Forbid() — freeze OS task switching
;     3.  Snapshot INTENA / DMACON (restored by offload.s on exit)
;     4.  Disable ALL interrupts and DMA
;     5.  Install our Level-3 VBlank handler at $6C
;     6.  Point Copper 1 at the null copper list (chip RAM) BEFORE
;         enabling copper DMA — prevents the copper running wild
;     7.  Kill all 8 sprites via direct hardware register writes
;     8.  Zero BPLCON0 — no active bitplanes
;     9.  Zero BPL1MOD / BPL2MOD — no bitplane modulo
;     10. Black background — COLOR00 = 0
;     11. Enable DMA: Master + Copper + Bitplane + Blitter  (no sprites yet)
;     12. Enable VBlank interrupt
;     13. Wait for the first clean VBlank — screen is now stable
;     14. Call _main_program (emitted by the BASSM codegen)
;     15. When _main_program returns → jump to _exit (defined in offload.s)
;
; REGISTER CONVENTION (held for the entire program lifetime)
;   a5 = $DFF000  Custom chip registers base
;   a6 = ExecBase (only valid during startup and in offload.s cleanup)
;   d0-d7, a0-a4  free scratch for generated code
;
; CODEGEN INTERFACE
;   Generated code MUST define:    _main_program
;   Generated code MAY define:     _vblank_hook  (see _SetVBlankHook)
;   Generated code calls exit via:  jmp _exit  (defined in offload.s)
;
; UTILITY SUBROUTINES (callable from generated code)
;   _WaitVBL        wait for next vertical blank (50 Hz PAL)
;   _GetFrameCount  return 50 Hz frame counter in d0
;   _SetVBlankHook  register a per-VBlank callback
;
; CHIP RAM LAYOUT (defined here, used by copper and graphics fragments)
;   _null_copper    4-byte copper list that immediately ends — safe default
;
; TARGET: OCS/ECS Amiga · PAL · 68000 · Kickstart 1.3+
; ASSEMBLE: vasmm68k_mot -Fhunk -o program.exe generated.s
; ============================================================================


; ── Custom Chip Register Offsets (from CUSTOM = $DFF000) ────────────────────

; Read-only (polling)
DMACONR     EQU $002        ; DMA channel enable state
INTENAR     EQU $01C        ; Interrupt enable mask
INTREQR     EQU $01E        ; Pending interrupt requests

; Copper
COP1LCH     EQU $080        ; Copper 1 list high word
COP1LCL     EQU $082        ; Copper 1 list low word
COPJMP1     EQU $088        ; Strobe: restart Copper 1 immediately

; Display geometry
DIWSTRT     EQU $08E        ; Display window start  (h/v beam positions)
DIWSTOP     EQU $090        ; Display window stop
DDFSTRT     EQU $092        ; Bitplane DMA fetch start
DDFSTOP     EQU $094        ; Bitplane DMA fetch stop

; Control
DMACON      EQU $096        ; DMA enable (write)
INTENA      EQU $09A        ; Interrupt enable (write)
INTREQ      EQU $09C        ; Interrupt request acknowledge (write)

; Bitplane control
BPLCON0     EQU $100        ; Bitplane control 0 (bpp count, modes)
BPLCON1     EQU $102        ; Bitplane scroll
BPLCON2     EQU $104        ; Bitplane priority
BPL1MOD     EQU $108        ; Modulo for odd bitplanes
BPL2MOD     EQU $10A        ; Modulo for even bitplanes

; Bitplane pointers (6 planes × 2 words each)
BPL1PTH     EQU $0E0        ; Bitplane 1 pointer high
BPL1PTL     EQU $0E2
BPL2PTH     EQU $0E4
BPL2PTL     EQU $0E6
BPL3PTH     EQU $0E8
BPL3PTL     EQU $0EA
BPL4PTH     EQU $0EC
BPL4PTL     EQU $0EE
BPL5PTH     EQU $0F0
BPL5PTL     EQU $0F2
BPL6PTH     EQU $0F4
BPL6PTL     EQU $0F6

; Sprites — 8 sprites × 4 registers each, starting at $140
; SPRxPOS = $140 + (n*8), SPRxCTL = $142 + (n*8),
; SPRxDATA = $144 + (n*8), SPRxDATB = $146 + (n*8)
SPR0POS     EQU $140
SPRITE_SIZE EQU 8           ; bytes between sprite bases

; Sprite DMA pointers in copper (8 sprites × 2 words = $120-$13E)
SPR0PTH     EQU $120
SPR0PTL     EQU $122
SPRITE_PTR_SIZE EQU 4       ; bytes between sprite pointer pairs

; Color registers
COLOR00     EQU $180        ; Background color (palette entry 0)
COLOR01     EQU $182

; ── DMA Control Bits ─────────────────────────────────────────────────────────
DMAF_SETCLR EQU $8000       ; 1 = set named bits,  0 = clear named bits
DMAF_MASTER EQU $0200       ; Master DMA enable (required for all other DMA)
DMAF_BPLEN  EQU $0100       ; Bitplane DMA
DMAF_COPEN  EQU $0080       ; Copper DMA
DMAF_BLTEN  EQU $0040       ; Blitter DMA
DMAF_SPREN  EQU $0020       ; Sprite DMA

; ── Interrupt Control Bits ───────────────────────────────────────────────────
INTF_SETCLR EQU $8000       ; 1 = set,  0 = clear
INTF_INTEN  EQU $4000       ; Master interrupt enable
INTF_VERTB  EQU $0020       ; VBlank (Level-3 autovector, 50 Hz PAL)
INTF_BLIT   EQU $0040       ; Blitter finished
INTF_PORTS  EQU $0008       ; CIA-A port (keyboard / joystick)

; ── Exec Library Offsets ─────────────────────────────────────────────────────
_LVOForbid  EQU -132        ; Forbid()  — freeze scheduler
_LVOPermit  EQU -138        ; Permit()  — unfreeze scheduler

; ── System Constants ─────────────────────────────────────────────────────────
CUSTOM      EQU $DFF000     ; Custom chip registers base address
ABSEXECBASE EQU 4           ; Address 4 always contains ExecBase pointer
VEC_LEVEL3  EQU $6C         ; 68000 Level-3 autovector (VBlank on Amiga)


; ============================================================================
;  STARTUP — GAME PREPARATION
; ============================================================================

        SECTION startup_code,CODE

        XDEF    start
start:
; ── 1. Preserve AmigaOS return context ───────────────────────────────────────
        move.l  a5,-(sp)                ; callee-save a5
        move.l  sp,_saved_sp            ; remember SP so offload.s can restore

        lea     CUSTOM,a5               ; a5 = $DFF000 — never changes again
        move.l  ABSEXECBASE.w,a6        ; a6 = ExecBase

        jsr     _LVOForbid(a6)          ; freeze OS scheduler

; ── 2. Snapshot current hardware masks ───────────────────────────────────────
        ; offload.s will use these to restore the system on exit
        move.w  INTENAR(a5),_saved_intena
        move.w  DMACONR(a5),_saved_dmacon
        move.l  VEC_LEVEL3.w,_saved_lev3vec

; ── 3. Disable all interrupts and DMA ────────────────────────────────────────
        move.w  #$7FFF,INTENA(a5)       ; clear all interrupt enables
        move.w  #$7FFF,INTREQ(a5)       ; acknowledge all pending requests
        move.w  #$7FFF,INTREQ(a5)       ; write twice — chip bus settling time
        move.w  #$7FFF,DMACON(a5)       ; stop all DMA immediately

; ── 4. Install null copper list BEFORE enabling copper DMA ───────────────────
        ; The Copper is a state machine. If we enable copper DMA without giving
        ; it a valid list, it will execute whatever garbage is in memory at the
        ; address COP1LC currently holds — unpredictable results.
        ; _null_copper is a single END instruction in chip RAM: safe to run.
        move.l  #_null_copper,d0
        swap    d0                      ; high word first (Amiga convention)
        move.w  d0,COP1LCH(a5)
        swap    d0
        move.w  d0,COP1LCL(a5)
        move.w  d0,COPJMP1(a5)         ; strobe: copper immediately starts

; ── 5. Kill all 8 sprites ────────────────────────────────────────────────────
        ; Without sprite DMA running, the shift registers hold stale data and
        ; sprites can appear as garbage on screen. Zeroing SPRxPOS/SPRxCTL
        ; positions each sprite off-screen (V-start = 0, V-stop = 0).
        ; We also zero the data words so even a glitching sprite shows nothing.
        lea     SPR0POS(a5),a0          ; a0 → SPR0POS
        moveq   #7,d7                   ; 8 sprites (d7 = 7 for dbra)
.kill_sprite:
        clr.w   (a0)+                   ; SPRxPOS  = 0  (v-start position)
        clr.w   (a0)+                   ; SPRxCTL  = 0  (v-stop, attachment)
        clr.w   (a0)+                   ; SPRxDATA = 0  (pixel data row)
        clr.w   (a0)+                   ; SPRxDATB = 0  (pixel data row)
        dbra    d7,.kill_sprite

; ── 6. Blank display state ───────────────────────────────────────────────────
        ; Zero bitplane count — no display output until graphics.s sets it up
        clr.w   BPLCON0(a5)
        clr.w   BPLCON1(a5)
        clr.w   BPLCON2(a5)
        clr.w   BPL1MOD(a5)            ; no modulo
        clr.w   BPL2MOD(a5)

        ; Black background — prevents random color flicker during setup
        clr.w   COLOR00(a5)

; ── 7. Install our VBlank interrupt handler ───────────────────────────────────
        ; The Level-3 autovector lives in Chip RAM at $6C.
        ; Overwriting it is normal bare-metal practice on the Amiga.
        move.l  #_lev3_handler,VEC_LEVEL3.w
        clr.l   _frame_count

; ── 8. Enable DMA ────────────────────────────────────────────────────────────
        ; Enable: Master + Copper + Bitplane + Blitter
        ; Sprites are NOT enabled here. graphics.s enables sprite DMA
        ; only when the program actually uses sprites.
        move.w  #(DMAF_SETCLR|DMAF_MASTER|DMAF_COPEN|DMAF_BPLEN|DMAF_BLTEN),DMACON(a5)

; ── 9. Enable VBlank interrupt ───────────────────────────────────────────────
        move.w  #(INTF_SETCLR|INTF_INTEN|INTF_VERTB),INTENA(a5)

; ── 10. Wait for first clean VBlank ─────────────────────────────────────────
        ; All register writes above take effect immediately but the video beam
        ; is mid-frame. Waiting one VBlank ensures we present a fully
        ; initialised state before the generated program draws anything.
        bsr     _WaitVBL

; ── 11. Run the generated program ────────────────────────────────────────────
        ; codegen.js emits a subroutine labelled _main_program containing
        ; the translated Blitz2D statements. Returning from it (or calling
        ; jmp _exit from inside it) triggers the offload.s cleanup.
        bsr     _main_program

; ── 12. Hand off to cleanup ──────────────────────────────────────────────────
        ; _exit is defined in offload.s which must follow this file
        ; in the concatenated generated assembly output.
        jmp     _exit


; ============================================================================
;  LEVEL-3 VBLANK INTERRUPT HANDLER
; ============================================================================
;
; Fired by Agnus at the top of every VBlank — 50 times/second on PAL.
; Increments the frame counter (used by WaitVBL) and calls the optional hook.
;
; Rules:
;   - Must save and restore every register it touches
;   - Must acknowledge INTREQ.VERTB before returning
;   - Must end with RTE  (not RTS — this is an exception return)
;   - The VBlank hook it calls must NOT call WaitVBL (deadlock)

_lev3_handler:
        movem.l d0-d7/a0-a5,-(sp)      ; save all scratch regs (a6 untouched)
        lea     CUSTOM,a5               ; re-establish custom base

        ; Acknowledge VBlank so hardware stops asserting Level-3.
        ; Written twice — second write ensures chipset bus has settled.
        move.w  #INTF_VERTB,INTREQ(a5)
        move.w  #INTF_VERTB,INTREQ(a5)

        addq.l  #1,_frame_count         ; advance 50 Hz frame counter

        ; Optional per-frame user callback
        move.l  _vblank_hook,d0
        beq.s   .no_hook
        move.l  d0,a0
        jsr     (a0)
.no_hook:
        movem.l (sp)+,d0-d7/a0-a5
        rte


; ============================================================================
;  UTILITY SUBROUTINES
; ============================================================================

; ── _WaitVBL ─────────────────────────────────────────────────────────────────
; Block until the next VBlank fires. Synchronises the game loop to 50 Hz.
; Blitz2D "WaitVbl" maps directly to this call.
;
; Usage:    bsr  _WaitVBL
; Trashes:  d0

        XDEF    _WaitVBL
_WaitVBL:
        move.l  _frame_count,d0         ; snapshot current count
.spin:  cmp.l   _frame_count,d0        ; has VBlank incremented it?
        beq.s   .spin                   ; no — poll again
        rts                             ; yes — exactly one VBlank has passed


; ── _GetFrameCount ───────────────────────────────────────────────────────────
; Returns the number of VBlanks since program start in d0.
; 50 counts = 1 second,  25 counts = half a second.
;
; Usage:    bsr  _GetFrameCount
; Returns:  d0.l

        XDEF    _GetFrameCount
_GetFrameCount:
        move.l  _frame_count,d0
        rts


; ── _SetVBlankHook ───────────────────────────────────────────────────────────
; Register a subroutine to be called from inside the VBlank interrupt.
; The routine executes 50 times/second in interrupt context.
;
; Requirements for the hook:
;   - PRESERVE every register (push on entry, pop on exit)
;   - Finish well within 1 frame (~160,000 cycles at 7 MHz)
;   - NEVER call WaitVBL or block in any way
;
; Usage:    lea  my_hook,a0
;           bsr  _SetVBlankHook
;
; To remove: moveq #0,d0 / move.l d0,_vblank_hook

        XDEF    _SetVBlankHook
_SetVBlankHook:
        move.l  a0,_vblank_hook
        rts


; ============================================================================
;  CHIP RAM DATA — null copper list
; ============================================================================
;
; The Copper needs a valid list in chip RAM before its DMA is enabled.
; A single WAIT $FFFF,$FFFE instruction tells the copper "wait for a beam
; position that can never be reached" — it stalls harmlessly at the end
; of every frame until graphics.s installs the real copper list.

        SECTION startup_copper,DATA_C   ; DATA_C = AmigaOS places in chip RAM

_null_copper:
        dc.w    $FFFF,$FFFE             ; WAIT: impossible position → copper end


; ============================================================================
;  BSS — Zero-filled variables (shared between startup.s and offload.s)
; ============================================================================

        SECTION startup_bss,BSS

        XDEF    _saved_sp
        XDEF    _saved_intena
        XDEF    _saved_dmacon
        XDEF    _saved_lev3vec
        XDEF    _frame_count
        XDEF    _vblank_hook

_saved_sp:      ds.l    1   ; stack pointer on entry — restored by offload.s
_saved_intena:  ds.w    1   ; INTENAR snapshot   — restored by offload.s
_saved_dmacon:  ds.w    1   ; DMACONR snapshot   — restored by offload.s
_saved_lev3vec: ds.l    1   ; Level-3 vector     — restored by offload.s
_frame_count:   ds.l    1   ; VBlank counter, incremented 50×/sec
_vblank_hook:   ds.l    1   ; optional callback address (0 = none)
