; ============================================================================
; text.s — BASSM Text Rendering (M6)
; ============================================================================
;
; PURPOSE
;   Provides runtime helpers for the Blitz2D text output commands:
;
;     _Text   — render a string at a pixel position on the back buffer
;     _NPrint — debug output (no-op in bare metal builds)
;
; BLITZ2D SYNTAX
;   Text x, y, "string"       ; render text at pixel position (x, y)
;   NPrint "string"           ; no-op (kept for Blitz2D source compatibility)
;
; CODEGEN CONTRACT
;   Generated CODE for  Text x, y, "hello":
;         ; evaluate y → d0, push; evaluate x → d0; pop y → d1
;         move.l  d0,-(sp)        ; push y
;         ...evaluate x...
;         move.l  (sp)+,d1        ; d1 = y
;         lea     .str_0,a0       ; a0 = string pointer
;         jsr     _Text
;         bra.s   .past_0
;   .str_0:
;         dc.b    "hello",0
;         even
;   .past_0:
;
; ALGORITHM — CPU, per-plane per-row
;   For each character c in string (until NUL):
;     $0A newline: x = 0, y += 8, continue
;     Skip if c < 32 or c > 127 (non-printable / non-ASCII)
;     Stop  if y >= GFXHEIGHT  (no point continuing below screen)
;     Skip  if y < 0 or x < 0 or x >= GFXWIDTH
;     glyph = _font8x8 + (c - 32) * 8     (8 bytes, one per pixel row)
;     byte_offset = y * GFXBPR + (x >> 3)  (offset into each bitplane)
;     shift = x & 7                         (pixel shift within the byte)
;     For each bitplane p (0 .. GFXDEPTH-1):
;       For each row r (0 .. 7):
;         ; split glyph byte across two consecutive screen bytes:
;         ;   hi_part = glyph_byte >> shift     → goes to screen_byte[0]
;         ;   lo_part = glyph_byte << (8-shift) → goes to screen_byte[1]
;         ; (lo_part = 0 when shift = 0 → second write is a no-op)
;         if bit p of _draw_color set: OR  hi/lo into screen
;         else:                        AND ~hi / ~lo into screen
;     x += 8   (font cell width)
;
; SHIFT TRICK  (avoids a separate shift-count register)
;   After  moveq #0,d1 / move.b (a1)+,d1   d1.l = 0x000000gg
;          lsl.w #8,d1                      d1.w = 0xgg00
;          lsr.w d6,d1                      d1.w = 0x[hi_part][lo_part]
;          → d1.byte[0] = lo_part, d1.byte[1] = hi_part
;   SET:  or.b d1,1(a3) / lsr.w #8,d1 / or.b d1,(a3)
;   CLR:  not.w d1       (→ d1.w = [~hi][~lo])
;         and.b d1,1(a3) / lsr.w #8,d1 / and.b d1,(a3)
;   When shift=0: lo_part=0, OR 0 = no-op; ~lo_part=$FF, AND $FF = no-op. ✓
;
; REGISTER USE  (saves d2-d7/a1-a4; d0,d1,a0 are trashed/input)
;   d0 = plane loop counter (dbra; set to GFXDEPTH-1 per char)
;   d1 = glyph byte / shift scratch
;   d2 = current x  (advances +8 per char)
;   d3 = y          (constant per _Text call)
;   d4 = row counter (dbra 7..0 = 8 rows)
;   d5 = byte_offset (y*GFXBPR + x>>3)
;   d6 = shift       (x & 7)
;   d7 = draw_color bits  (lsr.w #1 per plane)
;   a0 = string pointer   (advances with (a0)+)
;   a1 = glyph row ptr    (reset to a4 each plane)
;   a2 = plane base ptr   (advances by GFXPSIZE per plane)
;   a3 = row dest ptr     (advances by GFXBPR per row)
;   a4 = glyph base       (constant per character)
;
; DEPENDENCY
;   palette.s must precede this fragment (_draw_color defined there).
;   startup.s must precede (_back_planes_ptr defined there).
;   GFXBPR, GFXPSIZE, GFXDEPTH, GFXWIDTH, GFXHEIGHT — EQUs from codegen.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — not used by this routine)
; ============================================================================


        INCLUDE "font8x8.s"             ; chip-RAM font data (_font8x8)

        SECTION text_code,CODE


; ── _Text ─────────────────────────────────────────────────────────────────────
;
; Renders a null-terminated ASCII string at pixel (x, y) in the back buffer.
; Supports newline ($0A): resets x to 0, advances y by 8 (one font cell).
;
; Args:   a0 = pointer to null-terminated ASCII string
;         d0.l = X position in pixels  (0 .. GFXWIDTH-1)
;         d1.l = Y position in pixels  (0 .. GFXHEIGHT-1)
; Trashes: nothing visible (saves d2-d7/a1-a4; d0, d1, a0 are input)

        XDEF    _Text
_Text:
        movem.l d2-d7/a1-a4,-(sp)

        move.l  d0,d2                   ; d2 = current x
        move.l  d1,d3                   ; d3 = y (constant for this call)

; ── Character loop ────────────────────────────────────────────────────────────

.txt_char:
        moveq   #0,d4
        move.b  (a0)+,d4               ; d4 = next char (zero-extended to long)
        beq.w   .txt_done              ; NUL terminator

        ; ── Newline ──────────────────────────────────────────────────────────
        cmp.b   #10,d4
        bne.s   .txt_not_nl
        moveq   #0,d2                  ; x = 0
        addq.l  #8,d3                  ; y += font height (8 px)
        bra.w   .txt_char

.txt_not_nl:
        ; ── Skip non-printable ASCII ──────────────────────────────────────
        cmp.b   #32,d4
        blt.w   .txt_advance           ; < SPACE → skip
        cmp.b   #127,d4
        bgt.w   .txt_advance           ; > DEL  → skip

        ; ── y bounds check ───────────────────────────────────────────────
        tst.l   d3
        blt.w   .txt_done              ; y < 0 → stop (would corrupt below buffer)
        cmp.l   #GFXHEIGHT,d3
        bge.w   .txt_done              ; y >= height → stop (all further chars off screen)

        ; ── x bounds check ───────────────────────────────────────────────
        tst.l   d2
        blt.w   .txt_advance           ; x < 0 → skip this char
        cmp.l   #GFXWIDTH,d2
        bge.w   .txt_advance           ; x >= width → skip this char

        ; ── Glyph pointer: a4 = _font8x8 + (char - 32) * 8 ──────────────
        sub.l   #32,d4                 ; char index (0-95)
        lsl.l   #3,d4                  ; × 8  (8 bytes per glyph)
        lea     _font8x8,a4
        add.l   d4,a4                  ; a4 = base of 8 glyph row bytes

        ; ── byte_offset = y * GFXBPR + (x >> 3) ──────────────────────────
        move.l  d3,d5
        muls.w  #GFXBPR,d5             ; d5 = y * bytes-per-row
        move.l  d2,d6
        lsr.l   #3,d6                  ; d6 = x >> 3  (byte column)
        add.l   d6,d5                  ; d5 = byte_offset

        ; ── shift = x & 7 ─────────────────────────────────────────────────
        move.l  d2,d6
        and.l   #7,d6                  ; d6 = pixel shift within byte (0-7)

        ; ── Plane loop ─────────────────────────────────────────────────────
        move.w  _draw_color,d7         ; d7 = colour index bits (1 bit per plane)
        move.l  _back_planes_ptr,a2   ; a2 = plane 0 base
        moveq   #GFXDEPTH-1,d0        ; d0 = plane counter (dbra)

.txt_plane:
        move.l  a4,a1                  ; a1 = glyph row ptr (reset each plane)
        lea     (a2,d5.l),a3           ; a3 = row-0 dest byte for this plane
        moveq   #7,d4                  ; d4 = row counter (dbra 7..0 = 8 rows)

        btst    #0,d7
        beq.s   .txt_plane_clr

; ── Plane bit SET: OR glyph rows into screen ─────────────────────────────────
.txt_row_set:
        moveq   #0,d1
        move.b  (a1)+,d1               ; d1 = glyph row byte
        lsl.w   #8,d1                  ; d1.w = [gg, 00]
        lsr.w   d6,d1                  ; d1.w = [hi_part, lo_part]
        or.b    d1,1(a3)               ; lo_part → next byte (0 when shift=0 → no-op)
        lsr.w   #8,d1                  ; d1.byte[0] = hi_part
        or.b    d1,(a3)                ; hi_part → dest byte
        lea     GFXBPR(a3),a3         ; advance dest to next pixel row
        dbra    d4,.txt_row_set
        bra.s   .txt_plane_next

; ── Plane bit CLR: AND NOT glyph rows into screen ────────────────────────────
.txt_plane_clr:
.txt_row_clr:
        moveq   #0,d1
        move.b  (a1)+,d1               ; d1 = glyph row byte
        lsl.w   #8,d1                  ; d1.w = [gg, 00]
        lsr.w   d6,d1                  ; d1.w = [hi_part, lo_part]
        not.w   d1                     ; d1.w = [~hi_part, ~lo_part]
        and.b   d1,1(a3)               ; ~lo → AND next byte ($FF when shift=0 → no-op)
        lsr.w   #8,d1                  ; d1.byte[0] = ~hi_part
        and.b   d1,(a3)                ; ~hi → AND dest byte
        lea     GFXBPR(a3),a3
        dbra    d4,.txt_row_clr

.txt_plane_next:
        lea     GFXPSIZE(a2),a2       ; advance to next bitplane buffer
        lsr.w   #1,d7                  ; next plane's colour bit → LSB
        dbra    d0,.txt_plane          ; loop over all planes

.txt_advance:
        addq.l  #8,d2                  ; advance x by font cell width (8 px)
        bra.w   .txt_char              ; fetch next character

.txt_done:
        move.l  d2,d0                   ; return new x position to caller
        movem.l (sp)+,d2-d7/a1-a4
        rts


; ── _NPrint ───────────────────────────────────────────────────────────────────
;
; Debug text output — no-op in bare metal builds.
; Kept for Blitz2D source compatibility.
;
; Args:   a0 = pointer to null-terminated ASCII string  (ignored)

        XDEF    _NPrint
_NPrint:
        rts


; ── _IntToStr ─────────────────────────────────────────────────────────────────
;
; Converts a signed 32-bit integer to a null-terminated decimal ASCII string.
; Result is written into _str_buf (12 bytes; max "-2147483648\0" = 12 chars).
;
; Args:   d0.l = signed integer to convert
; Return: d0.l = pointer to start of string in _str_buf
; Trashes: d1-d3/a1 (saved/restored)
;
; ALGORITHM
;   Build digits right-to-left in _str_buf.
;   32-bit divide by 10 via two 16-bit divu steps (avoids divu overflow):
;     1. hi_quot = hi16 / 10          (remainder goes into hi_rem)
;     2. lo_quot = (hi_rem*65536 + lo16) / 10   (this is the standard long-div step)
;     digit = remainder of step 2
;   Repeat with quotient = (hi_quot << 16) | lo_quot until quotient = 0.
;   Prepend '-' if input was negative.

        XDEF    _IntToStr
_IntToStr:
        movem.l d1-d3/a1,-(sp)

        lea     _str_buf+11,a1          ; a1 = one past end of buffer
        clr.b   (a1)                    ; NUL terminator

        ; ── Special case: zero ────────────────────────────────────────────────
        tst.l   d0
        bne.s   .its_nonzero
        move.b  #'0',-(a1)
        bra.s   .its_done

.its_nonzero:
        ; ── Record sign, work with absolute value ─────────────────────────────
        moveq   #0,d3                   ; d3 = sign flag (0 = positive)
        tst.l   d0
        bge.s   .its_loop
        neg.l   d0
        moveq   #1,d3                   ; negative

        ; ── Digit extraction loop ─────────────────────────────────────────────
.its_loop:
        ; Two-step divu: divide 32-bit d0 by 10 without overflow.
        ;
        ; 68000 divu.w divides a 32-bit register by a 16-bit immediate.
        ; If the quotient would exceed 65535 it traps — so we cannot do
        ; divu.w #10,d0 directly for large values.  Instead:
        ;
        ;   Step 1:  hi_quot  =  hi16(d0) / 10
        ;            hi_rem   =  hi16(d0) mod 10
        ;   Step 2:  lo_quot  =  (hi_rem * 65536 + lo16(d0)) / 10
        ;            digit    =  (hi_rem * 65536 + lo16(d0)) mod 10
        ;   Full quotient     =  (hi_quot << 16) | lo_quot
        ;
        ; After step 2:  d2 = { digit | lo_quot }  (divu puts rem in hi word)
        ; After step 1:  d1.lo = hi_quot  (we saved it before overwriting d2)
        ; We need d1 = { hi_quot | lo_quot } = hi_quot*65536 + lo_quot.
        ;
        ;   swap d1            : d1.hi = hi_quot  (d1.lo had hi_quot; now it is top word)
        ;   move.w d2,d1       : d1.lo = lo_quot  → d1 = correct 32-bit quotient
        ;   (NO second swap)
        ;
        move.l  d0,d2
        lsr.l   #8,d2
        lsr.l   #8,d2                   ; d2.lo = hi16 of d0
        divu.w  #10,d2                  ; d2 = { hi_rem | hi_quot }
        move.w  d2,d1                   ; d1.lo = hi_quot (save)
        move.w  d0,d2                   ; d2.lo = lo16; d2.hi = hi_rem (intact)
        divu.w  #10,d2                  ; d2 = { digit | lo_quot }
        swap    d1                      ; d1.hi = hi_quot, d1.lo = garbage → will be overwritten
        move.w  d2,d1                   ; d1 = { hi_quot | lo_quot } = 32-bit quotient
        swap    d2                      ; d2.lo = digit (remainder 0-9)
        and.w   #$000F,d2               ; isolate digit (divu remainder should be 0-9 already)
        add.b   #'0',d2
        move.b  d2,-(a1)                ; store digit right-to-left in buffer
        move.l  d1,d0                   ; quotient → d0 for next iteration
        tst.l   d0
        bne.s   .its_loop

        ; ── Prepend minus sign if negative ────────────────────────────────────
        tst.l   d3
        beq.s   .its_done
        move.b  #'-',-(a1)

.its_done:
        move.l  a1,d0                   ; return pointer to start of string
        movem.l (sp)+,d1-d3/a1
        rts


        SECTION text_bss,BSS

        XDEF    _str_buf
        XDEF    _text_y
_str_buf:       ds.b    12              ; max "-2147483648\0"
_text_y:        ds.l    1               ; Y scratch for multi-part Text calls
