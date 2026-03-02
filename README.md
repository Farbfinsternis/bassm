# BASSM — Blitz2D to Amiga m68k Assembler

A compiler and live-preview IDE that translates a subset of the **Blitz2D** BASIC dialect into native **Motorola 68000 assembly** for the Commodore Amiga, assembles it with **vasmm68k_mot**, and previews the result in the **vAmiga** WASM emulator — all inside a single Electron app.

---

## What It Does

Write Blitz2D-style code on the left; click **Run** to compile, assemble, and boot it in the embedded Amiga emulator on the right. No Amiga hardware required.

```basic
Graphics 320,256,5

PaletteColor 0,0,0,0      ; black background
PaletteColor 1,15,0,0     ; red box

ClsColor 0
Cls

x = 10 : y = 10 : dx = 3 : dy = 2

While 1
  Color 0 : Box x,y,30,20    ; erase old position
  x = x + dx : y = y + dy
  If x < 0    Then x = 0  : dx = -dx : EndIf
  If x > 290  Then x = 290 : dx = -dx : EndIf
  If y < 0    Then y = 0  : dy = -dy : EndIf
  If y > 236  Then y = 236 : dy = -dy : EndIf
  Color 1 : Box x,y,30,20    ; draw new position
  WaitVbl
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
vasmm68k_mot         assemble to Amiga HUNK binary (.exe)
      │
      ▼
   vAmiga            WASM emulator — boots the .exe and renders to canvas
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
startup.s      bare-metal system takeover (Forbid, VBL handler, keyboard ISR)
graphics.s     bitplane + copper list setup
cls.s          Blitter screen clear (_Cls, pattern buffers)
clscolor.s     _ClsColor (sets background fill colour)
color.s        _SetColor
palette.s      32-entry OCS palette (_InitPalette, _SetPaletteColor, _draw_color)
text.s         stub (bitmap font not yet implemented)
plot.s         _Plot (single pixel, CPU)
line.s         _Line (Bresenham, CPU)
rect.s         _Rect (outline rectangle, CPU)
box.s          _Box (filled rectangle, Blitter A→D)
waitkey.s      _WaitKey (interrupt-driven CIA-A keyboard)
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

### Control Flow
| Construct | Description |
|-----------|-------------|
| `If expr … EndIf` | Conditional block |
| `If expr … Else … EndIf` | With else branch |
| `If … ElseIf … EndIf` | ElseIf chain |
| `While expr … Wend` | While loop |
| `For v = a To b [Step s] … Next` | For loop |
| `Select expr … Case v … EndSelect` | Select/Case |

### Variables & Expressions
- Integer variables (`x = expr`)
- Arithmetic: `+ - * /` with correct precedence, unary minus
- Comparisons: `= <> < > <= >=` (return Blitz2D boolean −1/0)
- Variables as command arguments

### Timing & Input
| Command | Description |
|---------|-------------|
| `WaitVbl` | Wait for next vertical blank (50 Hz PAL) |
| `Delay n` | Wait n VBlanks |
| `WaitKey` | Halt until any key is pressed (interrupt-driven CIA-A) |

---

## Hardware Notes (Amiga OCS, bare-metal)

- **Target:** OCS/ECS Amiga, PAL, Motorola 68000, Kickstart 1.3+
- **Assembler:** `vasmm68k_mot -Fhunk` + `vlink`
- **Register convention:** `a5 = $DFF000` (custom chip base) for the entire program lifetime
- **VBL interrupt:** Level-3 autovector at `$6C`, 50 Hz PAL frame counter
- **Keyboard:** Interrupt-driven Level-2 (CIA-A) handler at `$68`; `_kbd_pending` byte shared with `_WaitKey`
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

**Current milestone:** M5b (Blitter drawing) + M5c (Double-Buffering / `ScreenFlip`).

Completed milestones: M0 (core pipeline), M1 (integer variables), M2 (If/Else), M3 (While/For), M4 (Select/Case), M5 (drawing commands), M9-partial (WaitKey).

---

## License

MIT — see `package.json`.
