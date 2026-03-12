; ============================================================================
; sound.s — BASSM Paula Sound Support
; ============================================================================
;
; PURPOSE
;   Provides runtime helpers for playing 8-bit signed PCM samples on the
;   Amiga's Paula chip via hardware DMA, matching the Blitz2D interface:
;
;     _PlaySample  — start one Paula channel playing a sample (loops)
;     _StopSample  — stop a Paula channel (disables its DMA)
;
; BLITZ2D SYNTAX
;   PlaySample "file.raw", channel, period, volume
;       file    = raw 8-bit signed PCM data (INCBIN'd into chip RAM)
;       channel = 0–3  (Paula DMA channel)
;       period  = 3546895 / sample_rate  (PAL clock: 3.546895 MHz)
;                 e.g.  period 428 ≈ 8287 Hz,  period 214 ≈ 16574 Hz
;       volume  = 0–64 (Paula maximum)
;
;   StopSample channel
;
; DATA FORMAT
;   Signed 8-bit PCM, mono.  Must reside in chip RAM (codegen emits the
;   INCBIN in a DATA_C section).  Length must be even — codegen emits EVEN
;   after each INCBIN.
;
; HOW IT WORKS
;   Paula has four independent DMA audio channels (0–3).  Each channel has
;   its own set of registers:
;
;     AUDxLCH/LCL  — 32-bit sample start pointer  (hi word at offset +0, lo +2)
;     AUDxLEN      — sample length in words        (offset +4)
;     AUDxPER      — period (clock ticks per sample; lower = higher pitch)
;     AUDxVOL      — volume 0–64                   (offset +8)
;
;   Channel register bases relative to CUSTOM ($DFF000):
;     Channel 0: $0A0   Channel 1: $0B0
;     Channel 2: $0C0   Channel 3: $0D0
;   → offset = $0A0 + channel * $10
;
;   To enable audio DMA: write (bit 15=1 SET) | (1 << channel) to DMACON.
;   To disable:          write (bit 15=0 CLR) | (1 << channel) to DMACON.
;
;   After filling all AUDx registers we enable the DMA bit; Paula immediately
;   starts playing from AUDxLCH/LCL and loops back after AUDxLEN words.
;   (One-shot playback requires an audio interrupt; looping is the simple path
;   and suits continuous background samples / short effects stopped via StopSample.)
;
; CODEGEN CONTRACT
;   PlaySample "f", chan, per, vol  (any arg may be a variable/expression):
;         ; push vol, push per, push chan (all as .l on stack)
;         lea     _snd_N,a0          ; chip-RAM pointer to INCBIN data
;         move.l  #(_snd_N_end-_snd_N)/2,d1   ; length in words (assembler expression)
;         movem.l (sp)+,d0/d2-d3    ; d0=chan, d2=per, d3=vol
;         jsr     _PlaySample
;
;   StopSample chan:
;         moveq   #chan,d0           ; (or expression → d0)
;         jsr     _StopSample
;
; DEPENDENCY
;   startup.s — defines DMACON EQU, a5 = CUSTOM base.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION sound_code,CODE

; ── Paula register offsets (relative to CUSTOM = a5) ─────────────────────────
AUD0LCH     EQU     $0A0            ; channel 0 sample pointer high word
AUD0LCL     EQU     $0A2            ; channel 0 sample pointer low word
AUD0LEN     EQU     $0A4            ; channel 0 length in words
AUD0PER     EQU     $0A6            ; channel 0 period
AUD0VOL     EQU     $0A8            ; channel 0 volume (0-64)
AUDCHAN_SZ  EQU     $10             ; bytes between channel register sets

; ── Audio interrupt request bits (INTREQ / INTREQR) ──────────────────────────
INTF_AUD0   EQU     $0080           ; AUD0 DMA interrupt request bit
; AUD1=$0100, AUD2=$0200, AUD3=$0400 — computed as INTF_AUD0 << channel


; ── _PlaySample ──────────────────────────────────────────────────────────────
;
; Starts a Paula DMA channel playing a looping 8-bit signed PCM sample.
;
; Args:   d0.l = channel  (0–3)
;         a0   = chip-RAM pointer to sample data  (word-aligned)
;         d1.l = sample length in words
;         d2.l = period  (3546895 / Hz for PAL)
;         d3.l = volume  (0–64)
; Trashes: nothing (saves/restores d0-d4/a0-a1)

        XDEF    _PlaySample
_PlaySample:
        movem.l d0-d4/a0-a1,-(sp)

        ; ── Clamp channel and compute register base ───────────────────────
        andi.l  #3,d0                   ; clamp channel to 0-3
        move.l  d0,d4                   ; d4 = channel (preserved for DMA enable)
        lsl.w   #4,d0                   ; d0 = channel * AUDCHAN_SZ ($10)
        lea     AUD0LCH(a5),a1
        add.l   d0,a1                   ; a1 → AUDx register base (LCH word)

        ; ── Write sample pointer (split 32-bit address into hi/lo words) ─
        ;    Paula registers: AUDxLCH at +0, AUDxLCL at +2
        move.l  a0,d0
        swap    d0
        move.w  d0,0(a1)                ; AUDxLCH — high word of pointer
        swap    d0
        move.w  d0,2(a1)                ; AUDxLCL — low word of pointer

        ; ── Write length, period, volume ──────────────────────────────────
        move.w  d1,4(a1)                ; AUDxLEN — length in words
        move.w  d2,6(a1)                ; AUDxPER — period
        move.w  d3,8(a1)                ; AUDxVOL — volume

        ; ── Enable audio DMA for this channel ─────────────────────────────
        ;    DMACON write: bit 15=1 → SET mode; bit 0-3 = channel enables
        moveq   #1,d0
        lsl.w   d4,d0                   ; d0 = 1 << channel
        or.w    #$8000,d0               ; SET mode
        move.w  d0,DMACON(a5)

        movem.l (sp)+,d0-d4/a0-a1
        rts


; ── _PlaySampleOnce ──────────────────────────────────────────────────────────
;
; Plays a sample exactly once, then silently idles on a 1-word null buffer.
;
; Uses Paula's hardware double-buffering:
;   1. Write real sample pointer/length/period/volume and enable DMA.
;      Paula latches the address/length into internal counters on the first
;      DMA cycle and fires its INTREQ AUDx bit to say "give me the next pointer".
;   2. Poll INTREQR until the AUDx bit is set (safe — no handler needed,
;      bit reflects hardware state regardless of INTENA).
;   3. Clear the INTREQ bit, then overwrite AUDxLCH/LCL/LEN with _null_snd/1.
;   4. Paula plays the real sample to completion, reloads from the (now updated)
;      registers → plays 1 silent word in an endless loop → effectively silent.
;
; Args: same as _PlaySample
;   d0.l = channel  (0–3)
;   a0   = chip-RAM pointer to sample data  (word-aligned)
;   d1.l = sample length in words
;   d2.l = period  (3546895 / Hz for PAL)
;   d3.l = volume  (0–64)
; Trashes: nothing (saves/restores d0-d5/a0-a1)

        XDEF    _PlaySampleOnce
_PlaySampleOnce:
        movem.l d0-d5/a0-a1,-(sp)

        ; ── Clamp channel and compute register base ───────────────────────
        andi.l  #3,d0                   ; clamp channel to 0-3
        move.l  d0,d4                   ; d4 = channel (preserved for DMA enable)

        ; Compute INTREQ bit for this channel: INTF_AUD0 ($0080) << channel
        move.w  #INTF_AUD0,d5
        lsl.w   d4,d5                   ; d5 = AUDx INTREQ bit

        lsl.w   #4,d0                   ; d0 = channel * AUDCHAN_SZ ($10)
        lea     AUD0LCH(a5),a1
        add.l   d0,a1                   ; a1 → AUDx register base (LCH word)

        ; ── Write sample pointer (hi/lo words) ────────────────────────────
        move.l  a0,d0
        swap    d0
        move.w  d0,0(a1)                ; AUDxLCH — high word of pointer
        swap    d0
        move.w  d0,2(a1)                ; AUDxLCL — low word of pointer

        ; ── Write length, period, volume ──────────────────────────────────
        move.w  d1,4(a1)                ; AUDxLEN — real sample length in words
        move.w  d2,6(a1)                ; AUDxPER — period
        move.w  d3,8(a1)                ; AUDxVOL — volume

        ; ── Stop DMA and clear any stale INTREQ before (re)starting ──────────
        ; If the channel was already playing (e.g. null_snd loop from a previous
        ; PlaySampleOnce), the AUDx INTREQ bit fires every null_snd reload cycle
        ; (~428 clocks = 60 µs).  Without this step the poll below would see the
        ; stale bit immediately and exit before Paula has loaded the new sample.
        moveq   #1,d0
        lsl.w   d4,d0                   ; d0 = 1 << channel  (bit15=0 → CLEAR)
        move.w  d0,DMACON(a5)           ; stop audio DMA for this channel
        move.w  d5,INTREQ(a5)           ; clear any pending AUDx interrupt request
        move.w  d5,INTREQ(a5)           ; second write — chipset bus settling time
        ; (An in-flight DMA cycle may fire INTREQ between the DMACON write and the
        ; first INTREQ write; the second write catches it.  Same pattern as startup.s.)
        ; With DMA stopped no new AUDx INTREQ can fire until we re-enable below.

        ; ── Enable audio DMA for this channel ─────────────────────────────
        or.w    #$8000,d0               ; SET mode
        move.w  d0,DMACON(a5)

        ; ── Wait for Paula to latch the buffer into its internal counters ────
        ; Paula loads AUDxLCH/LCL/LEN at its first DMA slot after DMA enable.
        ; That slot occurs within one horizontal line (≤ 228 colour clocks
        ; ≈ 64 µs ≈ 456 CPU cycles @ 7 MHz).
        ;
        ; We do NOT poll INTREQR here.  On some host environments (e.g. WinUAE)
        ; the AUDx INTREQR bit is only updated when the corresponding INTENA bit
        ; is also set; since we never set INTENA.AUDx the poll would spin forever,
        ; killing performance and leaving the null buffer unwritten (→ loop).
        ;
        ; A fixed 2 000-cycle delay (200 × 10-cycle dbra) is more than 4× the
        ; worst-case latch time and costs < 2 sample-words of the real sample,
        ; so it is inaudible for any practical sound effect.
        ; On chip-RAM-only systems bus contention slows the CPU further, making
        ; the actual wall-clock wait even longer — which is equally safe.
        move.w  #199,d0
.wait:  dbra    d0,.wait

        ; ── Overwrite registers with null buffer ──────────────────────────
        ; Paula is still playing the real sample from its internal counters.
        ; When it finishes, it reloads from the EXTERNAL registers — which now
        ; point to a 1-word silent buffer → silent loop, no click, no pop.
        move.l  #_null_snd,d0
        swap    d0
        move.w  d0,0(a1)                ; AUDxLCH = null_snd high word
        swap    d0
        move.w  d0,2(a1)                ; AUDxLCL = null_snd low word
        move.w  #1,4(a1)                ; AUDxLEN = 1 word (minimum)

        movem.l (sp)+,d0-d5/a0-a1
        rts


; ── _StopSample ──────────────────────────────────────────────────────────────
;
; Disables the DMA for one Paula channel (silences it immediately).
;
; Args:   d0.l = channel  (0–3)
; Trashes: nothing (saves/restores d0-d1)

        XDEF    _StopSample
_StopSample:
        movem.l d0-d1,-(sp)

        andi.l  #3,d0                   ; clamp channel to 0-3
        moveq   #1,d1
        lsl.w   d0,d1                   ; d1 = 1 << channel
        ; DMACON write: bit 15=0 → CLEAR mode → disables audio DMA bit
        move.w  d1,DMACON(a5)

        movem.l (sp)+,d0-d1
        rts


; ── _null_snd — silent chip-RAM buffer for PlaySampleOnce ────────────────────
;
; A single zero word in chip RAM.  _PlaySampleOnce points Paula's "next buffer"
; registers here so the channel loops silently after the real sample ends.
; Paula requires AUDxLEN >= 1; one word is the minimum valid length.

        SECTION null_snd_sec,DATA_C

        XDEF    _null_snd
_null_snd:
        dc.w    0               ; one silent sample word (chip RAM required)
