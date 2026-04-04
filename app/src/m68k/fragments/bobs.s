; ============================================================================
; bobs.s — BASSM Blitter Objects (Bobs)
; ============================================================================
;
; PURPOSE
;   Provides Blitter Object (Bob) support: hardware-accelerated sprites with
;   optional transparency masking and automatic double-buffer background restore.
;
; BLITZ2D SYNTAX
;   SetBackground index               ; register a full-screen background image
;   LoadMask index, "file.mask"       ; optional: register a transparency mask
;   DrawBob index, x, y              ; queue a bob for drawing this frame
;
;   Example:
;     SetBackground 0                 ; image 0 is the static background
;     LoadMask 1, "player.mask"       ; image 1 has a transparency mask
;     DrawBob 1, px, py               ; draw player sprite (masked)
;     DrawBob 2, ex, ey               ; draw enemy sprite (direct copy, no mask)
;     ScreenFlip                      ; _FlushBobs injected automatically here
;
; HOW IT WORKS
;   Three queues track bob positions:
;     _bobs_new    — bobs queued this frame via DrawBob  (reset every frame)
;     _bobs_old_a  — what was drawn last time buffer A was back  (2-frame history)
;     _bobs_old_b  — what was drawn last time buffer B was back
;
;   _FlushBobs (auto-injected before ScreenFlip) runs in four steps:
;     1. Call _bg_restore_fn for each slot in the current back buffer's old queue
;        → erases last frame's bobs by blitting from the background image
;     2. Draw all new bobs from _bobs_new into the current back buffer
;        → masked blit if maskptr != 0, direct copy otherwise
;     3. Copy _bobs_new → old queue for this back buffer (save for next time)
;     4. Reset _bobs_new_cnt = 0
;
;   If SetBackground has not been called, Step 1 is skipped (bobs leave trails).
;   If no mask is registered for an image, DrawBob falls back to direct copy.
;
; BOB SLOT FORMAT (BOBS_SLOT_SZ = 16 bytes)
;   +0   imgptr.l    pointer to image data (8-byte header + palette + planes)
;   +4   maskptr.l   pointer to mask data (raw 1bpp, chip RAM); 0 = no mask
;   +8   x.w         horizontal position (word-aligned: x % 16 == 0)
;   +10  y.w         vertical position
;   +12  frame.w     animation frame index (0 = first frame; same as non-animated)
;   +14  padding.w   reserved (must be 0)
;
; MASKED BLIT (transparent bobs)
;   4-channel blitter operation:
;     A = mask    (1bpp, 1=opaque, 0=transparent)
;     B = bob     (bitplane pixels)
;     C = D       (back buffer plane — read then written back)
;   Minterm $CA = D = A?B:C  (if mask bit: D = bob pixel; else: D = background)
;   BLTCON0 = $0FCA  (USEA | USEB | USEC | USED)
;
; BACKGROUND RESTORE
;   _bg_restore_static blits from the static background image (_bg_bpl_ptr)
;   to the back buffer using the bob's own w/h/rowbytes to define the area.
;   BLTCON0 = $09F0  (USEA | USED, D = A — plain copy)
;   Both BLTAMOD and BLTDMOD = GFXBPR - bob_rowbytes (both are full-width).
;
; DEPENDENCY
;   startup.s  — Blitter EQUs, _WaitBlit, _back_planes_ptr, a5=$DFF000.
;   image.s    — _DrawImage (used for direct-copy bobs without a mask).
;   codegen.js — GFXBPR, GFXPSIZE, GFXDEPTH, BOBS_MAX.
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (must not be changed)
; ============================================================================


; ── BSS — Bob queue state (regular RAM, not chip) ───────────────────────────

        SECTION bobs_bss,BSS

        XDEF    _bg_restore_fn
        XDEF    _bg_bpl_ptr
        XDEF    _bobs_new_cnt
        XDEF    _bobs_new
        XDEF    _bobs_old_a
        XDEF    _bobs_old_b

_bg_restore_fn:  ds.l    1               ; fn ptr: 0=none, else _bg_restore_static
_bg_bpl_ptr:     ds.l    1               ; ptr to bg image bitplane-0 data start
_bobs_new_cnt:   ds.w    1               ; bobs queued this frame (filled by DrawBob)
_bobs_old_cnt_a: ds.w    1               ; old bob count for buffer A
_bobs_old_cnt_b: ds.w    1               ; old bob count for buffer B
                 ds.w    1               ; padding — keep _bobs_new longword-aligned
_bobs_new:       ds.b    BOBS_MAX*16     ; new queue   (16 = BOBS_SLOT_SZ)
_bobs_old_a:     ds.b    BOBS_MAX*16     ; old queue for buffer A
_bobs_old_b:     ds.b    BOBS_MAX*16     ; old queue for buffer B


; ── Bob-State-Block EQUs (T25) ──────────────────────────────────────────────
;   Per-viewport state block layout.  Each viewport has one BSS block of
;   BOB_ST_SIZE bytes (emitted by codegen.js, T26).
;   All .l fields are longword-aligned (offset 8+).

BOB_ST_NEW_CNT    EQU 0            ; .w — bobs queued this frame
BOB_ST_OLD_CNT_A  EQU 2            ; .w — old bob count for buffer A
BOB_ST_OLD_CNT_B  EQU 4            ; .w — old bob count for buffer B
                                    ; EQU 6: .w padding (longword alignment)
BOB_ST_RESTORE_FN EQU 8            ; .l — fn ptr (0 / _bg_restore_static / _bg_restore_tilemap)
BOB_ST_BG_BPL_PTR EQU 12           ; .l — ptr to bg image bitplane-0 data
BOB_ST_FINE_X     EQU 16           ; .w — fine-scroll X offset (0..tileW-1)
BOB_ST_FINE_Y     EQU 18           ; .w — fine-scroll Y offset (0..tileH-1)
BOB_ST_NEW        EQU 20           ; Bob-Queue new  (BOBS_MAX × 16 bytes)
BOB_ST_OLD_A      EQU (20+BOBS_MAX*16)
BOB_ST_OLD_B      EQU (20+BOBS_MAX*2*16)
BOB_ST_SIZE       EQU (20+BOBS_MAX*3*16)

; ── CODE ────────────────────────────────────────────────────────────────────

        SECTION bobs_code,CODE


; ── _SetBackground ────────────────────────────────────────────────────────────
;
; Registers a full-screen background image so _FlushBobs can restore the
; background pixels under each bob before drawing the new frame.
;
; Computes the pointer to bitplane-0 data (skipping the 8-byte header and the
; embedded OCS palette) and stores it in the active VP's Bob-State-Block.
; Installs _bg_restore_static as the active restore function.
;
; Args:   a0 = image label address (8-byte header + palette + bitplane data)
; Trashes: nothing (saves/restores d0-d1/a0-a1)

        XDEF    _SetBackground
_SetBackground:
        movem.l d0-d1/a0-a1,-(sp)

        ; Skip the 8-byte header (width.w, height.w, depth.w, rowbytes.w)
        ; and the palette block that follows it.
        ; Palette size = (1 << depth) * 2 bytes.
        move.w  4(a0),d0                ; d0.w = depth (offset 4 in header; may carry $8000 flag)
        and.w   #$7FFF,d0               ; clear interleaved flag — depth is at most 5
        moveq   #1,d1
        lsl.l   d0,d1                   ; d1 = 1 << depth  (palette entry count)
        add.l   d1,d1                   ; d1 = palette bytes  (2 bytes per entry)
        addq.l  #8,a0                   ; skip 8-byte header
        add.l   d1,a0                   ; skip palette → a0 = bitplane-0 data start

        move.l  _active_bob_state,a1
        move.l  a0,BOB_ST_BG_BPL_PTR(a1)

        ; Install the restore function
        lea     _bg_restore_static,a0
        move.l  a0,BOB_ST_RESTORE_FN(a1)

        movem.l (sp)+,d0-d1/a0-a1
        rts


; ── _AddBob ───────────────────────────────────────────────────────────────────
;
; Appends one entry to the active viewport's bob queue (via _active_bob_state).
; Silently discards the request when the queue is full (BOBS_MAX slots).
;
; Args:   a0 = image pointer (image label: 8-byte header + palette + planes)
;         a1 = mask pointer  (raw 1bpp data in chip RAM; 0 = direct-copy)
;         d0 = x  (word-aligned pixel position, x % 16 == 0)
;         d1 = y
;         d2 = frame index  (0 = first frame / non-animated)
; Trashes: nothing (saves/restores d0-d2/a0-a4)

        XDEF    _AddBob
_AddBob:
        movem.l d0-d2/a0-a4,-(sp)

        move.l  _active_bob_state,a4    ; a4 = VP Bob-State-Block
        move.w  BOB_ST_NEW_CNT(a4),d2
        cmp.w   #BOBS_MAX,d2
        bge.s   .full                   ; queue full — discard

        ; Slot address = BOB_ST_NEW(a4) + cnt * 16
        ; d0/d1/a0/a1 still hold x/y/imgptr/maskptr (only d2 was clobbered by count)
        ; Saved d2 (frame index) is at 8(sp) in the movem frame.
        mulu.w  #16,d2                  ; BOBS_SLOT_SZ = 16
        lea     BOB_ST_NEW(a4),a3
        add.l   d2,a3                   ; a3 = slot start

        move.l  a0,(a3)+               ; +0:  imgptr
        move.l  a1,(a3)+               ; +4:  maskptr (0 = no mask)
        move.w  d0,(a3)+               ; +8:  x
        move.w  d1,(a3)+               ; +10: y
        move.w  8(sp),(a3)+            ; +12: frame index (read from saved d2 on stack)
        clr.w   (a3)                    ; +14: padding

        addq.w  #1,BOB_ST_NEW_CNT(a4)
.full:
        movem.l (sp)+,d0-d2/a0-a4
        rts


; ── _FlushBobs ────────────────────────────────────────────────────────────────
;
; Auto-injected by codegen immediately before every _ScreenFlip call.
; Called once per viewport that uses bobs (T29).
;
; Step 1 — Restore background under old bobs (erases last frame's sprites).
;          Uses the back-buffer-specific old queue to get 2-frame history right.
;          Skipped if no restore fn registered (BOB_ST_RESTORE_FN=0).
;
; Step 2 — Draw all new bobs from the state block's new queue.
;          Uses masked blit when maskptr != 0, direct copy otherwise.
;
; Step 3 — Copy new → old queue for this back buffer.
;          These positions will be erased next time this buffer is back.
;
; Step 4 — Reset BOB_ST_NEW_CNT = 0 (ready for the next frame).
;
; Args:   a4 = VP Bob-State-Block (set by codegen)
;         _back_planes_ptr must be set to the active VP's back buffer before call
; Trashes: nothing (saves/restores d0-d7/a0-a6)

        XDEF    _FlushBobs
_FlushBobs:
        movem.l d0-d7/a0-a6,-(sp)

        ; ── Select old queue for the current back buffer ──────────────────────
        ; _front_is_a = 0: front=A, back=B → use BOB_ST_OLD_B / BOB_ST_OLD_CNT_B
        ; _front_is_a = 1: front=B, back=A → use BOB_ST_OLD_A / BOB_ST_OLD_CNT_A
        tst.b   _front_is_a
        bne.s   .back_is_a

        lea     BOB_ST_OLD_B(a4),a2     ; a2 = old queue base
        lea     BOB_ST_OLD_CNT_B(a4),a3 ; a3 = ptr to old count word
        bra.s   .do_flush

.back_is_a:
        lea     BOB_ST_OLD_A(a4),a2
        lea     BOB_ST_OLD_CNT_A(a4),a3

.do_flush:
        ; ── Step 1: Restore background at old bob positions ───────────────────
        move.l  BOB_ST_RESTORE_FN(a4),d6
        beq.s   .skip_restore           ; no restore fn — skip

        move.w  (a3),d7
        beq.s   .skip_restore           ; no old bobs — nothing to erase

        ; Shadowcopy bg_bpl_ptr → global (read by _bg_restore_static)
        move.l  BOB_ST_BG_BPL_PTR(a4),_bg_bpl_ptr

        subq.w  #1,d7
        move.l  a2,a6                   ; a6 = current old slot pointer

.restore_loop:
        move.l  (a6),a0                 ; a0 = bob imgptr
        clr.l   d0
        move.w  8(a6),d0               ; d0.l = x (zero-extended)
        clr.l   d1
        move.w  10(a6),d1              ; d1.l = visual_y (zero-extended)
        add.w   BOB_ST_FINE_X(a4),d0  ; buf_x = visual_x + fine_x (0 when no scroll)
        add.w   BOB_ST_FINE_Y(a4),d1  ; buf_y = visual_y + fine_y (0 when no scroll)
        move.l  d6,a1
        jsr     (a1)                    ; _bg_restore_fn(a0=imgptr, d0=x, d1=buf_y)
        lea     16(a6),a6              ; advance to next slot (BOBS_SLOT_SZ = 16)
        dbra    d7,.restore_loop

.skip_restore:
        ; ── Step 2: Draw new bobs ─────────────────────────────────────────────
        move.w  BOB_ST_NEW_CNT(a4),d7
        beq.s   .skip_draw

        subq.w  #1,d7
        lea     BOB_ST_NEW(a4),a6       ; a6 = current new slot pointer

.draw_loop:
        move.l  (a6),a0                 ; a0 = imgptr
        move.l  4(a6),a1                ; a1 = maskptr (0 = no mask)
        clr.l   d0
        move.w  8(a6),d0               ; d0.l = x
        clr.l   d1
        move.w  10(a6),d1              ; d1.l = y
        add.w   BOB_ST_FINE_X(a4),d0  ; buf_x = visual_x + fine_x (0 when no scroll)
        add.w   BOB_ST_FINE_Y(a4),d1  ; buf_y = visual_y + fine_y (0 when no scroll)
        clr.l   d2
        move.w  12(a6),d2              ; d2.l = frame index (0 = first / non-animated)
        cmpa.l  #0,a1                   ; tst.l An not valid on 68000
        beq.s   .draw_direct

        jsr     _BltBobMaskedFrame      ; masked:  a0=imgptr, a1=maskptr, d0=x, d1=y, d2=frame
        bra.s   .draw_next

.draw_direct:
        jsr     _DrawImageFrame         ; direct copy: a0=imgptr, d0=x, d1=y, d2=frame

.draw_next:
        lea     16(a6),a6              ; advance to next slot (BOBS_SLOT_SZ = 16)
        dbra    d7,.draw_loop

.skip_draw:
        ; ── Step 3: Copy new queue → old queue for this back buffer ──────────
        move.w  BOB_ST_NEW_CNT(a4),d7
        move.w  d7,(a3)                 ; update old count for this buffer
        beq.s   .skip_copy

        ; Copy d7 slots × 4 longwords/slot = d7*4 longword moves
        mulu.w  #4,d7                   ; slots × 4  (16 bytes = 4 longwords each)
        subq.w  #1,d7
        lea     BOB_ST_NEW(a4),a0
        move.l  a2,a1
.copy_loop:
        move.l  (a0)+,(a1)+
        dbra    d7,.copy_loop

.skip_copy:
        ; ── Step 4: Reset new queue ───────────────────────────────────────────
        clr.w   BOB_ST_NEW_CNT(a4)

        movem.l (sp)+,d0-d7/a0-a6
        rts


; ── _bg_restore_static ────────────────────────────────────────────────────────
;
; Restores the background pixels under one bob by blitting from the static
; background image (_bg_bpl_ptr) to the current back buffer.
;
; The blit area is determined by the bob's own dimensions (read from its
; 8-byte image header: height at +2, rowbytes at +6).
;
; The background image is full-screen (GFXBPR bytes per row), so both
; BLTAMOD and BLTDMOD equal (GFXBPR - bob_rowbytes).
;
; Args:   a0 = bob image pointer (8-byte header: width.w, height.w, depth.w, rowbytes.w)
;         d0 = x  (word-aligned pixel position)
;         d1 = y
; Trashes: nothing (saves/restores d0-d6/a0-a2)

_bg_restore_static:
        movem.l d0-d6/a0-a2,-(sp)

        ; ── Read bob dimensions from its header ───────────────────────────────
        ; Header layout: +0 width.w, +2 height.w, +4 depth.w, +6 rowbytes.w
        addq.l  #2,a0                   ; skip width word
        move.w  (a0)+,d4                ; d4.w = height
        addq.l  #2,a0                   ; skip depth word
        move.w  (a0),d6                 ; d6.w = rowbytes

        ; ── Bounds check — skip if position is outside the overscan buffer ──────
        ; Pixel width is not available here (header was partially read).
        ; We allow negative coords into the overscan border (±GFXBORDER).
        ; d2 is free at this point — use it as scratch for y+height.
        cmp.l   #-GFXBORDER,d0
        blt.w   .bg_done                ; x < -GFXBORDER
        cmp.l   #-GFXBORDER,d1
        blt.w   .bg_done                ; y < -GFXBORDER
        cmp.l   #(GFXWIDTH+GFXBORDER),d0
        bge.w   .bg_done                ; x >= GFXWIDTH+GFXBORDER
        move.l  d1,d2
        add.w   d4,d2                   ; d2 = y + height
        cmp.l   #(GFXHEIGHT+GFXBORDER),d2
        bgt.w   .bg_done                ; y + height > GFXHEIGHT+GFXBORDER

        ; ── BLTSIZE = (height << 6) | (rowbytes / 2) ─────────────────────────
        move.w  d4,d2
        lsl.w   #6,d2                   ; d2 = height << 6   (d4 free after this)
        move.w  d6,d3
        lsr.w   #1,d3                   ; d3 = rowbytes / 2
        or.w    d3,d2                   ; d2.w = BLTSIZE

        ; ── BG modulo (BLTAMOD): GFXBPR - rowbytes (non-interleaved source) ──
        move.w  #GFXBPR,d4
        sub.w   d6,d4                   ; d4.w = GFXBPR - rowbytes (d6 free after this)

        ; ── Screen modulo (BLTDMOD): GFXIBPR - rowbytes (interleaved dest) ───
        move.w  #GFXIBPR,d3
        sub.w   d6,d3                   ; d3.w = GFXIBPR - rowbytes

        ; ── Pixel byte offsets: two separate values for BG and screen ─────────
        asr.l   #3,d0                   ; d0 = x / 8  (signed; same for both)
        move.l  d1,d6                   ; d6 = y  (save before multiply)
        muls.w  #GFXIBPR,d1            ; d1 = y * GFXIBPR  (screen offset, interleaved)
        add.l   d0,d1                   ; d1 = y*GFXIBPR + x/8
        muls.w  #GFXBPR,d6             ; d6 = y * GFXBPR   (BG offset, non-interleaved)
        add.l   d0,d6                   ; d6 = y*GFXBPR + x/8

        ; ── Loop over all bitplanes ───────────────────────────────────────────
        move.l  _bg_bpl_ptr,a0          ; a0 = background plane-0 data start
        move.l  _back_planes_ptr,a1     ; a1 = back buffer plane-0 start
        moveq   #GFXDEPTH-1,d5         ; d5 = plane loop counter

.plane_loop:
        jsr     _WaitBlit               ; wait for previous blit to finish (trashes d0)

        move.w  #$09F0,BLTCON0(a5)      ; USEA | USED, minterm $F0: D = A (copy)
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        move.w  d4,BLTAMOD(a5)          ; BG source modulo (non-interleaved: GFXBPR-rowbytes)
        move.w  d3,BLTDMOD(a5)          ; screen dest modulo (interleaved: GFXIBPR-rowbytes)

        ; A = background plane N at (x, y) — non-interleaved BG image
        move.l  a0,d0
        add.l   d6,d0                   ; d0 = bg_plane_N + y*GFXBPR + x/8
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; D = back buffer plane N at (x, y) — interleaved screen
        move.l  a1,d0
        add.l   d1,d0                   ; d0 = screen_plane_N + y*GFXIBPR + x/8
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)          ; write BLTSIZE → start blit

        add.l   #GFXPSIZE,a0            ; advance to next bg plane (non-interleaved)
        add.l   #GFXBPR,a1             ; advance to next screen plane (interleaved)
        dbra    d5,.plane_loop

.bg_done:
        movem.l (sp)+,d0-d6/a0-a2
        rts


; ── _BltBobMasked / _BltBobMaskedFrame ───────────────────────────────────────
;
; Blits one frame of a masked bob sprite to the current back buffer.
;
; _BltBobMasked      — draws frame 0, backward-compatible entry (ignores d2)
; _BltBobMaskedFrame — draws frame d2 (0 = first frame / non-animated)
;
; 4-channel blitter operation per bitplane:
;   A = mask  (1bpp: 1 = opaque, 0 = transparent) — same mask for every frame
;   B = bob   (bitplane data — frame offset applied)
;   C = D     (back buffer bitplane)
;   Minterm $CA: D = A ? B : C
;   BLTCON0 = $0FCA  (USEA | USEB | USEC | USED)
;
; The mask is NOT advanced by frame offset — the same mask silhouette applies
; to all frames.  For different per-frame silhouettes, use separate images.
;
; Args (_BltBobMasked):      a0=imgptr, a1=maskptr, d0=x, d1=y
; Args (_BltBobMaskedFrame): same + d2.l=frame (0 = first frame)
;
; Trashes: nothing (saves/restores d0-d7/a0-a3)

        XDEF    _BltBobMasked
        XDEF    _BltBobMaskedFrame

_BltBobMasked:
        clr.l   d2                      ; frame 0 — fall through

_BltBobMaskedFrame:
        movem.l d0-d7/a0-a3,-(sp)

        ; ── Read 8-byte image header ──────────────────────────────────────────
        move.w  (a0)+,d3                ; d3.w = width  (scratch for frame offset below)
        move.w  (a0)+,d4                ; d4.w = height
        move.w  (a0)+,d5                ; d5.w = depth  ($8000 flag set for .iraw interleaved)
        move.w  (a0)+,d6                ; d6.w = rowbytes
        btst    #15,d5                  ; test interleaved flag (bit 15 = .iraw)
        bne.w   .bob_interleaved        ; → 1-blit masked path
        ; Skip palette: (1 << depth) * 2 bytes
        moveq   #1,d7
        lsl.l   d5,d7                   ; d7 = 1 << depth
        add.l   d7,d7                   ; d7 = palette bytes
        add.l   d7,a0                   ; a0 = bitplane-0 data start (frame 0)

        ; ── Plane size = height × rowbytes ────────────────────────────────────
        move.w  d4,d7
        mulu.w  d6,d7                   ; d7.l = plane_size

        ; ── Bounds check — skip if any edge is outside the overscan buffer ──────
        ; d3 (pixel width from header) is still valid here — used as scratch
        ; for the frame-offset calculation AFTER this check.
        ; a2 is free at this point; use it as scratch for x+width / y+height.
        cmp.l   #-GFXBORDER,d0
        blt.w   .bob_done               ; x < -GFXBORDER
        cmp.l   #-GFXBORDER,d1
        blt.w   .bob_done               ; y < -GFXBORDER
        move.l  d0,a2
        add.w   d3,a2                   ; a2 = x + pixel_width
        cmpa.l  #(GFXWIDTH+GFXBORDER),a2
        bgt.w   .bob_done               ; x + width > GFXWIDTH+GFXBORDER
        move.l  d1,a2
        add.w   d4,a2                   ; a2 = y + height
        cmpa.l  #(GFXHEIGHT+GFXBORDER),a2
        bgt.w   .bob_done               ; y + height > GFXHEIGHT+GFXBORDER

        ; ── Frame offset = d2 × depth × plane_size ───────────────────────────
        ; Uses d3 (width, no longer needed after bounds check) as scratch.
        ; frame_size = depth × plane_size  (must fit in 16 bits)
        move.w  d5,d3                   ; d3.w = depth
        mulu.w  d7,d3                   ; d3.l = depth × plane_size = frame_size_bytes
        mulu.w  d2,d3                   ; d3.l = frame × frame_size_bytes = frame_offset
        add.l   d3,a0                   ; a0 = bitplane-0 data start for frame d2

        ; ── BLTSIZE = (height << 6) | (rowbytes / 2) ─────────────────────────
        move.w  d4,d2
        lsl.w   #6,d2
        move.w  d6,d3
        lsr.w   #1,d3
        or.w    d3,d2                   ; d2.w = BLTSIZE

        ; ── C/D modulo = GFXIBPR − rowbytes (interleaved: skip other planes' rows) ─
        move.w  #GFXIBPR,d3
        sub.w   d6,d3                   ; d3.w = screen modulo

        ; ── Dest base: _back_planes_ptr + y*GFXBPR + x/8 ─────────────────────
        move.l  _back_planes_ptr,a2
        muls.w  #GFXIBPR,d1            ; d1 = y * GFXIBPR (interleaved row stride)
        add.l   d1,a2
        asr.l   #3,d0                   ; d0 = x / 8  (signed: handles negative x)
        add.l   d0,a2                   ; a2 = dest at (x,y) in plane-0

        ; ── Plane loop ────────────────────────────────────────────────────────
        subq.w  #1,d5                   ; depth − 1 for dbra

.plane_loop:
        jsr     _WaitBlit               ; wait for previous blit (trashes d0)

        move.w  #$0FCA,BLTCON0(a5)      ; USEA|USEB|USEC|USED, minterm $CA (D=A?B:C)
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        clr.w   BLTAMOD(a5)             ; mask: packed rows, no gap
        clr.w   BLTBMOD(a5)             ; bob:  packed rows, no gap
        move.w  d3,BLTCMOD(a5)          ; screen: full-width rows
        move.w  d3,BLTDMOD(a5)

        ; A = mask (same 1bpp mask for all planes; a1 does NOT advance)
        move.l  a1,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; B = bob bitplane N (frame-adjusted)
        move.l  a0,d0
        swap    d0
        move.w  d0,BLTBPTH(a5)
        swap    d0
        move.w  d0,BLTBPTL(a5)

        ; C = D = screen destination plane N at (x, y)
        move.l  a2,d0
        swap    d0
        move.w  d0,BLTCPTH(a5)
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTCPTL(a5)
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)          ; write BLTSIZE → start blit

        add.l   d7,a0                   ; advance to next bob bitplane (non-interleaved)
        add.l   #GFXBPR,a2             ; advance to next screen plane (interleaved)

        dbra    d5,.plane_loop

; ── _BltBobMaskedFrame — interleaved 1-blit path (.iraw + .imask) ────────────
;
; Entered when bit 15 of the header depth word is set (source is a .iraw file).
; The mask at a1 must be .imask format: each row repeated depth times so that
; BLTAMOD=0 feeds the correct mask bits for every plane-row.
;
; All depth × height plane-rows are packed (interleaved) in both source and mask,
; so a single 4-channel blit handles all planes at once:
;
;   BLTCON0  = $0FCA  (USEA|USEB|USEC|USED, minterm $CA: D = A ? B : C)
;   BLTAMOD  = 0     (mask interleaved: depth copies of each row, packed)
;   BLTBMOD  = 0     (bob interleaved: plane-rows packed)
;   BLTCMOD  = BLTDMOD = GFXBPR - rowbytes  (advance to next plane-row in screen)
;   BLTSIZE  = (height × depth) << 6 | (rowbytes / 2)
;
; Constraint: height × depth ≤ 1023 (sufficient for all sprite sizes).

.bob_interleaved:
        and.w   #$7FFF,d5               ; clear interleaved flag — d5 = actual depth

        ; Skip palette: (1 << depth) * 2 bytes
        moveq   #1,d7
        lsl.l   d5,d7                   ; d7 = 1 << depth
        add.l   d7,d7                   ; d7 = palette bytes
        add.l   d7,a0                   ; a0 = interleaved plane data start (frame 0)

        ; Plane size for frame offset = height × rowbytes
        move.w  d4,d7
        mulu.w  d6,d7                   ; d7.l = plane_size

        ; Bounds check (same conditions as non-interleaved path)
        cmp.l   #-GFXBORDER,d0
        blt.w   .bob_done
        cmp.l   #-GFXBORDER,d1
        blt.w   .bob_done
        move.l  d0,a2
        add.w   d3,a2                   ; a2 = x + pixel_width
        cmpa.l  #(GFXWIDTH+GFXBORDER),a2
        bgt.w   .bob_done
        move.l  d1,a2
        add.w   d4,a2                   ; a2 = y + height
        cmpa.l  #(GFXHEIGHT+GFXBORDER),a2
        bgt.w   .bob_done

        ; Frame offset = frame × depth × plane_size
        move.w  d5,d3                   ; d3 = depth
        mulu.w  d7,d3                   ; d3 = depth × plane_size = frame_size
        mulu.w  d2,d3                   ; d3 = frame × frame_size = frame_offset
        add.l   d3,a0                   ; a0 = frame N interleaved data start

        ; BLTSIZE = (height × depth) << 6 | (rowbytes / 2)
        move.w  d4,d2
        mulu.w  d5,d2                   ; d2.l = height × depth
        lsl.w   #6,d2                   ; d2 = (height × depth) << 6
        move.w  d6,d3
        lsr.w   #1,d3                   ; d3 = rowbytes / 2
        or.w    d3,d2                   ; d2.w = BLTSIZE

        ; BLTCMOD = BLTDMOD = GFXBPR - rowbytes
        ; Advances C and D pointers to the next plane-row in the interleaved screen.
        move.w  #GFXBPR,d3
        sub.w   d6,d3                   ; d3.w = screen modulo

        ; Destination = _back_planes_ptr + y*GFXIBPR + x/8  (plane-0 of row y)
        move.l  _back_planes_ptr,a2
        muls.w  #GFXIBPR,d1             ; d1 = y × GFXIBPR
        add.l   d1,a2
        asr.l   #3,d0                   ; d0 = x / 8
        add.l   d0,a2                   ; a2 = screen plane-0 at (x, y)

        ; 1 single masked blit — all depth planes simultaneously
        jsr     _WaitBlit

        move.w  #$0FCA,BLTCON0(a5)      ; USEA|USEB|USEC|USED, minterm $CA: D = A?B:C
        clr.w   BLTCON1(a5)
        move.w  #$FFFF,BLTAFWM(a5)
        move.w  #$FFFF,BLTALWM(a5)
        clr.w   BLTAMOD(a5)             ; mask interleaved: depth copies per row, packed
        clr.w   BLTBMOD(a5)             ; bob interleaved: plane-rows packed
        move.w  d3,BLTCMOD(a5)          ; GFXBPR - rowbytes
        move.w  d3,BLTDMOD(a5)          ; GFXBPR - rowbytes

        ; A = mask  (interleaved .imask, same pointer for all planes — a1 unchanged)
        move.l  a1,d0
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; B = bob pixels  (interleaved, frame-adjusted — a0 = frame N start)
        move.l  a0,d0
        swap    d0
        move.w  d0,BLTBPTH(a5)
        swap    d0
        move.w  d0,BLTBPTL(a5)

        ; C = D = screen destination plane-0 at (x, y)
        move.l  a2,d0
        swap    d0
        move.w  d0,BLTCPTH(a5)
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTCPTL(a5)
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)          ; triggers the blit (all planes in one pass)

.bob_done:
        movem.l (sp)+,d0-d7/a0-a3
        rts
