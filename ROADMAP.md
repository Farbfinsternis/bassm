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

## 📋 Geplante Milestones — Demo-Priorität

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
- `[ ]` `Include` in Docs dokumentieren

---

### LANG-C — Zahlen als Text ausgeben *(Feature-Complete-Blocker)*
> `Text` akzeptiert nur String-Literale. Score, Lives, Timer — alles nicht anzeigbar.
> Minimal nötig: `Str$(n)` oder `NPrint n` mit Integer-Argument.

```blitz
Text 10, 10, "Score: " + Str$(score)
NPrint score                        ; Blitz2D-Kompatibilität
```

- `[ ]` `int_to_str` Routine in `text.s` (oder eigenem Fragment): `divs.w #10` loop → Ziffern auf Stack, dann rückwärts ausgeben
- `[ ]` `Str$(n)` — Funktion: konvertiert Integer → temporären String-Puffer, gibt Adresse in d0 zurück
- `[ ]` `NPrint n` — Prozedur: `int_to_str` + `_Text` an aktueller Position (oder feste Position)
- `[ ]` CodeGen: `Str$(expr)` als `call_expr` behandeln, result-Adresse als String-Pointer weiterreichen
- `[ ]` `Text x,y,"prefix" + Str$(n)` — Concatenation zur Compile-Zeit nicht möglich; Lösung: `Text x,y,"prefix"` + `NPrint x+offset,y,n`

---

### M10 — Erweiterte Grafik

- `[ ]` **Hardware-Scrolling** — `ScrollX n` setzt BPLCON1 + BPL1MOD/BPL2MOD; klassischer
  Scrolltext-Effekt im Abspann
- `[ ]` **Hardware-Sprites** — `DefSprite n, data`, `MoveSprite n,x,y`; 8 Sprites × 16px,
  eigene Farben, keine Bitplane-/Blitter-Last
- `[ ]` **`Circle x,y,r`** — Bresenham-Kreis, CPU (niedrige Prio)

---

### M9b — Eingabe (Rest)

- `[ ]` **`Joydown(port)`** / **`Joyfire(port)`** — CIA JOYSTICK-Register auslesen (non-blocking)
- `[ ]` **`KeyDown(scancode)`** — Echtzeit-Tastaturabfrage aus `_kbd_pending` (non-blocking)

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

## Kritischer Pfad zur publishbaren Demo

```
✅ PERF-A + PERF-B        schneller Code — Bcc+Stack-Elim. fertig
✅ Runtime-PaletteColor   Palette-Animation mit Variablen fertig
✅ M-COPPER               CopperColor y,r,g,b — Rasterbalken CPU-frei fertig
✅ M6 Text                Text x,y,"str" — 8×8 Bitmap-Font, CPU-Rendering fertig
✅ M-ASSET Sound          PlaySample + PlaySampleOnce + StopSample + vAmiga Audio fertig
✅ M-ASSET Bitmaps        LoadImage + DrawImage; Blitter A→D; image.s fertig
✅ M7 Funktionen          Function/Proc; Stack-Frame; lokale Variablen; Return fertig
       ↓
⬅ SPRACHVOLLSTÄNDIGKEIT (Blocker)
✅ LANG-A  And / Or / Not    zusammengesetzte Bedingungen — fertig
✅ LANG-B  Mod               Wraparound / Frame-Cycling — fertig
✅ TOOL-1  Include           Code-Aufteilung in Dateien — fertig
LANG-C  Str$(n) / NPrint  Zahlen als Text — ohne das kein Score-Display
M9b     Joydown/KeyDown   non-blocking Input — ohne das kein echtes Spiel
       ↓
M10 Hardware-Scrolling     Scrolltext für Greetings/Credits-Part
       ↓
M11 Strings (optional)     Erst nach LANG-C relevant
```

### Begründung der Reihenfolge

**Warum M-COPPER vor M6 Text?**
Copper-Rasterbalken sind die visuelle DNA jeder Amiga-Demo. Sie kosten **null CPU-Zeit**
(Copper läuft parallel), brauchen keinen Font, keine Subroutinen — nur eine Copper-Liste
im Chip-RAM. Das Ergebnis ist sofort unverkennbar *Amiga*. Text braucht man danach für
Credits, aber der erste visuelle Wow-Moment kommt vom Copper.

**Warum Sound vor Bitmaps?**
"Eine Demo ohne Musik ist ein Bildschirmschoner." (Scene-Weisheit)
Ein einfacher Paula-Sample-Player (8-Bit raw, ein Kanal) reicht für Atmosound.
Ein ProTracker-MOD-Player macht aus dem Projekt eine echte Demo.

**Was M-COPPER konkret bedeutet:**
```blitz
; Rasterbalken: Copper setzt COLOR00 an bestimmten Rasterzeilen
; → CPU-freier Farbverlauf über den gesamten Bildschirm
; Typisch: 256-Zeilen-Gradient, jede Zeile eine andere Farbe
; = 256 Copper-MOVE-Befehle im Copper-Programm
```
Implementation: Copper-Liste zur Laufzeit aus BASSM heraus patchbar machen,
sodass `CopperLine y, colorReg, rgbValue` einen Eintrag in die aktive Liste schreibt.

### Was absichtlich niedrig priorisiert ist
| Feature | Grund |
|---------|-------|
| M11 Strings (Variablen) | LANG-C (`Str$`) reicht für Demo; volle String-Vars erst für Textadventures |
| Hardware-Sprites | Blitter-Objekte für Demo genug; Sprites erst für Spiele wichtig |
| Blitter-Line (B5) | CPU-Bresenham reicht für Demo-Zwecke |
| Circle | Kein typisches Demo-Element |
| Register-Caching | Erst nach M7 implementierbar |
| Goto / Gosub | Bewusst nicht implementiert |
