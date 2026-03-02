// ============================================================================
// test-m2-if.js — Tests for Milestone 2: If / ElseIf / Else / EndIf
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { parse, compile } = makePipeline();

const HDR = 'Graphics 320,256,4\n';

// ── Parser ────────────────────────────────────────────────────────────────────

console.log('\nParser');

test('Single-line: If 1 Then Cls', () => {
    const ast    = parse(HDR + 'If 1 Then Cls');
    const ifNode = ast.find(s => s?.type === 'if');
    assert(ifNode,                      'No if node');
    assertEqual(ifNode.then.length,     1);
    assertEqual(ifNode.then[0].name,    'cls');
    assertEqual(ifNode.elseIfs.length,  0);
    assertEqual(ifNode.else.length,     0);
});

test('Block If/EndIf — then body collected', () => {
    const ast    = parse(HDR + 'If x = 1\nCls\nEndIf');
    const ifNode = ast.find(s => s?.type === 'if');
    assert(ifNode,                   'No if node');
    assertEqual(ifNode.then.length,  1);
    assertEqual(ifNode.then[0].name, 'cls');
    assertEqual(ifNode.else.length,  0);
});

test('Block If/Else/EndIf — else body collected', () => {
    const ast    = parse(HDR + 'If x = 1\nCls\nElse\nWaitVbl\nEndIf');
    const ifNode = ast.find(s => s?.type === 'if');
    assert(ifNode,                    'No if node');
    assertEqual(ifNode.then.length,   1);
    assertEqual(ifNode.else.length,   1);
    assertEqual(ifNode.else[0].name,  'waitvbl');
});

test('If/ElseIf/Else/EndIf — all branches present', () => {
    const src = [
        HDR,
        'If x = 1',
        'Cls',
        'ElseIf x = 2',
        'WaitVbl',
        'Else',
        'ClsColor 0',
        'EndIf',
    ].join('\n');
    const ast    = parse(src);
    const ifNode = ast.find(s => s?.type === 'if');
    assert(ifNode,                               'No if node');
    assertEqual(ifNode.elseIfs.length,           1);
    assertEqual(ifNode.elseIfs[0].body.length,   1);
    assertEqual(ifNode.elseIfs[0].body[0].name,  'waitvbl');
    assertEqual(ifNode.else.length,              1);
    assertEqual(ifNode.else[0].name,             'clscolor');
});

test('If/ElseIf condition is captured as expression', () => {
    const src = HDR + 'If x = 1\nCls\nElseIf x = 2\nWaitVbl\nEndIf';
    const ast    = parse(src);
    const ifNode = ast.find(s => s?.type === 'if');
    const ei     = ifNode.elseIfs[0];
    assertEqual(ei.cond.type, 'binop');
    assertEqual(ei.cond.op,   '=');
});

test('Multiple ElseIf branches', () => {
    const src = [
        HDR,
        'If x = 1', 'Cls',
        'ElseIf x = 2', 'WaitVbl',
        'ElseIf x = 3', 'ClsColor 0',
        'EndIf',
    ].join('\n');
    const ast    = parse(src);
    const ifNode = ast.find(s => s?.type === 'if');
    assertEqual(ifNode.elseIfs.length, 2);
});

test('Nested If inside If body', () => {
    const src = [
        HDR,
        'If x = 1',
        '  If y = 2',
        '    Cls',
        '  EndIf',
        'EndIf',
    ].join('\n');
    const ast   = parse(src);
    const outer = ast.find(s => s?.type === 'if');
    assert(outer,                          'No outer if');
    assertEqual(outer.then.length,         1);
    assertEqual(outer.then[0].type,        'if');
    assertEqual(outer.then[0].then.length, 1);
    assertEqual(outer.then[0].then[0].name, 'cls');
});

test('If body may contain assignments', () => {
    const src    = HDR + 'If x = 1\ny = 5\nEndIf';
    const ast    = parse(src);
    const ifNode = ast.find(s => s?.type === 'if');
    assertEqual(ifNode.then.length,        1);
    assertEqual(ifNode.then[0].type,       'assign');
    assertEqual(ifNode.then[0].target,     'y');
});

// ── CodeGen ───────────────────────────────────────────────────────────────────

console.log('\nCodeGen');

test('Simple If emits tst.l + beq.w + endif label', () => {
    const asm = compile(HDR + 'x = 1\nIf x = 1\nCls\nEndIf');
    assertContains(asm, 'tst.l   d0');
    assertContains(asm, 'beq.w');
    assertContains(asm, 'jsr     _Cls');
});

test('If/Else emits beq.w, then body, bra.w, else body', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',
        'Cls',
        'Else',
        'WaitVbl',
        'EndIf',
    ].join('\n'));
    assertContains(asm, 'beq.w');
    assertContains(asm, 'bra.w');
    assertContains(asm, 'jsr     _Cls');
    assertContains(asm, 'jsr     _WaitVBL');
});

test('Single-line If Then produces valid tst + branch', () => {
    const asm = compile(HDR + 'x = 5\nIf x > 3 Then Cls');
    assertContains(asm, 'tst.l   d0');
    assertContains(asm, 'beq.w');
    assertContains(asm, 'jsr     _Cls');
});

test('If/ElseIf/Else — correct branch count', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',    'Cls',
        'ElseIf x = 2', 'WaitVbl',
        'Else',         'ClsColor 0',
        'EndIf',
    ].join('\n'));
    const beqCount = (asm.match(/beq\.w/g)  ?? []).length;
    const braCount = (asm.match(/bra\.w/g)  ?? []).length;
    // if-cond: 1 beq.w; elseif-cond: 1 beq.w → total 2
    assert(beqCount >= 2, `Expected >=2 beq.w, got ${beqCount}`);
    // then→endif: 1 bra.w; elseif→endif: 1 bra.w → total 2
    assert(braCount >= 2, `Expected >=2 bra.w, got ${braCount}`);
});

test('Variables inside If body appear in BSS', () => {
    const asm = compile(HDR + 'If 1\ny = 5\nEndIf');
    assertContains(asm, '_var_y:');
});

test('Nested If generates two sets of labels', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',
        '  If x = 2',
        '    Cls',
        '  EndIf',
        'EndIf',
    ].join('\n'));
    const beqCount = (asm.match(/beq\.w/g) ?? []).length;
    assert(beqCount >= 2, `Expected >=2 beq.w for nested If, got ${beqCount}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

summary('M2 If/Else Control Flow');
