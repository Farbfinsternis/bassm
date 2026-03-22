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

### BUG-8: IDE-COLOR — Farb-Swatches werden nicht gerendert
`inlineClassName`-Dekorationen auf dem Keyword-Range werden korrekt registriert
(`createDecorationsCollection.set()` / `deltaDecorations` liefern gültige IDs),
aber die CSS-Klasse erscheint nicht im Editor. CSS-Injektion via `sheet.insertRule()`
und `createElement('style')` wurden beide getestet. Statische Klassen aus `style.css`
funktionieren (Debugging bestätigt). Ursache unklar — möglicherweise Monaco 0.55
überschreibt `inlineClassName`-Stile durch eigenes Tokenizer-CSS mit höherer Spezifität.

**Was bekannt ist:**
- `inlineClassName` auf non-zero-width range: Dekorations-IDs werden zurückgegeben ✓
- Statische CSS-Klasse aus `style.css` + `inlineClassName` → Klasse ist **sichtbar** ✓
- Dynamisch injizierte CSS-Klasse + `inlineClassName` → Klasse ist **nicht sichtbar** ✗

**Verdacht:** Monaco's tokenizer-generierte `mtk*`-Klassen haben höhere Spezifität als
dynamisch injiziertes CSS. Lösung: CSS in `style.css` vorgenerieren oder Spezifität erhöhen
(z.B. `.monaco-editor .view-lines .bsm-sw-...`).

- [ ] Ursache klären: Browser-DevTools → Element-Inspector auf dekoriertem Span prüfen
      ob die `bsm-sw-*`-Klasse im DOM vorhanden ist
- [ ] Falls Klasse im DOM: Spezifität erhöhen (`.monaco-editor .view-lines .bsm-sw-...`)
- [ ] Falls Klasse nicht im DOM: `createDecorationsCollection` vs. `model.deltaDecorations` testen

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

### ~~BUG-6: muls.w — kein Overflow-Schutz bei Multiplikation~~ ✓ (partial)
Codegen emittiert `muls.w` (16×16→32 bit). Bei Operanden > 32767 entstehen falsche Ergebnisse ohne Fehlermeldung.

- [x] Compiler-Fehler wenn Literal-Operand außerhalb −32768..32767: `_emitMultiplyByConst` wirft mit klarer Meldung + Hinweis auf Variable
- [ ] Langfristig: `muls.l` (32×32→64) für Runtime×Runtime-Fall (beide Operanden variabel)

### ~~BUG-7: budget.js ignoriert RectsOverlap/ImagesOverlap/PeekB-Overhead~~ ✓
Kollisionsprüfungen und Hardware-Zugriffe kosten messbare Zyklen (movem + 4× cmp), sind aber nicht in der Budget-Schätzung.

- [x] `_estimateLineCycles`: RectsOverlap (~120 Zyklen), ImagesOverlap (~80 Zyklen), ImageRectOverlap (~80 Zyklen) ergänzt
- [x] PeekB/W/L (~20 Zyklen) und PokeB/W/L/Poke (~20 Zyklen) ergänzt

---

## ~~Milestone 1: IDE — Quick Wins~~ ✓ 2026-03-20

### ~~IDE-ERR: Fehler-Marker im Editor~~ ✓
- [x] Exception-Message parsen (`line N` / `Zeile N` Regex)
- [x] `monaco.editor.setModelMarkers()` mit `MarkerSeverity.Error` — rote Unterwellenlinie in der richtigen Zeile
- [x] Marker bei nächstem erfolgreichen Run gecleart

### ~~IDE-SYN: Syntax-Highlighting vervollständigen~~ ✓ (= BUG-1)
- [x] Alle fehlenden Commands in `editor-init.js` eingetragen (35 Commands + 20 Builtins)
- [x] `registerCompletionItemProvider` mit Tab-Stop-Snippets für alle Commands

### IDE-COLOR: Inline Farb-Swatches — ✗ offen (siehe BUG-8)
- [ ] Farbige Markierung auf `PaletteColor`- und `CopperColor`-Zeilen

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

## Milestone 2b: TOOL-TREE — Projekt-Manager Überarbeitung

*Der aktuelle Projekt-Manager hat keine Icons, keine visuelle Differenzierung zwischen
Dateitypen, und kein Kontext-Menü zum Anlegen/Umbenennen/Löschen. Diese Milestone
macht ihn zu einem echten Werkzeug.*

### TOOL-TREE-1 — Visuelle Überarbeitung (Icons + Farben) ✓
*`bassm.js` + `style.css`.*

- [x] Icon-Spans (`.tree-icon`) pro Eintrag: `◆`/`◇` bassm, `▪` png, `∼` audio, `▫` mask, `–` sonstiges
- [x] Typ-Klassen: `.tree-item-bassm`, `.tree-item-img`, `.tree-item-audio`, `.tree-item-mask`, `.tree-item-other`
- [x] Ordner nutzen `▸`/`▾` als Collapse-Toggle; `.tree-dir` ebenfalls flex

### TOOL-TREE-2 — Kontext-Menü + Neue Datei / Neuer Ordner ✓
*IPC in `main.js` + `preload.js`, UI in `bassm.js`.*

- [x] `bassm:create-file`, `bassm:create-dir`, `bassm:delete-item` mit Path-Traversal-Schutz
- [x] Rechtsklick **Panel-Header** + **leerer Bereich**: Neue Datei, Neuer Ordner (root-level)
- [x] Rechtsklick **Ordner**: Neue Datei hier, Neuer Ordner hier, Trennlinie, Ordner löschen
- [x] Rechtsklick **`.bassm`**: Umbenennen, Löschen (main.bassm: kein Löschen)
- [x] Rechtsklick **`.png`**: Convert (Asset Manager), Trennlinie, Löschen
- [x] Inline-Input direkt im Tree (kein Modal); Enter bestätigt, Escape bricht ab
- [x] Löschen mit native `confirm()`-Dialog

### TOOL-TREE-3 — Umbenennen (Inline) ✓
- [x] `bassm:rename-item` — `fs.renameSync`; aktive Datei-Referenz wird nachgeführt
- [x] Doppelklick auf `.bassm` → Inline-`<input>` ersetzt den Namen-Span
- [x] Enter bestätigt, Escape bricht ab

### TOOL-TREE-4 — Tree-State-Persistenz ✓
- [x] `_treeCollapsed` Set; Key = `bassm-tree-collapsed:<projectDir>` in `localStorage`
- [x] `_loadTreeState()` beim Projekt-Öffnen; `_saveTreeState()` bei jedem Collapse/Expand
- [ ] Pfeiltasten ↑↓ + Enter (Tastaturnavigation — noch offen)

---

## Milestone 2c: M-AUTOMASK — Automatische Farbe-0-Transparenz für Bobs

*Bobs ohne `LoadMask` machen derzeit einen direkten Bitplane-Copy ohne Transparenz.
Der Normalfall in Spielen ist aber: Farbe 0 = transparent (wie in Blitz2D/Blitz Basic).
Ziel: `LoadMask` bleibt als explizite Overridemöglichkeit erhalten, aber jedes Bob-Image
bekommt automatisch eine korrekte Maske — ohne externe `.mask`-Datei.*

**Grundprinzip:**
Pixel mit Palette-Index 0 haben alle Bitplane-Bits = 0.
Maske = bitweises OR aller Bitplanes → 0 = transparent (Farbe 0), 1 = opak (jede andere Farbe).

### M-AUTOMASK-1: Auto-Mask-Generierung im PNG→Amiga-Konverter (main.js)

*Der Konverter erzeugt bereits `.raw`-Dateien mit Amiga-Planar-Daten.
Er soll jetzt zusätzlich eine `.mask`-Datei (Raw-1bpp) erzeugen.*

- [ ] Nach der Bitplane-Konvertierung: für jede Zeile `mask_byte = plane0_byte | plane1_byte | … | plane_{d-1}_byte`
- [ ] Ergebnis als `<basename>.mask` neben der `.raw`-Datei speichern (z.B. `player.raw` → `player.mask`)
- [ ] Auto-Mask nur erzeugen wenn das Bild mindestens 1 Nicht-Farbe-0-Pixel enthält (sonst Vollmaske = $FF per Byte)
- [ ] Bestehende explizite `.mask`-Dateien werden *nicht* überschrieben (Datei-Existenz prüfen)

### M-AUTOMASK-2: codegen.js — Auto-Mask automatisch verknüpfen

*`_imageAssets` kennt bereits Filename und Label. Das Auto-Mask-Label wird daraus abgeleitet.*

- [ ] `_imageAssets`-Einträge um `autoMaskLabel` erweitern: `_img_N_mask` (analog zu `_img_N`)
- [ ] `_collectVars` (LoadImage/LoadAnimImage): Auto-Mask-Filename = `basename + ".mask"` → in `_maskAssets` eintragen **sofern kein explizites `LoadMask` für diesen Index vorhanden**
- [ ] `getAssetRefs()`: Auto-Mask-Filename ebenfalls als Asset-Referenz zurückgeben (damit `main.js` die Datei in das tmpDir kopiert)
- [ ] `DrawBob`-Codegen: Reihenfolge bleibt — `_maskAssets.get(idx)` trifft jetzt auch Auto-Masks; kein separater Pfad nötig

### M-AUTOMASK-3: bobs.s — keine Änderung

*`_BltBobMaskedFrame` und `_DrawImageFrame` sind bereits korrekt.
`maskptr != 0` → Masked Blit ($CA), `maskptr == 0` → Direct Copy.
Durch M-AUTOMASK-2 ist `maskptr` für jedes Bob-Image immer gesetzt.*

- [ ] Verifizieren: direkter Copy-Pfad (`_DrawImageFrame`) wird durch Auto-Mask nicht mehr erreicht — Fallback bleibt aber für den Fall dass die `.mask`-Datei fehlt (Compiler-Warnung statt Fehler)

### M-AUTOMASK-4: IDE / Asset Manager

- [ ] Asset-Manager-Konverter: nach erfolgreichem PNG-Import Hinweis anzeigen: `"player.mask" automatisch generiert`
- [ ] Tree-View: `.mask`-Dateien die neben einer gleichnamigen `.raw` liegen, mit `(auto)` oder gedimmtem Icon kennzeichnen
- [ ] `commands-map.json` + Hover-Doku: `LoadMask`-Beschreibung aktualisieren → `"optional — Farbe 0 wird standardmäßig als transparent behandelt"`

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

## Milestone 3b: M-DYNIMG — Laufzeit-Assets

*`LoadImage`, `LoadSample` etc. laden immer zur Laufzeit via dos.library. Kein INCBIN mehr.
Assets liegen neben der `.exe`. Blitz2D-kompatibles Verhalten.*

### T1 — BSS Pointer-Tabelle: Images
- [ ] `_img_N: dc.l 0` in BSS (statt INCBIN-Label `_img_N_raw`)
- [ ] INCBIN-Emit für Images in `generate()` entfernen
- [ ] `getAssetRefs()` bleibt erhalten (jetzt für Output-Dir-Copy)

### T2 — `dosio.s` Fragment
- [ ] `_LoadToChip(a0=filename, a1=BSS-Slot)` — dos.Open → Seek(END) → AllocMem(MEMF_CHIP) → Read → Close → ptr speichern
- [ ] `_LoadToPub(a0=filename, a1=BSS-Slot)` — identisch mit MEMF_PUBLIC (für Fonts)
- [ ] Fehler: AllocMem-Fail → `jsr _exit`

### T3 — LoadImage → Startup-Emission
- [ ] Codegen emittiert pro `LoadImage` in der Setup-Sektion:
  `lea _img_N_filename,a0 / lea _img_N,a1 / jsr _LoadToChip`
- [ ] Dateiname als `dc.b` in DATA-Segment (null-terminiert)
- [ ] `LoadAnimImage` gleicher Pfad (selber Header-Aufbau)

### T4 — DrawImage / SetBackground / BOBs: `lea` → `move.l`
- [ ] Alle `lea _img_N_raw,a0` → `move.l _img_N,a0` in Codegen
- [ ] Betrifft: `DrawImage`, `DrawImageFrame`, `SetBackground`, `_AddBob` (imgptr im Slot)
- [ ] Header-Offsets (w/h/rowbytes) bleiben identisch — Daten via Pointer erreichbar

### T5 — ImagesOverlap / ImageRectOverlap: w/h zur Laufzeit
- [ ] Bisher: `move.w _img_N_raw+0,dX` (compile-time Label-Offset)
- [ ] Neu: `move.l _img_N,aX / move.w (aX),dX / move.w 2(aX),dY`
- [ ] Compile-time-Optimierung entfällt; immer Laufzeit-Pfad

### T6 — FreeImage Befehl
- [ ] Neuer Befehl `FreeImage n` in `commands-map.json` + Codegen
- [ ] Inline: `move.l _img_N,a0 / <size aus Header> / FreeMem / clr.l _img_N`

### T7 — BSS Pointer-Tabelle + Startup-Emission: Samples
- [ ] `_snd_N: dc.l 0` in BSS; kein INCBIN mehr
- [ ] `_snd_N_size: dc.l 0` — Dateigröße neben Pointer speichern (für FreeSample)
- [ ] Startup emittiert `lea`+`jsr _LoadToChip` analog T3
- [ ] `_PlaySample` / `_PlaySampleOnce`: `move.l _snd_N,a0` statt `lea _snd_N_raw,a0`

### T8 — FreeSample Befehl
- [ ] `FreeSample n` → `FreeMem(_snd_N, _snd_N_size) / clr.l _snd_N`

### T9 — LoadMask → Laufzeit
- [ ] `_mask_N: dc.l 0` in BSS; Startup-Emission `jsr _LoadToChip`
- [ ] `_BltBobMasked`: `move.l _mask_N,a1` statt `lea _mask_N_raw,a1`

### T10 — LoadFont → Laufzeit
- [ ] Font-Daten sind kein Chip-RAM → `_LoadToPub`
- [ ] `_active_font_data` zeigt auf geladenen Block

### T11 — Asset-Pipeline: Output-Dir statt tmpDir
- [ ] `main.js`: Assets nicht mehr nach tmpDir kopieren
- [ ] Nach erfolgreichem vlink: alle referenzierten Assets ins Output-Verzeichnis kopieren (neben `.exe`)

### T12 — budget.js: Chip-RAM-Schätzung anpassen
- [ ] INCBIN-Contributions für Images/Sounds entfernen
- [ ] Hinweistext: "Runtime-Assets: Chip-RAM zur Compile-Zeit unbekannt"

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

### PERF-G: Interleaved Bitplanes — BOB-Blitting 5× schneller

*Größter einzelner Performance-Gewinn für BOB-intensive Spiele. Statt separater Plane-Puffer werden alle
Planes verschränkt im Speicher abgelegt: Zeile0-Plane0, Zeile0-Plane1, …, Zeile0-Plane4, Zeile1-Plane0, …*

*Effekt: Ein Blitter-Pass blittet alle Planes gleichzeitig statt 5 getrennte. Bei 10 BOBs: ca. 5× weniger
Blitter-Zeit. Voraussetzung für Chaos-Engine-Komplexität auf einem A500.*

- [ ] `Graphics`-Erweiterung: optionaler vierter Parameter `INTERLEAVED` — `Graphics 320,256,5,1`
- [ ] `graphics.s`: `_scr_bpl_stride` BSS-Variable (= `bpr × depth`); Copper-List-Einträge BPL1PT…BPL5PT
      mit `_scr_bpl_stride`-Abstand statt `bpr`-Abstand
- [ ] `cls.s`: Blitter füllt gesamten verschränkten Block in einem Pass —
      `BLTSIZE = (height × depth) Zeilen × (bpr / 2) Words`; ein Aufruf statt `depth` Aufrufe
- [ ] `box.s`: `BLTDMOD = (_scr_bpl_stride - word_width × 2)`; ein Blitter-Pass über alle Planes
- [ ] `bobs.s`: `_BltBobMaskedFrame` — BLTDMOD/BLTAMOD aus `_scr_bpl_stride` berechnen;
      Single-Pass über alle Planes; Minterm + Shift-Berechnung bleiben identisch
- [ ] `DrawImage`-Pfad: analog BOBs; Interleaved-Source und Interleaved-Destination
- [ ] A-MGR PNG-Konverter: Interleaved-Ausgabe erzeugen wenn Projekt-Flag gesetzt
- [ ] Tileset für M-SCROLL (PERF-J): ebenfalls interleaved konvertieren
- [ ] Budget-Schätzung: BOB-Blitter-Zyklen durch `depth` dividieren

### PERF-H: DBRA für Zählschleifen

*`dbra dn,label` (10 Zyklen) ist schneller als `sub.l #1,dn / bne.s label` (8+10 = 18 Zyklen)
und spart 2 Bytes. Gilt für alle For-Schleifen mit absteigendem Zähler.*

- [ ] Codegen `_genFor`: bei `Step = -1` und Integer-Zähler → `dbra`-Loop emittieren statt `sub+bne`
- [ ] Aufsteigende For-Schleifen optional: Count-down intern (`to - from` Iterationen; DBRA zählt rückwärts)
- [ ] Peephole-Regel (R10): `subq.l #1,dn / bne.s label` → `dbra dn,label`
- [ ] Einschränkung: DBRA zählt 16-Bit → max 65535 Iterationen; Compiler-Warnung bei größerem Range

### PERF-I: Register-Allocation für heiße Schleifen

*Derzeit wird jede Variable pro Zugriff aus BSS geladen (`move.l _var_x,d0`). Innerhalb einer
For-Schleife kann der Zähler in einem Register gehalten werden.*

- [ ] Codegen `_genFor`: Schleifenzähler für die Dauer der Loop in `d2` halten (kein BSS-Roundtrip)
- [ ] Einfache Heuristik: Variablen die ausschließlich innerhalb der Schleife gelesen/geschrieben werden
      → `d3`/`d4` (callee-save nach 68k-Konvention)
- [ ] Invariante: Loop darf keinen JSR enthalten (Funktionsaufruf darf d2–d4 clobbern) — Prüfung im Codegen
- [ ] Register-Cache bleibt deaktiviert innerhalb von Function-Frames (LINK/UNLK — bereits so)

### PERF-J: Screen-to-Screen-Blit für M-SCROLL

*Statt Tile-by-Tile-Blitter-Kopien: ein einziger großer Blitter-Shift-Blit der den sichtbaren Bereich
um scrollX Pixel verschiebt. Danach nur den freigewordenen Rand-Streifen mit neuen Tiles befüllen.*

*Das ist die Kernoptimierung hinter Chaos Engine, Xenon 2 und anderen OCS-Scrollern. Setzt M-SCROLL voraus.*

- [ ] `tilemap.s`: `_ScrollScreen(dx, dy)` — Shift berechnen und BLTCON1 setzen
- [ ] Horizontal: `BLTCON1 = (dx & 0xF) << 12`; Source-Offset = `dx >> 4` Words;
      BLTAMOD / BLTDMOD = `bpr - screen_width_words × 2 - 2` (Shift-Überlauf-Wort)
- [ ] BLTA und BLTD zeigen auf denselben Back-Buffer (Screen-to-Screen, kein zweiter Puffer nötig)
- [ ] Nach dem Blit: nur den freigewordenen Pixel-Streifen (1–16px breit) mit Rand-Tiles befüllen
      → deutlich weniger Tile-Blits als bei vollständigem Redraw
- [ ] Vertikal: Source-Offset = `dy × bpr`; horizontalen Streifen oben/unten mit Tiles auffüllen
- [ ] Mit PERF-G (Interleaved): ein Shift-Blit für alle Planes — nochmals geringerer Overhead

### PERF-K: Copper-basierte Mitte-Frame-Effekte

*Der Copper läuft parallel zur CPU und kostet keinerlei CPU-Zeit. Palette, Bitplane-Pointer und
andere Register können zeilengenau geändert werden — für Split-Screen, Raster-Bars und Parallax.*

- [ ] `CopperMove y, reg, val` — neuer Low-Level-Befehl: schreibt `MOVE reg,val` an Scanline y
      in die aktive Back-Copper-Liste (beide Listen werden gepatcht)
- [ ] `CopperWait y, x` — Copper-WAIT an Beam-Position (für präzises Timing-Control)
- [ ] Anwendungsfall Split-Screen: `CopperMove hud_line, BPLCON0, 0` → Bitplanes ab HUD-Linie aus;
      HUD-Inhalt via Hardware-Sprites oder separatem kleinen Bitplane-Bereich
- [ ] Anwendungsfall Parallax: Bitplane-Pointer mitte-Frame patchen → Hintergrund-Plane scrollt
      mit anderem Offset als Vordergrund-Plane (kein zusätzlicher CPU-Aufwand)
- [ ] Anwendungsfall Raster: `CopperColor` ist bereits implementiert; `CopperMove` verallgemeinert es
      auf beliebige Custom-Register
- [ ] Einschränkung: Copper-Listen sind Double-Buffered — Codegen patcht immer Back-Liste

---

## Priorisierungsübersicht

| Priorität | Milestone | Begründung |
|-----------|-----------|------------|
| **SOFORT** | Bugs BUG-1..3 | Inkonsistenz, kein Aufwand |
| **HOCH** | M1 IDE Quick Wins | Prio per Projektfokus; direkter UX-Gewinn |
| **HOCH** | LANG-G Const | Kleiner Aufwand, nützlich für alle Spiele |
| **HOCH** | LANG-H Data/Read | Essentiell für Level-Daten ohne riesige Array-Inits |
| **MITTEL** | M2 IDE DevEx | Macht den Editor professionell |
| **MITTEL** | M3b M-DYNIMG | Blitz2D-Kompatibilität; nötig vor Public Release |
| **MITTEL** | M4 M-SCROLL | Blockiert Platformer/Shooter-Genre komplett |
| **MITTEL** | M5 M-MUSIC | Größte Quality-of-Life-Lücke im Spielgefühl |
| **MITTEL** | A-MGR-2 Sound | Senkt Einstiegshürde für neue Nutzer |
| **NIEDRIG** | M6 M-SPRITE | Bobs können substituieren |
| **NIEDRIG** | M7 M-COLL-2 | AABB reicht für die meisten Spiele |
| **NIEDRIG** | LANG-I Strings | Str$() deckt die meisten Fälle |
| **NIEDRIG** | A-MGR-3/4 | Nice-to-have Editoren |
| **LANGFRISTIG** | M9 Deploy | Reale Hardware-Tests nötig erst wenn Spiel fertig |
| **LANGFRISTIG** | M10 PERF-D/E/F | Erst wenn Spiele an Budget-Grenze stossen |
| **HOCH** | PERF-G Interleaved Bitplanes | 5× BOB-Speedup; Voraussetzung für Chaos-Engine-Komplexität auf A500 |
| **MITTEL** | PERF-H DBRA | Kleiner Aufwand, messbare Beschleunigung aller Zählschleifen |
| **MITTEL** | PERF-I Register-Allocation | Sichtbar in datenintensiven Schleifen (Tilemap, KI-Update) |
| **MITTEL** | PERF-J Screen-to-Screen-Blit | Erst nach M-SCROLL relevant; dann aber kritisch für 25fps-Scrolling |
| **NIEDRIG** | PERF-K Copper-Effekte | Visuelle Extras; CopperColor bereits vorhanden |

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
| 25fps mit 15+ BOBs + Scrolling | **FEHLT** (PERF-G Interleaved) | Ohne Interleaved: ~5–8 BOBs realistisch |
