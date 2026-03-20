# BASSM — Roadmap

> **Stand:** 2026-03-20
> Vollständige Analyse: Implementierungsstand, fehlende Features, Bugs, Tech-Debt.
> Ziel: Was braucht ein vollständiges Amiga-Spiel?
>
> **Milestone 1 abgeschlossen:** 2026-03-20

---

## Implementierungsstand (vollständig abgeschlossen)

| Bereich | Features |
|---------|----------|
| **Kern** | Graphics, ScreenFlip, WaitVbl, Delay, End |
| **Ausdrücke** | Integer-Variablen, Zuweisung, alle Operatoren (+−×÷Mod Shl Shr And Or Xor Not) |
| **Fluss** | If/ElseIf/Else/EndIf, While/Wend, For/Next/Step, Repeat/Until, Exit [n], Select/Case |
| **Typen** | Type/Field/EndType (AoS, Skalar + Array), 1D-Arrays (Dim), 2D-Arrays (Dim w,h) |
| **Funktionen** | Function (Rückgabewert) + Procedure (kein Return); LINK/UNLK Stack-Frame |
| **Grafik** | Plot, Line, Rect, Box (Blitter), Cls (Blitter A→D), ClsColor |
| **Double-Buffering** | Zwei Bitplane-Puffer + zwei Copper-Listen; _FlushBobs auto-injiziert |
| **Text** | Text x,y,"str"; 8×8 Built-in Font; LoadFont/UseFont (variabler charW/H) |
| **Bilder** | LoadImage/DrawImage (Blitter), LoadAnimImage, DrawImage frame |
| **Bobs** | SetBackground, LoadMask, DrawBob [frame]; 3-Queue-System, Double-Buffer-korrekt |
| **Kollision** | RectsOverlap (8 Args, AABB), ImagesOverlap (Header-Dim), ImageRectOverlap |
| **Kupfer** | CopperColor y,r,g,b — inline, beide Pfade ohne JSR (PERF-C) |
| **Sound** | LoadSample, PlaySample, PlaySampleOnce, StopSample (Paula DMA) |
| **Eingabe** | WaitKey, KeyDown(sc), JoyUp/Down/Left/Right/Fire(p), MouseX/Y/Down/Hit |
| **Hardware** | PeekB/W/L(addr), PokeB/W/L/Poke addr,val — direkter Registerzugriff |
| **Strings** | Str$(n) — Integer-to-String; verwendbar in Text-Konkatenation |
| **Zufall** | Rnd(n) — Xorshift32; Abs(n) — inline |
| **Language** | Include, Type-System, LANG-A–F komplett |
| **Optimierung** | PERF-A (cmp+Bcc), PERF-B (Stack-Elimination), PERF-C (CopperColor inline), Peephole (5 Regeln) |
| **IDE** | Monaco-Editor (vollständiges Syntax-Highlighting, Autocomplete+Snippets, Farb-Swatches, Fehler-Marker), Projekt-Tree, Outliner, Budget-Bars (CPU+CHIP), Resizable Panes, Console mit Timestamps+Clear |
| **Asset Manager** | Palette-Editor, PNG→Amiga-Planar-Raw (Floyd-Steinberg), Copy-Code-Button |
| **Build** | PreProcessor → Lexer → Parser → CodeGen → Peephole → vasmm68k_mot → vlink → vAmiga WASM |

---

## Bekannte Bugs & Inkonsistenzen

*Diese Punkte sind einfach falsch und sollten unabhängig von der Milestone-Reihenfolge behoben werden.*

### ~~BUG-1: Syntax-Highlighting fehlt ~15 Befehle (editor-init.js)~~ ✓ 2026-03-20
~~Die Monaco-Keyword-Liste wurde seit M-BOB nicht mehr aktualisiert.~~

- [x] Alle fehlenden Befehle in die Keyword-Liste in `editor-init.js` eintragen
- [x] Completion-Provider mit Snippets für alle 35 Commands + 20 Builtin-Funktionen

### ~~BUG-2: commands-map.json — DrawImage/DrawBob Arg-Count falsch~~ ✓ 2026-03-20

- [x] `DrawImage` und `DrawBob` um optionalen `frame`-Parameter ergänzt (`"optional": true`)

### ~~BUG-3: NPrint ist ein No-Op-Stub~~ ✓ 2026-03-20

- [x] Entfernt aus `commands-map.json` und `codegen.js` (war nie implementiert)

### BUG-4: Mouse-Input in vAmiga-Preview funktioniert nicht
`_wasm_mouse` und `_wasm_mouse_button` sind exportiert und Handler sind gesetzt, aber Maus-Delta erreicht JOY0DAT nicht. Hypothesen: falscher Port-Index, fehlende `setDxDy`-API, AROS-Device-Init fehlt.

- [ ] vAmiga nonworker Sourcen prüfen: wie wird `_wasm_mouse(port, dx, dy)` intern verarbeitet?
- [ ] Alternative testen: absolute Maus-Koordinate direkt in JOY0DAT schreiben statt Delta
- [ ] Fallback: POTINP-Bit in AROS-BIOS verifizieren (rechte Taste)

### BUG-5: OS-Restore — AROS Workbench kehrt nach Programmende nicht zurück
Symptom: Bildschirm wird dunkelgrau, aber Workbench/Shell-Fenster bleibt weg. `LoadView(saved_view)` + `RethinkDisplay()` sind gesetzt, aber `gb_ActiView` ist in vAmiga's AROS wahrscheinlich NULL.

- [ ] Prüfen: `_saved_view` beim Start loggen (Debug-POKE an bekannte RAM-Adresse)
- [ ] Alternative: nach `LoadView(NULL)` / `WaitTOF×2` nur `RethinkDisplay` aufrufen (ohne LoadView(saved))
- [ ] Alternativ: Workbench-Fenster per `intuition.library/RefreshWindowFrame` explizit neu zeichnen

### BUG-6: muls.w — kein Overflow-Schutz bei Multiplikation
Codegen emittiert `muls.w` (16×16→32 bit). Bei Operanden > 32767 entstehen falsche Ergebnisse ohne Fehlermeldung.

- [ ] Budget-Hinweis in Fehlermeldung ergänzen: "Multiplikations-Operanden müssen 0..32767 sein"
- [ ] Langfristig: `muls.l` (32×32→64) prüfen oder Compiler-Warning bei Literal-Overflow

### BUG-7: budget.js ignoriert RectsOverlap/ImagesOverlap/PeekB-Overhead
Kollisionsprüfungen und Hardware-Zugriffe kosten messbare Zyklen (movem + 4× cmp), sind aber nicht in der Budget-Schätzung.

- [ ] `_estimateLineCycles` um RectsOverlap (~120 Zyklen), ImagesOverlap (~80 Zyklen), ImageRectOverlap (~80 Zyklen) ergänzen
- [ ] PeekB/W/L und PokeB/W/L als generische Statements behandeln (~20 Zyklen)

---

## ~~Milestone 1: IDE — Quick Wins~~ ✓ 2026-03-20

### ~~IDE-ERR: Fehler-Marker im Editor~~ ✓
- [x] Exception-Message parsen (`line N` / `Zeile N` Regex)
- [x] `monaco.editor.setModelMarkers()` mit `MarkerSeverity.Error` — rote Unterwellenlinie in der richtigen Zeile
- [x] Marker bei nächstem erfolgreichen Run gecleart

### ~~IDE-SYN: Syntax-Highlighting vervollständigen~~ ✓ (= BUG-1)
- [x] Alle fehlenden Commands in `editor-init.js` eingetragen (35 Commands + 20 Builtins)
- [x] `registerCompletionItemProvider` mit Tab-Stop-Snippets für alle Commands

### ~~IDE-COLOR: Inline Farb-Swatches~~ ✓
- [x] `createDecorationsCollection` + Glyph-Margin-Dekorationen
- [x] OCS r,g,b → CSS `rgb()` berechnet; dynamische `<style>`-Injektion pro Farbe
- [x] Funktioniert für `PaletteColor` und `CopperColor`; debounced bei 300 ms

### ~~IDE-CONSOLE: Console-Panel verbessern~~ ✓
- [x] Timestamps `[HH:MM:SS]` vor Log-Einträgen
- [x] Erfolg-Meldung zeigt Zeilenanzahl + ASM-Dateiname statt rohem ASM-Dump
- [x] `#console-bar` mit "✕ Clear"-Button; `.warn`-Klasse (gelb) ergänzt

---

## Milestone 2: IDE — Developer Experience

*Grössere IDE-Features. Machen den Editor zu einem echten Werkzeug.*

### ~~IDE-COMPLETE: Autocomplete für Befehle~~ ✓ 2026-03-20
- [x] `registerCompletionItemProvider` für 'blitz2d'
- [x] Prefix-Match auf alle 35 Commands + 20 Builtin-Funktionen
- [x] Parameter-Platzhalter via `InsertAsSnippet` (Tab-Stops)
- [x] Keyword-Snippets (12 Items): `For/Next`, `While/Wend`, `Repeat/Until`, `If/EndIf`, `If/Else/EndIf`, `If/ElseIf/EndIf`, `Select/EndSelect`, `Function` (value + procedure), `Type/EndType`, `Dim` (1D + 2D) — mit `filterText` für korrektes Prefix-Matching

### ~~IDE-HOVER: Hover-Dokumentation~~ ✓ 2026-03-20
- [x] Monaco `registerHoverProvider` für 'blitz2d'
- [x] Word unter Cursor gegen Command-Liste matchen
- [x] Markdown-Hover: `**DrawBob** *index, x, y [, frame]*` + Kurzbeschreibung
- [x] Beschreibungen in `commands-map.json` als `"description"`-Feld ergänzt; `doc`-Felder in `COMMAND_SIGS` + `BUILTIN_SIGS` in `editor-init.js`; `Str$`-Edge-Case behandelt

### ~~IDE-OUTLINE: Outliner verbessern~~ ✓ 2026-03-20
- [x] Functions und Procedures hervorheben — Icons `ƒ` (fn, blau) und `⊳` (proc, gelb)
- [x] While/Repeat-Schleifen mit Zeilennummer (Klick springt hin) — Icon `↻`, grün, While zeigt gekürzten Ausdruck
- [x] LoadImage/LoadSample/LoadFont/LoadAnimImage als Asset-Liste — Icons `▣`/`♪`/`A`, Farben lila/teal/gold

### ~~IDE-SPLIT: Emulator-Vollbild-Toggle~~ ✓ 2026-03-20
- [x] Button `⊡` in Toolbar + F11 togglen den Emulator-Panel auf volle Breite/Höhe
- [x] ESC (wenn Fullscreen aktiv) oder F11 zum Zurückkehren; Button leuchtet blau wenn aktiv
- [x] Console-Panel wird mitgeblendet; ResizeObserver + setTimeout(30ms) für saubere Bounds-Aktualisierung

### ~~IDE-KEYBIND: Tastenkürzel-Dokumentation~~ ✓ 2026-03-20
- [x] **F5** = Run (compile + run); **F6** = Re-run ohne Recompile (cached binary); **Ctrl+S** = Save; **F11** = Emulator fullscreen; **ESC** = Exit fullscreen — capture-phase keydown, überschreibt Monaco
- [x] `bassm.run()` gibt jetzt `{ asm, binary }` zurück; `_lastBinary` cached für F6
- [x] Tastenkürzel-Tooltips auf allen Toolbar-Buttons (`title`-Attribut)

---

## Milestone 3: Sprache — Fehlende Grundlagen

### LANG-G: Const — Compile-Time-Konstanten
Blitz2D kennt keine Const-Direktive, aber BASSM kann eine einführen. Kosten: 0 Zyklen, 0 BSS-Bytes (compile-time substituiert).

- [ ] Lexer: `Const` als Keyword registrieren
- [ ] Parser: `Const NAME = literal` → `{ type: 'const_def', name, value }` (nur Integer-Literale, kein Ausdruck)
- [ ] PreProcessor oder Parser: Const-Map aufbauen, alle `ident`-Nodes gegen Map testen und durch `int`-Node ersetzen
- [ ] Codegen: `const_def`-Statement → kein Code (nur Map-Eintrag)
- [ ] Fehler: `Const n = variable` → "Const-Wert muss Literal sein"
- [ ] Editor-Syntax-Highlighting: `Const` als Keyword

### LANG-H: Data / Read / Restore — Statische Datentabellen
Essentiell für Level-Maps, Lookup-Tabellen, Score-Tabellen ohne riesige Array-Initialisierung.

- [ ] Lexer: `Data`, `Read`, `Restore` als Keywords registrieren
- [ ] Parser: `Data val1, val2, ...` → `{ type: 'data_stmt', values: Expr[] }`
- [ ] Parser: `Read var` → `{ type: 'read_stmt', target: string }`
- [ ] Parser: `Restore [label]` → `{ type: 'restore_stmt', label: string|null }`
- [ ] Parser: `Data`-Label-Syntax: `label: Data 1,2,3` (optional, für Restore-Target)
- [ ] Codegen: Alle Data-Werte in `SECTION DATA` als `dc.l` sammeln (nach `_collectVars`)
- [ ] Codegen: `_data_ptr` BSS-Variable (Zeiger auf aktuellen Data-Eintrag)
- [ ] Codegen: `_data_start` = Adresse des ersten Data-Eintrags (für Restore)
- [ ] Codegen: Read → `move.l (_data_ptr),d0; move.l d0,_var_X; addq.l #4,_data_ptr`
- [ ] Codegen: Restore → `lea _data_start,a0; move.l a0,_data_ptr` (ohne Label: immer Anfang)
- [ ] budget.js: Read (~15 Zyklen), Data (~0 Zyklen da DATA-Segment)
- [ ] Tests: test-lang-data.js

### LANG-I: String-Variablen
Blitz2D unterscheidet String-Variablen (`s$`) von Integer-Variablen (`n`). Scope: einfache String-Pointer-Variablen (kein dynamisches Heap-Management).

- [ ] Lexer: `$`-Suffix als String-Variable-Marker erkennen (`IDENT$` → Token-Typ `STRING_IDENT`)
- [ ] Parser: String-Zuweisung `s$ = "text"` und `s$ = t$` parsen
- [ ] Codegen: String-Variablen als `ds.l 1` BSS (Pointer); String-Literale in CODE-Segment (wie bisher)
- [ ] Codegen: `s$ = "hello"` → `lea .strN,_var_s_str; move.l a0,_var_s`; Literal inline
- [ ] Codegen: `s$ = t$` → `move.l _var_t,_var_s`
- [ ] Codegen: `Text x,y,s$` → `move.l _var_s,a0; jsr _Text`
- [ ] Codegen: `s$ = s$ + "!"` → String-Concat via Puffer (shared `_str_concat_buf`, fixed size 256 B)
- [ ] Fehler: String-Variable in Integer-Ausdruck → Compiler-Error
- [ ] Scope: String-Variablen sind global (kein Frame-Alloc); Keine GC nötig
- [ ] Tests: test-lang-strings.js

---

## Milestone 4: M-SCROLL — Tilemap & Hardware-Scrolling

*Essentiell für Platformer, Shooter, RPGs. Größtes fehlendes Feature für vollständige Spiele.*

### M-SCROLL-1: Tileset laden
- [ ] `LoadTileset "file.raw", tileW, tileH` → Compile-Time; INCBIN DATA_C (Chip-RAM, Blitter-Zugriff)
- [ ] Metadaten-Header analog zu LoadImage: `dc.w tileW, tileH, depth, rowbytes`
- [ ] `_tilesetAssets` Map in Codegen; Tileset-Pointer in BSS
- [ ] A-MGR: Tileset-Vorschau (Raster über importiertem Bild)

### M-SCROLL-2: Tilemap laden & initialisieren
- [ ] `LoadTilemap "file.map", mapW, mapH` → Compile-Time; `dc.w` Array in DATA (nicht Chip-RAM — reine IDs)
- [ ] Alternativ: `Dim`-basierte Tilemap (bereits implementiert, sofort nutzbar)
- [ ] Empfehlung: Tilemap als `Dim map(mapW, mapH)` + `Data`-Initialisierung (LANG-H synergiert)
- [ ] `_tilemap_ptr`, `_tilemap_w`, `_tilemap_h` BSS-Variablen

### M-SCROLL-3: Tilemap zeichnen (Software-Renderer)
- [ ] `DrawTilemap scrollX, scrollY` — zeichnet sichtbaren Ausschnitt in Back-Buffer
- [ ] Kern-Routine `_DrawTilemap` in `tilemap.s`:
  - [ ] Tile-Index aus Map-Array lesen
  - [ ] Tile-Offset im Tileset berechnen (tileIdx × tileH × rowbytes × depth)
  - [ ] Blitter-Copy pro Tile: BLTCON0=$09F0 (D=A), keine Maske
- [ ] Ring-Buffer-Technik: Screen-Buffer = Sichtbereich + 1 Tile Rand links/rechts; scrollX modulo tileW
- [ ] Optimierung: nur Tiles am Rand neu zeichnen wenn scrollX sich nicht über Tile-Grenze bewegt

### M-SCROLL-4: Hardware-Scrolling (BPLCON1)
- [ ] `ScrollX n` — setzt BPLCON1 für Pixel-genaues horizontales Scrolling (0–15 Pixel sub-tile)
- [ ] Codegen: `move.w #(n<<4|n), BPLCON1(a5)` inline (n = Pixel-Offset im aktuellen Tile)
- [ ] BPL1MOD / BPL2MOD anpassen wenn scrollX > 0 (extra Wort am Zeilenanfang überspringen)
- [ ] Vertikal: `ScrollY n` → BPL1PTR / BPL2PTR um n×GFXBPR verschieben (Copper-List patchen)
- [ ] Kombination: horizontaler Pixel-Offset (BPLCON1) + vertikaler Byte-Offset (BPLxPTR)

### M-SCROLL-5: Bob-Integration
- [ ] `_bg_restore_tilemap` Routine in `tilemap.s` — ersetzt `_bg_restore_static`
- [ ] Installierbar via `_bg_restore_fn`-Pointer (Bob-System unterstützt das bereits)
- [ ] Korrekte Tile-Koordinaten aus Bob-Position berechnen; betroffene Tiles neu zeichnen

### M-SCROLL-6: budget.js Erweiterung
- [ ] DrawTilemap Kosten: mapW×mapH×tileH×planes×4 Zyklen (Blitter-Blit pro Tile)
- [ ] ScrollX: ~20 Zyklen (BPLCON1-Write)

---

## Milestone 5: M-MUSIC — Hintergrundmusik

*Entscheidend für Spielgefühl. Ohne Musik klingt das Spiel halb fertig.*

### M-MUSIC-1: Einfacher Note-Sequenzer (Paula-direkt)
Minimale Lösung ohne externe Bibliothek — für einfache Chiptunes.

- [ ] `music.s` Fragment: `_PlayNote ch, period, vol, len` — one-shot auf Paula-Kanal
- [ ] Vorbedingung: Kanal darf nicht von PlaySample belegt sein
- [ ] `_music_seq` DATA: Sequenz von `(ch, period, vol, dur)` Longwords; `$FFFFFFFF` = End/Loop
- [ ] `_music_pos` BSS: aktueller Sequenz-Zeiger
- [ ] VBlank-Hook: `_music_tick` dekrementiert Duration; bei 0 → nächsten Eintrag lesen
- [ ] Blitz2D-API: `PlayMusic "seq_label"` + `StopMusic` + `PauseMusic`
- [ ] Paula-Perioden-Tabelle für Noten A0–C8 (konstantes Data-Array)

### M-MUSIC-2: MOD-Replay (Protracker-kompatibel)
Vollständige Lösung für echte Chiptunes. Hoher Aufwand, aber das ist die Amiga-Art.

- [ ] Externe Protracker-Replay-Routine in m68k-ASM (z.B. P61A oder Wanted Team Replay — Public Domain)
- [ ] INCBIN der .mod-Datei in DATA_C (Chip-RAM wegen DMA)
- [ ] Blitz2D-API: `LoadMOD "song.mod"` + `PlayMOD` + `StopMOD` + `SetMODVolume n`
- [ ] VBlank-Integration: Replay-Routine in `_vblank_hook` aufrufen
- [ ] Achtung: MOD-Replay verwendet alle 4 Paula-Kanäle — PlaySample dann disabled oder auf 0 Kanal beschränkt
- [ ] A-MGR: MOD-Datei importieren + Vorschau (im System-Audio via Web Audio API)

---

## Milestone 6: M-SPRITE — Hardware Sprites

*OCS hat 8 Hardware-Sprites (je 2 Farben + Transparenz) ohne CPU-Kosten. Nützlich für Cursor, Kugeln, kleine Extras.*

### M-SPRITE-1: Sprite-DMA aktivieren
- [ ] `startup.s`: DMACON Sprite-DMA-Bit setzen (nur wenn `_usesSprites` in Codegen)
- [ ] 8 Sprite-DMA-Kanäle (SP0EN–SP7EN = DMACON Bits 0–7)

### M-SPRITE-2: Sprite-Definitionen
- [ ] `LoadSprite idx, "file.spr"` → `.spr`-Format: Sprite-Words (SPRxDATA/SPRxDATB) gepaart
- [ ] Alternativ: `DefineSprite idx, spriteData[]` aus Compile-Time-Daten
- [ ] Chip-RAM INCBIN (Blitter-unabhängig, direkt von DMA gelesen)

### M-SPRITE-3: Copper-Integration
- [ ] Copper-Liste: pro aktiven Sprite je 2 Einträge (SPRxPTH/SPRxPTL)
- [ ] Null-Sprites für inaktive Channels (SPRxCTL = 0)
- [ ] `_SetSpritePos(idx, x, y)` in `sprite.s`: VSTART/HSTART in SPRxPOS/SPRxCTL patchen

### M-SPRITE-4: Blitz2D-API
- [ ] `MoveSprite idx, x, y` — setzt Sprite-Position (Copper-List-Patch)
- [ ] `ShowSprite idx` / `HideSprite idx`
- [ ] Codegen: if `_usesSprites` → DMACON + Copper-Sprite-Einträge in `generate()`

---

## Milestone 7: M-COLL-2 — Pixel-Perfect Collision

*Für Actionspiele mit unregelmässigen Sprite-Formen wichtig.*

- [ ] `ImagesCollide(img1,x1,y1, img2,x2,y2)` → -1/0
  - [ ] Zuerst AABB-Test (wie ImagesOverlap) — bei false sofort 0 zurück
  - [ ] Überlappungs-Rechteck berechnen (4 min/max-Operationen)
  - [ ] Chip-RAM-Scratch-Buffer `_collision_scratch` (BOBS_MAX÷8 Bytes) für Blitter-AND-Ergebnis
  - [ ] Blitter-AND: Maske1 AND Maske2 → Scratch; BLTCON0=$05E8 (D=A AND B, 4-Kanal)
  - [ ] BLTAFWM/BLTALWM korrekt für Randwörter setzen
  - [ ] Ergebnis-Check: `BLTSTAT` Zero-Flag oder Scratch auf Null prüfen
  - [ ] `collision.s` neues Fragment
- [ ] Tests: test-coll-pixel.js

---

## Milestone 8: Asset Pipeline — Ergänzungen

### A-MGR-2: Sound-Konverter
Aktuell müssen Nutzer Sounds manuell in 8-bit signed mono .raw konvertieren (Audacity, SoX). Das ist eine Hürde.

- [ ] A-MGR: Tab "Sound" hinzufügen (neben Palette-Tab)
- [ ] File-Drop oder "Browse"-Button für WAV/AIFF
- [ ] Web Audio API: `decodeAudioData` → Samples extrahieren
- [ ] Resample auf Ziel-Samplerate (z.B. 8287 Hz = Period 428 = A-3); konfigurierbar
- [ ] Konvertieren zu Int8 (−128..127); Big-Endian-Output als `.raw`-File speichern
- [ ] Preview: Wellenform-Canvas; Abspielen im Browser
- [ ] Exportierter `LoadSample`-Code-Snippet in Clipboard

### A-MGR-3: Tilemap-Editor (Basis)
- [ ] Tab "Tilemap" in A-MGR
- [ ] Tileset-Import: PNG → Tile-Strip (einstellbare Tile-Grösse)
- [ ] Grid-Editor: Klick/Drag setzt Tile-ID
- [ ] Export: BASSM-Data-Block (kompatibel mit LANG-H) oder binäres `.map`-File
- [ ] Speichern/Laden als JSON im Projektordner

### A-MGR-4: Sprite-Editor (Basis)
- [ ] Tab "Sprite" in A-MGR
- [ ] Pixel-Raster (max. 16×16, OCS-Palette)
- [ ] Zeichenwerkzeuge: Stift, Fill, Radiergummi
- [ ] Export als `.raw` (planar, kompatibler Header wie LoadImage)

---

## Milestone 9: Build & Deploy

### TOOL-DEPLOY: ADF-Export für echte Hardware
- [ ] `node-adf` oder eigene Implementierung: ADF-Disk-Image schreiben (880 KB)
- [ ] Bootblock schreiben (Standard-DOS-Bootblock oder eigener Loader)
- [ ] Binary als `s/startup-sequence` + Executable in das ADF kopieren
- [ ] Asset-Dateien ebenfalls ins ADF kopieren (wenn sie per INCBIN nicht eingebettet sind)
- [ ] Button "Export ADF" in Toolbar; File-Save-Dialog

### TOOL-PROFILE: Cycle-Annotator
Die Budget-Bars zeigen Gesamtschätzung. Für Optimierung braucht man Auflösung.

- [ ] Peephole-Pass ergänzen: generiertes ASM mit Cycle-Kommentaren annotieren
  - Jede Instruktion: bekannte 68000-Timing-Tabelle (out-of-bag approach: JSON-Map)
  - `move.l Dn,Dn` = 4 Zyklen; `move.l abs,Dn` = 20 Zyklen; etc.
- [ ] Kommentar-Format: `; CYC:20` am Zeilenende
- [ ] IDE: "Profiler"-Modus zeigt Cycle-Wärme als Farb-Gradient im Editor-Gutter
- [ ] Nützlichster Einsatz: Hotspot in Hauptschleife finden

### TOOL-WASM: vAmiga WASM-Update
- [ ] Prüfen ob neuere vAmiga-WASM-Builds verfügbar sind
- [ ] Mouse-Input-Fix (BUG-4) hängt davon ab

---

## Milestone 10: Optimierungen & Performance

### PERF-D: Peephole-Regeln erweitern
- [ ] R6: `move.l #0,X` → `clr.l X` (spart 2 Zyklen + 2 Bytes, kein Immediate nötig)
- [ ] R7: `add.l #N,X` mit N=1..8 und X = Speicher-Operand → `addq.l #N,X`
- [ ] R8: `moveq #0,d0 / tst.l d0` → nur `moveq #0,d0` (tst nach moveq redundant — d0=0 setzt Z)
- [ ] R9: `move.l d0,X / clr.l d0` → `move.l d0,X` (d0 wird sowieso überschrieben)
- [ ] Sicherheit: gleiche Invarianten wie R1–R5 beachten

### PERF-E: Blitter-Wait-Optimierung
- [ ] `_WaitBlit` wird vor jedem Blitter-Aufruf aufgerufen — bei mehreren Blitter-Ops hintereinander doppelt ineffizient
- [ ] Peephole-Idee: aufeinanderfolgende Blitter-Ops zusammenfassen wenn Parameter kompatibel
- [ ] Minimal: `_WaitBlit` am Ende eines Blit (nach BLTSIZE) einsparen wenn nächste Op ihn ohnehin aufruft

### PERF-F: 32-Bit-Multiplikation
- [ ] `muls.l` (68020+) als Option wenn Ziel nicht 68000-kompatibel sein muss
- [ ] Compiler-Flag: `target = 68000|68020` (ECS/AGA-Unterscheidung)
- [ ] 68000-Alternative: 32×32-Bit-Mul via Software-Routine (3× muls.w + Shift)

---

## Priorisierungsübersicht

| Priorität | Milestone | Begründung |
|-----------|-----------|------------|
| **SOFORT** | Bugs BUG-1..3 | Inkonsistenz, kein Aufwand |
| **HOCH** | M1 IDE Quick Wins | Prio per Projektfokus; direkter UX-Gewinn |
| **HOCH** | LANG-G Const | Kleiner Aufwand, nützlich für alle Spiele |
| **HOCH** | LANG-H Data/Read | Essentiell für Level-Daten ohne riesige Array-Inits |
| **MITTEL** | M2 IDE DevEx | Macht den Editor professionell |
| **MITTEL** | M4 M-SCROLL | Blockiert Platformer/Shooter-Genre komplett |
| **MITTEL** | M5 M-MUSIC | Größte Quality-of-Life-Lücke im Spielgefühl |
| **MITTEL** | A-MGR-2 Sound | Senkt Einstiegshürde für neue Nutzer |
| **NIEDRIG** | M6 M-SPRITE | Bobs können substituieren |
| **NIEDRIG** | M7 M-COLL-2 | AABB reicht für die meisten Spiele |
| **NIEDRIG** | LANG-I Strings | Str$() deckt die meisten Fälle |
| **NIEDRIG** | A-MGR-3/4 | Nice-to-have Editoren |
| **LANGFRISTIG** | M9 Deploy | Reale Hardware-Tests nötig erst wenn Spiel fertig |
| **LANGFRISTIG** | M10 Perf | Erst wenn Spiele an Budget-Grenze stossen |

---

## Vollständiges Spiel — Checkliste

Was ein fertiges Amiga-Spiel mit BASSM heute braucht und ob es geht:

| Feature | Status | Workaround |
|---------|--------|------------|
| Grafik-Sprites | OK (DrawBob + Maske) | — |
| Statischer Hintergrund | OK (SetBackground) | — |
| Scrollender Hintergrund | **FEHLT** (M-SCROLL) | Kein Workaround |
| Kollision (AABB) | OK (RectsOverlap) | — |
| Kollision (Pixel) | **FEHLT** (M-COLL-2) | AABB als Näherung |
| Keyboard-Input | OK (KeyDown) | — |
| Joystick-Input | OK (JoyFire etc.) | — |
| Maus-Input | Partiell (Preview buggy) | Joystick als Ersatz |
| Sound-Effekte | OK (PlaySample) | — |
| Musik | **FEHLT** (M-MUSIC) | Kein Workaround |
| Level-Daten | Partiell (Dim + Init-Loop) | Umständlich ohne Data/Read |
| Score-Anzeige | OK (Text + Str$) | — |
| Game-States (Menu etc.) | OK (Select/Case + Funcs) | — |
| Mehrere Screens | OK (Include + Funcs) | — |
| Hardware Sprites | **FEHLT** (M-SPRITE) | DrawBob als Ersatz |
| Echte Hardware | **FEHLT** (kein ADF-Export) | WinUAE manuell |
