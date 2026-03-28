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
