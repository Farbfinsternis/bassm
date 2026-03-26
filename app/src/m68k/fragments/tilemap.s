; ============================================================================
; tilemap.s — BASSM Tilemap Scrolling
; ============================================================================
;
; PURPOSE
;   Provides hardware-scrolled tilemap backgrounds for the Blitz2D commands:
;
;     _DrawTilemap        — render visible tile columns into the back buffer
;     _bg_restore_tilemap — redraw tiles under a bob (used by _FlushBobs)
;
; BLITZ2D SYNTAX
;   LoadTileset 0, "tiles.iraw", 16, 16
;   LoadTilemap 0, "world.bmap"
;   SetTilemap 0, 0                       ; register as bob background
;   DrawTilemap 0, 0, scrollX             ; render visible portion
;
; TILESET FORMAT
;   Standard .iraw file (interleaved bitplanes), identical to LoadAnimImage.
;   Header: dc.w tile_w, tile_h, GFXDEPTH+$8000, rowbytes
;   Tiles stacked vertically: frame N = tile N.
;   _DrawImageFrame(a0=tileset, d0=x, d1=y, d2=tile_idx) draws one tile.
;
; TILEMAP FORMAT (.bmap)
;   8-byte header followed by tile-index words (0-based, row-major):
;     +0  dc.w  map_width      (tiles across)
;     +2  dc.w  map_height     (tiles down)
;     +4  dc.w  tile_w         (pixels)
;     +6  dc.w  tile_h         (pixels)
;     +8  dc.w  tile_index[0]  ... tile_index[map_width * map_height - 1]
;
; SCROLLING TECHNIQUE
;   Coarse scroll: _DrawTilemap selects visible tile columns from the map.
;   Fine scroll:   BPLCON1 ($DFF102) shifts the display 0..tile_w-1 pixels.
;   Phase 1 redraws all visible tiles every frame (~336 blits for 16px tiles).
;   PERF-J will add screen-to-screen blit to reduce this to ~20 blits.
;
;   Each call patches the BACK copper list (not hardware registers directly):
;     - BPLCON1  = (fine_x << 4) | fine_x  — fine scroll for both playfields
;     - DDFSTRT  = $0030  — fetch 336px (one extra word = 16px scroll headroom)
;     - BPL1MOD/BPL2MOD = GFXBPLMOD-2  — compensate for extra fetched bytes
;     - BPLxPT (via _PatchBitplanePtrs) = back_planes_ptr-2  — 16px left shift
;   The patches take effect when ScreenFlip activates the back copper list.
;
;   Display geometry with DDFSTRT=$0030 and BPL starting 2 bytes early:
;     - Fetch covers vis_orig-16 to vis_orig+319 (336 pixels)
;     - First 16 pixels are left of display window → invisible
;     - With BPLCON1=N: display beam X shows vis_orig + X + N
;     - So BPLCON1=fine_x scrolls the viewport right by fine_x pixels ✓
;
; BACKGROUND RESTORE
;   _bg_restore_tilemap replaces _bg_restore_static when SetTilemap is called.
;   It redraws only the tiles overlapping the bob's bounding box — typically
;   2x2 = 4 tiles for a 16x16 bob on a 16x16 tile grid.
;
; DEPENDENCY
;   startup.s  — Blitter EQUs, _WaitBlit, _back_planes_ptr, _front_is_a, a5=$DFF000.
;   graphics.s — _PatchBitplanePtrs, _gfx_copper_a/b, _gfx_cop_a/b_bpl_table.
;   image.s    — _DrawImageFrame (blits one tile per call).
;   codegen.js — GFXWIDTH, GFXHEIGHT, GFXDEPTH, GFXBPR, GFXBPLMOD, GFXIBPR.
;   bobs.s     — _bg_restore_fn, _active_tilemap_ptr, _active_tileset_ptr,
;                _active_scroll_x (BSS, emitted by codegen into user_vars).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION tilemap_code,CODE


; ── _DrawTilemap ─────────────────────────────────────────────────────────────
;
; Renders the visible portion of a tilemap into the current back buffer.
; Coarse-scrolls by selecting tile columns; fine-scrolls by patching BPLCON1
; and related registers in the back copper list.
;
; Args:   a0   = tilemap pointer (8-byte header + tile-index array)
;         a1   = tileset pointer (image header, as _DrawImageFrame expects)
;         d0.l = scrollX (pixels, 0 .. map_width*tile_w - 1)
; Trashes: nothing (saves/restores d0-d7/a0-a4)
;
; ── COPPER LIST LAYOUT (offsets from _gfx_copper_X base) ────────────────────
;   Each copper MOVE instruction = 4 bytes: dc.w reg_addr, value
;   Offset  0: DIWSTRT  (value at +2)
;   Offset  4: DIWSTOP  (value at +6)
;   Offset  8: DDFSTRT  (value at +10)  ← patched to $0030
;   Offset 12: DDFSTOP  (value at +14)
;   Offset 16: BPLCON0  (value at +18)
;   Offset 20: BPLCON1  (value at +22)  ← patched to (fine_x<<4)|fine_x
;   Offset 24: BPLCON2  (value at +26)
;   Offset 28: BPL1MOD  (value at +30)  ← patched to GFXBPLMOD-2
;   Offset 32: BPL2MOD  (value at +34)  ← patched to GFXBPLMOD-2
;   Offset 36: _gfx_cop_X_bpl_table     ← BPLxPT entries re-patched via fn
;
; ── STACK LAYOUT DURING TILE LOOP ────────────────────────────────────────────
;   0(sp) = tile_rows_draw (word, counts down)
;   2(sp) = tile_cols_draw (word, constant)
;   4(sp) = first_col      (word, constant — reset map_col at start of each row)
;   [saved d0-d7/a0-a4 below]

        XDEF    _DrawTilemap

_DrawTilemap:
        movem.l d0-d7/a0-a4,-(sp)

        ; ── Save arguments ──────────────────────────────────────────────────
        move.l  a1,a2           ; a2 = tileset ptr (constant throughout)
        move.l  a0,a3           ; a3 = tilemap base (header at +0)

        ; ── Compute first_col and fine_x ────────────────────────────────────
        ; d0.l = scrollX; d3.w = tile_w (from header +4)
        move.w  4(a3),d3        ; d3.w = tile_w
        divu.w  d3,d0           ; d0 low.w = first_col, d0 high.w = fine_x
        move.w  d0,d6           ; d6.w = first_col (save before swap)
        swap    d0              ; d0.w = fine_x

        ; ── Patch back copper list ──────────────────────────────────────────
        ; _front_is_a = 0 → front=A, back=B;  _front_is_a = 1 → front=B, back=A
        tst.b   _front_is_a
        bne.s   .cop_a

        lea     _gfx_copper_b,a0
        lea     _gfx_cop_b_bpl_table,a1
        bra.s   .cop_patch

.cop_a:
        lea     _gfx_copper_a,a0
        lea     _gfx_cop_a_bpl_table,a1

.cop_patch:
        ; BPLCON1 = (fine_x << 4) | fine_x  (same scroll for odd and even planes)
        move.w  d0,d1
        lsl.w   #4,d1
        or.w    d0,d1
        move.w  d1,22(a0)       ; patch BPLCON1 value word (offset 22)

        ; DDFSTRT = $0030 — fetch 21 words (336px) instead of 20 (320px)
        move.w  #$0030,10(a0)   ; patch DDFSTRT value word (offset 10)

        ; BPL1MOD/BPL2MOD = GFXBPLMOD-2 — compensate for 2 extra fetched bytes
        move.w  #(GFXBPLMOD-2),30(a0)  ; BPL1MOD value (offset 30)
        move.w  #(GFXBPLMOD-2),34(a0)  ; BPL2MOD value (offset 34)

        ; BPLxPT: start 2 bytes (16 pixels) earlier for scroll headroom.
        ; Re-use _PatchBitplanePtrs with adjusted base pointer.
        ; NOTE: _PatchBitplanePtrs trashes d0-d3 — header re-read follows.
        move.l  a1,a0                   ; a0 = _gfx_cop_X_bpl_table
        move.l  _back_planes_ptr,a1
        subq.l  #2,a1                   ; start 16 pixels (2 bytes) earlier
        moveq   #GFXDEPTH,d0
        move.l  #GFXBPR,d1
        jsr     _PatchBitplanePtrs      ; trashes d0-d3

        ; ── Re-read tilemap header (d3 trashed above) ───────────────────────
        move.w  (a3),d5         ; d5.w = map_w
        move.w  4(a3),d3        ; d3.w = tile_w
        move.w  6(a3),d4        ; d4.w = tile_h

        ; ── Compute tile_cols_draw = GFXWIDTH / tile_w + 2 ─────────────────
        ; +2: one partial tile on each edge, ensuring full coverage at any fine_x
        moveq   #0,d0
        move.w  #GFXWIDTH,d0
        divu.w  d3,d0           ; d0.w = GFXWIDTH / tile_w
        addq.w  #2,d0           ; d0.w = tile_cols_draw

        ; ── Compute tile_rows_draw = min(GFXHEIGHT / tile_h, map_h) ─────────
        moveq   #0,d1
        move.w  #GFXHEIGHT,d1
        divu.w  d4,d1           ; d1.w = GFXHEIGHT / tile_h
        cmp.w   2(a3),d1        ; compare with map_h
        ble.s   .rows_fit
        move.w  2(a3),d1        ; clamp to map_h if map is shorter than screen
.rows_fit:

        ; ── Push loop constants to stack ────────────────────────────────────
        move.w  d6,-(sp)        ; 4(sp) = first_col
        move.w  d0,-(sp)        ; 2(sp) = tile_cols_draw
        move.w  d1,-(sp)        ; 0(sp) = tile_rows_draw (counts down)

        ; ── Set up tile data pointer and initial state ───────────────────────
        lea     8(a3),a3        ; a3 = tilemap data base (skip 8-byte header)
        move.l  a3,a4           ; a4 = current row base pointer (row 0 = first row)
        moveq   #0,d1           ; d1.l = screen_y = 0

; ════════════════════ Outer loop (rows) ═════════════════════════════════════
.row_loop:
        subq.w  #1,(sp)         ; decrement tile_rows_draw
        bmi.w   .done           ; all rows rendered → exit

        ; Initialise inner loop state for this row
        move.w  2(sp),d7        ; d7 = tile_cols_draw
        subq.w  #1,d7           ; adjust for dbra (executes tile_cols_draw times)
        move.w  4(sp),d6        ; d6.w = first_col → initial map_col
        moveq   #0,d0           ; d0.l = screen_x = 0

; ──────────────────── Inner loop (columns) ───────────────────────────────────
.col_loop:
        ; ── Load tile index: word at row_base + map_col * 2 ─────────────────
        move.w  d6,d2
        add.w   d2,d2           ; d2.w = map_col * 2  (byte offset within row)
        move.w  0(a4,d2.w),d2   ; d2.w = tile index (0-based, unsigned)
        ; Upper word of d2 irrelevant — _DrawImageFrame uses mulu.w d2 only.

        ; ── _DrawImageFrame(a0=tileset, d0=x, d1=y, d2=tile_idx) ────────────
        ; Saves and restores d0-d7/a0-a3, so all our registers are intact.
        move.l  a2,a0
        jsr     _DrawImageFrame

        ; ── Advance screen position ──────────────────────────────────────────
        add.w   d3,d0           ; screen_x += tile_w  (d0 stays clean: upper=0)

        ; ── Advance map column with wraparound ───────────────────────────────
        addq.w  #1,d6           ; map_col++
        cmp.w   d5,d6           ; map_col >= map_w?
        blt.s   .no_wrap
        moveq   #0,d6           ; wrap: map_col = 0
.no_wrap:
        dbra    d7,.col_loop

; ──────────────────── End inner loop ─────────────────────────────────────────

        ; ── Advance to next tilemap row ──────────────────────────────────────
        add.w   d4,d1           ; screen_y += tile_h  (d1 stays clean: upper=0)

        ; a4 += map_w * 2  (advance row data pointer by one map row)
        move.w  d5,d0           ; d0.w = map_w (d0 upper word = 0 from moveq above)
        add.w   d0,d0           ; d0.w = map_w * 2
        lea     0(a4,d0.w),a4   ; a4 = next row base (sign-extends d0.w; valid for map_w < 16384)

        bra.w   .row_loop

; ════════════════════ Done ══════════════════════════════════════════════════
.done:
        addq.l  #6,sp           ; pop 3 words: first_col + cols_draw + rows_draw
        movem.l (sp)+,d0-d7/a0-a4
        rts


; ── _bg_restore_tilemap ─────────────────────────────────────────────────────
;
; Redraws the tiles that overlap a bob's bounding box.  Installed into
; _bg_restore_fn by the SetTilemap command; called from _FlushBobs.
;
; Args:   a0   = bob imgptr (header: +0 width.w, +2 height.w, +6 rowbytes.w)
;         d0.w = bob screen_x (pixels, relative to visible area)
;         d1.w = bob screen_y (pixels)
; Trashes: nothing (saves/restores d0-d7/a0-a4)
;
; ── SCREEN-TO-TILE MAPPING ───────────────────────────────────────────────────
;   _DrawTilemap blits tile at map column `col` to screen_x = (col-first_col)*tile_w.
;   Fine scroll (BPLCON1) is handled by hardware — we match the same blit positions.
;   k = screen-relative column offset: tile at k covers screen_x k*tile_w..(k+1)*tile_w-1
;   k_left  = screen_x / tile_w
;   k_right = (screen_x + bob_w - 1) / tile_w
;   map_col = (first_col + k) % map_w  (with wraparound)
;
; ── STACK LAYOUT ─────────────────────────────────────────────────────────────
;   0(sp) = k_left      (word)
;   2(sp) = k_right     (word)
;   4(sp) = row_bottom  (word)
;   6(sp) = first_col   (word)
;
; ── LOOP REGISTERS ───────────────────────────────────────────────────────────
;   d7 = current row   (outer; _DrawImageFrame saves/restores → survives calls)
;   d3 = k             (inner; saved/restored by _DrawImageFrame; incr'd after call)
;   d4 = map_w, d5 = tile_w, d6 = tile_h  (permanent)
;   a2 = tileset ptr   (permanent)
;   a3 = tilemap data base (permanent, past 8-byte header)
;   a1 = current row base ptr (updated per outer iteration)

        XDEF    _bg_restore_tilemap

_bg_restore_tilemap:
        movem.l d0-d7/a0-a4,-(sp)

        ; ── Bob bounding box ──────────────────────────────────────────────────
        move.w  (a0),d2         ; d2.w = bob_w
        move.w  2(a0),d3        ; d3.w = bob_h
        ; d0.w = screen_x (zero-extended from caller), d1.w = screen_y

        ; ── Tilemap/tileset pointers ──────────────────────────────────────────
        move.l  _active_tileset_ptr,a2
        move.l  _active_tilemap_ptr,a3

        ; ── Tilemap header ────────────────────────────────────────────────────
        move.w  (a3),d4         ; d4.w = map_w  (permanent)
        move.w  4(a3),d5        ; d5.w = tile_w (permanent)
        move.w  6(a3),d6        ; d6.w = tile_h (permanent)

        ; ── first_col = scroll_x / tile_w ────────────────────────────────────
        moveq   #0,d7
        move.w  _active_scroll_x,d7
        divu.w  d5,d7           ; d7.w = first_col (upper = fine_x, discarded)
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)        ; push first_col → will be at 6(sp)

        ; ── row_bottom = min((screen_y + bob_h - 1) / tile_h, map_h-1) ───────
        moveq   #0,d7
        move.w  d1,d7           ; d7.l = screen_y
        add.w   d3,d7           ; + bob_h
        subq.w  #1,d7           ; - 1
        divu.w  d6,d7           ; d7.w = (screen_y + bob_h - 1) / tile_h
        and.l   #$0000FFFF,d7
        move.w  2(a3),d3        ; d3.w = map_h  (bob_h no longer needed)
        subq.w  #1,d3           ; d3.w = map_h - 1
        cmp.w   d3,d7
        ble.s   .rbr_clamp_ok
        move.w  d3,d7
.rbr_clamp_ok:
        move.w  d7,-(sp)        ; push row_bottom → will be at 4(sp)

        ; ── k_right = (screen_x + bob_w - 1) / tile_w ───────────────────────
        moveq   #0,d7
        move.w  d0,d7           ; d7.l = screen_x
        add.w   d2,d7           ; + bob_w
        subq.w  #1,d7           ; - 1
        divu.w  d5,d7           ; d7.w = k_right
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)        ; push k_right → will be at 2(sp)

        ; ── k_left = screen_x / tile_w ───────────────────────────────────────
        moveq   #0,d7
        move.w  d0,d7           ; d7.l = screen_x
        divu.w  d5,d7           ; d7.w = k_left
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)        ; push k_left → at 0(sp)

        ; Stack layout confirmed:
        ;   0(sp) = k_left, 2(sp) = k_right, 4(sp) = row_bottom, 6(sp) = first_col

        ; ── Advance a3 past header ────────────────────────────────────────────
        lea     8(a3),a3        ; a3 = tilemap data base (permanent)

        ; ── row_top = screen_y / tile_h; init a1 = row_top's row base ─────────
        moveq   #0,d7
        move.w  d1,d7           ; d7.l = screen_y
        divu.w  d6,d7           ; d7.w = row_top
        and.l   #$0000FFFF,d7   ; d7 = row_top (outer loop counter, upper=0)

        move.l  d7,d0           ; d0.l = row_top
        mulu.w  d4,d0           ; d0.l = row_top * map_w
        add.l   d0,d0           ; d0.l = row_top * map_w * 2
        lea     0(a3,d0.l),a1   ; a1 = tilemap data + row_top offset

; ════════════════════ Outer loop (rows) ═════════════════════════════════════
.rbr_row:
        cmp.w   4(sp),d7        ; row > row_bottom?
        bgt.w   .rbr_done

        ; d1.l = screen_y for this row (d7 upper word = 0 guaranteed)
        move.l  d7,d1
        mulu.w  d6,d1           ; d1.l = row * tile_h

        ; d3 = k_left (inner loop counter, zero-extended)
        moveq   #0,d3
        move.w  0(sp),d3

; ──────────────────── Inner loop (columns) ───────────────────────────────────
.rbr_col:
        cmp.w   2(sp),d3        ; k > k_right?
        bgt.s   .rbr_col_done

        ; d0.l = screen_x = k * tile_w
        moveq   #0,d0
        move.w  d3,d0
        mulu.w  d5,d0           ; d0.l = k * tile_w

        ; d2.w = map_col = (first_col + k) % map_w
        move.w  6(sp),d2        ; d2.w = first_col
        add.w   d3,d2           ; d2.w = first_col + k
.rbr_wrap:
        cmp.w   d4,d2           ; col >= map_w?
        blt.s   .rbr_no_wrap
        sub.w   d4,d2           ; col -= map_w
        bra.s   .rbr_wrap
.rbr_no_wrap:
        ; Tile index: word at row_base + col * 2
        add.w   d2,d2           ; col * 2 (byte offset)
        move.w  0(a1,d2.w),d2   ; d2.w = tile index

        ; _DrawImageFrame(a0=tileset, d0=screen_x, d1=screen_y, d2=tile_idx)
        ; Saves/restores d0-d7/a0-a3 → d3(k), d7(row), a1(row_base), a2(tileset) intact.
        move.l  a2,a0
        jsr     _DrawImageFrame

        addq.w  #1,d3           ; k++  (d3 restored to k by _DrawImageFrame; now k+1)
        bra.s   .rbr_col

; ──────────────────── End inner loop ─────────────────────────────────────────
.rbr_col_done:
        addq.w  #1,d7           ; row++

        ; a1 += map_w * 2 (advance to next row data)
        move.w  d4,d0
        add.w   d0,d0           ; map_w * 2
        lea     0(a1,d0.w),a1

        bra.s   .rbr_row

; ════════════════════ Done ══════════════════════════════════════════════════
.rbr_done:
        addq.l  #8,sp           ; pop 4 words (k_left, k_right, row_bottom, first_col)
        movem.l (sp)+,d0-d7/a0-a4
        rts
