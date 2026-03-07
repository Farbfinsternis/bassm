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

test('Simple If emits cmp+Bcc + endif label (PERF-A)', () => {
    // x = 1, If x = 1 → PERF-A emits: cmp.l #1,d0 / bne.w endLbl
    const asm = compile(HDR + 'x = 1\nIf x = 1\nCls\nEndIf');
    assertContains(asm, 'cmp.l   #1,d0');
    assertContains(asm, 'bne.w');
    assertContains(asm, 'jsr     _Cls');
});

test('If/Else emits conditional branch, then body, bra.w, else body (PERF-A)', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',
        'Cls',
        'Else',
        'WaitVbl',
        'EndIf',
    ].join('\n'));
    // PERF-A: x = 1 condition → cmp.l #1,d0 / bne.w
    assertContains(asm, 'cmp.l   #1,d0');
    assertContains(asm, 'bne.w');
    assertContains(asm, 'bra.w');
    assertContains(asm, 'jsr     _Cls');
    assertContains(asm, 'jsr     _WaitVBL');
});

test('Single-line If Then emits cmp+Bcc (PERF-A)', () => {
    // x > 3 → PERF-A emits: cmp.l #3,d0 / ble.w (branch when NOT greater)
    const asm = compile(HDR + 'x = 5\nIf x > 3 Then Cls');
    assertContains(asm, 'cmp.l   #3,d0');
    assertContains(asm, 'ble.w');
    assertContains(asm, 'jsr     _Cls');
});

test('If/ElseIf/Else — correct branch count (PERF-A)', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',    'Cls',
        'ElseIf x = 2', 'WaitVbl',
        'Else',         'ClsColor 0',
        'EndIf',
    ].join('\n'));
    // PERF-A: x=1 → bne.w; x=2 → bne.w (two conditional branches total)
    const condBranchCount = (asm.match(/b(?:ne|eq|lt|gt|le|ge)\.w/g) ?? []).length;
    const braCount        = (asm.match(/bra\.w/g) ?? []).length;
    assert(condBranchCount >= 2, `Expected >=2 conditional branches, got ${condBranchCount}`);
    // then→endif: 1 bra.w; elseif→endif: 1 bra.w → total 2
    assert(braCount >= 2, `Expected >=2 bra.w, got ${braCount}`);
});

test('Variables inside If body appear in BSS', () => {
    const asm = compile(HDR + 'If 1\ny = 5\nEndIf');
    assertContains(asm, '_var_y:');
});

test('Nested If generates two sets of labels (PERF-A)', () => {
    const asm = compile([
        HDR,
        'x = 1',
        'If x = 1',
        '  If x = 2',
        '    Cls',
        '  EndIf',
        'EndIf',
    ].join('\n'));
    // PERF-A: x=1→bne.w, x=2→bne.w — two conditional branches
    const condBranchCount = (asm.match(/b(?:ne|eq|lt|gt|le|ge)\.w/g) ?? []).length;
    assert(condBranchCount >= 2, `Expected >=2 conditional branches for nested If, got ${condBranchCount}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

summary('M2 If/Else Control Flow');
