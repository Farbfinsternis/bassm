# Performance-Optimierungspotenzial für BASSM (m68k)

> **Hinweis:** Diese Datei ist in ROADMAP.md (PERF-A, PERF-B, PERF-low) konsolidiert.
> Hier als detaillierte Referenz mit Implementierungshinweisen erhalten.

Basierend auf der Analyse des generierten Assembler-Codes für die Bouncing-Box-Demo wurden folgende Bereiche identifiziert, in denen die Performance signifikant gesteigert werden kann.

---

## Aufwandslegende

| Symbol | Bedeutung |
|--------|-----------|
| 🟢 Niedrig | 1–20 Zeilen, isolierte Änderung in `codegen.js` |
| 🟡 Mittel  | 30–80 Zeilen, neue Hilfsmethode oder zweigleisige Codepfade |
| 🔴 Hoch    | Grundlegendes Redesign eines Compiler-Passes |

---

## 1. Register-Caching (Variable Mapping)

Aktuell werden Variablen bei jeder Operation aus dem Speicher geladen und wieder zurückgeschrieben:
```m68k
move.l  _var_x,d0
add.l   d1,d0
move.l  d0,_var_x
```
**Verbesserung:** Häufig genutzte Variablen (wie `x, y, dx, dy`) sollten während der Hauptschleife in den Registern `d2-d7` gehalten werden. Ein `move.l d2,d0` ist wesentlich schneller als ein Speicherzugriff.

### 🔴 Aufwand: Hoch

**Was sich ändern muss:**
- Neuer Pre-Pass: Häufigkeitsanalyse aller Variablen je Scope (Schleifenrumpf)
- Registervergabe-Tabelle (welche Variable → welches Register, wann Spill)
- `_genExpr` case `'ident'`: statt `move.l _var_x,d0` ggf. `move.l d2,d0`
- `_genStatement` case `'assign'`: statt `move.l d0,_var_x` ggf. `move.l d0,d2`
- **Spill-Logik:** Bei `jsr`-Aufrufen müssen Register-gebundene Variablen auf den
  Stack gesichert werden, falls die aufgerufene Subroutine `d2–d7` nicht rettet
  (alle aktuellen Fragmente retten nur `d0–d1`/`a0–a2`, NICHT `d2–d7`)
- Scope-Grenzen müssen sauber erkannt werden (While-Body, If-Zweige, …)

**Priorisierung:** Lohnt sich erst, wenn viele Variablen und enge Schleifen typisch sind. Kann bis nach M7 (Funktionen) verschoben werden, da Funktionen ohnehin Scope-Tracking erfordern.

---

## 2. Eliminierung des Stacks bei Ausdrücken

Der Compiler nutzt ein generisches Stack-Modell für Berechnungen:
```m68k
move.l  d0,-(sp)  ; Push rechts
move.l  _var_x,d0 ; Lade links
move.l  (sp)+,d1  ; Pop rechts
add.l   d1,d0     ; Operation
```
**Verbesserung:** Für einfache binäre Operationen — wenn der rechte Operand ein Literal oder eine einzelne Variable ist — kann der Stack komplett entfallen:
```m68k
; x + 3  (right = literal)
move.l  _var_x,d0
add.l   #3,d0

; x + y  (right = single ident)
move.l  _var_x,d0
add.l   _var_y,d0
```

### 🟡 Aufwand: Mittel

**Was sich ändern muss:**
- Neue Hilfsmethode `_isSimpleExpr(expr)` → `true` wenn `int` oder einzelner `ident`
- In `_genBinop`: Sonderfall wenn `isSimpleExpr(expr.right)` — direkter Immediate- oder
  Speicher-Operand, kein Push/Pop. Die Arithmetik-Opcodes `add.l`, `sub.l`, `cmp.l`
  erlauben alle Memory/Immediate als Quelloperand.
- Achtung Ausnahme: `muls.w` und `divs.w` erlauben nur Register als Quell-Operand →
  `d1` muss trotzdem geladen werden; Push-Pfad bleibt für `*` und `/` vorerst.
- Betrifft `_genBinop` (ca. 40 Zeilen) — keine anderen Methoden.

**Priorisierung:** Hoch — die häufigsten Ausdrücke (`x + 1`, `x + dx`, `x < 320`) wären sofort schneller.

---

## 3. Direkte Bedingungssprünge (Bcc statt Scc)

Aktuell wird für Vergleiche ein boolescher Wert (-1 oder 0) erzeugt, der dann geprüft wird:
```m68k
cmp.l   d1,d0
slt     d0        ; Setze d0 wenn <
ext.w   d0        ; Vorzeichenerweiterung
ext.l   d0
tst.l   d0
beq.w   .L2       ; Springe wenn False
```
**Verbesserung:** Direkte Nutzung der CPU-Flags. Ein `cmp.l d1,d0` gefolgt von einem `bge.s .L2` ersetzt fünf Instruktionen durch eine einzige.

### 🟡 Aufwand: Mittel

**Was sich ändern muss:**
- Neue Methode `_genCondBranch(expr, falseLbl, lines)`: wenn `expr` ein direkter
  Vergleich ist (`binop` mit `= <> < > <= >=`), emittiert sie `cmp + Bcc` statt den
  `scc`-Weg. Andernfalls Fallback auf `_genExpr + tst.l + beq.w`.
- `_genIf` und `_genWhile` rufen statt `_genExpr` die neue Methode auf.
- **Wichtige Einschränkung:** Der `scc`-Weg muss erhalten bleiben für den Fall, dass
  ein Vergleich als Ausdruck verwendet wird (z.B. `x = a < b` oder `If (a<b) * (c<d)`).
  Die neue Methode ist nur für die Condition direkt in `If`/`While` gedacht.
- Betrifft `_genIf`, `_genWhile`, neue Methode: ca. 35 Zeilen.

**Priorisierung:** Hoch — jede If/While-Condition spart 4 Instruktionen pro Frame.

---

## 4. ✅ Optimierung der Hauptschleife (`While 1`) — ERLEDIGT

~~Die Endlosschleife wird aktuell jedes Mal evaluiert:~~
```m68k
; vorher (3 tote Instruktionen pro Frame):
moveq   #1,d0
tst.l   d0
beq.w   .L1
```
```m68k
; nachher (While 1 / While <non-zero-literal>):
.L0:
    ; … body …
    bra.w   .L0
```
**Implementiert in `codegen.js` `_genWhile`:** Wenn `stmt.cond.type === 'int'` und Wert ≠ 0,
wird kein Condition-Code emittiert — weder `moveq` noch `tst.l` noch `beq.w`, und
`endLbl` wird nicht einmal vergeben.

---

## 5. "Short Branches" nutzen

Der Compiler nutzt durchgehend `.w` (Word) Offsets für Sprünge (z.B. `bra.w`).
**Verbesserung:** Wenn das Sprungziel weniger als 128 Bytes entfernt ist, sollte `.s` (Short) verwendet werden.

### 🟢 Aufwand: Niedrig (für Rückwärts-Branches)

**Was sich ändern muss:**
- Rückwärts-Branches (Schleifen-Kopf in `bra.w topLbl`) sind immer sicher als `.s`
  wenn der Loop-Body kurz ist — aber der CodeGen kennt die Byte-Größe des Bodies
  nicht.
- **Pragmatischer Ansatz:** vasmm68k_mot optimiert `bra.s` → `bra.w` **nicht**
  automatisch (Motorola-Syntax). Daher ist der sicherste Weg: bei Rückwärts-
  Branches immer `.w` belassen, ODER eine Byte-Zählung des generierten Textes
  einbauen (aufwendig).
- **Alternativer Ansatz:** Bei vorwärts-Branches in `_genIf` ohne
  ElseIf/Else-Kette und kurzen Bodies `.s` nutzen — riskant ohne Messung.
- **Empfehlung:** Diese Optimierung hat den kleinsten Effekt (2 Bytes pro Branch,
  kein Laufzeit-Unterschied auf dem 68000 außer Cache-Effekten). Niedrige Prio.

---

## 6. Grafik-Optimierung: Dirty Rects vs. Cls

In der Demo wird in jedem Frame der gesamte Screen mit `_Cls` gelöscht.
**Verbesserung:** Nur die alte Position der Box übermalen ("Dirty Rect Erasing") spart massiv Blitter-Bandbreite.

### ⚪ Aufwand: Nicht anwendbar für den CodeGenerator

**Analyse:** Der CodeGen hat kein Wissen über die Semantik des Programms (was sich bewegt, was statisch ist). Diese Optimierung ist eine **Programmiertechnik**, die der Nutzer im BASSM-Quellcode anwenden muss — z.B. indem er statt `Cls` manuell `Color 0 : Box oldX,oldY,w,h` schreibt. Compiler-seitig gibt es hier nichts zu tun.

---

## 7. Konstanten-Handling

Werte wie `320` oder `256` werden als `move.l #320, d0` geladen.

### 🟢 Aufwand: Niedrig (teilweise bereits erledigt)

**Was sich ändern muss:**
- ✅ `moveq` für -128..127: **bereits implementiert** in `_genExpr` case `'int'`.
  Kein Handlungsbedarf.
- `cmpi` direkt für Vergleiche gegen Konstanten: derzeit wird der rechte Operand
  immer über den generischen Pfad evaluiert (Push/Pop). Sonderfall in `_genBinop`
  für Vergleiche (`=`, `<>`, `<`, `>`, `<=`, `>=`), wenn der rechte Operand ein
  `int`-Literal ist:
  ```m68k
  ; x < 320  — aktuell: push 320 / load x / pop d1 / cmp d1,d0
  ; optimiert: move.l _var_x,d0 / cmp.l #320,d0
  ```
  Das ist ein Teilfall von Optimierung #2 (Stack-Eliminierung). Beide können
  gemeinsam implementiert werden.

---

## 8. Subroutine-Argumente

Beim Aufruf von `_Box` werden alle Argumente einzeln berechnet und gepusht, nur um sie dann mit `movem.l (sp)+,d1-d3` wieder zu holen.

### 🟡 Aufwand: Mittel

**Was sich ändern muss:**
- Neue Hilfsmethode `_genArgsToRegisters(stmt, count, lines)`: prüft ob alle
  `count` Argumente "einfache" Ausdrücke sind (`int` oder `ident`). Wenn ja:
  evaluiert Arg 0 → `d0`, Arg 1 direkt mit `move.l _var_y,d1` (Speicher-op),
  Arg 2 → `d2`, Arg 3 → `d3` — ohne Stack.
- Wenn mindestens ein Argument komplex (zusammengesetzter Ausdruck) ist: alter
  Push/movem-Pfad bleibt als Fallback.
- Betrifft die `case 'box'`, `'rect'`, `'line'`, `'plot'` Blöcke in `_genStatement`.
- Achtung: Argumente müssen in Reihenfolge 0→3 evaluiert werden, wobei die
  Zwischenergebnisse in `d1–d3` nicht von der Evaluation des nächsten Arguments
  überschrieben werden dürfen → nur sicher wenn alle einfach sind.
- Änderung: ca. 40–50 Zeilen (neue Methode + 4 angepasste Case-Blöcke).

---

## 9. PERF-C: CopperColor Intrinsic Inlining

`CopperColor` wird in der Demo 212× pro Frame gerufen. Jeder Aufruf geht durch
`_SetRasterColorRGB` → `_SetRasterColor` mit zweifachem `movem.l` Overhead.

**Overhead pro Aufruf (gemessen):**

```
movem.l d2-d3,-(sp) + movem.l (sp)+,d2-d3   32 Zyklen
2× JSR/RTS                                    32 Zyklen
movem.l d0/a0,-(sp) + movem.l (sp)+,d0/a0   32 Zyklen
codegen arg-setup movem.l (sp)+,d1-d3        24 Zyklen
────────────────────────────────────────────────────────
                                  gesamt: ~120 Zyklen
× 212 = 25.440 Zyklen ≈ 3,6 ms von 20 ms (18 % des Frames!)
```

**Lösung: Inline-Expansion als Intrinsic**

Statt JSR wird der Funktionskörper direkt in den generierten Code emittiert.
`d2` dient als OCS-Wort-Akkumulator (sicher: `_genExpr` nutzt nur `d0`/`d1`).

### Compile-time path (alle 4 args Literale):

```asm
; Kein moveq, kein JSR — direkte Speicherschreibung mit Compile-Zeit-Offset
tst.b   _front_is_a
bne.s   .LN
move.w  #$0RGB,_gfx_raster_b+(y*8+6)   ; y*8+6 ist Compile-Zeit-Konstante
bra.s   .LM
.LN:
move.w  #$0RGB,_gfx_raster_a+(y*8+6)
.LM:
; ~20 Zyklen statt ~60 Zyklen
```

### Runtime path (mind. 1 arg ist Variable/Ausdruck):

```asm
; r → d2 (bits 11:8)
<eval r> → d0 : andi.w #$F,d0 : lsl.w #8,d0 : move.w d0,d2
; g → d2 (bits 7:4)
<eval g> → d0 : andi.w #$F,d0 : lsl.w #4,d0 : or.w d0,d2
; b → d2 (bits 3:0) → d2 = $0RGB
<eval b> → d0 : andi.w #$F,d0 : or.w d0,d2
; y → d0, offset = y*8
<eval y> → d0 : lsl.l #3,d0
; Back-Raster wählen und schreiben (1 Branch statt 2× movem)
tst.b   _front_is_a
bne.s   .LA
lea     _gfx_raster_b,a0
bra.s   .LW
.LA:    lea     _gfx_raster_a,a0
.LW:    move.w  d2,6(a0,d0.l)
; ~22 Zyklen Overhead statt ~120 Zyklen
```

**Ersparnis Phase 1:** ~98 Zyklen × 212 = **20.776 Zyklen ≈ 3,0 ms** zurückgewonnen.

**Phase 2 (PERF-D, spätere Idee):** Schleifenkontext-Erkennung im Codegen — einmaliges
`tst.b _front_is_a; lea _gfx_raster_X,a4` *vor* der For-Schleife hissen, im Body
dann nur noch `move.w d2,6(a4,d0.l)`. Spart weitere ~10 Zyklen × 212.

### 🟢 Aufwand: Niedrig (ca. 25 Zeilen, isoliert in `case 'coppercolor'`)

**Was sich ändert:**
- `codegen.js`, `case 'coppercolor'`: Compile-time-Pfad und Runtime-Pfad ersetzen
  `jsr _SetRasterColor` / `jsr _SetRasterColorRGB` durch Inline-Code.
- `copper_raster.s` bleibt unverändert (Funktionen bleiben für ggf. direkten ASM-Aufruf).
- Keine Änderung an Parser, Fragment-Architektur oder Calling Convention.

---

## Empfohlene Implementierungsreihenfolge

| # | Optimierung | Aufwand | Status | Begründung |
|---|-------------|---------|--------|------------|
| 4 | `While 1` ohne Test | 🟢 | ✅ Erledigt | 5 Zeilen, null Risiko |
| 7a | `moveq` für Konstanten | 🟢 | ✅ Erledigt | War schon implementiert |
| 9 | CopperColor Intrinsic Inline | 🟢 | ✅ Erledigt | ~3 ms/Frame zurückgewonnen |
| 3 | Bcc statt Scc (If/While) | 🟡 | Offen | Jede Condition spart 4 Instr. |
| 2+7b | Stack-Elim. + cmpi | 🟡 | Offen | Häufigster Ausdruck-Fall |
| 8 | Args direkt in Register | 🟡 | Offen | Lohnt für viele Grafik-Calls |
| 1 | Register-Caching | 🔴 | Nach M7 | Braucht Scope-Analyse aus M7 |
| 5 | Short Branches | 🟢 | Niedrige Prio | Minimaler Effekt auf 68000 |
| 6 | Dirty Rects | ⚪ | N/A | Programmiertechnik, kein Compiler-Thema |

---

*Diese Optimierungen könnten die Framerate bei komplexeren Szenen vervielfachen, da die CPU-Last pro Objekt drastisch sinkt.*