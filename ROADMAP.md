# BASSM – Roadmap

## Status-Legende
- `[ ]` offen  |  `[~]` in Arbeit  |  `[x]` fertig

---

## ✅ Abgeschlossene Milestones

| Milestone | Inhalt |
|-----------|--------|
| **M0** Kern-Pipeline | PreProcessor · Lexer · Parser · CodeGen · vasm/vlink · vAmiga |
| **M1** Integer-Variablen & Ausdrücke | Zuweisung, `+ - * /`, unäres Minus, Vergleiche, `moveq`-Optimierung |
| **M2** Kontrollfluss If/Else | Einzeilig + Block, ElseIf-Kette, eindeutige Labels |
| **M3** Schleifen While/For | While·Wend, For·To·Step·Next; `While 1` ohne Test-Overhead |
| **M4** Select/Case | Mehrere Werte pro Case, Default-Branch |
| **M5** Zeichenbefehle | Plot, Line (Bresenham), Rect (Umriss), Box (gefüllt) |
| **M5b** Blitter | WaitBlit, Blitter-Cls, Blitter-Box, Blitter-Rect via 4×Box |
| **M5c** Double-Buffering | Zwei Copper-Listen, ScreenFlip, alle Draw-Befehle → Back-Buffer |
| **M8** Arrays + `:` Trenner | `Dim arr(n)`, arr(i) lesen/schreiben, `:` als Statement-Separator |
| **M9a** WaitKey | CIA-A SP-Flag, Interrupt-driven, Level-2-Vektor |
| **PERF-A** Direkte Bcc-Sprünge | `_genCondBranch`: `cmp.l + Bcc` statt `Scc+ext+tst+beq` — 4 Instr. pro Condition |
| **PERF-B** Stack-Eliminierung | `_isSimpleExpr`: `x+1`, `x+dx`, `x<320` ohne Push/Pop; `addq`/`subq` für 1..8 |
| **Runtime PaletteColor** | `_SetPaletteColorRGB(d0,d1,d2,d3)` in `palette.s`; alle 4 Args als Ausdrücke |
| **M-COPPER** Rasterbalken | `CopperColor y,r,g,b`; `_gfx_raster_a/b` in Copper-Listen; `copper_raster.s`; GFXRASTER EQU |
| **M6** Text | `Text x,y,"str"` → CPU 8×8 Font, per-Plane per-Row, Shift-Trick, Newline-Support |
| **PERF-C** CopperColor-Inlining | `CopperColor` inline expandiert; kein JSR-Overhead; ~120 Zyklen/Aufruf gespart |
| **M-ASSET A2** Sound | `PlaySample "f.raw",ch,per,vol` + `StopSample ch`; Paula DMA; `sound.s`; Asset-Pipeline |
| **M-ASSET A1** Bitmaps | `LoadImage n,"f.raw",w,h` + `DrawImage n,x,y`; Blitter A→D; `image.s`; 8-Byte-Header |
| **M7** Funktionen / Prozeduren | `Function name(params)` (Rückgabewert, Klammern) + `Function name params` (Prozedur, ohne Klammern); Stack-Frame via LINK/UNLK; lokale Parameter + Variablen; `Return [expr]`; Blitz2D-Signatur-Konvention |
| **LANG-A** And / Or / Not | `And`/`Or` (bitweise, auch logisch für -1/0 Werte) + `Not` (Komplement); alle drei als Präzedenzebenen im Parser; PERF-B für einfache Operanden; constant-folding für `Not <literal>` |
| **LANG-B** Mod | Modulo-Operator; gleiche Präzedenz wie `*`/`/`; `divs.w + swap + ext.l`; PERF für literal Divisor |
| **TOOL-1** Include | `Include "file.bassm"` — rekursive Datei-Inklusion im PreProcessor; async IPC-Readback; Circular-Detection; Path-Traversal-Schutz |

---

## 📋 Geplante Milestones — Ziel: 100% Amiga-Game-Complete

---

### PERF — Code-Optimierungen
> **Voraussetzung für komplexe Demos:** Ohne Optimierungen sind 50+ Objekte oder
> Effekt-Loops zu CPU-intensiv für stabile 50 fps.

#### ✅ PERF-A — Direkte Bedingungssprünge (`Bcc` statt `Scc`) 🟡 Mittel
**Jede `If`/`While`-Condition spart 4 Instruktionen:**
```m68k
; vorher:    cmp.l d1,d0 / slt d0 / ext.w d0 / ext.l d0 / tst.l d0 / beq.w .L1
; nachher:   cmp.l #10,d0 / bge.w .L1                (PERF-B + PERF-A kombiniert)
```
- `[x]` `_genCondBranch(expr, falseLbl, lines)` in `codegen.js`
- `[x]` `_genIf` und `_genWhile` rufen `_genCondBranch` statt `_genExpr` auf
- `[x]` Fallback auf `_genExpr + tst.l + beq.w` für boolesche Ausdrücke als Wert

#### ✅ PERF-B — Stack-Eliminierung für einfache Ausdrücke 🟡 Mittel
**`x+1`, `x+dx`, `x<320` ohne Push/Pop:**
```m68k
; vorher:    move.l d0,-(sp) / move.l _var_x,d0 / move.l (sp)+,d1 / add.l d1,d0
; nachher:   move.l _var_x,d0 / addq.l #1,d0      (addq für 1..8)
; nachher:   move.l _var_x,d0 / add.l _var_dx,d0  (Memory-Operand)
```
- `[x]` `_isSimpleExpr(expr)` / `_simpleOperand(expr)` Hilfsmethoden
- `[x]` `_genBinop`: +/- ohne Push/Pop; `addq`/`subq` für 1..8
- `[x]` `_genBinop` Comparison-Pfad: `cmp.l` direkt ohne Push/Pop

---

### ✅ M6 — Text & Palette-Animation

- `[x]` `text.s`: `_Text(a0=str, d0=x, d1=y)` — CPU-Rendering, 8×8 Font, per-Plane per-Row
  - Shift-Trick: `lsl.w #8 / lsr.w d6` → hi/lo-part ohne Extra-Register
  - SET: `or.b`; CLR: `not.w + and.b`; Newline `$0A`: x=0, y+=8; Bounds-Check
  - `INCLUDE "font8x8.s"` am Anfang — 768 Byte Fontdaten in DATA_C Chip-RAM
- `[x]` `_NPrint` — no-op (Blitz2D-Kompatibilität)
- `[x]` CodeGen: `Text x,y,"string"` → String inline eingebettet + `jsr _Text`
- `[x]` **Runtime `PaletteColor n,r,g,b`** mit Variablen/Ausdrücken als Argumente
  (`_SetPaletteColorRGB` in `palette.s`; CodeGen fällt auf Compile-Time-Pfad zurück wenn alle Literal)
- `[ ]` **`LoadPalette arr`** — alle 32 Palette-Einträge aus einem Integer-Array setzen;
  `palette.s`-Fragment: Schleife `COLOR00+n*2` aus Array füllen

---

### ✅ M-COPPER — Copper-Rastereffekte

- `[x]` **`CopperColor y, r, g, b`** — setzt `COLOR00` an Rasterzeile `y` im Back-Copper
  - CodeGen: Raster-Einträge (`WAIT+MOVE COLOR00`) in beide Copper-Listen eingebettet
  - `_gfx_raster_a` / `_gfx_raster_b` — XDEF-Labels für Laufzeit-Patching
  - `_SetRasterColor(d0=y, d1=ocs_word)` + `_SetRasterColorRGB(d0=y, d1=r, d2=g, d3=b)` in `copper_raster.s`
  - Compile-Time-Pfad (alle Literale) + Runtime-Pfad (Variablen/Ausdrücke)
  - `GFXRASTER EQU min(H, 212)` — nutzbare PAL-Rasterzeilen
  - Nur wenn `CopperColor` verwendet: kein Overhead für Programme ohne Rastereffekt
- `[x]` **Rasterbalken-Demo** im Sample — animierter RGB-Gradient über 212 Zeilen
- `[ ]` **Copper-Interrupt** (optional) — Level-3 Copper-Interrupt statt WAIT für exaktes Timing

---

### M-ASSET — Asset-Loading *(Neuer Milestone)*
> **Ohne Bitmap- und Sound-Loading ist keine vollständige Demo möglich.**

#### ✅ A1 — Bitmaps einbetten und anzeigen 🟡 Mittel
Raw-Bitplane-Daten per `INCBIN` in die Executable einbetten und per Blitter in den Back-Buffer kopieren.
- `[x]` **`LoadImage index, "datei.raw", width, height`** — Deklaration; bettet Bild als `DATA_C`-Label ein
  - CodeGen prepends 8-Byte-Header (`dc.w width, height, GFXDEPTH, rowbytes`) vor `INCBIN`
  - `_DrawImage` liest Header zur Laufzeit — kein Pre-Pass, keine IPC-Roundtrip
  - `rowbytes = ((width+15)/16)*2` (word-aligned)
  - Asset-Pipeline: Datei aus Projektordner → tmpDir kopiert (analog zu `LoadSample`)
- `[x]` **`DrawImage index, x, y`** — zeichnet Bild in Back-Buffer
  - `image.s`: `_DrawImage(d0=x, d1=y, a0=img_ptr)` — Blitter A→D, Minterm `$09F0` (D=A), pro Plane
  - BLTDMOD = GFXBPR − rowbytes; BLTSIZE = (height<<6) | (rowbytes/2); `x` muss byte-aligned sein
  - Kein Clipping; kein Transparenz-Masking (full-replace)
- `[ ]` IFF ILBM Parser (optional, spätere Phase) — für Standard-Amiga-Bildformat

#### ✅ A2 — Sound-Wiedergabe 🟡 Mittel
Amiga hat 4 DMA-Audiokanäle (Paula). Einfachste Ebene: rohe 8-Bit-Samples.
- `[x]` **`LoadSample index, "datei.raw"`** — Deklaration; bettet Sample per `INCBIN` als `DATA_C`-Sektion ein
- `[x]` **`PlaySample index, channel [, period [, volume]]`**
  - `period` + `volume` optional (Defaults: 428 ≈ 8287 Hz, 64 = Max)
  - `sound.s`: `_PlaySample(d0=ch, a0=ptr, d1=len_words, d2=period, d3=vol)` via Paula-Register
  - CodeGen: Index → `_snd_N`-Label; Länge als Assembler-Ausdruck `(end-start)/2`
  - Asset-Pipeline: Dateien aus `app/assets/` → tmpDir kopiert vor vasm-Aufruf
  - DMACON: Audio-DMA per Kanal einschalten (Bit 15=1 SET | 1<<channel)
- `[x]` **`StopSample channel`** — Audio-DMA des Kanals ausschalten (Bit 15=0 CLR | 1<<channel)
- `[x]` **`PlaySampleOnce index, channel [, period [, volume]]`** — Echte One-Shot-Wiedergabe:
  Paula Double-Buffering: echte Sample-Daten in AUDx schreiben, DMA aktivieren, Fixed-Delay
  (200× dbra ≈ 2000 Zyklen ≥ 4× maximale Latch-Zeit von 456 Zyklen), dann AUDxLCH/LCL/LEN
  auf `_null_snd` (1 stilles Wort, Chip-RAM) umschreiben → stilles Looping nach Sampleende.
  DMA-Stop + doppelter INTREQ-Clear vor Neustart verhindert veraltete INTREQ-Bits.
- `[x]` **vAmiga Web Audio Pipeline** — `setupAudio()` in `preview.html`:
  `ScriptProcessorNode(1024)` + `_wasm_set_sample_rate` + `_wasm_leftChannelBuffer`/
  `_wasm_rightChannelBuffer` + `_wasm_update_audio(offset)` Ping-Pong;
  `--autoplay-policy=no-user-gesture-required` in `main.js`; `Module.HEAPU32.buffer`
  statt `Module.HEAPF32.buffer` (letzteres in diesem vAmiga-Build nicht exportiert).
- `[ ]` **ProTracker-Modul** (spätere Phase) — `PlayModule "song.mod"` startet den PT-Player
  - Erfordert: eingebetteten PT-Player (ca. 1 KB), VBlank-Hook für Player-Update
  - Praktisch: fertigen PT-Player aus `startup.s` heraus aufrufen

---

### ✅ LANG-A — Logische & Bitweise Operatoren

```blitz
If x > 0 And x < 320 Then ...      ; compound condition
If fire Or timer > 100 Then ...
While lives > 0 And level < 10
    col = red And $0F               ; bitwise masking
    flags = flags Or %00000010      ; bit set
    If Not done Then ...
Wend
```

- `[x]` `keywords-map.json`: `And`, `Or`, `Not` als Keywords registriert
- `[x]` Parser: Präzedenzebenen `_parseOr()` → `_parseAnd()` → `_parseComparison()` (Or < And < Cmp)
- `[x]` Parser: `Not` als Unary-Operator in `_parseUnary()` — vor `-`; constant-folding `Not 0 → -1`
- `[x]` CodeGen `_genBinop`: `And` → `and.l d1,d0`; `Or` → `or.l d1,d0` (PERF-B: direkt wenn rechts einfach)
- `[x]` CodeGen `_genExpr` unary: `Not` → `not.l d0`
- `[x]` `_genCondBranch`: `And`/`Or` nutzen vorhandenen Fallback (`tst.l + beq.w`) — korrekt für -1/0 Werte
- `[ ]` Kurzschluss-Auswertung (optional, niedrige Prio — 68000 hat keinen Branch-Predictor)

---

### ✅ LANG-B — `Mod`-Operator

```blitz
frame = (frame + 1) Mod 8          ; animation cycling
x = (x + dx + 320) Mod 320         ; screen wraparound
If ticks Mod 50 = 0 Then ...        ; every second
```

- `[x]` `keywords-map.json`: `Mod` als Keyword registriert
- `[x]` Parser: `Mod` in `_parseMulDiv()` — gleiche Präzedenz wie `*`/`/`
- `[x]` CodeGen: `divs.w #n,d0` (PERF: literal Divisor ohne push/pop) + generic push/pop-Pfad
  - `divs.w`: d0.l ÷ d1.w → d0.hi = Rest, d0.lo = Quotient
  - `swap d0` → Rest in d0.lo; `ext.l d0` → 32-Bit vorzeichenbehaftet
- Divisor muss in 16 Bit passen — für alle typischen Spielwerte (Breite, Frames, Farben) gegeben

---

### ✅ TOOL-1 — `Include` — Code aus externen Dateien einbinden

```blitz
; main.bassm
Include "constants.bassm"
Include "physics.bassm"
Include "graphics_utils.bassm"

Graphics 320,256,3
; ... Hauptprogramm
```

- `[x]` PreProcessor: `expandIncludes(source, { readFile, _visited })` — rekursive Expansion
  - Erkennt `Include "filename"` (case-insensitiv) als eigene Zeile (auch mit `;`-Kommentar)
  - `readFile(filename)` — async Callback; Dateiname relativ zum Projektordner
  - Circular-Detection via `Set<string>` der bereits expandierten Dateinamen
  - Klare Fehlermeldungen: "file not found", "circular include", "requires open project"
  - Läuft **vor** `process()` (vor Comment-Strip und Colon-Split) — im rohen Quelltext
- `[x]` `bassm.js` `run()`: `await expandIncludes()` vor `compile()` — async Pre-Pass
- `[x]` IPC `bassm:read-file` in `main.js`: liest Datei aus `projectDir`; Path-Traversal-Schutz
- `[x]` `preload.js`: `readFile(payload)` via `ipcRenderer.invoke('bassm:read-file', payload)` exponiert
- `[x]` `Include` in Docs dokumentieren (bassm_doc.md, docs.de.md, docs.en.md, README.md)

---

### LANG-C — Zahlen als Text ausgeben *(Game-Complete-Blocker)*
> `Text` akzeptiert nur String-Literale. Score, Lives, Timer — alles nicht anzeigbar.
> Minimal nötig: `Str$(n)` oder `NPrint n` mit Integer-Argument.

```blitz
Text 10, 10, "Score: " + Str$(score)
Text 10, 20, "Lives:  " + Str$(lives)
NPrint score                        ; Blitz2D-Kompatibilität
```

- `[ ]` `int_to_str` Routine in `text.s` (oder eigenem Fragment): `divs.w #10` loop → Ziffern auf Stack, dann rückwärts ausgeben; negatives Vorzeichen `-` voranstellen
- `[ ]` `Str$(n)` — Funktion: konvertiert Integer → temporären String-Puffer (`_str_buf` in BSS), gibt Adresse in d0 zurück
- `[ ]` `NPrint x,y,n` — Prozedur: `int_to_str` + `_Text` an angegebener Position
- `[ ]` CodeGen: `Str$(expr)` als `call_expr`; result-Adresse als String-Pointer an `_Text` weiterreichen
- `[ ]` String-Concatenation: `"prefix" + Str$(n)` → zwei aufeinanderfolgende Text-Aufrufe; oder `NText x,y,"prefix",n` als kombinierter Befehl

---

### LANG-D — Math-Funktionen: `Rnd` + `Abs`

```blitz
x = Rnd(320)              ; zufällige X-Position 0..319
speed = Rnd(3) + 1        ; 1..3
dist = Abs(x2 - x1)       ; absoluter Abstand
If Abs(vx) < 1 Then vx = 1  ; Minimalgeschwindigkeit
```

- `[ ]` **`Rnd(n)`** — Zufallszahl 0..n−1
  - Linearer Kongruenzgenerator: `seed = seed × 1664525 + 1013904223` (Numerical Recipes)
  - `_rnd_seed` BSS Long; `muls.l` (68020) oder `muls.w` + Shift-Kombination (68000-safe)
  - Rückgabe: `(seed >> 16) And $7FFF Mod n`; Codegen emittiert JSR `_Rnd` mit arg in d1
  - Fragment `rnd.s` — nur eingebunden wenn `Rnd` verwendet wird
- `[ ]` **`Abs(n)`** — absoluter Betrag
  - Inline-Expansion: `tst.l d0 / bge .skip / neg.l d0`; kein Fragment nötig
  - Codegen: `abs_expr` node → 3 Instruktionen inline
- `[ ]` Parser: `Rnd(expr)` als `call_expr`; `Abs(expr)` als `unary_builtin`

---

### LANG-E — Fehlende Operatoren: `Xor` · `Shl` · `Shr`

```blitz
flags = flags Xor %00000100     ; Bit 2 toggeln
color = r Shl 8 Or g Shl 4 Or b ; OCS-Palette-Word packen
x = x Shr 4                     ; schnelle Division durch 16
mask = 1 Shl bitnum              ; Bit-Maske berechnen
```

- `[ ]` **`Xor`** — bitweises XOR; gleiche Präzedenz wie `And`/`Or`
  - Codegen: `eor.l d1,d0` (68k nennt es EOR, nicht XOR)
  - Parser-Ebene: `Or < Xor < And` oder `And < Xor < Or`?
    → Blitz2D: Xor auf gleicher Ebene wie Or (`Or`/`Xor` zwischen And und Comparison)
- `[ ]` **`Shl`** — arithmetischer Linksshift; gleiche Präzedenz wie `*`/`/`/`Mod`
  - Literal rechts: `asl.l #n,d0` (n≤8 direkt; n>8: loop oder `lsl.l d1,d0`)
  - Variable rechts: Shift-Count in d1, `lsl.l d1,d0`
- `[ ]` **`Shr`** — arithmetischer Rechtsshift (vorzeichenbehaftet: `asr.l`)
  - Literal: `asr.l #n,d0`; Variable: `asr.l d1,d0`
- `[ ]` PERF-B Erweiterung: `_isSimpleExpr` für Shl/Shr mit literal Shift-Count

> **Shl/Shr sind auf dem Amiga besonders wichtig:** OCS-Farbregister, DMA-Bits,
> Sprite-Koordinaten, BLTCON-Felder — alle sind bit-packed. Ohne Shift-Operatoren
> muss man mit `*` und `/` arbeiten, was auf dem 68000 deutlich langsamer ist.

---

### LANG-F — Kontrollfluss-Vervollständigung: `Repeat/Until` · `Exit`

```blitz
; Repeat/Until — natürliche "do while"-Schleife
Repeat
  ReadInput
  UpdatePhysics
  ScreenFlip
Until lives = 0 Or level > 10

; Exit — frühzeitiger Schleifenabbruch
For i = 0 To 63
  If arr(i) = target Then found = i : Exit
Next i

While 1
  If quit Then Exit
  UpdateGame
Wend
```

- `[ ]` **`Repeat … Until cond`**
  - Parser: `REPEAT` → Body → `UNTIL` → Bedingung
  - CodeGen: Loop-Label vor Body; `_genCondBranch(cond, loopLabel, lines)` am Ende (Sprung wenn falsch → zurück)
  - Until-Bedingung: wahr = verlassen, falsch = wiederholen (invertierte Logik gegenüber While)
- `[ ]` **`Exit [n]`** — verlässt n verschachtelte Schleifen (Standard: 1)
  - CodeGen: `bra.w .loop_end_label`; braucht Label-Stack für While/For/Repeat
  - `n > 1` selten, aber in Blitz2D dokumentiert — zunächst nur n=1 implementieren

---

### M9b — Eingabe (Joystick · Keyboard · Maus)

```blitz
; Joystick
If Joydown(1) And %0001 Then y = y - 1  ; hoch
If Joydown(1) And %0010 Then y = y + 1  ; runter
If Joydown(1) And %0100 Then x = x - 1  ; links
If Joydown(1) And %1000 Then x = x + 1  ; rechts
If Joyfire(1) Then Fire

; Tastatur (non-blocking)
If KeyDown($45) Then End    ; Escape

; Maus
mx = MouseX : my = MouseY
If MouseB(1) Then Click
```

- `[ ]` **`Joydown(port)`** — gibt Richtungs-Bitfeld zurück (Bit 0=oben, 1=unten, 2=links, 3=rechts)
  - Liest `JOY0DAT`/`JOY1DAT` ($DFF00A/$DFF00C) — Quadratur-Decoder
  - Standard-Dekodierung: `right = (dat>>1) Xor dat`, dann Bits ausmaskieren
  - CIAAPRA ($BFE001) für Up/Down (Joystick Port 1)
- `[ ]` **`Joyfire(port)`** — Feuer-Knopf; CIAAPRA Bit 7 (Port 1) / Bit 6 (Port 2)
- `[ ]` **`KeyDown(scancode)`** — Echtzeit-Tastencheck
  - CIA-A Handler in `startup.s` bereits vorhanden; Erweiterung: Key-Down-Matrix statt nur `_kbd_pending`
  - `_kbd_matrix` 8-Byte-BSS (64 Tasten); Handler setzt/löscht Bits beim Key-Down/Up
- `[ ]` **`MouseX`** / **`MouseY`** — Maus-Delta aus JOY0DAT (Low-Byte X, High-Byte Y)
  - Absolut-Position akkumulieren: `_mouse_x`/`_mouse_y` BSS, vom VBL-Handler geupdated
- `[ ]` **`MouseB(n)`** — Maustaste; Bit 10 von POTGOR ($DFF016) für rechte Taste; CIAAPRA für linke

---

### M-SYS — Direkter Hardware-Zugriff: `Peek` · `Poke`

```blitz
; Hardware-Register direkt lesen/schreiben
beam   = PeekW($DFF006) And $1FF  ; vertikale Strahlposition (VPOSR)
PokeW  $DFF180, $0F00             ; COLOR00 direkt auf Rot setzen
PokeL  $DFF040, bltcon            ; Blitter-Control direkt schreiben

; Chip-RAM manipulieren
PokеB $BFE001, PeekB($BFE001) And %11111110  ; CIA-A bit0 löschen
```

- `[ ]` **`PeekB(addr)`** / **`PeekW(addr)`** / **`PeekL(addr)`** — liest 1/2/4 Bytes von Adresse
  - Codegen: `move.l addr_expr,a0 / move.b/w/l (a0),d0`; kein Fragment
  - Adresse kann Literal (`$DFF006`) oder Variable sein
- `[ ]` **`PokeB addr, val`** / **`PokeW addr, val`** / **`PokeL addr, val`** — schreibt Bytes
  - Codegen: `move.l addr,a0 / move.l val,d0 / move.b/w/l d0,(a0)`; inline
- `[ ]` Kurzform: `Poke addr, val` als Alias für `PokeL` (Blitz2D-Kompatibilität)

> **Begründung:** Mit Peek/Poke kann der Programmierer alles, was BASSM noch nicht
> abstrahiert hat — Copper direkt patchen, Blitter-Register setzen, Custom Chips
> jenseits der BASSM-API ansprechen. Das ist die "Ausflucht nach unten" die jede
> Amiga-Sprache bieten muss.

---

### M-DATA — 2D-Arrays

```blitz
Dim map(19, 14)          ; 20×15 Tile-Map
map(x, y) = TILE_WALL
tile = map(px / 16, py / 16)

Dim board(7, 7)          ; 8×8 Spielfeld
```

- `[ ]` Parser: `Dim name(w, h)` — zweites Argument optional; AST-Node `dim2d`
- `[ ]` CodeGen: BSS `ds.l (w+1)*(h+1)`; Index-Formel `y*(w+1)+x` inline bei jedem Zugriff
- `[ ]` `arr(x, y)` lesen/schreiben — gleiche Syntax wie 1D mit 2 Argumenten
- `[ ]` Abwärtskompatibel: bestehende 1D-Syntax unverändert

---

### M-TYPE — Strukturen (`Type … EndType`)

> **Das wichtigste fehlende Feature für Spiele.**
> In Blitz2D ist jedes Spiel um Types herum gebaut. Ohne Types: N parallele Arrays.
> Mit Types: saubere Objekt-Abstraktion, lesbarer Code, wartbare Programme.

```blitz
Type Enemy
  Field x
  Field y
  Field vx
  Field vy
  Field hp
  Field active
EndType

Dim enemies.Enemy(15)    ; 16 statische Enemy-Instanzen

enemies(i)\x = Rnd(320)
enemies(i)\y = Rnd(256)
enemies(i)\active = 1

If enemies(i)\hp <= 0 Then enemies(i)\active = 0
```

**Implementierungsansatz: Statische Arrays von Strukturen (kein Heap)**
- Kein `New`/`Delete` — bare-metal, kein Heap-Allocator nötig
- `Dim name.TypeName(n)` erzeugt statisches Array von n+1 Instanzen in BSS
- Feldgröße: 4 Bytes (Long) pro Feld; Struct-Größe = Feldanzahl × 4
- `arr(i)\field` → Adresse = `base + i*structsize + fieldOffset`

**Implementierungsschritte:**
- `[ ]` Parser: `Type name … Field fname … EndType` — TypeDef-Registry im Parser
- `[ ]` Parser: `Dim arr.TypeName(n)` — typedArray-Node; erkennt TypeName
- `[ ]` Parser: `arr(i)\field` lesen/schreiben — `field_access`-Node
- `[ ]` CodeGen: TypeDef-Map `{name → {fields: [...], size: n*4}}`
- `[ ]` CodeGen: `Dim arr.Type(n)` → BSS `ds.l (n+1)*structsize`
- `[ ]` CodeGen: `arr(i)\field` → `move.l i_expr,d0 / muls.w #structsize,d0 / add.l #fieldOffset,d0 / move.l (base,d0.l),d1`
- `[ ]` Fehlerprüfung: unbekannter Type, unbekanntes Feld → Compiler-Fehler

---

### M10 — Hardware-Grafik

```blitz
; Sprites (8 Hardware-Sprites à 16×Hpx, eigene Farben)
DefSprite 0, spriteData    ; Sprite 0 aus Daten-Label definieren
MoveSprite 0, px, py       ; Sprite 0 an Position setzen
HideSprite 0               ; Sprite 0 ausblenden

; Hardware-Scrolling
ScrollX 8                  ; bitplane um 8 Pixel nach links scrollen (BPLCON1)
ScrollY 1                  ; vertikales Scrolling (BPL1MOD/BPL2MOD)

; Kreis
Circle 160, 128, 50        ; CPU Bresenham-Kreis
```

- `[ ]` **Hardware-Sprites** — 8 OCS Sprites × 16px Breite, eigene Farben, keine Blitter-/CPU-Last
  - `sprite.s`: `_DefSprite(d0=num, a0=data_ptr)` — SPRxPT + Sprite-DMA aktivieren
  - `_MoveSprite(d0=num, d1=x, d2=y)` — SPRxPOS/SPRxCTL patchen
  - `_HideSprite(d0=num)` — SPRxPOS=0 → unsichtbar
  - Sprite-Daten als INCBIN oder inline in CODE-Section
  - Sprite-DMA: DMACON Bit 5 (SPREN)
- `[ ]` **Hardware-Scrolling** — `ScrollX n`: BPLCON1 (Fine-Scroll 0..15), BPL1MOD/BPL2MOD für Coarse-Scroll
- `[ ]` **`Circle x,y,r`** — Bresenham-Kreis in `circle.s`, nutzt `_Plot` intern

---

### M-MOD — ProTracker MOD-Player *(Demo-Musik)*

```blitz
LoadModule "mysong.mod"   ; MOD-Datei laden (INCBIN in DATA_C)
PlayModule                 ; Abspielen starten (VBlank-Hook)
StopModule                 ; Stoppen
```

- `[ ]` Fertigen PT-Player als Fragment einbinden (`ptplayer.s` — öffentlich Domain, ~1KB)
- `[ ]` VBlank-Hook in `startup.s` ruft `_mt_music` bereits auf (50 Hz) — Infrastruktur vorhanden
- `[ ]` `LoadModule` → INCBIN DATA_C (Asset-Pipeline analog zu LoadSample)
- `[ ]` `PlayModule` / `StopModule` → `_mt_init` / `_mt_end` in `ptplayer.s`
- `[ ]` Paula-Kanäle 0–3 teilen sich zwischen MOD-Player und Sample-Befehlen → Kanal-Verwaltung

> **Begründung:** "Eine Demo ohne Musik ist ein Bildschirmschoner." Mit ProTracker-Support
> kann man fertige Amiga-MODs abspielen. Ohne das: nur Sample-Loops, kein richtiger Soundtrack.

---

### ✅ M7 — Funktionen / Prozeduren

**Blitz2D Signatur-Konvention:**
- `Function name(param, …)` — **mit Klammern** = Funktion mit Rückgabewert
- `Function name param, …` — **ohne Klammern** = Prozedur (kein Rückgabewert)

**Stack-Frame (LINK/UNLK):**
```
8(a6)  = param[0]   (erster Parameter)
12(a6) = param[1]   …
-4(a6) = local[0]   (erste lokale Variable)
-8(a6) = local[1]   …
```

- `[x]` Parser: `Function name(params)` … `EndFunction` (`hasReturn=true`)
- `[x]` Parser: `Function name params` … `EndFunction` (`hasReturn=false`, Prozedur)
- `[x]` Parser: User-Prozedur-Aufruf `name arg1, arg2` (Statement ohne Klammern)
- `[x]` Parser: Funktionsaufruf `name(arg1, arg2)` in Ausdrücken (`call_expr`)
- `[x]` Parser: `Return [expr]`
- `[x]` CodeGen: Separate `SECTION func_name,CODE` pro Funktion; `_func_name:` XDEF
- `[x]` CodeGen: LINK a6,#-n / UNLK a6; Caller-Cleanup nach JSR
- `[x]` CodeGen: Parameter-Zugriff via positiver Frame-Offset `8(a6)`, `12(a6)` …
- `[x]` CodeGen: Lokale Variablen via negativem Frame-Offset `-4(a6)`, `-8(a6)` …
- `[x]` CodeGen: `_varRef(name)` — global BSS oder Frame-relative Adressierung
- `[x]` Fehlerprüfung: Prozedur in Ausdrucks-Kontext → Compiler-Fehler
- `[x]` Fehlerprüfung: `Return expr` in Prozedur → Compiler-Fehler

---

### PERF-C — Optionale Variablen-Typisierung *(niedrige Prio, Expert-Feature)*
> **Hintergrund:** Alle Variablen sind derzeit 32-Bit Long (`ds.l`). `move.w` spart
> ~4 Zyklen gegenüber `move.l` auf dem 68000; der Hauptgewinn liegt in kleinerem
> Chip-RAM-Verbrauch (BSS). Automatische Typinferenz ist nicht zuverlässig machbar,
> da der Wertebereich von Variablen (z.B. Koordinaten, die sich per `x = x + dx`
> verändern) zur Compile-Zeit nicht bekannt ist. Daher: **optionales Opt-in-Suffix**,
> der User muss es nie verwenden.

```blitz
; Ohne Suffix: Long (default, immer sicher)
x = 100
dx = 3

; Optionale Suffixe für Experten:
col.b = 1      ; Byte  — ds.b, move.b (0..255)
px.w  = 160    ; Word  — ds.w, move.w (−32768..32767)
total.l = 0    ; Long  — ds.l, move.l (explizit, wie default)

; Arrays ebenfalls typisierbar:
Dim bx.w(7)    ; Word-Array statt Long-Array
```

**Implementierungsaufwand: 🔴 Hoch**
- Lexer: Suffix `.b`/`.w`/`.l` am IDENT-Token erkennen (Punkt ist aktuell kein Operator)
- Parser: Typ-Info in `assign`-, `dim`-, `array_assign`/`array_read`-Nodes übertragen
- CodeGen: Variable-Registry `Map<name, {type, size}>` statt nur `Set<name>`
- `_genExpr` / `_genBinop`: `move.b`/`move.w`/`move.l` je nach Typ; sign-extend bei
  Promotion (`ext.w d0` + `ext.l d0` für Byte→Long in Ausdrücken)
- BSS: `ds.b`/`ds.w`/`ds.l` je nach Typ; Byte/Word müssen word-aligned sein (`even`)
- Typpromotion-Regel: kleiner Typ + großer Typ → Long (sicher, kein stiller Überlauf)
- `[ ]` Suffix-Erkennung im Lexer
- `[ ]` Typ-Propagation durch Parser-AST
- `[ ]` Typisierter CodeGen (BSS + Lade/Speicher-Instruktionen)
- `[ ]` Typpromotion in `_genBinop`

---

### PERF-low — Niedrige Priorität

- `[ ]` **Short Branches** (`.s` statt `.w`): minimaler Effekt auf 68000, kein Cache
- `[ ]` **Register-Caching** (häufige Variablen in d2–d7 halten): erst nach M7 sinnvoll
  (braucht Scope-Analyse und Spill-Logik an jsr-Grenzen)
- `[ ]` **Subroutinen-Argumente direkt in Register** (statt Push/movem): spart Stack-Overhead
  bei einfachen Argumenten zu `Box`, `Line`, `Rect`

---

### M11 — String-Variablen *(niedrige Demo-Prio)*

- `[ ]` `name$ = "text"`, Konkatenation `a$ + b$`
- `[ ]` `Len(s$)`, `Left$`, `Mid$`, `Right$`
- `[ ]` `Val(s$)`, `Str$(n)`

---

## Offene Bugs

- `[~]` **OS-Restore (vAmiga/AROS)**: Nach Programmende dunkelgrauer Screen statt
  Workbench. `LoadView(saved)+RethinkDisplay` implementiert aber unzureichend.
  → Hypothesen in `MEMORY.md`.

---

## Kritischer Pfad — Ziel: 100% Amiga-Game-Complete

### Aktueller Stand

```
✅ Kern-Pipeline       vasm · vlink · vAmiga · IPC · Editor
✅ Grafik              Cls · Box · Line · Rect · Plot · CopperColor · Double-Buffer
✅ Farbe               Color · PaletteColor (runtime) · ClsColor
✅ Text                Text x,y,"str" — 8×8 Font, CPU, newline
✅ Sound               PlaySample · PlaySampleOnce · StopSample · Paula DMA
✅ Bitmaps             LoadImage · DrawImage · Blitter A→D
✅ Kontrollfluss       If/ElseIf/Else · While · For/Step · Select/Case
✅ Funktionen          Function/Proc · Stack-Frame · lokale Vars · Return
✅ Arrays (1D)         Dim arr(n) · arr(i) lesen/schreiben
✅ Operatoren          + - * / Mod And Or Not · alle Vergleiche
✅ Eingabe (blocking)  WaitKey
✅ Code-Organisation   Include · Statement-Separator ·
✅ Timing              WaitVbl · Delay · ScreenFlip
```

### Stufe 1 — Sprach-Grundlagen für Spiele (Blocker)

```
LANG-C  Str$(n)          Zahlen anzeigen — Score, Leben, Timer
LANG-D  Rnd(n) + Abs(n)  Zufall + Betrag — ohne Rnd kein Spiel
LANG-E  Xor + Shl + Shr  Fehlende Operatoren — Hardware-Zugriff, Bit-Packing
LANG-F  Repeat + Exit    Kontrollfluss vollständig
M9b     Joydown/Key/Maus Echte Eingabe — kein interaktives Programm ohne das
```

→ **Nach Stufe 1: ~80% game-complete.** Einfache Spiele wie Space Invaders,
  Breakout, Tetris (ohne Tile-Map) sind vollständig umsetzbar.

### Stufe 2 — Hardware und Daten

```
M-SYS   Peek/Poke        Direkter Hardware-Zugriff — "Ausflucht nach unten"
M-DATA  2D-Arrays        Tile-Maps, Spielfelder, Matrizen
M-TYPE  Type-Strukturen  Game-Objekte — das wichtigste fehlende Feature für echte Spiele
```

→ **Nach Stufe 2: ~95% game-complete.** Tile-basierte Spiele, komplexe Game-Objects,
  vollständige Hardware-Kontrolle möglich.

### Stufe 3 — Hardware-Features und Musik

```
M10     Sprites          Hardware-Sprites (8 OCS, eigene Farben, keine CPU-Last)
M10     Scrolling        BPLCON1 + MOD — klassischer Scrolltext, Parallax
M-MOD   ProTracker       MOD-Player — echte Demo-Musik statt Sample-Loops
```

→ **Nach Stufe 3: 100% game- und demo-complete.**

---

### Nicht umgesetzt (bewusste Entscheidung)

| Feature | Grund |
|---------|-------|
| `GoTo` / `GoSub` | Spaghetti-Code-Förderung; Functions + Exit reichen |
| Floating-Point | 68000 ohne FPU — zu langsam für Echtzeit; Amiga-Spiele nutzen Fixed-Point |
| String-Variablen (M11) | `Str$` + statische Strings decken 95% der Game-Anforderungen |
| Dynamische Speicherverwaltung (`New`/`Delete`) | Heap auf Amiga ist komplex; statische Arrays + Type ausreichend |
| Rekursion (tief) | Stack auf Amiga begrenzt; Algorithmen iterativ umsetzbar |
| Register-Caching (PERF-C) | Nur nach vollständiger Sprache sinnvoll; minimaler Nutzen vs. Aufwand |
