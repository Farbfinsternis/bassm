// ============================================================================
// test-m-data.js — Tests for M-DATA: 2D Arrays (Dim arr(w,h) / arr(x,y) read/write)
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { parse, compile } = makePipeline();

const HEADER = `Graphics 320,256,3\n`;

function findNode(src, type) {
    return parse(HEADER + src).find(s => s && s.type === type);
}

function compileWith(src) {
    return compile(HEADER + src);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: Dim arr(w,h) produces a dim2d node', () => {
    const node = findNode('Dim map(19, 14)', 'dim2d');
    assertEqual(node.type, 'dim2d');
});

test('Parser: dim2d captures name', () => {
    const node = findNode('Dim map(19, 14)', 'dim2d');
    assertEqual(node.name, 'map');
});

test('Parser: dim2d captures sizeW', () => {
    const node = findNode('Dim map(19, 14)', 'dim2d');
    assertEqual(node.sizeW.value, 19);
});

test('Parser: dim2d captures sizeH', () => {
    const node = findNode('Dim map(19, 14)', 'dim2d');
    assertEqual(node.sizeH.value, 14);
});

test('Parser: dim2d does not affect 1D Dim', () => {
    const node = findNode('Dim arr(7)', 'dim');
    assertEqual(node.type, 'dim');
    assertEqual(node.name, 'arr');
    assertEqual(node.size.value, 7);
});

test('Parser: arr(x,y) = expr produces array2d_assign', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array2d_assign');
    assert(node !== undefined, 'expected array2d_assign node');
});

test('Parser: array2d_assign captures name', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array2d_assign');
    assertEqual(node.name, 'map');
});

test('Parser: array2d_assign captures indexX', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array2d_assign');
    assertEqual(node.indexX.value, 3);
});

test('Parser: array2d_assign captures indexY', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array2d_assign');
    assertEqual(node.indexY.value, 2);
});

test('Parser: 1D array_assign unchanged (still uses index not indexX/Y)', () => {
    const stmts = parse(HEADER + 'Dim arr(7)\narr(3) = 9');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assertEqual(node.name, 'arr');
    assertEqual(node.index.value, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — BSS
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Dim(w,h) allocates (w+1)*(h+1) longs in BSS', () => {
    const asm = compileWith('Dim map(19, 14)');
    // 20*15 = 300 entries
    assertContains(asm, 'ds.l    300');
});

test('CodeGen: Dim(0,0) allocates 1 long', () => {
    const asm = compileWith('Dim t(0, 0)');
    assertContains(asm, 'ds.l    1');
});

test('CodeGen: Dim(4,3) allocates 20 longs', () => {
    const asm = compileWith('Dim g(4, 3)');
    // 5*4 = 20
    assertContains(asm, 'ds.l    20');
});

test('CodeGen: 2D array label is _arr_name', () => {
    const asm = compileWith('Dim map(9, 9)');
    assertContains(asm, '_arr_map:');
});

test('CodeGen: 1D Dim still works alongside 2D Dim', () => {
    const asm = compileWith('Dim a(7)\nDim b(3, 3)');
    assertContains(asm, '_arr_a:');
    assertContains(asm, '_arr_b:');
    assertContains(asm, 'ds.l    8');   // a: 8 longs
    assertContains(asm, 'ds.l    16');  // b: 4*4=16 longs
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — array2d_assign (write)
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: arr(x,y)=expr emits lea for array label', () => {
    const asm = compileWith('Dim map(19,14)\nmap(1, 2) = 42');
    assertContains(asm, 'lea     _arr_map,a0');
});

test('CodeGen: arr(x,y)=expr stores via (a0)', () => {
    const asm = compileWith('Dim map(19,14)\nmap(1, 2) = 42');
    assertContains(asm, 'move.l  (sp)+,(a0)');
});

test('CodeGen: arr(x,y)=expr shifts by 2 for longword offset', () => {
    const asm = compileWith('Dim map(19,14)\nmap(1, 2) = 42');
    assertContains(asm, 'asl.l   #2,d0');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — 2D array read
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: v = arr(x,y) emits lea for array label', () => {
    const asm = compileWith('Dim map(19,14)\nv = map(3, 1)');
    assertContains(asm, 'lea     _arr_map,a0');
});

test('CodeGen: v = arr(x,y) loads from (a0)', () => {
    const asm = compileWith('Dim map(19,14)\nv = map(3, 1)');
    assertContains(asm, 'move.l  (a0),d0');
});

// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION TEST — roundtrip write+read
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: 2D write + read compiles without error', () => {
    const asm = compileWith([
        'Dim map(19, 14)',
        'map(0, 0) = 1',
        'map(19, 14) = 99',
        'v = map(0, 0)',
        'w = map(x, y)',
    ].join('\n'));
    assertContains(asm, '_arr_map:');
    assertContains(asm, 'lea     _arr_map,a0');
});

test('CodeGen: 2D Dim does not emit code in _main_program', () => {
    const asm = compileWith('Dim map(5, 5)');
    // The Dim statement itself should produce no instructions — only BSS decl
    const mainIdx  = asm.indexOf('_main_program:');
    const bssIdx   = asm.indexOf('_arr_map:');
    assert(bssIdx >= 0,   '_arr_map BSS label must exist');
    assert(mainIdx >= 0,  '_main_program label must exist');
    // BSS section follows CODE section — _arr_map is after _main_program
    assert(bssIdx > mainIdx, '_arr_map must be in BSS section after _main_program');
    // No opcode-like lines (move/lea/add) between _main_program: and rts
    const mainBlock = asm.slice(mainIdx, asm.indexOf('rts', mainIdx) + 3);
    assert(!mainBlock.includes('lea     _arr_map'), 'Dim must not emit lea in main_program');
});

summary();
