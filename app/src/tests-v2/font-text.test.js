// ============================================================================
// font-text.test.js — Renderer-Smoke (font-chain-fix M4-T02)
// ============================================================================
// LoadFont + UseFont + Color + Text in einer Pipeline-Compile-Smoke.
// Ziel: kein Throw, der UseFont-Emit setzt alle für den Renderer relevanten
// Descriptor-Felder; Color landet als _draw_color, das _Text-Fragment ist
// referenziert.

import { describe, test, assertContains } from './_runner.js';
import { makePipeline, makeBfntHeader, HDR } from './_pipeline.js';

function makeBfntReader(headers) {
    return (filename, bytes) => {
        const hdr = headers[filename];
        if (!hdr) return { ok: false, error: 'file not found' };
        return { ok: true, data: hdr.slice(0, bytes) };
    };
}

describe('font-chain-fix M4-T02 — Renderer-Smoke (LoadFont + UseFont + Color + Text)', () => {
    test('10-px-Font: UseFont-Emit setzt data, bpr, advance, space_w', () => {
        // 10×7 mit tracking=2, spaceW=12 → bpr=2, advance=12, space_w=12.
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(10, 7, 32, 0, 2, 12) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt" : UseFont 0 : Color 1 : Text 0,0,"AB"\n');

        assertContains(asm, 'move.l  #_font_0_data,_active_font_data');
        assertContains(asm, 'move.w  #2,_active_font_bpr');         // ceil(10/8)
        assertContains(asm, 'move.w  #12,_active_font_advance');    // 10 + 2
        assertContains(asm, 'move.w  #12,_active_font_space_w');    // explizit aus Header
        assertContains(asm, '_Text');                                // Renderer-Routine referenziert
    });

    test('8-px-Font Default-Tracking: advance = charW+1, space_w = charW', () => {
        // 8×8 mit tracking=1, spaceW=0 → advance=9, space_w=8.
        const reader = makeBfntReader({ 'f.bfnt': makeBfntHeader(8, 8, 96, 0, 1, 0) });
        const { compile } = makePipeline({ headerReader: reader });
        const asm = compile(HDR + 'LoadFont 0,"f.bfnt" : UseFont 0 : Color 2 : Text 10,20,"Hi"\n');

        assertContains(asm, 'move.l  #_font_0_data,_active_font_data');
        assertContains(asm, 'move.w  #1,_active_font_bpr');
        assertContains(asm, 'move.w  #9,_active_font_advance');
        assertContains(asm, 'move.w  #8,_active_font_space_w');
        assertContains(asm, '_Text');
    });
});
