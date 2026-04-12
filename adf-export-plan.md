# ADF-Export Plan

**Ziel:** Der `Create ADF`-Button erzeugt eine bootfähige 880KB OFS-Diskette (.adf) die auf einem Amiga 500 mit KS 1.3 bootet und das kompilierte BASSM-Programm via `s/startup-sequence` automatisch startet.

**Ansatz:** Pure-JS ADF-Generator (keine npm-Dependency). Standard-DOS-Boot, KS 1.3 kompatibel.

**Dateien:**
- **Neu:** `app/src/adf.js` — ADF-Generator
- **Bestehend:** `main.js` (IPC), `app/preload.js` (Bridge), `app/src/bassm.js` (UI)

---

## Phase 1 — ADF-Kern: Leere formatierte Diskette

Eine neue Datei `app/src/adf.js` die einen gültigen, leeren OFS-Datenträger als Buffer erzeugt.

| Task | Beschreibung |
|------|-------------|
| T1 ✅ | **Konstanten & Layout** — OFS-Geometrie (1760 Blocks, 512 B/Block, Root=880, Bitmap=881), Block-Offsets, Header-Typen |
| T2 ✅ | **Buffer erzeugen** — 901.120 Bytes (880 KB), mit Nullen initialisiert |
| T3 ✅ | **Bootblock** — Block 0–1: `DOS\0` Magic + Flags + Root-Pointer + Bootblock-Checksum-Algorithmus. Macht die Diskette bootfähig für KS 1.3 |
| T4 ✅ | **Root Block** — Block 880: Type=2, SecType=1, Hash-Table (72 Einträge), Disk-Name, Datum, Bitmap-Pointer |
| T5 ✅ | **Bitmap Block** — Block 881: Freie/belegte Blocks als Bitfeld (1=frei, 0=belegt). Bootblock + Root + Bitmap als belegt markieren |

**Ergebnis:** `createEmptyADF(diskName)` → 880KB `Buffer` der in WinUAE als leere, formatierte Diskette mountbar ist.

---

## Phase 2 — Dateien schreiben

Funktionen um Dateien und Verzeichnisse auf den ADF-Buffer zu schreiben.

| Task | Beschreibung |
|------|-------------|
| T6 ✅ | **Block-Allokator** — Nächsten freien Block im Bitmap finden, als belegt markieren, Bitmap-Checksum updaten |
| T7 ✅ | **OFS Data Blocks** — Datei-Inhalt in Data Blocks aufteilen (je 488 Bytes Nutzdaten + 24 Byte OFS-Header: Type, HeaderKey, SeqNum, DataSize, NextData, Checksum) |
| T8 ✅ | **File Header Block** — Type=2, SecType=-3, Dateiname, Größe, Datum, Protection Bits, Block-Pointer-Liste (max 72 direkt, Extension Blocks bei >35KB) |
| T9 ✅ | **Hash-Table Eintrag** — Dateiname hashen (Amiga-Hash), in Parent-Directory eintragen, Hash-Chain bei Kollision |
| T10 ✅ | **Directory erstellen** — UserDir-Block (Type=2, SecType=2) für `s/`-Verzeichnis, Hash-Table Eintrag im Root |
| T11 ✅ | **startup-sequence** — Textdatei `startup-sequence` in `s/` schreiben. Inhalt: Name des Executables (eine Zeile). KS 1.3 führt diese Datei beim Booten automatisch aus |

**Ergebnis:** `writeFile(adf, parentBlock, name, data)` + `createDir(adf, parentBlock, name)` — bootfähige Diskette mit Executable und startup-sequence.

---

## Phase 3 — Electron-Integration

Den vorhandenen Button (`btn-create-adf` in index.html) an die Pipeline anschließen.

| Task | Beschreibung |
|------|-------------|
| T12 ✅ | **IPC-Handler** — `bassm:create-adf` in main.js: nimmt `{ projectDir, projectName, exeData }`, baut ADF, gibt Buffer zurück |
| T13 ✅ | **preload.js** — `createAdf` API-Methode exponieren |
| T14 ✅ | **Save-Dialog** — `showSaveDialog` mit Filter `*.adf`, Default-Name = Projektname |
| T15 ✅ | **Button-Handler** — Click auf `btn-create-adf`: letztes Build-Ergebnis (`_lastBinary`) nehmen, ADF erzeugen, speichern, Log-Ausgabe |

**Ergebnis:** Button erzeugt eine .adf Datei die auf KS 1.3 bootet und das Programm startet.

---

## Phase 4 — UX & Validierung

| Task | Beschreibung |
|------|-------------|
| T16 ✅ | **Button-State** — `btn-create-adf` erst aktivieren wenn `_lastBinary` vorhanden (nach erfolgreichem Build) |
| T17 ✅ | **Disk-Name** — Projektname als Volume-Label auf der ADF |
| T18 ✅ | **Console-Log** — Fortschritt + Dateigrößen + Speicherpfad loggen |
| T19 ✅ | **Größen-Check** — Warnung wenn Executable + Assets > ~860KB (OFS-Overhead ~20KB) |

---

## Boot-Ablauf auf dem Amiga

```
Disk einlegen
  → KS 1.3 liest Bootblock (Block 0–1)
  → erkennt DOS\0 Magic → lädt dos.library
  → dos.library sucht s/startup-sequence
  → führt Inhalt aus: "bassm_out"
  → Executable startet, übernimmt Hardware
```
