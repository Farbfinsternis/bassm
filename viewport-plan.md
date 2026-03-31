# M-VIEWPORT — Implementierungsplan

> **Stand:** 2026-03-28
> **Ziel:** Tilemap & Hardware-Slices — Ablösung des globalen Scrollings durch ein robustes Viewport-System.
> **Geschätzte Tasks:** 34 (V1, in 10 Phasen) + 8 (V2-Skizze: Per-VP Tiefe)

---

## 1. Überblick

M-VIEWPORT ersetzt das bisherige Konzept eines einzelnen globalen Screens durch ein System aus
unabhängigen Viewports. Jeder Viewport besitzt einen eigenen RAM-Puffer, eine eigene Copper-Section
und optional eine eigene Kamera. Der Amiga-Copper teilt den Bildschirm in horizontale Streifen —
Scrolling in einem Viewport beeinflusst andere Viewports nicht. HUDs und Status-Bars sind
automatisch stabil, weil sie in einem eigenen, nicht-scrollenden Viewport liegen.

### Neue Befehle

| Befehl | Syntax | Beschreibung |
|--------|--------|--------------|
| **SetViewport** | `SetViewport index, y1, y2` | Definiert Viewport `index` für Bildschirmzeilen y1..y2 (Literals). |
| **Viewport** | `Viewport index` | Schaltet den Zeichenkontext auf Viewport `index` um (Literal). |
| **SetCamera** | `SetCamera x, y` | Setzt die 2D-Kamera des aktiven Viewports (Expressions). |

### Anwendungsbeispiel

```basic
Graphics 320, 256, 5
SetViewport 0, 0, 199          ; Spielfeld (200 Zeilen)
SetViewport 1, 200, 255        ; HUD (56 Zeilen)

LoadTileset 0, "tiles.iraw", 16, 16
LoadTilemap 0, "world.bmap"
SetTilemap 0, 0

cx = 0 : cy = 0
While Not KeyDown(1)
  Viewport 0
  SetCamera cx, cy
  DrawTilemap 0, 0             ; scrollt automatisch mit Kamera
  DrawBob 1, playerX, playerY  ; World-Space → automatisch übersetzt

  Viewport 1
  Cls
  Text 10, 10, "Score: 12345"  ; Screen-Space (keine Kamera)

  ScreenFlip
Wend
```

---

## 2. Design-Entscheidungen

### D1 — Compile-Time Viewports
`SetViewport` erfordert **Integer-Literale** für index, y1, y2. Grund: Copper-Layout und
Buffer-Größen müssen zur Compile-Zeit feststehen (DATA_C / BSS_C).

### D2 — Lückenlose Abdeckung (V1)
Die Viewports müssen den gesamten Bildschirm abdecken:
`VP[0].y1 = 0`, `VP[N].y2 = GFXHEIGHT-1`, und `VP[i+1].y1 = VP[i].y2 + 1`.
Keine Lücken, keine Überlappungen. Vereinfacht die Copper-Generierung erheblich.

### D3 — Gleiche Breite; Tiefe V1 gleich, V2 variabel
Alle Viewports teilen sich `GFXWIDTH` und `GFXBPR`. In **V1** teilen sie auch `GFXDEPTH`
und `GFXIBPR` — dadurch funktionieren alle Zeichenbefehle unverändert.
In **V2** kann jeder Viewport eine eigene Tiefe erhalten (`SetViewport index, y1, y2, depth`).
Die Copper-Section-Architektur unterstützt das bereits: BPLCON0, BPLxPT-Tabellenlänge
und Palette-Größe sind per Section individuell. Der Umbau der Zeichenroutinen auf
per-VP `GFXIBPR`/`GFXPLANEOFS` ist der aufwändige Teil (→ Abschnitt 8: V2-Taskskizze).

### D4 — Gleicher GFXBORDER
Jeder Viewport bekommt den vollen 32px-Border (oben/unten/links/rechts).
Verschwendet etwas Chip-RAM bei kleinen Viewports, vermeidet aber Sonderpfade
in allen Zeichenroutinen. GFXPLANEOFS ist dadurch für alle Viewports identisch.

### D5 — Doppelpufferung für alle Viewports
Jeder Viewport hat ein eigenes Buffer-Paar (A/B). ScreenFlip tauscht ALLE
Viewports gleichzeitig (die zwei Copper-Listen wechseln sich ab wie bisher).

### D6 — Kamera nur für DrawBob + DrawTilemap
`DrawBob` wird automatisch von World-Space in Screen-Space übersetzt (camera_x/y Subtraktion).
`DrawTilemap` ohne explizite Scroll-Parameter nutzt die Kamera-Position als scrollX/scrollY.
Alle anderen Befehle (`Text`, `Plot`, `Line`, `Box`, `DrawImage`, `Cls`) arbeiten
in Screen-Space des aktiven Viewports — keine Kamera-Übersetzung.

### D7 — Per-Viewport Bob-Queues
Jeder Viewport hat eigene Bob-Queues (new/old_a/old_b). `DrawBob` schreibt in die
Queue des aktiven Viewports. `_FlushBobs` verarbeitet vor ScreenFlip alle Viewports
sequenziell.

### D8 — Per-Viewport Palette (gratis)
Jede Viewport-Section enthält eigene COLOR-Moves in der Copper-Liste. Der Copper
überschreibt die Palette-Register beim Erreichen einer neuen Section automatisch.
**Per-VP Palette ist daher in V1 ohne Zusatzaufwand enthalten.**
`Color`/`Palette`-Befehle innerhalb eines `Viewport N`-Kontexts schreiben nur in
die Copper-Sections von VP N (beide Listen A/B). Ohne Viewport-Kontext (Legacy oder
vor dem ersten `Viewport`-Befehl) schreiben sie in alle Sections.

### D9 — CopperColor-Kompatibilität
CopperColor (Raster-Effekte) wird in V1 **nicht** für Multi-Viewport unterstützt.
Compiler-Warnung wenn CopperColor zusammen mit SetViewport verwendet wird.
Wird in einer späteren Phase nachgerüstet.

### D10 — Impliziter Viewport 0 ohne SetViewport

Wird kein `SetViewport` verwendet, legt der Compiler automatisch **einen einzigen Viewport 0** an:
- `y1 = 0`, `y2 = GFXHEIGHT − 1` (Höhe aus dem `Graphics`-Befehl)
- Gleiche Copper-List-Struktur wie im Multi-Viewport-Modus (eine Section, kein WAIT)
- Gleiche Buffer-Labels und Offsets — alle Zeichenbefehle funktionieren unverändert

**Kamera:** Im impliziten Viewport 0 ist die Kamera **fix an den definierten Screen gebunden**
(aktuell 320×256). Da kein Scroll-Buffer (GFXVPAD/GFXHPAD) angelegt wird, ist `SetCamera`
wirkungslos — scrollX/scrollY bleiben 0. Für scrollende Programme ist `SetViewport` erforderlich.

**Vorteil:** Einziger Code-Pfad in `codegen.js`; kein separater Legacy-Ast der beim Erweitern
vergessen werden kann; bestehende Programme funktionieren ohne Änderung identisch.

---

## 3. Architektur

### 3.1 Copper-Liste (Multi-Viewport)

Jede der zwei Copper-Listen (A/B) hat folgende Struktur:

```
; ══════ Copper List A ══════
_gfx_copper_a:
        dc.w    $008E, GFXDIWSTRT          ; DIWSTRT (global)
        dc.w    $0090, GFXDIWSTOP          ; DIWSTOP (global)

; ── Viewport 0 (startet sofort, kein WAIT nötig) ────────────────
_vp0_cop_a:                                ; Section Base
        dc.w    $0092, $0038               ; +0  DDFSTRT
        dc.w    $0094, $00D0               ; +4  DDFSTOP
        dc.w    $0100, GFXBPLCON0          ; +8  BPLCON0
        dc.w    $0102, $0000               ; +12 BPLCON1 ← Tilemap patcht hier
        dc.w    $0104, $0000               ; +16 BPLCON2
        dc.w    $0108, GFXBPLMOD           ; +20 BPL1MOD ← Tilemap patcht hier
        dc.w    $010A, GFXBPLMOD           ; +24 BPL2MOD ← Tilemap patcht hier
_vp0_cop_a_bpl:                            ; +28 BPLxPT-Tabelle
        dc.w    $00E0, 0                   ;     BPL1PTH ← _PatchBitplanePtrs
        dc.w    $00E2, 0                   ;     BPL1PTL
        ... (D Planes × 8 Bytes)
_vp0_cop_a_pal:                            ; +28+D*8  Palette
        dc.w    $0180, 0                   ;     COLOR00
        ... (2^D Colors × 4 Bytes)        ; ← eigene Palette für VP0

; ── WAIT für Viewport 1 ─────────────────────────────────────────
        dc.w    $<(vStart+VP1_Y1)<<8|$01>, $FF00

; ── Viewport 1 ──────────────────────────────────────────────────
_vp1_cop_a:                                ; Section Base (gleiches Layout)
        dc.w    $0092, $0038               ; +0  DDFSTRT
        ...                                ; (identische Struktur wie VP0)
_vp1_cop_a_bpl:
        ...
_vp1_cop_a_pal:                            ; ← eigene Palette für VP1
        ...

        dc.w    $FFFF, $FFFE              ; END
```

### Standardisierte Offsets innerhalb einer Viewport-Section

```
VP_COP_DDFSTRT  EQU 2       ; Offset zum DDFSTRT Value-Word
VP_COP_DDFSTOP  EQU 6       ; Offset zum DDFSTOP Value-Word
VP_COP_BPLCON0  EQU 10      ; Offset zum BPLCON0 Value-Word
VP_COP_BPLCON1  EQU 14      ; Offset zum BPLCON1 Value-Word
VP_COP_BPLCON2  EQU 18      ; Offset zum BPLCON2 Value-Word
VP_COP_BPL1MOD  EQU 22      ; Offset zum BPL1MOD Value-Word
VP_COP_BPL2MOD  EQU 26      ; Offset zum BPL2MOD Value-Word
VP_COP_BPL      EQU 28      ; Offset zur BPLxPT-Tabelle
VP_COP_PAL      EQU (28+GFXDEPTH*8)  ; Offset zur Palette
```

In **V1** (gleiche Tiefe) sind diese Offsets für alle Viewports identisch.
In **V2** (per-VP Tiefe) variieren `VP_COP_PAL` und alles dahinter, weil die
BPLxPT-Tabellenlänge von der VP-Tiefe abhängt. Die Register-Offsets (DDFSTRT..BPL2MOD)
bleiben stabil — nur die BPL-Tabelle und Palette verschieben sich.
tilemap.s und andere Fragments nutzen diese EQUs statt hardcoded Magic Numbers.

### WAIT für Zeilen > 255

Der Copper kann nur V7..V0 vergleichen (8 Bit). Für display_line ≥ 256
(d.h. `vStart + y1 ≥ 256`, also `y1 ≥ 212` bei vStart=$2C):

```asm
        dc.w    $FFDF, $FFFE              ; WAIT end of line 255 (sets V8=1)
        dc.w    $<(line-256)<<8|$01>, $FF00  ; WAIT actual line (V8 already 1)
```

### 3.2 Buffer-Struktur

Jeder Viewport N bekommt:
- **VP_N_HEIGHT** = y2 − y1 + 1 (sichtbare Höhe)
- **VP_N_VHEIGHT** = VP_N_HEIGHT + 2 × GFXBORDER (inkl. Ränder)
- **VP_N_PSIZE** = GFXBPR × VP_N_VHEIGHT (eine Bitplane)
- **VP_N_BUFSIZE** = VP_N_PSIZE × GFXDEPTH (gesamter Buffer, interleaved)
- Für scrollende Viewports: **VP_N_BUFSIZE_SCROLL** = (VP_N_VHEIGHT + GFXVPAD) × GFXBPR × GFXDEPTH

**GFXPLANEOFS** bleibt gleich für alle Viewports (gleiche GFXBPR, gleicher GFXBORDER).

**V1-Beispiel** (5 Planes überall, 320×256, VP0=200 Zeilen, VP1=56 Zeilen):

| Buffer | Berechnung | Bytes |
|--------|-----------|-------|
| VP0 A | (200+64) × 48 × 5 | 63.360 |
| VP0 B | (200+64) × 48 × 5 | 63.360 |
| VP1 A | (56+64) × 48 × **5** | 28.800 |
| VP1 B | (56+64) × 48 × **5** | 28.800 |
| **Σ V1** | | **184.320** (~180 KB) |

**V2-Beispiel** (VP0=5 Planes, VP1=1 Plane HUD):

| Buffer | Berechnung | Bytes |
|--------|-----------|-------|
| VP0 A | (200+64) × 48 × 5 | 63.360 |
| VP0 B | (200+64) × 48 × 5 | 63.360 |
| VP1 A | (56+64) × 48 × **1** | 5.760 |
| VP1 B | (56+64) × 48 × **1** | 5.760 |
| **Σ V2** | | **138.240** (~135 KB) |

Zum Vergleich: Single-Screen = 153.600 Bytes.
V1 Delta +30 KB — vertretbar. V2 mit 1-Plane-HUD spart sogar 15 KB gegenüber Single-Screen.

### 3.3 Bob-Queues pro Viewport

Jeder Viewport hat einen **Bob-State-Block** im BSS (Fast RAM):

```
; Bob-State-Block Layout (pro Viewport):
;   +0   bobs_new_cnt.w
;   +2   bobs_old_cnt_a.w
;   +4   bobs_old_cnt_b.w
;   +6   bg_restore_fn.l        ; _bg_restore_static / _bg_restore_tilemap / 0
;   +10  bg_bpl_ptr.l           ; Hintergrund-Image für Restore
;   +14  fine_x.w               ; Sub-Tile X-Offset (von DrawTilemap)
;   +16  fine_y.w               ; Sub-Tile Y-Offset (von DrawTilemap)
;   +18  padding.w              ; Alignment
;   +20  bobs_new[BOBS_MAX×16]  ; Neue Queue
;   +20+N  bobs_old_a[BOBS_MAX×16]
;   +20+2N bobs_old_b[BOBS_MAX×16]
```

- `_active_bob_state` (BSS, .l): Pointer auf den State-Block des aktiven Viewports.
- `Viewport N` setzt `_active_bob_state` auf `_vpN_bob_state`.
- `_AddBob` nutzt `_active_bob_state` statt der bisherigen globalen `_bobs_new`-Labels.
- `_FlushBobs` wird mit dem State-Block-Pointer in a4 aufgerufen (parametrisiert).

### 3.4 Camera-Kompensation (fine_x / fine_y)

Wenn die Kamera bei `(cx, cy)` steht und `DrawTilemap` mit `scrollX=cx, scrollY=cy` gerufen wird:
- `fine_x = cx % tileW`, `fine_y = cy % tileH`
- Hardware (BPLCON1 + BPLxPT) verschiebt die gesamte Anzeige um `(fine_x, fine_y)` Pixel
- Ein Bob bei Welt-Position `(wx, wy)` muss bei **Buffer-Position** gezeichnet werden:

```
buffer_x = (wx − cx) + fine_x
buffer_y = (wy − cy) + fine_y
```

So kompensiert die Buffer-Position den Hardware-Shift:

```
display_x = buffer_x − fine_x = wx − cx     ✓
display_y = buffer_y − fine_y = wy − cy     ✓
```

**Implementierung:** Die Camera-Subtraktion `(wx − cx, wy − cy)` emittiert der Codegen.
Die Fine-Kompensation `(+ fine_x, + fine_y)` übernimmt `_FlushBobs` beim Blitten —
analog zum bestehenden `_active_fine_y`-Konzept, erweitert um `fine_x`.

---

## 4. Implementierungsphasen

### Phase 0 — API & Parser

#### T1 — commands-map.json: Neue Einträge ✓

**Datei:** `app/src/commands-map.json`

- `"SetViewport"`: `{ "args": 3, "types": ["int","int","int"] }`
- `"Viewport"`: `{ "args": 1, "types": ["int"] }`
- `"SetCamera"`: `{ "args": 2, "types": ["expr","expr"] }`

Alle drei sind Commands (keine Funktionen/Expressions).

**`DrawTilemap` erweitern** — scrollX/scrollY beide optional machen:

```json
{
    "name": "DrawTilemap",
    "args": [
        { "name": "tmSlot",  "type": "integer" },
        { "name": "tsSlot",  "type": "integer" },
        { "name": "scrollX", "type": "integer", "optional": true },
        { "name": "scrollY", "type": "integer", "optional": true }
    ]
}
```

Regel: scrollX und scrollY müssen **gemeinsam** angegeben werden oder **beide** fehlen.
Nur scrollX ohne scrollY ist ein Compilerfehler (bisher war scrollY das optionale Argument —
dieses Verhalten ändert sich).

Bisheriger 3-Arg-Aufruf `DrawTilemap tm, ts, scrollX` war "scrollY optional = 0" und
bleibt weiterhin gültig (scrollY default 0).

Neue 2-Arg-Variante `DrawTilemap tm, ts` = Camera-Modus (→ T20).

#### T2 — Parser: Neue Keywords + Statement-Nodes ✓

**Dateien:** `app/src/keywords-map.json`, `app/src/parser.js`

- Keywords registrieren: `"SetViewport"`, `"Viewport"`, `"SetCamera"`.
- Parser-Methoden:
  - `_parseSetViewport()` → `{ type: 'set_viewport', index: int, y1: int, y2: int, line }`
  - `_parseViewport()` → `{ type: 'viewport_cmd', index: int, line }`
  - `_parseSetCamera()` → `{ type: 'set_camera', x: Expr, y: Expr, line }`
- Validierung im Parser: `index`, `y1`, `y2` müssen Integer-Literale sein.
  `Viewport index` muss Integer-Literal sein (V1).

#### T3 — CodeGen: Pre-Pass + Validierung ✓

**Datei:** `app/src/codegen.js`

- Neues Instanzfeld: `this._viewports = new Map()` — index → `{ y1, y2, height, scroll }`.
- Im Pre-Pass (neben `_collectVars`):
  - Alle `set_viewport`-Nodes sammeln.
  - Sortierung nach y1 prüfen.
  - Validierung (Compilerfehler bei Verletzung):
    - Indizes 0..N lückenlos?
    - y1[0] = 0, y2[N] = GFXHEIGHT−1?
    - y1[i+1] = y2[i]+1 (lückenlos)?
    - 0 ≤ y1 < y2 ≤ GFXHEIGHT−1?
- Neues Flag: `this._hasExplicitViewports = this._viewports.size > 0`.
  Wird **vor** der impliziten VP0-Injektion (T32) gesetzt und ändert sich danach nicht.
  Steuert: Label-Aliasing (T7), Copper-Struktur (T5), Fragment-Pfade.
- Wenn `_hasExplicitViewports && _usesRaster` → Compiler-Warnung / Fehler (D9).
- Neues Feld: `this._activeViewportIdx = 0` (Compile-Time Viewport Tracker, für T15).

---

### Phase 1 — Copper-Liste pro Viewport

#### T4 — Copper-Section Layout & EQU-Offsets ✓

**Datei:** `app/src/codegen.js`

- Neues EQU-Set emittieren (nur wenn `_usesViewports`):
  ```
  VP_COP_DDFSTRT  EQU 2
  VP_COP_BPLCON1  EQU 14
  VP_COP_BPL1MOD  EQU 22
  VP_COP_BPL2MOD  EQU 26
  VP_COP_BPL      EQU 28
  ```
- Die EQUs gelten für alle Viewport-Sections (identische Struktur).
- tilemap.s und ggf. weitere Fragments nutzen diese Offsets statt Magic Numbers.
  (Wenn `_usesViewports` false, werden die EQUs nicht emittiert → Legacy-Offsets gelten.)

#### T5 — Copper-Generation refaktorieren ✓

**Datei:** `app/src/codegen.js`

- Bisherige `emitCopHeader()`-Logik in neue Funktion `_emitViewportCopSection(vpIdx)` extrahieren.
- Neue Funktion emittiert pro Viewport-Section:
  1. Label: `_vp${idx}_cop_${ab}:`
  2. DDFSTRT + DDFSTOP (Standard: `$0038` / `$00D0`)
  3. BPLCON0 + BPLCON1 + BPLCON2
  4. BPL1MOD + BPL2MOD (interleaved: `GFXBPLMOD`)
  5. Label: `_vp${idx}_cop_${ab}_bpl:` → BPLxPT-Paare (D Planes × 2 dc.w)
  6. Label: `_vp${idx}_cop_${ab}_pal:` → COLOR00..COLORn
- Hauptfunktion `_emitCopperList(ab)`:
  1. Global: DIWSTRT, DIWSTOP
  2. Viewport 0 Section (kein WAIT)
  3. Für VP 1..N: WAIT + Section
  4. END: `$FFFF,$FFFE`

#### T6 — WAIT-Instruktionen zwischen Viewports ✓

**Datei:** `app/src/codegen.js`

- WAIT vor Viewport i (i ≥ 1):
  - `display_line = vStart + VP[i].y1`
  - Wenn `display_line < 256`:
    - `dc.w $${hex((display_line << 8) | 0x01)},$FF00`
  - Wenn `display_line ≥ 256`:
    - `dc.w $FFDF,$FFFE` (WAIT for end of line 255)
    - `dc.w $${hex(((display_line - 256) << 8) | 0x01)},$FF00`

#### T7 — XDEF / XREF Labels pro Section + Alias-Strategie ✓

**Datei:** `app/src/codegen.js`

- Pro Viewport und Copper-Liste (a/b) exportieren:
  - `_vp${idx}_cop_${ab}` — Section Base
  - `_vp${idx}_cop_${ab}_bpl` — BPLxPT-Tabelle
  - `_vp${idx}_cop_${ab}_pal` — Palette-Start

**Alias-Strategie für Legacy-Kompatibilität (`!_hasExplicitViewports`):**

Wenn kein `SetViewport` verwendet wird (impliziter VP0), emittiert codegen.js an jeder
relevanten Stelle **beide Label gleichzeitig** — vasm unterstützt mehrere Labels
an derselben Adresse:

```asm
; Copper-Liste A:
_gfx_copper_a:          ; Legacy-Alias
_vp0_cop_a:             ; neues Label — beide zeigen auf denselben Punkt
        dc.w    $008E,...  ; DIWSTRT

_gfx_cop_a_bpl_table:   ; Legacy-Alias
_vp0_cop_a_bpl:
        dc.w    $00E0,0    ; BPL1PTH ...

; Buffer BSS:
_gfx_planes_data:       ; Legacy-Alias
_vp0_planes_a_data:
        ds.b    GFXBUFSIZE

_gfx_planes_b_data:     ; Legacy-Alias
_vp0_planes_b_data:
        ds.b    GFXBUFSIZE
```

Wenn `_hasExplicitViewports === true` (User schrieb `SetViewport`): **nur** die neuen
`_vpN_*`-Labels emittieren; keine Legacy-Labels. Alle Fragments (tilemap.s, bobs.s, …)
müssen in diesem Modus ausschließlich die neuen Labels oder `_active_*`-Variablen nutzen.

---

### Phase 2 — Buffer & State-Allokation

#### T8 — Per-Viewport EQUs ✓

**Datei:** `app/src/codegen.js`

Pro Viewport N emittieren:

```
VP_N_Y1      EQU <y1>
VP_N_Y2      EQU <y2>
VP_N_HEIGHT  EQU <y2-y1+1>
VP_N_VHEIGHT EQU (VP_N_HEIGHT+GFXBORDER*2)
VP_N_PSIZE   EQU (GFXBPR*VP_N_VHEIGHT)
VP_N_BUFSIZE EQU (VP_N_PSIZE*GFXDEPTH)
```

Falls Viewport N Tilemap nutzt (→ aus Pre-Pass bekannt):

```
VP_N_BUFSIZE_SCROLL EQU ((VP_N_VHEIGHT+GFXVPAD)*GFXBPR*GFXDEPTH)
```

Zusätzlich: `VP_COUNT EQU <Anzahl Viewports>`.

#### T9 — Per-Viewport BSS_C Buffer ✓

**Datei:** `app/src/codegen.js`

Pro Viewport N zwei Chip-RAM Buffer:

```asm
        SECTION vp_N_planes_a,BSS_C
_vpN_planes_a_data:  ds.b    VP_N_BUFSIZE    ; (oder VP_N_BUFSIZE_SCROLL)

        SECTION vp_N_planes_b,BSS_C
_vpN_planes_b_data:  ds.b    VP_N_BUFSIZE
```

- Die alten `_gfx_planes_data` / `_gfx_planes_b_data` werden durch VP-Buffer ersetzt.
- `startup.s` muss die Pointer `_gfx_planes` / `_gfx_planes_b` nicht mehr setzen —
  stattdessen setzt `_setup_graphics` die VP-Pointer direkt (→ T11).

#### T10 — Per-Viewport BSS State-Variablen ✓

**Datei:** `app/src/codegen.js` (emittiert in `SECTION user_vars,BSS`)

Pro Viewport N:

```asm
_vpN_back_ptr:       ds.l    1       ; Zeiger auf visible origin des Back-Buffers
_vpN_cam_x:          ds.l    1       ; Kamera X (0 wenn keine Kamera gesetzt)
_vpN_cam_y:          ds.l    1       ; Kamera Y
_vpN_cop_a_base:     ds.l    1       ; Adresse von _vpN_cop_a (Section-Base Copper A)
_vpN_cop_b_base:     ds.l    1       ; Adresse von _vpN_cop_b (Section-Base Copper B)
```

Globale Active-State-Variablen:

```asm
_active_vp_idx:      ds.w    1       ; Index des aktiven Viewports
_active_cop_base:    ds.l    1       ; Copper-Section-Base des aktiven VP im Back-Copper
```

Tilemap-State (pro Viewport, nur wenn VP Tilemap nutzt):

```asm
_vpN_tilemap_ptr:    ds.l    1
_vpN_tileset_ptr:    ds.l    1
_vpN_scroll_x:       ds.l    1
_vpN_scroll_y:       ds.l    1
```

---

### Phase 3 — Initialisierung

#### T11 — _setup_graphics: Per-Viewport BPLxPT-Patch ✓

**Datei:** `app/src/codegen.js` (generierter Code in `_setup_graphics`)

Für jeden Viewport N und jede Copper-Liste (A/B):

```asm
        ; VP N, Copper A
        lea     _vpN_cop_a_bpl,a0
        lea     _vpN_planes_a_data+GFXPLANEOFS,a1
        moveq   #GFXDEPTH,d0
        move.l  #GFXBPR,d1
        jsr     _PatchBitplanePtrs

        ; VP N, Copper B
        lea     _vpN_cop_b_bpl,a0
        lea     _vpN_planes_b_data+GFXPLANEOFS,a1
        moveq   #GFXDEPTH,d0
        move.l  #GFXBPR,d1
        jsr     _PatchBitplanePtrs
```

Palette: Initial-Palette (aus `Palette`/`Color`-Befehlen vor der Hauptschleife) in **alle**
Viewport-Sections schreiben. Jede Section hat eigene COLOR-Moves (D8) — initial identisch,
können aber zur Laufzeit per VP divergieren.

Copper-Adressen in BSS cachen:

```asm
        lea     _vpN_cop_a,a0
        move.l  a0,_vpN_cop_a_base
        lea     _vpN_cop_b,a0
        move.l  a0,_vpN_cop_b_base
```

#### T12 — Initial-Pointer ✓

**Datei:** `app/src/codegen.js`

Nach dem Patch aller BPLxPT:

```asm
        ; Initial: Front = Copper A, Back = Buffer B
        lea     _gfx_copper_a,a0
        jsr     _InstallCopper
        jsr     _InitPalette

        ; VP0 ist der Initial-Viewport
        move.l  #_vp0_planes_b_data+GFXPLANEOFS,_vp0_back_ptr
        move.l  _vp0_back_ptr,_back_planes_ptr

        ; Alle anderen VPs: Back = Buffer B
        move.l  #_vp1_planes_b_data+GFXPLANEOFS,_vp1_back_ptr
        ; ... (für jeden VP)

        clr.b   _front_is_a
```

---

### Phase 4 — Viewport-Kontext

#### T13 — Viewport N Command ✓

**Datei:** `app/src/codegen.js` (in `_genStatement`, neuer Case `viewport_cmd`)

`Viewport N` emittiert:

```asm
        ; 1. Drawing-Target umschalten
        move.l  _vpN_back_ptr,_back_planes_ptr

        ; 2. Active-Copper-Base setzen (für DrawTilemap-Patches)
        tst.b   _front_is_a
        bne.s   .vp_N_cop_a
        lea     _vpN_cop_b,a0          ; front=A → back=B
        bra.s   .vp_N_cop_done
.vp_N_cop_a:
        lea     _vpN_cop_a,a0          ; front=B → back=A
.vp_N_cop_done:
        move.l  a0,_active_cop_base

        ; 3. Bob-State-Block aktivieren
        lea     _vpN_bob_state,a0
        move.l  a0,_active_bob_state

        ; 4. Active-VP-Index setzen
        move.w  #N,_active_vp_idx
```

- `_active_bob_state` wird von `_AddBob` gelesen (→ T27).
- `_active_cop_base` wird von `_DrawTilemap` für Copper-Patches gelesen (→ T21).

#### T14 — Cls per Viewport ✓

**Datei:** `app/src/codegen.js`

- Der Codegen kennt zur Compile-Zeit den aktiven Viewport (T15: `_activeViewportIdx`).
- Cls emittiert viewport-spezifisches BLTSIZE:
  ```asm
  move.w  #((VP_N_VHEIGHT*GFXDEPTH)<<6|(GFXBPR/2)),d0
  jsr     _Cls
  ```
- **cls.s**: `_Cls` nimmt BLTSIZE im Register d0 statt hardcoded EQU.
  Minimale Änderung: `move.w d0,BLTSIZE(a5)` statt `move.w #...,BLTSIZE(a5)`.
- ClsColor analog: d0 = BLTSIZE, d1 = Color-Index (bereits so oder trivial erweiterbar).

#### T15 — Compile-Time Viewport-Tracking ✓

**Datei:** `app/src/codegen.js`

- `this._activeViewportIdx` wird bei jedem `viewport_cmd` aktualisiert.
- Ermöglicht dem Codegen, viewport-spezifische EQUs (VP_N_VHEIGHT etc.)
  in generierten Instruktionen zu referenzieren.
- Fehler wenn `DrawBob` oder `DrawTilemap` vor dem ersten `Viewport`-Befehl steht
  und mehrere Viewports definiert sind (ambig welcher VP aktiv ist).
  - Ausnahme: Wenn nur 1 Viewport definiert ist → implizit VP0.

---

### Phase 5 — ScreenFlip

#### T16 — Viewport-Pointer-Swap nach Flip ✓

**Datei:** `app/src/codegen.js` (Injection bei `ScreenFlip`-Command)

Nach `jsr _ScreenFlip` emittiert der Codegen inline:

```asm
        ; ScreenFlip hat _front_is_a getoggelt.
        ; Jetzt Back-Pointer für alle VPs aktualisieren:
        tst.b   _front_is_a
        bne.s   .flip_back_a

        ; front_is_a = 0 → Back ist Buffer-Set B
        move.l  #_vp0_planes_b_data+GFXPLANEOFS,_vp0_back_ptr
        move.l  #_vp1_planes_b_data+GFXPLANEOFS,_vp1_back_ptr
        ; ... (für jeden VP)
        bra.s   .flip_vp_done

.flip_back_a:
        ; front_is_a = 1 → Back ist Buffer-Set A
        move.l  #_vp0_planes_a_data+GFXPLANEOFS,_vp0_back_ptr
        move.l  #_vp1_planes_a_data+GFXPLANEOFS,_vp1_back_ptr
        ; ... (für jeden VP)

.flip_vp_done:
        ; Default Drawing-Target auf VP0
        move.l  _vp0_back_ptr,_back_planes_ptr
```

Dieser Code wird inline emittiert (nicht in flip.s), weil VP-Count und Labels
compile-time-spezifisch sind.

#### T17 — _ScreenFlip unverändert lassen ✓

**Datei:** `app/src/m68k/fragments/flip.s`

- `_ScreenFlip` bleibt wie bisher: Copper-Swap + VBL-Wait + `_front_is_a` Toggle.
- Die VP-spezifische Logik liegt komplett im Codegen-emittierten Code (T16).
- Einzige Änderung: `_back_planes_ptr`-Zuweisung in flip.s entfernen
  (wird jetzt vom Codegen nach dem `jsr _ScreenFlip` erledigt).
  → Nur wenn `_usesViewports`; Legacy-Pfad behält flip.s unverändert.

---

### Phase 6 — Camera-System

#### T18 — SetCamera Command ✓

**Datei:** `app/src/codegen.js`

`SetCamera x, y` emittiert:

```asm
        ; eval y → d0
        move.l  d0,_vpN_cam_y       ; N = aktueller Viewport (compile-time bekannt)
        ; eval x → d0
        move.l  d0,_vpN_cam_x
```

- `_vpN_cam_x/y` werden durch `Viewport N` beim nächsten Frame-Wechsel nicht gelöscht —
  die Kamera bleibt bis zum nächsten `SetCamera`-Aufruf bestehen.
- Ohne `SetCamera`: `_vpN_cam_x/y = 0` (BSS Zero-Init) → keine Translation.

#### T19 — DrawBob: Camera-Translation ✓

**Datei:** `app/src/codegen.js`

Wenn der aktive Viewport eine Kamera hat (Compile-Time-Tracking: `SetCamera` wurde für
diesen VP aufgerufen), wird bei `DrawBob imgIdx, wx, wy` folgendes emittiert:

```asm
        ; eval wy → d0
        sub.l   _vpN_cam_y,d0       ; World-Y → Screen-Y
        move.l  d0,-(sp)
        ; eval wx → d0
        sub.l   _vpN_cam_x,d0       ; World-X → Screen-X
        ; ... normaler AddBob-Aufruf
```

- Die fine_x/fine_y-Kompensation erfolgt NICHT hier, sondern in `_FlushBobs` (→ T30).
- Wenn keine Kamera → kein `sub.l` emittiert (kein Overhead für kameralose VPs).

#### T20 — DrawTilemap: Camera-Modus ✓

**Datei:** `app/src/codegen.js`

Bisherig: `DrawTilemap tmSlot, tsSlot, scrollX, scrollY`

Neu (alternative Syntax): `DrawTilemap tmSlot, tsSlot` (ohne Scroll-Args)

**Parsing:** `_genDrawTilemap(stmt)` prüft `stmt.args.length`:
- `args.length === 2` → Camera-Modus
- `args.length === 3` → explizit scrollX, scrollY = 0 (Backward-Compat, wie bisher)
- `args.length === 4` → explizit scrollX + scrollY

**Camera-Modus (2 Args) — emittierter Code:**
```asm
        move.l  _vp0_cam_x,d0      ; scrollX = camera_x des aktiven VP
        move.l  _vp0_cam_y,d1      ; scrollY = camera_y des aktiven VP
        lea     _tilemap_M,a0
        lea     _tileset_K,a1
        jsr     _DrawTilemap
```

- Compilerfehler wenn 2 Args und `_hasExplicitViewports === false` (impliziter VP0 hat keinen
  Scroll-Puffer — SetCamera wäre No-Op, Camera-Modus macht keinen Sinn).
- Compilerfehler wenn 2 Args und kein vorhergehender `SetCamera`-Aufruf im aktiven Viewport
  (würde mit Camera (0,0) scrollen — wahrscheinlich ein Bug im Programm).

---

### Phase 7 — Tilemap per Viewport

#### T21 — tilemap.s: Viewport-Copper patchen ✓

**Datei:** `app/src/m68k/fragments/tilemap.s`

Bisheriger Code patcht Copper-Offsets relativ zur Copper-List-Base:

```asm
; ALT:
lea     _gfx_copper_b,a0       ; ← globale Copper-Base
move.w  d1,22(a0)              ; BPLCON1 (alter Offset)
move.w  #$0030,10(a0)          ; DDFSTRT (alter Offset)
```

Neu: `_DrawTilemap` liest `_active_cop_base` (gesetzt von `Viewport N`, T13)
und nutzt die standardisierten VP_COP_*-Offsets:

```asm
; NEU:
move.l  _active_cop_base,a0    ; ← aktive VP Section-Base
move.w  d1,VP_COP_BPLCON1(a0)  ; BPLCON1 (EQU 14)
move.w  #$0030,VP_COP_DDFSTRT(a0)  ; DDFSTRT (EQU 2)
move.w  #(GFXBPLMOD-2),VP_COP_BPL1MOD(a0)
move.w  #(GFXBPLMOD-2),VP_COP_BPL2MOD(a0)
```

BPLxPT-Patch:

```asm
lea     VP_COP_BPL(a0),a0     ; → BPLxPT-Tabelle (EQU 28)
move.l  _back_planes_ptr,a1
; ... rest wie bisher (subq #2, fine_y offset, _PatchBitplanePtrs)
```

- Die Logik zum Auswählen von Copper A vs B (via `_front_is_a`) entfällt —
  `_active_cop_base` zeigt bereits auf die richtige (Back-)Copper-Section.

#### T22 — Codegen: Copper-Bases an tilemap.s kommunizieren ✓

**Datei:** `app/src/codegen.js`

- `_active_cop_base` wird von `Viewport N` (T13) gesetzt.
- `_DrawTilemap` liest `_active_cop_base` direkt (XREF in tilemap.s).
- BPL-Tabelle: `_active_cop_bpl` = `_active_cop_base + VP_COP_BPL` (inline berechnet).
- Kein neuer BSS-Slot nötig — `_active_cop_base` reicht aus.

#### T23 — Per-Viewport Tilemap-State ✓

**Datei:** `app/src/codegen.js`

- Bisherige globale Variablen (`_active_tilemap_ptr`, `_active_tileset_ptr`,
  `_active_scroll_x/y`) werden pro Viewport:
  ```
  _vpN_tilemap_ptr  ds.l 1
  _vpN_tileset_ptr  ds.l 1
  _vpN_scroll_x     ds.l 1
  _vpN_scroll_y     ds.l 1
  ```
- `SetTilemap tmSlot, tsSlot` emittiert Stores in die VP-spezifischen Labels
  (Compile-Time aktiver VP bekannt durch T15).
- `DrawTilemap` schreibt `_vpN_scroll_x/y` statt der globalen Variablen.
- `_bg_restore_tilemap` liest VP-spezifische Variablen (→ T24).

#### T24 — _bg_restore_tilemap: Viewport-aware ✓

**Datei:** `app/src/m68k/fragments/tilemap.s`

- `_bg_restore_tilemap` liest aktuell `_active_tilemap_ptr`, `_active_tileset_ptr`,
  `_active_scroll_x`, `_active_scroll_y` aus globalen BSS-Variablen.
- Mit Viewports: `_FlushBobs` setzt vor dem Restore-Pass die korrekten Pointer
  aus dem Bob-State-Block (T28). Zwei Optionen:
  - **Option A:** `_FlushBobs` kopiert die VP-spezifischen Werte in die globalen
    `_active_*`-Variablen vor dem Aufruf. `_bg_restore_tilemap` bleibt unverändert.
  - **Option B:** `_bg_restore_tilemap` nimmt Pointer als Register-Parameter.
- **Empfehlung: Option A** — minimal-invasiv für tilemap.s. Die globalen `_active_*`
  Variablen dienen als "Active-Viewport Shadowcopy", die von `_FlushBobs` per VP befüllt wird.

---

### Phase 8 — Bob-System pro Viewport

#### T25 — Bob-State-Block Definition ✓

**Dateien:** `app/src/m68k/fragments/bobs.s`, `app/src/codegen.js`

- Neues EQU-Set (in `bobs.s` definiert, via XDEF exportiert):
  ```
  BOB_ST_NEW_CNT    EQU 0       ; .w — bobs queued this frame
  BOB_ST_OLD_CNT_A  EQU 2       ; .w — old bob count for buffer A
  BOB_ST_OLD_CNT_B  EQU 4       ; .w — old bob count for buffer B
  ; EQU 6: .w padding — erzwingt Longword-Ausrichtung für die folgenden .l-Felder
  BOB_ST_RESTORE_FN EQU 8       ; .l — fn ptr (_bg_restore_static / _bg_restore_tilemap / 0)
  BOB_ST_BG_BPL_PTR EQU 12      ; .l — ptr to bg image bitplane-0 data
  BOB_ST_FINE_X     EQU 16      ; .w — horizontal fine-scroll offset (Tilemap, 0..tileW-1)
  BOB_ST_FINE_Y     EQU 18      ; .w — vertical fine-scroll offset (Tilemap, 0..tileH-1)
  BOB_ST_NEW        EQU 20      ; Bob-Queue new  (BOBS_MAX × 16 Bytes)
  BOB_ST_OLD_A      EQU (20+BOBS_MAX*16)
  BOB_ST_OLD_B      EQU (20+BOBS_MAX*2*16)
  BOB_ST_SIZE       EQU (20+BOBS_MAX*3*16)
  ```

**Alignment-Begründung:** Die drei `.w`-Felder (Offset 0–5) belegen 6 Bytes. Ein `.w`-Padding
bei Offset 6 bringt `BOB_ST_RESTORE_FN` auf Offset 8 (= Longword-Grenze). Alle `.l`-Felder
danach (`BOB_ST_RESTORE_FN`, `BOB_ST_BG_BPL_PTR`) liegen auf Longword-Grenzen — auf dem
68000 zwingend erforderlich, sonst Bus Error.

**Migration von bobs.s:** Das bestehende BSS-Layout in `bobs.s` (globale Labels
`_bg_restore_fn`, `_bg_bpl_ptr`, `_bobs_new_cnt`, `_bobs_new`, `_bobs_old_a/b`)
wird **komplett entfernt**. Der State-Block ersetzt diese Variablen vollständig.
Codegen emittiert den Block per Viewport (T26). `bobs.s` enthält danach nur noch CODE.

#### T26 — BSS für Bob-State-Blocks ✓

**Datei:** `app/src/codegen.js`

Pro Viewport N (nur wenn VP Bobs verwendet):

```asm
        SECTION vpN_bob_state_sec,BSS
_vpN_bob_state:  ds.b    BOB_ST_SIZE
```

Globale Pointer:

```asm
_active_bob_state:   ds.l    1       ; Ptr auf aktiven VP Bob-State-Block
```

- Die alten globalen `_bobs_new`, `_bobs_old_a/b`, `_bobs_new_cnt` etc.
  werden in den State-Block migriert.
- Legacy (ohne Viewports): ein einzelner State-Block `_vp0_bob_state`,
  `_active_bob_state` initial darauf gesetzt.

#### T27 — _AddBob: State-Block-Pointer ✓

**Datei:** `app/src/m68k/fragments/bobs.s`

Bisherig:

```asm
_AddBob:
        move.w  _bobs_new_cnt,d0
        ...
        lea     _bobs_new,a4
```

Neu:

```asm
_AddBob:
        move.l  _active_bob_state,a4
        move.w  BOB_ST_NEW_CNT(a4),d0
        cmp.w   #BOBS_MAX,d0
        bge.s   .full
        ...
        lea     BOB_ST_NEW(a4),a3      ; Queue-Base
        ; Slot-Offset: d0 * 16
        mulu.w  #16,d0
        lea     0(a3,d0.l),a3
        ; Schreibe imgptr, maskptr, x, y, frame in Slot
        ...
        addq.w  #1,BOB_ST_NEW_CNT(a4)
.full:
        ...
```

Alle Zugriffe auf `_bobs_new_cnt`, `_bobs_new` etc. werden relativ zu a4 (State-Block).

#### T28 — _FlushBobs: Parametrisiert via a4

**Datei:** `app/src/m68k/fragments/bobs.s`

`_FlushBobs` erhält den State-Block-Pointer in a4:

```asm
_FlushBobs:
        ; a4 = VP Bob-State-Block (gesetzt vom Codegen)
        ;
        ; Schritt 0: Aktive Queues bestimmen (old_a oder old_b je nach _front_is_a)
        ;   old_queue = _front_is_a ? BOB_ST_OLD_A(a4) : BOB_ST_OLD_B(a4)
        ;   old_cnt   = _front_is_a ? BOB_ST_OLD_CNT_A(a4) : BOB_ST_OLD_CNT_B(a4)
        ;
        ; Schritt 1: Erase old bobs
        ;   _bg_restore_fn aus BOB_ST_RESTORE_FN(a4) lesen
        ;   _bg_bpl_ptr aus BOB_ST_BG_BPL_PTR(a4)
        ;   fine_x/fine_y aus BOB_ST_FINE_X/Y(a4) für Position-Korrektur
        ;
        ; Schritt 2: Draw new bobs
        ;   Lese BOB_ST_NEW(a4), count = BOB_ST_NEW_CNT(a4)
        ;   fine_x/fine_y-Kompensation beim Blitten (→ T30)
        ;
        ; Schritt 3: new → old kopieren
        ; Schritt 4: BOB_ST_NEW_CNT(a4) = 0
```

- `_back_planes_ptr` muss VOR dem Aufruf korrekt gesetzt sein (vom Codegen).
- `_bg_restore_fn` und `_bg_bpl_ptr` kommen aus dem State-Block (→ gesetzt von SetBackground/SetTilemap).

#### T29 — Codegen: FlushBobs-Injection pro Viewport

**Datei:** `app/src/codegen.js`

Bisherig (vor ScreenFlip):

```asm
        jsr     _FlushBobs
```

Neu (pro Viewport):

```asm
        ; ── Flush VP 0 ──
        move.l  _vp0_back_ptr,_back_planes_ptr
        ; Active tilemap state → globale Shadow-Variablen kopieren (Option A, T24):
        move.l  _vp0_tilemap_ptr,_active_tilemap_ptr
        move.l  _vp0_tileset_ptr,_active_tileset_ptr
        move.l  _vp0_scroll_x,_active_scroll_x
        move.l  _vp0_scroll_y,_active_scroll_y
        lea     _vp0_bob_state,a4
        jsr     _FlushBobs

        ; ── Flush VP 1 ──
        move.l  _vp1_back_ptr,_back_planes_ptr
        move.l  _vp1_tilemap_ptr,_active_tilemap_ptr
        ; ... (analog)
        lea     _vp1_bob_state,a4
        jsr     _FlushBobs
```

Optimierung: VPs ohne Bobs (`!_usesBobs` für diesen VP) überspringen.
Erkennung: Compile-Time-Tracking ob `DrawBob`/`SetBackground` in einem VP aufgerufen wurde.

---

### Phase 9 — Fine-Scroll-Kompensation

#### T30 — _FlushBobs: fine_x + fine_y

**Datei:** `app/src/m68k/fragments/bobs.s`

Im Draw-Pass von `_FlushBobs`, vor dem Blit jedes Bobs:

```asm
        ; Bob-Position aus Queue lesen:
        move.w  8(a3),d0              ; screen_x
        move.w  10(a3),d1             ; screen_y

        ; Fine-Scroll-Kompensation:
        add.w   BOB_ST_FINE_X(a4),d0  ; + fine_x (NEU)
        add.w   BOB_ST_FINE_Y(a4),d1  ; + fine_y (bisher _active_fine_y)
```

Im Erase-Pass (Restore): gleiche Kompensation für die alten Positionen.

- Wenn kein Tilemap-Scroll aktiv: fine_x = fine_y = 0 (BSS-Init) → `add.w #0,dN` = NOP.
  Kein Branch nötig, minimal verschwendete Zyklen.

#### T31 — Per-Viewport fine_x/fine_y

**Datei:** `app/src/m68k/fragments/tilemap.s`, `app/src/codegen.js`

- `_DrawTilemap` schreibt `fine_x` und `fine_y` in den aktiven VP-Bob-State-Block:
  ```asm
  move.l  _active_bob_state,a4        ; (oder aus Register, falls noch geladen)
  move.w  d0,BOB_ST_FINE_X(a4)        ; fine_x
  move.w  <fine_y>,BOB_ST_FINE_Y(a4)  ; fine_y
  ```
- Alternativ: `_DrawTilemap` schreibt in globale `_active_fine_x/y` BSS-Vars,
  und der Codegen kopiert sie in den State-Block (wie bei den Tilemap-Pointern).
- Codegen: `_active_fine_x` BSS-Variable emittieren (analog zum bestehenden `_active_fine_y`).

---

### Phase 10 — Rückwärtskompatibilität & Abschluss

#### T32 — Impliziter Viewport 0 ohne SetViewport

**Datei:** `app/src/codegen.js`

Ablauf in `generate()`, direkt nach dem Pre-Pass, vor der Code-Generierung:

```js
// _hasExplicitViewports wurde bereits im Pre-Pass gesetzt (T3)
if (!this._hasExplicitViewports) {
    this._viewports.set(0, { y1: 0, y2: this._gfxHeight - 1, scroll: false });
}
```

- `scroll: false` → kein GFXVPAD/GFXHPAD; Buffer-Größe = sichtbare Fläche (= aktuelle Größe)
- `SetCamera` im impliziten VP0 → Compiler-Warnung: "SetCamera requires SetViewport (no scroll buffer)"
- Danach läuft **exakt derselbe Code-Pfad** — kein `if/else`, kein separater Ast

**Label-Ergebnis:** Da `!_hasExplicitViewports`, emittiert T7 sowohl Legacy-Labels als auch
`_vp0_*`-Labels (Doppel-Label-Strategie). Alle bestehenden Fragments die Legacy-Label-Namen
referenzieren (`_gfx_copper_a`, `_gfx_cop_a_bpl_table`, `_gfx_planes_data` …) funktionieren
weiterhin ohne Änderung.

**`SetCamera` im impliziten VP0** ist eine Camera ohne Scroll-Puffer — definiertes Verhalten:
die Warnung erscheint, kein Code wird emittiert, Koordinaten bleiben 0.

#### T33 — editor-init.js: Syntax & Autocomplete

**Datei:** `app/src/editor-init.js`

- Neue Keywords in die Monaco-Tokenizer-Regeln eintragen:
  `SetViewport`, `Viewport`, `SetCamera`.
- Autocomplete-Snippets:
  ```
  SetViewport ${1:0}, ${2:0}, ${3:199}
  Viewport ${1:0}
  SetCamera ${1:x}, ${2:y}
  ```

#### T34 — Integrations-Tests

Drei Test-Programme erstellen:

1. **test_single_viewport.bassm** — Programm OHNE SetViewport (impliziter Viewport 0).
   Muss identisch funktionieren wie bisher (Regressions-Check). Prüft außerdem dass
   `SetCamera` im impliziten Viewport keine Wirkung hat (Scroll-Parameter bleiben 0).

2. **test_dual_viewport.bassm** — Zwei Viewports (Game 200px + HUD 56px).
   VP0: Cls + farbiger Box-Hintergrund + DrawBob.
   VP1: Cls + Text "HUD".
   Erwartung: HUD bleibt stabil, Bob nur in VP0 sichtbar.

3. **test_viewport_camera.bassm** — VP0 mit Tilemap + Kamera + Bobs.
   VP1 mit statischem HUD.
   Kamera-Scroll mit Tastatur, Bob folgt World-Position.
   Erwartung: Smooth Scrolling in VP0, stabiles HUD in VP1, Bobs korrekt positioniert.

---

## 5. Abhängigkeitsgraph

```
Phase 0 (T1-T3)
   │
   ▼
Phase 1 (T4-T7)  ←── Copper-Refactor
   │
   ├───► Phase 2 (T8-T10)  ←── Buffer + State
   │        │
   │        ▼
   │     Phase 3 (T11-T12) ←── Init
   │        │
   │        ▼
   ├───► Phase 4 (T13-T15) ←── Viewport Context
   │        │
   │        ▼
   └───► Phase 5 (T16-T17) ←── ScreenFlip
            │
            ├───► Phase 6 (T18-T20) ←── Camera
            │        │
            │        ▼
            ├───► Phase 7 (T21-T24) ←── Tilemap (hängt auch von Phase 6 ab)
            │
            ├───► Phase 8 (T25-T29) ←── Bobs
            │        │
            │        ▼
            └───► Phase 9 (T30-T31) ←── Fine-Kompensation
                     │
                     ▼
               Phase 10 (T32-T34) ←── Compat + Tests
```

**Kritischer Pfad:** T1 → T3 → T5 → T9 → T11 → T13 → T16 → T28 → T30 → T34

---

## 6. Offene Fragen & Risiken

### R1 — Chip-RAM-Verbrauch
Multi-Viewport braucht in V1 ~20–30% mehr Chip-RAM als Single-Screen (180 KB vs 154 KB
bei 5 Planes). **Mitigation in V2:** Per-VP Tiefe (z.B. 1-Plane-HUD) reduziert den
Gesamtverbrauch auf ~135 KB — sogar weniger als Single-Screen (→ Abschnitt 8).

### R2 — CopperColor (Raster-Effekte)
CopperColor ist in V1 inkompatibel mit Multi-Viewport (D9). Nachrüstung erfordert
per-VP Raster-Tabellen in der Copper-Section. Aufwand: mittel.

### R3 — SetBackground per Viewport
`SetBackground` muss im richtigen VP-Kontext aufgerufen werden. Der `_bg_bpl_ptr`
wird im Bob-State-Block des aktiven VPs gespeichert (nicht global).

### R4 — Color/Palette-Commands
`Color N, r, g, b` und `Palette` schreiben in die Copper-Sections des aktiven
Viewports (D8). Ohne aktiven Viewport-Kontext (Legacy) schreiben sie in alle Sections.
Da jeder VP eigene COLOR-Moves hat, sind per-VP Paletten automatisch möglich.
**Achtung V2:** Bei unterschiedlicher Tiefe hat VP0 (5 Planes) 32 Farben, VP1
(1 Plane) nur 2 Farben. `Color`-Befehle mit Index ≥ Farbanzahl des VP → Compiler-Fehler.

---

## 7. Zusammenfassung

| Phase | Tasks | Kern-Dateien | Komplexität |
|-------|-------|-------------|-------------|
| 0 API & Parser | T1–T3 | commands-map, parser, codegen | Niedrig |
| 1 Copper-Liste | T4–T7 | codegen | **Hoch** |
| 2 Buffer & State | T8–T10 | codegen | Mittel |
| 3 Initialisierung | T11–T12 | codegen | Mittel |
| 4 Viewport-Kontext | T13–T15 | codegen, cls.s | Mittel |
| 5 ScreenFlip | T16–T17 | codegen, flip.s | Mittel |
| 6 Camera | T18–T20 | codegen | Niedrig |
| 7 Tilemap | T21–T24 | tilemap.s, codegen | **Hoch** |
| 8 Bobs | T25–T29 | bobs.s, codegen | **Hoch** |
| 9 Fine-Kompensation | T30–T31 | bobs.s, tilemap.s | Mittel |
| 10 Compat & Tests | T32–T34 | codegen, editor-init | Niedrig |

---

## 8. V2 — Per-Viewport Tiefe (Taskskizze)

> **Voraussetzung:** V1 muss abgeschlossen und stabil sein.
> **Ziel:** Jeder Viewport kann eine eigene Bitplane-Tiefe haben.
> **Erweiterte Syntax:** `SetViewport index, y1, y2 [, depth]` — ohne depth → erbt von `Graphics`.
> **Kerngewinn:** 1-Plane-HUD (2 Farben) spart ~80% Chip-RAM gegenüber 5-Plane-HUD.

### Was sich ändert

| Aspekt | V1 (gleiche Tiefe) | V2 (per-VP Tiefe) |
|--------|-------------------|-------------------|
| BPLCON0 | gleich für alle VPs | per VP: `(depth << 12) \| 0x0200` |
| BPLxPT-Tabelle | D × 8 Bytes (gleich) | VP_N_DEPTH × 8 Bytes (variiert) |
| Palette-Größe | 2^D × 4 Bytes (gleich) | 2^VP_N_DEPTH × 4 Bytes (variiert) |
| VP_COP_BPL | Offset 28 (fix) | Offset 28 (fix — ändert sich nicht) |
| VP_COP_PAL | `28 + D*8` (fix) | `28 + VP_N_DEPTH*8` (**variiert pro VP**) |
| GFXIBPR | `GFXBPR × D` (global) | `GFXBPR × VP_N_DEPTH` (per VP) |
| GFXPLANEOFS | global | `GFXBORDER × VP_N_IBPR + GFXBORDER/8` (per VP) |
| GFXBPLMOD | global | `VP_N_IBPR - GFXDBPR` (per VP) |
| Buffer-Größe | `VHEIGHT × BPR × D` | `VHEIGHT × BPR × VP_N_DEPTH` |

### V2-Tasks (grobe Schätzung: 8–12 Tasks)

#### V2-T1 — SetViewport: Optionaler 4. Parameter `depth`

**Dateien:** `commands-map.json`, `parser.js`, `codegen.js`

- `SetViewport 1, 200, 255, 1` → VP1 mit 1 Bitplane.
- Ohne 4. Arg: erbt `GFXDEPTH` von `Graphics` (V1-kompatibel).
- Pre-Pass: `_viewports` Map erweitert um `depth` pro VP.

#### V2-T2 — Per-VP EQUs: VP_N_DEPTH, VP_N_IBPR, VP_N_PLANEOFS, VP_N_BPLMOD

**Datei:** `codegen.js`

```
VP_N_DEPTH    EQU <depth>
VP_N_IBPR     EQU (GFXBPR*VP_N_DEPTH)
VP_N_PLANEOFS EQU (GFXBORDER*VP_N_IBPR+GFXBORDER/8)
VP_N_BPLMOD   EQU (VP_N_IBPR-GFXDBPR)
VP_N_BUFSIZE  EQU (GFXBPR*VP_N_VHEIGHT*VP_N_DEPTH)
```

#### V2-T3 — Copper-Section: Variable BPL-Tabelle + Palette

**Datei:** `codegen.js`

- `_emitViewportCopSection(vpIdx)` emittiert `VP_N_DEPTH` BPLxPT-Paare statt `GFXDEPTH`.
- Palette: `2^VP_N_DEPTH` COLOR-Moves statt `2^GFXDEPTH`.
- `VP_COP_PAL` wird per-VP EQU: `VP_N_COP_PAL EQU (28 + VP_N_DEPTH * 8)`.
- `VP_COP_BPL` bleibt bei Offset 28 (stabil).

#### V2-T4 — Zeichenroutinen: Runtime IBPR + PLANEOFS

**Dateien:** `cls.s`, `box.s`, `text.s`, `plot.s`, `image.s`, `bobs.s`

Zwei Ansätze (Trade-off: Änderungsaufwand vs. Laufzeit-Overhead):

**Ansatz A — Runtime-Variablen:**
- Neue BSS-Vars: `_active_gfx_ibpr.w`, `_active_gfx_depth.w`, `_active_gfx_planeofs.l`
- `Viewport N` setzt diese auf VP_N_IBPR, VP_N_DEPTH, VP_N_PLANEOFS.
- Alle Fragments lesen `_active_gfx_ibpr` statt EQU `GFXIBPR`.
- Overhead: ~2–4 Zyklen pro `move.w _active_gfx_ibpr,dN` statt immediate.
- **Vorteil:** Minimal-invasiv — Fragments bleiben generisch.

**Ansatz B — Codegen-emittierte Immediate-Werte:**
- Codegen kennt den aktiven VP (T15) und emittiert VP-spezifische Konstanten.
- Fragments werden zu Makros oder Inline-Code statt JSR-Aufrufe.
- **Vorteil:** Zero Overhead. **Nachteil:** Erheblicher Umbau.

**Empfehlung: Ansatz A** — pragmatisch, überschaubarer Umbau, Overhead vernachlässigbar
(2–4 Zyklen bei Routinen die hunderte Zyklen kosten).

#### V2-T5 — _setup_graphics: Per-VP BPLxPT + BPLCON0

**Datei:** `codegen.js`

- `_PatchBitplanePtrs` erhält `VP_N_DEPTH` statt `GFXDEPTH`.
- BPLCON0 in jeder VP-Section: `(VP_N_DEPTH << 12) | 0x0200`.

#### V2-T6 — _DrawTilemap: Per-VP Modulo + BPLxPT

**Datei:** `tilemap.s`

- `GFXBPLMOD` → liest `_active_gfx_bplmod` (oder VP-spezifisches EQU).
- `_PatchBitplanePtrs` Stride: `GFXBPR` statt `GFXPSIZE` (bereits so bei interleaved).
- `_DrawImageFrame` muss mit variierender Tiefe umgehen können (Image-Header enthält
  eigene Tiefe — der Blit-Loop iteriert `image_depth` mal, nicht `GFXDEPTH`).

#### V2-T7 — Color/Palette: Tiefe-Check

**Datei:** `codegen.js`

- `Color N, r, g, b` im VP-Kontext: Compiler-Fehler wenn `N >= 2^VP_N_DEPTH`.
- `Palette`-Befehl: nur `2^VP_N_DEPTH` Farben in die VP-Section schreiben.

#### V2-T8 — Budget-Bars: Per-VP Chip-RAM

**Datei:** `app/src/budget.js`

- Chip-RAM-Schätzung: Summe aller VP-Buffers statt `2 × GFXBUFSIZE`.

### V2-Zusammenfassung

| Task | Aufwand | Kern-Änderung |
|------|---------|---------------|
| V2-T1 Parser | Niedrig | 4. Arg für SetViewport |
| V2-T2 EQUs | Niedrig | Per-VP Konstanten |
| V2-T3 Copper | Mittel | Variable Section-Größe |
| V2-T4 Zeichenroutinen | **Hoch** | 6+ Fragments auf Runtime-IBPR umstellen |
| V2-T5 Setup | Mittel | Per-VP PatchBitplanePtrs |
| V2-T6 Tilemap | Mittel | Variable Modulos |
| V2-T7 Color-Check | Niedrig | Compile-Time Validierung |
| V2-T8 Budget | Niedrig | Summenberechnung |

**Geschätzter Gesamtaufwand V2:** ~8–12 Tasks, Schwerpunkt auf V2-T4 (Fragment-Umbau).
