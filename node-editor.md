# Implementierungsplan: BASSM Visueller Node-Editor (Epic 7)

Dieses Dokument definiert den phasenweisen Implementierungsplan für den visuellen Blueprint-Editor in BASSM. Ganz nach der Amiga-Philosophie wird das System **ohne externe Canvas/Node-Frameworks** mit einem reinen DOM/SVG-Ansatz aufgebaut.

Die Priorität liegt in den frühen Phasen extrem stark auf flüssiger **UI & UX**, bevor Thematiken wie Datenspeicherung und Code-Generierung im Backend angerührt werden.

---

## Phase 1: Foundation & Viewport Architektur
*Ziel: Ein stabiles, 100% viewport-füllendes Kamerasystem mit unendlichem Drag & Zoom sowie einem mitwachsenden Grid.*

- [x] **Task 1.1: Root-Container & Event-Blocker** ✓
  - Implementiere den Main-Viewport (100% x 100%, `overflow: hidden`).
  - Erstelle das `bnc-ui` Layer (z-index top, position: absolute).
  - Blocke in `bnc-ui` alle Scroll- und Drag-Events (`stopPropagation`), damit Panel-Interaktionen nicht die Welt bewegen.
- [x] **Task 1.2: Das Kamera-System (`bnc-world`)** ✓
  - Lege das `bnc-world` DIV an. Anbindung von Maus-Drag (Mittlere/Rechte Maustaste) für Panning via CSS `transform: translate`.
  - Anbindung des Mausrads zum Zoomen (ausgehend von der Maus-Cursor-Achse) mithilfe der CSS `scale()` Funktion. Etablierung von Min-/Max-Zoom Limits.
- [x] **Task 1.3: Das Infinite Grid (`bnc-grid`)** ✓
  - Rendere das Raster im `bnc-world` Container (oder als dynamischen Background).
  - Unterteile in Minor (leichtes Raster, z.B. alle 10px) und Major (starkes Raster, z.B. alle 100px).
  - Stelle sicher, dass das Raster optisch smooth mitskaliert (CSS-Background-Size oder SVG-Pattern).

## Phase 2: Core Render Objects (Node & Noodle UI)
*Ziel: Das visuelle Fundament der Objekte steht – Nodes sehen aus wie Amiga-Hardware-Bausteine, Kabel fließen weich dazwischen.*

- [x] **Task 2.1: Node-Design & Aufbau (`bnc-nodes`)** ✓
  - Designe das HTML-Template für eine Basis-Node: Header-Bereich (Titel), Body-Bereich mit Links (Eingänge) und Rechts (Ausgänge).
  - Setze CSS-Farbcodierungen der Pins um: Weiß für Exec-Pins, Blau (Int), Grün (String), etc.
- [x] **Task 2.2: Line-Rendering (`bnc-noodles`)** ✓
  - Erstelle ein `<svg>` Overlay, welches 100% von `bnc-world` einnimmt.
  - Baue eine JS-Routintele zum Zeichnen von kubischen Bézier-Kurven zwischen Pin A (Source) und Pin B (Target). Die Kurventangenten müssen horizontal abfließen (S-Kurve).
- [x] **Task 2.3: Die PLAY-Node** ✓
  - Hardcode die instanziierbare `PLAY`-Node auf dem Bildschirm. Setze Flags, sodass sie keine Delete-Funktionen zulässt und im Zentrum (0,0) startet.

## Phase 3: Canvas Interaktionen & State-Management
*Ziel: Nodes lassen sich auf dem Grid bewegen, auswählen und miteinander verkabeln.*

- [x] **Task 3.1: Node-Movement & Graph-Datenmodell** ✓
  - Baue die interne Klasse `GraphState` (hält eine Node-Liste und Edge-Liste).
  - Implementiere Click-and-Drag auf dem Node-Header, um die `translate(x,y)` Werte der Node auszuführen.
  - Sorge für automatische Neubeurteilung (Re-Draw) der SVG-Noodles aller mit der Node verbundenen Pins in Echtzeit während des Drags.
- [x] **Task 3.2: Noodle Instanziierung & User-Wiring** ✓
  - Mouse-Down auf einem Pin startet das Zeichnen einer flexiblen Preview-Noodle (Cursor-gebunden).
  - Mouse-Up über einem validen Drop-Target (Anderer Pin) validiert die Verbindung (Erlaubt? Zyklus?) und trägt sie in den `GraphState` ein.
- [x] **Task 3.3: Selektion & Löschung** ✓
  - Selection-Box: Drag auf dem leeren Grid zieht eine CSS-Box zur Multi-Selektion auf.
  - Delete-Handling: Drücken von <kbd>Entf</kbd> löscht aktuell selektierte Nodes und entfernt automatisch deren angebundene Noodle-Kanten.

## Phase 4: Pickers, Side-Panel & Advanced Workflows
*Ziel: Der Nutzer kann rasend schnell und effizient neue Elemente auf dem Canvas erschaffen, ohne je den Code-Editor zu benötigen.*

- [ ] **Task 4.1: Side-Panel UI**
  - Implementiere das rechte (oder linke) UI-Panel (`bnc-ui`) mit zwei Reitern/Akkordeons: **Variablen** und **Asset-Outliner**.
  - Binde den Asset-Outliner an den Projektpfad, zeige `.iraw` und `.wav` inkl. Miniatur an.
  - Implementiere Drag & Drop aus dem Side-Panel auf den Canvas zur Erstellung spezifischer Nodes (z.B. LoadImage Node gepulled mit Header-Werten).
- [ ] **Task 4.2: Globaler Node-Picker**
  - Doppelklick ins Grid öffnet ein kleines, fixiertes UI-Fenster am Cursor.
  - Biete alle aus `commands-map.json` registrierten Node-Typen gruppiert mit Collapsibles (UI, Math, Logic) an. Schnellsuchfeld ist Pflicht!
- [ ] **Task 4.3: Kontextsensitiver Noodle-Drop Selector**
  - Implementiere die UX-Abkürzung: Ziehe eine Noodle ins "Nichts" und lasse Mousedrop los.
  - Öffne den Picker, aber filtere die Ansicht. Wurde die Noodle z.B. aus einem "Int-Input" gezogen, zeige nur Nodes mit "Int-Outputs" an und auto-verlinke diese nach dem Klick.

## Phase 5: Graphen-Architektur & Subgraphs
*Ziel: Großprojekt-Fähigkeit durch einklappbare Logik.*

- [ ] **Task 5.1: Tab-Bedienung & Kapselung**
  - Implementiere eine obere Tab-Leiste im UI. Der initiale Main-Tab enthält den "PLAY"-Entry.
  - Konstruktion einer "Custom Function" Node erzeugt automatisch Entry/Return-Schattenpins für Input-Argumente.
- [ ] **Task 5.2: Subgraph-Navigation**
  - Doppelklicken auf den Körper einer Custom Function wechselt zu einem frischen (oder bereits angelegten) Canvas-Sateliten im Tab.
  - Der `GraphState` wird umgebaut, sodass er hierarchisch mehrere Graphen (Main + X Subgraphs) halten kann.

## Phase 6: Limitwarnungen & Hardware-Vorschau
*Ziel: Ein Amiga verzeiht keine 3 MB Bilddaten. Der Editor zwingt den Nutzer in Hardware-Grenzen, bevor der erste Compile stattfindet.*

- [ ] **Task 6.1: Hardware-Budget Overlay**
  - Aggregation der Ressourcenkosten pro Node (`Chip-RAM`, `Zyklen`) im Hintergrund via Observer-Pattern (jedes Mal, wenn `GraphState` sich ändert).
  - Visualisierung durch HUD Barometer in der Editor-Toolbar (Analog zu `TOOL-IDE-2`).
- [ ] **Task 6.2: Copper-Zeilen-Timeline**
  - Füge ein statisch skaliertes Panel (Höhe 0 bis 255) neben dem Grid ein.
  - Zeige visuell an, in welcher Zeile Viewports aufgemacht oder Colors verändert werden (Constraints/Überlagerungen markieren sich rot).

## Phase 7: Persistenz & IDE-Tiefenmigration
*Ziel: Was man baut, muss verlässlich gesichert, geladen und in das restliche Projekt verwoben werden.*

- [ ] **Task 7.1: .bnode JSON Struktur**
  - Schreibe einen Serializer für den gesamten `GraphState` → robustes JSON (Versioniert).
  - Schreibe Deserializer mit Rebuild der UI-Nodes/DOM Elemente.
- [ ] **Task 7.2: Tree-View Integration**
  - Mach die `.bnode` Dateien im IDE-Sidepanel doppelklickbar.
  - Starte den Editor als "zweite Ansicht", die den Texteditor versteckt/umschaltet.

## Phase 8: Compilation Engine & BASSM Translator
*Ziel: Aus grafischem Spaghettimonster wird lauffähiges 68000er Amiga-Gold.*

- [ ] **Task 8.1: Topologische Sortierung & Exec-Flow**
  - Baue den Algorithmus, der beim `Generate`-Klick den Graph durchläuft. Startpunkt MUSS die weiße Linie der `PLAY`-Node sein.
  - Verfolge die Nodes und löse Data-Abhängigkeiten (Pins) rekursiv rückwärts auf den Exec-Headlines auf.
- [ ] **Task 8.2: Generator-Pass (AST)**
  - Wandle die korrekte Sortierung in Strings für den BASSM-Dialekt (oder füttere direkt den AST in `codegen.js`).
  - Sammle alle "Setup-Zone" (LoadImage etc.) Komponenten voran, lege alle "Frame-Zone"-Elemente in einen `While 1 ... Wend` Mantel.
- [ ] **Task 8.3: BASSM Reverse Import / Two-Way Sync (Holy Grail / Nice to Have)**
  - *Hinweis:* Epic Games (Unreal Engine) vermeidet ganz bewusst eine bidirektionale Synchronisation zwischen C++ und Blueprints, da die Komplexität und "Spaghetti-Gefahr" durch fehlendes Auto-Layout massiv ist.
  - Dennoch halten wir dieses Feature ("Switch zwischen purer Code-Ansicht und sichtbarem VBE-Graphen") als Langzeit-Vision fest. Egal wie schwierig es ist: BASSM aus bestehendem Text (`.bassm`) retrograd zu parsen und in einen VBE-Blueprint (`.bnode`) zu übersetzen, wäre ein unendlich wertvolles Alleinstellungsmerkmal, das BASSM direkt vor Konkurrenten wie Godot oder Scorpion Engine aufstellt.
