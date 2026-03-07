// ============================================================================
// test-m8-arrays.js — Tests for Milestone 8: Arrays (Dim / arr(i) / arr(i)=v)
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { tokenize, parse, compile } = makePipeline();

const HEADER = `Graphics 320,256,3\n`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findNode(src, type) {
    return parse(HEADER + src).find(s => s && s.type === type);
}

function compileWith(src) {
    return compile(HEADER + src);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS — Dim
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: Dim produces a dim node', () => {
    const node = findNode('Dim arr(7)', 'dim');
    assertEqual(node.type, 'dim');
});

test('Parser: Dim captures the array name (lowercased by lexer)', () => {
    const node = findNode('Dim myArr(3)', 'dim');
    assertEqual(node.name, 'myarr');
});

test('Parser: Dim captures the size as an int literal', () => {
    const node = findNode('Dim arr(10)', 'dim');
    assertEqual(node.size.type, 'int');
    assertEqual(node.size.value, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS — array_assign
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: array assign produces an array_assign node', () => {
    const node = findNode('Dim arr(3)\narr(0) = 42', 'array_assign');
    assertEqual(node.type, 'array_assign');
});

test('Parser: array_assign captures array name', () => {
    const node = findNode('Dim arr(3)\narr(1) = 5', 'array_assign');
    assertEqual(node.name, 'arr');
});

test('Parser: array_assign captures literal index', () => {
    const node = findNode('Dim arr(3)\narr(2) = 99', 'array_assign');
    assertEqual(node.index.type, 'int');
    assertEqual(node.index.value, 2);
});

test('Parser: array_assign captures literal value', () => {
    const node = findNode('Dim arr(3)\narr(0) = 77', 'array_assign');
    assertEqual(node.expr.type, 'int');
    assertEqual(node.expr.value, 77);
});

test('Parser: array_assign accepts variable index', () => {
    const node = findNode('Dim arr(7)\narr(i) = 1', 'array_assign');
    assertEqual(node.index.type, 'ident');
    assertEqual(node.index.name, 'i');
});

test('Parser: array_assign accepts expression as value', () => {
    const node = findNode('Dim arr(3)\narr(0) = x + 1', 'array_assign');
    assertEqual(node.expr.type, 'binop');
    assertEqual(node.expr.op, '+');
});

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS — array_read
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: array_read inside assignment RHS', () => {
    // x = arr(2) — x is a scalar assign, RHS is array_read
    const stmts = parse(HEADER + 'Dim arr(3)\nx = arr(2)');
    const assign = stmts.find(s => s && s.type === 'assign');
    assertEqual(assign.expr.type, 'array_read');
    assertEqual(assign.expr.name, 'arr');
    assertEqual(assign.expr.index.type, 'int');
    assertEqual(assign.expr.index.value, 2);
});

test('Parser: array_read in expression uses variable index', () => {
    const stmts = parse(HEADER + 'Dim arr(7)\nx = arr(i)');
    const assign = stmts.find(s => s && s.type === 'assign');
    assertEqual(assign.expr.type, 'array_read');
    assertEqual(assign.expr.index.type, 'ident');
    assertEqual(assign.expr.index.name, 'i');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — BSS declaration
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Dim declares array in BSS section', () => {
    const asm = compileWith('Dim arr(7)');
    assertContains(asm, '_arr_arr:');
});

test('CodeGen: Dim(n) allocates n+1 longs in BSS', () => {
    const asm = compileWith('Dim arr(7)');
    assertContains(asm, 'ds.l    8');
});

test('CodeGen: Dim(0) allocates 1 long in BSS', () => {
    const asm = compileWith('Dim arr(0)');
    assertContains(asm, 'ds.l    1');
});

test('CodeGen: multiple Dim declarations both appear in BSS', () => {
    const asm = compileWith('Dim bx(7)\nDim by(7)');
    assertContains(asm, '_arr_bx:');
    assertContains(asm, '_arr_by:');
});

test('CodeGen: Dim does not emit a scalar variable for the array name', () => {
    const asm = compileWith('Dim arr(3)');
    assert(!asm.includes('_var_arr:'), 'Array name must not appear as scalar _var_arr');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — array_assign
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: array assign emits index shift and lea', () => {
    const asm = compileWith('Dim arr(3)\narr(0) = 5');
    assertContains(asm, 'asl.l   #2,d0');
    assertContains(asm, 'lea     _arr_arr,a0');
    assertContains(asm, 'add.l   d0,a0');
});

test('CodeGen: array assign stores value via (a0)', () => {
    const asm = compileWith('Dim arr(3)\narr(0) = 5');
    assertContains(asm, 'move.l  (sp)+,(a0)');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — array_read
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: array read emits index shift, lea, and load from (a0)', () => {
    const asm = compileWith('Dim arr(3)\nx = arr(1)');
    assertContains(asm, 'asl.l   #2,d0');
    assertContains(asm, 'lea     _arr_arr,a0');
    assertContains(asm, 'move.l  (a0),d0');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — For loop with array (realistic usage)
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: For loop writing to array emits expected structure', () => {
    const src = [
        'Dim vals(4)',
        'For i = 0 To 4',
        '  vals(i) = i',
        'Next i',
    ].join('\n');
    const asm = compileWith(src);
    assertContains(asm, '_arr_vals:');
    assertContains(asm, 'asl.l   #2,d0');
    assertContains(asm, '_var_i:');
});

test('CodeGen: For loop reading from array emits expected structure', () => {
    const src = [
        'Dim vals(4)',
        'For i = 0 To 4',
        '  x = vals(i)',
        'Next i',
    ].join('\n');
    const asm = compileWith(src);
    assertContains(asm, '_arr_vals:');
    assertContains(asm, 'move.l  (a0),d0');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN TESTS — PERF-B: colon separator reaches arrays (integration)
// ─────────────────────────────────────────────────────────────────────────────

test('Colon separator: Dim and assign on same line', () => {
    const asm = compileWith('Dim arr(3) : arr(0) = 99');
    assertContains(asm, '_arr_arr:');
    assertContains(asm, 'move.l  (sp)+,(a0)');
});

// ─────────────────────────────────────────────────────────────────────────────

summary();
