// ============================================================================
// font-loadfont.test.js — Regeltests für font-chain-fix M3 + M4-T01
// ============================================================================
// LoadFont-Signatur ist seit M3 zwingend `LoadFont index, "file.bfnt"` (2 Args).
// Header ist 16 Bytes (M1-T10). Validiert Codegen-Pfad: Asset-Registrierung,
// Daten-Emission (`_font_N` Section + `_lookup`/`_data` EQU-Offsets) und das
// UseFont-Emit für die descriptor-relevanten Felder (advance, space_w, lookup_size).

import { describe, test, assert, assertContains, assertThrows } from './_runner.js';
import { makePipeline, makeBfntHeader, HDR } from './_pipeline.js';

// Stub: liefert für jeden Filename einen aus `headers` abgeleiteten BFNT-Header.
function makeBfntReader(headers) {
    return (filename, bytes) => {
        const hdr = headers[filename];
        if (!hdr) return { ok: false, error: 'file not found' };
        return { ok: true, data: hdr.slice(0, bytes) };
    };
}

describe('font-chain-fix M4-T01 — LoadFont 2-Arg-Signatur + .bfnt-Header', () => {
    test('LoadFont 0,"f.bfnt" 8x8 registriert Asset + emittiert _font_0 Section', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt"\n');
        assertContains(asm, 'SECTION _font_0_sec,DATA');
        assertContains(asm, 'INCBIN  "f.bfnt"');
        // M1-T10: Header ist 16 B, Lookup-Offset = 16, Data-Offset = 16+128 für 128er-Lookup.
        assert(/_font_0_lookup\s+EQU\s+_font_0\+16\b/.test(asm),
            `Erwartet "_font_0_lookup EQU _font_0+16", asm:\n${asm.slice(0, 600)}`);
        assert(/_font_0_data\s+EQU\s+_font_0\+16\+128\b/.test(asm),
            `Erwartet "_font_0_data EQU _font_0+16+128", asm:\n${asm.slice(0, 600)}`);
    });

    test('LoadFont 16x16 — bpr=2, glyph_size=32 sichtbar im UseFont-Emit', () => {
        const reader = makeBfntReader({ 'big.bfnt': makeBfntHeader(16, 16, 64) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"big.bfnt"\nUseFont 0\n');
        assertContains(asm, 'move.w  #2,_active_font_bpr');
        assertContains(asm, 'move.w  #32,_active_font_glyph_size');
        assertContains(asm, 'move.w  #16,_active_font_charW');
    });

    test('LoadFont 10x7 — bpr=2, glyph_size=14 wird akzeptiert', () => {
        const reader = makeBfntReader({ 't.bfnt': makeBfntHeader(10, 7, 32) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"t.bfnt"\nUseFont 0\n');
        assertContains(asm, 'move.w  #2,_active_font_bpr');
        assertContains(asm, 'move.w  #14,_active_font_glyph_size');
    });

    test('charW=20 wirft "außerhalb 1..16"', () => {
        const reader = makeBfntReader({ 'wide.bfnt': makeBfntHeader(20, 8, 32) });
        const { compile } = makePipeline({ headerReader: reader });
        assertThrows(
            () => compile(HDR + 'LoadFont 0,"wide.bfnt"\n'),
            'außerhalb 1..16'
        );
    });

    test('5-Arg-Form wirft Migrations-Hinweis (M3-T01)', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96) });
        const { compile } = makePipeline({ headerReader: reader });
        assertThrows(
            () => compile(HDR + 'LoadFont 0,"abc","f.raw",8,8\n'),
            'Legacy .raw-Fonts werden nicht mehr unterstützt'
        );
    });

    test('Legacy .raw-Endung (2-Arg) wirft Migrations-Hinweis', () => {
        const reader = makeBfntReader({ 'f.raw': makeBfntHeader(8, 8, 96) });
        const { compile } = makePipeline({ headerReader: reader });
        assertThrows(
            () => compile(HDR + 'LoadFont 0,"f.raw"\n'),
            'nur .bfnt-Dateien werden unterstützt'
        );
    });

    test('256-Byte-Lookup (flags Bit 0 = 1) — Data-Offset = 16+256', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 256, 0x01) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt"\nUseFont 0\n');
        assert(/_font_0_data\s+EQU\s+_font_0\+16\+256\b/.test(asm),
            `Erwartet "_font_0_data EQU _font_0+16+256", asm:\n${asm.slice(0, 600)}`);
        assertContains(asm, 'move.w  #256,_active_font_lookup_size');
    });

    test('tracking=3 → advance = charW + 3 im UseFont-Emit', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96, 0, 3, 0) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt"\nUseFont 0\n');
        assertContains(asm, 'move.w  #11,_active_font_advance');     // 8 + 3
    });

    test('spaceW=0 im Header → wird auf charW gemappt', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96, 0, 1, 0) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt"\nUseFont 0\n');
        assertContains(asm, 'move.w  #8,_active_font_space_w');      // = charW
    });

    test('spaceW=12 im Header → bleibt 12 im UseFont-Emit', () => {
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96, 0, 1, 12) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt"\nUseFont 0\n');
        assertContains(asm, 'move.w  #12,_active_font_space_w');
    });
});
