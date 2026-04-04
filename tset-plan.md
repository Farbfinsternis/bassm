# `.tset` Implementierungsplan

Referenz: `tset-specs.md` (Spezifikation V1)

---

## Phase 1: .tset Binary Writer (asset-manager.js)

Ziel: Der bestehende Asset-Manager erzeugt `.tset` statt `.iraw` für Tilesets.
Zunächst nur Header + PALETTE + IMAGE (flags=0, keine Metadaten-Sections).

- [x] **T1.1** `buildTsetBinary(palette, imageData, tileSize, tileCount, depth)` erstellen.
  Baut den 12-Byte-Header (magic "TSET", version 1, tile_size, tile_count,
  depth, flags=0, reserved=0), hängt PALETTE und IMAGE an.
  Datei: `app/src/asset-manager.js`

- [x] **T1.2** `onConvertAndSaveTileset()` anpassen: Ruft `buildTsetBinary()` statt
  der bisherigen Logik auf. Palette-Extraktion bleibt gleich (quantisierte OCS-Werte
  liegen bereits vor), Bilddaten kommen aus `toPlanarBitmapInterleaved()`.
  Datei: `app/src/asset-manager.js` (ca. Zeile 572–616)

- [x] **T1.3** Dateiendung im Save-Dialog von `.iraw` auf `.tset` ändern.
  Filter: `{ name: 'BASSM Tileset', extensions: ['tset'] }`.
  Datei: `app/src/asset-manager.js` (ca. Zeile 603)

- [x] **T1.4** `onCopyTilesetCode()` anpassen: 2-Argument-Form generieren.
  Alt: `LoadTileset 0, "${name}", ${tileW}, ${tileH}`
  Neu: `LoadTileset 0, "${name}"`
  Datei: `app/src/asset-manager.js` (ca. Zeile 618–627)

- [ ] **T1.5** Manueller Test: PNG importieren → "Convert & Save" → `.tset`-Datei
  erzeugen → Hex-Dump prüfen (Magic, Header-Felder, Palette, Image-Offset).

---

## Phase 2: Compiler — LoadTileset mit .tset

Ziel: `codegen.js` liest den .tset-Header zur Compile-Zeit und emittiert
korrektes Assembly mit INCBIN-Offset/Länge.

- [x] **T2.1** `commands-map.json` aktualisieren: `LoadTileset` von 4 auf 2 Argumente
  ändern (slot, file). `tileW`/`tileH`-Parameter entfernen.
  Datei: `app/src/commands-map.json` (Zeile 548–571)

- [x] **T2.2** Datei-Lese-API für Codegen bereitstellen. `codegen.js` braucht Zugriff
  auf die ersten 12 Bytes einer `.tset`-Datei zur Compile-Zeit. Optionen:
  (a) `readFileSync` über `preload.js`-Bridge, oder
  (b) Asset-Dateien werden vor Codegen-Start gelesen und als Map übergeben.
  Dateien: `app/preload.js`, `app/src/codegen.js`, ggf. `app/src/bassm.js`

- [x] **T2.3** Collect-Handler `loadtileset` anpassen: .tset-Header lesen statt
  tileW/tileH aus Source-Argumenten. `_tilesetAssets`-Map erweitern um:
  `tile_count`, `depth`, `flags`, `palette_size`, `image_size` und Section-Offsets.
  Datei: `app/src/codegen.js` (ca. Zeile 3059–3079)

- [x] **T2.4** Asset-Emission anpassen: Synthetischen dc.w-Header emittieren,
  dann PALETTE und IMAGE als separate INCBIN mit Offset+Länge.
  Alt: `INCBIN "${filename}"` (gesamte .iraw)
  Neu: `INCBIN "${filename}",${palOffset},${palSize}` +
       `INCBIN "${filename}",${imgOffset},${imgSize}`
  Datei: `app/src/codegen.js` (ca. Zeile 1493–1501)

- [x] **T2.5** `_cmd_loadtileset` prüfen: `_SetImagePalette`-Aufruf bleibt
  unverändert — das Memory-Layout (Header → Palette → Image) ist identisch.
  Nur sicherstellen, dass der emittierte dc.w-Header `depth` aus dem .tset
  verwendet, nicht hart `GFXDEPTH`.
  Datei: `app/src/codegen.js` (ca. Zeile 2828–2836)

- [x] **T2.6** Compile-Zeit-Validierung: Magic-Check ("TSET"), Version (1),
  tile_size ∈ {8,16,32}, depth ∈ {1..5}, tile_count > 0. Klare Fehlermeldung
  bei ungültiger .tset-Datei.
  Datei: `app/src/codegen.js`

- [ ] **T2.7** End-to-End-Test: BASSM-Programm mit `LoadTileset 0, "tiles.tset"` +
  `DrawTilemap` compilieren → vasmm68k_mot → vlink → vAmiga Preview.
  Erwartung: Identisches Ergebnis wie bisher mit .iraw.

---

## Phase 3: Migration & Beispiele

Ziel: Bestehende Beispiele auf .tset umstellen, alte .iraw-Tileset-Referenzen entfernen.

- [x] **T3.1** Konvertierungs-Hilfsfunktion `irawToTset(irawBuffer, tileSize, depth)`
  erstellen. Liest bestehende .iraw (Palette + Image), schreibt .tset.
  Datei: `app/src/asset-manager.js`

- [ ] **T3.2** Beispiel-Tileset `examples/viewport/images/tiles.iraw` nach `.tset`
  konvertieren.

- [x] **T3.3** `examples/viewport/test_viewport_camera.bassm` aktualisieren:
  `LoadTileset 0, "images/tiles.tset"` (2 Argumente).

- [x] **T3.4** ~~Übersprungen~~ — Keine externen Nutzer; Examples werden bald ersetzt.

- [x] **T3.5** ~~Übersprungen~~ — .tset ist exklusiv; keine Backward-Compat nötig.

---

## Phase 4: Tileset-Editor — Grundgerüst

Ziel: Neuer Editor-Tab in der IDE. PNG importieren, Tiles im Grid anzeigen,
.tset speichern (noch ohne Metadaten-Sections).

- [x] **T4.1** Neuen Editor-View erstellen: HTML-Struktur mit Canvas (Tile-Grid),
  Seitenleiste (Toolbar + Properties), Import-Button.
  Dateien: `app/index.html` oder neues HTML-Partial

- [x] **T4.2** CSS-Layout: Canvas mit Zoom/Pan, Tile-Palette-Panel, Property-Panel.
  Datei: `app/style.css`

- [x] **T4.3** PNG-Import: Datei laden → auf Canvas zeichnen → in tile_size-Blöcke
  zerlegen → Tile-Array aufbauen. Tile-Größe wählbar (8/16/32).
  Datei: `app/src/tileset-editor.js` (neues Modul)

- [x] **T4.4** Tile-Grid-Rendering: Alle Tiles nummeriert auf Canvas anzeigen.
  Hover zeigt Tile-Index. Klick selektiert Tile für Property-Editing.
  Datei: `app/src/tileset-editor.js`

- [x] **T4.5** Depth-Auswahl (1–5 Bitplanes) und Farbquantisierung: Bestehende
  Quantisierungs-Logik aus asset-manager.js wiederverwenden.
  Datei: `app/src/tileset-editor.js`

- [x] **T4.6** "Save .tset"-Button: Ruft `buildTsetBinary()` (aus Phase 1) auf,
  speichert via `window.assetAPI.saveAssetWithDialog()`.
  Datei: `app/src/tileset-editor.js`

- [x] **T4.7** "Load .tset"-Button: Bestehende .tset-Datei öffnen, Header parsen,
  Palette + Image anzeigen, Metadaten laden (falls vorhanden).
  Datei: `app/src/tileset-editor.js`

- [x] **T4.8** Budget-Anzeige: Geschätzte Chip-RAM-Belegung berechnen und
  anzeigen (palette_size + image_size). Warnung bei > 50% von 512 KB.
  Datei: `app/src/tileset-editor.js`

---

## Phase 5: Tileset-Editor — TYPES

Ziel: User kann pro Tile einen Typ-Tag vergeben. Die TYPES-Section wird in die
.tset-Datei geschrieben.

- [ ] **T5.1** UI: Typ-Eingabefeld im Property-Panel. Dropdown oder Nummer (0–255).
  Optionales Textfeld für Label (nur IDE-intern, wird nicht in .tset gespeichert).
  Datei: `app/src/tileset-editor.js`

- [ ] **T5.2** Internes State-Array `tileTypes = new Uint8Array(tile_count)`.
  Initialisierung mit 0. Aktualisierung bei Typ-Änderung.
  Datei: `app/src/tileset-editor.js`

- [ ] **T5.3** `buildTsetBinary()` erweitern: Wenn mindestens ein Typ ≠ 0,
  flags Bit 0 setzen und TYPES-Section anhängen (tile_count Bytes + Pad).
  Datei: `app/src/asset-manager.js`

- [ ] **T5.4** Codegen: Wenn .tset-Header flags Bit 0 gesetzt, TYPES-Label und
  INCBIN emittieren (`SECTION DATA`). Offset berechnen:
  `types_offset = 12 + palette_size + image_size`.
  Datei: `app/src/codegen.js`

- [ ] **T5.5** Codegen: BSS-Variable `_active_tileset_types: ds.l 1` emittieren
  (nur wenn TYPES-Section vorhanden). `SetTilemap` setzt den Pointer.
  Datei: `app/src/codegen.js`

---

## Phase 6: Tileset-Editor — COLLISION

Ziel: User kann pro Tile Kollisions-Flags setzen. Die COLLISION-Section wird in
die .tset-Datei geschrieben.

- [ ] **T6.1** UI: Checkbox-Gruppe im Property-Panel für SOLID, PASS_UP,
  PASS_DOWN, PASS_LEFT, PASS_RIGHT, SLOPE. Visuelle Deaktivierung der PASS-Bits
  wenn SOLID aktiv.
  Datei: `app/src/tileset-editor.js`

- [ ] **T6.2** Internes State-Array `tileColl = new Uint8Array(tile_count)`.
  Bit-Manipulation bei Checkbox-Änderung.
  Datei: `app/src/tileset-editor.js`

- [ ] **T6.3** `buildTsetBinary()` erweitern: Wenn mindestens ein Collision-Flag ≠ 0,
  flags Bit 1 setzen und COLLISION-Section anhängen.
  Datei: `app/src/asset-manager.js`

- [ ] **T6.4** Codegen: Wenn .tset-Header flags Bit 1 gesetzt, COLLISION-Label
  und INCBIN emittieren. Offset berechnen:
  `coll_offset = types_offset + (has_types ? align(tile_count) : 0)`.
  Datei: `app/src/codegen.js`

- [ ] **T6.5** Codegen: BSS-Variable `_active_tileset_coll: ds.l 1` emittieren.
  `SetTilemap` setzt den Pointer.
  Datei: `app/src/codegen.js`

- [ ] **T6.6** Tile-Grid Overlay: Selektierte Collision-Flags als farbige
  Overlay-Icons auf den Tiles im Editor anzeigen (S=Solid, Pfeile für PASS,
  Schraffur für SLOPE).
  Datei: `app/src/tileset-editor.js`

---

## Phase 7: Runtime — Tile-Eigenschafts-Abfragen

Ziel: Neue BASSM-Befehle `GetTileType()` und `GetTileColl()` für den Zugriff
auf Tile-Eigenschaften zur Laufzeit.

- [ ] **T7.1** `commands-map.json`: Neue Befehle definieren.
  `GetTileType(slot, x, y)` → gibt Typ-Byte zurück.
  `GetTileColl(slot, x, y)` → gibt Collision-Byte zurück.
  Datei: `app/src/commands-map.json`

- [ ] **T7.2** Codegen `_cmd_gettiletype`: Inline-Codegen (kein Fragment nötig).
  1. Tile-Index aus Map lesen: `scrollX+x` / tile_w → col, `scrollY+y` / tile_h → row,
     map_data[row * map_w + col] → tile_index.
  2. TYPES-LUT lesen: `move.b 0(types_ptr, tile_index.w), result`.
  3. Ergebnis in d0 oder User-Variable.
  Datei: `app/src/codegen.js`

- [ ] **T7.3** Codegen `_cmd_gettilecoll`: Analog zu T7.2, aber auf COLLISION-LUT.
  Datei: `app/src/codegen.js`

- [ ] **T7.4** Alternative: Subroutinen `_GetTileAtPos(d0=x, d1=y) → d0=tile_index`
  als Fragment (vermeidet Code-Duplikation zwischen GetTileType/GetTileColl).
  Entscheidung: Inline vs. Fragment basierend auf Code-Größe.
  Datei: `app/src/m68k/fragments/tilemap.s` oder neues `tileprops.s`

- [ ] **T7.5** Test: BASSM-Programm das Tile-Typen abfragt und Ergebnis
  auf Screen anzeigt (z.B. `Print GetTileType(0, playerX, playerY)`).

---

## Phase 8: Runtime — ChangeTile

Ziel: BASSM-Befehl `ChangeTile(slot, x, y, newIndex)` zum Ändern von Tiles
zur Laufzeit.

- [ ] **T8.1** `commands-map.json`: `ChangeTile(slot, x, y, newIndex)` definieren.
  Datei: `app/src/commands-map.json`

- [ ] **T8.2** Codegen `_cmd_changetile`: Map-Array-Eintrag überschreiben.
  `x / tile_w → col`, `y / tile_h → row`, `map_data[row * map_w + col] = newIndex`.
  Schreibzugriff: `move.w newIndex, 0(map_base, offset.l)`.
  Datei: `app/src/codegen.js`

- [ ] **T8.3** Optionaler visueller Update: Wenn das geänderte Tile im sichtbaren
  Viewport liegt, ein einzelnes Tile-Blit in den Back-Buffer auslösen.
  Entscheidung: automatisch vs. "wird beim nächsten DrawTilemap sichtbar".
  Datei: `app/src/codegen.js`, ggf. `tilemap.s`

---

## Phase 9: Tileset-Editor — ANIMATION

Ziel: User kann Animations-Gruppen definieren. Die ANIMATION-Section wird in die
.tset-Datei geschrieben.

- [ ] **T9.1** UI: "Animations"-Panel im Editor. Button "Neue Gruppe".
  Pro Gruppe: Start-Tile (Klick auf Grid), Frame-Count (Spinner), Speed (Spinner).
  Vorschau: animierte Tile-Anzeige im Panel.
  Datei: `app/src/tileset-editor.js`

- [ ] **T9.2** Internes State-Array `animGroups = []`, jedes Element:
  `{ startIndex, frameCount, speed }`. Validierung: Frames müssen konsekutiv
  und innerhalb tile_count liegen.
  Datei: `app/src/tileset-editor.js`

- [ ] **T9.3** `buildTsetBinary()` erweitern: Wenn animGroups.length > 0,
  flags Bit 2 setzen und ANIMATION-Section anhängen (2 + groups × 4 Bytes).
  Datei: `app/src/asset-manager.js`

- [ ] **T9.4** Codegen: Wenn flags Bit 2 gesetzt, ANIMATION-Label + INCBIN emittieren.
  BSS-Variable `_active_tileset_anim: ds.l 1`. Offset berechnen.
  Datei: `app/src/codegen.js`

- [ ] **T9.5** Runtime-Architektur entscheiden: Wie werden animierte Tiles
  zur Laufzeit substituiert?
  Option A: Substitutions-LUT (`tile_remap[tile_count]`, 2 Bytes/Tile),
  aktualisiert pro VBlank.
  Option B: DrawTilemap prüft pro Tile inline gegen Animations-Gruppen.
  Empfehlung: Option A (LUT), da O(1) pro Tile beim Rendern.

- [ ] **T9.6** Runtime: Animations-Tick implementieren. Pro Gruppe:
  frame_counter inkrementieren, bei Überlauf wraparound. Remap-LUT patchen.
  Datei: `app/src/m68k/fragments/tilemap.s` oder neues Fragment

- [ ] **T9.7** DrawTilemap anpassen: Vor _DrawImageFrame den Tile-Index durch
  `tile_remap[index]` ersetzen (`move.w 0(remap_base, d2.w*2), d2`).
  Datei: `app/src/m68k/fragments/tilemap.s`

---

## Phase 10: Tileset-Editor — SLOPES

Ziel: User kann Heightmaps für Slope-Tiles zeichnen. Die SLOPES-Section wird
in die .tset-Datei geschrieben.

- [ ] **T10.1** Voraussetzung: Tile muss SLOPE-Flag in COLLISION haben (Phase 6).
  UI zeigt Heightmap-Editor nur wenn SLOPE-Flag gesetzt.
  Datei: `app/src/tileset-editor.js`

- [ ] **T10.2** Heightmap-Editor: Canvas zeigt das Tile vergrößert (z.B. 8×).
  User zeichnet die Bodenlinie durch Klick/Drag auf die Pixel-Spalten.
  Höhe pro Spalte = Mausposition (0 = unten, tile_size = oben).
  Datei: `app/src/tileset-editor.js`

- [ ] **T10.3** Internes State: `slopeData = new Map()`, Key = tile_index,
  Value = `Uint8Array(tile_size)`. Nur für Tiles mit SLOPE-Flag.
  Datei: `app/src/tileset-editor.js`

- [ ] **T10.4** `buildTsetBinary()` erweitern: Wenn slopeData.size > 0,
  flags Bit 3 setzen und SLOPES-Section anhängen
  (2 + entries × (2 + tile_size) Bytes).
  Datei: `app/src/asset-manager.js`

- [ ] **T10.5** Codegen: Wenn flags Bit 3 gesetzt, SLOPES-Label + INCBIN emittieren.
  BSS-Variable `_active_tileset_slopes: ds.l 1`. Offset berechnen.
  Datei: `app/src/codegen.js`

---

## Phase 11: Runtime — Collide and Slide

Ziel: Subroutine für Slope-Kollision. BASSM-Befehl oder automatische Integration
in die Tile-Kollisionsprüfung.

- [ ] **T11.1** Slope-Lookup-Subroutine: Eingabe: tile_index + rel_x.
  Slope-Eintrag im SLOPES-Array finden (linearer Scan oder Index-Tabelle).
  Heightmap-Byte lesen.
  Datei: `app/src/m68k/fragments/tilemap.s` oder `tileprops.s`

- [ ] **T11.2** Collide-and-Slide-Algorithmus: Spielerposition korrigieren.
  1. Foot-Position → Tile bestimmen
  2. Collision-Flag prüfen (SLOPE?)
  3. rel_x = foot_x AND (tile_size-1)
  4. surface_y = tile_bottom - heightmap[rel_x]
  5. Wenn foot_y > surface_y → snap foot_y = surface_y (Slide)
  6. Horizontale Bewegung bleibt erhalten
  Datei: `app/src/m68k/fragments/tilemap.s`

- [ ] **T11.3** BASSM-Befehl entscheiden: Eigener Befehl (`CollideTile`)?
  Oder automatisch in eine erweiterte `GetTileColl`-Variante integriert?
  Abwägung: Explizit vs. implizit (BASSM-Philosophie: kein verstecktes Verhalten).

- [ ] **T11.4** Test: Platformer-Testprogramm mit Rampen. Spieler läuft über
  Slopes, gleitet hoch/runter ohne zu stoppen oder durchzufallen.

---

## Phase 12: Tilemap-Editor Integration

Ziel: Der Tilemap-Editor nutzt .tset-Dateien als Tile-Palette und zeigt
Eigenschaften als Overlay an.

- [ ] **T12.1** .tset als Palette-Quelle: Tilemap-Editor lädt .tset,
  zeigt Tiles in der Palette an (statt manueller PNG-Konfiguration).
  Datei: Tilemap-Editor-Modul

- [ ] **T12.2** Tile-Overlay im Map-Canvas: Collision-Flags als halbtransparentes
  Overlay auf den platzierten Tiles anzeigen (Solid=rot, PASS=Pfeile, Slope=gelb).
  Datei: Tilemap-Editor-Modul

- [ ] **T12.3** Tile-Info auf Hover: Tooltip zeigt Tile-Index, Typ-Name,
  Collision-Flags, Animation-Zugehörigkeit.
  Datei: Tilemap-Editor-Modul

- [ ] **T12.4** .bmap-Export: Map-Grid als .bmap speichern (bestehende Logik
  aus asset-manager.js, Tile-Size kommt jetzt aus der geladenen .tset).
  Datei: Tilemap-Editor-Modul

---

## Abhängigkeiten

```
Phase 1 ──→ Phase 2 ──→ Phase 3
                │
                ↓
             Phase 4 ──→ Phase 5 ──→ Phase 7
                │           │
                │           ↓
                ├──→ Phase 6 ──→ Phase 7
                │                  │
                │                  ↓
                │               Phase 8
                │
                ├──→ Phase 9
                │
                ├──→ Phase 10 ──→ Phase 11
                │
                └──→ Phase 12 (benötigt Phase 5 + 6)
```

Phase 1–3 bilden den kritischen Pfad: Ohne funktionierendes .tset-Format und
Compiler-Support kann kein Editor-Feature getestet werden.

Phase 4 (Editor-Grundgerüst) ist Voraussetzung für alle Editor-Phasen (5, 6, 9, 10, 12).

Phase 7–8 (Runtime-Befehle) können parallel zur Editor-Entwicklung stattfinden,
sobald Phase 2 abgeschlossen ist.

Phase 9–11 (Animation, Slopes) sind unabhängig voneinander und haben die niedrigste
Priorität.
