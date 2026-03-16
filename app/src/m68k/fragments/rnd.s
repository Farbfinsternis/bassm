; ============================================================================
; rnd.s — Pseudo-random number generator  (Xorshift32, 68000-compatible)
;
; _Rnd
;   Input:  d1.l = n  (upper bound, 1..32767  →  result is 0..n-1)
;   Output: d0.l = pseudo-random integer, 0..n-1
;   Clobbers: d0, d1
;   Saves/restores: d2, d3
;
; Algorithm: Xorshift32 with triple {13, 17, 5} — maximal period 2^32-1.
; All shifts use the register form (lsl.l Dn,Dm / lsr.l Dn,Dm) so that shift
; counts > 8 are legal on the 68000 (immediate shifts are limited to 1..8).
;
; Seed initialisation (first call, seed = 0):
;   Two reads of VHPOSR ($DFF006) via a5=$DFF000 give a 32-bit value that
;   varies with program-start timing — different seed each run.
; ============================================================================

        SECTION rnd_code,CODE

        XDEF    _Rnd

_Rnd:
        movem.l d2/d3,-(sp)

        move.l  _rnd_seed,d0
        bne.s   .rnd_go

        ; First call: seed from beam-position register (varies with timing).
        move.w  6(a5),d0            ; VHPOSR ($DFF006) — hi byte = vpos, lo = hpos
        swap    d0
        move.w  6(a5),d0            ; second read for more entropy
        or.l    #1,d0               ; guarantee non-zero (Xorshift needs seed != 0)

.rnd_go:
        ; ── Xorshift32 ────────────────────────────────────────────────────────
        ; step 1: d0 ^= d0 << 13
        move.l  d0,d2
        moveq   #13,d3
        lsl.l   d3,d2
        eor.l   d2,d0

        ; step 2: d0 ^= d0 >> 17
        move.l  d0,d2
        moveq   #17,d3
        lsr.l   d3,d2
        eor.l   d2,d0

        ; step 3: d0 ^= d0 << 5  (count <= 8: immediate is fine)
        move.l  d0,d2
        lsl.l   #5,d2
        eor.l   d2,d0

        move.l  d0,_rnd_seed        ; persist new seed

        ; ── Reduce to 0..n-1 ─────────────────────────────────────────────────
        ; swap puts the high 16 bits (better distributed) into the low word.
        ; AND $7FFF masks to 15 bits → value is 0..32767, guaranteed positive.
        ; DIVU.W n,d0 → quotient in d0.lo, remainder (0..n-1) in d0.hi.
        ; swap again brings the remainder to d0.lo; AND $FFFF zero-extends.
        swap    d0
        and.l   #$7FFF,d0
        divu.w  d1,d0               ; d0.hi = remainder (0..n-1), d0.lo = quotient
        swap    d0
        and.l   #$FFFF,d0           ; zero-extend remainder to 32 bits

        movem.l (sp)+,d2/d3
        rts

; ── BSS ───────────────────────────────────────────────────────────────────────

        SECTION rnd_bss,BSS

        XDEF    _rnd_seed
_rnd_seed:
        ds.l    1
