# BASSM Codegen-Optimierungen: Implementierungsplan

Alle 5 Optimierungen befinden sich ausschliesslich in `app/src/codegen.js`.
Es gibt keinen IR zwischen AST und Text-Ausgabe — Peephole-Optimierungen
arbeiten auf dem akkumulierten `lines[]`-Puffer.

---

## Phase 1 — Sofort, kein Risiko (parallel umsetzbar)

### ~~PERF-1: `lsl.l #n` statt `muls.w` fuer Zweierpotenzen~~ ✓ DONE

**Datei:** `app/src/codegen.js` — neue Hilfsmethode + 2 Aufruf-Stellen

Neue Methode direkt ueber `_genBinop` einfuegen:

```javascript
_emitMultiplyByConst(n, lines) {
    const shift = 31 - Math.clz32(n);
    if (n > 0 && (1 << shift) === n) {
        lines.push(`        lsl.l   #${shift},d0`);
    } else {
        lines.push(`        move.l  #${n},d1`);
        lines.push(`        muls.w  d1,d0`);
    }
}
```

Aufruf-Ersetzungen:
- `_genTypeFieldWrite`: `muls.w #${stride},d0` → `this._emitMultiplyByConst(stride, lines)`
- `case 'type_field_read'` in `_genExpr`: gleiche Ersetzung

**Spart:** 70 → 18 Zyklen pro Struct-Feldzugriff. Im Hauptloop ~30 Zugriffe × 8 Baelle
= ~1.560 Zyklen/Iteration weniger.

> **Fallstrick:** `Math.log2` gibt Float zurueck. `31 - Math.clz32(n)` verwenden
> und gegen `(1 << shift) === n` verifizieren.

**Abhaengigkeiten:** Keine. Vorarbeit fuer PERF-2.

---

### ~~PERF-3: Konstant-Falten fuer 0-Kanaele in CopperColor~~ ✓ DONE

**Datei:** `app/src/codegen.js` — `case 'coppercolor'`, Runtime-Pfad (~Zeile 673–709)

```javascript
const rIsZero = rArg.type === 'int' && rArg.value === 0;
const gIsZero = gArg.type === 'int' && gArg.value === 0;
const bIsZero = bArg.type === 'int' && bArg.value === 0;

if (rIsZero) {
    lines.push('        moveq   #0,d2');
} else {
    // r-Block: _genExprArg → andi.w #$F → lsl.w #8 → move.w d0,d2
}
if (!gIsZero) {
    // g-Block: _genExprArg → andi.w #$F → lsl.w #4 → or.w d0,d2
}
if (!bIsZero) {
    // b-Block: _genExprArg → andi.w #$F → or.w d0,d2
}
```

**Sonderfall alle Kanaele = 0:** `moveq #0,d2` deckt das korrekt ab.

**Spart:** 4 tote Instruktionen × 212 Iterationen = 848 nutzlose Instruktionen/Frame
(Demo: `CopperColor line, rc, 0, gc` — g ist immer Literal 0).

**Abhaengigkeiten:** Keine.

---

### ~~PERF-5: For-Schranke als Immediate-Compare~~ ✓ DONE

**Datei:** `app/src/codegen.js` — `_genFor`, `stepLit !== null`-Branch (~Zeile 909–918)

```javascript
if (stmt.to.type === 'int') {
    // PERF-5: Immediate-Compare, kein Stack
    lines.push(`        move.l  _var_${stmt.var},d0`);
    lines.push(`        cmp.l   #${stmt.to.value},d0`);
} else if (this._isSimpleExpr(stmt.to)) {
    // PERF-B-Synergie: to ist eine Variable
    lines.push(`        move.l  _var_${stmt.var},d0`);
    lines.push(`        cmp.l   ${this._simpleOperand(stmt.to)},d0`);
} else {
    // Original-Pfad: komplexer Ausdruck
    this._genExpr(stmt.to, lines);
    lines.push('        move.l  d0,-(sp)');
    lines.push(`        move.l  _var_${stmt.var},d0`);
    lines.push('        move.l  (sp)+,d1');
    lines.push('        cmp.l   d1,d0');
}
lines.push(stepLit >= 0
    ? `        bgt.w   ${endLbl}`
    : `        blt.w   ${endLbl}`);
```

**Aktuell** (`For i = 0 To 7`): 5 Instruktionen + Branch
**Nach PERF-5:** 2 Instruktionen + Branch

**Spart:** ~3.800 Zyklen/Frame (236 Loop-Iterationspruefungen/Frame gesamt).

**Abhaengigkeiten:** Keine. Erleichtert PERF-4 (weniger redundante Reloads).

---

## Phase 2 — Nach Phase 1

### ~~PERF-4: Redundant-Reload-Elimination (Peephole)~~ ✓ DONE

**Datei:** `app/src/codegen.js` — neue Methode + Aufrufe in `_genFor`, `_genWhile`,
`_genIf`, `generate()`

Neue Methode:

```javascript
_peepholeRedundantReload(lines) {
    const n = lines.length;
    if (n < 2) return;
    const prev = lines[n - 2].trim();
    const curr = lines[n - 1].trim();
    const storeRe = /^move\.l\s+d0,(_var_\w+)$/;
    const loadRe  = /^move\.l\s+(_var_\w+),d0$/;
    const storeM  = storeRe.exec(prev);
    const loadM   = loadRe.exec(curr);
    if (storeM && loadM && storeM[1] === loadM[1]) lines.pop();
}
```

Ueberall wo Statement-Ergebnisse in gemeinsamen Puffer gepusht werden:

```javascript
// In _genFor, _genWhile, _genIf, _genSelect:
lines.push(...this._genStatement(s));
this._peepholeRedundantReload(lines);

// In generate():
out.push(...this._genStatement(stmt));
this._peepholeRedundantReload(out);
```

**Eliminiert** Muster wie `move.l d0,_var_rc` direkt gefolgt von `move.l _var_rc,d0`
im Raster-Loop — 4x pro Frame-Iteration × 212 = ~848 Zyklen.

> **Fallstrick:** Regex bricht ab wenn `lines[n-1].trim()` auf `:` endet (Label).
> Labels stehen immer am Statement-Anfang, nie nach einem Store — in der Praxis
> sicher, aber zur Absicherung pruefen: `if (curr.endsWith(':')) return;`

**Abhaengigkeiten:** Profitiert von PERF-5 (weniger false-positive Kandidaten).

---

## Phase 3 — Spaeter, aufwaendig

### ~~PERF-2: Struct-Pointer-Caching in For-Loops (PERF-D)~~ ✓ DONE

**Datei:** `app/src/codegen.js` — `_detectPointerCacheCandidate`, `_ptrCacheCtx`-State,
modifizierte Feldzugriffspfade in `_genTypeFieldWrite` und `type_field_read`

**Vorbedingung: Fragment-Audit** — Pruefe welche Register `a1`/`a2` in
`box.s`, `line.s`, `rect.s`, `plot.s` nach `jsr`-Rueckkehr erhalten bleiben.
Wenn `a1` clobbered wird: sicheres Register waehlen (z.B. `a2`) oder Cache
fuer Loops mit `jsr`-Calls deaktivieren.

**Ablauf:**

1. Analyse-Pass in `_genFor`:

```javascript
_detectPointerCacheCandidate(body, loopVar) {
    // Gibt {instName, stride} zurueck wenn:
    // - Alle type_field_read/write im Body referenzieren genau EINE Instanz
    // - Index ist exakt loopVar (ident-Node)
    // - Keine jsr-emittierenden Commands im Body (oder a1/a2 sicher)
    // Sonst: null
}
```

2. Wenn Kandidat: Prologue-Code vor Body-Emission:

```asm
; einmalig pro Iteration (nutzt PERF-1):
move.l  _var_i,d0
lsl.l   #5,d0           ; stride = 32 (2^5)
lea     _tinst_b,a1
add.l   d0,a1           ; a1 = &b(i) -- gecacht fuer den gesamten Body
```

3. Cache-Kontext setzen:

```javascript
this._ptrCacheCtx = { instName, regName: 'a1' };
// Body-Statements emittieren...
this._ptrCacheCtx = null;
```

4. In `_genTypeFieldWrite` und `type_field_read` — Cache-Pfad:

```javascript
if (this._ptrCacheCtx &&
    this._ptrCacheCtx.instName === node.instance &&
    node.index && node.index.type === 'ident') {
    // Direktzugriff: kein muls/lea/add mehr
    // Lesen: move.l fieldOff(a1),d0
    // Schreiben: move.l d0,fieldOff(a1)
    return;
}
// sonst: normaler Pfad
```

**Spart:** ~23.500 Zyklen/Frame ≈ 30% des effektiven Frame-Budgets auf OCS
ohne FastRAM.

**Abhaengigkeiten:** PERF-1 muss vorhanden sein (fuer den Prologue-Code).
Fragment-Audit muss abgeschlossen sein.

---

## Testmatrix

| Optimierung | Blitz2D-Snippet | Erwartung im ASM |
|---|---|---|
| PERF-1 | `Type T; Field a,b; EndType; Dim x.T(3); For i=0 To 3; x(i)\a=i; Next i` | `lsl.l #3,d0` statt `muls.w #8,d0` |
| PERF-2 | `For i=0 To 7; b(i)\x=b(i)\x+b(i)\dx; Next i` | Einmaliges `lea _tinst_b,a1; lsl+add` + `OFFSET(a1)` |
| PERF-3 | `CopperColor 0, 5, 0, 3` | Kein `lsl.w #4,d0` / `or.w d0,d2` fuer g=0 |
| PERF-4 | `rc=rc+1 : If rc>15 : rc=0 : EndIf` | Kein `move.l _var_rc,d0` direkt nach `move.l d0,_var_rc` |
| PERF-5 | `For i = 0 To 7` | `move.l _var_i,d0 / cmp.l #7,d0` statt 5-Instruktionen-Stack |

---

## Gesamtschatzung Ersparnis

| Optimierung | Zyklen/Frame | Aufwand |
|---|---|---|
| PERF-1 (`lsl.l`) | ~12.500 | gering |
| PERF-2 (Ptr-Cache) | ~23.500 | hoch |
| PERF-3 (CopperColor) | ~850 | gering |
| PERF-4 (Peephole) | ~850 | mittel |
| PERF-5 (Immediate cmp) | ~3.800 | gering |
| **Gesamt** | **~41.500 / ~75.000** | |

Auf OCS ohne FastRAM entspricht das einer Entlastung von ~55% des effektiven
Frame-Budgets — entscheidend sobald mehr Objekte, Sprites oder komplexere
Spiellogik dazukommen.
