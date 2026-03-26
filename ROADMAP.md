# BASSM — Roadmap

> **Stand:** 2026-03-25
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
- [ ] **M-SCROLL: Tilemap & Hardware-Scrolling**
  - `LoadTileset`, `LoadTilemap`. Ring-Buffer-Technik (Screen + 1 Tile Rand).
  - `ScrollX n` via BPLCON1. `_bg_restore_tilemap` für Bobs.
- [ ] **PERF-J: Screen-to-Screen-Blit für M-SCROLL**
  - Statt alle Tiles neu zu zeichnen: Shift-Blit des Screens, nur Ränder neu befüllen. Essentiell für 25fps.
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
- [ ] **TOOL-DEPLOY: ADF-Export für echte Hardware**
  - Bootblock und Binary in ein 880 KB ADF-Image schreiben, um Spiele auf echter Hardware oder WinUAE zu testen.
- [ ] **TOOL-TREE-5: Tastaturnavigation im Projektbaum**
  - Pfeiltasten ↑↓ und Enter zum Navigieren und Öffnen von Dateien im Tree.

---

## Epic 4: Speicher-Management & Sprache (Prio 4)

- [ ] **M-DYNIMG: Laufzeit-Assets laden**
  - `LoadImage`, `LoadSample` etc. laden zur Laufzeit via `dos.library` ins RAM, statt via `INCBIN` hart ins Executable kompiliert zu werden. Spart extrem Speicherplatz bei großen Spielen.
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
- [ ] **PERF-H: DBRA für Zählschleifen** (Compiler-Optimierung)
- [ ] **PERF-I: Register-Allocation für For-Schleifen**
- [ ] **PERF-K: Copper-basierte Mitte-Frame-Effekte**
- [ ] **Peephole-Regeln erweitern (R6-R9)**
