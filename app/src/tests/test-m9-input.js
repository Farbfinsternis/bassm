// ============================================================================
// test-m9-input.js — Tests for Milestone 9 (Input): WaitKey
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { tokenize, parse, compile } = makePipeline();

const HEADER = `Graphics 320,256,3\n`;

function compileWith(src) {
    return compile(HEADER + src);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: WaitKey produces command node with name "waitkey"', () => {
    const ast  = parse(HEADER + 'WaitKey');
    const node = ast.find(s => s && s.type === 'command' && s.name === 'waitkey');
    assertEqual(node.type,  'command');
    assertEqual(node.name,  'waitkey');
});

test('Parser: WaitKey has exactly 0 args', () => {
    const ast  = parse(HEADER + 'WaitKey');
    const node = ast.find(s => s && s.type === 'command' && s.name === 'waitkey');
    assertEqual(node.args.length, 0);
});

test('Parser: WaitKey can appear before and after other commands', () => {
    const ast = parse(HEADER + 'Cls\nWaitKey\nEnd');
    const wk  = ast.find(s => s && s.type === 'command' && s.name === 'waitkey');
    assertEqual(wk.name, 'waitkey');
});

test('Parser: WaitKey inside a While loop is parsed correctly', () => {
    const ast  = parse(HEADER + 'While 1\n  WaitKey\nWend');
    const wh   = ast.find(s => s && s.type === 'while');
    const wk   = wh.body.find(s => s && s.type === 'command' && s.name === 'waitkey');
    assertEqual(wk.name, 'waitkey');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: WaitKey emits jsr _WaitKey', () => {
    const asm = compileWith('WaitKey');
    assertContains(asm, 'jsr     _WaitKey');
});

test('CodeGen: WaitKey INCLUDE for waitkey.s present', () => {
    const asm = compileWith('WaitKey');
    assertContains(asm, 'INCLUDE "waitkey.s"');
});

test('CodeGen: WaitKey generates no extra instructions (single jsr)', () => {
    const asm   = compileWith('WaitKey');
    const lines = asm.split('\n').filter(l => l.includes('_WaitKey'));
    // Should appear exactly once (the jsr) — the INCLUDE line is separate
    const jsrLines = lines.filter(l => l.includes('jsr'));
    assertEqual(jsrLines.length, 1);
});

test('CodeGen: two WaitKey calls generate two jsr _WaitKey instructions', () => {
    const asm = compileWith('WaitKey\nWaitKey');
    const count = (asm.match(/jsr\s+_WaitKey/g) || []).length;
    assertEqual(count, 2);
});

test('CodeGen: WaitKey after drawing commands compiles without error', () => {
    const asm = compileWith('Color 1\nBox 10,10,100,80\nWaitKey\nEnd');
    assertContains(asm, 'jsr     _WaitKey');
    assertContains(asm, 'jsr     _Box');
});

test('CodeGen: WaitKey inside If block compiles without error', () => {
    const asm = compileWith('If 1\n  WaitKey\nEndIf');
    assertContains(asm, 'jsr     _WaitKey');
});

// ─────────────────────────────────────────────────────────────────────────────

summary('M9 Input (WaitKey)');
