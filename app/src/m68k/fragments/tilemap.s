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
;   DrawTilemap 0, 0, scrollX, scrollY    ; render visible portion
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
;   Coarse X: _DrawTilemap selects tile columns by first_col = scrollX / tile_w.
;   Fine  X: BPLCON1 = (fine_x<<4)|fine_x shifts the display 0..tile_w-1 pixels.
;   Coarse Y: _DrawTilemap selects tile rows by first_row = scrollY / tile_h.
;   Fine  Y: BPLxPT base is shifted down by fine_y * GFXBPR bytes.
;            Buffer must be GFXVHEIGHT+GFXVPAD rows tall (GFXBUFSIZE_VSCROLL).
;
;   Phase 1 redraws all visible tiles every frame (~336+ blits for 16px tiles).
;   PERF-J will add screen-to-screen blit to reduce this to ~36 blits (2D).
;
;   Each call patches the BACK copper list (not hardware registers directly):
;     - BPLCON1  = (fine_x << 4) | fine_x  — fine X scroll for both playfields
;     - DDFSTRT  = $0030  — fetch 336px (one extra word = 16px scroll headroom)
;     - BPL1MOD/BPL2MOD = GFXBPLMOD-2  — compensate for extra fetched bytes
;     - BPLxPT (via _PatchBitplanePtrs) = back_planes_ptr - 2 + fine_y*GFXBPR
;   The patches take effect when ScreenFlip activates the back copper list.
;
;   Display geometry with DDFSTRT=$0030 and BPL starting 2 bytes early:
;     - Fetch covers vis_orig-16 to vis_orig+319 (336 pixels)
;     - First 16 pixels are left of display window → invisible
;     - With BPLCON1=N: display beam X shows vis_orig + X + N
;     - So BPLCON1=fine_x scrolls the viewport right by fine_x pixels ✓
;     - With BPLxPT += fine_y*GFXBPR: display row 0 maps to buffer row fine_y ✓
;
; BACKGROUND RESTORE
;   _bg_restore_tilemap replaces _bg_restore_static when SetTilemap is called.
;   It redraws only the tiles overlapping the bob's bounding box — typically
;   2x2 = 4 tiles for a 16x16 bob on a 16x16 tile grid.
;
; DEPENDENCY
;   startup.s  — Blitter EQUs, _WaitBlit, _back_planes_ptr, a5=$DFF000.
;   graphics.s — _PatchBitplanePtrs.
;   codegen.js — _active_cop_base (BSS), VP_COP_* EQUs.
;   image.s    — _DrawImageFrame (blits one tile per call).
;   codegen.js — GFXWIDTH, GFXHEIGHT, GFXDEPTH, GFXBPR, GFXBPLMOD, GFXIBPR.
;   bobs.s     — _bg_restore_fn, _active_tilemap_ptr, _active_tileset_ptr,
;                _active_scroll_x, _active_scroll_y, _active_fine_y
;                (BSS, emitted by codegen into user_vars).
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must not be changed)
; ============================================================================


        SECTION tilemap_code,CODE


; ── _DrawTilemap ─────────────────────────────────────────────────────────────
;
; Renders the visible portion of a tilemap into the current back buffer.
; Coarse X: tile columns selected by first_col = scrollX / tile_w.
; Fine  X: BPLCON1 patched to (fine_x<<4)|fine_x.
; Coarse Y: tile rows selected by first_row = scrollY / tile_h.
; Fine  Y: BPLxPT base shifted by fine_y * GFXBPR bytes downward.
;           Buffer must be at least GFXVHEIGHT+GFXVPAD rows tall (see GFXBUFSIZE_VSCROLL).
;
; Args:   a0   = tilemap pointer (8-byte header + tile-index array)
;         a1   = tileset pointer (image header, as _DrawImageFrame expects)
;         d0.l = scrollX (pixels, 0 .. map_width*tile_w - 1)
;         d1.l = scrollY (pixels, 0 .. map_height*tile_h - 1)
; Trashes: nothing (saves/restores d0-d7/a0-a4)
; Side-effects: writes _active_fine_y (BSS) for use by _FlushBobs.
;
; ── COPPER LIST LAYOUT (offsets from _active_cop_base) ──────────────────────
;   Uses VP_COP_* EQUs (emitted by codegen.js for multi-viewport support):
;   VP_COP_DDFSTRT  EQU  2   ← patched to $0030
;   VP_COP_BPLCON1  EQU 14   ← patched to (fine_x<<4)|fine_x
;   VP_COP_BPL1MOD  EQU 22   ← patched to GFXBPLMOD-2
;   VP_COP_BPL2MOD  EQU 26   ← patched to GFXBPLMOD-2
;   VP_COP_BPL      EQU 28   ← BPLxPT table, re-patched via _PatchBitplanePtrs
;
; ── STACK LAYOUT DURING TILE LOOP ────────────────────────────────────────────
;   0(sp) = tile_rows_draw (word, counts down)
;   2(sp) = tile_cols_draw (word, constant)
;   4(sp) = first_col      (word, constant — map column for screen_x = 0)
;   6(sp) = map_h          (word, constant — for vertical row wraparound)
;   8(sp) = row_idx        (word, counts up from first_row, wraps mod map_h)
;   [saved d0-d7/a0-a4 below]

        XDEF    _DrawTilemap

_DrawTilemap:
        movem.l d0-d7/a0-a4,-(sp)

        ; ── Save arguments ──────────────────────────────────────────────────
        move.l  a1,a2           ; a2 = tileset ptr (constant throughout)
        move.l  a0,a3           ; a3 = tilemap base (header at +0)

        ; ── Compute first_col and fine_x from scrollX (d0) ─────────────────
        move.w  4(a3),d3        ; d3.w = tile_w
        divu.w  d3,d0           ; d0 low.w = first_col, d0 high.w = fine_x
        move.w  d0,d6           ; d6.w = first_col (save before swap)
        swap    d0              ; d0.w = fine_x

        ; ── Compute first_row and fine_y from scrollY (d1) ──────────────────
        move.w  6(a3),d4        ; d4.w = tile_h
        divu.w  d4,d1           ; d1 low.w = first_row, d1 high.w = fine_y
        move.w  d1,d7           ; d7.w = first_row (survives copper patch — d7 not touched)
        swap    d1              ; d1.w = fine_y
        and.l   #$0000FFFF,d1   ; clear garbage upper word
        move.w  d1,_active_fine_y  ; save for _FlushBobs

        ; ── Patch back copper list (via _active_cop_base, set by Viewport N) ──
        move.l  _active_cop_base,a0

        ; BPLCON1 = (fine_x << 4) | fine_x  (same scroll for odd and even planes)
        move.w  d0,d1
        lsl.w   #4,d1
        or.w    d0,d1
        move.w  d1,VP_COP_BPLCON1(a0)

        ; DDFSTRT = $0030 — fetch 21 words (336px) instead of 20 (320px)
        move.w  #$0030,VP_COP_DDFSTRT(a0)

        ; BPL1MOD/BPL2MOD = GFXBPLMOD-2 — compensate for 2 extra fetched bytes
        move.w  #(GFXBPLMOD-2),VP_COP_BPL1MOD(a0)
        move.w  #(GFXBPLMOD-2),VP_COP_BPL2MOD(a0)

        ; BPLxPT: horizontal -2 bytes + vertical fine_y * GFXBPR bytes.
        ; NOTE: _PatchBitplanePtrs trashes d0-d3 — header re-read follows.
        lea     VP_COP_BPL(a0),a0      ; a0 = BPLxPT table in active VP section
        move.l  _back_planes_ptr,a1
        subq.l  #2,a1                   ; horizontal: 16px (2 bytes) left headroom
        moveq   #0,d1                   ; vertical: fine_y * GFXBPR byte offset
        move.w  _active_fine_y,d1       ; d1.w = fine_y (read back from BSS)
        mulu.w  #GFXBPR,d1              ; d1.l = fine_y * GFXBPR
        add.l   d1,a1                   ; a1 += fine_y * GFXBPR
        moveq   #GFXDEPTH,d0
        move.l  #GFXBPR,d1
        jsr     _PatchBitplanePtrs      ; trashes d0-d3

        ; ── Re-read tilemap header (d3/d4 trashed by _PatchBitplanePtrs) ────
        move.w  (a3),d5         ; d5.w = map_w
        move.w  4(a3),d3        ; d3.w = tile_w
        move.w  6(a3),d4        ; d4.w = tile_h

        ; ── Compute tile_cols_draw = GFXWIDTH / tile_w + 2 ─────────────────
        ; +2: one partial tile on each edge, ensuring full coverage at any fine_x
        moveq   #0,d0
        move.w  #GFXWIDTH,d0
        divu.w  d3,d0           ; d0.w = GFXWIDTH / tile_w
        addq.w  #2,d0           ; d0.w = tile_cols_draw

        ; ── Compute tile_rows_draw = GFXHEIGHT / tile_h + 2 ─────────────────
        ; +2: one partial row top and bottom for any fine_y value.
        ; No map_h clamping — vertical wraparound handles short maps.
        moveq   #0,d1
        move.w  #GFXHEIGHT,d1
        divu.w  d4,d1           ; d1.w = GFXHEIGHT / tile_h
        addq.w  #2,d1           ; d1.w = tile_rows_draw

        ; ── Push loop constants to stack ─────────────────────────────────────
        ; Push order: row_idx first (→ 8(sp)), then map_h (→ 6(sp)),
        ; first_col (→ 4(sp)), tile_cols_draw (→ 2(sp)), tile_rows_draw (→ 0(sp))
        move.w  d7,-(sp)        ; row_idx = first_row
        move.w  2(a3),-(sp)     ; map_h  (header +2, still valid — a3 not yet advanced)
        move.w  d6,-(sp)        ; first_col
        move.w  d0,-(sp)        ; tile_cols_draw
        move.w  d1,-(sp)        ; tile_rows_draw (counts down)

        ; ── Set up tile data pointer ─────────────────────────────────────────
        lea     8(a3),a3        ; a3 = tilemap data base (skip 8-byte header, permanent)

        ; a4 = data base + first_row * map_w * 2
        moveq   #0,d0
        move.w  d7,d0           ; d0.l = first_row  (d7 still holds it)
        mulu.w  d5,d0           ; d0.l = first_row * map_w
        add.l   d0,d0           ; d0.l = first_row * map_w * 2 (bytes)
        lea     0(a3,d0.l),a4   ; a4 = pointer to first_row's data

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

        ; a4 += map_w * 2
        move.w  d5,d0           ; d0.w = map_w (upper word = 0 from moveq in inner loop)
        add.w   d0,d0           ; d0.w = map_w * 2
        lea     0(a4,d0.w),a4   ; a4 = next row base

        ; ── Vertical row wraparound ───────────────────────────────────────────
        move.w  8(sp),d0        ; d0 = row_idx
        addq.w  #1,d0           ; row_idx++
        cmp.w   6(sp),d0        ; row_idx >= map_h?
        blt.s   .no_vwrap
        moveq   #0,d0           ; row_idx = 0
        move.l  a3,a4           ; a4 = tilemap data base (row 0)
.no_vwrap:
        move.w  d0,8(sp)        ; store updated row_idx

        bra.w   .row_loop

; ════════════════════ Done ══════════════════════════════════════════════════
.done:
        lea     10(sp),sp       ; pop 5 words: rows+cols+first_col+map_h+row_idx
        movem.l (sp)+,d0-d7/a0-a4
        rts


; ── _bg_restore_tilemap ─────────────────────────────────────────────────────
;
; Redraws the tiles that overlap a bob's bounding box.  Installed into
; _bg_restore_fn by the SetTilemap command; called from _FlushBobs.
;
; Args:   a0   = bob imgptr (header: +0 width.w, +2 height.w, +6 rowbytes.w)
;         d0.w = bob screen_x (pixels, relative to visible area)
;         d1.w = bob buf_y (buffer Y = visual_y + _active_fine_y, added by _FlushBobs T13)
; Trashes: nothing (saves/restores d0-d7/a0-a4)
;
; ── TILE COORDINATE MAPPING ──────────────────────────────────────────────────
;   _DrawTilemap blits map row R to buffer Y = (R - first_row) * tile_h,
;   where first_row = _active_scroll_y / tile_h.
;   d1.w (buf_y) includes fine_y (added by _FlushBobs after T13 is applied).
;   row_top_abs = first_row + buf_y / tile_h
;   row_bot_abs = first_row + (buf_y + bob_h - 1) / tile_h  [clamped to first_row+map_h-1]
;   map_row     = row_abs % map_h  (vertical wraparound via DIVU each outer iteration)
;   buf_y drawn = (row_abs - first_row) * tile_h
;
; ── HORIZONTAL MAPPING ───────────────────────────────────────────────────────
;   k = screen-column offset; tile at k covers screen_x k*tile_w..(k+1)*tile_w-1.
;   k_left  = screen_x / tile_w
;   k_right = (screen_x + bob_w - 1) / tile_w
;   map_col = (first_col + k) % map_w  (with wraparound)
;
; ── STACK LAYOUT ─────────────────────────────────────────────────────────────
;   0(sp)  = k_left       (word)
;   2(sp)  = k_right      (word)
;   4(sp)  = row_bot_abs  (word)
;   6(sp)  = first_col    (word)
;   8(sp)  = map_h        (word)
;   10(sp) = first_row    (word)
;
; ── LOOP REGISTERS ───────────────────────────────────────────────────────────
;   d7 = row_abs  (outer; absolute row index, starts at row_top_abs)
;   d3 = k        (inner; screen-column offset, runs k_left..k_right)
;   d4 = map_w, d5 = tile_w, d6 = tile_h  (permanent throughout)
;   a2 = tileset ptr   (permanent)
;   a3 = tilemap data base (permanent, past 8-byte header)

        XDEF    _bg_restore_tilemap

_bg_restore_tilemap:
        movem.l d0-d7/a0-a4,-(sp)

        ; ── Bob bounding box ──────────────────────────────────────────────────
        move.w  (a0),d2         ; d2.w = bob_w
        move.w  2(a0),d3        ; d3.w = bob_h
        ; d0.w = screen_x, d1.w = buf_y (both preserved through entire prologue)

        ; ── Tilemap/tileset pointers ──────────────────────────────────────────
        move.l  _active_tileset_ptr,a2
        move.l  _active_tilemap_ptr,a3

        ; ── Tilemap header ────────────────────────────────────────────────────
        move.w  (a3),d4         ; d4.w = map_w  (permanent)
        move.w  4(a3),d5        ; d5.w = tile_w (permanent)
        move.w  6(a3),d6        ; d6.w = tile_h (permanent)

        ; ── Push first_row = _active_scroll_y / tile_h  [→ 10(sp)] ──────────
        moveq   #0,d7
        move.l  _active_scroll_y,d7
        divu.w  d6,d7
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)

        ; ── Push map_h from header  [→ 8(sp)] ────────────────────────────────
        move.w  2(a3),-(sp)

        ; ── Push first_col = _active_scroll_x / tile_w  [→ 6(sp)] ───────────
        moveq   #0,d7
        move.l  _active_scroll_x,d7
        divu.w  d5,d7
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)

        ; ── Push row_bot_abs  [→ 4(sp)] ──────────────────────────────────────
        ; = first_row + (buf_y + bob_h - 1) / tile_h, clamped to first_row + map_h - 1
        ; first_row at 4(sp), map_h at 2(sp) at this point (3 words pushed so far)
        moveq   #0,d7
        move.w  d1,d7           ; d7.l = buf_y
        add.w   d3,d7           ; + bob_h  (d3 still = bob_h here)
        subq.w  #1,d7
        divu.w  d6,d7           ; d7.w = (buf_y + bob_h - 1) / tile_h
        and.l   #$0000FFFF,d7
        add.w   4(sp),d7        ; + first_row → row_bot_abs (unclamped)
        move.w  4(sp),d3        ; d3.w = first_row  (bob_h no longer needed)
        add.w   2(sp),d3        ; d3.w = first_row + map_h
        subq.w  #1,d3           ; d3.w = first_row + map_h - 1  (max allowed)
        cmp.w   d3,d7
        ble.s   .rbr_clamp_ok
        move.w  d3,d7
.rbr_clamp_ok:
        move.w  d7,-(sp)        ; push row_bot_abs  [→ 4(sp)]

        ; ── Push k_right = (screen_x + bob_w - 1) / tile_w  [→ 2(sp)] ───────
        moveq   #0,d7
        move.w  d0,d7           ; d7.l = screen_x  (d0.w untouched since entry)
        add.w   d2,d7           ; + bob_w
        subq.w  #1,d7
        divu.w  d5,d7
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)

        ; ── Push k_left = screen_x / tile_w  [→ 0(sp)] ──────────────────────
        moveq   #0,d7
        move.w  d0,d7           ; d7.l = screen_x
        divu.w  d5,d7
        and.l   #$0000FFFF,d7
        move.w  d7,-(sp)

        ; Stack layout confirmed:
        ;   0(sp)=k_left  2(sp)=k_right  4(sp)=row_bot_abs
        ;   6(sp)=first_col  8(sp)=map_h  10(sp)=first_row

        ; ── Advance a3 past header ────────────────────────────────────────────
        lea     8(a3),a3        ; a3 = tilemap data base (permanent)

        ; ── row_top_abs = first_row + buf_y / tile_h → d7 (outer counter) ────
        moveq   #0,d7
        move.w  d1,d7           ; d7.l = buf_y  (d1.w preserved from entry)
        divu.w  d6,d7
        and.l   #$0000FFFF,d7
        add.w   10(sp),d7       ; d7 = row_top_abs

; ════════════════════ Outer loop (rows) ═════════════════════════════════════
.rbr_row:
        cmp.w   4(sp),d7        ; row_abs > row_bot_abs?
        bgt.w   .rbr_done

        ; ── map_row = row_abs % map_h  (for tilemap data indexing) ───────────
        move.l  d7,d0           ; d0.l = row_abs  (upper word = 0)
        divu.w  8(sp),d0        ; d0.high.w = row_abs % map_h = map_row
        swap    d0
        and.l   #$0000FFFF,d0   ; d0.l = map_row

        ; ── a1 = tilemap_data + map_row * map_w * 2 ──────────────────────────
        move.l  d0,d1
        mulu.w  d4,d1           ; map_row * map_w
        add.l   d1,d1           ; * 2 (bytes)
        lea     0(a3,d1.l),a1

        ; ── buf_y for _DrawImageFrame: (row_abs - first_row) * tile_h ────────
        move.l  d7,d1           ; d1.l = row_abs
        sub.w   10(sp),d1       ; d1.l = row_abs - first_row
        mulu.w  d6,d1           ; d1.l = (row_abs - first_row) * tile_h

        ; ── Inner loop (columns): k = k_left .. k_right ──────────────────────
        moveq   #0,d3
        move.w  0(sp),d3        ; d3 = k_left

.rbr_col:
        cmp.w   2(sp),d3        ; k > k_right?
        bgt.s   .rbr_col_done

        ; d0.l = screen_x = k * tile_w
        moveq   #0,d0
        move.w  d3,d0
        mulu.w  d5,d0

        ; d2.w = map_col = (first_col + k) % map_w
        move.w  6(sp),d2        ; first_col
        add.w   d3,d2
.rbr_wrap:
        cmp.w   d4,d2
        blt.s   .rbr_no_wrap
        sub.w   d4,d2
        bra.s   .rbr_wrap
.rbr_no_wrap:
        add.w   d2,d2
        move.w  0(a1,d2.w),d2   ; d2.w = tile index

        ; _DrawImageFrame(a0=tileset, d0=screen_x, d1=buf_y, d2=tile_idx)
        ; Saves/restores d0-d7/a0-a3 → d3(k), d7(row_abs), a2(tileset) intact.
        move.l  a2,a0
        jsr     _DrawImageFrame

        addq.w  #1,d3
        bra.s   .rbr_col

; ──────────────────── End inner loop ─────────────────────────────────────────
.rbr_col_done:
        addq.w  #1,d7           ; row_abs++
        bra.s   .rbr_row

; ════════════════════ Done ══════════════════════════════════════════════════
.rbr_done:
        addq.l  #12,sp          ; pop 6 words (k_left+k_right+row_bot+first_col+map_h+first_row)
        movem.l (sp)+,d0-d7/a0-a4
        rts
