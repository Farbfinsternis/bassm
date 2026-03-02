// ============================================================================
// test-m4-select.js — Tests for Milestone 4: Select / Case / Default
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { parse, compile } = makePipeline();

const HDR = 'Graphics 320,256,4\n';

// ── Parser ────────────────────────────────────────────────────────────────────

console.log('\nParser');

test('Select produces select node with expr', () => {
    const ast  = parse(HDR + 'x = 1\nSelect x\nEndSelect');
    const node = ast.find(s => s?.type === 'select');
    assert(node,               'No select node');
    assertEqual(node.expr.type, 'ident');
    assertEqual(node.expr.name, 'x');
    assertEqual(node.cases.length,  0);
    assertEqual(node.default.length, 0);
});

test('Single Case: values and body captured', () => {
    const ast  = parse(HDR + 'x = 1\nSelect x\nCase 1\nCls\nEndSelect');
    const node = ast.find(s => s?.type === 'select');
    assertEqual(node.cases.length,         1);
    assertEqual(node.cases[0].values.length, 1);
    assertEqual(node.cases[0].values[0].value, 1);
    assertEqual(node.cases[0].body.length,   1);
    assertEqual(node.cases[0].body[0].name, 'cls');
});

test('Multiple Cases each captured independently', () => {
    const src = [HDR, 'x = 1',
        'Select x',
        'Case 1', 'Cls',
        'Case 2', 'WaitVbl',
        'EndSelect',
    ].join('\n');
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.cases.length, 2);
    assertEqual(node.cases[0].body[0].name, 'cls');
    assertEqual(node.cases[1].body[0].name, 'waitvbl');
});

test('Case with multiple comma-separated values', () => {
    const src  = HDR + 'x = 1\nSelect x\nCase 1, 2, 3\nCls\nEndSelect';
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.cases[0].values.length, 3);
    assertEqual(node.cases[0].values[0].value, 1);
    assertEqual(node.cases[0].values[1].value, 2);
    assertEqual(node.cases[0].values[2].value, 3);
});

test('Default body captured', () => {
    const src = [HDR, 'x = 1',
        'Select x',
        'Case 1', 'Cls',
        'Default', 'WaitVbl',
        'EndSelect',
    ].join('\n');
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.default.length, 1);
    assertEqual(node.default[0].name, 'waitvbl');
});

test('Default-only Select (no Cases)', () => {
    const src  = HDR + 'x = 1\nSelect x\nDefault\nCls\nEndSelect';
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.cases.length,   0);
    assertEqual(node.default.length, 1);
});

test('Case body may contain assignments', () => {
    const src  = HDR + 'x = 1\nSelect x\nCase 1\ny = 42\nEndSelect';
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.cases[0].body[0].type,   'assign');
    assertEqual(node.cases[0].body[0].target, 'y');
});

test('Case body may contain If', () => {
    const src  = HDR + 'x = 1\nSelect x\nCase 1\nIf y = 2 Then Cls\nEndSelect';
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.cases[0].body[0].type, 'if');
});

test('Selector is an arbitrary expression', () => {
    const src  = HDR + 'x = 3\nSelect x * 2\nEndSelect';
    const node = parse(src).find(s => s?.type === 'select');
    assertEqual(node.expr.type, 'binop');
    assertEqual(node.expr.op,   '*');
});

test('Nested Select inside Case body', () => {
    const src = [HDR, 'x = 1',
        'Select x',
        'Case 1',
        '  Select x',
        '  Case 2', '    Cls',
        '  EndSelect',
        'EndSelect',
    ].join('\n');
    const outer = parse(src).find(s => s?.type === 'select');
    assert(outer,                                'No outer select');
    assertEqual(outer.cases[0].body[0].type,     'select');
    assertEqual(outer.cases[0].body[0].cases.length, 1);
});

// ── CodeGen ───────────────────────────────────────────────────────────────────

console.log('\nCodeGen');

test('Selector is pushed on stack and popped at end', () => {
    const asm = compile(HDR + 'x = 1\nSelect x\nEndSelect');
    assertContains(asm, 'move.l  d0,-(sp)');
    assertContains(asm, 'addq.l  #4,sp');
});

test('Literal Case generates optimised move.l (sp),d0 + cmp.l #n,d0', () => {
    const asm = compile(HDR + 'x = 1\nSelect x\nCase 5\nCls\nEndSelect');
    assertContains(asm, 'move.l  (sp),d0');
    assertContains(asm, 'cmp.l   #5,d0');
    assertContains(asm, 'beq.w');
});

test('Matching Case body is reachable (code present)', () => {
    const asm = compile(HDR + 'x = 1\nSelect x\nCase 1\nCls\nEndSelect');
    assertContains(asm, 'jsr     _Cls');
});

test('Multiple Cases: one beq.w per Case value', () => {
    const asm = compile([HDR, 'x = 1',
        'Select x',
        'Case 1', 'Cls',
        'Case 2', 'WaitVbl',
        'EndSelect',
    ].join('\n'));
    const beqCount = (asm.match(/beq\.w/g) ?? []).length;
    assert(beqCount >= 2, `Expected >=2 beq.w, got ${beqCount}`);
    assertContains(asm, 'jsr     _Cls');
    assertContains(asm, 'jsr     _WaitVBL');
});

test('Multiple Case values: one beq.w per value (Case 1, 2, 3)', () => {
    const asm = compile(HDR + 'x = 1\nSelect x\nCase 1, 2, 3\nCls\nEndSelect');
    const beqCount = (asm.match(/beq\.w/g) ?? []).length;
    assert(beqCount >= 3, `Expected >=3 beq.w for 3 values, got ${beqCount}`);
});

test('Default body is emitted after Case bodies', () => {
    const asm = compile([HDR, 'x = 1',
        'Select x',
        'Case 1', 'Cls',
        'Default', 'WaitVbl',
        'EndSelect',
    ].join('\n'));
    assertContains(asm, 'jsr     _Cls');
    assertContains(asm, 'jsr     _WaitVBL');
    // Default body must appear after Cls code
    assert(asm.indexOf('jsr     _WaitVBL') > asm.indexOf('jsr     _Cls'),
        'Default (_WaitVBL) should come after Case 1 (_Cls)');
});

test('No match falls through to Default via bra.w', () => {
    const asm = compile([HDR, 'x = 5',
        'Select x',
        'Case 1', 'Cls',
        'Default', 'WaitVbl',
        'EndSelect',
    ].join('\n'));
    // Must have a bra.w for the "no match" path
    assertContains(asm, 'bra.w');
});

test('Case bodies each end with bra.w to skip remaining bodies', () => {
    const asm = compile([HDR, 'x = 1',
        'Select x',
        'Case 1', 'Cls',
        'Case 2', 'WaitVbl',
        'EndSelect',
    ].join('\n'));
    const braCount = (asm.match(/bra\.w/g) ?? []).length;
    // At least: 1 bra.w (no-match) + 2 case body exits = 3
    assert(braCount >= 3, `Expected >=3 bra.w, got ${braCount}`);
});

test('Variable as Case value uses general comparison sequence', () => {
    const asm = compile(HDR + 'x = 1\nv = 1\nSelect x\nCase v\nCls\nEndSelect');
    assertContains(asm, 'move.l  4(sp),d0');
    assertContains(asm, 'move.l  (sp)+,d1');
    assertContains(asm, 'cmp.l   d1,d0');
});

// ── Summary ───────────────────────────────────────────────────────────────────

summary('M4 Select / Case / Default');
