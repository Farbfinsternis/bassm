# TOOL-RESTRUCTURE — IDE Tool Integration Overhaul

## Ziel

Die Tool-Landschaft von BASSM vereinheitlichen. Alle Editoren und Converter leben
im Main Panel (`#editor-panel`). Das separate Asset-Manager-Fenster entfällt.
UX-Prinzip: **Der Dateityp bestimmt den Editor.** Jeder Editor sieht und fühlt sich
gleich an. Neue Editoren können jederzeit ergänzt werden.

---

## Architektur-Entscheidungen

### Panel-View-System
- `#editor-panel` zeigt immer genau **eine View**. Steuerung via CSS-Klassen
  auf `<body>`: `state-code`, `state-image-editor`, `state-tilemap-editor`, etc.
- Jede View ist ein `<div>` in `index.html` (analog zum heutigen `#tileset-editor-panel`).
- View-Wechsel über eine zentrale Funktion `switchView(viewName)`, die alle
  `state-*` Klassen bereinigt und die richtige setzt.
- Jede View hat dieselbe Grundstruktur:
  ```
  ┌─ Toolbar (View-spezifisch) ─────────────────────────────────┐
  │  [Import] [Save] | Settings | Status                        │
  ├──────────────────────────────────────────────────────────────┤
  │                                                              │
  │  Content Area (Canvas, Previews, Inputs)                     │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │  Sidebar / Properties (optional, rechts)                     │
  └──────────────────────────────────────────────────────────────┘
  ```

### Toolbar (Global)
```
[New Project] [Open Project] [Save Project] | [Run] [Build] [Create ADF] | [Node-Editor] [Tilemap-Editor]
```
- `Save Project` = aktuellen Editor-Inhalt speichern (Code: `.bassm`, andere: jeweiliges Asset)
- `Build` = kompilieren ohne Emulator-Start (asm + binary erzeugen)
- `Create ADF` = ADF-Disk-Image erzeugen (späteres Feature, Button zunächst disabled)
- `Node-Editor` = dedizierter Toolbar-Button (öffnet Node-Editor-View)
- `Tilemap-Editor` = dedizierter Toolbar-Button (öffnet Tilemap-View)
- **Entfernte Buttons:** `Asset Manager` (btn-assets), `Tileset Editor` (btn-tileset-editor)
- `Emulator Exit` bleibt kontextuell sichtbar

### Kontext-abhängige Editoren (aus Project Tree)
| Dateityp    | View                | Trigger                              |
|-------------|---------------------|--------------------------------------|
| `.bassm`    | Code Editor         | Doppelklick im Tree                  |
| `.bnode`    | Node Editor         | Doppelklick im Tree                  |
| `.png/jpg`  | **Image Editor**    | Doppelklick im Tree                  |
| `.wav/mp3`  | **Sound Editor**    | Doppelklick im Tree (Platzhalter)    |
| `.tset`     | Tileset Editor*     | Doppelklick im Tree                  |
| `.bmap`     | Tilemap Editor*     | Toolbar-Button oder Doppelklick      |

*Tileset Editor wird Sub-View des Tilemap-Editors (siehe Phase 4).

### PNG Import: 8-Bit Indexed + 24-Bit TrueColor
- Pixel-Tools (Aseprite, Photoshop, GIMP, etc.) exportieren PNGs entweder als
  8-Bit Indexed (mit eingebetteter Palette) oder als 24-Bit TrueColor.
- BASSM muss **beide Varianten** korrekt einlesen und zu OCS `.iraw` konvertieren.
- **8-Bit Indexed PNG:** Eingebettete Palette wird als OCS-Palette übernommen
  (RGB → $0RGB Quantisierung). Keine Median-Cut nötig.
- **24-Bit TrueColor PNG:** Median-Cut erzeugt OCS-Palette, dann Dithering/Quantize
  wie bisher.
- Erkennung erfolgt automatisch beim Laden (Canvas API liefert immer RGBA,
  aber die Quell-Bit-Tiefe kann via PNG-Header oder Heuristik erkannt werden).
- Ausgabe ist immer dasselbe: OCS `.iraw` + `.pal`. Kein separater Modus nötig.
- Fehler werden in die **BASSM-Konsole** geloggt (nicht nur `"Error: decode failed"`)
  — Fehlermeldungen enthalten Dateiname, Dimension, was genau fehlschlug

### Konvertierung → Zielverzeichnis abfragen
Jeder "Convert & Save"-Vorgang zeigt einen **Save-Dialog** mit dem Projektverzeichnis
als Default. Der User wählt Dateiname und Zielordner.

### .iraw als Standard
- `.raw` wird nicht mehr erzeugt. Die Interleaved-Checkbox entfällt.
- Ausgabeformat ist immer `.iraw` (interleaved bitplanes).
- `.pal` wird automatisch neben `.iraw` gespeichert.

### Erweiterbarkeit
Neue Editoren werden hinzugefügt durch:
1. HTML-Panel in `index.html` (oder separates HTML-Fragment)
2. JS-Modul in `app/src/`
3. CSS-Klasse `state-<name>` in `style.css`
4. Registrierung in `switchView()` + File-Extension-Mapping in `_openFile()`
5. Optional: Toolbar-Button falls nicht rein kontextabhängig

---

## Phase 0 — View-System Grundgerüst

**Ziel:** Zentrale View-Switching-Infrastruktur. Noch keine neuen Editoren.

### T0.1: `switchView(viewName)` Funktion ✅
- In `bassm.js`: Funktion die **alle** `state-*` Klassen von `<body>` entfernt
  und `state-<viewName>` setzt.
- State-Namen: `code`, `node-editor`, `tileset-editor`, `image-editor`,
  `sound-editor`, `tilemap-editor`
- Bestehende Toggle-Logik in `tileset-editor.js` und Node-Editor-Toggle
  refactoren um `switchView()` zu nutzen.

### T0.2: `_openFile(relativePath)` Dispatcher ✅
- In `bassm.js`: Funktion die anhand der Dateiendung entscheidet welche View
  geöffnet wird.
- `.bassm` → lädt Datei in Monaco, `switchView('code')`
- `.bnode` → `switchView('node-editor')`
- `.png/.jpg/.bmp` → `switchView('image-editor')` (Panel noch leer)
- `.wav/.mp3/.ogg` → `switchView('sound-editor')` (Panel noch leer)
- `.tset` → `switchView('tileset-editor')` (bestehend)
- `.bmap` → `switchView('tilemap-editor')` (Panel noch leer)
- Doppelklick im Project Tree ruft `_openFile()` auf.

### T0.3: Toolbar-Umbau ✅
- Neue Buttons: `Save Project` (Ctrl+S), `Build` (F7), `Create ADF` (disabled)
- `Node-Editor` Button: öffnet `switchView('node-editor')` (bisheriger Toggle bleibt, wird umverdrahtet)
- `Tilemap-Editor` Button: öffnet `switchView('tilemap-editor')`
- Entfernen: `btn-assets` (Asset Manager), `btn-tileset-editor` (Tileset Toggle)
- HTML in `index.html` anpassen, Event-Listener in `bassm.js` umverdrahten.

### T0.4: Leere Panel-Shells ✅
- In `index.html`: `<div id="image-editor-panel">`, `<div id="sound-editor-panel">`,
  `<div id="tilemap-editor-panel">` mit Placeholder-Text.
- CSS: `state-image-editor`, `state-sound-editor`, `state-tilemap-editor`
  analog zu `state-tileset-editor`.

### T0.5: Kontext-Menü anpassen ✅
- Rechtsklick auf `.png` im Tree: "Open" (öffnet Image Editor), statt "Convert"
  (das einen Popup öffnete).
- Rechtsklick auf `.wav`/`.mp3`: "Open" (öffnet Sound Editor).
- "Convert" Menüpunkt entfällt.

---

## Phase 1 — Image Editor ins Main Panel

**Ziel:** PNG-Konvertierung komplett im Main Panel. Asset Manager nicht mehr nötig für Images.

### T1.1: Image Editor HTML ✅
- Panel `#image-editor-panel` in `index.html` ausbauen:
  - View-Toolbar: `[Import PNG]` | Depth-Dropdown | Dither-Dropdown | +.imask Checkbox | Status
  - Content: Original-Canvas (links) + Converted-Canvas (rechts), darunter Palette-Preview (32 Swatches)
  - Sidebar: Properties (File, Size, Match-%), Budget (Chip RAM, % of 512 KB)
  - Action-Buttons in Sidebar: `[Convert & Save]` `[Export IFF]` `[Copy Code]`
- Design-Sprache: shared `.view-*` CSS-Klassen (Toolbar, Section-Titles, Prop-Rows, Buttons).

### T1.2: Image Editor JS Modul ✅
- Neues Modul `app/src/image-editor.js`
- Konvertierungslogik aus `asset-manager.js` extrahiert:
  `_imgToPlanarInterleaved()`, `_imgToMaskInterleaved()`, `medianCutPalette`-Aufruf,
  `quantizeWithDither`, `_imgRenderPreview()`, `_imgLoadBlob()`.
- Nutzt `window.electronAPI` (inkl. neuer `readAsset`/`saveAsset` in preload.js).
- Export: `window.imgOpenFile(relativePath, projectDir)`.
- `_openFile()` in bassm.js ruft `imgOpenFile()` auf wenn view=image-editor.
- Import-PNG-Button entfernt (Einstieg immer über Project Tree).

### T1.3: 8-Bit Indexed + 24-Bit TrueColor PNG Support ✅
- Automatische Erkennung: PNG-Header parsen (IHDR Chunk, Byte 25 = color type:
  3 = indexed, 2 = truecolor). Canvas API liefert immer RGBA — die Erkennung
  bestimmt nur den Palette-Pfad.
- **8-Bit Indexed PNG:** Eingebettete Palette (PLTE Chunk) extrahieren,
  RGB → OCS $0RGB quantisieren, direkt als OCS-Palette verwenden.
  Pixel-Indizes aus der RGBA-Rückrechnung oder Palette-Lookup.
- **24-Bit TrueColor PNG:** Median-Cut → OCS-Palette → Dithering/Quantize
  (wie bisher).
- Ausgabe ist in beiden Fällen identisch: `.iraw` + `.pal`.
- UI zeigt in beiden Fällen Original + Converted Preview + Palette.

### T1.4: .iraw als einziges Format ✅
- Kein `.raw`-Output mehr. Checkbox "Interleaved" entfällt — immer interleaved.
- "Generate Mask" Checkbox bleibt (erzeugt `.imask` neben `.iraw`).
- Dateiname-Default: `<bildname>.iraw`

### T1.5: .pal neben .iraw speichern ✅
- Bei Convert & Save: automatisch `<bildname>.pal` neben `.iraw` ablegen.
- `.pal`-Format: N × 2 Bytes Big-Endian OCS-Wörter (wie bisher Palette-Prefix in .iraw).

### T1.6: Fehler in die Konsole ✅
- Alle Fehler (Decode, Quantize, Save) gehen an `logLine(msg, 'error')`.
- Fehlermeldungen sind aussagekräftig: Dateiname, was genau fehlschlug, ggf.
  Dimensionen. Beispiel: `"Image 'player.png' (320×256): Decode failed — file may be corrupted or not a valid image"`

### T1.7: Save-Dialog mit Zielverzeichnis ✅
- Jeder Convert & Save nutzt `electronAPI.saveAssetWithDialog()` mit
  `defaultPath` = Projektverzeichnis + Unterordner der Quelldatei.
- User kann Zielordner frei wählen.

### T1.8: Drag & Drop aus Project Tree — ENTFÄLLT
- Einstieg über Doppelklick / Kontextmenü reicht.
- Globaler D&D-Handler kommt in T5.2 (Phase 5).

### T1.9: IPC Cleanup ✅
- `readAsset` IPC-Handler in `main.js` auch via `electronAPI` exponieren
  (bisher nur in `preload-assets.js` / `assetAPI`).
- Oder: einheitlichen Handler schaffen der von beiden Preloads genutzt wird.

---

## Phase 1b — Image Editor Overhaul

**Ziel:** Den bestehenden Image Editor zu einem vollwertigen, professionellen
Konvertierungs-Werkzeug ausbauen. Layout optimieren, Skalierung/Cropping
ermöglichen, interaktive Vollbild-Vorschau, und „Point of Interest" Masking
für gezielte Palette-Optimierung.

### T1b.1: Layout-Umstrukturierung ✅

#### Palette als vertikale Leiste (links)
- `#img-palette-bar` wird von der horizontalen Leiste unter den Canvases
  zu einer **vertikalen Leiste am linken Rand** des Content-Bereichs umgebaut.
- 32 Swatches vertikal gestapelt (1 Spalte), aktive Farben oben, inaktive
  (>= colorCount) unten mit reduzierter Opazität.
- Tooltip pro Slot: `Color N — $0RGB` (wie bisher).
- CSS: `#img-palette-bar` → `flex-direction: column`, fixe Breite (~28 px).

#### Neues Panel-Layout
```
┌─ Toolbar ─────────────────────────────────────────────────────┐
│ Depth | Dither | +.imask | [Scale/Crop] | [Fullscreen] | Sta │
├─────┬──────────────────────────────────────────┬──────────────┤
│     │                                          │              │
│ PAL │  Original-Canvas                         │  Properties  │
│     │                                          │  Budget      │
│     ├──────────────────────────────────────────┤  Scale/Crop  │
│     │                                          │              │
│     │  OCS Preview-Canvas                      │  Actions     │
│     │                                          │              │
└─────┴──────────────────────────────────────────┴──────────────┘
```
- Default: Bilder **übereinander** (vertikal gestapelt), um die verfügbare
  Breite maximal auszunutzen.
- Beide Canvases füllen den verfügbaren Platz so groß wie möglich aus
  (`object-fit: contain`, proportional skaliert).
- `#img-canvas-area` → `flex-direction: column` statt `row`.

#### Ansichts-Option „Originalgröße" (1:1)
- Toggle-Button in der Toolbar: `[1:1]` (oder Icon).
- Aktiviert: Canvases zeigen Pixel 1:1, Overflow → Scrollbars.
- Deaktiviert (Default): Canvases werden auf den verfügbaren Platz skaliert
  (`object-fit: contain`).
- State per CSS-Klasse `img-view-actual` auf `#img-workspace`.

### T1b.2: Skalierungs-Optionen (Sidebar) ✅

**Amiga OCS Limits:** Bilder können größer als 320×256 (PAL) / 320×240 (NTSC)
geladen werden. Der Image Editor bietet Werkzeuge zur Anpassung.

#### Resize-Sektion in der Sidebar
- Neue `view-section` „Dimensions" zwischen Properties und Budget:
  ```
  ┌─ Dimensions ──────────────────┐
  │ Width   [___320___]           │
  │            🔗                 │
  │ Height  [___256___]           │
  │                               │
  │  [Resize]                     │
  └───────────────────────────────┘
  ```
- **Width / Height Input-Felder:** Numerische Eingabe für Zielgröße.
  Default = Original-Dimensionen des geladenen Bildes.
- **Aspect-Ratio Lock (Kettensymbol 🔗):** Klickbares Icon **zwischen**
  Width und Height.
  - Aktiv (Default): Änderung eines Wertes berechnet den anderen proportional.
  - Inaktiv: Beide Werte unabhängig änderbar.
  - Visuelles Feedback: Ketten-Icon verbunden vs. gebrochen, Farbe aktiv vs. dimmed.
- **Resize-Button:** Wendet die Skalierung auf das Quellbild an.
  Interpolation: bilinear via temporärem Canvas.

#### Crop-Sektion in der Sidebar
- Unterhalb von Resize, in derselben „Dimensions"-Section:
  ```
  ┌─ Crop ────────────────────────┐
  │  Origin:                      │
  │  ┌───┬───┬───┐               │
  │  │ ↖ │ ↑ │ ↗ │               │
  │  ├───┼───┼───┤               │
  │  │ ← │ · │ → │               │
  │  ├───┼───┼───┤               │
  │  │ ↙ │ ↓ │ ↘ │               │
  │  └───┴───┴───┘               │
  │                               │
  │  [Crop]                       │
  └───────────────────────────────┘
  ```
- **Origin-Grid (3×3, 9 Pixel):** Definiert den Ankerpunkt des Crops.
  - Top-Left, Top-Center, Top-Right
  - Middle-Left, Center, Middle-Right
  - Bottom-Left, Bottom-Center, Bottom-Right
  - Default: Center.
  - Visuelles Feedback: ausgewählter Pixel hervorgehoben.
- **Workflow:**
  1. User lädt ein 640×480 Bild.
  2. Resize: Height → 256 (Aspect Ratio Lock aktiv → Width wird ~341).
  3. Origin → Top-Left gewählt.
  4. Width → 320 eingeben + Crop → Bild wird rechts beschnitten (341→320).
  5. Ergebnis: 320×256 px, bereit für OCS.
- **Crop-Button:** Wendet den Crop auf das bereits skalierte Bild an.
  Berechnung basierend auf Origin: Offset-X/Y wird aus Origin-Position
  und Differenz zwischen aktuellem Bild und Zielgröße abgeleitet.

### T1b.3: Auto-Reconvert bei Depth-Änderung ✅
- Wenn `img-sel-depth` geändert wird, soll nicht nur die Vorschau
  neu gerendert werden, sondern auch die **Palette automatisch neu
  berechnet** werden (Median-Cut mit neuer `colorCount`).
- Gilt nur für TrueColor-Quellen (`_imgIsIndexed === false`).
- Bei Indexed PNGs: Palette bleibt, nur Quantisierung/Dithering wird
  mit den neuen `colorCount` Slots neu berechnet.
- `_imgSchedulePreview()` → prüft ob Depth sich geändert hat →
  ruft `medianCutPalette()` erneut auf.

### T1b.4: Fullscreen OCS Preview ✅
- Neuer Button in der Toolbar: `[Fullscreen]` (Icon: `codicon-screen-full`
  oder ähnlich).
- Klick öffnet ein **modales Overlay** (`#img-fullscreen-overlay`) über
  dem gesamten `#editor-panel`:
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │ OCS Preview                   [3 bpp ▾]  [Floyd-S. ▾]  [✕] │
  ├──────────────────────────────────────────────────────────────┤
  │                                                              │
  │                  OCS-Converted Canvas                        │
  │                  (so groß wie möglich,                       │
  │                   pixelated rendering)                       │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
  ```
- **Interaktive Steuerung im Fullscreen:**
  - Depth-Dropdown (1–5 bpp): Änderung → sofortige Neuberechnung
    (Palette + Quantize + Render).
  - Dither-Dropdown (None / Floyd-Steinberg / Atkinson / Bayer):
    Änderung → sofortige Neuberechnung.
  - Änderungen im Fullscreen werden zurück in die Haupt-Toolbar synchronisiert.
- **Schließen:** `[✕]` Button oder `Escape`-Taste.
- **Rendering:** Canvas mit `image-rendering: pixelated`, zentriert,
  maximale Größe im Viewport unter Beibehaltung des Seitenverhältnisses.

### T1b.5: „Copy Code" Button entfernen ✅
- Button `#img-btn-copy-code` aus `index.html` entfernen.
- Event-Listener und `_imgCopyCode()` Funktion aus `image-editor.js` entfernen.
- Verbleibende Buttons in der Sidebar: `[Convert & Save]`, `[Export IFF]`.

### T1b.6: Point of Interest (POI) Editor — Komplexes Feature

**Ziel:** Der User kann im Originalbild einen Bereich maskieren, der für die
Palettengenerierung und das Dithering besonders wichtig ist. Die Farbverteilung
im markierten Bereich wird priorisiert.

#### T1b.6a: POI UI-Shell (HTML + CSS) ✅
- **Toolbar:**
  - `[POI]` Toggle-Button in der Image Editor Toolbar (nach dem 1:1-Button).
    Style: wie Node-Editor-Button (aktiv = hervorgehoben, `#7ac5ff` / `#1a2a4a`).
  - `[Clear Mask]` Button — nur sichtbar wenn POI-Modus aktiv.
- **Sidebar** — neue Section „Point of Interest" (unter Budget, über Actions):
  ```
  ┌─ Point of Interest ──────────┐
  │ Brush Size  [====|==] [__30] │
  │ Feather     [====|==] [__64] │
  │                               │
  │ [Clear Mask]                  │
  └───────────────────────────────┘
  ```
  - Section ist nur sichtbar wenn POI-Modus aktiv
    (CSS-Klasse `img-poi-active` auf `#image-editor-panel`).
  - Brush Size: `<input type="range" min="1" max="100" value="30">` +
    `<input type="number">`, synchronisiert.
  - Feather: `<input type="range" min="0" max="255" value="0">` +
    `<input type="number">`, synchronisiert.
- **CSS:**
  - `.img-poi-active` Klasse auf `#image-editor-panel` steuert Sichtbarkeit
    der POI-Sidebar-Section und des Clear-Buttons.
  - POI-Toggle-Button Active-State Styling.
- **Kein JS-Verhalten** außer dem Toggle der Klasse und Slider↔Input-Sync.
  Maske wird noch nicht gezeichnet.

#### T1b.6b: Masken-Datenstruktur + Canvas-Layer ✅
- **Masken-Speicher:** Neues `Uint8Array` (`_imgPoiMask`), Dimensionen =
  Bildgröße. Wert 255 = voll maskiert, 0 = nicht maskiert.
- **Overlay-Canvas:** Zweiter Canvas (`#img-canvas-mask-overlay`) überlagert
  den Original-Canvas per `position: absolute` im selben Container.
  - Gleiche Dimensionen wie der Original-Canvas.
  - `pointer-events: none` im Normalzustand, `pointer-events: auto` im
    POI-Modus.
  - Transparenter Hintergrund.
- **Allokation:** `_imgPoiMask` wird beim Laden eines neuen Bildes
  (`imgOpenFile`) mit der richtigen Größe erzeugt und auf 0 gefüllt.
- **Clear Mask:** Button setzt `_imgPoiMask.fill(0)` und löscht den
  Overlay-Canvas.

#### T1b.6c: Pinsel-Werkzeug (Painting) ✅
- **Maus-Events auf dem Overlay-Canvas:**
  - `mousedown` + `mousemove` → Maske malen/radieren.
  - Linke Maustaste → Pixel auf 255 setzen (maskieren).
  - Rechte Maustaste → Pixel auf 0 setzen (radieren).
  - `mouseup` / `mouseleave` → Malen stoppen.
- **Pinselform:** Kreis mit Radius = `brushSize / 2`.
  Für jeden Pixel im Kreis: `_imgPoiMask[y * width + x] = value`.
- **Pinselgröße:** Aus dem Sidebar-Slider/Input lesen.
- **Cursor:** Custom Cursor auf dem Overlay-Canvas — Kreis-Darstellung
  passend zur aktuellen Pinselgröße. Implementierung:
  - CSS `cursor: none` auf dem Overlay im POI-Modus.
  - Kreis per Canvas-Zeichnung oder via dynamisch generiertem
    `cursor: url(data:...)` dargestellt.
- **Koordinaten-Mapping:** Mausposition → Bildkoordinate umrechnen,
  da der Canvas via CSS skaliert angezeigt wird (`getBoundingClientRect()`
  vs. `canvas.width/height`).
- **Noch keine Visualisierung** der Maske (kommt in T1b.6d).

#### T1b.6d: Masken-Visualisierung ✅
- **Overlay-Canvas rendern:** Nach jedem Paint-Stroke und bei jedem
  Render-Zyklus den Overlay-Canvas aktualisieren.
- **Darstellung:**
  - Maskierter Bereich (value > 0): farbiger Tint (rot/orange),
    Opazität proportional zum Maskenwert (~30% bei 255).
  - Nicht-maskierter Bereich: leicht abgedunkelt (~10% schwarz).
- **Rendering-Funktion:** `_imgPoiRenderOverlay()`:
  1. `ImageData` erzeugen (gleiche Dimensionen wie Bild).
  2. Für jeden Pixel: wenn `_imgPoiMask[i] > 0` → Tint-Farbe mit
     Alpha ∝ Maskenwert. Sonst → dunkler Overlay.
  3. `putImageData()` auf den Overlay-Canvas.
- **Performance:** Nur rendern wenn sich die Maske geändert hat
  (Flag `_imgPoiDirty`). Debounced via `requestAnimationFrame`.
- **Overlay nur sichtbar im POI-Modus:** CSS `opacity: 0` wenn
  POI-Modus inaktiv, `opacity: 1` wenn aktiv (Transition).

#### T1b.6e: Feathering (Gauß-Blur auf Maske) ✅
- **Schieberegler + Eingabefeld:** Wert 0–255 (aus T1b.6a).
  - 0 = harter Übergang (kein Blur).
  - 255 = großer, weicher Übergang.
- **Interner Ablauf:**
  1. Binäre Maske `_imgPoiMask` wird gezeichnet (Uint8Array, 0 oder 255).
  2. Feathering-Wert bestimmt den Blur-Radius: `radius = ceil(feather / 2)`.
  3. Separabler 1D-Gauß-Blur in X und Y Richtung auf eine Kopie der Maske.
  4. Ergebnis: `_imgPoiWeights` (Float32Array, Werte 0.0–1.0) —
     die gewichtete Maske für die Palette-Generierung.
- **Blur-Implementierung:** `_imgGaussBlur(mask, width, height, radius)`:
  - Gauß-Kernel berechnen (σ = radius / 3).
  - Horizontaler Pass: jede Zeile falten.
  - Vertikaler Pass: jede Spalte falten.
  - Normalisieren auf 0.0–1.0.
- **Trigger:** Feather-Slider/Input-Änderung → Blur neu berechnen →
  Overlay-Canvas aktualisieren (zeigt gefeatherte Maske) →
  Palette-Neuberechnung triggern (erst ab T1b.6f).
- **Performance:** Separabler Gauß ist O(n × radius). Bei 320×256
  und Radius 128: ~10M Operationen — sollte in <50ms laufen.

#### T1b.6f: Gewichtete Palette-Generierung ✅
- **`medianCutPalette()` erweitern:**
  - Neuer optionaler Parameter `weights: Float32Array` (gleiche Länge
    wie Pixel-Array).
  - Wenn `weights` vorhanden:
    - Pixel mit `weight > 0` werden proportional häufiger in die
      Pixel-Liste eingetragen: `count = 1 + floor(weight * multiplier)`.
    - `multiplier` bestimmt die Stärke der Gewichtung (z.B. 4–8×).
    - Nicht-maskierte Pixel (weight = 0) gehen einmal in die Liste ein
      — sie beeinflussen die Palette, aber weniger stark.
  - Median-Cut + CIEDE2000-Merge arbeiten dann mit der gewichteten
    Pixelverteilung.
- **Integration in `_imgRenderPreview()`:**
  - Wenn `_imgPoiWeights` existiert und nicht leer:
    `medianCutPalette(_imgData, colorCount, threshold, _imgPoiWeights)`.
  - Sonst: wie bisher ohne Gewichtung.
- **Integration in `_imgFsRender()`:**
  - Gleiche Logik wie in `_imgRenderPreview()`.
- **Dithering:** Zunächst bleibt das Dithering **uniform** (ohne Gewichtung).
  Die Palette-Optimierung auf den POI-Bereich reicht in den meisten Fällen
  aus für deutlich bessere Ergebnisse. Gewichtetes Dithering kann als
  optionale Erweiterung in einem späteren Task ergänzt werden.

#### T1b.6g: Echtzeit-Vorschau-Pipeline ✅
- **Debounced Pipeline:** Jede Änderung an der Maske, Pinselgröße oder
  Feathering löst eine verzögerte Neuberechnung aus:
  1. Maske → Blur (Feathering) → `_imgPoiWeights` erzeugen.
  2. Gewichtete `medianCutPalette()` aufrufen.
  3. `quantizeWithDither()` mit neuer Palette aufrufen.
  4. Beide Canvases (Original-Overlay + OCS Preview) aktualisieren.
- **Debounce-Timing:**
  - Während des Malens (mousemove): nur Overlay aktualisieren (schnell).
  - Nach `mouseup`: volle Pipeline mit ~200ms Debounce triggern.
  - Feather-Slider: Pipeline bei `input`-Event mit ~300ms Debounce.
- **Performance-Hinweis:** Median-Cut ist O(n log n). Bei großen Bildern
  (>320×256) kann die Neuberechnung spürbar werden. Mögliche spätere
  Optimierung: Web Worker für Median-Cut + Quantize.
- **Statusanzeige:** Während der Neuberechnung Status-Text in der
  Toolbar: `„Recalculating…"` → `„320 × 256 px (TrueColor, POI active)"`.

### Zusammenfassung: Dateien die sich in Phase 1b ändern

| Datei | Aktion |
|---|---|
| `app/index.html` | Toolbar-Buttons (1:1, Fullscreen, POI), Sidebar-Sections (Dimensions, Crop, POI), Fullscreen-Overlay, Copy-Code-Button entfernen |
| `app/style.css` | Vertikale Palette, gestapeltes Canvas-Layout, 1:1-Modus, Fullscreen-Overlay, Origin-Grid, POI-Styles |
| `app/src/image-editor.js` | Layout-Logik, Resize/Crop, Auto-Reconvert, Fullscreen, POI-Masking, Copy-Code entfernen |
| `app/src/image-quantizer.js` | `medianCutPalette()` + `quantizeWithDither()` um optionale `weights` erweitern |

### Session-Planung Phase 1b

| Session | Tasks | Ergebnis |
|---------|-------|----------|
| A ✅ | T1b.1 + T1b.5 | Neues Layout (vertikale Palette, gestapelte Canvases, 1:1-Toggle), Copy-Code weg |
| B ✅ | T1b.2 + T1b.3 | Resize/Crop mit Aspect-Lock und Origin-Grid, Auto-Reconvert |
| C ✅ | T1b.4 | Fullscreen OCS Preview mit interaktiven Controls |
| D1 ✅ | T1b.6a + T1b.6b | POI UI-Shell (Toolbar, Sidebar, Slider) + Masken-Datenstruktur + Canvas-Layer |
| D2 ✅ | T1b.6c + T1b.6d | Pinsel-Werkzeug (Painting) + Masken-Visualisierung (Overlay-Rendering) |
| D3 ✅ | T1b.6e + T1b.6f + T1b.6g | Feathering (Gauß-Blur) + gewichtete Palette + Echtzeit-Pipeline |

---

## Phase 2 — Sound Editor (Platzhalter)

**Ziel:** Minimaler Sound Editor im Main Panel. Konvertierung kommt später.

### T2.1: Sound Editor HTML ✅
- Panel `#sound-editor-panel` in `index.html`:
  - View-Toolbar: `[Import WAV/MP3]` | Period-Slider | Status
  - Content: Waveform-Placeholder + File-Info
  - Action-Bar: `[Convert & Save]` (disabled), `[Copy Code]`
- Gleiches Layout-Muster wie Image Editor.

### T2.2: Sound Editor JS ✅
- Neues Modul `app/src/sound-editor.js`
- `initSoundEditor()`, `openSoundFile(relativePath)`
- Zeigt Datei-Info (Name, Größe, Dauer) an.
- Convert-Logik: analog zu bisherigem `onSoundDropped()` in `asset-manager.js`,
  wird in späterem Milestone implementiert.

### T2.3: Tree-Integration ✅
- Doppelklick auf `.wav`/`.mp3`/`.ogg` → `switchView('sound-editor')` + Datei laden.

---

## Phase 3 — Asset-Manager-Fenster entfernen

**Ziel:** Alles lebt im Main Panel. Das Popup-Fenster und seine Infrastruktur werden entfernt.

### T3.1: `main.js` — Asset Manager Window entfernen ✅
- `createAssetManagerWindow()` löschen.
- `ipcMain.on('bassm:open-asset-manager')` löschen.
- `assetManagerWindow` Variable und alle Referenzen entfernen.
- File-Watcher-Notify an Asset Manager Window entfernen.

### T3.2: `preload-assets.js` entfernen ✅
- Datei löschen.
- IPC-Handler die exklusiv vom Asset Manager genutzt werden prüfen:
  - `bassm:list-assets` — evtl. noch nützlich → behalten falls Image Editor es nutzt, sonst entfernen.
  - `bassm:write-asset` — prüfen ob noch genutzt.
  - `bassm:save-asset-path` — wird für .imask-Auto-Save gebraucht → in `preload.js` exponieren.
  - `bassm:read-asset` — in `preload.js` exponieren (Image Editor braucht es).

### T3.3: Asset Manager Dateien entfernen ✅
- `app/asset-manager.html` löschen.
- `app/asset-manager.css` löschen.
- `app/src/asset-manager.js` löschen.
- Referenzen in `main.js` (loadFile, BrowserWindow) bereinigen.

### T3.4: `preload.js` erweitern ✅
- Fehlende IPC-Methoden aus `preload-assets.js` übernehmen:
  - `readAsset` (Binärdatei aus Projektverzeichnis lesen)
  - `saveAsset` (Datei an absoluten Pfad schreiben, ohne Dialog)
  - `listAssets` (falls benötigt)

### T3.5: `bassm.js` — `openAssetManager` Referenz entfernen ✅
- `btn-assets` Event-Listener löschen.
- Kontext-Menü "Convert" → bereits in Phase 0 durch "Open" ersetzt.

### T3.6: Smoke Test ✅
- Projekt öffnen → PNG doppelklicken → Image Editor öffnet im Main Panel
- Convert & Save → .iraw + .pal + .imask im gewählten Verzeichnis
- Kein Asset Manager Fenster mehr erreichbar
- Compiler-Pipeline unverändert funktionsfähig

---

## Phase 4 — Tilemap-Editor + Tileset als Sub-View

**Ziel:** Vollständiger Tilemap-Editor im Main Panel. Der Tileset-Editor wird
darin eingebettet, da jede Tilemap genau ein Tileset hat.

### T4.1: Tilemap Editor HTML
- Panel `#tilemap-editor-panel` in `index.html`:
  - View-Toolbar: `[New Tilemap]` `[Open .bmap]` `[Save .bmap]` | Map-Settings (W×H, Tile W×H) | Status
  - Content: **Split-View**
    - Links: Tile-Palette (Tileset-Preview, klickbare Tiles)
    - Mitte: Tilemap-Canvas (Grid, Click-to-Paint)
    - Rechts: Properties (Map-Dimensions, Tile-Count, Budget)
  - Tileset-Zone oben links: Drop-Target + `[Load Tileset]` Button
  - "Edit Tileset" Button → wechselt in Tileset Sub-View

### T4.2: Tileset als Sub-View
- Der bisherige Tileset Editor (`#tileset-editor-panel`) wird zur Sub-View
  des Tilemap-Editors.
- Aufruf: Button "Edit Tileset" im Tilemap-Editor, oder Doppelklick auf `.tset`
  im Tree.
- Tileset-Editor bekommt **"Back to Tilemap"** Button in seiner Toolbar.
- CSS: `state-tileset-editor` bleibt, wird aber logisch als Sub-State
  von `state-tilemap-editor` behandelt.

### T4.3: PNG → Tileset per Drag & Drop
- Im Tilemap-Editor: definierte Drop-Zone für das Tileset (oben links).
- PNG aus dem Tree auf die Zone droppen:
  1. Öffnet Tileset Sub-View mit dem PNG vorgeladen
  2. User stellt Tile-Size und Depth ein
  3. "Save & Use" → speichert `.tset`, kehrt zum Tilemap-Editor zurück,
     Tileset ist geladen

### T4.4: Tilemap Editor JS
- Neues Modul `app/src/tilemap-editor.js`
- Konvertierungslogik aus `asset-manager.js` extrahieren: `parseTilemapCSV()`,
  `csvToBmap()`.
- Erweitern: visuelles Painting auf dem Grid (Click → Tile setzen).
- `initTilemapEditor()`, `openTilemapFile(relativePath)`, `openNewTilemap()`.

### T4.5: Tileset-Editor Refactor
- `tileset-editor.js` anpassen:
  - `openTsetFromTree(relativePath)` — lädt .tset direkt aus Projektverzeichnis
  - Kommunikation mit Tilemap-Editor: Callback `onTilesetReady(tsetData)`
  - "Back to Tilemap" Button nur sichtbar wenn aus Tilemap-Editor geöffnet.

### T4.6: CSV-Import
- Tilemap-Editor: Button "Import CSV" → lädt CSV-Textdatei, parsed zu Grid.
- Bisherige `parseTilemapCSV()` wiederverwenden.

### T4.7: Tree-Integration
- Doppelklick `.bmap` → `switchView('tilemap-editor')` + Datei laden.
- Doppelklick `.tset` → `switchView('tileset-editor')` + Datei laden.
- Toolbar-Button "Tilemap-Editor" → `switchView('tilemap-editor')` (leerer Editor).

---

## Phase 5 — UX Polish & Konsistenz

**Ziel:** Alle Editoren sehen identisch aus. Drag & Drop überall. Keyboard-Shortcuts.

### T5.1: Einheitliche Editor-Toolbar CSS
- Gemeinsame CSS-Klasse `.view-toolbar` für alle View-Toolbars.
- Gleiche Abstände, Button-Styles, Separator-Styles.
- Gemeinsame `.view-content`, `.view-sidebar`, `.view-action-bar` Klassen.

### T5.2: Globaler Drag & Drop Handler
- In `bassm.js`: Dateien aus dem Tree auf das Main Panel droppen.
- Erkennt Dateityp und öffnet den passenden Editor.
- Drop-Overlay mit Typ-spezifischem Hint-Text.

### T5.3: Keyboard Shortcuts
- `Ctrl+S`: Save (kontextuell — Code speichert .bassm, Image Editor speichert .iraw, etc.)
- `F5`: Run (wie bisher)
- `F7`: Build only
- `Escape`: zurück zum Code Editor (oder vorherige View)

### T5.4: Breadcrumb / View-Indicator
- Kleine Anzeige unter der Toolbar: welche View/Datei gerade offen ist.
- Beispiel: `Code > main.bassm` oder `Image Editor > gfx/player.png`
- Klickbar → zurück zum Code Editor.

### T5.5: Konsolen-Integration
- Alle Editoren loggen Status-Meldungen in die BASSM-Konsole.
- Konvertierungs-Erfolg: `"[Image] Converted player.png → player.iraw + player.pal (3.2 KB Chip RAM)"`
- Fehler: `"[Image] Error: player.png — unsupported bit depth 48"` etc.

---

## Phase 6 — Font-Konverter

**Ziel:** Dedizierter Font-Editor im Main Panel. Fonts sind keine normalen Images —
sie haben ein festes Zeichenraster (z.B. 8×8, 16×16) und eine Zeichentabelle.
Der Image Editor konvertiert Grafiken zu `.iraw`, der Font-Konverter erzeugt
das Format das `LoadFont` erwartet.

### T6.1: Font Editor HTML + CSS ✅
- Panel `#font-editor-panel` in `index.html`
- View-Toolbar: Char-Width × Char-Height | Depth | Charset-Auswahl | Status
- Content: Font-Sheet Preview (Grid mit Zeichen-Overlay), Einzelzeichen-Preview
- Sidebar: Properties (Chars, Total Size, Chip RAM)
- Action: `[Convert & Save]` `[Copy Code]`

### T6.2: Font Editor JS ✅
- Neues Modul `app/src/font-editor.js`
- PNG laden → Zeichen-Grid erkennen (Breite/Höhe pro Zeichen)
- Zeichensatz-Mapping (ASCII-Range, Custom)
- Ausgabe im Format das `LoadFont` / `_text_init` erwartet
- `window.fontOpenFile(relativePath, projectDir)`

### T6.3: Integration ✅
- `switchView('font-editor')`, `state-font-editor` CSS
- `_EXT_VIEW_MAP`: Font-Quell-PNGs via Kontextmenü "Open as Font"
  (da PNGs sowohl Images als auch Fonts sein können, braucht es
  eine explizite Unterscheidung — entweder Kontextmenü-Option oder
  eigene Dateiendung `.fnt.png`)
- Doppelklick auf `.bfnt` (BASSM Font Binary) → öffnet Font Editor

### T6.4: Abgrenzung Image Editor vs. Font Editor ✅
- Image Editor: beliebige Grafiken → `.iraw` + `.pal`
- Font Editor: Zeichensatz-Sheets → Font-Binary (`.bfnt` o.ä.)
- Kein Overlap: PNGs die als Font gedacht sind, werden über den Font Editor geöffnet

---

## Zusammenfassung: Dateien die sich ändern

| Datei | Aktion |
|---|---|
| `app/index.html` | Toolbar-Umbau, neue Panel-Shells, Tileset-Editor Anpassung |
| `app/style.css` | Neue `state-*` Klassen, einheitliche View-CSS |
| `app/src/bassm.js` | `switchView()`, `_openFile()`, Toolbar-Events, Tree-Doppelklick, Asset-Manager-Referenzen entfernen |
| `app/src/image-editor.js` | **NEU** — Image Converter im Main Panel |
| `app/src/font-editor.js` | **NEU** — Font-Konverter im Main Panel |
| `app/src/sound-editor.js` | **NEU** — Sound Editor Platzhalter |
| `app/src/tilemap-editor.js` | **NEU** — Tilemap Editor |
| `app/src/tileset-editor.js` | Refactor: Sub-View des Tilemap-Editors, Tree-Anbindung |
| `app/preload.js` | IPC-Methoden aus preload-assets.js übernehmen |
| `main.js` | Asset Manager Window entfernen, ggf. neue IPC-Handler |
| `app/asset-manager.html` | **LÖSCHEN** |
| `app/asset-manager.css` | **LÖSCHEN** |
| `app/src/asset-manager.js` | **LÖSCHEN** |
| `app/preload-assets.js` | **LÖSCHEN** |

---

## Session-Planung

| Session | Phasen | Ergebnis |
|---------|--------|----------|
| 1 ✅ | Phase 0 | View-System steht, Toolbar umgebaut, Dispatcher funktioniert |
| 2 ✅ | Phase 1 (T1.1–T1.5) | Image Editor im Main Panel, .iraw + .pal |
| 3 ✅ | Phase 1 (T1.6–T1.9) | Fehler-Logging, Save-Dialog, IPC Cleanup |
| 4 | Phase 1b (T1b.1 + T1b.5) | Neues Layout (vertikale Palette, gestapelt, 1:1-Toggle), Copy-Code weg |
| 5 | Phase 1b (T1b.2 + T1b.3) | Resize/Crop mit Aspect-Lock und Origin-Grid, Auto-Reconvert |
| 6 | Phase 1b (T1b.4) | Fullscreen OCS Preview mit interaktiven Controls |
| 7 | Phase 1b (T1b.6) | Point of Interest Editor (Pinsel, Feathering, gewichtete Palette) |
| 8 ✅ | Phase 2 | Sound-Platzhalter |
| 9 ✅ | Phase 3 | Asset Manager Fenster + Code komplett entfernt |
| 10 | Phase 4 (T4.1–T4.3) | Tilemap-Editor Grundgerüst + Tileset Sub-View |
| 11 | Phase 4 (T4.4–T4.7) | Tilemap-Editor komplett, Tree-Integration |
| 12 | Phase 5 | UX Polish, Shortcuts, Konsistenz |
| 13 ✅ | Phase 6 | Font-Konverter im Main Panel |

