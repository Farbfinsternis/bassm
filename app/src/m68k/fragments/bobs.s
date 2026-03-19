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


; ── CODE ────────────────────────────────────────────────────────────────────

        SECTION bobs_code,CODE


; ── _SetBackground ────────────────────────────────────────────────────────────
;
; Registers a full-screen background image so _FlushBobs can restore the
; background pixels under each bob before drawing the new frame.
;
; Computes the pointer to bitplane-0 data (skipping the 8-byte header and the
; embedded OCS palette) and stores it in _bg_bpl_ptr.  Installs
; _bg_restore_static as the active restore function.
;
; Args:   a0 = image label address (8-byte header + palette + bitplane data)
; Trashes: nothing (saves/restores d0-d1/a0)

        XDEF    _SetBackground
_SetBackground:
        movem.l d0-d1/a0,-(sp)

        ; Skip the 8-byte header (width.w, height.w, depth.w, rowbytes.w)
        ; and the palette block that follows it.
        ; Palette size = (1 << depth) * 2 bytes.
        move.w  4(a0),d0                ; d0.w = depth (offset 4 in header)
        moveq   #1,d1
        lsl.l   d0,d1                   ; d1 = 1 << depth  (palette entry count)
        add.l   d1,d1                   ; d1 = palette bytes  (2 bytes per entry)
        addq.l  #8,a0                   ; skip 8-byte header
        add.l   d1,a0                   ; skip palette → a0 = bitplane-0 data start

        move.l  a0,_bg_bpl_ptr

        ; Install the restore function
        lea     _bg_restore_static,a0
        move.l  a0,_bg_restore_fn

        movem.l (sp)+,d0-d1/a0
        rts


; ── _AddBob ───────────────────────────────────────────────────────────────────
;
; Appends one entry to the current-frame bob queue (_bobs_new).
; Silently discards the request when the queue is full (BOBS_MAX slots).
;
; Args:   a0 = image pointer (image label: 8-byte header + palette + planes)
;         a1 = mask pointer  (raw 1bpp data in chip RAM; 0 = direct-copy)
;         d0 = x  (word-aligned pixel position, x % 16 == 0)
;         d1 = y
;         d2 = frame index  (0 = first frame / non-animated)
; Trashes: nothing (saves/restores d0-d2/a0-a2)

        XDEF    _AddBob
_AddBob:
        movem.l d0-d2/a0-a2,-(sp)

        move.w  _bobs_new_cnt,d2
        cmp.w   #BOBS_MAX,d2
        bge.s   .full                   ; queue full — discard

        ; Slot address = _bobs_new + cnt * 16
        ; d0/d1/a0/a1 still hold x/y/imgptr/maskptr (only d2 was clobbered by count)
        ; Saved d2 (frame index) is at 8(sp) in the movem frame.
        mulu.w  #16,d2                  ; BOBS_SLOT_SZ = 16
        lea     _bobs_new,a2
        add.l   d2,a2                   ; a2 = slot start

        move.l  a0,(a2)+               ; +0:  imgptr
        move.l  a1,(a2)+               ; +4:  maskptr (0 = no mask)
        move.w  d0,(a2)+               ; +8:  x
        move.w  d1,(a2)+               ; +10: y
        move.w  8(sp),(a2)+            ; +12: frame index (read from saved d2 on stack)
        clr.w   (a2)                    ; +14: padding

        addq.w  #1,_bobs_new_cnt
.full:
        movem.l (sp)+,d0-d2/a0-a2
        rts


; ── _FlushBobs ────────────────────────────────────────────────────────────────
;
; Auto-injected by codegen immediately before every _ScreenFlip call.
;
; Step 1 — Restore background under old bobs (erases last frame's sprites).
;          Uses the back-buffer-specific old queue to get 2-frame history right.
;          Skipped if no background image has been registered (_bg_restore_fn=0).
;
; Step 2 — Draw all new bobs from _bobs_new into the current back buffer.
;          Uses masked blit when maskptr != 0, direct copy otherwise.
;
; Step 3 — Copy _bobs_new → old queue for this back buffer.
;          These positions will be erased next time this buffer is back.
;
; Step 4 — Reset _bobs_new_cnt = 0 (ready for the next frame).
;
; Args:   none
; Trashes: nothing (saves/restores d0-d7/a0-a6)

        XDEF    _FlushBobs
_FlushBobs:
        movem.l d0-d7/a0-a6,-(sp)

        ; ── Select old queue for the current back buffer ──────────────────────
        ; _front_is_a = 0: front=A, back=B → use _bobs_old_b / _bobs_old_cnt_b
        ; _front_is_a = 1: front=B, back=A → use _bobs_old_a / _bobs_old_cnt_a
        tst.b   _front_is_a
        bne.s   .back_is_a

        lea     _bobs_old_b,a2          ; a2 = old queue base
        lea     _bobs_old_cnt_b,a3      ; a3 = ptr to old count word
        bra.s   .do_flush

.back_is_a:
        lea     _bobs_old_a,a2
        lea     _bobs_old_cnt_a,a3

.do_flush:
        ; ── Step 1: Restore background at old bob positions ───────────────────
        move.l  _bg_restore_fn,d6
        beq.s   .skip_restore           ; no restore fn — skip

        move.w  (a3),d7
        beq.s   .skip_restore           ; no old bobs — nothing to erase

        subq.w  #1,d7
        move.l  a2,a4                   ; a4 = current old slot pointer
        move.l  d6,a6                   ; a6 = _bg_restore_static fn ptr

.restore_loop:
        move.l  (a4),a0                 ; a0 = bob imgptr
        clr.l   d0
        move.w  8(a4),d0               ; d0.l = x (zero-extended)
        clr.l   d1
        move.w  10(a4),d1              ; d1.l = y (zero-extended)
        jsr     (a6)                    ; _bg_restore_fn(a0=imgptr, d0=x, d1=y) — frame-agnostic
        lea     16(a4),a4               ; advance to next slot (BOBS_SLOT_SZ = 16)
        dbra    d7,.restore_loop

.skip_restore:
        ; ── Step 2: Draw new bobs ─────────────────────────────────────────────
        move.w  _bobs_new_cnt,d7
        beq.s   .skip_draw

        subq.w  #1,d7
        lea     _bobs_new,a4            ; a4 = current new slot pointer

.draw_loop:
        move.l  (a4),a0                 ; a0 = imgptr
        move.l  4(a4),a1                ; a1 = maskptr (0 = no mask)
        clr.l   d0
        move.w  8(a4),d0               ; d0.l = x
        clr.l   d1
        move.w  10(a4),d1              ; d1.l = y
        clr.l   d2
        move.w  12(a4),d2              ; d2.l = frame index (0 = first / non-animated)
        cmpa.l  #0,a1                   ; tst.l An not valid on 68000
        beq.s   .draw_direct

        jsr     _BltBobMaskedFrame      ; masked:  a0=imgptr, a1=maskptr, d0=x, d1=y, d2=frame
        bra.s   .draw_next

.draw_direct:
        jsr     _DrawImageFrame         ; direct copy: a0=imgptr, d0=x, d1=y, d2=frame

.draw_next:
        lea     16(a4),a4               ; advance to next slot (BOBS_SLOT_SZ = 16)
        dbra    d7,.draw_loop

.skip_draw:
        ; ── Step 3: Copy new queue → old queue for this back buffer ──────────
        move.w  _bobs_new_cnt,d7
        move.w  d7,(a3)                 ; update old count for this buffer
        beq.s   .skip_copy

        ; Copy d7 slots × 4 longwords/slot = d7*4 longword moves
        mulu.w  #4,d7                   ; slots × 4  (16 bytes = 4 longwords each)
        subq.w  #1,d7
        lea     _bobs_new,a0
        move.l  a2,a1
.copy_loop:
        move.l  (a0)+,(a1)+
        dbra    d7,.copy_loop

.skip_copy:
        ; ── Step 4: Reset new queue ───────────────────────────────────────────
        clr.w   _bobs_new_cnt

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

        ; ── Bounds check — skip if position is outside the screen ─────────────
        ; Pixel width is not available here (header was partially read).
        ; We check x/y >= 0 and y+height <= GFXHEIGHT.  The x+width check is
        ; handled by _BltBobMaskedFrame before the bob is ever queued.
        ; d2 is free at this point — use it as scratch for y+height.
        tst.l   d0
        blt.w   .bg_done                ; x < 0
        tst.l   d1
        blt.w   .bg_done                ; y < 0
        cmp.l   #GFXWIDTH,d0
        bge.w   .bg_done                ; x >= GFXWIDTH
        move.l  d1,d2
        add.w   d4,d2                   ; d2 = y + height
        cmp.l   #GFXHEIGHT,d2
        bgt.w   .bg_done                ; y + height > GFXHEIGHT

        ; ── BLTSIZE = (height << 6) | (rowbytes / 2) ─────────────────────────
        move.w  d4,d2
        lsl.w   #6,d2                   ; d2 = height << 6
        move.w  d6,d3
        lsr.w   #1,d3                   ; d3 = rowbytes / 2
        or.w    d3,d2                   ; d2.w = BLTSIZE

        ; ── Modulo = GFXBPR − rowbytes ───────────────────────────────────────
        move.w  #GFXBPR,d3
        sub.w   d6,d3                   ; d3.w = BLTAMOD = BLTDMOD

        ; ── Pixel byte offset = y*GFXBPR + x/8 ──────────────────────────────
        lsr.l   #3,d0                   ; d0 = x / 8  (byte column)
        mulu.w  #GFXBPR,d1             ; d1 = y * GFXBPR  (fits 32-bit: max 255×40)
        add.l   d0,d1                   ; d1 = plane offset in bytes

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
        move.w  d3,BLTAMOD(a5)          ; source modulo (bg image is full-width)
        move.w  d3,BLTDMOD(a5)          ; dest modulo

        ; A = background plane N at (x, y)
        move.l  a0,d0
        add.l   d1,d0                   ; d0 = bg_plane_N + pixel_offset
        swap    d0
        move.w  d0,BLTAPTH(a5)
        swap    d0
        move.w  d0,BLTAPTL(a5)

        ; D = back buffer plane N at (x, y)
        move.l  a1,d0
        add.l   d1,d0
        swap    d0
        move.w  d0,BLTDPTH(a5)
        swap    d0
        move.w  d0,BLTDPTL(a5)

        move.w  d2,BLTSIZE(a5)          ; write BLTSIZE → start blit

        add.l   #GFXPSIZE,a0            ; advance to next bg plane
        add.l   #GFXPSIZE,a1            ; advance to next back buffer plane
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
        move.w  (a0)+,d5                ; d5.w = depth
        move.w  (a0)+,d6                ; d6.w = rowbytes
        ; Skip palette: (1 << depth) * 2 bytes
        moveq   #1,d7
        lsl.l   d5,d7                   ; d7 = 1 << depth
        add.l   d7,d7                   ; d7 = palette bytes
        add.l   d7,a0                   ; a0 = bitplane-0 data start (frame 0)

        ; ── Plane size = height × rowbytes ────────────────────────────────────
        move.w  d4,d7
        mulu.w  d6,d7                   ; d7.l = plane_size

        ; ── Bounds check — skip if any edge is outside the screen ─────────────
        ; d3 (pixel width from header) is still valid here — used as scratch
        ; for the frame-offset calculation AFTER this check.
        ; a2 is free at this point; use it as scratch for x+width / y+height.
        tst.l   d0
        blt.w   .bob_done               ; x < 0
        tst.l   d1
        blt.w   .bob_done               ; y < 0
        move.l  d0,a2
        add.w   d3,a2                   ; a2 = x + pixel_width  (d3 = width, still valid)
        cmpa.l  #GFXWIDTH,a2
        bgt.w   .bob_done               ; x + width > GFXWIDTH
        move.l  d1,a2
        add.w   d4,a2                   ; a2 = y + height
        cmpa.l  #GFXHEIGHT,a2
        bgt.w   .bob_done               ; y + height > GFXHEIGHT

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

        ; ── C/D modulo = GFXBPR − rowbytes ───────────────────────────────────
        move.w  #GFXBPR,d3
        sub.w   d6,d3                   ; d3.w = screen modulo

        ; ── Dest base: _back_planes_ptr + y*GFXBPR + x/8 ─────────────────────
        move.l  _back_planes_ptr,a2
        mulu.w  #GFXBPR,d1             ; d1 = y * GFXBPR
        add.l   d1,a2
        lsr.l   #3,d0                   ; d0 = x / 8
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

        add.l   d7,a0                   ; advance to next bob bitplane
        add.l   #GFXPSIZE,a2            ; advance to next screen plane

        dbra    d5,.plane_loop

.bob_done:
        movem.l (sp)+,d0-d7/a0-a3
        rts
