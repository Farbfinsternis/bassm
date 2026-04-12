# macOS-Support — Implementierungsplan

> **Stand:** 2026-04-04
> **Ziel:** BASSM als native Electron-App auf macOS (Intel + Apple Silicon) ausliefern
> **Geschätzter Aufwand:** 2–3 Sessions

---

## Ist-Zustand

BASSM unterstützt heute **Windows** und **Linux**:

| Komponente | Windows | Linux | macOS |
|---|---|---|---|
| Electron-App | ✅ Portable .exe | ✅ AppImage | ❌ Fehlt |
| vasmm68k_mot | ✅ `bin/vasmm68k_mot.exe` | ✅ `bin/vasmm68k_mot` | ❌ Fehlt |
| vlink | ✅ `bin/vlink.exe` | ✅ `bin/vlink` | ❌ Fehlt |
| `main.js` Plattform-Logik | ✅ `IS_WIN` | ✅ Fallback (non-Windows) | ⚠️ Funktioniert teilweise |
| `fs.watch` recursive | ✅ Nativ | ❌ Nur root-level | ✅ Nativ (wie Windows) |

### Was heute schon funktioniert (ohne Änderung)

- **`main.js`**: Die Plattform-Logik (`IS_WIN ? '.exe' : ''`) erkennt macOS korrekt
  als Non-Windows → schlägt den extensionlosen Binary-Pfad ein (wie Linux). **macOS
  würde sofort funktionieren wenn die nativen Binaries im `bin/`-Ordner lägen.**
- **`fs.watch({ recursive: true })`**: Zeile 31 in `main.js` hat den Kommentar
  `recursive is only supported on Windows and macOS` — aber aktuell wird `recursive`
  nur bei `IS_WIN` gesetzt. Für macOS muss das erweitert werden (siehe T3).
- **Electron auf macOS**: Monaco Editor, WebContentsView, IPC — alles plattformunabhängig.
- **vAmiga WASM-Emulator**: WebAssembly ist plattformunabhängig; kein Handlungsbedarf.

---

## Phase 1: Binaries (vasmm68k_mot + vlink für macOS)

### T1 — vasmm68k_mot für macOS kompilieren

**Quelle:** http://sun.hasenbraten.de/vasm/

vasm ist in reinem C geschrieben und kompiliert nativ auf macOS. Es werden keine
externen Abhängigkeiten benötigt (kein autoconf, kein cmake) — nur Apple Command
Line Tools (`xcode-select --install`).

**Build-Schritte (auf macOS oder in CI):**
```bash
curl -O http://sun.hasenbraten.de/vasm/daily/vasm.tar.gz
tar -xzf vasm.tar.gz
cd vasm
make CPU=m68k SYNTAX=mot
# → erzeugt ./vasmm68k_mot
```

**Universal Binary (Intel + Apple Silicon):**
```bash
# Für Intel (x86_64):
arch -x86_64 make CPU=m68k SYNTAX=mot
cp vasmm68k_mot vasmm68k_mot_x86_64
make clean

# Für Apple Silicon (arm64):
arch -arm64 make CPU=m68k SYNTAX=mot
cp vasmm68k_mot vasmm68k_mot_arm64

# Universal Binary erzeugen:
lipo -create -output vasmm68k_mot vasmm68k_mot_x86_64 vasmm68k_mot_arm64
```

**Ziel-Datei:** `bin/darwin/vasmm68k_mot` (Universal Binary, ~2 MB)

### T2 — vlink für macOS kompilieren

**Quelle:** http://sun.hasenbraten.de/vlink/

Identischer Prozess:
```bash
curl -O http://sun.hasenbraten.de/vlink/daily/vlink.tar.gz
tar -xzf vlink.tar.gz
cd vlink
make
# → erzeugt ./vlink
```

Universal Binary analog zu T1.

**Ziel-Datei:** `bin/darwin/vlink` (Universal Binary, ~2 MB)

### Alternative: GitHub Actions CI

Statt manuell auf einem Mac zu kompilieren, können die Binaries automatisiert
in einer CI-Pipeline gebaut werden:

```yaml
# .github/workflows/build-tools-macos.yml
name: Build vasm/vlink for macOS
on: workflow_dispatch

jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Build vasm (arm64)
        run: |
          curl -O http://sun.hasenbraten.de/vasm/daily/vasm.tar.gz
          tar -xzf vasm.tar.gz
          cd vasm && make CPU=m68k SYNTAX=mot
          cp vasmm68k_mot ../vasmm68k_mot_arm64
          make clean

      - name: Build vasm (x86_64)
        run: |
          cd vasm
          arch -x86_64 make CPU=m68k SYNTAX=mot
          cp vasmm68k_mot ../vasmm68k_mot_x86_64

      - name: Create Universal Binary (vasm)
        run: |
          lipo -create -output vasmm68k_mot vasmm68k_mot_x86_64 vasmm68k_mot_arm64

      - name: Build vlink (arm64)
        run: |
          curl -O http://sun.hasenbraten.de/vlink/daily/vlink.tar.gz
          tar -xzf vlink.tar.gz
          cd vlink && make
          cp vlink ../vlink_arm64
          make clean

      - name: Build vlink (x86_64)
        run: |
          cd vlink
          arch -x86_64 make
          cp vlink ../vlink_x86_64

      - name: Create Universal Binary (vlink)
        run: |
          lipo -create -output vlink vlink_x86_64 vlink_arm64

      - name: Upload Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: macos-tools
          path: |
            vasmm68k_mot
            vlink
```

---

## Phase 2: Electron-App Anpassungen

### T3 — `main.js`: Plattform-Erkennung erweitern

**Datei:** `main.js` (Zeile 14–16, 31, 59–62)

Aktuell:
```js
const IS_WIN    = process.platform === 'win32';
const BIN_EXT   = IS_WIN ? '.exe' : '';
const VASM      = path.join(__dirname, 'bin', `vasmm68k_mot${BIN_EXT}`);
```

Neu:
```js
const IS_WIN    = process.platform === 'win32';
const IS_MAC    = process.platform === 'darwin';
const BIN_EXT   = IS_WIN ? '.exe' : '';
const BIN_DIR   = IS_MAC
  ? path.join(__dirname, 'bin', 'darwin')
  : path.join(__dirname, 'bin');
const VASM      = path.join(BIN_DIR, `vasmm68k_mot${BIN_EXT}`);
```

Zeile 56 analog:
```js
const VLINK     = path.join(BIN_DIR, `vlink${BIN_EXT}`);
```

**`fs.watch` recursive**: Zeile 31 von:
```js
_projectWatcher = fs.watch(projectDir, { recursive: IS_WIN }, ...);
```
zu:
```js
_projectWatcher = fs.watch(projectDir, { recursive: IS_WIN || IS_MAC }, ...);
```

**chmod**: Zeile 59 bereits korrekt — `if (!IS_WIN)` greift für macOS und Linux.

### T4 — `bin/` Verzeichnisstruktur

Neue Ordnerstruktur:
```
bin/
├── vasmm68k_mot        ← Linux x86_64 (bestehend)
├── vasmm68k_mot.exe    ← Windows x64 (bestehend)
├── vlink               ← Linux x86_64 (bestehend)
├── vlink.exe           ← Windows x64 (bestehend)
└── darwin/
    ├── vasmm68k_mot    ← macOS Universal Binary (NEU)
    └── vlink           ← macOS Universal Binary (NEU)
```

Alternative (ohne Unterordner): macOS-Binaries mit Suffix (`vasmm68k_mot.darwin`),
aber `darwin/` ist sauberer und zukunftssicher für arm64-only vs. x86_64.

### T5 — `package.json`: macOS Build-Target

Neue Einträge in `build` und `scripts`:

```json
{
  "scripts": {
    "build:mac": "electron-builder --mac --publish never --config.directories.output=dist/macos"
  },
  "build": {
    "mac": {
      "target": [
        {
          "target": "dmg",
          "arch": ["universal"]
        }
      ],
      "artifactName": "BASSM-mac-${arch}.dmg",
      "category": "public.app-category.developer-tools",
      "identity": null
    }
  }
}
```

**Hinweise:**
- `"identity": null` — Ohne Apple Developer Account wird die App nicht signiert.
  macOS-Benutzer müssen beim ersten Start Rechtsklick → "Öffnen" wählen (Gatekeeper-Bypass).
  Alternativ: `xattr -d com.apple.quarantine BASSM.app` im Terminal.
- `"arch": ["universal"]` — Electron baut ein Universal Binary das auf Intel und
  Apple Silicon nativ läuft. Electron-Builder übernimmt das Bundling automatisch.
- **DMG vs. ZIP:** DMG ist der macOS-Standard für App-Distribution. Alternative:
  `"target": "zip"` für ein einfaches ZIP-Archiv.

### T6 — Build-Script: `build-mac.sh`

Neue Datei `build-mac.sh`:

```bash
#!/bin/bash
set -e

echo "============================================================"
echo " BASSM | macOS Build"
echo "============================================================"
echo

echo "[1/2] Installiere Abhaengigkeiten..."
npm install

echo
echo "[2/2] Erstelle Electron-App fuer macOS..."
npx electron-builder --mac --publish never --config.directories.output=dist/macos

echo
echo "============================================================"
echo " Build fertig: dist/macos/BASSM-mac-universal.dmg"
echo "============================================================"
```

---

## Phase 3: Kompatibilität & Testing

### T7 — macOS-spezifische Anpassungen

| Thema | Problem | Lösung |
|---|---|---|
| **App-Menü** | macOS erwartet ein App-Menü mit dem App-Namen als erstes Item | `Menu.buildFromTemplate`: Erstes Item als `{ role: 'appMenu' }` nur auf mac |
| **Quit-Shortcut** | macOS nutzt ⌘Q statt Alt+F4 | `accelerator: IS_MAC ? 'Cmd+Q' : 'Alt+F4'` |
| **Fenster schließen ≠ App beenden** | macOS-Konvention: App bleibt offen | Zeile 674: `if (process.platform !== 'darwin') app.quit()` — **bereits korrekt!** |
| **Window Restore** | macOS `activate` Event bei Dock-Klick | Zeile 668: `app.on('activate', ...)` — **bereits implementiert!** |
| **Case-Sensitivity** | macOS HFS+ ist case-insensitive, APFS default auch | Kein Problem — BASSM-Dateinamen sind lowercase |
| **Path-Separator** | macOS nutzt `/` | `path.join`/`path.sep` — **bereits korrekt!** |

### T8 — Kompatibilitätstest-Checkliste

- [ ] IDE startet, Monaco Editor lädt
- [ ] Projekt öffnen / erstellen
- [ ] Datei im Projektbaum anlegen, umbenennen, löschen
- [ ] BASSM-Code eingeben, Syntax-Highlighting aktiv
- [ ] Compile-Button: vasm + vlink erzeugen Executable
- [ ] vAmiga WASM-Preview zeigt Amiga-Output
- [ ] Asset Manager öffnet und konvertiert PNGs
- [ ] Tileset-Editor funktioniert
- [ ] Budget-Bars aktualisieren sich
- [ ] `fs.watch` erkennt externe Dateiänderungen (recursive)

---

## Phase 4: CI/CD & Distribution

### T9 — GitHub Actions: macOS-Build automatisieren

Bestehende CI erweitern (oder neuer Workflow):

```yaml
# .github/workflows/build-app.yml (Ergänzung)
jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build:mac
      - uses: actions/upload-artifact@v4
        with:
          name: BASSM-macOS
          path: dist/macos/*.dmg
```

### T10 — README.md aktualisieren

Neue Sektion unter "Running":

```markdown
### macOS

```bash
npm install
npm start
```

> **Hinweis:** Beim ersten Start muss macOS Gatekeeper umgangen werden:
> Rechtsklick auf die App → "Öffnen" → "Öffnen" bestätigen.
```

Neue Sektion unter "Building a Distributable":

```markdown
### macOS

```bash
chmod +x build-mac.sh
./build-mac.sh
```

Output: `dist/macos/BASSM-mac-universal.dmg` (Universal Binary: Intel + Apple Silicon)
```

---

## Code-Signing & Notarization (Optional, Post-1.0)

Ohne Apple Developer Account ($99/Jahr) wird die App nicht signiert. Das bedeutet:
- Gatekeeper-Warnung beim ersten Start ("von einem nicht identifizierten Entwickler")
- Benutzer müssen den Gatekeeper-Bypass manuell durchführen

Für eine professionelle Distribution nach 1.0:
1. Apple Developer Program beitreten ($99/Jahr)
2. `electron-builder` Code-Signing konfigurieren (`CSC_LINK`, `CSC_KEY_PASSWORD`)
3. Notarization via `@electron/notarize` aktivieren
4. Automatisierte Notarization in CI

**Empfehlung:** Für 1.0 ohne Signing releasen. Die Amiga-Zielgruppe ist technisch
versiert genug um Gatekeeper zu umgehen. Signing für 1.1+ evaluieren wenn die
Nutzerbasis wächst.

---

## Zusammenfassung

| Task | Aufwand | Abhängigkeit |
|---|---|---|
| T1: vasm macOS-Binaries | Klein | Zugang zu macOS oder CI |
| T2: vlink macOS-Binaries | Klein | Zugang zu macOS oder CI |
| T3: `main.js` Plattform-Logik | Minimal | T1, T2 |
| T4: `bin/darwin/` Verzeichnis | Minimal | T1, T2 |
| T5: `package.json` macOS-Target | Minimal | — |
| T6: `build-mac.sh` Script | Minimal | T5 |
| T7: macOS-spezifische Anpassungen | Klein | — |
| T8: Kompatibilitätstest | Mittel | T1–T7 |
| T9: CI/CD macOS-Build | Klein | T5 |
| T10: README aktualisieren | Minimal | T8 |

**Gesamtaufwand:** ~2 Sessions (primär wegen Binary-Kompilation und Testing)

**Voraussetzung:** Zugang zu einem Mac oder macOS-CI-Runner (GitHub Actions
`macos-latest` ist kostenlos für Public Repos).
