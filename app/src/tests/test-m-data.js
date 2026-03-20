// ============================================================================
// test-m-data.js — Tests for M-DATA: N-dimensional Arrays (Dim arr(d0[,d1,...]) / arr(i0[,i1,...]))
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

test('Parser: Dim arr(w,h) produces a dim node with dims[2]', () => {
    const node = findNode('Dim map(19, 14)', 'dim');
    assertEqual(node.type, 'dim');
    assertEqual(node.dims.length, 2);
});

test('Parser: dim node captures name', () => {
    const node = findNode('Dim map(19, 14)', 'dim');
    assertEqual(node.name, 'map');
});

test('Parser: dim node captures dims[0] (width)', () => {
    const node = findNode('Dim map(19, 14)', 'dim');
    assertEqual(node.dims[0].value, 19);
});

test('Parser: dim node captures dims[1] (height)', () => {
    const node = findNode('Dim map(19, 14)', 'dim');
    assertEqual(node.dims[1].value, 14);
});

test('Parser: 1D Dim produces dim node with dims[1]', () => {
    const node = findNode('Dim arr(7)', 'dim');
    assertEqual(node.type, 'dim');
    assertEqual(node.name, 'arr');
    assertEqual(node.dims.length, 1);
    assertEqual(node.dims[0].value, 7);
});

test('Parser: 3D Dim produces dim node with dims[3]', () => {
    const node = findNode('Dim cube(3, 4, 5)', 'dim');
    assertEqual(node.dims.length, 3);
    assertEqual(node.dims[2].value, 5);
});

test('Parser: arr(x,y) = expr produces array_assign with indices[2]', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assert(node !== undefined, 'expected array_assign node');
    assertEqual(node.indices.length, 2);
});

test('Parser: array_assign captures name', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assertEqual(node.name, 'map');
});

test('Parser: array_assign captures indices[0]', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assertEqual(node.indices[0].value, 3);
});

test('Parser: array_assign captures indices[1]', () => {
    const stmts = parse(HEADER + 'Dim map(19,14)\nmap(3,2) = 1');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assertEqual(node.indices[1].value, 2);
});

test('Parser: 1D array_assign has indices[1]', () => {
    const stmts = parse(HEADER + 'Dim arr(7)\narr(3) = 9');
    const node = stmts.find(s => s && s.type === 'array_assign');
    assertEqual(node.name, 'arr');
    assertEqual(node.indices.length, 1);
    assertEqual(node.indices[0].value, 3);
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

test('CodeGen: 3D Dim allocates (d0+1)*(d1+1)*(d2+1) longs', () => {
    const asm = compileWith('Dim cube(3, 4, 5)');
    // 4*5*6 = 120
    assertContains(asm, 'ds.l    120');
});

test('CodeGen: 3D array write+read compiles without error', () => {
    const asm = compileWith([
        'Dim cube(3, 4, 5)',
        'cube(1, 2, 3) = 7',
        'v = cube(1, 2, 3)',
    ].join('\n'));
    assertContains(asm, '_arr_cube:');
    assertContains(asm, 'lea     _arr_cube,a0');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — array_assign (write)
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
