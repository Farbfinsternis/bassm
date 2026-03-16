![BASSM](logo.png)

# BASSM — Blitz2D to Amiga m68k Assembler

A compiler and live-preview IDE that translates a subset of the **Blitz2D** BASIC dialect into native **Motorola 68000 assembly** for the Commodore Amiga, assembles and links it with **vasmm68k_mot + vlink**, and previews the result in the **vAmiga** WASM emulator — all inside a single Electron app.

The generated executables are standard **AmigaOS hunk-format binaries** compatible with AROS, real Amiga hardware (OCS/ECS), and Amiga emulators (vAmiga, WinUAE).

---

## What It Does

Write Blitz2D-style code on the left; click **Run** to compile, assemble, and boot it in the embedded Amiga emulator on the right. No Amiga hardware required.

```basic
Graphics 320,256,3

PaletteColor 0,0,0,0      ; black background
PaletteColor 1,15,0,0     ; red box

ClsColor 0

x = 10
y = 10
dx = 3
dy = 2

While 1
  Cls                        ; clear back buffer (Blitter)

  x = x + dx
  y = y + dy

  If x < 0    Then x = 0   : dx = -dx : EndIf
  If x + 30 > 320 Then x = 290 : dx = -dx : EndIf
  If y < 0    Then y = 0   : dy = -dy : EndIf
  If y + 20 > 256 Then y = 236 : dy = -dy : EndIf

  Color 1 : Box x,y,30,20   ; draw into back buffer

  ScreenFlip                 ; VBL-sync swap — no tearing
Wend
```

---

## Pipeline

```
Blitz2D source
      │
      ▼
  PreProcessor       strip comments, normalize whitespace
      │
      ▼
    Lexer            tokenize: keywords, identifiers, literals, operators
      │
      ▼
    Parser           build AST (commands, assignments, control flow)
      │
      ▼
   CodeGen           emit m68k assembly + fragment INCLUDEs
      │
      ▼
vasmm68k_mot         assemble → hunk object file (-Fhunk)
      │
      ▼
    vlink            link → clean AmigaOS hunk executable (-bamigahunk)
      │              (merges sections: one CODE hunk, CHIP DATA/BSS hunks)
      ▼
   vAmiga            WASM emulator — boots the .exe and renders to canvas
      │
      ▼  (copy of .exe also written to out/bassm_out.exe)
real Amiga / WinUAE  runs natively on hardware and any compatible emulator
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| `main.js` | Electron main process — spawns vasm/vlink, loads ROM, sends .exe to preview |
| `app/src/bassm.js` | Compiler pipeline orchestrator |
| `app/src/parser.js` | Recursive-descent parser |
| `app/src/codegen.js` | AST → m68k assembly generator |
| `app/src/commands-map.json` | Command name → argument count registry |
| `app/src/keywords-map.json` | Keyword token definitions |
| `app/src/m68k/fragments/` | Assembly fragments included in every program |
| `emulator/preview/preview.html` | vAmiga WASM preview window |
| `bin/vlink.exe` | Amiga HUNK linker |

### Fragment Architecture

Every compiled program is assembled from these fragments in order:

```
startup.s      bare-metal system takeover (Forbid, VBL handler, CIA-A keyboard ISR,
               128-key matrix, mouse delta accumulation)
graphics.s     bitplane + two copper lists setup (double-buffering)
cls.s          Blitter screen clear (_Cls, writes to back buffer)
clscolor.s     _ClsColor (sets background fill colour)
color.s        _SetColor
palette.s      32-entry OCS palette (_InitPalette, _SetPaletteColor, _draw_color)
text.s         _Text (8×8 bitmap font, CPU per-plane per-row rendering, newline support)
               _IntToStr / _str_buf — integer-to-decimal for Str$
rnd.s          _Rnd (Xorshift32, auto-seeded from VHPOSR) — only if Rnd is used
plot.s         _Plot (single pixel, CPU, writes to back buffer)
line.s         _Line (Bresenham, CPU)
rect.s         _Rect (outline rectangle, 4× _Box calls)
box.s          _Box (filled rectangle, Blitter A→D, writes to back buffer)
waitkey.s      _WaitKey (interrupt-driven CIA-A keyboard)
flip.s         _ScreenFlip (VBL-synchronised front/back buffer swap)
copper_raster.s  _SetRasterColor (only if CopperColor is used)
sound.s        _PlaySample, _StopSample — Paula DMA (only if LoadSample is used)
image.s        _DrawImage — Blitter A→D image blit (only if LoadImage is used)
[_main_program]  generated user code
offload.s      OS restoration (LoadView, RethinkDisplay, return to CLI)
```

---

## Implemented Language Features

### Screen
| Command | Description |
|---------|-------------|
| `Graphics w,h,d` | Set up screen (320×H, d bitplanes, OCS PAL lores) |
| `Cls` | Clear screen to ClsColor (Blitter fill) |
| `ClsColor n` | Set background clear colour |

### Colour
| Command | Description |
|---------|-------------|
| `Color n` | Set current drawing colour (palette index) |
| `PaletteColor n,r,g,b` | Set palette entry n to OCS colour (r,g,b each 0-15) |

### Drawing
| Command | Description |
|---------|-------------|
| `Plot x,y` | Plot single pixel |
| `Line x1,y1,x2,y2` | Bresenham line |
| `Rect x,y,w,h` | Rectangle outline |
| `Box x,y,w,h` | Filled rectangle (Blitter A→D, per-plane word masks) |
| `Text x,y,"str"` | Render string with 8×8 bitmap font (CPU, per-plane, newline `$0A` supported) |

### Control Flow
| Construct | Description |
|-----------|-------------|
| `If expr … EndIf` | Conditional block |
| `If expr … Else … EndIf` | With else branch |
| `If … ElseIf … EndIf` | ElseIf chain |
| `While expr … Wend` | While loop |
| `Repeat … Until expr` | Do-while loop (body runs at least once; exits when condition is true) |
| `For v = a To b [Step s] … Next` | For loop |
| `Select expr … Case v … EndSelect` | Select/Case |
| `Exit [n]` | Exit n levels of nested loops (default 1); works in While, For, Repeat |

### Variables & Expressions
- Integer variables (`x = expr`)
- Arithmetic: `+ - * / Mod` with correct precedence, unary minus
- Comparisons: `= <> < > <= >=` (return Blitz2D boolean −1/0)
- Logical/bitwise: `And` `Or` `Xor` `Not` (32-bit, work correctly for −1/0 booleans)
- Shift: `Shl` (left shift, `lsl.l`) / `Shr` (arithmetic right shift, `asr.l`)
- Math: `Rnd(n)` — random 0..n-1 (Xorshift32, VHPOSR seed); `Abs(n)` — absolute value (inline)
- `Str$(n)` — converts integer to decimal string pointer (usable in `Text`)
- Variables as command arguments

### Timing & Double-Buffering
| Command | Description |
|---------|-------------|
| `WaitVbl` | Wait for next vertical blank (50 Hz PAL) |
| `Delay n` | Wait n VBlanks |
| `ScreenFlip` | VBL-synchronised front/back buffer swap (no screen tearing) |

### Input
| Command / Function | Description |
|--------------------|-------------|
| `WaitKey` | Halt until any key is pressed (interrupt-driven CIA-A) |
| `KeyDown(sc)` | −1 if scancode `sc` is held, 0 otherwise; non-blocking; up to 128 simultaneous keys |
| `JoyUp(p)` / `JoyDown(p)` / `JoyLeft(p)` / `JoyRight(p)` | Joystick direction on port p (0=left/mouse, 1=right/joystick) |
| `Joyfire(p)` | Fire button on port p |
| `MouseX()` / `MouseY()` | Mouse position (starts at screen centre; updated every VBL) |
| `MouseDown(n)` | −1 if mouse button n is held (0=left, 1=right) |
| `MouseHit(n)` | −1 if button n was clicked since last call; clears flag (one-shot) |

### Sound (Paula DMA)
| Command | Description |
|---------|-------------|
| `LoadSample n,"file.raw"` | Register raw 8-bit PCM sample at index n (INCBIN into chip RAM) |
| `PlaySample n,ch[,per[,vol]]` | Start Paula DMA channel ch looping; period default 428 (≈8287 Hz), volume default 64 |
| `PlaySampleOnce n,ch[,per[,vol]]` | Play sample once, then fall silent (Paula double-buffer trick) |
| `StopSample ch` | Stop Paula DMA channel (immediate silence) |

### Images (Blitter)
| Command | Description |
|---------|-------------|
| `LoadImage n,"file.raw",w,h` | Register raw planar image at index n (INCBIN into chip RAM; depth = screen depth); `LoadImage 0` also applies the image's embedded OCS palette at runtime |
| `DrawImage n,x,y` | Blit image n to back buffer at (x,y); x must be **word-aligned** (x%16 == 0) |

**Image file format (`.raw`):** produced by the Asset Manager.
- `[2^depth × 2 bytes]` OCS palette words (big-endian `$0RGB`); `LoadImage 0` copies these into the hardware color registers automatically.
- `[depth × height × rowbytes bytes]` planar bitplane data — plane 0 rows, then plane 1, etc. Each row is `((w+15)/16)*2` bytes (word-aligned).

The codegen prepends an 8-byte metadata header (`dc.w width, height, GFXDEPTH, rowbytes`) before the INCBIN. `_DrawImage` reads this header at runtime to skip the palette block and compute blit parameters.

### Copper Effects
| Command | Description |
|---------|-------------|
| `CopperColor y,r,g,b` | Set background colour (COLOR00) at raster line y via copper list |

### Code Organisation

| Directive | Description |
|-----------|-------------|
| `Include "file.bassm"` | Insert source file at this position (relative to project folder; recursive; circular detection) |

### Functions & Procedures

Blitz2D signature convention — parentheses mark the distinction:

| Declaration | Return value | Call site |
|-------------|--------------|-----------|
| `Function Name(p1, p2)` | yes — usable in expressions | `x = Name(a, b)` |
| `Function Name p1, p2` | none — statement-only | `Name a, b` |

```basic
; Function with return value (parentheses required)
Function Clamp(n, lo, hi)
  If n < lo Then Return lo
  If n > hi Then Return hi
  Return n
EndFunction

; Procedure — no return value (no parentheses)
Function DrawMark x, y
  Box x, y, 8, 8
EndFunction

x = Clamp(pos, 0, 300)   ; call in expression
DrawMark 100, 50          ; call as statement
```

Parameters and all variables assigned inside a function are **local** to that call.
Global variables of the same name are unaffected. Stack-frame layout: `LINK a6,#-n` /
`UNLK a6`; parameters at positive `a6` offsets (`8(a6)`, `12(a6)`, …), locals at
negative offsets (`-4(a6)`, `-8(a6)`, …).

---

## Hardware Notes (Amiga OCS, bare-metal)

- **Target:** OCS/ECS Amiga, PAL, Motorola 68000, Kickstart 1.3+
- **Compatibility:** executables run on AROS, real Amiga hardware, vAmiga, and WinUAE
- **Assembler:** `vasmm68k_mot -Fhunk` (object) + `vlink -bamigahunk` (executable)
- **Register convention:** `a5 = $DFF000` (custom chip base) for the entire program lifetime
- **VBL interrupt:** Level-3 autovector at `$6C`, 50 Hz PAL frame counter
- **Keyboard:** Interrupt-driven Level-2 (CIA-A) handler at `$68`; 128-key matrix in `startup.s`; `KeyDown(scancode)` tests any of 128 scancodes; `WaitKey` blocks until key release
- **Mouse:** Delta accumulation in VBL handler (JOY0DAT); left button = CIAAPRA bit 6; right button = POTINP bit 10 (POTGO init at startup)
- **Joystick:** JOY0DAT/JOY1DAT XOR-decode inline; fire = CIAAPRA bits 7/6
- **Blitter:** A→D mode with chip-RAM constant pattern rows (`_blt_ones_row` / `_blt_zero_row`); D-only mode does not work reliably in vAmiga

---

## Running

Requires **Node.js** and **Electron**.

```bash
npm install
npm start
```

The Amiga ROM (`aros.rom`) must be placed in the project root or loaded via the emulator controls. Tests (unit tests for the compiler pipeline) run with:

```bash
npm test
```

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full implementation plan.

**Next milestone:** M10 Hardware Scrolling · M-BOB (Bobs / sprite blitting with background restore).

Completed milestones: M0 (core pipeline), M1 (integer variables), M2 (If/Else), M3 (While/For), M4 (Select/Case), M5 (drawing commands), M5b (Blitter fill), M5c (Double-Buffering / `ScreenFlip`), M6 (Text / 8×8 font), M7 (Functions & Procedures: stack frame, local variables, Blitz2D signature convention), M8 (Arrays), M9a (WaitKey), M9b (full input: Joystick, `KeyDown`, Mouse — interrupt-driven, non-blocking), M-COPPER (`CopperColor` raster effects), PERF-A+B+C (optimised codegen), M-ASSET A2 (Sound: Paula DMA looping + one-shot, vAmiga Web Audio), M-ASSET A1 (Bitmaps: `LoadImage`/`DrawImage`, Blitter A→D), LANG-A (`And`/`Or`/`Not`), LANG-B (`Mod`), LANG-C (`Str$`: integer-to-string for live HUD display), LANG-D (`Rnd`/`Abs`: Xorshift32 random + inline absolute value), LANG-E (`Xor`/`Shl`/`Shr`: bitwise XOR and 68k shift instructions), LANG-F (`Repeat`/`Until`/`Exit`: do-while loop with multi-level break), TOOL-1 (`Include`: source file inclusion, recursive, circular detection), TOOL-IDE (IDE Budget Bars: live CPU-cycles + Chip RAM health bars in the editor).

---

## License

MIT — see `package.json`.
