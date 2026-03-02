# BASSM – Implementierungs-Roadmap

## Status-Legende
- `[ ]` offen
- `[~]` in Arbeit / teilweise
- `[x]` fertig

---

## Milestone 0 — Kern-Pipeline ✅
Grundgerüst: PreProcessor → Lexer → Parser → CodeGen → vasm → vAmiga

- `[x]` PreProcessor (Kommentare, Leerzeilen)
- `[x]` Lexer (alle Token-Typen inkl. Keywords, Operatoren)
- `[x]` Parser (Commands mit Literal-Argumenten)
- `[x]` CodeGen (Grundstruktur, Fragments-Include, copper-Liste)
- `[x]` startup.s (bare-metal Übernahme, VBlank-Handler)
- `[x]` offload.s (OS-Restore: INTENA/DMACON/VBlank-Vektor)
- `[x]` graphics.s (Bitplane-Setup, copper-Install)
- `[x]` cls.s (CPU-Fill, Blitter-Ersatz)
- `[x]` clscolor.s
- `[x]` color.s / palette.s (32-Einträge OCS-Palette)
- `[~]` text.s (Stub — noch kein Bitmap-Font)

---

## Milestone 1 — Integer-Variablen & Ausdrücke ✅

Voraussetzung für fast alle weiteren Features.

### 1.1 Parser
- `[x]` Zuweisung: `x = <expr>` (IDENT EQ expr)
- `[x]` Ausdruck: Literale, Variablen, `+` `-` `*` `/` mit korrekter Präzedenz
- `[x]` Ausdruck: unäres Minus (`-x`)
- `[x]` Vergleich in Ausdrücken: `=  <>  <  >  <=  >=`
- `[x]` Variablen als Command-Argumente: `Delay n` statt `Delay 150`

### 1.2 CodeGen
- `[x]` Globale Integer-Variablen: BSS-Einträge (`ds.l 1`) im `vars_bss`-Abschnitt
- `[x]` Zuweisung: `move.l #val,_var` bzw. Ausdruck in d0 berechnen, dann speichern
- `[x]` Ausdruck-Evaluierung: rekursiver Codegen, Ergebnis in d0
  - Literal → `moveq`/`move.l #n,d0`
  - Variable → `move.l _var,d0`
  - Binäre Op → linken Teil in d0, push, rechten Teil in d1, Op ausführen
- `[x]` Stack-basierte Ausdruck-Auswertung (d0 = Akkumulator, Stack für Teilausdrücke)

---

## Milestone 2 — Kontrollfluss: If / Else ✅

- `[x]` Parser: `If <expr> Then <stmt>` (einzeilig)
- `[x]` Parser: `If <expr>` … `EndIf` (Block)
- `[x]` Parser: `If <expr>` … `Else` … `EndIf`
- `[x]` Parser: `ElseIf <expr>` Kette
- `[x]` CodeGen: Vergleich in CCR auswerten, `Bcc`-Sprung zu `.else_N` / `.endif_N`
- `[x]` CodeGen: Label-Generierung (eindeutige Zähler pro Scope)

---

## Milestone 3 — Schleifen: While & For ✅

### 3.1 While / Wend
- `[x]` Parser: `While <expr>` … `Wend`
- `[x]` CodeGen: Sprung zurück zum Schleifenkopf, Bedingung am Kopf prüfen

### 3.2 For / To / Step / Next
- `[x]` Parser: `For <var> = <expr> To <expr> [Step <expr>]` … `Next [<var>]`
- `[x]` CodeGen: Zählvariable initialisieren, Grenze prüfen, Step addieren

---

## Milestone 4 — Select / Case ✅

- `[x]` Parser: `Select <expr>` … `Case <val>` … `EndSelect`
- `[x]` Parser: `Default`-Branch
- `[x]` CodeGen: Vergleich gegen jeden Case-Wert, Sprung zu zugehörigem Block

---

## Milestone 5 — Zeichenbefehle ✅

Jeder Befehl benötigt ein Assembly-Fragment und einen CodeGen-Case.

- `[x]` `Plot x,y` — einzelnes Pixel setzen (Bitplane-Adresse berechnen, Bit setzen)
- `[x]` `Line x1,y1,x2,y2` — Bresenham-Linie
- `[x]` `Rect x,y,w,h` — Rechteck (Umriss)
- `[x]` `Box x,y,w,h` — gefülltes Rechteck (CPU: zeilenweiser _Line-Aufruf)
- `[ ]` `Circle x,y,r` — Kreis (optional, niedrige Prio)

> Alle Zeichenbefehle schreiben aktuell direkt in `_gfx_planes` (Single-Buffer, CPU-Fill).
> M5b und M5c ersetzen das durch Blitter + Double-Buffering.

---

## Milestone 5b — Blitter-Zeichenroutinen

Ersetzt die CPU-Fill-Schleifen in Cls/Box durch Blitter-DMA.
Blitter ist ~4× schneller als CPU-Move.l und gibt der CPU Zeit für Spiellogik.

> **Abhängigkeit:** Kann unabhängig von M5c implementiert werden.
> Blitter schreibt zunächst noch in den Single-Buffer (wie bisher).
> Vollständig erst sinnvoll nutzbar nach M5c (Double-Buffering).

### B1 — `_WaitBlit` Hilfsroutine ✅
- `[x]` `_WaitBlit` in `startup.s`: DMACONR Bit 14 (BBUSY) pollen
  - Solange Bit 14 gesetzt: busy-wait (`move.w DMACONR(a5),d0` / `btst #14,d0` / `bne`)
  - Vor jedem Blitter-Setup aufrufen
  - Blitter-Registerkonstanten (BLTCON0..BLTADAT, DMAB_BBUSY) in startup.s ergänzt
  - XDEF `_WaitBlit`

### B2 — Blitter-`_Cls` ✅
- `[x]` A→D Blitter-Fill: `BLTCON0=$09F0` (USEA+USED, minterm $F0 = D→A)
  - `_blt_ones_row` (DATA_C, `dcb.w GFXBPR/2,$FFFF`) und `_blt_zero_row` (BSS_C)
    als chip-RAM Quellmuster; XDEF'd für box.s
  - `BLTAMOD = -GFXBPR` — A-Pointer Reset nach jeder Zeile
  - `BLTDMOD = 0`, `BLTSIZE = (GFXHEIGHT<<6)|(GFXBPR/2)` (Compile-time Konstante)
  - Pro Plane 1 Blit mit `_WaitBlit` vor jedem Register-Setup

### B3 — Blitter-`_Box` ✅
- `[x]` Runtime-Masken und Modulos:
  - `BLTAFWM = $FFFF >> (x%16)`, `BLTALWM = $FFFF XOR ($FFFF >> ((x+w-1)%16+1))`
  - `word_count = (x%16 + w + 15) / 16`
  - `BLTDMOD = GFXBPR - word_count*2`, `BLTAMOD = -(word_count*2)`
  - `BLTSIZE = (h<<6) | word_count` startet den Blit
  - Prologue berechnet alles einmal; Plane-Loop hat klare Register-Zuordnung

### B4 — Blitter-`_Rect` (Umriss)
- `[ ]` 4 horizontale Blitter-Streifen (oben, unten, links, rechts)
  - Oben/Unten: volle Breite, 1 Zeile
  - Links/Rechts: 1 Wort breit, h-2 Zeilen (je Plane)
- `[ ]` `_Rect` in `rect.s` umschreiben

### B5 — Defer: Blitter-`_Line` und Blitter-`_Plot`
- `[ ]` Blitter Line-Mode für `_Line` (Amiga Blitter hat dedizierten Linienzieh-Mode)
- `[ ]` `_Plot` kann CPU-basiert bleiben (1 Pixel = vernachlässigbar)

---

## Milestone 5c — Double-Buffering

Eliminiert Screen-Tearing durch abwechselndes Zeichnen in Front- und Back-Buffer.
Copper zeigt immer den fertig gezeichneten Front-Buffer an; die CPU/Blitter zeichnen
ausschließlich in den Back-Buffer. `ScreenFlip` synchronisiert den Tausch mit dem VBL.

> **Abhängigkeit:** Setzt M5b voraus (Blitter muss in `_back_planes_ptr` schreiben,
> nicht in `_gfx_planes` direkt).

### C1 — Zweiten Bitplane-Satz allozieren
- `[ ]` `codegen.js`: BSS_C-Sektion auf `GFXPSIZE * GFXDEPTH * 2` Byte verdoppeln
  - `_gfx_planes` = Buffer A (Bytes 0 … GFXPSIZE×GFXDEPTH−1)
  - `_gfx_planes_b` = Buffer B (EQU `_gfx_planes + GFXPSIZE*GFXDEPTH`)
  - Chip-RAM-Bedarf für 320×256×5: 2 × 51 200 = 102 400 Byte ≈ 100 KB
    (OCS hat 512 KB Chip-RAM → ausreichend)

### C2 — Zwei Copper-Listen generieren
- `[ ]` `codegen.js`: emittiert `_gfx_copper_a` (Planes → Buffer A) und
  `_gfx_copper_b` (Planes → Buffer B) als separate DATA_C-Sektionen
- `[ ]` `_setup_graphics` ruft `_PatchBitplanePtrs` zweimal auf:
  - Einmal mit `_gfx_planes` → `_gfx_copper_a`
  - Einmal mit `_gfx_planes_b` → `_gfx_copper_b`
- `[ ]` `_InstallCopper` wird initial mit `_gfx_copper_a` aufgerufen (Front = A)

### C3 — Buffer-Tracking-Variablen
- `[ ]` Neue BSS-Variable in `startup.s` (oder separatem Fragment):
  - `_back_planes_ptr: ds.l 1` — Adresse des Back-Buffers (aktuell Buffer B)
  - `_front_is_a: ds.b 1` — Flag: 0 = Front ist A, 1 = Front ist B
- `[ ]` `_setup_graphics` initialisiert `_back_planes_ptr = _gfx_planes_b`
  und `_front_is_a = 0`

### C4 — `_ScreenFlip` Routine (`flip.s`)
- `[ ]` Neues Fragment `app/src/m68k/fragments/flip.s`
- `[ ]` Ablauf:
  1. `jsr _WaitVBL` — VBL abwarten (Tausch nur am Strahlaustast-Intervall)
  2. `_front_is_a` prüfen:
     - War Front = A → `_InstallCopper(_gfx_copper_b)`, `_back_planes_ptr = _gfx_planes`
     - War Front = B → `_InstallCopper(_gfx_copper_a)`, `_back_planes_ptr = _gfx_planes_b`
  3. Flag toggeln
- `[ ]` `XDEF _ScreenFlip`

### C5 — Zeichenbefehle auf Back-Buffer umstellen
- `[ ]` Alle Zeichenbefehle ersetzen `lea _gfx_planes,a0`
  durch `move.l _back_planes_ptr,a0`
  - `cls.s` (Blitter-BLTDPT bzw. CPU-Basisadresse)
  - `box.s` (Blitter-BLTDPT)
  - `plot.s` (Pixel-Adressberechnung)
  - `rect.s` (4 Streifen)
  - `line.s` (nutzt `_Plot` — wird automatisch korrekt wenn plot.s umgestellt)

### C6 — CodeGen + commands-map.json
- `[ ]` `commands-map.json`: Eintrag `{ "name": "ScreenFlip", "args": 0 }` ergänzen
- `[ ]` `codegen.js`: `case 'ScreenFlip': emit('jsr _ScreenFlip')`
- `[ ]` `bassm.js`: `flip.s` in die Fragment-Inklusionsliste aufnehmen
  (nach `waitkey.s`, vor `_main_program`)

### C7 — Demo updaten
- `[ ]` `app/index.html`: Bouncing-Box-Demo umstellen:
  - `WaitVbl` → `ScreenFlip`
  - Dirty-Erase (Color 0 / Box) entfernen — stattdessen am Frameanfang `Cls`
  - Ergebnis: sauberes, tearingfreies Bild mit vollem Screen-Clear pro Frame

---

## Milestone 6 — Text-Rendering (text.s)

- `[ ]` 8×8-Bitmap-Font in Chip-RAM (DATA_C, z.B. ASCII 32–127)
- `[ ]` `_Text x,y,"string"` — Zeichenkette pixelweise rendern
- `[ ]` `_NPrint "string"` — an aktueller Cursor-Position ausgeben, Cursor vorrücken
- `[ ]` Cursor-Variablen `_text_x`, `_text_y` in BSS

---

## Milestone 7 — Prozeduren / Funktionen

- `[ ]` Parser: `Function name([param,…])` … `EndFunction`
- `[ ]` Parser: Prozedur-Aufruf `name arg1,arg2` (wie Command, aber user-definiert)
- `[ ]` Parser: `Return [expr]`
- `[ ]` CodeGen: Funktions-Label + `rts`, Parameter via Stack oder Register-Konvention
- `[ ]` CodeGen: Aufruf `jsr _fn_name`
- `[ ]` Scope-Management: lokale Variablen auf dem Stack

---

## Milestone 8 — Arrays

- `[ ]` Parser: `Dim name(size)` — eindimensionales Integer-Array
- `[ ]` CodeGen: BSS-Allokation `_arr_name: ds.l size`
- `[ ]` Parser: Array-Lese-/Schreibzugriff `name(i)` in Ausdrücken und Zuweisungen
- `[ ]` CodeGen: Index-Berechnung → `move.l _arr_name(d0*4),d0`

---

## Milestone 9 — Eingabe

- `[x]` `WaitKey` — Programm anhalten bis Tastendruck (CIA-A SP-Flag, Ack-Handshake)
- `[ ]` `Joydown(port)` — Joystick-Richtung abfragen (CIA JOYSTICK-Register)
- `[ ]` `Joyfire(port)` — Feuerknopf
- `[ ]` `KeyDown(code)` — Tastaturabfrage (CIA-A, Keyboard-Scan)
- `[ ]` `Inkey$()` — letztes gedrücktes Zeichen (optional)

---

## Milestone 10 — Erweiterte Grafik

> Double-Buffering und Blitter-Primitives wurden vorgezogen → M5b + M5c.

- `[ ]` `LoadPalette` — Palette aus Array laden
- `[ ]` Sprite-System (Hardware-Sprites, 8 Stück, 16px breit)
- `[ ]` Hardware-Scrolling (BPLCON1, BPL1MOD)
- `[ ]` `Circle x,y,r` — Kreis (Bresenham)

---

## Milestone 11 — String-Variablen

- `[ ]` String-Variablen (`name$ = "text"`)
- `[ ]` String-Konkatenation (`a$ + b$`)
- `[ ]` `Len(s$)`, `Left$(s$,n)`, `Mid$(s$,pos,n)`, `Right$(s$,n)`
- `[ ]` `Val(s$)`, `Str$(n)` — Konvertierung

---

## Offene Probleme / Bekannte Bugs

- `[~]` **OS-Restore (vAmiga/AROS)**: Nach Programmende wird der Screen dunkelgrau
  statt zum Workbench-Fenster zurückzukehren. LoadView+RethinkDisplay
  implementiert aber noch nicht ausreichend. → Siehe `MEMORY.md`.

---

## Reihenfolge-Empfehlung

```
M1 Variablen  →  M2 If/Else  →  M3 Schleifen  →  M6 Text
     ↓                                                ↓
M5 Zeichnen   →  M5b Blitter  →  M5c Double-Buffer  →  M7 Funktionen
                                                            ↓
                                               M8 Arrays  →  M9 Input
```

Empfohlene Implementierungsreihenfolge für M5b+M5c:
1. **B1** `_WaitBlit` (Voraussetzung für alle Blitter-Routinen)
2. **B2** Blitter-`_Cls` testen (einfachster Blitter-Use-Case → Machbarkeit prüfen)
3. **C1–C4** Double-Buffering-Infrastruktur (Copper-Swap, `_ScreenFlip`)
4. **C5** Zeichenbefehle auf Back-Buffer umstellen
5. **B3** Blitter-`_Box` (profitiert sofort vom Double-Buffer)
6. **C6–C7** CodeGen + Demo-Update

M4 (Select) und M10–M11 nach Bedarf parallel einschieben.
