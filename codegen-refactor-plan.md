# CodeGen Refactoring — Plan

> **Stand:** 2026-03-28
> **Ziel:** `codegen.js` (3.101 Zeilen) in wartbare, erweiterbare Struktur umbauen.
> **Methode:** Rein mechanische Extraktion — kein Verhaltenswechsel, keine neuen Features.
> **Tasks:** 24 (in 5 Phasen)

---

## Prinzipien

1. **Kein Verhaltenswechsel.** Generiertes Assembly muss Byte-für-Byte identisch bleiben.
2. **Ein Task = ein Commit.** Jeder Task ist unabhängig verifizierbar.
3. **Kleine Diffs.** Jeder Task verändert maximal ~100–150 Zeilen (Cut + Paste + Dispatch).
4. **Reihenfolge egal.** Innerhalb einer Phase können Tasks in beliebiger Reihenfolge bearbeitet werden.
5. **Verifikation:** Nach jedem Task ein bestehendes BASSM-Programm kompilieren und prüfen, dass identisches ASM entsteht (Diff gegen vorherige Ausgabe).

---

## Ist-Zustand

| Methode | Zeilen | Problem |
|---------|--------|---------|
| `generate()` | 446 | Monolith: EQUs + Includes + Copper + BSS + Setup + Main in einer Funktion |
| `_collectVars()` | 231 | 56 Command-Cases inline (Duplikat der _genStatement-Struktur) |
| `_genStatement()` | 873 | 56 Command-Cases in einem Switch + 15 Statement-Types als if/else |
| `_genExpr()` | 470 | 15 Built-in-Funktionen als if/else-Kette im `call_expr`-Case |

---

## Phase 1 — Command-Handler-Tabelle (Kern-Refactoring)

> Ziel: Den 56-Case-Switch in `_genStatement` durch eine Handler-Tabelle ersetzen.
> Jeder Task extrahiert eine Gruppe verwandter Commands in eigene Methoden.

### Mechanik (gilt für alle Tasks in Phase 1)

**Vorher** (in `_genStatement`, Zeile ~1011):
```javascript
switch (name) {
    case 'cls':
        lines.push('        jsr     _Cls');
        break;
    // ... 55 weitere cases
}
```

**Nachher:**
```javascript
// Handler-Tabelle (Instanz-Eigenschaft, einmal definiert)
this._cmdHandlers = {
    cls: (stmt, lines) => this._cmd_cls(stmt, lines),
    // ...
};

// In _genStatement:
const handler = this._cmdHandlers[name];
if (handler) { handler(stmt, lines); }
else { console.warn(`Unhandled command: ${name}`); }
```

```javascript
// Extrahierte Methode:
_cmd_cls(stmt, lines) {
    lines.push('        jsr     _Cls');
}
```

---

### ~~T1 — Handler-Tabelle Gerüst + Triviale Commands (8 Commands)~~ ✓

**Ziel:** Handler-Map anlegen und die einfachsten Cases (1–5 Zeilen) extrahieren.

**Commands:**
| Command | Zeilen | Methode |
|---------|--------|---------|
| `cls` | 3 | `_cmd_cls` |
| `clscolor` | 5 | `_cmd_clscolor` |
| `color` | 5 | `_cmd_color` |
| `end` | 3 | `_cmd_end` |
| `waitvbl` | 3 | `_cmd_waitvbl` |
| `waitkey` | 3 | `_cmd_waitkey` |
| `graphics` | 4 | `_cmd_graphics` |
| `screenflip` | 4 | `_cmd_screenflip` |

**Schritte:**
1. Neue Methode `_initCommandHandlers()` anlegen, die `this._cmdHandlers = { ... }` setzt.
2. `_initCommandHandlers()` im `generate()`-Reset-Block aufrufen (nach State-Init, vor Code-Generierung).
3. Die 8 Cases aus dem Switch ausschneiden, jeweils in eine `_cmd_NAME`-Methode einfügen.
4. Handler-Map-Einträge für alle 8 Commands eintragen.
5. Am Ende von `_genStatement`: Switch durch Handler-Lookup ersetzen, **restliche Cases bleiben vorerst im Switch als Fallback**.
6. Kompilieren, ASM-Diff prüfen.

**Dispatch-Logik in _genStatement (Übergangsphase):**
```javascript
if (stmt.type !== 'command') return lines;
const name = stmt.name;
const handler = this._cmdHandlers[name];
if (handler) {
    handler(stmt, lines);
    return lines;
}
switch (name) {
    // ... verbleibende Cases (werden in T2–T10 schrittweise entfernt)
}
return lines;
```

---

### ~~T2 — Drawing Commands (4 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `plot` | 10 | `_cmd_plot` |
| `line` | 14 | `_cmd_line` |
| `rect` | 14 | `_cmd_rect` |
| `box` | 14 | `_cmd_box` |

Alle vier haben die gleiche Struktur: Args evaluieren → JSR.
Aus Switch ausschneiden, in `_cmd_NAME` einfügen, Handler-Map erweitern.

---

### ~~T3 — Sound Commands (3 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `playsample` | 38 | `_cmd_playsample` |
| `playsampleonce` | 29 | `_cmd_playsampleonce` |
| `stopsample` | 6 | `_cmd_stopsample` |

---

### ~~T4 — Asset-Loading Commands (5 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `loadsample` | 4 | `_cmd_loadsample` |
| `loadfont` | 4 | `_cmd_loadfont` |
| `loadimage` | 11 | `_cmd_loadimage` |
| `loadanimimage` | 11 | `_cmd_loadanimimage` |
| `loadmask` | 3 | `_cmd_loadmask` |

---

### ~~T5 — Image/Bob Commands (3 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `drawimage` | 53 | `_cmd_drawimage` |
| `drawbob` | 57 | `_cmd_drawbob` |
| `setbackground` | 13 | `_cmd_setbackground` |

Die größten Command-Handler. Jeweils 1:1 in eigene Methode verschieben.

---

### ~~T6 — Text Commands (2 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `text` | 50 | `_cmd_text` |
| `usefont` | 35 | `_cmd_usefont` |

---

### ~~T7 — Poke/Palette Commands (2 Gruppen)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `pokeb`/`pokew`/`pokel`/`poke` | 33 | `_cmd_poke` (ein Handler, size-Dispatch intern) |
| `palettecolor` | 30 | `_cmd_palettecolor` |

---

### ~~T8 — CopperColor (1 Command)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `coppercolor` | 87 | `_cmd_coppercolor` |

Der größte einzelne Command-Handler. 1:1 extrahieren.

---

### ~~T9 — Tilemap Commands (4 Commands)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `loadtileset` | 11 | `_cmd_loadtileset` |
| `loadtilemap` | 4 | `_cmd_loadtilemap` |
| `drawtilemap` | 35 | `_cmd_drawtilemap` |
| `settilemap` | 26 | `_cmd_settilemap` |

---

### ~~T10 — Delay + Switch aufräumen (1 Command + Cleanup)~~ ✓

| Command | Zeilen | Methode |
|---------|--------|---------|
| `delay` | 16 | `_cmd_delay` |

**Cleanup:** Nach diesem Task ist der Switch leer. Entfernen und durch reinen Handler-Lookup ersetzen:

```javascript
if (stmt.type !== 'command') return lines;
const handler = this._cmdHandlers[stmt.name];
if (handler) {
    handler(stmt, lines);
} else {
    console.warn(`Unhandled command: ${stmt.name} (line ${stmt.line})`);
}
return lines;
```

**Ergebnis Phase 1:** `_genStatement` schrumpft von ~873 auf ~200 Zeilen.
56 Commands leben in ~33 isolierten `_cmd_*`-Methoden (einige Commands teilen sich einen Handler).

---

## Phase 2 — Statement-Handler-Tabelle

> Ziel: Die if/else-Kette der Statement-Types durch eine Handler-Tabelle ersetzen.

### ~~T11 — Statement-Handler: Assign + Declaration-Types~~ ✓

**Schritte:**
1. `_genStmt_assign(stmt, lines)` extrahieren (Zeilen 824–877, ~54 Zeilen).
   Enthält die PERF-D Optimierungen (clr, moveq, addq/subq, direkte Speicher-Ops).
2. `_genStmt_decl(stmt, lines)` extrahieren (Zeilen 880–885, ~6 Zeilen).
   Leere Methode für `dim`, `type_def`, `dim_typed`, `dim_typed_array`, `function_def`, `const_def`, `data_stmt`.
3. Statement-Handler-Map anlegen:
   ```javascript
   this._stmtHandlers = {
       assign: (s, l) => this._genStmt_assign(s, l),
       dim: (s, l) => {},  // declaration-only
       type_def: (s, l) => {},
       // ...
   };
   ```

---

### ~~T12 — Statement-Handler: Data/Read/Restore/Local/Return~~ ✓

| Type | Zeilen | Methode |
|------|--------|---------|
| `read_stmt` | 8 | `_genStmt_read` |
| `restore_stmt` | 6 | `_genStmt_restore` |
| `local_decl` | 11 | `_genStmt_local` |
| `return` | 16 | `_genStmt_return` |
| `call_stmt` | 8 | `_genStmt_call` |
| `type_field_write` | 4 | `_genStmt_typeFieldWrite` |
| `array_assign` | 13 | `_genStmt_arrayAssign` |
| `exit` | 7 | `_genStmt_exit` |

---

### ~~T13 — Statement-Handler: Control Flow + Dispatch-Cleanup~~ ✓

- Bestehende Delegationen (`_genIf`, `_genWhile`, etc.) in die Handler-Map eintragen:
  ```javascript
  if:     (s, l) => l.push(...this._genIf(s)),
  while:  (s, l) => l.push(...this._genWhile(s)),
  for:    (s, l) => l.push(...this._genFor(s)),
  repeat: (s, l) => l.push(...this._genRepeat(s)),
  select: (s, l) => l.push(...this._genSelect(s)),
  ```
- Die gesamte if/else-Kette in `_genStatement` durch Handler-Lookup ersetzen:
  ```javascript
  _genStatement(stmt) {
      const lines = [];
      const handler = this._stmtHandlers[stmt.type]
                   ?? (stmt.type === 'command' ? null : undefined);
      if (handler) {
          handler(stmt, lines);
      } else if (stmt.type === 'command') {
          const cmdHandler = this._cmdHandlers[stmt.name];
          if (cmdHandler) cmdHandler(stmt, lines);
          else console.warn(`Unknown command: ${stmt.name}`);
      }
      return lines;
  }
  ```

**Ergebnis Phase 2:** `_genStatement` ist jetzt **~15 Zeilen** — reiner Dispatch.

---

## Phase 3 — call_expr Built-in-Funktionen extrahieren

> Ziel: Die 15 Built-in-Funktionen aus der if/else-Kette in `_genExpr` → `call_expr`
> in eigene Methoden verschieben.

### Mechanik

**Vorher** (in `_genExpr`, case `call_expr`):
```javascript
if (expr.name === 'abs') {
    // 8 Zeilen inline
}
```

**Nachher:**
```javascript
this._builtinHandlers = {
    abs: (expr, lines) => this._builtin_abs(expr, lines),
    // ...
};

// In call_expr case:
const builtinFn = this._builtinHandlers[expr.name];
if (builtinFn) { builtinFn(expr, lines); break; }
// ... fallback: user function call
```

---

### ~~T14 — Builtin-Handler-Tabelle + Math/Util (3 Funktionen)~~ ✓

| Funktion | Zeilen | Methode |
|----------|--------|---------|
| `abs` | 8 | `_builtin_abs` |
| `rnd` | 5 | `_builtin_rnd` |
| `str$` | 4 | `_builtin_str` |

Handler-Map anlegen (`_initBuiltinHandlers()`), in `generate()` aufrufen.

---

### ~~T15 — Builtin-Handler: Joystick (5 Funktionen)~~ ✓

| Funktion | Zeilen | Methode |
|----------|--------|---------|
| `joyup` | ~8 | `_builtin_joydir` (shared, Direction als Parameter) |
| `joydown` | ~8 | ↑ |
| `joyleft` | ~8 | ↑ |
| `joyright` | ~8 | ↑ |
| `joyfire` | 22 | `_builtin_joyfire` |

Die vier Richtungen teilen fast identische Logik (nur Bit-Offset und XOR-Maske
unterscheiden sich). Ideal als **ein Handler** mit Direction-Parameter.

---

### ~~T16 — Builtin-Handler: Mouse (4 Funktionen)~~ ✓

| Funktion | Zeilen | Methode |
|----------|--------|---------|
| `mousex` | 4 | `_builtin_mousex` |
| `mousey` | 4 | `_builtin_mousey` |
| `mousedown` | 14 | `_builtin_mousedown` |
| `mousehit` | 16 | `_builtin_mousehit` |

---

### ~~T17 — Builtin-Handler: Keyboard + Peek (4 Funktionen)~~ ✓

| Funktion | Zeilen | Methode |
|----------|--------|---------|
| `keydown` | 12 | `_builtin_keydown` |
| `peekb` | ~10 | `_builtin_peek` (shared, size als Parameter) |
| `peekw` | ~10 | ↑ |
| `peekl` | ~10 | ↑ |

Die drei Peek-Varianten teilen die gleiche Logik (literal-addr vs runtime-addr),
nur die Instruktionsgröße (`move.b`/`.w`/`.l`) und Zero-/Sign-Extension unterscheiden sich.

---

### ~~T18 — Builtin-Handler: Collision (3 Funktionen)~~ ✓

| Funktion | Zeilen | Methode |
|----------|--------|---------|
| `rectsoverlap` | 34 | `_builtin_rectsoverlap` |
| `imagesoverlap` | 53 | `_builtin_imagesoverlap` |
| `imagerectoverlap` | 45 | `_builtin_imagerectoverlap` |

Die drei größten Built-in-Handler. 1:1 extrahieren.

---

### ~~T19 — call_expr Dispatch-Cleanup~~ ✓

- Die if/else-Kette in `call_expr` durch Builtin-Handler-Lookup ersetzen:
  ```javascript
  case 'call_expr': {
      const builtin = this._builtinHandlers[expr.name];
      if (builtin) {
          builtin(expr, lines);
          break;
      }
      // User function call (fallback)
      const funcDef = this._userFunctions.get(expr.name);
      if (funcDef) {
          this._emitFunctionCall(funcDef, expr.args, lines);
          break;
      }
      // N-dimensional array read (fallback)
      // ...
  }
  ```

**Ergebnis Phase 3:** `call_expr`-Case schrumpft von ~379 auf ~20 Zeilen.

---

## Phase 4 — `generate()` aufteilen

> Ziel: Die 446-Zeilen `generate()`-Methode in logische Abschnitte aufteilen.

### ~~T20 — EQUs + Includes extrahieren~~ ✓

~~Extrahiere in `_emitEQUs(out, W, H, D, ...)` (Zeilen ~139–171, ~33 Zeilen)
und `_emitIncludes(out)` (Zeilen ~173–210, ~38 Zeilen).~~

---

### ~~T21 — Copper-Liste extrahieren~~ ✓

~~Extrahiere in `_emitCopperLists(out, D, ...)` (Zeilen ~330–400, ~70 Zeilen).
Enthält `emitCopHeader()` (aktuell lokale Funktion), Copper A, Copper B,
BPL-Tabellen und Raster-Entries.~~

**Wichtig für M-VIEWPORT:** Diese Methode wird der zentrale Ansatzpunkt für die
Viewport-Copper-Generation. Durch die Extraktion jetzt ist die spätere Erweiterung
sauber isoliert.

---

### ~~T22 — BSS/DATA-Sections extrahieren~~ ✓

~~Extrahiere:~~
- ~~`_emitUserVarsBSS(out, varNames)` — user_vars, arrays, type instances~~
- ~~`_emitDataSection(out)` — Data/Read/Restore~~
- ~~`_emitAssetData(out)` — Image INCBIN, Tileset, Tilemap, Sound, Font, Mask~~
- ~~`_emitBufferBSS(out)` — gfx_planes_a/b BSS_C~~

---

### ~~T23 — _setup_graphics extrahieren~~ ✓

~~Extrahiere in `_emitSetupGraphics(out)` (Zeilen ~213–237, ~25 Zeilen).~~

**Ergebnis Phase 4:** `generate()` wird zum reinen Orchestrator (~80 Zeilen):
```javascript
generate(ast) {
    this._resetState();
    this._initHandlers();
    this._prePass(ast);
    const out = [];
    this._emitHeader(out);
    this._emitEQUs(out);
    this._emitIncludes(out);
    this._emitSetupGraphics(out);
    this._emitMainProgram(out, ast);
    this._emitFunctionDefs(out);
    this._emitUserVarsBSS(out);
    this._emitDataSection(out);
    this._emitCopperLists(out);
    this._emitBufferBSS(out);
    this._emitAssetData(out);
    return out.join('\n');
}
```

---

## Phase 5 — _collectVars aufräumen

> Ziel: Die 231-Zeilen `_collectVars()` entschlacken.

### ~~T24 — _collectVars: Command-Cases in Handler-Map~~ ✓

~~`_collectVars` durchläuft den AST und sammelt Flags (`_usesRaster`, `_usesSound`, etc.)
und Asset-Deklarationen. Intern hat sie einen ähnlichen Switch wie `_genStatement`.~~

~~Handler-Map `this._collectCmdHandlers` mit 12 Einträgen (coppercolor, loadsample,
loadimage, loadanimimage, loadmask, loadfont, setbackground, drawbob, loadtileset,
loadtilemap, drawtilemap, settilemap). Dispatch via `_initCollectHandlers()`.~~

---

## Abhängigkeiten

```
Phase 1: T1 → T2..T10 (beliebige Reihenfolge) → T10-Cleanup
Phase 2: T11 → T12 → T13 (setzt Phase 1 voraus)
Phase 3: T14 → T15..T18 (beliebige Reihenfolge) → T19
Phase 4: T20..T23 (beliebige Reihenfolge, unabhängig von Phase 1–3)
Phase 5: T24 (unabhängig von Phase 1–4)
```

**Phasen 1–3 sind der Kern.** Phase 4 und 5 sind Nice-to-have und können
nach M-VIEWPORT nachgeholt werden.

---

## Ergebnis-Prognose

| Metrik | Vorher | Nachher |
|--------|--------|---------|
| `_genStatement` Zeilen | 873 | ~15 (reiner Dispatch) |
| `_genExpr` call_expr Zeilen | 379 | ~20 (reiner Dispatch) |
| `generate()` Zeilen | 446 | ~80 (Orchestrator) |
| Neue Methoden | 0 | ~50 (`_cmd_*`, `_builtin_*`, `_emit*`) |
| Größte Methode | 873 | ~57 (`_cmd_drawbob`) |
| Neue Commands hinzufügen | Switch verstehen + Case einfügen | Handler-Methode + 1 Zeile Map-Eintrag |

---

## Verifikation

Nach **jedem** Task:

1. Ein bestehendes BASSM-Programm kompilieren (z.B. das Boing-Demo oder ein Testprogramm).
2. Generiertes ASM mit der Ausgabe vor dem Refactoring vergleichen (`diff`).
3. **Muss identisch sein.** Jede Abweichung ist ein Bug im Refactoring.

Optional: Vor Phase 1 das ASM eines Referenzprogramms in eine Datei speichern
und nach jedem Task automatisch dagegen diffen.
