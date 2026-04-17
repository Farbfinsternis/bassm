; ============================================================================
; tilemap_anim.s — Tile Animation (LUT-based remap)
; ============================================================================
;
; PURPOSE
;   Provides animated tile substitution for tilemap rendering.
;   Uses a per-tile remap LUT so DrawTilemap can resolve animated tiles
;   in O(1) per tile — no per-tile group search at render time.
;
; ANIMATION DATA FORMAT (from .tset ANIMATION section, pointed to by
; _active_tileset_anim):
;   +0  dc.w  group_count
;   Per group (4 bytes each):
;     +0  dc.w  startIndex       (first tile in the animation cycle)
;     +2  dc.b  frameCount       (number of frames in the cycle)
;     +3  dc.b  speed            (VBlanks per frame advance)
;
; REMAP LUT (_tile_remap):
;   Word array, one entry per tile.  Initially identity (tile N -> N).
;   _AnimTilesTick patches entries for animated groups each VBlank.
;   DrawTilemap reads remap[raw_index] to get the displayed tile index.
;
; ANIM STATE (_anim_state):
;   Per group, 2 bytes:
;     byte 0 = tick counter   (0..speed-1, increments per VBlank)
;     byte 1 = current offset (0..frameCount-1, advances when tick wraps)
;
; DEPENDENCY
;   startup.s  — _frame_count (50 Hz VBlank counter)
;   codegen.js — emits _tile_remap (BSS, ds.w tile_count),
;                _anim_state (BSS, ds.b group_count*2),
;                _active_tileset_anim (BSS, ds.l 1)
;
; ============================================================================

        SECTION tilemap_anim_code,CODE

        XREF    _tile_remap
        XREF    _anim_state
        XREF    _active_tileset_anim
        XREF    _frame_count


; ── _AnimTilesInit ──────────────────────────────────────────────────────────
;
; Fills _tile_remap with identity mapping (tile N -> N) and zeros all
; per-group animation state.  Called by SetTilemap when the active
; tileset has animation data.
;
; Input:  d0.w = tile_count
; Trashes: nothing (saves/restores all used regs)

        XDEF    _AnimTilesInit

_AnimTilesInit:
        movem.l d0-d2/a0,-(sp)

        ; Identity remap: remap[i] = i  for i = 0..tile_count-1
        lea     _tile_remap,a0
        move.w  d0,d2           ; d2 = tile_count (preserve)
        subq.w  #1,d0           ; dbra adjust
        moveq   #0,d1           ; d1 = index counter
.id_loop:
        move.w  d1,(a0)+
        addq.w  #1,d1
        dbra    d0,.id_loop

        ; Zero anim state (tick + offset per group)
        move.l  _active_tileset_anim,d0
        beq.s   .no_state
        move.l  d0,a0
        move.w  (a0),d0         ; d0 = group_count
        beq.s   .no_state
        lea     _anim_state,a0
        subq.w  #1,d0           ; dbra adjust
.zero_st:
        clr.w   (a0)+           ; tick=0, offset=0
        dbra    d0,.zero_st
.no_state:
        ; Force first tick by invalidating last-frame marker
        move.l  #-1,_anim_last_frame

        movem.l (sp)+,d0-d2/a0
        rts


; ── _AnimTilesTick ──────────────────────────────────────────────────────────
;
; Advances tile animation by one tick and patches the remap LUT.
; Called before DrawTilemap.  Safe to call multiple times per frame —
; skips if _frame_count hasn't changed since last tick.
;
; For each animation group:
;   1. Increment tick counter.  If tick >= speed: reset tick, advance
;      frame offset (wrap at frameCount).
;   2. Patch remap entries:
;        remap[startIndex + i] = startIndex + ((i + offset) % frameCount)
;      for i = 0..frameCount-1.
;
; Trashes: nothing (saves/restores all used regs)
;
; Registers during group loop:
;   a0 = anim data read pointer (advances through groups)
;   a1 = anim state read/write pointer
;   a2 = _tile_remap base (constant)
;   a3 = &remap[startIndex] for current group
;   d0 = scratch (tick counter, then mapped index in patch loop)
;   d1 = current offset
;   d2 = scratch (startIndex copy during patch)
;   d3 = patch loop counter (dbra)
;   d4 = startIndex (constant per group)
;   d5 = frameCount (constant per group)
;   d6 = speed (constant per group)
;   d7 = group loop counter (dbra)

        XDEF    _AnimTilesTick

_AnimTilesTick:
        ; Quick exit: no animation data?
        move.l  _active_tileset_anim,d0
        beq.s   .done

        ; Already ticked this frame?
        move.l  _frame_count,d0
        cmp.l   _anim_last_frame,d0
        beq.s   .done

        movem.l d0-d7/a0-a3,-(sp)
        move.l  _frame_count,d0
        move.l  d0,_anim_last_frame

        move.l  _active_tileset_anim,a0
        move.w  (a0)+,d7        ; d7 = group_count
        beq.w   .exit
        lea     _anim_state,a1
        lea     _tile_remap,a2
        subq.w  #1,d7           ; dbra adjust

.group:
        ; Read group definition: startIndex(w), frameCount(b), speed(b)
        move.w  (a0)+,d4        ; d4.w = startIndex
        moveq   #0,d5
        move.b  (a0)+,d5        ; d5 = frameCount
        moveq   #0,d6
        move.b  (a0)+,d6        ; d6 = speed

        ; Read per-group state
        move.b  (a1),d0         ; d0 = tick counter
        move.b  1(a1),d1        ; d1 = current offset

        ; Increment tick
        addq.b  #1,d0
        cmp.b   d6,d0           ; tick >= speed?
        blt.s   .store

        ; Tick overflow -> advance frame offset
        clr.b   d0              ; reset tick
        addq.b  #1,d1           ; offset++
        cmp.b   d5,d1           ; offset >= frameCount?
        blt.s   .store
        clr.b   d1              ; wrap to 0

.store:
        move.b  d0,(a1)+        ; write tick
        move.b  d1,(a1)+        ; write offset

        ; Patch remap LUT for this group:
        ;   remap[startIndex + i] = startIndex + ((i + offset) % frameCount)
        move.w  d4,d2
        add.w   d2,d2           ; word offset into remap
        lea     0(a2,d2.w),a3   ; a3 = &remap[startIndex]

        moveq   #0,d0
        move.b  d1,d0           ; d0 = mapped index (starts at offset)
        move.w  d5,d3
        subq.w  #1,d3           ; dbra adjust

.patch:
        move.w  d4,d2           ; d2 = startIndex
        add.w   d0,d2           ; d2 = startIndex + mapped_idx
        move.w  d2,(a3)+        ; write remap entry

        ; Advance mapped index with wraparound
        addq.b  #1,d0
        cmp.b   d5,d0           ; >= frameCount?
        blt.s   .no_wrap
        clr.b   d0
.no_wrap:
        dbra    d3,.patch

        dbra    d7,.group

.exit:
        movem.l (sp)+,d0-d7/a0-a3
.done:
        rts


; ── BSS ─────────────────────────────────────────────────────────────────────
        SECTION tilemap_anim_bss,BSS

        XDEF    _anim_last_frame
_anim_last_frame:   ds.l    1       ; last _frame_count when tick ran
