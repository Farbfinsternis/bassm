# BASSM – Roadmap

## Status-Legende
- `[ ]` offen  |  `[~]` in Arbeit  |  `[x]` fertig

---

## ✅ Abgeschlossene Milestones

| Milestone | Inhalt |
|-----------|--------|
| **M0** Kern-Pipeline | PreProcessor · Lexer · Parser · CodeGen · vasm/vlink · vAmiga |
| **M1** Integer-Variablen & Ausdrücke | Zuweisung, `+ - * /`, unäres Minus, Vergleiche, `moveq`-Optimierung |
| **M2** Kontrollfluss If/Else | Einzeilig + Block, ElseIf-Kette, eindeutige Labels |
| **M3** Schleifen While/For | While·Wend, For·To·Step·Next; `While 1` ohne Test-Overhead |
| **M4** Select/Case | Mehrere Werte pro Case, Default-Branch |
| **M5** Zeichenbefehle | Plot, Line (Bresenham), Rect (Umriss), Box (gefüllt) |
| **M5b** Blitter | WaitBlit, Blitter-Cls, Blitter-Box, Blitter-Rect via 4×Box |
| **M5c** Double-Buffering | Zwei Copper-Listen, ScreenFlip, alle Draw-Befehle → Back-Buffer |
| **M6** Text | `Text x,y,"str"` → CPU 8×8 Font, per-Plane per-Row, Shift-Trick, Newline-Support |
| **M7** Funktionen / Prozeduren | `Function name(params)` + `Function name params`; Stack-Frame LINK/UNLK; lokale Vars; `Return [expr]` |
| **M8** Arrays + `:` Trenner | `Dim arr(n)`, arr(i) lesen/schreiben, `:` als Statement-Separator |
| **M-TYPE** Strukturen | `Type … Field … EndType`; `Dim inst.T` + `Dim arr.T(n)`; `inst\field` + `arr(i)\field` lesen/schreiben; AoS-Layout (4 Bytes/Feld); PERF-2 Pointer-Cache für wiederholten Index-Zugriff |
| **M9a** WaitKey | CIA-A SP-Flag, Interrupt-driven, Level-2-Vektor |
| **M9b-Mouse** Maus-Eingabe | `MouseX()`, `MouseY()` — Delta-Akkumulation via JOY0DAT; `MouseDown(n)`, `MouseHit(n)` — Links/Rechts-Tasten; VBL-Interrupt-driven; `mouse.s` Fragment |
| **M-COPPER** Rasterbalken | `CopperColor y,r,g,b`; `_gfx_raster_a/b`; `copper_raster.s`; GFXRASTER EQU |
| **M-ASSET A1** Bitmaps | `LoadImage n,"f.raw",w,h` + `DrawImage n,x,y`; Blitter A→D; 8-Byte-Header; auto-Palette via `LoadImage 0` |
| **M-ASSET A2** Sound | `PlaySample "f.raw",ch,per,vol` + `PlaySampleOnce` + `StopSample`; Paula DMA; vAmiga Web Audio |
| **PERF-A** Direkte Bcc-Sprünge | `_genCondBranch`: `cmp.l + Bcc` statt Scc-Kette |
| **PERF-B** Stack-Eliminierung | `_isSimpleExpr`: `x+1`, `x+dx` ohne Push/Pop; `addq`/`subq` für 1..8 |
| **PERF-C** CopperColor-Inlining | `CopperColor` inline expandiert; ~120 Zyklen/Aufruf gespart |
| **Runtime PaletteColor** | `_SetPaletteColorRGB(d0,d1,d2,d3)` in `palette.s`; alle 4 Args als Ausdrücke |
| **LANG-A** And / Or / Not | Bitweise + logisch; alle drei als Präzedenzebenen im Parser |
| **LANG-B** Mod | Modulo-Operator; `divs.w + swap + ext.l`; PERF für literal Divisor |
| **TOOL-1** Include | `Include "file.bassm"` — rekursiv; Circular-Detection; Path-Traversal-Schutz |
| **A-MGR** Asset Manager | Konverter-Fenster; PNG→.raw; WAV→.raw; Palette-Pipeline; Click-to-Load; Datei-Watcher |
| **LANG-D** Rnd + Abs | `Rnd(n)` Xorshift32 via `rnd.s`; `Abs(n)` inline 3-Instr.; beide als `call_expr`-Builtins |
| **LANG-E** Xor / Shl / Shr | Bitweises XOR (`eori.l`/`eor.l`), Linksshift (`lsl.l`), arithmetischer Rechtsshift (`asr.l`); Präzedenz Xor=Or, Shl/Shr=Mul |
| **TOOL-IDE Budget** | CPU-Cycle + Chip-RAM Lebensbalken im Editor; `budget.js` statische Analyse; Hauptloop-Erkennung; For-Multiplikation; Gradient-Bars grün→rot mit Glow-Effekt |
| **PERF-PEEP** Peephole-Optimizer | 5 Regeln (Text-basiert, Sliding Window, Multi-Pass bis stabil): R1 Store-Reload, R2 `cmp.l #0→tst.l`, R3 For-Doppel-Load, R4 Binop-Push-Pop→direkter Speicheroperand, R5 2-Arg-Push-Pop; Safety: Label-Guards; ~5% Einsparung/Frame für boing.s |
| **M-SYS** Peek / Poke | `PeekB/W/L(addr)` inline (literal→direkt, runtime→via a0); `PokeB/W/L/Poke addr,val` mit 3-Pfad-Optimierung (beide literal → 1 Instr.; literal addr → eval+absolut-Store; runtime addr → push/eval/pop→a0); vollständig inline, kein Fragment |
| **M-BOB** Blitter Objects | `SetBackground imgIdx`, `LoadMask imgIdx,"f.mask"`, `DrawBob imgIdx,x,y`; `bobs.s` mit 3-Queue-System (_bobs_new/_old_a/_old_b); `_FlushBobs` auto-injiziert vor ScreenFlip; `_bg_restore_static` (BLTCON0=$09F0); `_BltBobMasked` (BLTCON0=$0FCA, Minterm $CA); Fallback auf `_DrawImage` ohne Maske |
| **M-COLL** Kollisionserkennung | `RectsOverlap(x1,y1,w1,h1,x2,y2,w2,h2)`, `ImagesOverlap(img1,x1,y1,img2,x2,y2)`, `ImageRectOverlap(img,x,y,rx,ry,rw,rh)`; alle vollständig inline; 8/4/6 Args per Stack + movem; Header-Dimensionen zur Compile-Time; a1/a2 als Scratch |
| **M-ANIM** Sprite-Animation | `LoadAnimImage n,"f.raw",fw,fh,count`; `DrawImage n,x,y,frame` (optional); `DrawBob n,x,y,frame` (optional); `_DrawImageFrame(d2=frame)` + `_DrawImageFrame` Fall-Through in image.s; `_BltBobMaskedFrame(d2=frame)` in bobs.s; Bob-Slot 12→16 Bytes; Frame-Offset = `frame×depth×plane_size`; Restore-Pass frame-agnostisch |

---

## 🎯 Kritischer Pfad — Ziel: Spielbares Amiga-Game

Die Milestones sind **in Ausführungsreihenfolge** sortiert. Jede Stufe baut auf der
vorherigen auf. Innerhalb einer Stufe gilt die Reihenfolge der Einträge als Priorität.

---

## Stufe 1 — Sprach-Grundlagen *(Game-Complete-Blocker)*

> **Ziel:** Ein echtes interaktives Spiel schreiben können.
> Nach Stufe 1: Space Invaders, Breakout, Pong — vollständig umsetzbar.

---

### ✅ LANG-D — `Rnd` + `Abs` *(kleinster Aufwand, größter Unblocking-Effekt)*

```blitz
x = Rnd(320)              ; zufällige X-Position 0..319
speed = Rnd(3) + 1        ; Geschwindigkeit 1..3
dist = Abs(x2 - x1)       ; absoluter Abstand
If Abs(vx) < 1 Then vx = 1
```

- `[x]` **`Rnd(n)`** — Zufallszahl 0..n−1
  - Xorshift32 {13,17,5} — 68000-sicher (Register-Shifts), Periode 2^32-1
  - Seed 0 → auto-init aus VHPOSR (Beam-Position); unterschiedliche Sequenz pro Run
  - Fragment `rnd.s` — nur eingebunden wenn `Rnd` verwendet wird
  - CodeGen: `Rnd(expr)` als `call_expr`-Builtin → d1=n, JSR `_Rnd`, Ergebnis d0
- `[x]` **`Abs(n)`** — absoluter Betrag
  - Inline-Expansion: `tst.l d0 / bge.s / neg.l d0` — kein Fragment
  - CodeGen: `abs`-Builtin in `call_expr` → 3 Instruktionen inline

---

### 2. M9b — Joystick · KeyDown *(ohne Eingabe kein interaktives Programm)*

```blitz
If JoyUp(1)    Then y = y - 1
If JoyDown(1)  Then y = y + 1
If JoyLeft(1)  Then x = x - 1
If JoyRight(1) Then x = x + 1
If Joyfire(1)  Then Fire

If KeyDown($45) Then End    ; Escape (non-blocking)
```

- `[x]` **`JoyUp(port)`**, **`JoyDown(port)`**, **`JoyLeft(port)`**, **`JoyRight(port)`** — je Boolean (-1/0)
  - Liest `JOY0DAT`/`JOY1DAT` ($DFF00A/$DFF00C) — XOR-Decode: `move.w; lsr.w #1,d1; eor.w d0,d1`
  - bit0=right, bit1=left, bit8=down, bit9=up (bit1/9 = raw-Bit da Bit2/10=0 bei Digitaljoystick)
  - Inline-Expansion in codegen.js, kein Fragment nötig; `sne+ext.w+ext.l` → -1/0
  - Runtime-Port-Fallback: `$DFF00A + port*2`
- `[x]` **`Joyfire(port)`** — CIAAPRA ($BFE001) Bit 7 (Port 0) / Bit 6 (Port 1), active-low
  - `not.b + btst + sne + ext` → -1 wenn gedrückt, 0 sonst; Runtime-Port-Fallback (7-port)
- `[x]` **`KeyDown(scancode)`** — Echtzeit-Tastencheck (non-blocking)
  - `startup.s`: `_kbd_matrix ds.b 16` (128-Bit), `_lev2_kbd_handler` setzt/löscht Bits per Key-Down/Up
  - Handler speichert `_kbd_pending` (raw, für WaitKey) UND aktualisiert Matrix (decoded)
  - CodeGen: inline `btst d0,(a0)` → `sne+ext.w+ext.l` → -1/0
- `[x]` **`MouseX()`**, **`MouseY()`** — absolute Mausposition (0..GFXWIDTH-1 / 0..GFXHEIGHT-1)
  - `JOY0DAT` ($DFF00A): Bits [15:8]=Y-Zähler, [7:0]=X-Zähler — Delta-Akkumulation per VBL
  - `mouse.s`: `_mouse_vbl` vom Level-3-VBL-Handler aufgerufen (via `_mouse_vbl_ptr` in `startup.s`)
  - `_MouseInit`: POTGO schreiben, JOY0DAT-Baseline, Cursor auf Bildmitte; nach `_setup_graphics` aufgerufen
- `[x]` **`MouseDown(n)`** — `-1` wenn Taste n gehalten, `0` sonst (n=0: links, n=1: rechts)
  - Links: CIAAPRA ($BFE001) Bit 6, active-low; Rechts: POTINP ($DFF016) Bit 10, active-low
  - `_mouse_down_0`/`_mouse_down_1` BSS-Bytes in `mouse.s` (gesetzt im VBL-Handler)
- `[x]` **`MouseHit(n)`** — `-1` wenn Taste seit letztem Aufruf gedrückt wurde, dann Flag löschen
  - `_mouse_hit_0`/`_mouse_hit_1` BSS-Bytes: gesetzt beim ersten Press, gelöscht durch `MouseHit()` selbst

---

### 3. LANG-C — Zahlen als Text ausgeben *(Score, Leben, Timer)* ✅

```blitz
Text 10, 10, "Score: " + Str$(score)
Text 10, 20, "Lives:  " + Str$(lives)
NPrint score                        ; Blitz2D-Kompatibilität (no-op)
```

- `[x]` `_IntToStr`-Routine in `text.s`:
  - Zwei-Schritt `divu.w #10`-Loop (32-Bit safe) → Ziffern rückwärts in `_str_buf`
  - Negatives Vorzeichen `-` voranstellen; Ergebnis in `_str_buf` (BSS, 12 Bytes)
- `[x]` **`Str$(n)`** — gibt Adresse des String-Puffers in d0 zurück
  - Lexer: `$`-Suffix nach Bezeichner → IDENT `str$`
  - CodeGen: `_genExpr` → `jsr _IntToStr` → d0 = Zeiger
  - Verwendbar als String-Argument in `Text x,y,Str$(n)`
- `[x]` **String-Concatenation** `"prefix" + Str$(n)`:
  - `_flattenStrArg` zerlegt Argument rekursiv in `{lit}` / `{str_expr}` Parts
  - `_Text` gibt neue X-Position in d0 zurück; `_text_y` BSS sichert Y über Aufrufe
  - Multi-Part-Pfad: Y wird in `_text_y` gespeichert, jeder Part ruft `_Text` sequenziell auf
- `[x]` **`NPrint`** — Blitz2D-Kompatibilitätsstub (no-op in Bare-Metal-Builds)

---

### 4. LANG-F — `Repeat/Until` · `Exit` *(Kontrollfluss vollständig)* ✅

```blitz
Repeat
  ReadInput
  UpdatePhysics
  ScreenFlip
Until lives = 0 Or level > 10

For i = 0 To 63
  If arr(i) = target Then found = i : Exit
Next i
```

- `[x]` **`Repeat … Until cond`**
  - Parser: `REPEAT` → Body → `UNTIL` → Bedingung → `{type:'repeat', cond, body}`
  - CodeGen: `_genRepeat` — topLbl vor Body; `_genCondBranch(cond, topLbl)` am Ende
  - Until-Bedingung: wahr = verlassen (fall-through), falsch = wiederholen (branch back)
- `[x]` **`Exit [n]`** — verlässt n verschachtelte Schleifen (Standard: 1)
  - `_loopStack`: While/For/Repeat pushen ihre `endLbl` vor dem Body, poppen danach
  - `Exit n` → `bra.w _loopStack[top - n]`; Compiler-Fehler wenn Stack zu flach

---

### 5. LANG-E — `Xor` · `Shl` · `Shr` *(Hardware-Zugriff, Bit-Packing)*

```blitz
flags = flags Xor %00000100     ; Bit 2 toggeln
color = r Shl 8 Or g Shl 4 Or b ; OCS-Palette-Word packen
x = x Shr 4                     ; schnelle Division durch 16
mask = 1 Shl bitnum              ; Bit-Maske berechnen
```

- `[x]` **`Xor`** — bitweises XOR; Präzedenz wie `Or`
  - CodeGen: literal → `eori.l #n,d0`; Variable → `eor.l d1,d0`
- `[x]` **`Shl`** — Linksshift; Präzedenz wie `*`/`/`/`Mod`
  - Literal n=1..8: `lsl.l #n,d0`; n>8 oder Variable: Register-Form `lsl.l d1,d0`
- `[x]` **`Shr`** — arithmetischer Rechtsshift
  - Literal n=1..8: `asr.l #n,d0`; n>8 oder Variable: `asr.l d1,d0`
- `[x]` PERF-B-Erweiterung: `_isSimpleExpr` für Shl/Shr mit literal Shift-Count (via literal path)

> **Besonders wichtig auf dem Amiga:** OCS-Farbregister, DMA-Bits, Sprite-Koordinaten,
> BLTCON-Felder sind alle bit-packed. Ohne Shift-Operatoren muss man mit `*`/`/` arbeiten —
> deutlich langsamer auf dem 68000.

---

## Stufe 2 — Daten & Hardware

> **Ziel:** Tile-basierte Spiele, echte Game-Objects, vollständige Hardware-Kontrolle.
> Nach Stufe 2: ~95% game-complete. Tile-Platformer, komplexe Spiellogik möglich.

---

### 6. M-SYS — `Peek` · `Poke` *(Direkter Hardware-Zugriff — "Ausflucht nach unten")*

```blitz
beam   = PeekW($DFF006) And $1FF  ; VPOSR — vertikale Strahlposition
PokeW  $DFF180, $0F00             ; COLOR00 direkt auf Rot
PokeL  $DFF040, bltcon            ; Blitter-Control direkt
PokeB  $BFE001, PeekB($BFE001) And %11111110
```

- `[x]` **`PeekB/PeekW/PeekL(addr)`** — liest 1/2/4 Bytes von Adresse
  - Literal addr: direkte absolute Adressierung (1–2 Instruktionen, kein a0)
  - Runtime addr: eval→d0, `move.l d0,a0`, dann `move.sz (a0),d0`
  - PeekB: zero-extend (0–255); PeekW: sign-extend (`ext.l`); PeekL: volle 32 Bit; kein Fragment
- `[x]` **`PokeB/PokeW/PokeL addr, val`** — schreibt Bytes/Word/Long
  - Beide literal → `move.sz #val,$ADDR` (1 Instruktion)
  - Literal addr + runtime val → eval val→d0, `move.sz d0,$ADDR`
  - Runtime addr → eval addr→d0, push; eval val→d0; pop→a0; `move.sz d0,(a0)`
- `[x]` `Poke addr, val` als Alias für `PokeL` (Blitz2D-Kompatibilität)

> Mit Peek/Poke kann der Programmierer alles ansprechen, was BASSM noch nicht abstrahiert —
> kein Feature-Blocker mehr, sobald diese zwei Befehle vorhanden sind.

---

### ✅ 7. M-BOB — Blitter Objects *(Bewegliche Objekte über Hintergrund)*

```blitz
LoadImage 0, "bg.raw",     320, 256  ; Hintergrund
LoadImage 1, "player.raw",  32,  32  ; Bob — ohne Maske: Direct-Copy
LoadMask  1, "player.mask"            ; optionale 1-bpp Transparenzmaske
LoadImage 2, "deer.raw",    24,  24  ; Bob — ohne Maske

SetBackground 0      ; Image 0 ist der statische Hintergrund

While 1
    DrawBob 1, px, py   ; Hintergrund automatisch gesichert/wiederhergestellt
    DrawBob 2, dx, dy
    ScreenFlip          ; _FlushBobs automatisch injiziert
Wend
```

- `[x]` **`SetBackground imgIdx`** — erklärt ein Image zum read-only Hintergrund
  - `_SetBackground(a0=imgptr)`: überspringt 8-Byte-Header + Palette → speichert Bitplane-0-Ptr in `_bg_bpl_ptr`; installiert `_bg_restore_static` in `_bg_restore_fn`
- `[x]` **`LoadMask imgIdx, "file.mask"`** — optionale 1-bpp Transparenzmaske für DrawBob
  - `_maskAssets` Map; separates DATA_C INCBIN für Chip-RAM; kein Laufzeit-Code
- `[x]` **`DrawBob imgIdx, x, y`** — Eintrag in Bob-Queue (`_AddBob`)
  - Slot = 12 Bytes: imgptr.l + maskptr.l + x.w + y.w; BOBS_MAX=32 Slots
- `[x]` **`bobs.s`** — Bob-System vollständig implementiert:
  - 3 Queues: `_bobs_new`, `_bobs_old_a`, `_bobs_old_b` (Double-Buffer-korrekt: 2-Frame-History)
  - `_FlushBobs`: Restore → Draw → Copy → Reset; auto-injiziert vor `ScreenFlip`
  - `_bg_restore_static`: Blitter-Copy aus statischem BG-Image (BLTCON0=$09F0)
  - `_BltBobMasked`: 4-Kanal-Blit A=Maske/B=Bob/C=D=Screen; Minterm $CA; BLTCON0=$0FCA
  - Kein Mask → `_DrawImage` als Fallback
  - `_bg_restore_fn` Slot vorbereitet → M-SCROLL installiert `_bg_restore_tilemap`
- `[ ]` **Compiler-Injection** — `jsr _FlushBobs` automatisch vor `ScreenFlip` wenn Bob-System aktiv

---

### ✅ 8. M-COLL — Kollisionserkennung *(Physik-Grundlage jedes Spiels)*

```blitz
; Einfacher AABB-Test zweier Rechtecke — kein Fragment, vollständig inline
If RectsOverlap(px, py, 16, 16,  ex, ey, 16, 16) Then HitEnemy i

; AABB mit gespeicherter Bildgröße aus LoadImage-Header
If ImagesOverlap(1, px, py,  2, ex, ey) Then Explode

; Pixel-genaue Kollision via Blitter-AND der Masken
If ImagesCollide(1, px, py,  2, ex, ey) Then HitEnemy i
```

- `[x]` **`RectsOverlap(x1,y1,w1,h1, x2,y2,w2,h2)`** — AABB-Test; gibt -1 (True) oder 0 zurück
  - Pure-Math, kein Fragment — vollständig inline expandiert, kein JSR
  - Bedingung: `x1+w1 > x2 And x2+w2 > x1 And y1+h1 > y2 And y2+h2 > y1`
  - CodeGen: 8 Args per Stack gepusht, `movem.l (sp)+,d0-d7` → d0=h2..d7=x1; a1/a2 als Scratch für x1/y1-Sicherung
  - Typischer Einsatz: Bullets vs. Enemies, Player vs. Platforms, Pickup-Items

- `[x]` **`ImagesOverlap(img1,x1,y1, img2,x2,y2)`** — AABB mit LoadImage-Header-Dimensionen
  - Liest `w` / `h` direkt aus den `dc.w` am Beginn des DATA_C-Labels (Offset +0 / +2)
  - CodeGen: 4 Ausdrucks-Args gepusht, `movem.l (sp)+,d0-d3`; w1/h1/w2/h2 per `move.w lbl+0,d4` etc. aus Header
  - Logisch äquivalent zu `RectsOverlap(x1,y1,w1,h1,x2,y2,w2,h2)`; spart Tipparbeit
  - img-Indizes müssen Literale sein; Dimensionen werden zur Compile-Time aufgelöst

- `[x]` **`ImageRectOverlap(img, x, y, rx, ry, rw, rh)`** — Image-Bounding-Box gegen statisches Rechteck
  - Typischer Einsatz: Sprite gegen Tile-Geometrie, Level-Wände, Plattformen
  - CodeGen: 6 Ausdrucks-Args gepusht, `movem.l (sp)+,d0-d5`; img_w/h aus Header in d6/d7
  - Entspricht `RectsOverlap(x,y,img_w,img_h, rx,ry,rw,rh)` mit automatischen Bild-Dimensionen

- `[ ]` **`ImagesCollide(img1,x1,y1, img2,x2,y2)`** — Pixel-genaue Kollision via Blitter *(Phase 2)*
  - Blitter AND der `.mask`-Daten beider Images in einen temporären BSS-Puffer
  - CPU-Scan danach: irgendein Wort != 0 → Treffer; kein Treffer → 0
  - Benötigt `.mask`-Dateien (je ein Bitplane Maske, 1 Bit = undurchsichtig); A-MGR exportiert diese
  - Kosten: First-AABB-Guard (schnell scheitern ohne Blitter) + 1–2 Blitter-Ops + CPU-Scan
  - **Empfehlung:** `RectsOverlap`/`ImagesOverlap` reichen für ~95 % aller Spielsituationen;
    `ImagesCollide` nur einsetzen wenn sichtbare Kollisionsungenauigkeiten auftreten (runde Sprites)
  - Fragment `collision.s`: `_BltCollide(a0=mask1,a1=mask2,d0=x1,d1=y1,d2=x2,d2=y2,d3=w,d4=h)`
    + `_coll_scratch ds.b MAXBOB_W*MAXBOB_H/8` (BSS, Chip-RAM); kein eigenes Screen-Byte verwendet

> **Blitz2D-Analogie:** `RectsOverlap` und `ImagesOverlap`/`ImagesCollide` sind direkte
> Übernahmen aus Blitz2D. Für BASSM entfällt der Frame-Parameter (kein Sprite-Animation noch),
> alle anderen Argumente sind identisch.

---

### 9. M-ANIM — Sprite-Animation *(Laufende Figuren, Explosionen, Animierte Tiles)*

```blitz
LoadAnimImage 1, "hero.raw",    32, 32, 8   ; 8 Frames à 32×32 Pixel
LoadAnimImage 2, "explode.raw", 16, 16, 6   ; Explosions-Sequenz

; Statisches Bild — kein Hintergrund, kein BG-Restore (z.B. HUD-Sprite)
anim = (anim + 1) Mod 8
DrawImage 1, hx, hy, anim

; Bob über Hintergrund — BG-Restore via _bg_restore_fn
; Identisch für SetBackground (statisch) UND LoadTilemap (Ring-Buffer)
DrawBob 1, px, py, anim
DrawBob 2, ex, ey, explode_frame
ScreenFlip
```

- `[x]` **`LoadAnimImage n, "f.raw", fw, fh, count`** — Blitz2D-Konvention für animierte Images
  - Header: `dc.w fw, fh, GFXDEPTH, rowbytes` — 8 Bytes (identisch zu `LoadImage`; count nur Compile-Zeit)
  - Frame-Layout: alle Frames sequenziell im .raw-File: Frame 0 (alle Planes) → Frame 1 → …
  - `LoadImage` bleibt unverändert — keine Rückwärts-Kompatibilitätsprobleme
  - A-MGR: **Strip-Import** — PNG-Sprite-Sheet (N×fw breit) → Frame-für-Frame in planares Raw *(TODO)*

- `[x]` **`DrawImage n, x, y, frame`** — optionaler 4. Parameter
  - `_DrawImage`: `clr.l d2` + Fall-Through auf `_DrawImageFrame` (XDEF in image.s)
  - `_DrawImageFrame(d2=frame)`: Frame-Offset = `d2 × depth × plane_size` (in image.s)
  - Literal frame: `moveq #N,d2; jsr _DrawImageFrame` — null Overhead für N=0..7
  - Variable frame: push/pop-Kette → `jsr _DrawImageFrame`

- `[x]` **`DrawBob n, x, y, frame`** — optionaler 4. Parameter
  - Bob-Slot jetzt 16 Bytes: imgptr.l + maskptr.l + x.w + y.w + frame.w + padding.w
  - `_AddBob(d2=frame)`: frame aus `8(sp)` gelesen (saved d2 im movem-Frame)
  - `_BltBobMaskedFrame(d2=frame)`: Frame-Offset vor BLTSIZE; Maske konstant (gleiche Silhouette)
  - **Restore-Pass frame-agnostisch**: `_bg_restore_fn` → w×h-Rechteck, unabhängig vom Frame

> **Hintergrund-Unabhängigkeit:** Der Restore-Pass stellt ein Rechteck wieder her — er liest
> keine Bild-Semantik, nur rohe Pixel. Animated Bobs funktionieren deshalb auf **statischem
> Hintergrund** (M-BOB) und **Tilemap-Ring-Buffer** (M-SCROLL) ohne jeden Unterschied.
> Der `_bg_restore_fn`-Zeiger abstrahiert den Hintergrundtyp vollständig — kein separater
> `DrawAnimBob` oder `DrawBobOnTilemap` nötig.

---

### 10. M-SCROLL — Ring-Buffer Tilemap *(scrollende Tile-Welten)*

```blitz
LoadTilemap "world.map"         ; Dimensionen stehen in der Datei
LoadTileset "tiles.raw", 16, 16 ; Tile-Größe; Anzahl wird aus dem Image errechnet

While 1
    ScrollTilemap dx, dy    ; Pixel-Delta — zeichnet neue Strips, updated Scroll-HW
    DrawBob 1, px, py       ; identisch zu statischem BG — kein Unterschied für den User
    ScreenFlip
Wend
```

> **Einheitliche Schnittstelle:** `DrawBob` funktioniert identisch für statische Hintergründe
> (M-BOB) und scrollende Tilemaps (M-SCROLL). BASSM löst den Unterschied intern auf —
> `LoadTilemap` installiert `_bg_restore_tilemap` in `_bg_restore_fn`, `SetBackground`
> installiert `_bg_restore_static`. Für den Nutzer gibt es **keine unterschiedlichen Befehle**.

- `[ ]` **Ring-Buffer in Chip-RAM**: `(320 + 32) × (256 + 32) × planes` ≈ 62 KB bei 5 Planes
  - Feste Größe unabhängig von der Weltgröße; nur der sichtbare Bereich + 1 Tile Rand
  - BPL1MOD = `(buffer_bytes_per_row − display_bytes_per_row)` kompensiert Puffer-Breite
- `[ ]` **`LoadTilemap file`** — lädt Tile-Index-Daten in Fast-RAM
  - Map-Dimensionen (Breite, Höhe) im Dateiformat eingebettet — kein Parameter nötig
  - **Offene Design-Frage:** TileD-Support (TMX/JSON → Binär zur Buildzeit, in `main.js`)
    oder eigener Tilemap-Editor in A-MGR (integriert, einfacheres Binärformat)?
    Beide Wege schließen sich nicht aus: A-MGR-Editor als Primärwerkzeug + TileD-Import
- `[ ]` **`LoadTileset file, tile_w, tile_h`** — lädt Tile-Grafiken
  - Anzahl Tiles = `(image_w / tile_w) × (image_h / tile_h)` — aus Bilddimensionen errechnet
  - Tiles ohne opake Pixel (alle Planes = 0 in jedem Pixel) werden automatisch ignoriert
- `[ ]` **`ScrollTilemap dx, dy`** — Pixel-Delta scrollt den Ausschnitt
  - Fine-Scroll (0–15 px): BPLCON1 (horizontal) / BPLxPT-Offset (vertikal) — 0 Blitter-Kosten
  - Tile-Übergang (±16 px): neue Spalte oder Zeile per Blitter in Ring-Buffer einzeichnen
    - Spalte (16×256×5 Planes): ~1,4 ms Blitter
    - Zeile (320×16×5 Planes): ~3,6 ms Blitter
  - Ring-Buffer zirkulär: neue Strip überschreibt die gegenüberliegende, jetzt unsichtbare Seite
  - Installiert `_bg_restore_tilemap` in `_bg_restore_fn` (einmalig bei `LoadTilemap`)
- `[ ]` **`_bg_restore_tilemap(d0=x, d1=y, d2=w, d3=h)`** — Bob-Restore aus Ring-Buffer
  - Berechnet Ring-Buffer-Adresse: `ring_start + (y + scroll_y_mod) * buf_row + (x + scroll_x_mod) / 8`
  - Normalfall (Bob nicht am Ring-Saum): 1 Blit
  - Randfall (Saum schneidet Bob-Bereich): Split in bis zu 4 Teil-Blits

---

### 11. M-DATA — 2D-Arrays *(Tile-Maps, Spielfelder)*

```blitz
Dim map(19, 14)          ; 20×15 Tile-Map
map(x, y) = TILE_WALL
tile = map(px / 16, py / 16)
```

- `[ ]` Parser: `Dim name(w, h)` — zweites Argument optional; `dim2d`-Node
- `[ ]` CodeGen: BSS `ds.l (w+1)*(h+1)`; Indexformel `y*(w+1)+x` inline
- `[ ]` `arr(x, y)` lesen/schreiben — gleiche Syntax wie 1D mit 2 Argumenten
- `[ ]` Abwärtskompatibel: bestehende 1D-Syntax unverändert

---

### 12. M-TYPE — Strukturen (`Type … EndType`) *(das wichtigste fehlende Feature)*

```blitz
Type Enemy
  Field x
  Field y
  Field vx
  Field vy
  Field hp
  Field active
EndType

Dim enemies.Enemy(15)

enemies(i)\x = Rnd(320)
If enemies(i)\hp <= 0 Then enemies(i)\active = 0
```

**Implementierungsansatz: Statische Arrays von Strukturen (kein Heap)**
- Kein `New`/`Delete` — bare-metal; `Dim name.TypeName(n)` erzeugt statisches BSS-Array
- Feldgröße: 4 Bytes (Long) pro Feld; Struct-Größe = Feldanzahl × 4
- `arr(i)\field` → Adresse = `base + i*structsize + fieldOffset`

- `[x]` Parser: `Type name … Field fname … EndType` — TypeDef-Registry
- `[x]` Parser: `Dim inst.TypeName` (Skalar) + `Dim arr.TypeName(n)` (Array) — separate AST-Nodes
- `[x]` Parser: `inst\field` + `arr(i)\field` lesen/schreiben — `type_field_read`/`type_field_write`-Nodes
- `[x]` CodeGen: `_typeDefs` Map `{name → {fields: string[]}}`; `_typeInstances` Map
- `[x]` CodeGen: BSS `ds.l (n+1)*fieldCount` für Arrays; `ds.l fieldCount` für Skalare
- `[x]` CodeGen: Index-Adressierung `muls.l #stride,d0` + `lea base,a0` + `move.l offset(a0,d0.l),d1`
- `[x]` PERF-2: Pointer-Cache — bei wiederholtem `arr(i)\…` in einem Block wird `i*stride` einmalig berechnet und `a0` wiederverwendet
- `[x]` Fehlerprüfung: unbekannter Type, unbekanntes Feld → Compiler-Fehler

---

## Stufe 3 — Hardware-Features & Musik

> **Ziel:** 100% game- und demo-complete.
> Hardware-Sprites, Scrolling, echte Musik.

---

### 9. M10 — Hardware-Grafik *(Sprites + Scrolling)*

```blitz
DefSprite 0, spriteData
MoveSprite 0, px, py
HideSprite 0

ScrollX 8                  ; BPLCON1 — Fine-Scroll
ScrollY 1                  ; BPL1MOD/BPL2MOD — Coarse-Scroll
```

- `[ ]` **Hardware-Sprites** — 8 OCS Sprites × 16px, eigene Farben, keine CPU-Last
  - `sprite.s`: `_DefSprite(d0=num, a0=data_ptr)` — SPRxPT + Sprite-DMA (DMACON Bit 5)
  - `_MoveSprite(d0=num, d1=x, d2=y)` — SPRxPOS/SPRxCTL patchen
  - `_HideSprite(d0=num)` — SPRxPOS=0 → unsichtbar
- `[ ]` **Hardware-Scrolling** — `ScrollX n`: BPLCON1 (Fine-Scroll 0..15); BPL1MOD/BPL2MOD
- `[ ]` **`Circle x,y,r`** — Bresenham-Kreis in `circle.s`, nutzt `_Plot` intern

---

### 10. M-MOD — ProTracker MOD-Player *("Eine Demo ohne Musik ist ein Bildschirmschoner")*

```blitz
LoadModule "mysong.mod"
PlayModule
StopModule
```

- `[ ]` Fertigen PT-Player als Fragment einbinden (`ptplayer.s` — Public Domain, ~1 KB)
- `[ ]` VBlank-Hook in `startup.s` ruft `_mt_music` bereits auf (50 Hz) — Infrastruktur vorhanden
- `[ ]` `LoadModule` → INCBIN DATA_C (Asset-Pipeline analog zu LoadSample)
- `[ ]` `PlayModule` / `StopModule` → `_mt_init` / `_mt_end`
- `[ ]` Paula-Kanäle 0–3: Kanal-Verwaltung zwischen MOD-Player und Sample-Befehlen

---

## 🎨 Asset Manager — Tooling-Spur *(parallel, nach Bedarf)*

> **Status:** Konverter-Grundlage implementiert (PNG→.raw, WAV→.raw, Palette-Pipeline,
> Click-to-Load, Datei-Watcher). Die folgenden Milestones erweitern das Tool schrittweise.
> **Kein Blocker für die Sprach-Milestones** — kann parallel oder zwischen Sprach-Tasks
> implementiert werden, sobald ein konkreter Bedarf entsteht.

---

### A-MGR-1 — Projektpalette *(interaktiver Editor)*

```
┌─ Projektpalette ─────────────────────────────────────────────┐
│  ██  ██  ██  ██  ██  ██  ██  ██   Farben 0–7                │
│  ██  ██  ██  ██  ██  ██  ██  ██   Farben 8–15               │
│  ··  ··  ··  ··  ··  ··  ··  ··   Farben 16–23 (inaktiv)    │
│  ··  ··  ··  ··  ··  ··  ··  ··   Farben 24–31 (inaktiv)    │
└───────────────────────────────────────────────────────────────┘
```

- `[ ]` **OCS-Farbwähler pro Slot** — Schieberegler 0–15 je Kanal (nicht 0–255); Live-Vorschau
- `[ ]` **Gespeichert** als `assets/palette_<name>.json` im Projektordner
- `[ ]` **Aus BASSM-Code lesen** — `PaletteColor`-Statements parsen → Palette rekonstruieren
- `[ ]` **Bidirektionale Code-Synchronisation** — Palette ändern → Copy-Button erzeugt
  `PaletteColor`-Block; Code geändert → Grid aktualisiert sich
- `[ ]` **Export `.act`** — für Aseprite, Photoshop, GIMP, Inkscape

---

### A-MGR-2 — Bild-Konverter *(erweiterte Features)*

> Grundlage (Drop-Zone, Split-View, PNG→.raw) bereits implementiert.

- `[ ]` **Dithering** — Floyd-Steinberg; Qualitätsunterschied direkt im Split-View sichtbar
- `[ ]` **Fit-Qualitätsanzeige** — mittlerer Farbabstand Bild ↔ Palette (0–100%)
- `[ ]` **Palette-Slots-Anzeige** — "Slots 1 3 5 7 (4 von 16)"
- `[ ]` **Batch-Import** — Ordner wählen → alle Bilder gegen Projektpalette konvertieren
- `[ ]` **Generierter BASSM-Code** (Copy-Button): `LoadImage 0, "hero.raw", 32, 48`

---

### A-MGR-3 — Sound-Konverter *(erweiterte Features)*

> Grundlage (Drop-Zone, WAV→.raw via AudioContext) bereits implementiert.

- `[ ]` **Wellenform-Visualisierung** — Canvas, Zoom, Playback-Cursor
- `[ ]` **Period / Frequenz-Rechner** — bidirektional; Presets: 428/214/135
- `[ ]` **Normalisieren** — Peak auf Maximum
- `[ ]` **Stille trimmen** — Anfang/Ende unter Schwellwert abschneiden
- `[ ]` **Vorschau-Playback** — Original vs. Konvertiert via Web Audio
- `[ ]` **Generierter BASSM-Code** (Copy-Button): `LoadSample 0, "explosion.raw"`

---

### A-MGR-4 — Mehrere Paletten / Szenen-Paletten

```
assets/
├── palette_level1.json
├── palette_level2.json
└── palette_ui.json
```

- `[ ]` **Benannte Paletten** — anlegen, umbenennen, löschen, duplizieren
- `[ ]` **Aktive Palette** — Dropdown; alle Vorschauen beziehen sich darauf
- `[ ]` **Batch-Re-Quantisierung** — Palette ändern → alle Assets neu konvertieren

---

### A-MGR-5 — IDE-Integration

- `[ ]` **Drag & Drop** aus Projektbaum in Code-Editor → fügt `LoadImage`/`LoadSample`-Statement ein
- `[ ]` **Automatische Code-Synchronisation** beim Öffnen:
  - `LoadImage`/`LoadSample`-Statements → markiert referenzierte Assets im Baum
  - `PaletteColor`-Statements → lädt als aktive Projektpalette

---

## 🖥️ IDE — Tooling-Spur *(parallel, nach Bedarf)*

> **Kein Blocker für Sprach- oder Grafik-Milestones.** IDE-Features verbessern den
> Entwicklungskomfort und sind die Grundlage der späteren Gamification der gesamten IDE.

---

### TOOL-IDE-1 — Budget-Bars *(Lebensbalken für CPU + Chip-RAM)* ✅

- `[x]` **`budget.js`** — statische Analyse des BASSM-Quellcodes
  - `Graphics w,h,n` → Frame-Budget (141 800 Cycles @ 50 Hz) + Screen-Buffer-RAM
  - `LoadImage` → Chip-RAM-Verbrauch (DATA_C-Größe aus w×h×planes)
  - `LoadSample` → unbekannte Größe → `+`-Marker
  - Hauptloop-Erkennung: erstes While/Repeat das `ScreenFlip` enthält
  - `For i=0 To N` mit Literalgrenzen → innere Kosten × N multipliziert
  - Cycle-Kosten-Tabelle: `Cls`, `Box`, `DrawImage` (nach Bildgröße), `Plot`, `Line`, `Text`, `CopperColor`, `ScreenFlip`
- `[x]` **Gradient-Bars** im Editor-Footer (22→30 px Strip unter Monaco)
  - Farbverlauf `#00cc44 → #88cc00 → #ccaa00 → cc5500 → #cc1111` — clip bei aktueller Breite
  - Klassen `ok` / `warn` / `crit` (< 65 % / < 88 % / ≥ 88 %) auf Track-Element
  - Glow: `box-shadow` auf Track (nicht Fill) → kein Clip durch `overflow: hidden`
  - CSS-Transition `0.4s cubic-bezier` für sanfte Animation beim Tippen
  - Debounce 600 ms; update auch bei Projekt-Open und File-Load

---

### TOOL-IDE-2 — IDE-Gamification *(geplant)*

- `[ ]` **Amiga-Style Skin** — Toolbar, Panels, Scrollbalken im OCS-Look
- `[ ]` **Weitere Budget-Metriken** — Blitter-Zeit separiert von CPU-Zeit; CHIP vs. FAST RAM
- `[ ]` **Compile-Fehler als "Crash"-Animation** — kurze visuelle Rückmeldung
- `[ ]` **Score-Anzeige** — Gamification-Konzept für Cycle-Effizienz (optional / experimental)

---

## PERF & Niedrige Priorität

### PERF-C — Optionale Variablen-Typisierung *(Expert-Feature, kein Blocker)*

```blitz
col.b = 1      ; Byte  — ds.b, move.b
px.w  = 160    ; Word  — ds.w, move.w
total.l = 0    ; Long  — ds.l (default)
```

**Aufwand: 🔴 Hoch** — Lexer, Parser, CodeGen, BSS, Typpromotion alle betroffen.

- `[ ]` Suffix `.b`/`.w`/`.l` im Lexer erkennen
- `[ ]` Typ-Propagation durch Parser-AST
- `[ ]` Typisierter CodeGen + Typpromotion in `_genBinop`

---

### PERF-low

- `[ ]` **Short Branches** (`.s` statt `.w`): minimaler Effekt auf 68000
- `[ ]` **Register-Caching** (d2–d7): erst nach vollständiger Sprache sinnvoll; braucht Scope-Analyse
- `[ ]` **Subroutinen-Argumente direkt in Register** statt Push/movem

---

### M11 — String-Variablen *(niedrige Demo-Prio)*

- `[ ]` `name$ = "text"`, Konkatenation `a$ + b$`
- `[ ]` `Len(s$)`, `Left$`, `Mid$`, `Right$`
- `[ ]` `Val(s$)`, `Str$(n)` (String-Variablen-Variante; `Str$(n)` für Integer-Ausgabe bereits via LANG-C implementiert)

---

### Optionale Hardware-Features

- `[ ]` **LoadPalette arr** — alle 32 Palette-Einträge aus Integer-Array setzen
- `[ ]` **Copper-Interrupt** — Level-3 für exaktes Raster-Timing (statt WAIT-Abfragen)
- `[ ]` **IFF ILBM Parser** — Standard-Amiga-Bildformat direkt laden

---

## Offene Bugs

- `[~]` **OS-Restore (vAmiga/AROS)**: Nach Programmende dunkelgrauer Screen statt
  Workbench. `LoadView(saved)+RethinkDisplay` implementiert aber unzureichend.
  → Hypothesen in `MEMORY.md`. Niedrige Prio — betrifft nur den Entwicklungskomfort.

---

## Nicht umgesetzt — bewusste Entscheidungen

| Feature | Grund |
|---------|-------|
| `GoTo` / `GoSub` | Spaghetti-Code; Functions + Exit reichen |
| Floating-Point | 68000 ohne FPU — zu langsam; Amiga-Spiele nutzen Fixed-Point |
| String-Variablen (M11) | `Str$` + statische Strings decken 95% der Game-Anforderungen |
| Dynamische Speicherverwaltung | Heap auf Amiga komplex; statische Arrays + Type ausreichend |
| Kurzschluss-Auswertung (And/Or) | 68000 hat keinen Branch-Predictor — minimaler Vorteil |
| Rekursion (tief) | Stack begrenzt; Algorithmen iterativ umsetzbar |

---

## Übersicht: Kritischer Pfad

```
✅ Kern + Grafik + Sound + Bitmaps + Funktionen + Arrays + Operatoren + Include + Asset Manager

Stufe 1 — Sprach-Grundlagen:
  [x] LANG-D   Rnd + Abs
  [x] M9b      JoyUp/Down/Left/Right + Joyfire + KeyDown + MouseX/Y/Down/Hit
  [x] LANG-C   Str$(n)
  [x] LANG-F   Repeat + Exit
  [x] LANG-E   Xor + Shl + Shr
  → ~80% game-complete: Space Invaders, Breakout, Pong möglich

Stufe 2 — Daten & Hardware:
  [x] M-SYS    Peek + Poke
  [x] M-BOB    DrawBob + SetBackground + LoadMask + _bg_restore_fn + bobs.s
  [x] M-COLL   RectsOverlap + ImagesOverlap + ImageRectOverlap (ImagesCollide Phase 2)
  [x] M-ANIM   LoadAnimImage + DrawImage/DrawBob frame-Argument; _DrawImageFrame + _BltBobMaskedFrame
  [ ] M-SCROLL Ring-Buffer Tilemap + ScrollTilemap + _bg_restore_tilemap
  [ ] M-DATA   2D-Arrays
  [x] M-TYPE   Type-Strukturen
  → ~95% game-complete: Tile-Platformer, komplexe Game-Objects

Stufe 3 — Hardware-Features & Musik:
  [ ] M10      Sprites + Scrolling
  [ ] M-MOD    ProTracker
  → 100% game- und demo-complete

IDE-Tooling-Spur (parallel):
  [x] TOOL-IDE-1   Budget-Bars CPU + Chip-RAM
  [ ] TOOL-IDE-2   IDE-Gamification
```
