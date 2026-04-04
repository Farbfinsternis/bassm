# PERF — Demoscene-Optimierungen für 25fps auf dem Amiga 500

> **Stand:** 2026-03-28
> **Ziel:** 25fps Game-Loop auf A500 (68000 @ 7.09 MHz, 512 KB Chip RAM, kein Fast RAM)
> **Budget:** ~162.000 effektive CPU-Zyklen pro Game-Frame (nach Bitplane-DMA-Abzug)
> **Sortierung:** Aufsteigend nach Implementierungsaufwand

---

## Zyklen-Referenz (68000)

| Instruktion | Zyklen | Anmerkung |
|---|---|---|
| `move.l d0,d1` | 4 | Register → Register |
| `move.l #imm,d0` | 12 | Immediate → Register |
| `move.l _var,d0` | 20 | Absolute Chip RAM → Register |
| `move.l d0,_var` | 20 | Register → Absolute Chip RAM |
| `add.l d1,d0` | 8 | Register-Register ALU |
| `add.l _var,d0` | 18 | Memory-Register ALU |
| `lsl.l #n,d0` | 8+2n | Shift (max 24 für n=8) |
| `muls.w d1,d0` | 38–70 | Signed Multiply (datenabhängig) |
| `mulu.w d1,d0` | 38–70 | Unsigned Multiply |
| `divu.w d1,d0` | ~140 | Unsigned Divide (!) |
| `tst.l d0` | 4 | Zero-Test |
| `cmp.l #0,d0` | 14 | Zero-Test (10 Zyklen teurer als tst.l) |

---

## Phase 1 — Strength Reduction (Codegen)

> **Aufwand:** Niedrig
> **Geschätzter Gewinn:** 1.000–5.000 Zyklen/Frame
> **Dateien:** `app/src/codegen.js`

Erweitere `_emitMultiplyByConst()` und füge `_emitDivideByConst()` hinzu.
Betrifft nur vom Codegen emittierte Multiplikationen/Divisionen mit Compile-Time-Konstanten
in User-Expressions. Die Fragment-internen `muls`/`divu` (tilemap.s, bobs.s) werden in
späteren Phasen separat behandelt.

### T1 — Multiplikation: Shift+Add-Dekomposition

**Datei:** `app/src/codegen.js` (`_emitMultiplyByConst`)

Aktuell: Power-of-2 → `lsl.l`, sonst `muls.w`. Erweitern auf kleine Konstanten:

| Konstante | Heute | Neu | Zyklen (alt → neu) |
|---|---|---|---|
| ×2 | `lsl.l #1,d0` | (bleibt) | 10 |
| ×3 | `muls.w` | `move.l d0,d1` / `add.l d0,d0` / `add.l d1,d0` | ~54 → 16 |
| ×5 | `muls.w` | `move.l d0,d1` / `lsl.l #2,d0` / `add.l d1,d0` | ~54 → 16 |
| ×6 | `muls.w` | `add.l d0,d0` / `move.l d0,d1` / `lsl.l #1,d0` / `add.l d1,d0` | ~54 → 20 |
| ×7 | `muls.w` | `lsl.l #3,d0` / `sub.l d1,d0` (d1=orig) | ~54 → 18 |
| ×9 | `muls.w` | `move.l d0,d1` / `lsl.l #3,d0` / `add.l d1,d0` | ~54 → 18 |
| ×10 | `muls.w` | `add.l d0,d0` / `move.l d0,d1` / `lsl.l #2,d0` / `add.l d1,d0` | ~54 → 20 |

Algorithmus: Für n ≤ 10 eine Lookup-Table mit optimalen Shift+Add-Sequenzen.
Für n > 10 und nicht Power-of-2: Fallback auf `muls.w` (wie bisher).

**Schritte:**
1. Lookup-Map `SHIFT_ADD_SEQUENCES` mit Einträgen für 3, 5, 6, 7, 9, 10.
2. `_emitMultiplyByConst(n, lines)` prüft zuerst Power-of-2, dann Lookup, dann muls-Fallback.
3. Tests: Alle 10 Konstanten verifizieren (Breakout + manuell).

---

### T2 — Division durch Power-of-2: Shift Right

**Datei:** `app/src/codegen.js`

Neue Methode `_emitDivideByConst(n, lines)`:

| Konstante | Heute | Neu | Zyklen (alt → neu) |
|---|---|---|---|
| ÷2 | `move.l #2,d1` / `divs.w d1,d0` | `asr.l #1,d0` | ~150 → 10 |
| ÷4 | `divs.w` | `asr.l #2,d0` | ~150 → 12 |
| ÷8 | `divs.w` | `asr.l #3,d0` | ~150 → 14 |
| ÷16 | `divs.w` | `asr.l #4,d0` | ~150 → 16 |

Nur für Power-of-2; signed (`asr`) für BASSM-Integers.
Nicht-Power-of-2 bleibt bei `divs.w`.

**Schritte:**
1. Neue Methode `_emitDivideByConst(n, lines)`.
2. Aufruf in `_genExpr` bei `binary_expr` mit `/`-Operator und Integer-Literal als rechtem Operand.
3. Erkennung: Rechter Operand ist `{ type: 'int', value: n }` → n ist Power-of-2?

---

### T3 — Modulo durch Power-of-2: AND-Mask

**Datei:** `app/src/codegen.js`

| Ausdruck | Heute | Neu | Zyklen (alt → neu) |
|---|---|---|---|
| `x Mod 16` | `divs.w` + Swap | `and.l #15,d0` | ~150 → 14 |
| `x Mod 8` | `divs.w` + Swap | `and.l #7,d0` | ~150 → 14 |

**Einschränkung:** Nur korrekt für **nicht-negative** Operanden. Da BASSM-Variablen
signed sind, muss der Codegen sicherstellen, dass das Ergebnis semantisch korrekt ist.
Konservativer Ansatz: Nur anwenden wenn der linke Operand nachweislich ≥ 0 ist
(z.B. Array-Index, Schleifenzähler mit positivem Start). Sonst Fallback auf Division.

**Schritte:**
1. In `_genExpr` bei `Mod`-Operator: Prüfe ob rechter Operand Power-of-2.
2. Wenn ja und linker Operand "sicher positiv" → `and.l #(n-1),d0`.
3. Sonst: bestehender Pfad.

---

## Phase 2 — Compile-Time Lookup-Tabellen

> **Aufwand:** Niedrig–Mittel
> **Geschätzter Gewinn:** 5.000–10.000 Zyklen/Frame (bei Tilemap-Rendering)
> **Dateien:** `app/src/codegen.js`, `app/src/m68k/fragments/tilemap.s`

Ersetze laufzeitberechnete `mulu.w`/`divu.w` in den Fragments durch vorberechnete Tabellen.
Die Tabellen werden vom Codegen als `dc.w`-Blöcke in die DATA-Section emittiert.

### T4 — Y-Offset-Tabelle für Tilemap-Rendering

**Problem:** `tilemap.s` berechnet `row * tile_h` und `row * GFXIBPR` wiederholt.
`mulu.w` kostet ~54 Zyklen pro Aufruf. Bei 14 sichtbaren Rows × 2 Multiplikationen = ~1.500 Zyklen.

**Lösung:** Vorberechnete Tabelle `_tile_y_offset`:
```asm
_tile_y_offset:         ; tile_row → pixel_y (row * tile_h)
        dc.w    0, 16, 32, 48, ...    ; max_rows Einträge
```

Zugriff:
```asm
; ALT:  mulu.w  d6,d1           ; 54 Zyklen
; NEU:
        add.w   d1,d1           ; 4 Zyklen (word index)
        move.w  _tile_y_offset(pc,d1.w),d1  ; 14 Zyklen
```

**Gewinn pro Zugriff: ~36 Zyklen.** Bei 14 Rows: ~504 Zyklen/Frame.

**Schritte:**
1. Codegen: In `_emitAssetData()` nach Tileset-Daten eine `_tile_y_offset`-Tabelle emittieren
   (`dc.w` mit `row * tileH` für 0 .. maxRows).
2. `maxRows = ceil(GFXHEIGHT / tileH) + 2` (inkl. Border-Tiles).
3. Tilemap.s: `mulu.w d6,d1` → Table-Lookup.
4. Analog: `_tile_ibpr_offset`-Tabelle für `row * GFXIBPR` (interleaved row stride).

---

### T5 — Map-Row-Offset-Tabelle

**Problem:** `tilemap.s` berechnet `map_row * map_w * 2` für den Tilemap-Daten-Zugriff.
Das ist ein `mulu.w` + `add.l` pro Row.

**Lösung:** Vorberechnete Tabelle `_tilemap_row_offset`:
```asm
_tilemap_row_offset:    ; map_row → byte offset in tilemap data
        dc.l    0, 40, 80, ...   ; map_h Einträge (map_w * 2 pro Row)
```

**Schritte:**
1. Codegen: Tabelle emittieren nach Tilemap-INCBIN: `dc.l row * map_w * 2` für 0..map_h-1.
2. `_DrawTilemap`: `mulu.w d5,d0` / `add.l d0,d0` → `lsl.l #2,d0` / `move.l _tilemap_row_offset(pc,d0.l),d0`.
3. Map-Breite (map_w) und -Höhe (map_h) werden bereits im Tilemap-Header gespeichert.
   Die Tabellengröße ist map_h × 4 Bytes (bei 64 Rows = 256 Bytes).

---

### T6 — GFXIBPR-Multiplikations-Tabelle (optional)

**Problem:** `muls.w #GFXIBPR,d1` erscheint mehrfach in bobs.s (Zeilen 346, 479, 594).
GFXIBPR = GFXBPR × GFXDEPTH (z.B. 48 × 5 = 240). `muls.w #240,d1` kostet ~66 Zyklen.

**Lösung:** Vorberechnete Tabelle `_ibpr_y_table`:
```asm
_ibpr_y_table:          ; y → y * GFXIBPR
        dc.l    0, 240, 480, ...    ; (GFXVHEIGHT) Einträge
```

**Gewinn pro Zugriff:** ~50 Zyklen. Bei 10 BOBs (Erase + Draw = 2×): ~1.000 Zyklen/Frame.

**Trade-off:** (GFXHEIGHT + 2×GFXBORDER) × 4 Bytes = (256+64) × 4 = 1.280 Bytes.
Nur emittieren wenn `_usesBobs || _usesTilemap` (Zeichenoperationen die Y→Offset brauchen).

**Schritte:**
1. Codegen: Tabelle in DATA-Section emittieren.
2. bobs.s: `muls.w #GFXIBPR,d1` → `add.l d1,d1` / `add.l d1,d1` / `move.l _ibpr_y_table(pc,d1.l),d1`.
   (Achtung: d1 enthält y als .w, muss zu Longword-Index ×4 werden.)
3. Nur wenn Tabelle emittiert wird (Feature-Flag).

---

## Phase 3 — Pre-Shifted BOBs

> **Aufwand:** Mittel
> **Geschätzter Gewinn:** 5.000–15.000 Zyklen/Frame (bei 10+ BOBs)
> **Dateien:** Asset-Pipeline, `app/src/codegen.js`, `app/src/m68k/fragments/bobs.s`

Vorberechnete 16 Shift-Varianten pro BOB eliminieren den Barrel-Shift und das Extra-Word
beim Blitten. Der Blitter kopiert statt zu shiften → weniger Zyklen, kein BLTCON-Shift-Setup.

### T7 — Asset-Pipeline: Shift-Varianten generieren

**Datei:** Asset-Manager oder neues Build-Script

Für jedes BOB-Image mit PreShift-Flag:
- Eingabe: 1 Variante (Shift 0), W×H Pixel, D Bitplanes.
- Ausgabe: 16 Varianten (Shift 0–15), jede (W+16)×H Pixel breit (1 Word breiter).
- Format: Interleaved `.iraw` wie bisher, aber 16× hintereinander im selben File.
- Masken: Ebenfalls 16 Varianten (selbe Shift-Logik).

Algorithmus pro Shift s (1–15):
```
Für jede Bitplane-Row:
  Lese original_word[0..n]
  Shift alle Words um s Bits nach rechts
  Carry aus Word[i] wird Bit 15..s von Word[i+1]
  Word[n+1] = Carry des letzten Words
```

**Schritte:**
1. Neues Flag in `LoadImage`/`LoadAnimImage`: 6. Argument optional `PreShift` (oder
   automatisch für alle BOBs wenn globales Flag gesetzt).
2. Asset-Pipeline erzeugt `.iraw.preshifted` (oder inline im selben .iraw mit Metadata).
3. Codegen registriert in `_imageAssets`: `preShifted: true`, `shiftedRowbytes: rowbytes + 2`.

---

### T8 — Codegen: Pre-Shifted Metadata im Image-Header

**Datei:** `app/src/codegen.js`

Erweiterter Image-Header für pre-shifted BOBs:
```asm
_img_N:
        dc.w    width, height, GFXDEPTH+$8000+$4000, rowbytes
        ;                      bit 14 = PreShifted-Flag ──┘
        dc.w    shifted_rowbytes    ; +8: Breite einer Shift-Variante (rowbytes+2)
        dc.l    shift_frame_size    ; +10: Bytes pro Shift-Variante (für Offset-Berechnung)
        ; Daten: Shift0, Shift1, ..., Shift15 hintereinander
```

`_DrawImageFrame` / `_BltBobMaskedFrame` prüfen Bit 14 und verzweigen auf den
Pre-Shift-Pfad.

---

### T9 — bobs.s: Pre-Shift-Rendering-Pfad

**Datei:** `app/src/m68k/fragments/bobs.s`

Neuer Pfad in `_BltBobMaskedFrame` wenn Bit 14 gesetzt:

```asm
; Pre-Shifted-Pfad:
        move.w  d0,d2           ; d0 = screen_x
        and.w   #$F,d2          ; d2 = shift_index (0–15)
        ; Berechne Offset in Pre-Shift-Daten:
        mulu.w  shift_frame_size(a0),d2   ; d2 = shift_index × frame_size
        add.l   d2,a0           ; a0 zeigt auf korrekte Shift-Variante
        ; Kein BLTCON-Shift nötig — Daten sind bereits geshiftet
        ; Blitter-Setup: A=Mask, B=Shifted-Source, C=Dest, D=Dest
        ; Breite = shifted_rowbytes / 2 (1 Word breiter als Original)
```

**Vorteil:** Kein Barrel-Shift → BLTCON0 Shift-Bits = 0 → schnellerer Blit.
Außerdem: Kein Extra-Leseword nötig (Daten sind schon breit genug).

**Schritte:**
1. Bit-14-Check nach bestehendem Bit-15-Check (interleaved).
2. Shift-Index berechnen: `and.w #$F,d0`.
3. Frame-Offset mit Shift-Variante: `shift_index * shift_frame_size + frame * 16 * shift_frame_size`.
4. Blitter-Setup ohne Shift, mit breiterer Blitsize.
5. Fallback: Ohne Bit 14 → bisheriger Pfad (unverändert).

---

### T10 — Masken: Ebenfalls 16 Varianten

**Datei:** Asset-Pipeline, `app/src/m68k/fragments/bobs.s`

Masken müssen zum geshifteten BOB passen. Gleiche 16 Varianten, gleiches Layout.

```asm
_mask_N:
        ; Shift0-Mask, Shift1-Mask, ..., Shift15-Mask
        ; Jeweils (rowbytes+2) × height Bytes
```

**Schritte:**
1. Asset-Pipeline: Shift-Varianten für `.imask`-Dateien generieren.
2. bobs.s: Mask-Pointer analog zum Source-Pointer um shift_index × mask_frame_size verschieben.

---

## Phase 4 — Loop-Invariant Code Motion (LICM)

> **Aufwand:** Mittel–Hoch
> **Geschätzter Gewinn:** 2.000–8.000 Zyklen/Frame
> **Dateien:** `app/src/codegen.js` (neuer Analyse-Pass)

Identifiziere Ausdrücke in Schleifen, die sich pro Iteration nicht ändern, und hebe
sie vor die Schleife.

### T11 — Write-Set-Analyse für Loop-Bodies

**Datei:** `app/src/codegen.js`

Neue Methode `_collectWriteSet(stmts)` → `Set<string>`:
- Durchläuft den Loop-Body rekursiv.
- Sammelt alle Variablennamen, die geschrieben werden (`assign`, `array_assign`, `read_stmt`).
- Enthält auch Variablen, die durch Funktionsaufrufe potenziell geschrieben werden
  (konservativ: wenn ein `call_stmt`/`call_expr` vorkommt, gilt jede nicht-lokale Variable
  als geschrieben — kein Interprozedurales Alias-Tracking nötig).
- Commands mit Seiteneffekten (`DrawBob`, `DrawTilemap`, etc.) clobbern keine User-Variablen
  und sind daher transparent.

**Schritte:**
1. Rekursiver Walker über Statement-Typen (analog zu `_collectVars`).
2. Bei `call_stmt`/`call_expr` → Return-Flag `hasCalls = true`.
3. Wenn `hasCalls`: LICM konservativ deaktiviert (alle Variablen als "möglicherweise geschrieben" betrachten).
   Alternative (aggressiver): User-Functions analysieren und deren Write-Sets einbeziehen.

---

### T12 — Invarianz-Erkennung in Expressions

**Datei:** `app/src/codegen.js`

Neue Methode `_isInvariant(expr, writeSet)` → `boolean`:
- Ein Ausdruck ist invariant wenn:
  - `int`/`string`-Literal → immer invariant.
  - `var`-Referenz → invariant wenn `name ∉ writeSet`.
  - `binary_expr` → invariant wenn beide Operanden invariant.
  - `unary_expr` → invariant wenn Operand invariant.
  - `call_expr` (Built-in wie `Abs`, `Rnd`) → `Abs` invariant wenn Arg invariant;
    `Rnd` **nie** invariant (Seiteneffekt).
  - `call_expr` (User-Funktion) → konservativ: nie invariant (außer pure functions,
    deren Detektion Phase-2-Arbeit wäre).
  - Array-Read `arr(expr)` → invariant wenn Index-Ausdruck invariant UND `arr ∉ writeSet`.
  - Type-Field-Read `inst\field` → invariant wenn `inst ∉ writeSet`.

---

### T13 — Code-Hoisting in der Codegen-Schleife

**Datei:** `app/src/codegen.js`

In `_genFor` / `_genWhile` / `_genRepeat`:

1. `writeSet = _collectWriteSet(stmt.body)`
2. Für jeden Statement im Body: prüfe Sub-Expressions auf Invarianz.
3. Invariante Sub-Expressions → vor dem Loop in ein temporäres BSS-Register hoisten.
4. Im Loop-Body: Referenz auf das temporäre Register statt Neuberechnung.

**Pragmatischer Ansatz (V1):** Nur Top-Level-Argumente von Commands hoisten.
Beispiel:
```basic
For i = 0 To 31
  DrawBob 0, bx(i) + cameraX, by(i) + cameraY  ; cameraX, cameraY invariant
Next
```
→ `cameraX` und `cameraY` werden vor der Schleife in d5/d6 geladen.
→ Im Loop: `add.l d5,d0` statt `move.l _var_cameraX,d0` / `add.l d0,...`.

**Einschränkung V1:** Nur simple Variablen-Referenzen hoisten, keine komplexen Ausdrücke.
Komplexe invariante Ausdrücke (z.B. `a + b * 2` wo a und b invariant sind) können in
einer späteren Iteration behandelt werden.

---

## Phase 5 — Screen-to-Screen Blit (PERF-J)

> **Aufwand:** Hoch
> **Geschätzter Gewinn:** 30.000–60.000 Zyklen/Frame (!)
> **Dateien:** `app/src/m68k/fragments/tilemap.s`, `app/src/codegen.js`

Der mit Abstand größte Einzelgewinn. Statt alle sichtbaren Tiles (~280 Tiles bei 16×16)
jedes Frame neu zu zeichnen, wird der bestehende Screen-Inhalt per Blitter verschoben
und nur die neu sichtbaren Rand-Tiles gezeichnet (~20 Tiles pro Frame bei 1px-Scroll).

### T14 — Scroll-Delta-Tracking

**Datei:** `app/src/m68k/fragments/tilemap.s`

Neue BSS-Variablen (pro Viewport, oder global für Single-VP):
```asm
_prev_scroll_x:     ds.l    1       ; ScrollX des letzten Frames
_prev_scroll_y:     ds.l    1       ; ScrollY des letzten Frames
_scroll_dx:         ds.w    1       ; Delta X (signed)
_scroll_dy:         ds.w    1       ; Delta Y (signed)
```

Am Anfang von `_DrawTilemap`:
```asm
        move.l  _prev_scroll_x,d2
        sub.l   d0,d2               ; d2 = prev_x - new_x = -dx
        neg.l   d2                  ; d2 = dx (positive = rechts gescrollt)
        move.w  d2,_scroll_dx
        ; analog für dy
        move.l  d0,_prev_scroll_x   ; Update für nächsten Frame
```

Wenn `|dx| > GFXWIDTH/2` oder `|dy| > GFXHEIGHT/2` → Full-Redraw (Kamera-Teleport).

---

### T15 — Horizontaler Screen-Shift

**Datei:** `app/src/m68k/fragments/tilemap.s`

Blitter-Copy von einem Bereich im Back-Buffer auf einen verschobenen Bereich im selben Buffer.

Für Scroll nach rechts (dx > 0):
```
Source:  [####VISIBLE####___]     (linker Bereich des Buffers)
Dest:    [___####VISIBLE####]     (verschoben um dx Pixel nach rechts)
Redraw:  [NEW]                    (linke Spalte: neu sichtbare Tiles)
```

Blitter-Setup:
- A = Source (Back-Buffer + alter Offset)
- D = Dest (Back-Buffer + neuer Offset)
- Shift = dx mod 16 (BLTCON0/1 Barrel-Shift)
- Breite = (GFXWIDTH - |dx|) Pixel → in Words
- Alle GFXDEPTH Planes (interleaved: eine Blit-Operation)

**Herausforderung:** Wenn Source und Dest überlappen, muss die Blit-Richtung
korrekt sein (aufsteigend/absteigend). Der Amiga-Blitter unterstützt beides
über `BLTCON1.DESC` (descending mode).

- Scroll nach rechts → Source liegt links → absteigend blitten (DESC=1)
- Scroll nach links → Source liegt rechts → aufsteigend blitten (DESC=0)

**Schritte:**
1. dx-Vorzeichen prüfen → Blit-Richtung bestimmen.
2. Blitter-Register konfigurieren (A-Source, D-Dest, Shift, Modulos).
3. Blit kicken.
4. Neue linke/rechte Spalte(n) mit `_DrawImageFrame` zeichnen.

---

### T16 — Vertikaler Screen-Shift

**Datei:** `app/src/m68k/fragments/tilemap.s`

Analog zu T15, aber vertikal. Einfacher, weil kein Barrel-Shift nötig:

- Scroll nach unten (dy > 0): Blitter kopiert Zeilen aufwärts, neue Zeile(n) unten zeichnen.
- Scroll nach oben (dy < 0): Blitter kopiert Zeilen abwärts, neue Zeile(n) oben zeichnen.

Source/Dest-Offset = `|dy| * GFXIBPR` Bytes Differenz.

**Schritte:**
1. dy-Vorzeichen prüfen → Source/Dest-Offsets berechnen.
2. Blitter-Copy (kein Shift, nur Offset-Differenz).
3. Neue obere/untere Zeile(n) mit Tile-Draw füllen.

---

### T17 — Diagonaler Scroll (dx + dy kombiniert)

**Datei:** `app/src/m68k/fragments/tilemap.s`

Wenn sowohl dx ≠ 0 als auch dy ≠ 0 (diagonales Scrolling):

**Option A (einfach):** Zwei separate Blits: erst horizontal, dann vertikal.
Nachteil: 2 Blitter-Operationen statt 1.

**Option B (optimal):** Ein einziger Blit mit kombiniertem Source/Dest-Offset + Shift.
Komplexer, aber nur 1 Blit. Spart ~3.000 Zyklen.

**Empfehlung:** Option A für V1 (korrekt und einfach), Option B als spätere Optimierung.

**Schritte:**
1. Horizontalen Blit ausführen (T15).
2. Vertikalen Blit auf das Ergebnis ausführen (T16).
3. Rand-Tiles: Sowohl Spalte(n) als auch Zeile(n) zeichnen, plus Eck-Tiles.

---

### T18 — Edge-Tile-Fill: Nur neue Tiles zeichnen

**Datei:** `app/src/m68k/fragments/tilemap.s`

Nach dem Screen-Shift müssen nur die neu sichtbaren Tiles gezeichnet werden:

- Bei Scroll nach rechts: Rechte Spalte (1–2 Tiles breit, je nach dx).
- Bei Scroll nach unten: Untere Zeile (1–2 Tiles hoch, je nach dy).
- Bei diagonalem Scroll: Spalte + Zeile + Eck-Tile.

**Anzahl neuer Tiles:**
- Horizontal: `ceil(|dx| / tileW)` Spalten × `visible_rows` = ~1 × 14 = 14 Tiles
- Vertikal: `visible_cols` × `ceil(|dy| / tileH)` = 22 × ~1 = 22 Tiles
- Diagonal: 14 + 22 + 2 = 38 Tiles

**Vergleich Full-Redraw:** ~280 Tiles → Edge-Fill: ~38 Tiles. **7× weniger Blitter-Arbeit.**

**Schritte:**
1. Neue `_DrawTilemap_Scroll`-Routine (oder Erweiterung von `_DrawTilemap`).
2. Parameter: dx, dy, first_col, first_row (aus Scroll-Delta).
3. Zeichne nur die Tiles im neuen Rand-Bereich.
4. Full-Redraw als Fallback wenn `|dx| >= tileW` oder `|dy| >= tileH`.

---

### T19 — Integration mit DrawTilemap

**Datei:** `app/src/m68k/fragments/tilemap.s`, `app/src/codegen.js`

`_DrawTilemap` entscheidet automatisch:
- **Erster Aufruf** (prev_scroll_x/y = 0 und noch nie gezeichnet) → Full-Redraw.
- **Kamera-Teleport** (`|dx| > GFXWIDTH/2` oder `|dy| > GFXHEIGHT/2`) → Full-Redraw.
- **Normaler Scroll** → Screen-Shift + Edge-Fill.
- **Kein Scroll** (dx=0, dy=0) → Nichts tun (Screen-Inhalt ist noch gültig).

Neues BSS-Flag:
```asm
_tilemap_needs_full_redraw:  ds.b 1   ; 1 = erster Frame oder Teleport
```
Wird von `SetTilemap` auf 1 gesetzt. `_DrawTilemap` setzt auf 0 nach Full-Redraw.

---

## Phase 6 — Register-Pinning (PERF-I)

> **Aufwand:** Hoch
> **Geschätzter Gewinn:** 5.000–20.000 Zyklen/Frame
> **Dateien:** `app/src/codegen.js` (neuer Analyse-Pass + Codegen-Änderungen)

Heiße Variablen in Schleifen werden in Registern gehalten statt bei jedem Zugriff
aus dem BSS geladen/gespeichert. Der 68000 hat 6 freie Datenregister (d2–d7) und
3 Adressregister (a2–a4) die über Subroutinen hinweg erhalten bleiben
(BASSM-Fragments clobbern nur d0–d1 und a0–a1).

### T20 — Zugriffs-Frequenz-Analyse

**Datei:** `app/src/codegen.js`

Neue Methode `_analyzeVarAccess(stmts)` → `Map<string, { reads: number, writes: number }>`:
- Zählt Lese- und Schreibzugriffe auf jede Variable im Loop-Body.
- Rekursiv über verschachtelte Statements (If/While im Loop).
- Ignoriert verschachtelte Loops (die haben ihre eigene Analyse).

**Ranking:** `score = reads × 20 + writes × 20` (Zyklen-Einsparung pro Register-Zugriff).
Die Top-N Variablen (N ≤ 6 für d2–d7) werden zu Register-Kandidaten.

---

### T21 — Register-Zuordnung

**Datei:** `app/src/codegen.js`

Neue Methode `_assignRegisters(varAccessMap, maxRegs)` → `Map<string, string>`:
- Sortiere Variablen nach Score (absteigend).
- Weise die Top-N Variablen Register d2..d(2+N-1) zu.
- Adressregister (a2–a4) für Pointer-artige Zugriffe (Type-Instance-Pointer, Array-Base).

**Register-Budget:**
| Register | Verfügbar | Verwendung |
|---|---|---|
| d0–d1 | Nein | Scratch (Expressions, Subroutinen) |
| d2–d7 | Ja (6) | Gepinnte User-Variablen |
| a0–a1 | Nein | Scratch (Subroutinen) |
| a2–a4 | Ja (3) | Gepinnte Pointer / Type-Instances |
| a5 | Nein | CUSTOM ($DFF000) |
| a6 | Nein | Frame-Pointer (LINK/UNLK) |
| a7 | Nein | Stack-Pointer |

**Einschränkung PERF-2 (bestehend):** Der Pointer-Cache nutzt bereits a1 in For-Loops
für Type-Instance-Zugriffe. Register-Pinning muss mit PERF-2 koexistieren:
- Wenn PERF-2 aktiv → a1 ist belegt → a2–a4 für Pinning verfügbar.
- Kein Konflikt, da PERF-2 nur a1 nutzt und Register-Pinning d2–d7 + a2–a4.

---

### T22 — Codegen: Prolog/Epilog für gepinnte Register

**Datei:** `app/src/codegen.js`

Für jeden Loop mit gepinnten Variablen:

**Prolog (vor Loop-Eintritt):**
```asm
        ; Load pinned vars into registers
        move.l  _var_px,d2
        move.l  _var_py,d3
        move.l  _var_pdx,d4
```

**Epilog (nach Loop-Ende):**
```asm
        ; Spill pinned vars back to BSS
        move.l  d2,_var_px
        move.l  d3,_var_py
        move.l  d4,_var_pdx
```

**Im Loop-Body:** Jede Referenz auf `px` → `d2` statt `_var_px`.

---

### T23 — Codegen: Expression-Emission mit Register-Map

**Datei:** `app/src/codegen.js`

Modifikation von `_genExpr()` und `_genStatement()`:
- Neuer Parameter oder Instanzfeld: `this._pinnedVars: Map<string, string>` (varName → regName).
- Bei Variable-Read: Wenn `name ∈ _pinnedVars` → `move.l regName,d0` (4 Zyklen statt 20).
- Bei Variable-Write (assign): Wenn `target ∈ _pinnedVars` → `move.l d0,regName` (4 Zyklen statt 20).

**Spezialfall:** `x = x + 1` wo x gepinnt ist (d2):
```asm
; Heute (ungepinnt):
        move.l  _var_x,d0       ; 20 Zyklen
        addq.l  #1,d0           ; 8 Zyklen
        move.l  d0,_var_x       ; 20 Zyklen  = 48 Zyklen

; Gepinnt (d2):
        move.l  d2,d0           ; 4 Zyklen
        addq.l  #1,d0           ; 8 Zyklen
        move.l  d0,d2           ; 4 Zyklen   = 16 Zyklen

; Optimal (direkt, zukünftige Peephole-Regel):
        addq.l  #1,d2           ; 8 Zyklen   = 8 Zyklen
```

---

### T24 — Subroutine-Boundary-Handling

**Datei:** `app/src/codegen.js`

Wenn ein Command im Loop-Body eine `jsr`-Subroutine aufruft:
- Fragments (cls.s, bobs.s, etc.) clobbern d0–d1, a0–a1 (Konvention).
- **d2–d7 und a2–a4 bleiben erhalten** → gepinnte Register überleben den Aufruf.
- Verifizierung: Prüfe alle Fragment-`movem.l`-Save/Restore-Masken.

**Problem-Fragment:** `box.s` saved `d0-d7/a0-a2` — das clobbert d2–d7!
→ box.s muss d2–d7 restoren (tut es bereits via movem.l restore).
→ Aber: die restore-Werte sind die *alten* Werte, nicht die gepinnten.

**Lösung:** Vor `jsr _Box` (und ähnlichen Fragments die d2+ clobbern):
```asm
        movem.l d2-d7,-(sp)     ; save pinned regs
        jsr     _Box
        movem.l (sp)+,d2-d7     ; restore pinned regs
```

Dieser Save/Restore kostet ~40 Zyklen — aber nur 1× pro Box-Aufruf statt N× für
Variable-Loads pro Iteration. Netto-Gewinn wenn mehr als 2 Variablen gepinnt sind.

**Schritte:**
1. Inventar: Welche Fragments clobbern d2+? (box.s, text.s — prüfen)
2. Codegen: Vor/nach `jsr` zu clobbernden Fragments → `movem.l` save/restore emittieren.
3. Nur wenn gepinnte Register aktiv sind (`_pinnedVars.size > 0`).

---

### T25 — Verschachtelte Loops

**Datei:** `app/src/codegen.js`

Bei verschachtelten Loops teilen sich Inner und Outer Loop das Register-Budget:

```basic
While 1                          ; Outer: pinnt cx, cy → d2, d3
  For i = 0 To 31               ; Inner: pinnt i → d4 (DBRA, bereits PERF-H)
    DrawBob 0, bx(i)-cx, by(i)-cy
  Next
  ScreenFlip
Wend
```

**Strategie:**
- Outer-Loop-Analyse zuerst, weist d2–d(2+K) zu.
- Inner-Loop-Analyse danach, weist d(2+K+1)–d7 zu.
- Wenn Register-Budget erschöpft → Inner-Loop-Variablen werden nicht gepinnt.
- Bereits bestehende PERF-H DBRA-Optimierung für `For`-Schleifen nutzt d7 für den
  Zähler — muss in die Register-Map integriert werden, damit kein Konflikt entsteht.

---

## Phase 7 — Blitter-Pipelining

> **Aufwand:** Hoch
> **Geschätzter Gewinn:** 15.000–30.000 Zyklen/Frame (bei 10+ BOBs)
> **Dateien:** `app/src/m68k/fragments/bobs.s`

Aktuell wartet `_FlushBobs` vor *jedem* Blit auf den Blitter (WaitBlit am Anfang
jeder Blit-Operation). Die CPU ist dabei idle. Pipelining eliminiert diese Idle-Zeit
durch Überlappung von CPU-Adressberechnung und Blitter-DMA.

### T26 — FlushBobs: Erase-Pass-Pipelining

**Datei:** `app/src/m68k/fragments/bobs.s`

Aktueller Erase-Pass:
```
For each old bob:
  WaitBlit           ← CPU wartet
  Berechne Adressen  ← CPU rechnet
  Kick Blit          ← Blitter startet
```

Gepipelined:
```
Berechne Adressen für Bob 0
Kick Blit Bob 0
For i = 1 to N-1:
  Berechne Adressen für Bob i    ← CPU rechnet WÄHREND Blitter Bob i-1 zeichnet
  WaitBlit                        ← Erst jetzt warten (idealerweise Blitter schon fertig)
  Kick Blit Bob i
WaitBlit  (letzter Bob)
```

**Gewinn:** Die Adressberechnung (~30–50 Zyklen pro BOB) überlappt mit der Blit-Zeit
(~100–200 Zyklen pro BOB). Bei 10 BOBs: ~400 Zyklen idle eliminiert im Erase-Pass.

**Schritte:**
1. Erase-Loop umstrukturieren: Adress-Calc vor WaitBlit statt danach.
2. Erster Bob: Kein WaitBlit (Blitter ist initial idle).
3. Letzter Bob: WaitBlit nach dem letzten Kick.
4. Register-Zuordnung prüfen: Berechnete Werte müssen über den WaitBlit hinweg in
   Registern gehalten werden (kein Problem, d2–d7 verfügbar).

---

### T27 — FlushBobs: Draw-Pass-Pipelining

**Datei:** `app/src/m68k/fragments/bobs.s`

Identisches Prinzip wie T26, aber für den Draw-Pass (Masked-Blit).
Der Draw-Blit ist aufwändiger (3 Kanäle: A=Mask, B=Source, C=Dest, D=Dest)
und dauert daher länger → mehr CPU-Zeit für Adressberechnung verfügbar.

**Schritte:**
1. Draw-Loop analog umstrukturieren.
2. Besonderheit: Draw-Blit braucht mehr Register für Source/Mask/Dest-Adressen.
   → Pre-Calculate in Registern, dann WaitBlit + schnelles Kick-Sequence.

---

### T28 — Erase/Draw-Interleave (Fortgeschritten)

**Datei:** `app/src/m68k/fragments/bobs.s`

Noch aggressiver: Statt erst alle Bobs zu löschen, dann alle zu zeichnen,
**verschränken** wir Erase und Draw:

```
Erase Bob 0 → Draw Bob 0 → Erase Bob 1 → Draw Bob 1 → ...
```

**Vorteil:** Bessere Cache-Lokalität im Chip-RAM (gleicher Bildschirmbereich wird
kurz nacheinander gelesen und geschrieben). Reduziert Chip-RAM-Bus-Contention.

**Nachteil:** Komplexerer Code. Nur sinnvoll wenn BOBs sich nicht überlappen
(sonst: Erase von Bob 1 könnte Bob 0 beschädigen wenn sie überlappen).

**Empfehlung:** Nur als Option nach Profiling, wenn T26/T27 nicht ausreichen.
In den meisten Spielen überlappen BOBs nicht stark genug um Probleme zu verursachen.

---

### T29 — CPU-Work-Slots zwischen Blitter-Kicks

**Datei:** `app/src/codegen.js`, `app/src/m68k/fragments/bobs.s`

Der Codegen kann zwischen Blitter-Operationen CPU-Arbeit einschieben, die sonst
an anderer Stelle im Frame gemacht würde:

- Kollisionsberechnung (reine CPU-Arbeit, kein Blitter)
- Kamera-Update (einfache Addition)
- Zustandsmaschinen-Logik

**Ansatz:** Der Codegen emittiert `_FlushBobs` nicht als monolithischen `jsr`,
sondern als Sequence mit Callback-Slots:

```asm
        jsr     _FlushBobs_StartErase
        ; CPU: Kollisionslogik hier (Blitter läuft parallel)
        jsr     _FlushBobs_FinishEraseStartDraw
        ; CPU: Kamera-Update hier
        jsr     _FlushBobs_FinishDraw
```

**Komplexität:** Hoch. Erfordert Aufbrechen von `_FlushBobs` in Teilschritte.
**Empfehlung:** Erst nach T26/T27 evaluieren. Nur nötig wenn das Zyklen-Budget
nach allen anderen Optimierungen immer noch knapp ist.

---

## Abhängigkeitsgraph

```
Phase 1 (T1–T3)     Strength Reduction          ──── unabhängig
Phase 2 (T4–T6)     Lookup-Tabellen             ──── unabhängig
Phase 3 (T7–T10)    Pre-Shifted BOBs            ──── unabhängig
Phase 4 (T11–T13)   LICM                        ──── unabhängig
Phase 5 (T14–T19)   PERF-J Screen-Blit          ──── unabhängig
Phase 6 (T20–T25)   Register-Pinning            ──── nach Phase 4 (nutzt Write-Set-Analyse)
Phase 7 (T26–T29)   Blitter-Pipelining          ──── unabhängig
```

Phasen 1–5 und 7 sind vollständig unabhängig voneinander.
Phase 6 nutzt die Write-Set-Analyse aus Phase 4 (T11).

---

## Kosten/Nutzen-Übersicht

| Phase | Tasks | Zyklen-Gewinn/Frame | Aufwand | RAM-Kosten |
|---|---|---|---|---|
| 1 Strength Reduction | T1–T3 | 1.000–5.000 | Niedrig | 0 |
| 2 Lookup-Tabellen | T4–T6 | 5.000–10.000 | Niedrig–Mittel | ~2 KB |
| 3 Pre-Shifted BOBs | T7–T10 | 5.000–15.000 | Mittel | ~25 KB (10 BOBs) |
| 4 LICM | T11–T13 | 2.000–8.000 | Mittel–Hoch | 0 |
| 5 PERF-J Screen-Blit | T14–T19 | **30.000–60.000** | Hoch | ~16 Bytes BSS |
| 6 Register-Pinning | T20–T25 | 5.000–20.000 | Hoch | 0 |
| 7 Blitter-Pipelining | T26–T29 | 15.000–30.000 | Hoch | 0 |
| **Σ** | **29 Tasks** | **63.000–148.000** | | |

**Budget:** 162.000 Zyklen/Frame.
**Potenzielle Einsparung:** Bis zu 148.000 Zyklen → **91% weniger CPU-Last im Rendering.**

Das verbleibende Budget steht für Spiellogik, AI, Kollisionserkennung und Audio zur Verfügung.
