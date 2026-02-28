; ============================================================================
; graphics.s — BASSM Screen Initialisation Subroutines
; ============================================================================
;
; PURPOSE
;   Provides the runtime helpers that support the Blitz2D "Graphics" command:
;
;     _PatchBitplanePtrs   — writes real chip-RAM addresses into a copper list
;     _InstallCopper       — points Copper 1 at the new list and restarts it
;
; BLITZ2D SYNTAX
;   Graphics width, height, depth
;   Example: Graphics 320, 256, 5    (320×256, 5 bitplanes = 32 colours, PAL)
;
; HOW THE PIPELINE WORKS
;   1. codegen.js reads a "Graphics W,H,D" statement and emits four things
;      into the generated .s file (see CODEGEN CONTRACT below):
;        a) Screen constants (EQUs)
;        b) Chip-RAM BSS for the raw bitplane pixel data
;        c) Chip-RAM DATA containing the copper list template
;        d) A CODE section "_setup_graphics" that calls the helpers here
;   2. _setup_graphics (generated code) calls:
;        lea  _gfx_cop_bpl_table,a0   ; pointer to copper BPL-ptr section
;        lea  _gfx_planes,a1          ; base of bitplane chip-RAM buffer
;        moveq #GFXDEPTH,d0          ; number of bitplanes
;        move.l #GFXPSIZE,d1         ; bytes per bitplane
;        bsr  _PatchBitplanePtrs      ; (this file) — fill in the addresses
;        lea  _gfx_copper,a0          ; start of complete copper list
;        bsr  _InstallCopper          ; (this file) — activate it
;   3. Copper takes over display from that point onward.
;
; ── CODEGEN CONTRACT — what codegen.js must emit for Graphics W,H,D ─────────
;
;   EQUs (assembly-time constants)
;   ─────────────────────────────
;   GFXWIDTH    EQU <W>                      e.g. 320
;   GFXHEIGHT   EQU <H>                      e.g. 256
;   GFXDEPTH    EQU <D>                      e.g. 5
;   GFXBPR      EQU (GFXWIDTH/8)             bytes per row (40 for 320px)
;   GFXPSIZE    EQU (GFXBPR*GFXHEIGHT)       bytes per bitplane (10240 for 320×256)
;   GFXCOLORS   EQU (1<<GFXDEPTH)            colour entries (32 for 5 planes)
;   GFXBPLCON0  EQU ((GFXDEPTH<<12)|$0200)   BPLCON0 word (see table below)
;   GFXDIWSTRT  EQU <computed>               display window start (see formula)
;   GFXDIWSTOP  EQU <computed>               display window stop
;   GFXDDFSTRT  EQU <computed>               DMA fetch start
;   GFXDDFSTOP  EQU <computed>               DMA fetch stop
;
;   BPLCON0 values (lores OCS, colour enabled, bit 9 = 1)
;   ──────────────
;   1 plane  → $1200    2 planes → $2200    3 planes → $3200
;   4 planes → $4200    5 planes → $5200    6 planes → $6200
;   Formula: (depth << 12) | $0200
;
;   Display window formulas (PAL lores, centred, width = 320)
;   ──────────────────────────────────────────────────────────
;   H_start  = $81                 (beam pos of left lores pixel)
;   V_start  = $2C                 (first non-blank PAL line = 44)
;   H_stop   = ($81 + W) & $FF    (right edge; hardware implies bit 8 = 1)
;   V_stop   = ($2C + H) & $FF    (bottom edge; hardware implies bit 8 = 1)
;   GFXDIWSTRT = (V_start << 8) | H_start
;   GFXDIWSTOP = (V_stop  << 8) | H_stop
;
;   Common precomputed values (PAL lores, 320 px wide)
;   ─────────────────────────────────────────────────
;   320×200 → DIWSTRT=$2C81  DIWSTOP=$F4C1  DDFSTRT=$003C  DDFSTOP=$00D4
;   320×256 → DIWSTRT=$2C81  DIWSTOP=$2CC1  DDFSTRT=$003C  DDFSTOP=$00D4
;   320×270 → DIWSTRT=$2C81  DIWSTOP=$46C1  DDFSTRT=$003C  DDFSTOP=$00D4
;
;   DDF values (lores 320 px, OCS):
;   GFXDDFSTRT = $003C   GFXDDFSTOP = $00D4
;   (These are fixed for all 320-wide lores screens in OCS)
;
;   Chip-RAM BSS — bitplane pixel buffers
;   ──────────────────────────────────────
;           SECTION gfx_planes,BSS_C
;   _gfx_planes:    ds.b  GFXPSIZE*GFXDEPTH
;
;   Chip-RAM DATA — copper list (template; BPL pointers patched at runtime)
;   ─────────────────────────────────────────────────────────────────────────
;           SECTION gfx_copper,DATA_C
;   _gfx_copper:
;           dc.w  $008E,GFXDIWSTRT      ; DIWSTRT
;           dc.w  $0090,GFXDIWSTOP      ; DIWSTOP
;           dc.w  $0092,GFXDDFSTRT      ; DDFSTRT
;           dc.w  $0094,GFXDDFSTOP      ; DDFSTOP
;           dc.w  $0100,GFXBPLCON0      ; BPLCON0
;           dc.w  $0102,$0000           ; BPLCON1  (no scroll)
;           dc.w  $0104,$0000           ; BPLCON2  (default priority)
;           dc.w  $0108,$0000           ; BPL1MOD  (no modulo)
;           dc.w  $010A,$0000           ; BPL2MOD
;   _gfx_cop_bpl_table:                 ; ← _PatchBitplanePtrs patches from here
;           dc.w  $00E0,$0000           ; BPL1PTH  (plane 0 high)
;           dc.w  $00E2,$0000           ; BPL1PTL  (plane 0 low)
;       [repeat for each extra bitplane up to D, registers $E4-$F6]
;   _gfx_cop_color_table:               ; ← color.s / cls.s write palette here
;           dc.w  $0180,$0000           ; COLOR00  (background)
;       [repeat GFXCOLORS-1 more entries, registers $182-$1BE]
;           dc.w  $FFFF,$FFFE           ; END of copper list
;
;   Bitplane pointer registers by plane index (1-based, Amiga convention)
;   ─────────────────────────────────────────────────────────────────────
;   Plane  PTH    PTL       Plane  PTH    PTL
;     1   $00E0  $00E2        4   $00EC  $00EE
;     2   $00E4  $00E6        5   $00F0  $00F2
;     3   $00E8  $00EA        6   $00F4  $00F6
;
;   Generated CODE — init routine called from _main_program
;   ─────────────────────────────────────────────────────────────────────
;           SECTION gfx_init,CODE
;   _setup_graphics:
;           lea  _gfx_cop_bpl_table,a0
;           lea  _gfx_planes,a1
;           moveq #GFXDEPTH,d0
;           move.l #GFXPSIZE,d1
;           bsr  _PatchBitplanePtrs
;           lea  _gfx_copper,a0
;           bsr  _InstallCopper
;           rts
;
;   In _main_program, the Graphics statement becomes:   bsr _setup_graphics
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s — must still hold here)
; ============================================================================


        SECTION graphics_code,CODE


; ── _PatchBitplanePtrs ───────────────────────────────────────────────────────
;
; Iterates over the copper list's bitplane pointer section and writes the
; real chip-RAM addresses of each bitplane into the value fields.
;
; A copper list MOVE instruction is 4 bytes:
;   [register_offset : word] [value : word]
;                             ↑ we write here (offset +2 from entry start)
;
; For plane N at address A:
;   PTH entry (even)  → value field = A >> 16  (high word)
;   PTL entry (odd)   → value field = A & $FFFF (low word)
; Two entries (8 bytes) per plane, sequential in chip RAM.
;
; Args:  a0 = _gfx_cop_bpl_table  (first BPLxPTH copper entry)
;        a1 = _gfx_planes          (chip-RAM base of bitplane data)
;        d0 = GFXDEPTH             (number of bitplanes, 1-6)
;        d1 = GFXPSIZE             (bytes per bitplane)
; Trashes: d0-d3

        XDEF    _PatchBitplanePtrs
_PatchBitplanePtrs:
        movem.l d0-d3/a0-a1,-(sp)

        move.l  d1,d3           ; d3 = plane size (safe — d1 reused below)
        move.l  a1,d2           ; d2 = current plane chip-RAM address (long)
        subq.w  #1,d0           ; adjust count for dbra (D planes → D-1)

.patch_plane:
        ; ── Write high word of plane address (PTH value) ──────────────────
        move.l  d2,d1           ; copy full address
        swap    d1              ; d1.w = bits 31:16 (high word)
        move.w  d1,2(a0)        ; store in copper value field (offset +2)
        addq.l  #4,a0           ; advance: skip past PTH entry → PTL entry

        ; ── Write low word of plane address (PTL value) ───────────────────
        move.w  d2,2(a0)        ; d2.w = bits 15:0 (low word already in d2)
        addq.l  #4,a0           ; advance: skip past PTL entry → next PTH

        ; ── Advance to the next bitplane ──────────────────────────────────
        add.l   d3,d2           ; next plane = base + planesize

        dbra    d0,.patch_plane

        movem.l (sp)+,d0-d3/a0-a1
        rts


; ── _InstallCopper ───────────────────────────────────────────────────────────
;
; Points Copper 1 at the given chip-RAM copper list and triggers an
; immediate restart so the copper begins executing from it next cycle.
;
; Writing order: HIGH word first, then LOW word.
; Writing any value to COPJMP1 ($DFF088) forces the copper to re-read COP1LC
; and jump to that address immediately, without waiting for VBlank.
;
; Args:   a0 = address of copper list in chip RAM
; Trashes: d0

        XDEF    _InstallCopper
_InstallCopper:
        move.l  a0,d0           ; d0 = copper list address (32-bit)

        swap    d0              ; d0.w = high 16 bits
        move.w  d0,COP1LCH(a5) ; write high word to Copper 1 pointer

        swap    d0              ; d0.w = low 16 bits again
        move.w  d0,COP1LCL(a5) ; write low word

        move.w  d0,COPJMP1(a5) ; strobe: copper restarts immediately
                                ; (value written is irrelevant — any write works)
        rts
