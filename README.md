![BASSM](logo.png)

# BASSM — Blitz2D to Amiga m68k Assembler

A compiler and IDE that translates **Blitz2D**-style BASIC into native **Motorola 68000 assembly** for the Commodore Amiga, assembles and links it with **vasmm68k_mot + vlink**, and previews the result in the **vAmiga** WASM emulator — all inside a single Electron app.

Generated executables are standard **AmigaOS hunk binaries**, compatible with real Amiga hardware (OCS/ECS, KS 1.3+), WinUAE, vAmiga, and AROS. There is no runtime — every command compiles to inline m68k.

> **Documentation, tutorials, language reference:** [basm-amiga.com](https://basm-amiga.com)

---

## What it does

Write code on the left, click **Run** to compile, assemble, link and boot it in the embedded Amiga emulator. No Amiga hardware required.

```basic
Graphics 320, 256, 3
PaletteColor 0, 0,0,0     ; black background
PaletteColor 1, 15,0,0    ; red box
ClsColor 0

x = 10 : y = 10 : dx = 3 : dy = 2

While 1
  Cls
  x = x + dx : y = y + dy
  If x < 0   Or x + 30 > 320 Then dx = -dx : EndIf
  If y < 0   Or y + 20 > 256 Then dy = -dy : EndIf
  Color 1 : Box x, y, 30, 20
  ScreenFlip
Wend
```

---

## Pipeline

`Source → Lexer → Parser → CodeGen → Peephole → vasmm68k_mot → vlink → .exe → vAmiga / WinUAE / real Amiga`

Four passes in JS produce m68k assembly with a peephole optimiser as the final pass; vasm + vlink produce a clean AmigaOS hunk executable that is also written to the project folder for transfer to a real Amiga.

---

## Running

Requires **Node.js** (LTS). Supported on **Windows** and **Linux**.

```bash
npm install
npm start
```

The free AROS ROM is bundled — no Kickstart file needed.

```bash
npm test            # compiler unit tests
```

---

## Building a distributable

| Platform | Command | Output |
|---|---|---|
| Windows | `build-win.bat` | `dist/windows/BASSM-win-x64.exe` (portable) |
| Linux | `./build-linux.sh` | `dist/linux/BASSM-linux-x64.AppImage` |

Both scripts run `npm install` first. Linux AppImage needs `libfuse2`.

---

## Language

Blitz2D-compatible subset, integer-typed, with Amiga-aware extensions:

- **Drawing:** `Plot`, `Line`, `Rect`, `Box`, `Cls`, `Text`, `Color`, `PaletteColor`, `LoadFont` / `UseFont`
- **Tiles & scrolling:** `LoadTileset`, `LoadTilemap`, `DrawTilemap`, `SetTilemap`, `ChangeTile`, `SetCamera`, `SetViewport`, `Viewport`
- **Sprites:** `LoadImage`, `DrawImage`, `LoadAnimImage`, `LoadMask`, `SetBackground`, `DrawBob` (with auto background restore + masked draw)
- **Sound:** `LoadSample`, `PlaySample`, `PlaySampleOnce`, `StopSample` (Paula DMA)
- **Input:** `WaitKey`, `KeyDown`, `Joy*`, `MouseX/Y/Down/Hit`
- **Collision:** `RectsOverlap`, `ImagesOverlap`, `ImageRectOverlap` (all inline)
- **Control flow:** `If/ElseIf/Else/EndIf`, `While/Wend`, `Repeat/Until`, `For/Next`, `Select/Case`, `Exit n`
- **Functions & procedures** with locals and parameters (Blitz2D `Function`/`EndFunction`)
- **Arrays:** `Dim arr(d0, d1, …)`, N-dimensional
- **Constants & data:** `Const`, `Data` / `Read` / `Restore`
- **Math:** `+ - * /`, `Mod`, `Shl`, `Shr`, `And`, `Or`, `Xor`, `Not`, `Rnd`, `Abs`, `Str$`
- **Hardware:** `PeekB/W/L`, `PokeB/W/L`, `CopperColor` for raster bars
- **Code organisation:** `Include "file.bassm"`

Full reference with signatures, examples and gotchas: [basm-amiga.com/docs](https://basm-amiga.com).

---

## Targets

OCS/ECS Amiga · PAL · 68000 · Kickstart 1.3+. The IDE reports cycle and chip-RAM budgets per frame so programs stay within real hardware constraints.

---

## License

MIT — see `package.json`.
