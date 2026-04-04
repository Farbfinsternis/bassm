# BASSM Tileset Format `.tset` — Spezifikation V1

## 1. Zweck

Das `.tset`-Format kombiniert Palette, Grafik und Eigenschaften eines Tilesets
in einer einzigen Binärdatei. Es ersetzt die bisherige `.iraw`-Datei für Tilesets.

```
tiles.png → Tileset-Editor → tiles.tset   (Palette + Grafik + Typ + Collision + Anim + Slopes)
                            → world.bmap   (Grid: welcher Tile-Index wo — unverändert)
```

```bassm
LoadTileset 0, "tiles.tset"
LoadTilemap 0, "world.bmap"
DrawTilemap 0, 0, scrollX, scrollY
```

Das `.bmap`-Format (8-Byte-Header + 16-Bit-Index-Array, row-major) bleibt unverändert.

---

## 2. Einschränkungen

| Regel                        | Wert                        |
|------------------------------|-----------------------------|
| Tile-Größe                   | 8×8, 16×16 oder 32×32 Pixel |
| Tiles pro Tileset            | 1–1024                      |
| Bitplanes (Depth)            | 1–5                         |
| Byte-Order                   | Big-Endian (Motorola)       |
| Alignment                    | Jede Section beginnt auf gerader Adresse. Bei ungerader Payload-Länge folgt 1 Pad-Byte (0x00). |

---

## 3. Dateiaufbau (Übersicht)

```
┌──────────────────────────────────────────┐
│  HEADER                    (12 Bytes)    │
├──────────────────────────────────────────┤
│  PALETTE  (immer vorhanden)              │
├──────────────────────────────────────────┤
│  IMAGE    (immer vorhanden)              │
├──────────────────────────────────────────┤
│  TYPES    (optional, Flag Bit 0)         │
├──────────────────────────────────────────┤
│  COLLISION (optional, Flag Bit 1)        │
├──────────────────────────────────────────┤
│  ANIMATION (optional, Flag Bit 2)        │
├──────────────────────────────────────────┤
│  SLOPES    (optional, Flag Bit 3)        │
└──────────────────────────────────────────┘
```

Sections erscheinen in **exakt dieser Reihenfolge**. Ist ein Flag-Bit nicht gesetzt,
fehlt die entsprechende Section (0 Bytes). Die Größe jeder Section ist aus dem
Header berechenbar oder selbstbeschreibend (Count-Prefix). Keine Chunk-IDs, keine
Offset-Tabelle — die Einfachheit ist Absicht.

---

## 4. HEADER (12 Bytes)

```
Offset  Größe   Feld            Beschreibung
─────────────────────────────────────────────────────────────────
0       4       magic           ASCII "TSET" (0x54 0x53 0x45 0x54)
4       1       version         Format-Version (1)
5       1       tile_size       Tile-Kantenlänge in Pixel (8, 16 oder 32)
6       2       tile_count      Anzahl Tiles im Tileset (uint16, 1–1024)
8       1       depth           Anzahl Bitplanes (1–5)
9       1       flags           Section-Flags (Bitmask, siehe unten)
10      2       reserved        Reserviert, muss 0x0000 sein
```

### Section-Flags (Byte 9)

```
Bit 0   TYPES      Tile-Typ-Tags vorhanden
Bit 1   COLLISION  Kollisions-Flags vorhanden
Bit 2   ANIMATION  Animations-Gruppen vorhanden
Bit 3   SLOPES     Slope-Heightmaps vorhanden
Bit 4–7            Reserviert (0)
```

PALETTE und IMAGE sind **immer vorhanden** und benötigen kein Flag-Bit.

### Abgeleitete Werte (nicht gespeichert)

```
row_bytes    = (tile_size = 8)  → 2
               (tile_size = 16) → 2
               (tile_size = 32) → 4

palette_size = (1 << depth) × 2        (Anzahl Farben × 2 Bytes)
image_size   = tile_count × tile_size × row_bytes × depth
```

`row_bytes` ist die Breite einer Bitplane-Zeile auf Word-Grenze aufgerundet:
`row_bytes = ((tile_size + 15) >> 4) << 1`. Für die drei erlaubten Tile-Größen
ist das Ergebnis deterministisch.

---

## 5. PALETTE Section (immer vorhanden)

**Offset:** 12 (direkt nach Header)
**Größe:** `palette_size` Bytes (immer gerade → kein Padding nötig)

Enthält `2^depth` OCS-Farbwörter (uint16, Format `$0RGB`, je 4 Bit pro Kanal).

```
Offset  Größe           Feld
──────────────────────────────────────────────
+0      palette_size    color[0] .. color[2^depth - 1]
```

| Depth | Farben | Größe    |
|-------|--------|----------|
| 1     | 2      | 4 Bytes  |
| 2     | 4      | 8 Bytes  |
| 3     | 8      | 16 Bytes |
| 4     | 16     | 32 Bytes |
| 5     | 32     | 64 Bytes |

### BASSM-Philosophie

BASSM setzt die erste geladene Palette als **die** Display-Palette. Daher enthält
jedes `.tset` seine eigene Palette. `LoadTileset 0` schreibt die Palette in die
Copper-Liste (via `_SetImagePalette`). Weitere `LoadTileset`-Aufrufe mit höherem
Slot-Index setzen die Palette **nicht** — der User muss sie explizit laden wenn
gewünscht.

---

## 6. IMAGE Section (immer vorhanden)

**Offset:** 12 + palette_size
**Größe:** `image_size` Bytes (immer gerade → kein Padding nötig)

Die Bilddaten sind **interleaved Bitplanes**, identisch zum Payload einer `.iraw`-Datei.
Tiles sind vertikal gestapelt: Tile 0 beginnt bei Byte 0, Tile 1 bei
`tile_size × row_bytes × depth`, usw.

Aufbau einer Tile-Zeile (interleaved):

```
Plane 0 Row 0  (row_bytes)
Plane 1 Row 0  (row_bytes)
  ...
Plane D-1 Row 0 (row_bytes)
Plane 0 Row 1  (row_bytes)
  ...
```

### Kompatibilität mit `_DrawImageFrame`

Der Codegen emittiert einen synthetischen 8-Byte-Header (dc.w) und platziert
PALETTE + IMAGE per INCBIN direkt dahinter. Das resultierende Memory-Layout
ist **identisch** zum bisherigen .iraw-Layout:

```
[dc.w header: 8B] [palette: 2^depth×2 B] [interleaved image data]
```

`_SetImagePalette` und `_DrawImageFrame` (image.s) funktionieren **ohne Änderung**:
- `_SetImagePalette` liest Palette ab Offset +8 nach dem dc.w-Header
- `_DrawImageFrame` überspringt Palette mit `(1 << depth) * 2` Bytes, dann Blit

---

## 7. TYPES Section (optional, Flag Bit 0)

**Offset:** 12 + palette_size + image_size + ggf. Pad
**Größe:** `tile_count` Bytes + ggf. 1 Pad-Byte

Pro Tile-Index ein Byte: der **Tile-Typ** (0–255). Die Bedeutung der Werte wird
vom User festgelegt (z.B. 0=Leer, 1=Gras, 2=Sand, 3=Wasser). BASSM erzwingt
keine Semantik.

```
Offset  Größe         Feld
──────────────────────────────────────
+0      tile_count    type[0] .. type[tile_count-1]
```

**68k-Zugriff:** `move.b 0(a0,d0.w),d1` — wobei a0 = TYPES-Basisadresse,
d0 = Tile-Index. Ein einziger Instruction-Zugriff.

**Padding:** Ist `tile_count` ungerade, folgt 1 Null-Byte für Word-Alignment
der nächsten Section.

---

## 8. COLLISION Section (optional, Flag Bit 1)

**Offset:** nach TYPES (falls vorhanden) oder nach IMAGE
**Größe:** `tile_count` Bytes + ggf. 1 Pad-Byte

Pro Tile-Index ein Byte als Bitmaske:

```
Bit 0   SOLID       Blockiert Bewegung aus allen Richtungen
Bit 1   PASS_UP     Durchlässig von unten (One-Way-Platform)
Bit 2   PASS_DOWN   Durchlässig von oben
Bit 3   PASS_LEFT   Durchlässig von links
Bit 4   PASS_RIGHT  Durchlässig von rechts
Bit 5   SLOPE       Tile hat Heightmap in SLOPES Section
Bit 6–7             Reserviert (0)
```

### Semantik

- **SOLID** (Bit 0): Universelle Sperre. Wenn gesetzt, werden PASS-Bits ignoriert.
- **PASS_x** (Bit 1–4): Richtungsbezogene Durchlässigkeit. Ein Tile mit
  `PASS_UP=1` blockiert Bewegung von oben nach unten, lässt aber Bewegung von
  unten nach oben durch (klassische One-Way-Platform).
- **SLOPE** (Bit 5): Zeigt an, dass für diesen Tile-Index eine Heightmap in der
  SLOPES Section existiert. Ein Slope-Tile ist implizit begehbar — die Heightmap
  definiert die Oberfläche.

**68k-Zugriff:** `btst #0,0(a0,d0.w)` — ein einziger Bit-Test pro Flag.

---

## 9. ANIMATION Section (optional, Flag Bit 2)

**Größe:** 2 + (group_count × 4) Bytes

```
Offset  Größe   Feld
──────────────────────────────────────────────────
+0      2       group_count     Anzahl Animations-Gruppen (uint16)
+2      4×N     groups[0..N-1]  Gruppendefinitionen
```

Pro Gruppe (4 Bytes):

```
Offset  Größe   Feld
──────────────────────────────────────────────────
+0      2       start_index     Erster Tile-Index der Animation (uint16)
+2      1       frame_count     Anzahl Frames (2–255, konsekutive Tile-Indices)
+3      1       speed           VBlanks pro Frame (1–255, 1 = 50 fps, 5 = 10 fps)
```

### Konvention

Animationsframes sind **konsekutive Tile-Indices** im Tileset. Eine Gruppe mit
`start_index=10, frame_count=4` zykliert durch Tiles 10 → 11 → 12 → 13 → 10 → …

Der User platziert auf der Map den `start_index` (hier: 10). Die Engine ersetzt
diesen zur Laufzeit durch den aktuellen Frame der Gruppe.

---

## 10. SLOPES Section (optional, Flag Bit 3)

**Größe:** 2 + (slope_count × (2 + tile_size)) Bytes

```
Offset  Größe   Feld
──────────────────────────────────────────────────
+0      2       slope_count     Anzahl Slope-Definitionen (uint16)
+2      var     slopes[0..N-1]  Slope-Einträge
```

Pro Slope-Eintrag (2 + tile_size Bytes):

```
Offset  Größe       Feld
──────────────────────────────────────────────────
+0      2           tile_index      Tile-Index (uint16), muss SLOPE-Bit in COLLISION haben
+2      tile_size   heightmap       1 Byte pro Pixel-Spalte (links → rechts)
```

### Heightmap-Werte

Jedes Byte gibt die **Bodenhöhe** an der jeweiligen Pixel-Spalte an,
gemessen vom unteren Rand des Tiles (0 = kein Boden, tile_size = volle Höhe).

Beispiele für tile_size=16:

```
45°-Rampe links→rechts:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15]
45°-Rampe rechts→links:  [15,14,13,12,11,10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
Halbhöhen-Plattform:     [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]
Mulde:                    [8, 5, 3, 2, 1, 0, 0, 0, 0, 0, 0, 1, 2, 3, 5, 8]
```

**68k-Zugriff:** `rel_x = player_x AND (tile_size-1)` (Bit-Maske, da tile_size
Zweierpotenz), dann `move.b 0(a0,d0.w),d1` auf die Heightmap-Tabelle.

---

## 11. Größenberechnung & RAM-Budget

### Formel

```
total = 12                                              ; Header
      + (1 << depth) × 2                                ; PALETTE
      + tile_count × tile_size × row_bytes × depth      ; IMAGE
      + tile_count       (if TYPES)       + pad
      + tile_count       (if COLLISION)   + pad
      + 2 + groups × 4  (if ANIMATION)
      + 2 + slopes × (2 + tile_size)  (if SLOPES)
```

### Beispielrechnung: Typisches Platformer-Tileset

| Parameter         | Wert       |
|-------------------|------------|
| tile_size         | 16         |
| tile_count        | 128        |
| depth             | 4          |
| Animations-Gruppen| 4          |
| Slopes            | 8          |

```
Header:       12 Bytes
PALETTE:      16 × 2                    =      32 Bytes
IMAGE:        128 × 16 × 2 × 4         =  16.384 Bytes
TYPES:        128                       =     128 Bytes
COLLISION:    128                       =     128 Bytes
ANIMATION:    2 + 4 × 4                =      18 Bytes
SLOPES:       2 + 8 × (2 + 16)         =     146 Bytes
──────────────────────────────────────────────────────────
GESAMT:                                   16.848 Bytes  (~16,5 KB)
```

Davon landen ~16,4 KB (PALETTE + IMAGE) im Chip-RAM, ~420 Bytes (Metadaten)
im Fast-RAM (oder Chip falls kein Fast vorhanden). Bei 512 KB Chip-RAM sind
selbst 256 Tiles mit 5 Planes (40 KB IMAGE + 64 B Palette) unkritisch.

### Maximales Szenario: 1024 Tiles, 32×32, 5 Planes

```
IMAGE: 1024 × 32 × 4 × 5 = 655.360 Bytes = 640 KB → ÜBERSCHREITET 512 KB CHIP-RAM
```

Realistische Grenze bei 512 KB Chip: **~300 Tiles à 32×32×5 Planes** (192 KB),
wenn gleichzeitig Double-Buffer-Bitplanes (~100 KB) und Copper/Sound benötigt werden.
Der Tileset-Editor sollte die geschätzte Chip-RAM-Belegung anzeigen.

---

## 12. Integration mit dem BASSM-Compiler

### Codegen (codegen.js)

`LoadTileset 0, "tiles.tset"` erzeugt:

```asm
        SECTION _tileset_0_sec,DATA_C
        XDEF    _tileset_0
_tileset_0:
        dc.w    16,16                   ; tile_w, tile_h  (aus .tset Header)
        dc.w    GFXDEPTH+$8000          ; depth | $8000   (interleaved Flag)
        dc.w    2                       ; row_bytes
        INCBIN  "tiles.tset",12,32      ; PALETTE (Offset 12, palette_size Bytes)
        INCBIN  "tiles.tset",44,16384   ; IMAGE   (Offset 12+palette_size, image_size Bytes)
        EVEN

; --- Metadaten-Sections (nur wenn flags ≠ 0): ---

        SECTION _tileset_0_types_sec,DATA
        XDEF    _tileset_0_types
_tileset_0_types:
        INCBIN  "tiles.tset",16428,128  ; TYPES

        SECTION _tileset_0_coll_sec,DATA
        XDEF    _tileset_0_coll
_tileset_0_coll:
        INCBIN  "tiles.tset",16556,128  ; COLLISION
        EVEN

; usw. für ANIMATION, SLOPES
```

Die Offsets und Längen berechnet der Codegen zur Compile-Zeit aus dem .tset-Header.
Nicht vorhandene Sections (Flag=0) erzeugen kein Label und kein INCBIN.

### Section-Zuordnung

| Daten      | ASM Section      | RAM-Typ     |
|------------|------------------|-------------|
| PALETTE    | `SECTION DATA_C` | Chip-RAM    |
| IMAGE      | `SECTION DATA_C` | Chip-RAM    |
| TYPES      | `SECTION DATA`   | Fast/Chip   |
| COLLISION  | `SECTION DATA`   | Fast/Chip   |
| ANIMATION  | `SECTION DATA`   | Fast/Chip   |
| SLOPES     | `SECTION DATA`   | Fast/Chip   |

### Memory-Layout (Runtime)

Durch die Platzierung von PALETTE direkt nach dem dc.w-Header entsteht im
Amiga-Speicher exakt das Layout, das `_SetImagePalette` und `_DrawImageFrame`
(image.s) erwarten:

```
_tileset_0:
    [dc.w header       8 Bytes]   ← _SetImagePalette liest depth hier
    [palette      2^depth×2 B]    ← _SetImagePalette liest Farben ab Offset +8
    [image data    image_size]    ← _DrawImageFrame überspringt Palette automatisch
```

**Keine Änderungen an image.s, tilemap.s oder bobs.s nötig.**

---

## 13. Abgrenzung: Was das Format NICHT definiert

Das `.tset`-Format beschreibt **was ein Tile ist**. Es definiert nicht:

- **Kollisions-Algorithmus:** Wie "Collide and Slide" auf der Heightmap ausgewertet
  wird, ist Engine-Code in `tilemap.s`, nicht Bestandteil des Formats.
- **Animations-Playback:** Wie die Engine Frame-Cycling umsetzt (VBlank-Counter,
  Substitutions-LUT) ist Runtime-Logik.
- **Tile-Platzierung:** Welcher Tile-Index wo auf der Map liegt, steht in der `.bmap`.
- **Sprach-API:** Befehle wie `GetTile()`, `GetTileType()`, `ChangeTile()` sind
  Compiler-Features (BASSM-Sprachdesign), nicht Format-Features.
