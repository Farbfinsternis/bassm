# `.tset` Implementierungsplan

Referenz: `tset-specs.md` (Spezifikation V1)

---

## Ist-Stand (nach TOOL-RESTRUCTURE)

Phase 1–4 des ursprünglichen Plans sind abgeschlossen. Die Implementierung
weicht vom alten Plan ab — es gibt keine `asset-manager.js`. Alle .tset-Logik
lebt im Tileset-Editor und im Compiler:

### .tset Binary Writer + Editor — DONE

| Was | Wo | Funktion |
|-----|----|----------|
| Header + Binary bauen | `app/src/tileset-editor.js` | `_tseBuildBinary()` |
| Planar-Konvertierung | `app/src/tileset-editor.js` | `_tseToPlanar()` |
| Save-Dialog (.tset) | `app/src/tileset-editor.js` | `_tseSave()` |
| Load + Parse (.tset) | `app/src/tileset-editor.js` | `_tseApplyBuffer()` |
| PNG-Import + Quantisierung | `app/src/tileset-editor.js` | `_tseImportPng()`, `_tseQuantise()` |
| Tile-Grid + Zoom/Pan | `app/src/tileset-editor.js` | `_tseRender()`, Wheel/MMB-Events |
| Budget-Anzeige (Chip KB + %) | `app/src/tileset-editor.js` | `_tseUpdateProps()` |
| Open from Project Tree | `app/src/tileset-editor.js` | `tseOpenFromTree()` |
| Back → Tilemap-Editor | `app/src/tileset-editor.js` | `_tseGetCurrentTilesetData()` |

### Compiler — DONE

| Was | Wo | Details |
|-----|----|---------|
| `LoadTileset` 2-Arg-Form | `app/src/commands-map.json` | `(slot, file)` — kein tileW/tileH |
| .tset-Header lesen (Compile-Zeit) | `app/src/bassm.js` | `setAssetHeaderReader()` → `readBinaryHeader` via preload |
| Collect: Header parsen + validieren | `app/src/codegen.js:3065` | Magic, Version, tileSize, depth, tileCount, flags |
| Emission: dc.w + INCBIN offset/len | `app/src/codegen.js:1498` | `SECTION DATA_C`, PALETTE + IMAGE separat |
| `_cmd_loadtileset`: Palette setzen | `app/src/codegen.js:2834` | Slot 0 → `_SetImagePalette` |

### Beispiel — DONE

`examples/viewport/test_viewport_camera.bassm` nutzt `LoadTileset 0, "images/tiles.tset"`.

---

## Phase 5: Tileset-Editor — TYPES

Ziel: User kann pro Tile einen Typ-Tag vergeben. Die TYPES-Section wird in die
.tset-Datei geschrieben.

- [x] **T5.1** UI: Typ-Eingabefeld im Property-Panel. Dropdown oder Nummer (0–255).
  Optionales Textfeld für Label (nur IDE-intern, wird nicht in .tset gespeichert).
  Datei: `app/src/tileset-editor.js`

- [x] **T5.2** Tile-Selektion: Klick auf Tile im Grid selektiert es, zeigt Index +
  aktuellen Typ im Property-Panel. Highlight-Rahmen auf selektiertem Tile.
  Datei: `app/src/tileset-editor.js`

- [x] **T5.3** Internes State-Array `_tseTileTypes = new Uint8Array(tile_count)`.
  Initialisierung mit 0. Aktualisierung bei Typ-Änderung. Bei `_tseApplyBuffer()`
  aus .tset laden wenn flags Bit 0 gesetzt.
  Datei: `app/src/tileset-editor.js`

- [x] **T5.4** `_tseBuildBinary()` erweitern: Wenn mindestens ein Typ ≠ 0,
  flags Bit 0 setzen und TYPES-Section anhängen (tile_count Bytes + Pad).
  Datei: `app/src/tileset-editor.js`

- [x] **T5.5** Codegen: Wenn .tset-Header flags Bit 0 gesetzt, TYPES-Label und
  INCBIN emittieren (`SECTION DATA`). Offset berechnen:
  `types_offset = 12 + palette_size + image_size`.
  Datei: `app/src/codegen.js` (Emission ~Zeile 1498, Collect ~Zeile 3065)

- [x] **T5.6** Codegen: BSS-Variable `_active_tileset_types: ds.l 1` emittieren
  (nur wenn TYPES-Section vorhanden). `SetTilemap` setzt den Pointer.
  Datei: `app/src/codegen.js`

---

## Phase 6: Tileset-Editor — COLLISION

Ziel: User kann pro Tile Kollisions-Flags setzen. Die COLLISION-Section wird in
die .tset-Datei geschrieben.

- [x] **T6.1** UI: Checkbox-Gruppe im Property-Panel für SOLID, PASS_UP,
  PASS_DOWN, PASS_LEFT, PASS_RIGHT, SLOPE. Visuelle Deaktivierung der PASS-Bits
  wenn SOLID aktiv.
  Datei: `app/src/tileset-editor.js`

- [x] **T6.2** Internes State-Array `_tseTileColl = new Uint8Array(tile_count)`.
  Bit-Manipulation bei Checkbox-Änderung. Bei `_tseApplyBuffer()` aus .tset laden
  wenn flags Bit 1 gesetzt.
  Datei: `app/src/tileset-editor.js`

- [x] **T6.3** `_tseBuildBinary()` erweitern: Wenn mindestens ein Collision-Flag ≠ 0,
  flags Bit 1 setzen und COLLISION-Section anhängen.
  Datei: `app/src/tileset-editor.js`

- [x] **T6.4** Codegen: Wenn .tset-Header flags Bit 1 gesetzt, COLLISION-Label
  und INCBIN emittieren. Offset berechnen:
  `coll_offset = types_offset + (has_types ? align(tile_count) : 0)`.
  Datei: `app/src/codegen.js`

- [x] **T6.5** Codegen: BSS-Variable `_active_tileset_coll: ds.l 1` emittieren.
  `SetTilemap` setzt den Pointer.
  Datei: `app/src/codegen.js`

- [x] **T6.6** Tile-Grid Overlay: Selektierte Collision-Flags als farbige
  Overlay-Icons auf den Tiles im Editor anzeigen (S=Solid, Pfeile für PASS,
  Schraffur für SLOPE).
  Datei: `app/src/tileset-editor.js`

---

## Phase 7: Runtime — Tile-Eigenschafts-Abfragen

Ziel: Neue BASSM-Befehle `GetTileType()` und `GetTileColl()` für den Zugriff
auf Tile-Eigenschaften zur Laufzeit.

- [x] **T7.1** Builtin-Handler registrieren: `gettiletype` und `gettilecoll`
  in `_initBuiltinHandlers()`. (Funktionen mit Rückgabewert sind Builtins,
  nicht commands-map.json — commands-map ist nur für void-Commands.)
  Datei: `app/src/codegen.js`

- [x] **T7.2** Codegen `_builtin_gettiletype`: Inline-Codegen via shared
  `_builtin_tilequery()`. World (x,y) → `divu` col/row → Map-Lookup →
  TYPES-LUT-Byte → d0. Kein Fragment nötig.
  Datei: `app/src/codegen.js`

- [x] **T7.3** Codegen `_builtin_gettilecoll`: Analog zu T7.2 via shared
  `_builtin_tilequery()`, aber auf `_active_tileset_coll`.
  Datei: `app/src/codegen.js`

- [x] **T7.4** ~~Fragment~~ → Entscheidung: Inline mit shared Codegen-Helper
  `_builtin_tilequery(expr, lines, lutVar, fnName)`. Kein Fragment nötig —
  der Helper emittiert identischen ASM für beide Builtins, nur LUT-Pointer
  unterscheidet sich. Signatur: `GetTileType(x, y)` / `GetTileColl(x, y)`
  ohne Slot-Argument (nutzt `_active_tilemap_ptr` + `_active_tileset_*`).

- [ ] **T7.5** Test: BASSM-Programm das Tile-Typen abfragt und Ergebnis
  auf Screen anzeigt (z.B. `Print GetTileType(0, playerX, playerY)`).

---

## Phase 8: Runtime — ChangeTile

Ziel: BASSM-Befehl `ChangeTile(slot, x, y, newIndex)` zum Ändern von Tiles
zur Laufzeit.

- [x] **T8.1** `commands-map.json`: `ChangeTile x, y, newIndex` definieren (kein
  Slot — nutzt `_active_tilemap_ptr` von SetTilemap). Command-Handler in
  `_initCmdHandlers()` registriert.
  Dateien: `app/src/commands-map.json`, `app/src/codegen.js`

- [x] **T8.2** Codegen `_cmd_changetile`: Map-Array-Eintrag überschreiben.
  `x / tile_w → col`, `y / tile_h → row`, `map_data[row * map_w + col] = newIndex`.
  Schreibzugriff: `move.w d2,8(a0,d1.l)`.
  Datei: `app/src/codegen.js`

- [x] **T8.3** Entscheidung: **Kein sofortiger Blit.** Das geänderte Tile wird beim
  nächsten `DrawTilemap` sichtbar. Begründung: Phase 1 zeichnet ohnehin alle
  sichtbaren Tiles neu — ein Einzel-Blit wäre verschwendet und müsste fine_x/y,
  Copper-State und Back-Buffer-Pointer kennen. `_bg_restore_tilemap` liest
  ebenfalls aus `_active_tilemap_ptr` und ist damit automatisch konsistent.
  **Achtung:** Wenn PERF-J (Screen-to-Screen Blit) implementiert wird, braucht
  `ChangeTile` eine Dirty-Tile-Liste → siehe `perf-plan.md` T19.

---

## Phase 9: Tileset-Editor — ANIMATION

Ziel: User kann Animations-Gruppen definieren. Die ANIMATION-Section wird in die
.tset-Datei geschrieben.

- [x] **T9.1** UI: "Animations"-Panel im Editor. Button "Neue Gruppe".
  Pro Gruppe: Start-Tile (Klick auf Grid), Frame-Count (Spinner), Speed (Spinner).
  Vorschau: animierte Tile-Anzeige im Panel.
  Datei: `app/src/tileset-editor.js`

- [x] **T9.2** Internes State-Array `_tseAnimGroups = []`, jedes Element:
  `{ startIndex, frameCount, speed }`. Validierung: Frames müssen konsekutiv
  und innerhalb tile_count liegen.
  Datei: `app/src/tileset-editor.js`

- [x] **T9.3** `_tseBuildBinary()` erweitern: Wenn _tseAnimGroups.length > 0,
  flags Bit 2 setzen und ANIMATION-Section anhängen (2 + groups × 4 Bytes).
  Bei `_tseApplyBuffer()` aus .tset laden wenn flags Bit 2 gesetzt.
  Datei: `app/src/tileset-editor.js`

- [x] **T9.4** Codegen: Wenn flags Bit 2 gesetzt, ANIMATION-Label + INCBIN emittieren.
  BSS-Variable `_active_tileset_anim: ds.l 1`. Offset berechnen.
  Datei: `app/src/codegen.js`

- [x] **T9.5** Runtime-Architektur entschieden: **Option A (LUT)**.
  Substitutions-LUT (`tile_remap[tile_count]`, 2 Bytes/Tile),
  aktualisiert pro VBlank. O(1) pro Tile beim Rendern.

- [x] **T9.6** Runtime: Animations-Tick implementieren. Pro Gruppe:
  frame_counter inkrementieren, bei Überlauf wraparound. Remap-LUT patchen.
  Datei: `app/src/m68k/fragments/tilemap.s` oder neues Fragment

- [x] **T9.7** DrawTilemap + _bg_restore_tilemap: Tile-Index durch
  `tile_remap[index]` ersetzen. `_tile_remap` BSS wird immer emittiert
  (nicht nur bei Animationen), `SetTilemap` initialisiert identity-Remap.
  `_DrawTilemap` nutzt a1 als Remap-Base, `_bg_restore_tilemap` nutzt a4.
  Dateien: `app/src/m68k/fragments/tilemap.s`, `app/src/codegen.js`

---

## Phase 10: Tileset-Editor — SLOPES

Ziel: User kann Heightmaps für Slope-Tiles zeichnen. Die SLOPES-Section wird
in die .tset-Datei geschrieben.

- [x] **T10.1** Voraussetzung: Tile muss SLOPE-Flag in COLLISION haben (Phase 6).
  UI: `#tse-slope-section` (Canvas + Titel) wird per `_tseUpdateCollUI()` nur
  angezeigt wenn Bit 5 (SLOPE) im Collision-Byte gesetzt ist.
  Dateien: `app/index.html`, `app/style.css`, `app/src/tileset-editor.js`

- [x] **T10.2** Heightmap-Editor: `_tseSlopeRender()` zeichnet Tile 8× vergrößert
  mit Spalten-Grid und gelber Heightmap-Linie + Ground-Fill. Klick/Drag auf
  Canvas setzt Spaltenhöhe (0=unten, tileSize=oben) via `_tseSlopeSetColumn()`.
  State in `_tseSlopeData` Map (tileIdx → Uint8Array). Reset bei Import/Load.
  Datei: `app/src/tileset-editor.js`

- [x] **T10.3** State `_tseSlopeData` (Map, T10.2 angelegt). Laden in
  `_tseApplyBuffer()`: flags Bit 3 → slope_count + entries parsen
  (2 + tile_idx + heightmap pro Entry). Cleanup: SLOPE-Checkbox unchecked →
  `_tseSlopeData.delete()`. Reset bei Import/Load (T10.2).
  Datei: `app/src/tileset-editor.js`

- [x] **T10.4** `_tseBuildBinary()`: flags Bit 3, SLOPES-Section anhängen.
  Gefiltert auf Tiles mit SLOPE-Bit (belt-and-suspenders zu T10.3 Cleanup).
  Format: slope_count(w) + entries × (tile_index(w) + heightmap(tile_size B)).
  Datei: `app/src/tileset-editor.js`

- [x] **T10.5** Codegen: flags Bit 3 → Collect: `_readAssetHeader` für slope_count,
  Offset/Size berechnen. Emission: `SECTION DATA`, XDEF + INCBIN.
  BSS: `_active_tileset_slopes: ds.l 1`. SetTilemap: Pointer setzen.
  Datei: `app/src/codegen.js`

---

## Phase 11: Runtime — Collide and Slide

Ziel: Subroutine für Slope-Kollision. BASSM-Befehl oder automatische Integration
in die Tile-Kollisionsprüfung.

- [x] **T11.1** Slope-Lookup-Subroutine: Eingabe: tile_index + rel_x.
  Slope-Eintrag im SLOPES-Array finden (linearer Scan oder Index-Tabelle).
  Heightmap-Byte lesen.
  Datei: `app/src/m68k/fragments/tilemap.s` oder `tileprops.s`

- [x] **T11.2** Collide-and-Slide-Algorithmus: Spielerposition korrigieren.
  1. Foot-Position → Tile bestimmen
  2. Collision-Flag prüfen (SLOPE?)
  3. rel_x = foot_x AND (tile_size-1)
  4. surface_y = tile_bottom - heightmap[rel_x]
  5. Wenn foot_y > surface_y → snap foot_y = surface_y (Slide)
  6. Horizontale Bewegung bleibt erhalten
  Datei: `app/src/m68k/fragments/tilemap.s`

- [x] **T11.3** Entscheidung: **Eigener Builtin `CollideTile(x, y)`**.
  Gibt korrigiertes y zurück (surface_y bei Slope-Snap, sonst y unverändert).
  Builtin-Funktion (Rückgabewert d0), nicht void-Command. Kollisions-Erkennung
  durch Vergleich mit Original-y: `If CollideTile(px, py) <> py`.
  Inline-Codegen: Argumente evaluieren → `jsr _CollideSlope` → `move.l d1,d0`.
  Datei: `app/src/codegen.js` (`_initBuiltinHandlers`, `_builtin_collidetile`)

- [ ] **T11.4** Test: Platformer-Testprogramm mit Rampen. Spieler läuft über
  Slopes, gleitet hoch/runter ohne zu stoppen oder durchzufallen.

---

## Phase 12: Tilemap-Editor Integration

Ziel: Der Tilemap-Editor nutzt .tset-Dateien als Tile-Palette und zeigt
Eigenschaften als Overlay an.

- [x] **T12.1** .tset als Palette-Quelle: Tilemap-Editor lädt .tset,
  zeigt Tiles in der Palette an (statt manueller PNG-Konfiguration).
  Bereits durch TOOL-RESTRUCTURE implementiert: `_tmapParseTset()`,
  `_tmapLoadTsetDialog()`, `_tmapApplyTileset()`, `_tmapRenderTilePalette()`.
  Datei: `app/src/tilemap-editor.js`

- [x] **T12.2** Tile-Overlay im Map-Canvas: Collision-Flags als halbtransparentes
  Overlay auf den platzierten Tiles anzeigen (Solid=rot, PASS=Pfeile, Slope=gelb).
  `_tmapParseTset()` erweitert (COLLISION-Section), `_tmapDrawArrow()`,
  Overlay-Pass in `_tmapRenderMap()`, Checkbox "Show Collision" im Sidebar.
  Dateien: `app/src/tilemap-editor.js`, `app/index.html`

- [x] **T12.3** Tile-Info auf Hover: Tooltip zeigt Tile-Index, Typ-Name,
  Collision-Flags, Animation-Zugehörigkeit. `_tmapParseTset()` erweitert
  (TYPES + ANIMATION), `_tmapBuildTooltip()`, `_tmapShowTooltip()` in
  mousemove, `#tmap-tooltip` div + CSS.
  Dateien: `app/src/tilemap-editor.js`, `app/index.html`, `app/style.css`

- [x] **T12.4** .bmap-Export: Map-Grid als .bmap speichern (bestehende Logik
  aus tilemap-editor.js, Tile-Size kommt jetzt aus der geladenen .tset).
  Fix: `_tmapApplyTileset()` synchronisiert `_tmapTileW/H` auf `tset.tileSize`,
  aktualisiert Dropdowns, disabled Tile-Size-Selektoren (Tileset ist autoritativ).
  Datei: `app/src/tilemap-editor.js`

---

## Abhängigkeiten

```
Phase 5 (TYPES) ──────→ Phase 7 (GetTileType/GetTileColl)
    │                       │
    │                       ↓
Phase 6 (COLLISION) ──→ Phase 7 ──→ Phase 8 (ChangeTile)
    │
    └──→ Phase 10 (SLOPES) ──→ Phase 11 (Collide & Slide)

Phase 9 (ANIMATION) ──→ eigenständig (nur Tileset-Editor + Codegen + Runtime)

Phase 12 (Tilemap-Editor) ──→ benötigt Phase 5 + 6
```

Phase 5 + 6 sind Voraussetzung für die meisten Runtime-Features.
Phase 9 (Animation) und Phase 10 (Slopes) sind unabhängig voneinander.
Phase 12 (Tilemap-Editor Integration) profitiert von allen Editor-Phasen,
kann aber inkrementell umgesetzt werden.
