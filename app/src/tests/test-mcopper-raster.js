// ============================================================================
// test-mcopper-raster.js — Tests for M-COPPER: CopperColor rasterbar support
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { compile } = makePipeline();

const HDR = 'Graphics 320,256,4\n';

// ── Helper ────────────────────────────────────────────────────────────────────

function compileWith(src) {
    return compile(HDR + src);
}

// ─────────────────────────────────────────────────────────────────────────────
//  EQU / INCLUDE — emitted only when CopperColor is present
// ─────────────────────────────────────────────────────────────────────────────

test('CopperColor: GFXRASTER EQU emitted when CopperColor is used', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    assertContains(asm, 'GFXRASTER');
});

test('CopperColor: GFXRASTER EQU is min(H, 212) = 212 for 320x256', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    assertContains(asm, 'GFXRASTER    EQU 212');
});

test('CopperColor: copper_raster.s included when CopperColor is used', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    assertContains(asm, 'INCLUDE "copper_raster.s"');
});

test('No CopperColor: GFXRASTER EQU NOT emitted', () => {
    const asm = compileWith('Cls');
    assert(!asm.includes('GFXRASTER'), 'GFXRASTER EQU must not appear without CopperColor');
});

test('No CopperColor: copper_raster.s NOT included', () => {
    const asm = compileWith('Cls');
    assert(!asm.includes('copper_raster.s'), 'copper_raster.s must not appear without CopperColor');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Copper list raster sections
// ─────────────────────────────────────────────────────────────────────────────

test('CopperColor: _gfx_raster_a label emitted in copper list A', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    assertContains(asm, 'XDEF    _gfx_raster_a');
    assertContains(asm, '_gfx_raster_a:');
});

test('CopperColor: _gfx_raster_b label emitted in copper list B', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    assertContains(asm, 'XDEF    _gfx_raster_b');
    assertContains(asm, '_gfx_raster_b:');
});

test('CopperColor: raster entries appear before END in copper list A', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    // The first raster entry for y=0: WAIT vStart=0x2C=44 → (44<<8)|1 = $2C01
    assertContains(asm, 'dc.w    $2C01,$FF00');
    assertContains(asm, 'dc.w    $0180,$0000');
});

test('CopperColor: copper END instruction still present', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    // Both copper lists must still end with the copper END instruction
    const endCount = (asm.match(/\$FFFF,\$FFFE/g) ?? []).length;
    assertEqual(endCount, 2);  // one per copper list
});

test('CopperColor: 212 WAIT entries emitted per copper list (256-height case)', () => {
    const asm = compileWith('CopperColor 0,15,0,0');
    // Count dc.w lines with $FF00 (WAIT lo word) — 212 per list = 424 total
    const waitCount = (asm.match(/\$FF00/g) ?? []).length;
    assertEqual(waitCount, 424);
});

test('No CopperColor: raster labels NOT emitted in copper list', () => {
    const asm = compileWith('Cls');
    assert(!asm.includes('_gfx_raster_a'), 'raster labels must not appear without CopperColor');
    assert(!asm.includes('_gfx_raster_b'), 'raster labels must not appear without CopperColor');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CodeGen — compile-time path (all args are integer literals)
// ─────────────────────────────────────────────────────────────────────────────

test('CopperColor compile-time: emits moveq #y,d0', () => {
    const asm = compileWith('CopperColor 10,15,8,0');
    assertContains(asm, 'moveq   #10,d0');
});

test('CopperColor compile-time: emits move.w #$0RGB,d1 (r=15=$F, g=8=$8, b=0=$0 → $0F80)', () => {
    const asm = compileWith('CopperColor 10,15,8,0');
    assertContains(asm, 'move.w  #$0F80,d1');
});

test('CopperColor compile-time: emits jsr _SetRasterColor', () => {
    const asm = compileWith('CopperColor 10,15,8,0');
    assertContains(asm, 'jsr     _SetRasterColor');
});

test('CopperColor compile-time: r/g/b nibble clamp (values > 15 masked to low nibble)', () => {
    // r=31 → &0xF = 15 = $F, g=16 → &0xF = 0 = $0, b=255 → &0xF = 15 = $F → $0F0F
    const asm = compileWith('CopperColor 0,31,16,255');
    assertContains(asm, 'move.w  #$0F0F,d1');
});

test('CopperColor compile-time: y=0, all-black ($0000)', () => {
    const asm = compileWith('CopperColor 0,0,0,0');
    assertContains(asm, 'moveq   #0,d0');
    assertContains(asm, 'move.w  #$0000,d1');
    assertContains(asm, 'jsr     _SetRasterColor');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CodeGen — runtime path (any arg is a variable or expression)
// ─────────────────────────────────────────────────────────────────────────────

test('CopperColor runtime: emits jsr _SetRasterColorRGB when y is variable', () => {
    const asm = compileWith('CopperColor y,15,8,0');
    assertContains(asm, 'jsr     _SetRasterColorRGB');
});

test('CopperColor runtime: emits jsr _SetRasterColorRGB when r is variable', () => {
    const asm = compileWith('CopperColor 0,r,8,0');
    assertContains(asm, 'jsr     _SetRasterColorRGB');
});

test('CopperColor runtime: emits movem.l (sp)+,d1-d3', () => {
    const asm = compileWith('CopperColor y,r,g,b');
    assertContains(asm, 'movem.l (sp)+,d1-d3');
});

test('CopperColor runtime: variable y appears in BSS', () => {
    const asm = compileWith('CopperColor y,15,8,0');
    assertContains(asm, '_var_y:');
});

test('CopperColor runtime: all variable args appear in BSS', () => {
    const asm = compileWith('CopperColor line,rc,gc,bc');
    assertContains(asm, '_var_line:');
    assertContains(asm, '_var_rc:');
    assertContains(asm, '_var_gc:');
    assertContains(asm, '_var_bc:');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Integration — CopperColor inside a For loop (realistic demo usage)
// ─────────────────────────────────────────────────────────────────────────────

test('Integration: CopperColor in For loop compiles without error', () => {
    const src = [
        'For y = 0 To 211',
        '  CopperColor y, y, 0, 15',
        'Next y',
        'ScreenFlip',
    ].join('\n');
    const asm = compileWith(src);
    assertContains(asm, '_gfx_raster_a:');
    assertContains(asm, 'jsr     _SetRasterColorRGB');
    assertContains(asm, 'jsr     _ScreenFlip');
});

test('Integration: CopperColor in While loop with compile-time colors', () => {
    const src = [
        'While 1',
        '  CopperColor 50, 15, 0, 0',
        '  CopperColor 100, 0, 15, 0',
        '  CopperColor 150, 0, 0, 15',
        '  ScreenFlip',
        'Wend',
    ].join('\n');
    const asm = compileWith(src);
    assertContains(asm, 'moveq   #50,d0');
    assertContains(asm, 'moveq   #100,d0');
    assertContains(asm, 'moveq   #150,d0');
    assertContains(asm, 'jsr     _ScreenFlip');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Regression: command-name variable as CopperColor arg
// ─────────────────────────────────────────────────────────────────────────────

test('Regression: CopperColor with "line" as y-variable (command name conflict)', () => {
    // "line" is the Line drawing command — must still work as a variable name
    const src = [
        'For line = 0 To 211',
        '  CopperColor line, 15, 0, 0',
        'Next line',
    ].join('\n');
    const asm = compileWith(src);
    assertContains(asm, '_var_line:');
    assertContains(asm, 'jsr     _SetRasterColorRGB');
});

// ─────────────────────────────────────────────────────────────────────────────

summary('M-COPPER Rasterbar');
