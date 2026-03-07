// ============================================================================
// test-m3-loops.js — Tests for Milestone 3: While / For loops
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { parse, compile } = makePipeline();

const HDR = 'Graphics 320,256,4\n';

// ── Parser: While ─────────────────────────────────────────────────────────────

console.log('\nParser — While');

test('While produces while node with cond and body', () => {
    const ast  = parse(HDR + 'While x < 10\nCls\nWend');
    const node = ast.find(s => s?.type === 'while');
    assert(node,                 'No while node');
    assertEqual(node.cond.type,  'binop');
    assertEqual(node.cond.op,    '<');
    assertEqual(node.body.length, 1);
    assertEqual(node.body[0].name, 'cls');
});

test('While body may be empty', () => {
    const ast  = parse(HDR + 'While 0\nWend');
    const node = ast.find(s => s?.type === 'while');
    assert(node, 'No while node');
    assertEqual(node.body.length, 0);
});

test('While body may contain assignments', () => {
    const ast  = parse(HDR + 'While 1\nx = x + 1\nWend');
    const node = ast.find(s => s?.type === 'while');
    assertEqual(node.body[0].type, 'assign');
});

test('While body may contain If', () => {
    const ast  = parse(HDR + 'While 1\nIf x = 5 Then Cls\nWend');
    const node = ast.find(s => s?.type === 'while');
    assertEqual(node.body[0].type, 'if');
});

test('Nested While inside While', () => {
    const src = [HDR, 'While 1', '  While 0', '    Cls', '  Wend', 'Wend'].join('\n');
    const ast   = parse(src);
    const outer = ast.find(s => s?.type === 'while');
    assert(outer,                          'No outer while');
    assertEqual(outer.body[0].type,        'while');
    assertEqual(outer.body[0].body[0].name, 'cls');
});

// ── Parser: For ───────────────────────────────────────────────────────────────

console.log('\nParser — For');

test('For produces for node: var, from, to, step=null', () => {
    const ast  = parse(HDR + 'For i = 1 To 10\nCls\nNext i');
    const node = ast.find(s => s?.type === 'for');
    assert(node,                   'No for node');
    assertEqual(node.var,          'i');
    assertEqual(node.from.value,   1);
    assertEqual(node.to.value,     10);
    assert(node.step === null,     'step should be null');
    assertEqual(node.body.length,  1);
    assertEqual(node.body[0].name, 'cls');
});

test('For with Step stores step expression', () => {
    const ast  = parse(HDR + 'For i = 10 To 1 Step -1\nNext i');
    const node = ast.find(s => s?.type === 'for');
    assert(node.step !== null, 'step should not be null');
    assertEqual(node.step.type,  'int');
    assertEqual(node.step.value, -1);
});

test('For with expression Step', () => {
    const ast  = parse(HDR + 's = 2\nFor i = 0 To 20 Step s\nNext i');
    const node = ast.find(s => s?.type === 'for');
    assertEqual(node.step.type, 'ident');
    assertEqual(node.step.name, 's');
});

test('For body may contain assignments and commands', () => {
    const ast  = parse(HDR + 'For i = 1 To 3\nx = i * 2\nCls\nNext i');
    const node = ast.find(s => s?.type === 'for');
    assertEqual(node.body.length, 2);
    assertEqual(node.body[0].type, 'assign');
    assertEqual(node.body[1].name, 'cls');
});

test('Nested For inside For', () => {
    const src = [HDR,
        'For i = 1 To 3',
        '  For j = 1 To 3',
        '    Cls',
        '  Next j',
        'Next i',
    ].join('\n');
    const ast   = parse(src);
    const outer = ast.find(s => s?.type === 'for');
    assert(outer,                           'No outer for');
    assertEqual(outer.body[0].type,         'for');
    assertEqual(outer.body[0].var,          'j');
    assertEqual(outer.body[0].body[0].name, 'cls');
});

test('For loop variable added to variable set', () => {
    const ast  = parse(HDR + 'For i = 1 To 10\nNext i');
    const node = ast.find(s => s?.type === 'for');
    assertEqual(node.var, 'i');
});

// ── CodeGen: While ─────────────────────────────────────────────────────────────

console.log('\nCodeGen — While');

test('While: emits loop label, cmp+Bcc, bra.w (PERF-A)', () => {
    // x < 10 → PERF-A: cmp.l #10,d0 / bge.w endLbl (branch when NOT less-than)
    const asm = compile(HDR + 'x = 0\nWhile x < 10\nx = x + 1\nWend');
    assertContains(asm, 'cmp.l   #10,d0');
    assertContains(asm, 'bge.w');
    assertContains(asm, 'bra.w');
});

test('While: body code is between condition check and bra.w', () => {
    const asm = compile(HDR + 'x = 1\nWhile x < 5\nCls\nWend');
    // jsr _Cls must appear before the final bra.w back to top
    const idxCls  = asm.indexOf('jsr     _Cls');
    const idxBra  = asm.lastIndexOf('bra.w');
    assert(idxCls !== -1, 'No _Cls in output');
    assert(idxBra !== -1, 'No bra.w in output');
    assert(idxCls < idxBra, '_Cls should appear before final bra.w');
});

test('While: no loop variable in BSS (only used vars)', () => {
    const asm = compile(HDR + 'x = 0\nWhile x < 3\nWend');
    assertContains(asm, '_var_x:');
});

// ── CodeGen: For ──────────────────────────────────────────────────────────────

console.log('\nCodeGen — For');

test('For: loop variable appears in BSS', () => {
    const asm = compile(HDR + 'For i = 1 To 5\nNext i');
    assertContains(asm, '_var_i:');
});

test('For (default step=1): emits bgt.w to exit, addq.l #1', () => {
    const asm = compile(HDR + 'For i = 1 To 10\nCls\nNext i');
    assertContains(asm, 'bgt.w');
    assertContains(asm, 'addq.l  #1,_var_i');
    assertContains(asm, 'bra.w');
});

test('For Step 2: emits bgt.w and addq.l #2', () => {
    const asm = compile(HDR + 'For i = 0 To 10 Step 2\nNext i');
    assertContains(asm, 'bgt.w');
    assertContains(asm, 'addq.l  #2,_var_i');
});

test('For Step -1: emits blt.w to exit, subq.l #1', () => {
    const asm = compile(HDR + 'For i = 10 To 1 Step -1\nNext i');
    assertContains(asm, 'blt.w');
    assertContains(asm, 'subq.l  #1,_var_i');
});

test('For Step large positive: uses move.l + add.l', () => {
    const asm = compile(HDR + 'For i = 0 To 1000 Step 100\nNext i');
    assertContains(asm, 'add.l   #100,d0');
    assertContains(asm, `move.l  d0,_var_i`);
});

test('For Step large negative: uses move.l + add.l with negative literal', () => {
    const asm = compile(HDR + 'For i = 1000 To 0 Step -100\nNext i');
    assertContains(asm, 'add.l   #-100,d0');
});

test('For with expression Step: emits runtime bmi.s direction check', () => {
    const asm = compile(HDR + 's = 1\nFor i = 1 To 10 Step s\nNext i');
    assertContains(asm, 'bmi.s');
    assertContains(asm, 'bgt.w');
    assertContains(asm, 'blt.w');
});

test('For body is placed between condition check and step increment', () => {
    const asm = compile(HDR + 'For i = 1 To 3\nCls\nNext i');
    const idxCls  = asm.indexOf('jsr     _Cls');
    const idxAdd  = asm.indexOf('addq.l  #1,_var_i');
    const idxBra  = asm.lastIndexOf('bra.w');
    assert(idxCls !== -1, 'No _Cls');
    assert(idxAdd !== -1, 'No addq.l');
    assert(idxCls < idxAdd, 'Body should be before step increment');
    assert(idxAdd < idxBra, 'Step should be before bra.w');
});

test('Nested For loops each get unique labels', () => {
    const asm = compile([HDR,
        'For i = 1 To 3',
        '  For j = 1 To 3',
        '    Cls',
        '  Next j',
        'Next i',
    ].join('\n'));
    const bgtCount = (asm.match(/bgt\.w/g) ?? []).length;
    assert(bgtCount >= 2, `Expected >=2 bgt.w for nested For, got ${bgtCount}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

summary('M3 Loops (While & For)');
