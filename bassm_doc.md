# BASSM Sprachreferenz

**BASSM** — *Blitz2D Amiga System Subset*

BASSM ist eine einfache Programmiersprache für den Commodore Amiga, die sich an
Blitz2D anlehnt. Du schreibst Basic-ähnlichen Code — BASSM übersetzt ihn in ein
lauffähiges Amiga-Programm.

> **Wichtig:** BASSM ist kein vollständiges Blitz2D. Nur die hier dokumentierten
> Befehle sind implementiert.

---

## Inhaltsverzeichnis

1. [Programmstruktur](#1-programmstruktur)
2. [Datentypen & Variablen](#2-datentypen--variablen)
3. [Arrays](#3-arrays)
4. [Ausdrücke & Operatoren](#4-ausdrücke--operatoren)
5. [Kontrollstrukturen](#5-kontrollstrukturen)
6. [Funktionen & Prozeduren](#6-funktionen--prozeduren)
7. [Systemsteuerung](#7-systemsteuerung)
8. [Grafik — Grundlagen](#8-grafik--grundlagen)
9. [Grafik — Zeichenbefehle](#9-grafik--zeichenbefehle) (Plot, Line, Rect, Box, LoadImage/DrawImage)
10. [Palette & Farben](#10-palette--farben)
11. [Eingabe](#11-eingabe)
12. [Text & Debug-Ausgabe](#12-text--debug-ausgabe)
13. [Sound](#13-sound)
14. [Amiga-spezifisches Verhalten](#14-amiga-spezifisches-verhalten)
15. [Bekannte Einschränkungen](#15-bekannte-einschränkungen)
16. [Vollständiges Beispiel](#16-vollständiges-beispiel)
17. [Die IDE — Hauptfenster](#17-die-ide--hauptfenster)
18. [Asset Manager](#18-asset-manager)

---

## 1. Programmstruktur

Jedes BASSM-Programm beginnt mit `Graphics`. Danach folgen Initialisierungen
und die Hauptschleife.

```blitz
Graphics 320,256,4      ; Bildschirm einrichten — muss die erste Zeile sein

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
; Semikolon-Kommentar
// C-Stil Kommentar
```

### Statement-Separator `:`

Mehrere Anweisungen können mit `:` auf einer Zeile stehen:

```blitz
x = 0 : y = 0 : dx = 2 : dy = 3
If x < 0 : x = 0 : dx = -dx : EndIf
```

### Include

```blitz
Include "dateiname.bassm"
```

Bindet den Inhalt einer anderen `.bassm`-Datei an dieser Stelle ein.
Der Inhalt wird **vor dem Kompilieren** eingelesen und ersetzt die `Include`-Zeile
vollständig. Der Pfad ist relativ zum Projektordner.

```blitz
; main.bassm
Include "constants.bassm"    ; Konstanten und Palette-Definitionen
Include "physics.bassm"      ; Physik-Hilfsfunktionen

Graphics 320,256,4
; ...
```

`Include` lädt Dateien rekursiv — eine eingebundene Datei kann selbst wieder `Include`
verwenden. Zirkuläre Includes (A → B → A) werden erkannt und als Fehler gemeldet.

> **Hinweis:** `Include` ist nur in Projekten verfügbar, die mit **„Open Folder"**
> geöffnet wurden. Im eingebetteten Demo-Editor steht es nicht zur Verfügung.

### Groß-/Kleinschreibung

Keywords und Befehlsnamen sind **nicht case-sensitiv** (`if` = `If` = `IF`).
Variablennamen werden intern immer kleingeschrieben — `MyVar` und `myvar`
sind dieselbe Variable.

Variablennamen dürfen mit Befehlsnamen übereinstimmen — `line`, `box`, `color`
usw. sind gültige Variablennamen.

---

## 2. Datentypen & Variablen

BASSM kennt nur einen Datentyp: **ganze Zahlen** (32-Bit, mit Vorzeichen).
Es gibt keine Kommazahlen, keine Strings als Variablen.

### Deklaration & Zuweisung

Variablen müssen nicht vorher deklariert werden. Die erste Zuweisung legt
die Variable an.

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

---

## 3. Arrays

Arrays werden mit `Dim` deklariert. Der Index läuft immer von **0 bis n**,
also gibt es n+1 Elemente.

### Deklaration

```blitz
Dim arr(7)      ; 8 Elemente: arr(0) bis arr(7)
Dim punkte(31)  ; 32 Elemente: punkte(0) bis punkte(31)
```

### Lesen & Schreiben

```blitz
arr(0) = 100
arr(i) = arr(i) + 1
x = arr(3)
x = arr(i * 2)   ; Index kann ein Ausdruck sein
```

### Eigenschaften

- Arrays sind global (kein lokaler Gültigkeitsbereich)
- Kein Bounds-Checking — ein Index außerhalb des Bereichs überschreibt anderen Speicher
- Arrays und gleichnamige skalare Variablen können nicht gleichzeitig existieren

---

## 4. Ausdrücke & Operatoren

### Arithmetik

| Operator | Bedeutung | Hinweis |
|----------|-----------|---------|
| `+` | Addition | |
| `-` | Subtraktion / unäres Minus | |
| `*` | Multiplikation | Werte sollten −32768 bis 32767 sein |
| `/` | Division (ganzzahlig, Rest wird verworfen) | |
| `Mod` | Modulo (Rest der Division) | Divisor muss ≤ 32767 sein |

> **Multiplikation:** Bei Werten über 32767 kann es zu falschen Ergebnissen kommen.
> Für Bildschirmkoordinaten ist das normalerweise kein Problem.

```blitz
frame = (frame + 1) Mod 8     ; Frame-Cycling (0..7)
x = (x + dx) Mod 320          ; horizontaler Wraparound
If ticks Mod 50 = 0 Then ...   ; jede Sekunde (50 Hz)
```

### Vergleiche

| Operator | Bedeutung |
|----------|-----------|
| `=` | gleich |
| `<>` | ungleich |
| `<` | kleiner |
| `>` | größer |
| `<=` | kleiner oder gleich |
| `>=` | größer oder gleich |

Vergleiche liefern **−1** (wahr) oder **0** (falsch) — wie in Blitz2D.

### Logische & Bitweise Operatoren

| Operator | Bedeutung | Hinweis |
|----------|-----------|---------|
| `And` | UND (bitweise) | `-1 And -1 = -1` (wahr), `0 And -1 = 0` (falsch) |
| `Or` | ODER (bitweise) | `0 Or -1 = -1` (wahr), `0 Or 0 = 0` (falsch) |
| `Not` | Komplement (bitweise) | `Not 0 = -1`, `Not -1 = 0` |

`And` und `Or` arbeiten auf 32-Bit-Integern — bitweise, genau wie in Blitz2D.
Für boolesche Werte (−1/0) ergibt sich das erwartete logische Verhalten.

```blitz
; Zusammengesetzte Bedingungen
If x > 0 And x < 320 Then ...
If fire Or timer > 100 Then ...
While Not done

; Bitweise Operationen
col = farbe And $0F          ; unteres Nibble maskieren
flags = flags Or %00000010   ; Bit 1 setzen
```

### Operatorrangfolge

Von höchster zu niedrigster Priorität:

1. Unäres Minus (`-x`), `Not`
2. `*` `/` `Mod`
3. `+` `-`
4. `=` `<>` `<` `>` `<=` `>=`
5. `And`
6. `Or`

```blitz
y = (x + 2) * 3                   ; Klammern überschreiben die Rangfolge
If x > 0 And x < 320 Then ...     ; And bindet stärker als Or
If a Or b And c Then ...           ; wird ausgewertet als: a Or (b And c)
```

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
If punkte > 1000
  Color 5
ElseIf punkte > 500
  Color 3
ElseIf punkte > 0
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

**Endlosschleife:**
```blitz
While 1
  ; Hauptschleife
Wend
```

**Mit Bedingung:**
```blitz
i = 0
While i < 10
  i = i + 1
Wend
```

---

### For

```blitz
For <variable> = <start> To <ende> [Step <schritt>]
  ; body
Next [<variable>]
```

```blitz
; Aufwärts zählen
For i = 0 To 7
  arr(i) = 0
Next i

; Mit Schrittweite
For x = 0 To 319 Step 2
  Plot x, 100
Next x

; Rückwärts
For i = 7 To 0 Step -1
  arr(i) = i * 2
Next i
```

- `Next` kann ohne Variablenname geschrieben werden.
- `Step` kann eine Variable oder ein Ausdruck sein.

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

- Mehrere Werte pro `Case` durch Komma trennen.
- `Default` ist optional.

---

## 6. Funktionen & Prozeduren

BASSM unterstützt benutzerdefinierte Unterprogramme in zwei Varianten —
entsprechend der **Blitz2D-Signatur-Konvention**:

| Form | Klammern | Rückgabewert | Aufruf |
|------|----------|--------------|--------|
| `Function Name(p1, p2)` | **ja** | **ja** — in Ausdrücken verwendbar | `x = Name(a, b)` |
| `Function Name p1, p2` | **nein** | **nein** — nur als Statement aufrufbar | `Name a, b` |

### Funktion mit Rückgabewert

```blitz
Function Clamp(n, lo, hi)
  If n < lo Then Return lo
  If n > hi Then Return hi
  Return n
EndFunction

Function Add(a, b)
  Return a + b
EndFunction
```

Aufruf **im Ausdruck**:
```blitz
x = Clamp(meinWert, 0, 100)
y = Add(x, 50) * 2
```

### Prozedur (kein Rückgabewert)

```blitz
Function DrawBox x, y
  Box x, y, 16, 16
EndFunction

Function SetupColors r, g, b
  PaletteColor 1, r, g, b
  PaletteColor 2, 15-r, g, b
EndFunction
```

Aufruf **als Statement** (mit oder ohne Klammern):
```blitz
DrawBox 100, 50
DrawBox(100, 50)    ; auch gültig
SetupColors 15, 8, 0
```

> **Fehler:** Eine Prozedur (ohne Klammern in der Deklaration) in einem Ausdruck
> zu verwenden (`x = DrawBox(...)`) ist ein Compiler-Fehler.

### Return

```blitz
Return          ; verlässt die Funktion/Prozedur sofort (kein Wert)
Return expr     ; verlässt eine Funktion und gibt expr zurück
```

`Return` ohne Ausdruck ist in beiden Varianten erlaubt (Early Exit).
`Return expr` ist nur in Funktionen mit Klammern erlaubt.

### Lokale Variablen

Parameter und alle Variablen, die innerhalb einer Funktion zugewiesen werden,
sind **lokal** — sie existieren nur für die Dauer des Aufrufs und überschreiben
keine gleichnamigen globalen Variablen.

```blitz
x = 42                      ; globales x

Function Test(x)            ; lokaler Parameter x
  y = x * 2                 ; lokales y
  Return y
EndFunction

z = Test(10)                ; z = 20, globales x bleibt 42
```

### Einschränkungen

- Maximale Parameteranzahl: unbegrenzt (Stack-basiert)
- Keine Rekursion empfohlen (Stack-Tiefe auf dem Amiga begrenzt)
- Keine verschachtelten Funktionsdefinitionen
- `Dim` innerhalb von Funktionen erzeugt ein **globales** Array

---

## 7. Systemsteuerung

### Graphics
```blitz
Graphics breite, höhe, tiefe
```
**Muss die allererste Anweisung sein.**

| Parameter | Beschreibung |
|-----------|--------------|
| `breite` | Nur `320` (PAL Lores) |
| `höhe` | z.B. `256` (PAL) oder `200` |
| `tiefe` | 1–6 Bitplanes → 2–64 Farben |

```blitz
Graphics 320,256,4   ; 320×256 Pixel, 16 Farben
Graphics 320,200,5   ; 320×200 Pixel, 32 Farben
```

### ScreenFlip
```blitz
ScreenFlip
```
Zeigt das gezeichnete Bild auf dem Bildschirm. BASSM verwendet immer
**Double Buffering**: du zeichnest unsichtbar im Hintergrund, `ScreenFlip`
tauscht Vorder- und Hinterbild. Wartet automatisch auf den nächsten
Bildschirm-Refresh (50 mal pro Sekunde).

### WaitVbl
```blitz
WaitVbl
```
Wartet auf den nächsten Bildschirm-Refresh (ca. 50 mal pro Sekunde, PAL).

### Delay
```blitz
Delay n
```
Wartet `n` Bildschirm-Refreshes lang.
```blitz
Delay 50     ; ca. 1 Sekunde warten
Delay tempo  ; variable Pause
```

### End
```blitz
End
```
Beendet das Programm und kehrt zum Amiga-Betriebssystem zurück.

---

## 8. Grafik — Grundlagen

### Koordinatensystem

- Ursprung `(0,0)` ist **oben links**.
- X wächst nach rechts.
- Y wächst nach unten.

### Double Buffering

BASSM zeichnet immer im unsichtbaren Hinterbild. Erst `ScreenFlip` macht
das Gezeichnete sichtbar. Typische Hauptschleife:

```blitz
While 1
  Cls                  ; Hinterbild löschen
  ; ... zeichnen ...
  ScreenFlip           ; Hinterbild zeigen
Wend
```

### Cls
```blitz
Cls
```
Löscht den gesamten Hintergrund mit der durch `ClsColor` gesetzten Farbe
(Standard: 0 = schwarz). Sehr schnell.

---

## 9. Grafik — Zeichenbefehle

Alle Zeichenbefehle verwenden die mit `Color` gesetzte Farbe und zeichnen
ins Hinterbild.

### Plot
```blitz
Plot x, y
```
Setzt einen einzelnen Pixel.

### Line
```blitz
Line x1, y1, x2, y2
```
Zeichnet eine Linie von `(x1,y1)` nach `(x2,y2)`.

### Rect
```blitz
Rect x, y, breite, höhe
```
Zeichnet einen **Rechteck-Umriss** (nicht gefüllt).
`(x,y)` ist die obere linke Ecke.

### Box
```blitz
Box x, y, breite, höhe
```
Zeichnet ein **gefülltes Rechteck**. `(x,y)` ist die obere linke Ecke.
Verwendet den Hardware-Zeichnungsbeschleuniger des Amiga — sehr schnell.

### LoadImage / DrawImage

```blitz
LoadImage index, "datei.raw", breite, höhe
DrawImage index, x, y
```

Lädt ein vorkonvertiertes Bild und zeichnet es in den Back-Buffer (Blitter A→D, sehr schnell).

| Parameter | Beschreibung |
|-----------|--------------|
| `index` | Bild-Nummer 0–… |
| `"datei.raw"` | Dateiname relativ zum Projektordner (`images/`-Unterordner empfohlen) |
| `breite` / `höhe` | Bildgröße in Pixeln |
| `x`, `y` | Zielposition (obere linke Ecke) |

```blitz
LoadImage 0, "images/player.raw", 16, 16
LoadImage 1, "images/bullet.raw", 8, 8

While 1
  DrawImage 0, px, py
  DrawImage 1, bx, by
  ScreenFlip
Wend
```

**Dateiformat (`.raw`):** Erzeugt vom Asset Manager. Enthält zuerst die OCS-Palette
(`2^tiefe × 2 Bytes`, Big-Endian `$0RGB`), gefolgt von den planaren Bitplane-Daten
(Plane 0 zuerst, dann Plane 1 usw.). Jede Zeile ist auf Wortgrenzen aufgefüllt
(`((breite+15)/16)*2` Bytes).

> **Auto-Palette:** `LoadImage 0` liest die im Bild eingebettete Palette und setzt
> **automatisch** alle OCS-Farbregister. Ein explizites `PaletteColor` ist für
> Bild-basierte Programme **nicht** nötig.

> **Wort-Ausrichtung:** `x` muss durch 16 teilbar sein (`x % 16 == 0`). Der OCS-Blitter
> rundet die Zieladresse auf Wortgrenzen ab — Positionen wie `x=8` werden als `x=0`
> gezeichnet und können zu Ghost-Pixeln führen. Im Code `b(i)\x And -16` verwenden.

> **Kein Clipping:** `(x + breite)` darf den rechten Bildschirmrand nicht überschreiten.

---

## 10. Palette & Farben

Der Amiga hat eine Palette mit **32 Farben** (Indizes 0–31). Jede Farbe
hat einen Rot-, Grün- und Blauanteil von je **0 bis 15** (4-Bit, nicht 0–255
wie am PC).

### Color
```blitz
Color index
```
Setzt die aktuelle Zeichenfarbe (Palette-Index 0–31).

```blitz
Color 1          ; feste Farbe
Color i + 1      ; Ausdruck als Farbe
Color farbe(i)   ; Array-Element als Farbe
```

### PaletteColor
```blitz
PaletteColor n, r, g, b
```
Ändert Palette-Eintrag `n` zur Farbe `(r, g, b)`.
Jeder Kanal: **0–15** (nicht 0–255!).

> **Tipp:** Bei Bild-basierten Programmen setzt `LoadImage 0` die Palette automatisch
> aus dem Bild. `PaletteColor` ist dann nur noch nötig, wenn Farben nachträglich
> geändert werden sollen.

```blitz
PaletteColor 1, 15, 0, 0      ; Rot
PaletteColor 2, 0, 15, 0      ; Grün
PaletteColor 3, 0, 0, 15      ; Blau
PaletteColor 4, 15, 8, 0      ; Orange
PaletteColor 1, r, g, b       ; aus Variablen
PaletteColor 1, t, 15-t, 0    ; Palette-Animation
```

### ClsColor
```blitz
ClsColor n
```
Setzt die Hintergrundfarbe für `Cls`. Für schwarzen Hintergrund: `ClsColor 0`
(das ist auch der Standard).

```blitz
ClsColor 0    ; Hintergrund schwarz (Standard)
```

### CopperColor
```blitz
CopperColor zeile, r, g, b
```
Setzt die Hintergrundfarbe an einer bestimmten Bildschirmzeile.
Damit lassen sich **Farbverläufe** über den Bildschirm erzeugen — ein
klassischer Amiga-Effekt (Rasterbalken).

| Parameter | Beschreibung |
|-----------|--------------|
| `zeile` | Bildschirmzeile (0 = oben, maximal 211) |
| `r` | Rot 0–15 |
| `g` | Grün 0–15 |
| `b` | Blau 0–15 |

Der Befehl verändert nur die Hintergrundfarbe (`Color 0`) — nicht die
Farben von gezeichneten Objekten. Er kostet **keine Rechenzeit** während
der Bildschirmausgabe.

```blitz
; Statisch: Zeile 50 in Rot
CopperColor 50, 15, 0, 0

; Farbverlauf über den ganzen Bildschirm
r = 0 : b = 15
For zeile = 0 To 211
  CopperColor zeile, r, 0, b
  r = r + 1 : If r > 15 : r = 0 : EndIf
  b = b - 1 : If b < 0  : b = 15 : EndIf
Next zeile
ScreenFlip
```

> **Hinweis:** `CopperColor` existiert in Blitz2D für Windows nicht —
> es ist ein reiner Amiga-Effekt.

### Standard-Palette

Beim Programmstart stehen diese Farben zur Verfügung:

| Index | Farbe |
|-------|-------|
| 0 | Schwarz |
| 1 | Weiß |
| 2 | Rot |
| 3 | Grün |
| 4 | Blau |
| 5 | Gelb |
| 6 | Magenta |
| 7 | Cyan |
| 8 | Mittelgrau |
| 9 | Dunkelgrau |
| 10 | Hellgrau |
| 11 | Orange |
| 12 | Braun |
| 13 | Hellgrün |
| 14 | Himmelblau |
| 15 | Rosa |
| 16–31 | Schwarz (Reserve) |

---

## 11. Eingabe

### WaitKey
```blitz
WaitKey
```
Hält das Programm an, bis eine Taste gedrückt und losgelassen wird.

---

## 12. Text & Debug-Ausgabe

### Text
```blitz
Text x, y, "string"
```
Schreibt Text auf den Bildschirm (ins Hinterbild) mit der aktuellen
`Color`-Farbe. Der Text erscheint erst nach `ScreenFlip`.

| Parameter | Beschreibung |
|-----------|--------------|
| `x` | X-Position in Pixel |
| `y` | Y-Position in Pixel |
| `"string"` | Der anzuzeigende Text (muss ein festes String-Literal sein) |

Der eingebaute Font ist 8×8 Pixel groß (monospaced).

```blitz
Color 15
Text 10, 4, "HALLO AMIGA"

Color 8
Text 10, 230, "DRUECKE EINE TASTE"

; Mehrere Zeilen — einfach mehrere Text-Aufrufe:
Text 8, 100, "PUNKTE: 1000"
Text 8, 110, "LEBEN:     3"
```

> **Einschränkung:** `Text` akzeptiert nur **feste Texte** (String-Literale).
> Zahlen können nicht direkt angezeigt werden — es gibt kein `str$(n)`.

### NPrint
```blitz
NPrint "string"
```
Hat keinen sichtbaren Effekt. Nur für Blitz2D-Kompatibilität vorhanden.

---

## 13. Sound

Sound-Dateien müssen als **rohe 8-Bit-PCM-Mono-Daten** im Ordner `app/assets/`
gespeichert sein. Geeignete Dateien lassen sich z.B. mit Audacity exportieren:
Format „Raw Data", Encoding „Signed 8-bit PCM", Mono.

Der Amiga hat **4 unabhängige Sound-Kanäle** (0–3), die gleichzeitig
laufen können. Das Abspielen eines Sounds belastet die CPU **nicht** —
der Amiga erledigt das automatisch im Hintergrund.

### LoadSample
```blitz
LoadSample index, "datei.raw"
```
Registriert eine Sound-Datei unter einer Nummer. Diese Anweisung muss
**vor der Hauptschleife** stehen.

```blitz
LoadSample 0, "kick.raw"
LoadSample 1, "bass.raw"
LoadSample 2, "treffer.raw"
```

> **Hinweis:** `LoadSample` selbst spielt noch nichts ab — es lädt nur die
> Datei in das Programm ein.

### PlaySample
```blitz
PlaySample index, kanal [, period [, lautstärke]]
```
Spielt ein Sample **als Endlos-Loop** auf dem angegebenen Kanal ab.

| Parameter | Standard | Beschreibung |
|-----------|----------|--------------|
| `index` | — | Sample-Nummer (wie in `LoadSample`) |
| `kanal` | — | Sound-Kanal 0–3 |
| `period` | **428** | Tonhöhe: `3546895 / Hz`; 428 ≈ 8287 Hz, 214 ≈ 16574 Hz |
| `lautstärke` | **64** | 0 (still) bis 64 (volle Lautstärke) |

```blitz
PlaySample 0, 0              ; Kanal 0, Standardwerte
PlaySample 1, 1, 214         ; Kanal 1, doppelte Tonhöhe
PlaySample 2, ch, per, vol   ; alle Werte aus Variablen
```

Für Hintergrundmusik oder Dauertöne geeignet. Mit `StopSample` anhalten.

### PlaySampleOnce
```blitz
PlaySampleOnce index, kanal [, period [, lautstärke]]
```
Spielt ein Sample **genau einmal** ab. Danach wird der Kanal automatisch
still — kein `StopSample` nötig, kein Klicken.

Gleiche Parameter wie `PlaySample`.

```blitz
PlaySampleOnce 0, 0             ; Boing-Sound einmalig
PlaySampleOnce 1, ch, 214, 48   ; einmalig, halbe Lautstärke
```

Ideal für **Soundeffekte**: Kollision, Schuss, Sprung, Münze.

> Wenn zwei Boxen gleichzeitig kollidieren und beide `PlaySampleOnce` auf
> demselben Kanal aufrufen, hört man nur einen Sound. Für parallele Effekte
> verschiedene Kanäle verwenden.

### StopSample
```blitz
StopSample kanal
```
Stoppt sofort die Wiedergabe auf dem angegebenen Kanal.

```blitz
StopSample 0        ; Kanal 0 stoppen
StopSample ch       ; Kanal aus Variable
```

### Vier unabhängige Kanäle

| Kanal | Typische Verwendung |
|-------|---------------------|
| 0 | Soundeffekte (links) |
| 1 | Soundeffekte (rechts) |
| 2 | Musik / Hintergrund (links) |
| 3 | Musik / Hintergrund (rechts) |

---

## 14. Amiga-spezifisches Verhalten

### ScreenFlip ist Pflicht
`ScreenFlip` muss am Ende jedes Frames aufgerufen werden — sonst sieht
man das gezeichnete Bild nicht. Das ist anders als in PC-Blitz2D, das
automatisch zeichnet.

### Farben haben nur 16 Stufen
Amiga OCS hat 4 Bit pro Farbkanal: Werte von **0 bis 15**, nicht 0–255.

```blitz
PaletteColor 1, 15, 8, 0    ; Orange — r=15, g=8, b=0
; NICHT:       255, 128, 0  — das wäre PC-Blitz2D
```

### CopperColor und der Bildschirm
`CopperColor` setzt die Hintergrundfarbe (`Color 0`) an bestimmten Zeilen.
Es betrifft ausschließlich den Hintergrund, nicht die darauf gezeichneten
Objekte. Die Änderung wird beim nächsten `ScreenFlip` sichtbar.

### Sound kostet keine Rechenzeit
Sobald `PlaySample` oder `PlaySampleOnce` aufgerufen wurde, läuft der
Sound vollständig automatisch im Hintergrund. Die Hauptschleife wird
dadurch nicht verlangsamt.

### Multiplikation: Vorsicht bei großen Zahlen
`*` funktioniert korrekt für Werte bis **32767**. Größere Werte können
zu falschen Ergebnissen führen. Für Bildschirmkoordinaten ist das
normalerweise kein Problem.

---

## 15. Bekannte Einschränkungen

| Einschränkung | Erklärung |
|---------------|-----------|
| Nur 320px Breite | `Graphics` akzeptiert nur `width=320` |
| Nur ganze Zahlen | Keine Kommazahlen, keine Strings als Variablen |
| Text: nur feste Texte | `Text` zeigt keine Zahlen oder Variableninhalte |
| Kein Bounds-Checking | Array-Überläufe korrumpieren Speicher stillschweigend |
| `*` bis 32767 | Multiplikation mit größeren Zahlen liefert falsche Ergebnisse |
| OS-Restore (vAmiga) | Nach `End` erscheint unter AROS/vAmiga kein Workbench-Fenster wieder |

---

## 16. Vollständiges Beispiel

Copper-Rasterbalken + 8 springende Boxen + Text + Sound.
Läuft stabil mit 50 fps auf dem Amiga 500.

```blitz
; Rasterbalken + 8 Bouncing Boxes + Text + Sound
Graphics 320,256,4

LoadSample 0, "boing.raw"

Dim bx(7) : Dim by(7) : Dim bdx(7) : Dim bdy(7)

bx(0)=10  : by(0)=20  : bdx(0)=3  : bdy(0)=2
bx(1)=100 : by(1)=50  : bdx(1)=-4 : bdy(1)=3
bx(2)=200 : by(2)=30  : bdx(2)=2  : bdy(2)=-3
bx(3)=50  : by(3)=150 : bdx(3)=-3 : bdy(3)=-2
bx(4)=250 : by(4)=100 : bdx(4)=4  : bdy(4)=2
bx(5)=130 : by(5)=200 : bdx(5)=-2 : bdy(5)=4
bx(6)=80  : by(6)=120 : bdx(6)=5  : bdy(6)=-3
bx(7)=280 : by(7)=180 : bdx(7)=-3 : bdy(7)=5

; Text einmalig in beide Bildschirm-Buffer zeichnen
Color 15 : Text 8, 4,   "BASSM DEMO  * AMIGA OCS *"
Color 8  : Text 8, 236, "CODE: BASSM COMPILER  FONT: 8X8"
ScreenFlip
Color 15 : Text 8, 4,   "BASSM DEMO  * AMIGA OCS *"
Color 8  : Text 8, 236, "CODE: BASSM COMPILER  FONT: 8X8"

t = 0

While 1
  ; Animierter Farbverlauf über den Bildschirm (Rasterbalken)
  t = t + 1 : If t > 15 : t = 0 : EndIf
  rc = t : gc = 15 - t
  For zeile = 0 To 211
    CopperColor zeile, rc, 0, gc
    rc = rc + 1 : If rc > 15 : rc = 0 : EndIf
    gc = gc - 1 : If gc < 0  : gc = 15 : EndIf
  Next zeile

  ; 8 Boxen bewegen und bei Wandkontakt abprallen + Sound
  For i = 0 To 7
    bx(i) = bx(i) + bdx(i) : by(i) = by(i) + bdy(i)
    If bx(i) < 0   : bx(i) = 0   : bdx(i) = -bdx(i) : PlaySampleOnce 0, 0 : EndIf
    If bx(i) > 304 : bx(i) = 304 : bdx(i) = -bdx(i) : PlaySampleOnce 0, 0 : EndIf
    If by(i) < 16  : by(i) = 16  : bdy(i) = -bdy(i) : PlaySampleOnce 0, 0 : EndIf
    If by(i) > 220 : by(i) = 220 : bdy(i) = -bdy(i) : PlaySampleOnce 0, 0 : EndIf
    Color i + 1
    Box bx(i),by(i),16,16
  Next i

  ScreenFlip
Wend
```

---

## 17. Die IDE — Hauptfenster

BASSM ist eine eigenständige Electron-Anwendung mit integriertem Editor,
Emulator-Vorschau und Build-Pipeline.

### Fenster-Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  📁 Open Project  ▶ Run  🖼 Assets  │ Projektname │    Status       │
├──────────────────┬──────────────────────────────┬───────────────────┤
│  Project         │                              │                   │
│  ├ main.bassm    │                              │  vAmiga           │
│  ├ images/       │       Monaco Editor          │  Emulator         │
│  │  └ blob.raw   │       (Blitz2D Syntax)       │  Vorschau         │
│  └ sounds/       │                              │                   │
│                  │                              ├───────────────────┤
│  Outliner        │                              │  Console          │
│  ├ fn  Clamp     │                              │  (Assembly-Log,   │
│  └ proc DrawMark │                              │   Fehlermeldungen)│
└──────────────────┴──────────────────────────────┴───────────────────┘
```

### Toolbar

| Schaltfläche | Funktion |
|---|---|
| `📁 Open Project` | Öffnet einen Projektordner; lädt `main.bassm` in den Editor |
| `▶ Run` | Kompiliert, assembliert und startet das Programm im Emulator |
| `🖼 Assets` | Öffnet den Asset Manager als separates Fenster |
| Projektname | Zeigt den Namen des geöffneten Ordners |
| Status | `Ready` · `Compiling…` · `Running` · `Error` |

### Linke Seitenleiste

**Project Tree** — zeigt alle Dateien des Projektordners rekursiv.
Klick auf eine `.bassm`-Datei öffnet sie im Editor.
Asset-Dateien (`.raw`, Bilder, Sounds) werden angezeigt, können aber
nicht direkt bearbeitet werden.
`main.bassm` ist der Einstiegspunkt und wird immer zuerst gelistet.
Der Baum aktualisiert sich automatisch wenn Dateien extern hinzugefügt,
geändert oder gelöscht werden.

**Outliner** — listet alle `Function`-Deklarationen im aktuellen Quelltext.
Klick auf einen Eintrag springt direkt zur entsprechenden Zeile im Editor.

### Editor

Monaco-Editor mit BASSM-Syntax-Highlighting:

| Token | Farbe |
|---|---|
| Keywords (`If`, `While`, `For`, …) | blau |
| String-Literale (`"text"`) | orange |
| Zahlen (`42`, `$FF`, `%1010`) | hellgrün |
| Kommentare (`;` und `//`) | grün-grau, kursiv |

### Run-Workflow

Klick auf `▶ Run` führt diese Schritte automatisch aus:

1. **Auto-Save** — die aktuelle Datei wird auf Disk gespeichert
2. **Include-Expansion** — `Include "datei.bassm"` werden aufgelöst
3. **Kompilierung** — Blitz2D → m68k-Assembly (BASSM Compiler)
4. **Assemblierung** — `vasmm68k_mot -Fhunk` → Objekt-Datei
5. **Linken** — `vlink -bamigahunk` → AmigaOS HUNK-Executable
6. **Start** — Binary wird an den vAmiga-Emulator gesendet; AROS bootet sofort

Die generierte Assembly und Fehlermeldungen erscheinen in der **Console**.
Das Binary wird zusätzlich als `out/bassm_out.exe` gespeichert —
kompatibel mit WinUAE und echter Amiga-Hardware.

### Projektstruktur

Ein Projekt ist ein einfacher Ordner mit einer `main.bassm`. Empfohlene
Struktur:

```
mein-projekt/
  main.bassm          ← Hauptquelltext (Pflicht)
  physics.bassm       ← Include-Datei (optional)
  images/
    player.png        ← Quell-Grafik (noch nicht konvertiert)
    player.raw        ← Konvertiertes Format (INCBIN)
  sounds/
    boing.raw         ← Amiga-PCM-Sample
```

---

## 18. Asset Manager

Der Asset Manager öffnet sich als separates Fenster über `🖼 Assets`.
Er konvertiert externe Mediendateien in Amiga-kompatible Formate und
zeigt alle Assets des Projekts übersichtlich in einer Liste.

### Linke Seitenleiste

Zeigt alle Assets des offenen Projekts in drei Gruppen:
**Palettes** · **Images** · **Sounds**.

| Markierung | Bedeutung |
|---|---|
| `◆` (amber) | Quell-Datei (PNG, JPG, WAV …) — noch nicht konvertiert |
| `✓` (grün) | Konvertierte Datei (`.raw`) — bereit für `INCBIN` |

Klick auf eine Quell-Datei öffnet sie direkt im Konverter.
Die Liste aktualisiert sich automatisch wenn der Projektordner
extern geändert wird (Datei hinzugefügt, umbenannt, gelöscht).

### Palette-Tab

Zeigt das 32-Slot-Palette-Raster des Projekts.
Klick auf einen Slot öffnet einen Farbwähler.

> **Hinweis:** Bei Bild-basierten Programmen übernimmt `LoadImage 0`
> die Palette automatisch aus dem Bild — manuelles Setzen ist selten nötig.

### Images-Tab — Bild-Konverter

Konvertiert PNG/JPG/BMP in das Amiga-Planar-Raw-Format.

**Bild laden — zwei Wege:**
- Quell-Datei in der linken Liste anklicken *(empfohlen)*
- PNG/JPG/BMP per Drag & Drop in die Drop-Zone ziehen

**Split-View:** Original links, OCS-Palette-Vorschau rechts.
Die Vorschau aktualisiert sich live bei jeder Änderung.

**Einstellungen:**

| Option | Beschreibung |
|---|---|
| **Depth** | Bitplanes (1–5) → 2–32 Farben; muss mit `Graphics`-Tiefe übereinstimmen |
| **Floyd-Steinberg** | Dithering für weichere Farbübergänge |
| **Match %** | Qualitätswert: 100 % = verlustfreie Übernahme |

**Aktionen:**

| Schaltfläche | Funktion |
|---|---|
| `Convert & Save` | Konvertiert und speichert als `images/<name>.raw` im Projektordner |
| `Copy Code` | Kopiert den passenden `LoadImage`-Befehl in die Zwischenablage |

**Ausgabe-Format (`.raw`):**

```
[2^depth × 2 Bytes]    OCS-Palette ($0RGB, Big-Endian)
[planare Bitplane-Daten]  Plane 0 (alle Zeilen) · Plane 1 · …
```

`LoadImage 0` liest die Palette automatisch aus dieser Datei und
setzt alle OCS-Farbregister — kein `PaletteColor` nötig.

### Sounds-Tab

Konvertiert WAV/MP3/OGG in 8-Bit-Signed-PCM-Mono (`.raw`) für Paula.

> **Hinweis:** Die Sound-Konvertierung ist noch in Entwicklung.

---

## Anhang: Präprozessor-Direktiven

```
Include "dateiname.bassm"
```

Werden vor dem Lexer ausgewertet — nicht Teil der eigentlichen Sprache.

## Anhang: Reservierte Schlüsselwörter

```
If  Then  Else  ElseIf  EndIf
While  Wend
For  To  Step  Next
Select  Case  Default  EndSelect
Dim
Function  EndFunction  Return
And  Or  Not  Mod
```

## Anhang: Reservierte Befehlsnamen

```
Graphics   Cls       ClsColor    Color       PaletteColor  CopperColor
WaitVbl    WaitKey   Delay       ScreenFlip  End
Plot       Line      Rect        Box
Text       NPrint
LoadSample PlaySample  PlaySampleOnce  StopSample
LoadImage  DrawImage
```

---

*Dokumentation für BASSM — Stand: 2026-03-15* · Sektionen 17–18: IDE & Asset Manager
