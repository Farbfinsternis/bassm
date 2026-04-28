// ============================================================================
// sprint2-bmap.test.js — End-to-End Tests für M3 (.bmap v2 Format)
// ============================================================================
// Akzeptanz S3-T04 / M4-T05:
//   - Roundtrip „v2-Fixture → Codegen parst Header → korrekte ASM-Emission"
//   - Tileset-Auto-Linking abgesichert (INCBIN-Offset überspringt Header + Pfad)
//   - Negativ-Pfade aus plans/bmap-v2-spec.md §7
//
// Wir testen die Compiler-Seite des Lebenszyklus. Der Editor-Roundtrip
// (_tmapParseBmap/_tmapBuildBmapBinary) lebt in tilemap-editor.js als
// Browser-Skript ohne Exports und ist von Node aus nicht direkt aufrufbar;
// die produktive Konsequenz von Auto-Tileset (korrekter INCBIN-Offset über
// dem Header + Pfad-Block + Pad) ist aber komplett auf Compiler-Seite
// verifizierbar.

import { describe, test, assertContains, assertNotContains, assertThrows } from './_runner.js';
import { makePipeline, makeBmapHeader, makeBmapFile, makeAssetMapReader, HDR } from './_pipeline.js';

// Generate a fresh DrawTilemap-less program — LoadTilemap alone emits no
// runtime code, only the asset section, which is what we want to inspect.
const PROG = file => HDR + `LoadTilemap 0,"${file}"\n`;

describe('Sprint-2 / M3 — .bmap v2 Codegen Roundtrip', () => {
    test('Map ohne Tileset-Pfad: INCBIN startet bei 24, Runtime-Header korrekt', () => {
        const file = makeBmapFile({ mapW: 4, mapH: 3, tileW: 16, tileH: 16, tilesetPath: '' });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'world.bmap': file }),
        });
        const asm = compile(PROG('world.bmap'));
        assertContains(asm, 'dc.w    4,3,16,16');           // runtime header from parsed bytes
        assertContains(asm, 'INCBIN  "world.bmap",24,24');  // 24 = no path; 4*3*2 = 24 indices bytes
    });

    test('Map mit gerader Pfadlänge: kein Pad, INCBIN-Offset = 24+len', () => {
        const path = 'tiles/world.tset'; // 16 bytes (gerade)
        const file = makeBmapFile({ mapW: 2, mapH: 2, tileW: 8, tileH: 8, tilesetPath: path });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'm.bmap': file }),
        });
        const asm = compile(PROG('m.bmap'));
        assertContains(asm, 'dc.w    2,2,8,8');
        assertContains(asm, `INCBIN  "m.bmap",${24 + 16},${2 * 2 * 2}`);
    });

    test('Map mit ungerader Pfadlänge: Pad-Byte addiert, INCBIN-Offset = 24+len+1', () => {
        const path = 'a.tset'; // 6 bytes — gerade. Nimm einen ungeraden:
        const oddPath = 'assets/d.tset'; // 13 bytes (ungerade)
        const file = makeBmapFile({ mapW: 4, mapH: 3, tileW: 16, tileH: 16, tilesetPath: oddPath });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'odd.bmap': file }),
        });
        const asm = compile(PROG('odd.bmap'));
        assertContains(asm, 'dc.w    4,3,16,16');
        assertContains(asm, `INCBIN  "odd.bmap",${24 + 13 + 1},${4 * 3 * 2}`);
        void path;
    });

    test('Asset wird unter dem angegebenen Slot registriert (_tilemap_0 Label)', () => {
        const file = makeBmapFile({ mapW: 2, mapH: 2, tileW: 8, tileH: 8, tilesetPath: '' });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'm.bmap': file }),
        });
        const asm = compile(PROG('m.bmap'));
        assertContains(asm, '_tilemap_0:');
        assertContains(asm, 'SECTION _tilemap_0_sec,DATA');
        assertContains(asm, 'XDEF    _tilemap_0');
    });

    test('Tile-Dimensionen 8/16/32 werden alle akzeptiert (32×32 Tile-Test)', () => {
        const file = makeBmapFile({ mapW: 1, mapH: 1, tileW: 32, tileH: 32, tilesetPath: '' });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'big.bmap': file }),
        });
        const asm = compile(PROG('big.bmap'));
        assertContains(asm, 'dc.w    1,1,32,32');
    });

    test('Kein doppeltes Asset bei zweimaligem LoadTilemap auf gleichem Slot', () => {
        const file = makeBmapFile({ mapW: 2, mapH: 2, tileW: 8, tileH: 8, tilesetPath: '' });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'a.bmap': file, 'b.bmap': file }),
        });
        const asm = compile(HDR + 'LoadTilemap 0,"a.bmap"\nLoadTilemap 0,"b.bmap"\n');
        // Slot 0 ist nach dem ersten Load belegt; der zweite Aufruf wird stumm
        // ignoriert (codegen.js:3375 `if (this._tilemapAssets.has(idxArg.value)) return;`).
        assertContains(asm, 'INCBIN  "a.bmap",24,8');
        assertNotContains(asm, '"b.bmap"');
    });
});

describe('Sprint-2 / M3 — .bmap v2 Negativ-Pfade', () => {
    test('Legacy v1 (kein BMAP-Magic) → throw mit Migrations-Hinweis', () => {
        // Old format: 8-byte plain header, no magic
        const legacy = new Uint8Array([0x00, 0x04, 0x00, 0x03, 0x00, 0x10, 0x00, 0x10, /* ... */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'old.bmap': legacy }),
        });
        assertThrows(
            () => compile(PROG('old.bmap')),
            'legacy v1'
        );
    });

    test('Falsche Version (z.B. 1) → klare Fehlermeldung', () => {
        const hdr = makeBmapHeader(2, 2, 8, 8, 0);
        hdr[4] = 0x00; hdr[5] = 0x01;   // version = 1
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'v1.bmap': new Uint8Array(hdr) }),
        });
        assertThrows(
            () => compile(PROG('v1.bmap')),
            'unsupported version 1'
        );
    });

    test('Reserved flags ≠ 0 → throw', () => {
        const hdr = makeBmapHeader(2, 2, 8, 8, 0);
        hdr[7] = 0x01;                  // flags = 1
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'flag.bmap': new Uint8Array(hdr) }),
        });
        assertThrows(
            () => compile(PROG('flag.bmap')),
            'reserved flags'
        );
    });

    test('mapW = 0 → throw mit Dimensions-Hinweis', () => {
        const hdr = makeBmapHeader(0, 3, 16, 16, 0);
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'zero.bmap': new Uint8Array(hdr) }),
        });
        assertThrows(
            () => compile(PROG('zero.bmap')),
            'ungültige Map-Dimension'
        );
    });

    test('tile_w = 24 (nicht 8/16/32) → throw mit Tile-Dimension-Hinweis', () => {
        const hdr = makeBmapHeader(2, 2, 24, 16, 0);
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'odd.bmap': new Uint8Array(hdr) }),
        });
        assertThrows(
            () => compile(PROG('odd.bmap')),
            'ungültige Tile-Dimension'
        );
    });

    test('Kein Projekt-Verzeichnis (kein headerReader) → klare Fehlermeldung', () => {
        const { compile } = makePipeline();   // kein headerReader gesetzt
        assertThrows(
            () => compile(PROG('any.bmap')),
            'kein Projekt-Verzeichnis'
        );
    });

    test('Datei nicht lesbar → throw mit Reader-Fehlertext', () => {
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ /* leer */ }),
        });
        assertThrows(
            () => compile(PROG('missing.bmap')),
            'file not found'
        );
    });

    test('Slot kein Integer-Literal → throw', () => {
        const file = makeBmapFile({ mapW: 2, mapH: 2, tileW: 8, tileH: 8, tilesetPath: '' });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'm.bmap': file }),
        });
        assertThrows(
            () => compile(HDR + 'LoadTilemap "x","m.bmap"\n'),
            'Integer-Literal'
        );
    });

    test('Dateiname kein String-Literal → throw', () => {
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({}),
        });
        assertThrows(
            () => compile(HDR + 'LoadTilemap 0, 42\n'),
            'String-Literal'
        );
    });
});

describe('Sprint-2 / M3 — Auto-Tileset (Compiler-Konsequenz)', () => {
    // Akzeptanz: „Tileset-Auto-Linking abgesichert". Auf Compiler-Seite heißt
    // das: Tileset-Pfad im Header beeinflusst NUR die INCBIN-Offsets — der
    // Pfad selbst wird nicht zu LoadTileset umgemünzt (siehe Spec §9). Ein
    // LoadTilemap mit Tileset-Pfad muss also exakt dieselbe Asset-Emission
    // ergeben wie das gleiche Map ohne Pfad — nur eben mit anderem Offset.
    test('Pfad im Header ≠ separater LoadTileset (kein impliziter Slot belegt)', () => {
        const file = makeBmapFile({ mapW: 2, mapH: 2, tileW: 8, tileH: 8, tilesetPath: 'assets/x.tset' });
        const { compile, codegen } = makePipeline({
            headerReader: makeAssetMapReader({ 'm.bmap': file }),
        });
        compile(PROG('m.bmap'));
        // Tileset-Slot 0 darf NICHT durch das LoadTilemap-Header-Feld belegt
        // worden sein — Auto-Linking ist Editor-Feature, nicht Compiler-Feature.
        const tilesetAssets = codegen._tilesetAssets;
        if (tilesetAssets.size !== 0) {
            throw new Error(`Expected no tileset assets, got ${tilesetAssets.size} (slot 0 should not be implicitly populated)`);
        }
    });

    test('Indices liegen nach Header + Pfad + Pad — INCBIN-Length deckt nur Indices', () => {
        const path = 'p.tset'; // 6 bytes (gerade → kein Pad)
        const file = makeBmapFile({ mapW: 5, mapH: 5, tileW: 16, tileH: 16, tilesetPath: path });
        const { compile } = makePipeline({
            headerReader: makeAssetMapReader({ 'm.bmap': file }),
        });
        const asm = compile(PROG('m.bmap'));
        // 5×5×2 = 50 indices bytes, offset 24+6 = 30, kein Pad
        assertContains(asm, `INCBIN  "m.bmap",30,50`);
        void path;
    });
});
