# BASSM Dokumentation Redesign Plan

Dieser Plan beschreibt die Umstrukturierung und Überarbeitung der BASSM-Dokumentation in eine anfängerfreundliche, interaktive und modulare Struktur.

## 🎯 Übergeordnete Ziele
1. **Zielgruppenfokus:** Die Dokumentation richtet sich explizit an Amiga-Anfänger und BASIC-Programmierer. Komplexe interne technische Abläufe (z. B. wie der Compiler Dinge in Assembler oder BSS-Segmenten ablegt) werden in optionale **Hint-Boxen** verlagert.
2. **Modularität:** Das aktuelle monolithische `docs.de.md` wird in thematische Einzel-Seiten zerlegt. Die Anzeige erfolgt dynamisch mittels **Vue Router**.
3. **Beispiel-Driven:** Es soll für jeden BASSM-Befehl ein vollständiges, kopierbares und lauffähiges Code-Beispiel geben.
4. **Verlinkung:** Intelligentes Cross-Linking zwischen Themen (z. B. Verweis von `DrawImage` auf `LoadImage`).
5. **Aufräumen:** Veraltete Features (wie der externe Asset-Manager) werden komplett gestrichen, da sie durch modernere in-IDE Editoren ersetzt wurden.

---

## 🗺️ Meilensteine & Tasks

### Milestone 1: Architektur & Router-Setup
In dieser Phase wird die technische Grundlage im `site/`-Ordner geschaffen, um die Dokumentation als Single-Page-App (SPA) mit Einzelunterseiten darzustellen.

- [ ] **Task 1.1: Vue Router Konfiguration:** Erstellen der Haupt- und Unterrouten (`vue-router`) für die neu entstehende Dokumentations-URL-Struktur (z.B. `/docs/structure`, `/docs/graphics`, etc.).
  > **Implementation Hint:** Nutze die dynamische Import-Funktion von Vue Router (`import()`), um Markdown-Files Lazy zu laden und die Initiale Ladezeit (Payload) klein zu halten.
- [ ] **Task 1.2: Layout & Sidebar:** Implementierung einer übersichtlichen, zweispaltigen Ansicht mit linker Navigations-Sidebar für die Kapitel und einem rechten Content-Bereich.
  > **Implementation Hint:** Baue eine zentrale Konfigurations-Datei (z.B. `sidebar.json`), die die Reihenfolge und Titel der Kapitel steuert, damit Links nicht hardcodiert werden müssen.
- [ ] **Task 1.3: Markdown-it Container aktivieren/konfigurieren:** Einrichten von standardisierten Markdown-Erweiterungen (z.B. `markdown-it-container` Plug-in), um die geforderten "Hint/Info-Boxen" darzustellen.
  > **Implementation Hint:** Passe in der `vite.config.js` die Markdown-it Optionen so an, dass Custom Blocks (z.B. `:::info Nerd-Wissen ... :::`) via spezifischen CSS-Klassen in ansprechende Vue-Komponenten gewandelt werden.
- [ ] **Task 1.4: Ordner & Datei-Struktur vorbereiten:** Generieren eines neuen Ordners `site/src/content/docs/` und Anlegen von leeren `.md`-Dateien für jedes Kapitel aus dem bisherigen Inhaltsverzeichnis (Schritt für Schritt Ersatz des großen `docs.de.md`).
  > **Implementation Hint:** Behalte vorerst die alte `docs.de.md` als Referenz bei und lösche sie erst, wenn alle Unterseiten final geprüft sind.

### Milestone 2: Basis-Sprache & Variablen überarbeiten
Überarbeitung der Anfänger-Konzepte. Hier muss die "Nerd-Terminologie" konsequent aussortiert und verpackt werden.

- [ ] **Task 2.1: Kapitel Programmstruktur, Typen & Kontrollstrukturen:**
    - Migration der Inhalte in die neuen Files.
    - Verschieben technisch tiefer Infos in isolierte Hint-Boxen.
    - Lauffähige Mini-Programme für Schleifen, If-Abfragen und die generelle Variablen-Deklaration einbauen.
  > **Implementation Hint:** Erkläre in Hint-Boxen, warum Division auf dem Amiga langsam, aber Bitshifts (`Shl` / `Shr`) extrem schnell sind. Das ist für Einsteiger nützlich, ohne den Codeflow zu verwirren.
- [ ] **Task 2.2: Arrays & Funktionen:** 
    - Erstellen eines kleinen lauffähigen 1D/2D-Array Beispiels (z.B. Erzeugen eines einfachen Sternenfelds in einem "Dim").
    - Cross-Links zwischen lokalen Variablen in Funktionen und globalen Werten deutlich als Verweis einfügen.
  > **Implementation Hint:** Betone im Array-Kapitel, dass BASSM keine Bounds-Checks durchführt und fehlerhafte Indizes das System crashen lassen könnten.
- [ ] **Task 2.3: Transition Guides für Umsteiger:**
    - Verfassen einer dedizierten Informations-Seite ("Gotchas"), die gezielt auf die Unterschiede zu PC-BlitzBasic, AmiBlitz und anderen Basic-Dialekten eingeht.
  > **Implementation Hint:** Unterteile die Seite explizit in "Für PC-Blitz3D User" (Achtung: Integer only, keine Strings/Floats!) und "Für AmiBlitz User" (Wie matchen die neuen Bild-Befehle alte Konzepte wie `Shape` oder `QBlit`?). Ergänze zudem ein kurzes Mini-Glossar für absolute Anfänger zur Amiga-Terminologie (z.B. Was ist eigentlich eine *Bitplane*?).

### Milestone 3: Grafik, Sound & Input (Die Kernfunktionen)
Dies ist oft die faszinierendste, aber auch anspruchsvollste Phase für neue Spieleentwickler. Befehle wie `DrawImage` oder `Box` müssen visuell eindeutig erklärt werden.

- [ ] **Task 3.1: Grafik-Grundlagen & Zeichenbefehle:**
    - Migration und Trennung der ehemals großen Kapitel "Systemsteuerung", "Grundlagen" und "Farben/Zeichenbefehle".
    - Komplettes Boilerplate-Beispiel hinzufügen: `Graphics` → `ClsColor` → `Cls` → Rechteck formatieren → `ScreenFlip`.
  > **Implementation Hint:** Zeichne eine kleine Diagramm-Grafik ein, die Double-Buffering visuell (Front- vs Backbuffer) aufzeigt, da `ScreenFlip` für viele Webentwickler neu ist.
- [ ] **Task 3.2: Sound & Eingabe:**
    - Beispiele für direkte Tastatursteuerung (`WaitKey`, `KeyDown`) und Controller (`JoyX`, `Joyfire`).
    - Lauffähiges Beispiel: Ein simples Rechteck, das per Mausklick seine Farbe ändert oder sich über die Tastatur nach rechts/links bewegen lässt.
  > **Implementation Hint:** Stelle sicher, dass Endlosschleifen der Beispiele (`While 1`) via `WaitVbl` oder `ScreenFlip` blockiert werden, um Einsteigern nicht direkt saubere Amiga CPU-Budgets kaputt zu machen.
- [ ] **Task 3.3: Bobs & Tilemaps (Advanced Features):**
    - Migration der fortgeschrittenen Themen (Viewports, Bobs, Tilemap-Scrolling) in eigene Unterseiten.
    - Hardcore-Performancedaten konsequent in separate Hint-Boxen packen.
  > **Implementation Hint:** Packe Zykluskosten-Schätzungen (wie "DrawTilemap kostet aktuell ca 70.000 Zyklen") explizit als Advanced-Info-Kasten dazu.

### Milestone 4: Veraltete Inhalte entfernen & Feinschliff
Aufräumen von Altlasten, Finalisierung und Qualitätssicherung.

- [ ] **Task 4.1: Asset Manager löschen:** Lokalisieren und restloses Löschen des alten "Asset Manager" Kapitels.
  > **Implementation Hint:** Führe eine projektweite Volltextsuche (Grep) über alle neuen MD-Files aus, um jeden verbliebenen Verweis auf den "Asset Manager" oder "Vorkonvertierte RAW-Bilder" zu ersetzen, da die IDE das jetzt intern löst.
- [ ] **Task 4.2: Aktualisierung der IDE-Doku:** Sektionen zur IDE so ändern, dass sie direkt Bezug auf die integrierten Editoren nehmen.
  > **Implementation Hint:** Füge aktuelle Screenshots aus den neuen Image / Tilemap Tabs als Assets ein.
- [ ] **Task 4.3: Das "Vollständige Beispiel":** Breakout-Code umfassend und anfängerfreundlich kommentieren und ablegen.
  > **Implementation Hint:** Spalte den Code in Reitern auf (z.B. "Logik", "Zeichnen", "Setup") oder hebe in Markdown die wichtigsten Code-Passagen gelb hervor.
- [ ] **Task 4.4: Router & Cross-Linking QA:** Systematisches Prüfen, ob markdown-interne Link-Anker reibungslos funktionieren.
  > **Implementation Hint:** Erstelle ggf. ein Link-Validation-Script für Markdown in CI/CD, oder prüfe es händisch über alle Links hinweg, um Tote Links (`#LoadImage`) auf andere `.md` Files abzufangen.

### Milestone 5: Interaktive Erweiterungen & Zusatzfeatures
Nach dem grundlegenden Refactoring werden funktionale Highlights für ein besseres Lern-Erlebnis integriert.

- [ ] **Task 5.1: i18n & Zweisprachigkeit:** Aufbau der Router- und Ordnerstrukturen für Deutsch und Englisch.
  > **Implementation Hint:** Trenne die Routen statisch (z.B. `/de/docs/...` und `/en/docs/...`) anstatt ein komplexes dynamisches Vue-i18n Setup zu wählen, da reine Markdown-Dokumentationen durch URL-Trennung SEO-freundlicher sind.
- [ ] **Task 5.2: "Copy-to-Clipboard" Feature:** Implementierung eines Copy-Buttons für jeden Code-Block.
  > **Implementation Hint:** Integriere ein Custom Markdown-it Render Rule, welches an jeden `<pre><code>` Block automatisch einen Vue-kompatiblen Copy-Button-Container anhängt.
- [ ] **Task 5.3: Getting Started Tutorial:** Verfassen einer 3-teiligen Tutorial-Reihe ("Mein erstes Spiel / Pong").
  > **Implementation Hint:** Biete am Ende jeden Tutorial-Schritts den kompletten bisherigen Code zum Kopieren an, da Beginner oft kleine Zwischenschritte vergessen und der Code nicht mehr kompiliert.
- [ ] **Task 5.4: Interaktives Cheat-Sheet:** Erstellen einer Übersichts-Route (`/docs/cheatsheet`) als filterbare Referenz.
  > **Implementation Hint:** Generiere die Datenbasis aus einem `cheatsheet.json`. Nutze Vue-Komponenten (v-for), um die Grid-Karten zu rendern, anstatt es hardcodiert in Markdown zu schreiben.
- [ ] **Task 5.5: "Run in IDE" / vAmiga Integration (Langzeitziel):** Implementieren eines "Play"-Buttons an den Dokumentations-Codeblöcken für blitzschnelles Starten des Emulator aus der Website heraus.
  > **Implementation Hint:** Nutze die Localhost-API Vorgehensweise statt Custom Protocol Handlern. Die statische `bassm-amiga.com` Website führt ein `fetch()` oder HTTP-POST Request via Browser an `http://localhost:<PORT>/play` aus. Ist die BASSM Electron Maschine im Hintergrund geöffnet, fängt sie (z.B. via Express.js) den Request samt Quellcode ab und bootet den Emulator. So agiert der Browser des Users Client-Side mit seiner eigenen, laufenden Desktop-App, ohne Backend-Aufwand!
