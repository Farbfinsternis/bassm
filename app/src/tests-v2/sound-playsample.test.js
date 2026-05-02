// ============================================================================
// sound-playsample.test.js — PlaySample loop-parameter dispatch
// ============================================================================
// PlaySample now consolidates the previous PlaySample / PlaySampleOnce pair
// into a single command:
//
//   PlaySample index, channel [, loop [, period [, volume]]]
//
//   loop = 0 (default) → compile-time dispatch to _PlaySampleOnce (one-shot)
//   loop ≠ 0           → compile-time dispatch to _PlaySample      (looping)
//   loop = variable    → runtime dispatch via tst.l + bne.s (both jsr emitted)

import { describe, test, assertContains, assertNotContains, assertThrows } from './_runner.js';
import { makePipeline, HDR } from './_pipeline.js';

const LOAD = 'LoadSample 0,"sfx.raw"\n';

describe('PlaySample — loop dispatch', () => {
    test('No loop arg defaults to one-shot (_PlaySampleOnce)', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0\n');
        assertContains(asm, 'jsr     _PlaySampleOnce');
        assertNotContains(asm, 'jsr     _PlaySample\n');  // exact, no Once suffix
    });

    test('loop literal 0 → one-shot', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0,0\n');
        assertContains(asm, 'jsr     _PlaySampleOnce');
        assertNotContains(asm, 'jsr     _PlaySample\n');
    });

    test('loop literal -1 → looping (_PlaySample)', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0,-1\n');
        assertContains(asm, 'jsr     _PlaySample\n');
        assertNotContains(asm, 'jsr     _PlaySampleOnce');
    });

    test('loop literal 1 → looping (any nonzero counts as true)', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0,1\n');
        assertContains(asm, 'jsr     _PlaySample\n');
        assertNotContains(asm, 'jsr     _PlaySampleOnce');
    });

    test('loop variable → runtime dispatch with both jsr targets and tst.l/bne.s', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'lp=1\nPlaySample 0,0,lp\n');
        assertContains(asm, 'tst.l   d0');
        assertContains(asm, 'bne.s');
        assertContains(asm, 'jsr     _PlaySampleOnce');
        assertContains(asm, 'jsr     _PlaySample\n');
    });

    test('Default period 428 and volume 64 are emitted when omitted', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0\n');
        assertContains(asm, '#428');
        assertContains(asm, '#64');
    });

    test('Explicit period and volume override the defaults', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0,0,214,32\n');
        assertContains(asm, '#214');
        assertContains(asm, '#32');
    });

    test('Loaded sample emits chip-RAM label and length expression', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + LOAD + 'PlaySample 0,0\n');
        assertContains(asm, 'lea     _snd_0,a0');
        assertContains(asm, '#(_snd_0_end-_snd_0)/2,d1');
    });

    test('Unloaded sample index throws', () => {
        const { compile } = makePipeline();
        assertThrows(
            () => compile(HDR + 'PlaySample 7,0\n'),
            'not loaded'
        );
    });

    test('Non-literal index throws', () => {
        const { compile } = makePipeline();
        assertThrows(
            () => compile(HDR + LOAD + 'i=0\nPlaySample i,0\n'),
            'integer literal'
        );
    });

    test('PlaySampleOnce no longer exists as a command', () => {
        const { compile } = makePipeline();
        // Lexer treats unknown identifiers as variables; codegen's command
        // dispatcher would throw "Unknown command" on the statement form.
        // Either way, it must not produce a working PlaySampleOnce call.
        let threw = false;
        try { compile(HDR + LOAD + 'PlaySampleOnce 0,0\n'); }
        catch (e) { threw = true; }
        if (!threw) {
            throw new Error('expected PlaySampleOnce to be removed, but compile succeeded');
        }
    });
});
