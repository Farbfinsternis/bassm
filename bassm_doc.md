# BASSM Language Reference

**BASSM** — *Blitz2D Amiga System Subset for m68k*

BASSM ist eine Compilersprache, die syntaktisch an Blitz2D (PC) angelehnt ist,
aber ausschließlich für bare-metal Amiga OCS/ECS-Hardware entwickelt wurde.
Der Compiler übersetzt BASSM-Quellcode in m68k-Assembler, der mit
`vasmm68k_mot` + `vlink` zu einer Amiga-Executable kompiliert wird.

> **Wichtig:** BASSM ist kein vollständiges Blitz2D. Viele Blitz2D-Befehle
> fehlen oder verhalten sich anders. Diese Dokumentation beschreibt nur, was
> tatsächlich implementiert ist.

---

## Inhaltsverzeichnis

1. [Programmstruktur](#1-programmstruktur)
2. [Datentypen & Variablen](#2-datentypen--variablen)
3. [Arrays](#3-arrays)
4. [Ausdrücke & Operatoren](#4-ausdrücke--operatoren)
5. [Kontrollstrukturen](#5-kontrollstrukturen)
6. [Systemsteuerung](#6-systemsteuerung)
7. [Grafik — Grundlagen](#7-grafik--grundlagen)
8. [Grafik — Zeichenbefehle](#8-grafik--zeichenbefehle)
9. [Palette & Farben](#9-palette--farben)
10. [Eingabe](#10-eingabe)
11. [Text & Debug-Ausgabe](#11-text--debug-ausgabe)
12. [Amiga-spezifisches Verhalten](#12-amiga-spezifisches-verhalten)
13. [Bekannte Einschränkungen](#13-bekannte-einschränkungen)
14. [Vollständiges Beispiel](#14-vollständiges-beispiel)

---

## 1. Programmstruktur

Jedes BASSM-Programm muss mit `Graphics` beginnen. Danach folgen
Initialisierungen und die Hauptschleife.

```blitz
Graphics 320,256,4      ; Muss die erste Anweisung sein

; Initialisierungen
x = 10
Color 1

; Hauptschleife
While 1
  Cls
  Box x,50,16,16
  ScreenFlip
Wend
```

### Kommentare

```blitz
; Semikolon-Kommentar (Blitz2D-Stil)
// C-Stil Kommentar
```

### Statement-Separator `:`

Mehrere Anweisungen können durch `:` auf einer Zeile stehen:

```blitz
x = 0 : y = 0 : dx = 2 : dy = 3
If x < 0 : x = 0 : dx = -dx : EndIf
```

### Groß-/Kleinschreibung

Keywords und Befehlsnamen sind **case-insensitiv**. Variablennamen werden intern
immer kleingeschrieben (`MyVar` und `myvar` sind dieselbe Variable).

---

## 2. Datentypen & Variablen

BASSM kennt nur einen Datentyp: **32-Bit vorzeichenbehafteter Integer**.
Es gibt keine Floats, Strings als Variablen oder Zeiger.

### Deklaration & Zuweisung

Variablen müssen nicht deklariert werden. Eine erste Zuweisung erzeugt die
Variable im BSS-Bereich des Programms.

```blitz
x = 42
y = x + 1
z = -100
```

### Ganzzahl-Literale

| Format | Beispiel | Wert |
|--------|---------|------|
| Dezimal | `255` | 255 |
| Hexadezimal | `$FF` | 255 |
| Binär | `%11111111` | 255 |
| Negativ | `-1` | -1 |

> **Intern:** Alle Variablen werden als `ds.l 1` (32-Bit Long) im BSS-Segment
> abgelegt. Kurze Literale (−128 bis 127) nutzen `moveq` statt `move.l`
> (PERF-Optimierung).

---

## 3. Arrays

Arrays werden mit `Dim` deklariert. Der Index-Bereich ist immer **0 bis n**
(d.h. n+1 Elemente).

### Deklaration

```blitz
Dim arr(7)      ; 8 Elemente: arr(0) .. arr(7)
Dim coords(31)  ; 32 Elemente: coords(0) .. coords(31)
```

### Lesen & Schreiben

```blitz
arr(0) = 100
arr(i) = arr(i) + 1
x = arr(3)
```

Der Index kann ein beliebiger Ausdruck sein:

```blitz
arr(i * 2) = val     ; zusammengesetzter Index
x = arr(base + i)
```

### Eigenschaften

- Arrays sind global (kein lokaler Scope)
- Elementgröße: 32-Bit Long (4 Byte pro Element)
- Kein Bounds-Checking zur Laufzeit
- Arrays und skalare Variablen haben getrennte Namensräume
  (`arr` als Array und `arr` als skalare Variable können nicht gleichzeitig existieren)

---

## 4. Ausdrücke & Operatoren

### Arithmetik

| Operator | Bedeutung | Hinweis |
|----------|-----------|---------|
| `+` | Addition | |
| `-` | Subtraktion / unäres Minus | |
| `*` | Multiplikation | 16-Bit-Operanden (`muls.w`); Überlauf bei > 32767 |
| `/` | Division (ganzzahlig) | 32-Bit ÷ 16-Bit (`divs.w`); Rest wird verworfen |

### Vergleiche

| Operator | Bedeutung |
|----------|-----------|
| `=` | gleich |
| `<>` | ungleich |
| `<` | kleiner |
| `>` | größer |
| `<=` | kleiner oder gleich |
| `>=` | größer oder gleich |

Vergleiche liefern einen Blitz2D-Boolean: **−1** (wahr) oder **0** (falsch).

### Operatorrangfolge

Von höchster zu niedrigster Priorität:

1. Unäres Minus (`-x`)
2. `*` `/`
3. `+` `-`
4. `=` `<>` `<` `>` `<=` `>=`

Klammern überschreiben die Rangfolge:

```blitz
y = (x + 2) * 3
If (a < b) = -1 Then Cls
```

### Compiler-Optimierungen (PERF-A & PERF-B)

Der Compiler optimiert automatisch:

- **PERF-A:** `If`/`While`-Bedingungen mit direkten Vergleichen erzeugen
  `cmp + Bcc` statt des langsamen `Scc + ext + tst + beq`-Musters (−4 Instruktionen
  pro Bedingung).

- **PERF-B:** Wenn der rechte Operand von `+`, `-` oder einem Vergleich ein
  Literal oder eine einzelne Variable ist, entfällt Push/Pop komplett.
  Literale 1–8 nutzen `addq`/`subq` (kompakteste m68k-Instruktion).

---

## 5. Kontrollstrukturen

### If

**Einzeilig (mit Then):**
```blitz
If x > 0 Then Cls
If bx < 0 Then bx = 0 : bdx = -bdx
```

**Block:**
```blitz
If x > 0
  Cls
  Color 1
EndIf
```

**If / Else:**
```blitz
If x > 320
  x = 320
  dx = -dx
Else
  x = x + dx
EndIf
```

**If / ElseIf / Else:**
```blitz
If score > 1000
  Color 5
ElseIf score > 500
  Color 3
ElseIf score > 0
  Color 1
Else
  Color 0
EndIf
```

---

### While

```blitz
While <bedingung>
  ; body
Wend
```

**Endlosschleife** (kein Test-Overhead, direkt `bra.w` zurück):
```blitz
While 1
  ; Hauptschleife
Wend
```

Beliebige Bedingung:
```blitz
i = 0
While i < 10
  i = i + 1
Wend
```

---

### For

```blitz
For <var> = <start> To <end> [Step <schritt>]
  ; body
Next [<var>]
```

Beispiele:
```blitz
; Aufwärts, impliziter Step 1
For i = 0 To 7
  arr(i) = 0
Next i

; Expliziter Step
For x = 0 To 319 Step 2
  Plot x,100
Next x

; Abwärts
For i = 7 To 0 Step -1
  arr(i) = i * 2
Next i
```

- `Step` kann eine Variable oder ein Ausdruck sein.
- Bei negativem `Step` prüft der Compiler das Abbruchkriterium mit `blt.w`.
- `Next` kann ohne Variablenname geschrieben werden.

---

### Select / Case / Default

```blitz
Select <ausdruck>
  Case 1
    Cls
  Case 2, 3
    Color 2
  Default
    Color 0
EndSelect
```

- Mehrere Werte in einem `Case` durch Komma getrennt.
- `Default` ist optional; wird ausgeführt wenn kein Case passt.
- Der Selektor-Ausdruck wird einmal ausgewertet.

---

## 6. Systemsteuerung

### Graphics
```blitz
Graphics width, height, depth
```
**Muss die erste Anweisung jedes Programms sein.**

| Parameter | Typ | Einschränkung |
|-----------|-----|---------------|
| `width` | Integer-Literal | Nur `320` (PAL Lores OCS) |
| `height` | Integer-Literal | Üblicherweise `256` (PAL) oder `200` |
| `depth` | Integer-Literal | 1–6 Bitplanes → 2–64 Farben |

```blitz
Graphics 320,256,4   ; 320×256, 4 Bitplanes = 16 Farben
Graphics 320,200,5   ; 320×200, 5 Bitplanes = 32 Farben
```

### ScreenFlip
```blitz
ScreenFlip
```
Tauscht Front- und Back-Buffer (Double Buffering). Warten auf den nächsten
VBlank ist implizit enthalten. **Alle Zeichenbefehle arbeiten immer auf dem
Back-Buffer.** Ohne `ScreenFlip` ist kein Bild sichtbar (außer nach `Cls`).

### WaitVbl
```blitz
WaitVbl
```
Wartet auf den vertikalen Rücklauf (VBlank, ca. 50 Hz bei PAL).

### Delay
```blitz
Delay n
```
Wartet `n` VBlanks. `n` kann eine Variable oder ein Ausdruck sein.
```blitz
Delay 50     ; ca. 1 Sekunde warten
Delay speed  ; variable Pause
```

### End
```blitz
End
```
Beendet das Programm und kehrt zum AmigaOS zurück.

---

## 7. Grafik — Grundlagen

### Koordinatensystem

- Ursprung `(0,0)` ist **oben links**.
- X wächst nach rechts (0 bis Breite−1).
- Y wächst nach unten (0 bis Höhe−1).

### Double Buffering

BASSM verwendet immer **Double Buffering**: es gibt einen Front-Buffer
(sichtbar) und einen Back-Buffer (zum Zeichnen). `ScreenFlip` tauscht die
beiden. Typische Hauptschleife:

```blitz
While 1
  Cls                  ; Back-Buffer löschen
  ; ... zeichnen ...   ; alles geht in den Back-Buffer
  ScreenFlip           ; Back-Buffer zeigen, tauschen
Wend
```

### Cls
```blitz
Cls
```
Löscht den Back-Buffer mit der durch `ClsColor` gesetzten Farbe (Standard: 0 = schwarz).
Verwendet den **Amiga-Blitter** (sehr schnell, ca. 1–2 Rasterlines für 320×256).

---

## 8. Grafik — Zeichenbefehle

Alle Zeichenbefehle verwenden die aktuell mit `Color` gesetzte Farbe
und zeichnen in den Back-Buffer.

### Plot
```blitz
Plot x, y
```
Setzt einen einzelnen Pixel.

### Line
```blitz
Line x1, y1, x2, y2
```
Zeichnet eine Linie von `(x1,y1)` nach `(x2,y2)`. Implementierung: CPU-Bresenham.

### Rect
```blitz
Rect x, y, w, h
```
Zeichnet einen **Rechteck-Umriss** (4 Seiten, nicht gefüllt).
- `(x,y)` = obere linke Ecke
- `w` = Breite, `h` = Höhe

### Box
```blitz
Box x, y, w, h
```
Zeichnet ein **gefülltes Rechteck**.
- Implementierung: **Amiga Blitter** (A-Kanal als Kantenmaske, C-Kanal für Read-Modify-Write)
- `(x,y)` = obere linke Ecke
- `w` = Breite, `h` = Höhe

> **Amiga-spezifisch:** `Box` nutzt den Blitter mit korrekten Minterms
> für randgenaues Füllen ohne Pixel-Artefakte an den Wortgrenzen.

---

## 9. Palette & Farben

Der Amiga OCS unterstützt eine Palette von **32 Farben** (Indizes 0–31).
Jede Farbe ist ein OCS-Farbwort: `$0RGB` mit je 4 Bit pro Kanal (0–15).

### Color
```blitz
Color index
```
Setzt die aktuelle Zeichenfarbe auf Palette-Index `index` (0–31).
`index` kann eine Variable oder ein Ausdruck sein.

```blitz
Color 1          ; feste Farbe
Color bcol(i)    ; Array-Element als Farbe
Color i + 1      ; Ausdruck als Farbe
```

### PaletteColor
```blitz
PaletteColor n, r, g, b
```
Setzt Palette-Eintrag `n` auf den RGB-Wert `(r, g, b)`.
Jeder Kanal: 0–15 (4-Bit OCS-Auflösung).

Alle vier Argumente können **Variablen oder Ausdrücke** sein (Runtime):

```blitz
PaletteColor 1, 15, 0, 0      ; Compile-Time: reines Rot (schneller Pfad)
PaletteColor 2, r, g, b       ; Runtime: Variablen als RGB
PaletteColor 1, t, 15-t, 0    ; Runtime: Palette-Animation
```

**Compile-Time-Optimierung:** Wenn alle vier Argumente Literale sind, berechnet
der Compiler das OCS-Farbwort (`$0RGB`) zur Compile-Zeit und ruft
`_SetPaletteColor` direkt auf (kein Subroutine-Overhead für RGB-Aufbau).

### ClsColor
```blitz
ClsColor n
```
Setzt die Hintergrundfarbe für `Cls`. `n` ist ein **Bitfeld**, kein
Palette-Index direkt: Bit `k` in `n` entspricht dem Bit-k-Plane-Füllwert.

Typische Verwendung:
```blitz
ClsColor 0    ; Schwarz (alle Planes mit 0 füllen)
ClsColor 1    ; Color-Bit 0 gesetzt = Palette-Farbe 1 (auf 1-Bitplane-Systemen)
```

> **Hinweis:** `ClsColor` steuert den Blitter-Minterm für `Cls`. Für den
> einfachen Fall (Hintergrundfarbe = 0 = schwarz) ist `ClsColor 0` oder
> weglassen korrekt.

### CopperColor *(Amiga-spezifisch — M-COPPER)*
```blitz
CopperColor y, r, g, b
```
Setzt die Hintergrundfarbe (`COLOR00`) an Rasterzeile `y` im Copper-Programm.

| Parameter | Beschreibung |
|-----------|--------------|
| `y` | Bildschirm-Rasterzeile (0 = oben, max `GFXRASTER-1`) |
| `r` | Rot-Komponente (0..15) |
| `g` | Grün-Komponente (0..15) |
| `b` | Blau-Komponente (0..15) |

Der Copper ist ein eigenständiger Koprozessor im OCS-Chipsatz. Er läuft
**parallel zur CPU** und erzeugt **null CPU-Overhead** während der Rasteranzeige.
`CopperColor` patcht den Back-Buffer-Copper; die Änderung wird beim nächsten
`ScreenFlip` sichtbar.

**Maximale Rasterzeilen (`GFXRASTER`):** `min(H, 212)` für PAL-Lores
(Zeilen 213..255 liegen im vertikalen Austastbereich und können nicht
mit einem Standard-WAIT adressiert werden).

```blitz
; Statisch (Compile-Time-Pfad — kein Overhead):
CopperColor 50, 15, 0, 0     ; Zeile 50 = reines Rot

; Dynamisch (Runtime-Pfad — Variablen/Ausdrücke):
CopperColor line, rc, gc, bc

; Klassischer Rasterbalken-Gradient:
For line = 0 To 211
    rc = line / 14
    CopperColor line, rc, 0, 15 - rc
Next line
ScreenFlip
```

**Compile-Time-Optimierung:** Wenn alle vier Argumente Literale sind,
berechnet der Compiler das OCS-Farbwort zur Compile-Zeit und ruft
`_SetRasterColor` (2 Argumente) direkt auf. Andernfalls werden R, G, B
via Stack übergeben und `_SetRasterColorRGB` aufgerufen.

> **Hinweis:** `CopperColor` ist ein rein BASSM/Amiga-spezifischer Befehl.
> Er existiert in Blitz2D für Windows nicht. Er erzeugt automatisch die
> nötigen Raster-Einträge in beiden Copper-Listen — das Programm muss
> die Copper-Liste nicht manuell verwalten.

### Standard-Palette

Beim Programmstart wird die Standard-Palette aus dem Chip-RAM geladen:

| Index | OCS-Wort | Farbe |
|-------|----------|-------|
| 0 | `$0000` | Schwarz (Hintergrund / Cls-Standard) |
| 1 | `$0FFF` | Weiß |
| 2 | `$0F00` | Rot |
| 3 | `$00F0` | Grün |
| 4 | `$000F` | Blau |
| 5 | `$0FF0` | Gelb |
| 6 | `$0F0F` | Magenta |
| 7 | `$00FF` | Cyan |
| 8 | `$0888` | Mittelgrau |
| 9 | `$0444` | Dunkelgrau |
| 10 | `$0CCC` | Hellgrau |
| 11 | `$0F80` | Orange |
| 12 | `$0840` | Braun |
| 13 | `$08F8` | Hellgrün |
| 14 | `$048F` | Himmelblau |
| 15 | `$0F88` | Rosa |
| 16–31 | `$0000` | Reserve (schwarz) |

---

## 10. Eingabe

### WaitKey
```blitz
WaitKey
```
Blockiert bis eine Taste gedrückt **und losgelassen** wird.
Implementierung: CIA-A Keyboard-Interrupt (Level-2), interrupt-driven.

> **vAmiga-Hinweis:** `WaitKey` funktioniert nur, wenn `INTENA.PORTS` aktiv ist.
> Dies wird vom Startup-Code korrekt initialisiert.

---

## 11. Text & Debug-Ausgabe

### Text *(Stub — noch nicht funktional)*
```blitz
Text x, y, "string"
```
Geplant: Rendert einen String mit dem eingebetteten 8×8-Bitmap-Font an
Pixelposition `(x,y)`. **Aktuell als Stub implementiert (kein sichtbarer Output).**

### NPrint *(Stub — kein sichtbarer Output)*
```blitz
NPrint "string"
```
Geplant: Debug-Ausgabe. Auf bare-metal Amiga kein sichtbarer Effekt.
**Aktuell als Stub implementiert.**

---

## 12. Amiga-spezifisches Verhalten

Diese Befehle und Konzepte existieren in Blitz2D für Windows **nicht**:

### ScreenFlip
Amiga-spezifisch. Auf dem PC hat Blitz2D automatisches Buffering.
Im BASSM-Programm muss `ScreenFlip` manuell am Ende jedes Frames aufgerufen
werden, sonst sieht man das Back-Buffer-Bild nicht.

### Double Buffering ist immer aktiv
BASSM erzeugt immer zwei Bitplane-Sets im Chip-RAM und zwei Copper-Listen.
Es gibt keinen Modus ohne Double Buffering.

### CopperColor und der Copper-Prozessor
`CopperColor` patcht eine Copper-Liste, die vom **Copper-Coprozessor** (OCS)
ausgeführt wird. Der Copper läuft **vollständig parallel zur CPU** und verursacht
keinen Overhead im Hauptprogramm. Die CPU schreibt einen neuen Farbwert in den
Back-Copper (8 Byte schreiben) — der Rest passiert automatisch durch DMA.

### Blitter-Zeichnung
`Cls` und `Box` nutzen den OCS-Blitter (DMA-gesteuerter Bitplane-Coprozessor).
Andere Befehle (`Plot`, `Line`, `Rect`) arbeiten auf der CPU.

### PAL-Bildschirm, bare-metal
- Das Programm läuft **direkt auf der Hardware**, ohne AmigaOS während der Ausführung.
- VBlank = ca. 50 Hz (PAL).
- Kein multitasking, kein Speicherschutz.

### OCS-Farbpalette
4-Bit pro Kanal (16 Stufen) statt 8-Bit (wie PC-Blitz2D):
```blitz
PaletteColor 1, 15, 8, 0    ; Orange: r=15, g=8, b=0  (OCS: $0F80)
; NICHT: PaletteColor 1, 255, 128, 0  — Werte werden auf 0..15 geklemmt
```

### Multiplikation: 16-Bit-Operanden
`*` nutzt `muls.w` (16×16→32 Bit). Wenn Operanden > 32767, kommt es zu
falschen Ergebnissen (kein Überlauf-Fehler, stille Verfälschung).

### Division: ganzzahlig
`/` liefert nur den Quotienten (Rest wird verworfen). Es gibt keine
`Mod`-Operation. Workaround:
```blitz
rest = a - (a / b) * b    ; manuelles Modulo
```

---

## 13. Bekannte Einschränkungen

| Einschränkung | Erklärung |
|---------------|-----------|
| Nur 320px Breite | `Graphics` akzeptiert nur `width=320` |
| Nur Integer | Keine Floats, keine Strings als Variablen |
| Keine Funktionen | `Function`/`Procedure` noch nicht implementiert (geplant: M7) |
| Text ist ein Stub | `Text`/`NPrint` erzeugen noch keinen sichtbaren Output |
| `*` max. 16-Bit | Multiplikation mit `muls.w`; Operanden müssen −32768..32767 sein |
| Kein Mod-Operator | Workaround: `a - (a/b)*b` |
| Keine Strings als Variablen | Stringliterale nur als Argumente für `Text`/`NPrint` |
| Keine Rekursion | Ohne Funktionsstack kein Rekursionsunterstützung |
| Kein Bounds-Checking | Array-Überläufe korrumpieren Speicher stillschweigend |
| OS-Restore (vAmiga) | Nach `End` erscheint unter AROS/vAmiga kein Workbench-Fenster wieder (bekannter offener Bug) |

---

## 14. Vollständiges Beispiel

Das folgende Programm zeigt 8 springende Boxen mit animierter Palette —
es nutzt Arrays, `For`-Schleifen, `:` als Statement-Separator, `ScreenFlip`
und Runtime-`PaletteColor`:

```blitz
; 8 Bouncing Boxes + Palette Animation
; Alle BASSM-Features in einem Programm.
Graphics 320,256,4   ; 320x256, 4 Bitplanes = 16 Farben

ClsColor 0           ; Cls fuellt mit Schwarz

; Position/Geschwindigkeit als Arrays (8 Boxen: Index 0..7)
Dim bx(7) : Dim by(7) : Dim bdx(7) : Dim bdy(7)

bx(0)=10  : by(0)=20  : bdx(0)=3  : bdy(0)=2
bx(1)=100 : by(1)=50  : bdx(1)=-4 : bdy(1)=3
bx(2)=200 : by(2)=10  : bdx(2)=2  : bdy(2)=-3
bx(3)=50  : by(3)=150 : bdx(3)=-3 : bdy(3)=-2
bx(4)=250 : by(4)=100 : bdx(4)=4  : bdy(4)=2
bx(5)=130 : by(5)=200 : bdx(5)=-2 : bdy(5)=4
bx(6)=80  : by(6)=120 : bdx(6)=5  : bdy(6)=-3
bx(7)=280 : by(7)=180 : bdx(7)=-3 : bdy(7)=5

t = 0               ; Frame-Zaehler fuer Palette-Animation

While 1
  Cls               ; Back-Buffer loeschen (Blitter)

  ; Palette animieren: RGB-Phase um t verschieben, Zyklus 0..15
  t = t + 1
  If t > 15 : t = 0 : EndIf

  PaletteColor 1, t,    15-t, 0
  PaletteColor 2, 0,    t,    15-t
  PaletteColor 3, 15-t, 0,    t
  PaletteColor 4, t,    t,    15-t
  PaletteColor 5, 15-t, t,    0
  PaletteColor 6, 0,    15-t, t
  PaletteColor 7, t,    0,    15-t
  PaletteColor 8, 15-t, 15-t, t

  For i = 0 To 7
    ; Bewegen
    bx(i) = bx(i) + bdx(i)
    by(i) = by(i) + bdy(i)

    ; Randbedingungen
    If bx(i) < 0   : bx(i) = 0   : bdx(i) = -bdx(i) : EndIf
    If bx(i) > 304 : bx(i) = 304 : bdx(i) = -bdx(i) : EndIf
    If by(i) < 0   : by(i) = 0   : bdy(i) = -bdy(i) : EndIf
    If by(i) > 240 : by(i) = 240 : bdy(i) = -bdy(i) : EndIf

    Color i + 1            ; Farbe = Index+1 (animiert durch PaletteColor)
    Box bx(i),by(i),16,16  ; gefuelltes Rechteck zeichnen (Blitter)
  Next i

  ScreenFlip       ; Back-Buffer zeigen, naechsten VBlank abwarten
Wend
```

---

## Anhang: Reservierte Schlüsselwörter

```
If  Then  Else  ElseIf  EndIf
While  Wend
For  To  Step  Next
Select  Case  Default  EndSelect
Dim
```

## Anhang: Reservierte Befehlsnamen

```
Graphics   Cls       ClsColor    Color       PaletteColor  CopperColor
WaitVbl    WaitKey   Delay       ScreenFlip  End
Plot       Line      Rect        Box
Text       NPrint
```

---

*Dokumentation generiert für BASSM — Compiler-Stand: 2026-03-07*
