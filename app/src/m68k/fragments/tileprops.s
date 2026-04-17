; ============================================================================
; tileprops.s — Tile Property Runtime Queries (Slopes)
; ============================================================================
;
; PURPOSE
;   Provides runtime lookup for slope heightmaps stored in .tset SLOPES sections.
;   Used by the Collide-and-Slide system (T11.2) and potentially by user code
;   via a future BASSM builtin.
;
; SLOPES DATA FORMAT (from .tset, pointed to by _active_tileset_slopes):
;   +0  dc.w  slope_count            ; number of slope entries
;   Per entry (2 + tile_w bytes each):
;     +0  dc.w  tile_index            ; which tile this slope belongs to
;     +2  ds.b  tile_w                ; heightmap: one byte per column
;                                     ; value 0 = floor, tile_h = ceiling
;
; ENTRY STRIDE
;   2 + tile_w bytes.  tile_w is read from the tilemap header at runtime
;   (_active_tilemap_ptr + 4), so the subroutine works for 8/16/32px tiles.
;
; COLLISION BITS (from .tset COLLISION section, per-tile byte):
;   Bit 0 = SOLID
;   Bit 1 = PASS_UP
;   Bit 2 = PASS_DOWN
;   Bit 3 = PASS_LEFT
;   Bit 4 = PASS_RIGHT
;   Bit 5 = SLOPE        (← used by _CollideSlope)
;
; DEPENDENCY
;   codegen.js — _active_tileset_slopes (BSS, ds.l 1),
;                _active_tileset_coll   (BSS, ds.l 1),
;                _active_tilemap_ptr    (BSS, ds.l 1)
;
; ============================================================================

        SECTION tileprops_code,CODE

        XREF    _active_tileset_slopes
        XREF    _active_tileset_coll
        XREF    _active_tilemap_ptr


; ── _SlopeLookup ────────────────────────────────────────────────────────────
;
; Finds the slope entry for a given tile and returns the heightmap value
; at the specified column (rel_x).  Linear scan through slope_count entries.
;
; Input:  d0.w = tile_index (the tile to look up)
;         d1.w = rel_x      (column within tile, 0..tile_w-1)
; Output: d0.w = height     (0..tile_h if found, 0 if tile has no slope)
; Trashes: nothing except d0 (all other registers preserved)
;
; Performance: O(n) where n = slope_count.  Typically <20 slope tiles,
;              3 instructions per miss — negligible on 68000.

        XDEF    _SlopeLookup

_SlopeLookup:
        movem.l d1-d3/a0-a1,-(sp)

        ; ── Early exit: no slopes data? ─────────────────────────────────────
        move.l  _active_tileset_slopes,d2
        beq.s   .sl_zero
        move.l  d2,a0

        ; ── Read slope_count ────────────────────────────────────────────────
        move.w  (a0)+,d2            ; d2.w = slope_count
        beq.s   .sl_zero

        ; ── Compute entry stride: 2 + tile_w ───────────────────────────────
        move.l  _active_tilemap_ptr,a1
        moveq   #0,d3
        move.w  4(a1),d3            ; d3.w = tile_w (from tilemap header)
        addq.w  #2,d3               ; d3.w = entry_stride = 2 + tile_w

        ; ── Linear scan ────────────────────────────────────────────────────
        subq.w  #1,d2               ; dbra adjust
.sl_scan:
        cmp.w   (a0),d0             ; entry.tile_index == target?
        beq.s   .sl_found
        add.w   d3,a0               ; advance to next entry
        dbra    d2,.sl_scan

        ; ── Not found → return 0 ──────────────────────────────────────────
.sl_zero:
        moveq   #0,d0
        movem.l (sp)+,d1-d3/a0-a1
        rts

        ; ── Found → return heightmap[rel_x] ───────────────────────────────
.sl_found:
        moveq   #0,d0
        move.b  2(a0,d1.w),d0      ; d0.b = heightmap[rel_x] (zero-extended)
        movem.l (sp)+,d1-d3/a0-a1
        rts


; ── _CollideSlope ───────────────────────────────────────────────────────────
;
; Collide-and-Slide for slope tiles.  Given a foot position in world
; coordinates, determines whether the foot is inside a slope tile's
; heightmap surface and snaps it upward if so.
;
; Algorithm:
;   1. foot_x / tile_w → col + rel_x (remainder)
;   2. foot_y / tile_h → row
;   3. tile_index = map_data[row * map_w + col]
;   4. collision byte for tile → check SLOPE bit (bit 5)
;   5. _SlopeLookup(tile_index, rel_x) → height
;   6. surface_y = (row + 1) * tile_h - height
;   7. foot_y > surface_y → snap foot_y = surface_y
;
; Input:  d0.l = foot_x  (world pixels)
;         d1.l = foot_y  (world pixels)
; Output: d1.l = corrected foot_y (snapped to slope surface if inside)
;         d0.w = 0 (no collision) or 1 (snapped)
; Trashes: d0, d1 (outputs only — all other registers preserved)
;
; NOTE: Horizontal movement is never altered — only vertical correction.
;       Requires _active_tileset_coll (always present when slopes exist,
;       because slopes require the SLOPE collision flag → COLLISION section).

        XDEF    _CollideSlope

_CollideSlope:
        movem.l d2-d6/a0-a1,-(sp)

        ; ── Tilemap header ──────────────────────────────────────────────────
        move.l  _active_tilemap_ptr,a0
        move.w  (a0),d4             ; d4.w = map_w  (permanent)
        move.w  4(a0),d5            ; d5.w = tile_w (= tile_h, permanent)
        lea     8(a0),a0            ; a0 = map data base (past 8-byte header)

        ; ── col + rel_x from foot_x ────────────────────────────────────────
        divu.w  d5,d0               ; d0.low = col, d0.high = rel_x
        move.w  d0,d6               ; d6.w = col
        swap    d0
        move.w  d0,d2               ; d2.w = rel_x (saved for _SlopeLookup)

        ; ── row from foot_y ─────────────────────────────────────────────────
        move.l  d1,d3               ; d3.l = foot_y (preserve d1 for output)
        divu.w  d5,d3               ; d3.low = row, d3.high = foot_y % tile_h
        ; d3.w = row (keep low word only for arithmetic below)

        ; ── tile_index = map_data[row * map_w + col] ───────────────────────
        moveq   #0,d0
        move.w  d3,d0               ; d0.l = row
        mulu.w  d4,d0               ; d0.l = row * map_w
        add.w   d6,d0               ; d0.l = row * map_w + col
        add.l   d0,d0               ; d0.l = byte offset (word array)
        move.w  0(a0,d0.l),d0       ; d0.w = tile_index

        ; ── Check collision byte → SLOPE = bit 5 ──────────────────────────
        move.l  _active_tileset_coll,a1
        moveq   #0,d6
        move.b  0(a1,d0.w),d6       ; d6.b = collision flags
        btst    #5,d6               ; SLOPE?
        beq.s   .cs_none

        ; ── _SlopeLookup(d0=tile_index, d1=rel_x) → d0=height ─────────────
        ; d0.w = tile_index (still valid), d1 = foot_y (must save)
        move.l  d1,-(sp)            ; save foot_y
        move.w  d2,d1               ; d1.w = rel_x
        jsr     _SlopeLookup        ; d0.w = height (0 if not found)
        move.l  (sp)+,d1            ; restore foot_y

        tst.w   d0
        beq.s   .cs_none            ; height 0 → no surface here

        ; ── surface_y = (row + 1) * tile_h - height ───────────────────────
        ; d3.w = row, d5.w = tile_h, d0.w = height (clean from _SlopeLookup)
        move.w  d0,d2               ; d2.w = height (save)
        moveq   #0,d0
        move.w  d3,d0               ; d0.l = row
        addq.l  #1,d0               ; d0.l = row + 1
        mulu.w  d5,d0               ; d0.l = (row + 1) * tile_h = tile_bottom
        sub.w   d2,d0               ; d0.l = surface_y

        ; ── foot_y > surface_y → snap ──────────────────────────────────────
        cmp.l   d0,d1               ; foot_y > surface_y?
        ble.s   .cs_none
        move.l  d0,d1               ; snap: foot_y = surface_y
        moveq   #1,d0               ; d0 = 1 (collision)
        movem.l (sp)+,d2-d6/a0-a1
        rts

.cs_none:
        moveq   #0,d0               ; d0 = 0 (no collision)
        movem.l (sp)+,d2-d6/a0-a1
        rts
