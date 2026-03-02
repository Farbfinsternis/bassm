// ============================================================================
// test-m5-drawing.js — Tests for Milestone 5: Plot / Line / Rect / Box
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { tokenize, parse, compile } = makePipeline();

const HEADER = `Graphics 320,256,3\n`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStmt(src) {
    return parse(HEADER + src).find(s => s && s.type === 'command' && s.name !== 'graphics');
}

function compileWith(src) {
    return compile(HEADER + src);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSER TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Parser: Plot produces command node with name "plot"', () => {
    const node = parseStmt('Plot 10,20');
    assertEqual(node.type, 'command');
    assertEqual(node.name, 'plot');
});

test('Parser: Plot has exactly 2 args', () => {
    const node = parseStmt('Plot 10,20');
    assertEqual(node.args.length, 2);
});

test('Parser: Plot args are correct literals (x=10, y=20)', () => {
    const node = parseStmt('Plot 10,20');
    assertEqual(node.args[0].type, 'int');
    assertEqual(node.args[0].value, 10);
    assertEqual(node.args[1].type, 'int');
    assertEqual(node.args[1].value, 20);
});

test('Parser: Plot accepts variable expressions as args', () => {
    const node = parseStmt('Plot px,py');
    assertEqual(node.args[0].type, 'ident');
    assertEqual(node.args[0].name, 'px');
    assertEqual(node.args[1].type, 'ident');
    assertEqual(node.args[1].name, 'py');
});

test('Parser: Line produces command node with name "line"', () => {
    const node = parseStmt('Line 0,0,319,255');
    assertEqual(node.type, 'command');
    assertEqual(node.name, 'line');
});

test('Parser: Line has exactly 4 args', () => {
    const node = parseStmt('Line 0,0,319,255');
    assertEqual(node.args.length, 4);
});

test('Parser: Line args are correct literals', () => {
    const node = parseStmt('Line 5,10,100,200');
    assertEqual(node.args[0].value, 5);
    assertEqual(node.args[1].value, 10);
    assertEqual(node.args[2].value, 100);
    assertEqual(node.args[3].value, 200);
});

test('Parser: Line accepts expression args', () => {
    const node = parseStmt('Line x1,y1,x2,y2');
    assertEqual(node.args[0].type, 'ident');
    assertEqual(node.args[1].type, 'ident');
    assertEqual(node.args[2].type, 'ident');
    assertEqual(node.args[3].type, 'ident');
});

test('Parser: Rect produces command node with name "rect"', () => {
    const node = parseStmt('Rect 10,10,100,80');
    assertEqual(node.type, 'command');
    assertEqual(node.name, 'rect');
});

test('Parser: Rect has exactly 4 args', () => {
    const node = parseStmt('Rect 10,10,100,80');
    assertEqual(node.args.length, 4);
});

test('Parser: Rect args are correct literals (x,y,w,h)', () => {
    const node = parseStmt('Rect 10,20,100,80');
    assertEqual(node.args[0].value, 10);
    assertEqual(node.args[1].value, 20);
    assertEqual(node.args[2].value, 100);
    assertEqual(node.args[3].value, 80);
});

test('Parser: Box produces command node with name "box"', () => {
    const node = parseStmt('Box 10,10,100,80');
    assertEqual(node.type, 'command');
    assertEqual(node.name, 'box');
});

test('Parser: Box has exactly 4 args', () => {
    const node = parseStmt('Box 10,10,100,80');
    assertEqual(node.args.length, 4);
});

test('Parser: Box args are correct literals (x,y,w,h)', () => {
    const node = parseStmt('Box 5,15,60,40');
    assertEqual(node.args[0].value, 5);
    assertEqual(node.args[1].value, 15);
    assertEqual(node.args[2].value, 60);
    assertEqual(node.args[3].value, 40);
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN — Plot
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Plot emits jsr _Plot', () => {
    const asm = compileWith('Plot 10,20');
    assertContains(asm, 'jsr     _Plot');
});

test('CodeGen: Plot evaluates y before x (y pushed first)', () => {
    const asm = compileWith('Plot 10,20');
    // y=20 is evaluated first, pushed; x=10 evaluated next
    const yIdx = asm.indexOf('moveq   #20,d0');
    const xIdx = asm.indexOf('moveq   #10,d0');
    assert(yIdx < xIdx, 'y arg should be evaluated before x arg');
});

test('CodeGen: Plot pops y into d1', () => {
    const asm = compileWith('Plot 10,20');
    assertContains(asm, 'move.l  (sp)+,d1');
});

test('CodeGen: Plot with variable args references _var_ names', () => {
    const asm = compileWith('px = 5\npy = 10\nPlot px,py');
    assertContains(asm, 'move.l  _var_px,d0');
    assertContains(asm, 'move.l  _var_py,d0');
    assertContains(asm, 'jsr     _Plot');
});

test('CodeGen: Plot INCLUDE for plot.s present', () => {
    const asm = compileWith('Plot 0,0');
    assertContains(asm, 'INCLUDE "plot.s"');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN — Line
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Line emits jsr _Line', () => {
    const asm = compileWith('Line 0,0,319,255');
    assertContains(asm, 'jsr     _Line');
});

test('CodeGen: Line uses movem.l (sp)+,d1-d3 to pop 3 args', () => {
    const asm = compileWith('Line 0,0,319,255');
    assertContains(asm, 'movem.l (sp)+,d1-d3');
});

test('CodeGen: Line evaluates y2 first (deepest on stack)', () => {
    const asm = compileWith('Line 1,2,3,4');
    // y2=4 should appear first in the output (pushed deepest)
    const y2Idx = asm.indexOf('moveq   #4,d0');
    const x1Idx = asm.lastIndexOf('moveq   #1,d0');
    assert(y2Idx < x1Idx, 'y2 arg should be evaluated before x1 arg');
});

test('CodeGen: Line INCLUDE for line.s present', () => {
    const asm = compileWith('Line 0,0,10,10');
    assertContains(asm, 'INCLUDE "line.s"');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN — Rect
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Rect emits jsr _Rect', () => {
    const asm = compileWith('Rect 10,10,100,80');
    assertContains(asm, 'jsr     _Rect');
});

test('CodeGen: Rect uses movem.l (sp)+,d1-d3 to pop 3 args', () => {
    const asm = compileWith('Rect 10,10,100,80');
    assertContains(asm, 'movem.l (sp)+,d1-d3');
});

test('CodeGen: Rect evaluates h first (deepest on stack)', () => {
    const asm = compileWith('Rect 1,2,3,4');
    // h=4 deepest, then w=3, then y=2, then x=1
    const hIdx = asm.indexOf('moveq   #4,d0');
    const xIdx = asm.lastIndexOf('moveq   #1,d0');
    assert(hIdx < xIdx, 'h arg should be evaluated before x arg');
});

test('CodeGen: Rect INCLUDE for rect.s present', () => {
    const asm = compileWith('Rect 0,0,10,10');
    assertContains(asm, 'INCLUDE "rect.s"');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN — Box
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: Box emits jsr _Box', () => {
    const asm = compileWith('Box 10,10,100,80');
    assertContains(asm, 'jsr     _Box');
});

test('CodeGen: Box uses movem.l (sp)+,d1-d3 to pop 3 args', () => {
    const asm = compileWith('Box 10,10,100,80');
    assertContains(asm, 'movem.l (sp)+,d1-d3');
});

test('CodeGen: Box evaluates h first (deepest on stack)', () => {
    const asm = compileWith('Box 1,2,3,4');
    const hIdx = asm.indexOf('moveq   #4,d0');
    const xIdx = asm.lastIndexOf('moveq   #1,d0');
    assert(hIdx < xIdx, 'h arg should be evaluated before x arg');
});

test('CodeGen: Box INCLUDE for box.s present', () => {
    const asm = compileWith('Box 0,0,10,10');
    assertContains(asm, 'INCLUDE "box.s"');
});

// ─────────────────────────────────────────────────────────────────────────────
//  CODEGEN — Combined / integration
// ─────────────────────────────────────────────────────────────────────────────

test('CodeGen: drawing commands inside a For loop compile without error', () => {
    const asm = compileWith(
        'For i = 0 To 10\n' +
        '  Plot i,i\n' +
        'Next'
    );
    assertContains(asm, 'jsr     _Plot');
    assertContains(asm, 'bra.w'); // For loop back-branch
});

test('CodeGen: multiple drawing commands generate in correct order', () => {
    const asm = compileWith(
        'Plot 1,1\n' +
        'Line 0,0,10,10\n' +
        'Rect 5,5,20,15\n' +
        'Box  5,5,20,15\n'
    );
    const plotIdx = asm.indexOf('jsr     _Plot');
    const lineIdx = asm.indexOf('jsr     _Line');
    const rectIdx = asm.indexOf('jsr     _Rect');
    const boxIdx  = asm.indexOf('jsr     _Box');
    assert(plotIdx < lineIdx, 'Plot before Line');
    assert(lineIdx < rectIdx, 'Line before Rect');
    assert(rectIdx < boxIdx,  'Rect before Box');
});

test('CodeGen: expression args in drawing commands evaluate correctly', () => {
    const asm = compileWith(
        'w = 100\n' +
        'h = 80\n' +
        'Box 10,10,w,h\n'
    );
    // w and h are variables, so they should load via move.l _var_
    assertContains(asm, 'move.l  _var_w,d0');
    assertContains(asm, 'move.l  _var_h,d0');
    assertContains(asm, 'jsr     _Box');
});

// ─────────────────────────────────────────────────────────────────────────────

summary('M5 Drawing Commands');
