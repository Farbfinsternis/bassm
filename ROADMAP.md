# BASSM — Roadmap

> **Stand:** 2026-03-26
> **Ziel:** Was braucht ein vollständiges Amiga-Spiel?

Eine detaillierte Übersicht aller **bereits implementierten Features und behobenen Bugs** befindet sich in der Datei [`CHANGELOG.dev.md`](CHANGELOG.dev.md). 

---

## Epic 1: Stabilität & Bugfixes (Prio 1)
*Bevor neue Features gebaut werden, müssen die Grundlagen fehlerfrei laufen.*

- [ ] **BUG-4: Mouse-Input in vAmiga-Preview funktioniert nicht**
  - `_wasm_mouse` und `_wasm_mouse_button` exportiert, aber Joystick-Port reagiert nicht.
  - vAmiga nonworker Sourcen prüfen oder POTINP-Fallback evaluieren.
- [ ] **BUG-5: OS-Restore — AROS Workbench kehrt nach Programmende nicht zurück**
  - Bildschirm wird dunkelgrau. `LoadView(saved_view)` in AROS evtl. fehlerhaft.
  - Alternative: `RethinkDisplay` und `RefreshWindowFrame` testen.
- [ ] **BUG-8: IDE-COLOR — Farb-Swatches werden nicht gerendert**
  - Monaco `inlineClassName` vs dynamisches CSS Spezifitätsproblem klären.

---

## Epic 2: Projekt "TIMEMILL" / Engine-Core (Prio 2)
*Timemill ist ein Top-Down Action-Spiel im Stil von The Chaos Engine. Ziel: A500, 25fps, Hardware-Scrolling, 10+ BOBs. Dies ist der kritische Pfad!*

- [x] **PERF-G: Interleaved Bitplanes** ✓ 2026-03-24
  - Phase 1: Codegen + cls.s/box.s/image.s/plot.s/text.s/bobs.s auf interleaved Modulos umgestellt.
  - Phase 2: `.iraw`/`.imask`-Assets; 1-Blit-BOB+DrawImage (5× Speedup auf echter Hardware).
- [ ] **M-VIEWPORT: Tilemap & Hardware-Slices Architektur**
  - Ablösung des fehleranfälligen globalen Scrollings durch ein robustes Viewport-System.
  - `SetViewport index, y1, y2` definiert via Copper-Split einen abgetrennten RAM-Puffer und den sichtbaren Monitorbereich.
  - `Viewport index` dient als Zeichenkontext. `DrawBob`, `DrawText` und `DrawTilemap` arbeiten exklusiv in diesem Puffer.
  - Etablierung einer 2D-Camera (`SetCamera x, y`): Automatische Translation von World-Space Bobs in Screen-Space, inkl. Ausgleich des Amiga `fine_x/y` Hardware-Offsets.
  - Perfektes, gratis Hardware-Clipping an den Rändern der Viewports durch den Copper. Erlaubt wackelfreie, statische UI/HUDs problemlos parallel zur scrollenden Spielwelt.
- [ ] **PERF-J: Screen-to-Screen-Blit für Tilemaps**
  - Statt alle Kacheln im Viewport neu zu zeichnen: Shift-Blit des Screens, nur Ränder neu befüllen. Essentiell für 25fps.
- [ ] **M-COLL-2: Pixel-Perfect Collision**
  - `ImagesCollide(img1... img2...)` via Blitter-AND der Transparenzmasken definieren.
- [ ] **M-MUSIC: Hintergrundmusik (MOD)**
  - Externe Protracker-Replay-Routine (z.B. P61A). `LoadMOD`, `PlayMOD`.

---

## Epic 3: Developer Experience & Workflow (Prio 3)
*Wenn die Engine steht, muss das Bauen von Spielen und Assets reibungslos funktionieren.*

- [ ] **A-MGR-CLEANUP: Asset-Manager UI entschlacken**
  - Manuellen Paletten-Editor (`#palette-grid` und Color-Picker) komplett aus der UI entfernen.
  - Laufzeit/Logik bleibt erhalten: Fokus auf reine "Fire and Forget"-Konvertierung (Original PNG/Render → Quantisierung/Dithering auf X Bitplanes → OCS Planar Output).
  - UI auf reinen Image-Drop, Bittiefe, Dithering-Dropdown und Vorher/Nachher-Preview reduzieren.
- [ ] **M-AUTOMASK: Automatische Farbe-0-Transparenz für Bobs**
  - PNG-Konverter erzeugt `.mask` automatisch, falls Farbe 0 als Transparent genutzt werden soll.
- [ ] **TOOL-IDE-2: Disk-Budget im Live Resource Budget**
  - Neuer Budget-Bar "Disk" (Limit: 880 KB = eine DD-Diskette).
  - **Echtzeit-Schätzung**: Summe aller referenzierten Asset-Dateigrößen (aus dem Asset-Manager) + konstanter Code-Overhead (~10 KB). Aktualisiert sich ohne Compile-Lauf.
  - **Exakter Wert nach Compile**: `main.js` liest nach jedem erfolgreichen Build die tatsächliche Executable-Größe (`fs.statSync`) und schickt sie an den Renderer.
  - Warnschwelle bei 750 KB (Puffer für ADF-Bootblock + Directory). Bei Überschreitung von 880 KB wird TOOL-DEPLOY deaktiviert bzw. mit Warnung versehen.
- [ ] **TOOL-DEPLOY: ADF-Export für echte Hardware**
  - Bootblock und Binary in ein 880 KB ADF-Image schreiben, um Spiele auf echter Hardware oder WinUAE zu testen.
  - Export-Button deaktiviert wenn Disk-Budget (TOOL-IDE-2) überschritten.
- [ ] **TOOL-TREE-5: Tastaturnavigation im Projektbaum**
  - Pfeiltasten ↑↓ und Enter zum Navigieren und Öffnen von Dateien im Tree.

---

## Epic 4: Speicher-Management & Sprache (Prio 4)

- [ ] **M-DYNIMG: Laufzeit-Assets laden + IncBin-Deklaration**
  - `LoadImage`, `LoadSample`, `LoadTileset`, `LoadTilemap` etc. werden auf Laufzeit-Loading umgestellt: Assets liegen als separate Dateien neben dem Executable und werden via `dos.library` ins RAM geladen.
  - Neuer Befehl **`IncBin "datei"`**: Deklariert eine Datei als eingebettet — der Transpiler bindet sie per `INCBIN` ins Executable ein und merkt sich den Dateinamen. Ein nachfolgendes `LoadImage 0, "datei", w, h` (oder ein anderes `Load*`) erkennt automatisch, dass diese Datei eingebettet ist, und nutzt die Speicheradresse des eingebetteten Blobs statt eines `dos.library`-Aufrufs. Ohne `IncBin`-Deklaration lädt `Load*` zur Laufzeit vom Dateisystem. Der Nutzer ändert seine `Load*`-Aufrufe nie — nur die Präsenz von `IncBin` entscheidet über den Ladepfad.
- [ ] **LANG-I: String-Variablen**
  - Echte String-Variablen verwalten (`s$ = "text"`).

---

## Epic 5: Community & Distribution (Prio 5)
*Features, um fertige BASSM-Spiele für die Retro-Community perfekt auslieferbar zu machen.*

- [ ] **TOOL-WHDLOAD: WHDLoad-Export**
  - Generiert neben dem Executable einen fertigen WHDLoad-Wrapper (`.slave`, `.info`, `readme`) verpackt als LHA-Archiv. Ermöglicht Spielern das nahtlose Einbinden in HD-Launcher wie iGame oder TinyLauncher. BASSM-Spiele laufen zwar auch nativ von HD, ein WHDLoad-Paket ist heutzutage aber der Goldstandard für Releases.

---

## Epic 7: Visueller Node-Editor (Prio 7)
*Unreal-Blueprint-artiger Editor als zweite Ansicht neben dem Text-Editor. Macht Amiga-Spielentwicklung auch ohne Coding-Erfahrung zugänglich.*

- [ ] **TOOL-VNE-1: Node-Editor V1 — Core-Renderer**
  - ✓ **Kein externes Framework.** Eigenes DIV/SVG-Layer-System innerhalb eines parent-Containers, der immer **exakt in den Viewport passt** (100% Breite/Höhe, kein Scrolling nach außen).
  - ✓ **Layering im World-Space**:
    - ✓ `bnc-grid`: Basis-DIV-Layer für ein visuelles Raster, unterteilt in Minor- und Major-Grid-Linien (skaliert und pannt automatisch mit).
    - ✓ `bnc-noodles`: SVG-Layer (kubische Bézier-Noodles in World-Space) exakt über dem Grid.
    - ✓ `bnc-nodes`: DIV-Schicht (ein `<div>` pro Node) über den Noodles.
  - ✓ **UI-Layer (Fixed)**: `bnc-ui` Layer (Toolbar, Minimap, Panels). Kein Transform! Mauseingaben (Drag, Scrollrad) auf UI-Elementen werden geblockt (`stopPropagation`), um ungewolltes Navigieren im World-Space zu verhindern.
  - ✓ **Drag-to-Connect** via SVG-Preview-Noodle (gestrichelt); ✓ Zoom um Maus-Zentrum; ✓ Proximity-basierter Pin-Snap (30px Radius).
  - ✓ **Pin-System**: Exec-Pins (weiß, Dreiecke, Ausführungsreihenfolge) + Data-Pins (farbig: blau=int, grün=string, gelb=bool, grau=asset-handle).
  - ✓ **Node-Dragging, Selektion & Löschung**: Header-Drag, Rubber-Band-Selektion, Entf-Taste (geschützte Nodes ausgenommen).

- [ ] **TOOL-VNE-1a: PLAY- & LOOP-Architektur (Zwei-Zonen-Modell)**
  - ✓ **PLAY-Node (Execution Start)**: Der Graph startet mit einer fixierten „PLAY"-Node. Diese Spezial-Node **kann nicht gelöscht** und **nicht mehrfach instanziiert** werden. Sie erscheint nicht im Node-Picker.
  - **LOOP-Node (Frame-Schleife)**: Der Nutzer kann über den Node-Picker **genau eine** LOOP-Node platzieren (Singleton). Die LOOP-Node markiert den Anfang des `While 1 … ScreenFlip … Wend`-Blocks. Sobald eine LOOP-Node existiert, verschwindet sie aus dem Picker. Die LOOP-Node kann nicht gelöscht werden.
  - **Zonen-Klassifikation**: Jeder Command aus `commands-map.json` erhält eine Zone-Eigenschaft:
    - `setup` — Nur nach PLAY (einmalige Init): `Graphics`, `LoadImage`, `LoadAnimImage`, `LoadMask`, `LoadSample`, `LoadFont`, `LoadTileset`, `LoadTilemap`, `SetViewport`, `SetBackground`, `SetTilemap`, `PaletteColor`.
    - `frame` — Nur nach LOOP (pro Frame): `Cls`, `ClsColor`, `Color`, `DrawImage`, `DrawBob`, `DrawTilemap`, `ScreenFlip`, `Viewport`, `SetCamera`, `Text`, `Plot`, `Line`, `Rect`, `Box`.
    - `any` — Beide Zonen: `WaitKey`, `WaitVbl`, `Delay`, `End`, `PlaySample`, `PlaySampleOnce`, `StopSample`, `CopperColor`, `UseFont`, `PokeB`, `PokeW`, `PokeL`, `Poke`.
  - **Wiring-Validierung**: An Exec-Ketten dürfen nur zonen-kompatible Nodes angehängt werden. Die Zugehörigkeit wird per Rückwärts-Trace der Exec-Kette ermittelt (endet bei PLAY → setup; endet bei LOOP → frame).

- [ ] **TOOL-VNE-1b: Node-Picker & Kontext-Filter**
  - ✓ **Node-Picker (Global)**: Doppelklick auf das leere Grid öffnet den Picker mit Suchfeld und auf-/zuklappbaren Kategorien. Zeigt **alle** verfügbaren Nodes an (inklusive LOOP, solange keine existiert).
  - **Node-Picker (Contextual / Noodle-Drop)**: Zieht man eine Noodle aus einem Exec-Pin und lässt sie im Leeren fallen, öffnet sich der Picker **kontextsensitiv gefiltert**: Befindet sich die Quell-Node in der Setup-Kette (Rückwärts-Trace endet bei PLAY), werden nur `setup`- und `any`-Nodes angezeigt. Befindet sie sich in der Frame-Kette (Trace endet bei LOOP), nur `frame`- und `any`-Nodes. Zusätzlich filtert der Picker bei Data-Pins nach kompatiblem Datentyp (Int→Int, String→String, etc.).

- [ ] **TOOL-VNE-1c: Editor Side-Panel (Variables & Assets)**
  - **Variable Manager**: Globale und lokale Variablen inkl. Typen (Int, String, Array) in einer Liste anlegen und verwalten. Drag & Drop einer Variable auf den Canvas erzeugt automatisch Getter/Setter-Nodes.
  - **Asset Outliner**: Baumnavigation für Projekt-Assets (.iraw, .mask, etc.). Drag & Drop eines Assets auf den Canvas erzeugt intelligente Nodes (z.B. LoadImage mit vorbereiteten Metadaten).

- [ ] **TOOL-VNE-1d: Amiga-spezifische Features**
  - **Hardware-Budget-Overlay**: Jeder Node trägt zu Chip-RAM / Fast-RAM / Disk / DMA / Paula-Kanäle bei. Budget-Bars live in der Toolbar.
  - **Copper-Timeline-Panel**: Vertikale PAL-Zeilenskala (0–255), markiert welcher Viewport welche Zeilen belegt. Sofortiges visuelles Feedback (lückenlose Abdeckung).
  - **Constraint-Warnings** vor Code-Generierung: DrawBob vor Viewport, CopperColor + SetViewport, ScreenFlip fehlt, Paula-Kanal doppelt belegt, Chip-RAM überschritten.

- [ ] **TOOL-VNE-2: Persistenz & IDE-Integration**
  - **Speichern/Laden** als `.bnode` (JSON, versioniert), TOOL-TREE-Integration.
  - `.bnode`-Dateien im Projektbaum doppelklickbar; Editor öffnet sich als zweite Ansicht.
  - Vollständige Node-Library aus `commands-map.json` generiert.

- [ ] **TOOL-VNE-3: Graph → BASSM Code-Generierung**
  - **Topologische Sortierung** der Exec-Pins. Startpunkt: PLAY-Node.
  - Setup-Kette (PLAY → … → LOOP) wird als linearer Code vor dem Main-Loop emittiert.
  - Frame-Kette (LOOP → …) wird in `While 1 … ScreenFlip … Wend` gewrappt.
  - "Generate & Compile" startet direkt den Build.

- [ ] **TOOL-VNE-4: BASSM → Graph Import**
  - BASSM-Parser AST → natives `.bnode` JSON.
  - Auto-Layout (z.B. via Sugiyama-Algorithmus), um generierten Graphen visuell aufzuräumen.
  - "Import Code"-Button: bestehendes `.bas` wird in editierbaren Graph überführt.

- [ ] **TOOL-VNE-5: Live-Sync (Code ↔ Visual)**
  - Graph-Änderungen regenerieren BASSM-Code sofort (One-Way → Live).
  - Bidirektionaler Tab: Text-Edit → Graph aktualisiert wenn parsebar.

- [ ] **TOOL-VNE-6: Subgraphs & Custom Functions**
  - Kapselung von Spiellogik: Nutzer können eigene Function-Nodes erstellen.
  - **Isolierter Canvas**: Doppelklick auf eine Custom Function öffnet einen neuen Graph-Tab mit dedizierten Entry- und Return-Pins zur Parameterübergabe, analog zur `Function … EndFunction` Architektur.

---

## Epic 6: Backlog / Low-Level Optimierungen (Prio 6)
*Nice-to-have Features und Mikro-Optimierungen (wenn alles andere fertig ist).*

- [ ] **M-SPRITE / Hardware Sprites**
  - Da Bobs durch PERF-G stark beschleunigt werden, vorerst obsolet. OCS hat nur 8 Hardware-Sprites.
- [ ] **A-MGR Tools (Tilemap / Sprite / Sound)**
  - UI-Editoren im Asset-Manager. Externe Tools wie Aseprite reichen idR aus.
- [x] **PERF-H: DBRA für Zählschleifen** (Compiler-Optimierung) ✓ 2026-03-27
- [ ] **PERF-I: Register-Allocation für For-Schleifen**
- [ ] **PERF-K: Copper-basierte Mitte-Frame-Effekte**
- [ ] **Peephole-Regeln erweitern (R6-R9)**
