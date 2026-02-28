; ============================================================================
; text.s — BASSM Text Rendering (Stub / Planned Interface)
; ============================================================================
;
; PURPOSE
;   Will provide runtime helpers for the Blitz2D text output commands:
;
;     _Text    — render a string at a pixel position on the current screen
;     _NPrint  — debug console output (no-op on bare metal)
;
; BLITZ2D SYNTAX (planned)
;   Text x, y, "string"       ; render text at pixel position (x, y)
;   NPrint "string"           ; print to debug port (no-op in bare metal builds)
;
; CURRENT STATUS: STUB — subroutines return immediately without rendering.
;
; ── PLANNED IMPLEMENTATION ──────────────────────────────────────────────────
;
; Text rendering on OCS Amiga requires:
;   1. FONT DATA — a bitmap font in chip RAM with glyph data for each
;      printable ASCII character (typically 8×8 or 8×16 pixels per glyph).
;   2. A RENDERING LOOP — copies each glyph from the font into the bitplane
;      at the target (x, y) position, one character at a time.
;   3. BLITTER COPY — each glyph blit uses channels A (mask) and C (source)
;      to merge the glyph pixels into the destination bitplane via minterm:
;        D = (A AND C) OR ((NOT A) AND D)   — transparent blit, minterm $CA
;   4. POSITION TRACKING — current cursor X/Y updated after each character.
;
; Planned subroutine interface:
;
;   _Text(a0=string_ptr, d0=x_pixel, d1=y_pixel)
;     Renders the null-terminated string at (x, y) in the current screen.
;     Advances x by font width per character; wraps on \n.
;
;   _NPrint(a0=string_ptr)
;     Intended for development: writes to a debug port or serial line.
;     In a final bare-metal build this is a no-op.
;
; CODEGEN CONTRACT (planned)
;   Generated CODE for Text x, y, "hello":
;         lea    .str_0,a0
;         move.w #x,d0
;         move.w #y,d1
;         bsr    _Text
;         bra.s  .past_0
;   .str_0:
;         dc.b   "hello",0
;         even
;   .past_0:
;
;   Generated CODE for NPrint "msg":
;         lea    .str_1,a0
;         bsr    _NPrint
;         bra.s  .past_1
;   .str_1:
;         dc.b   "msg",0
;         even
;   .past_1:
;
; ── REGISTER CONVENTION ─────────────────────────────────────────────────────
;   a5 = $DFF000  (established by startup.s)
; ============================================================================


        SECTION text_code,CODE


; ── _Text ────────────────────────────────────────────────────────────────────
;
; NOT YET IMPLEMENTED — returns immediately.
;
; Planned args:
;   a0 = pointer to null-terminated ASCII string
;   d0.w = X position in pixels
;   d1.w = Y position in pixels

        XDEF    _Text
_Text:
        rts                             ; STUB — not yet implemented


; ── _NPrint ──────────────────────────────────────────────────────────────────
;
; Debug text output — no-op in bare metal builds.
;
; Planned args:
;   a0 = pointer to null-terminated ASCII string

        XDEF    _NPrint
_NPrint:
        rts                             ; no-op
