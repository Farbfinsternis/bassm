// ============================================================================
// test-m1-variables.js — Tests for Milestone 1: Integer Variables & Expressions
// ============================================================================

import { test, assert, assertEqual, assertContains, summary } from './runner.js';
import { makePipeline } from './helpers.js';

const { tokenize, parse, compile } = makePipeline();

// Every test program needs a Graphics statement to satisfy CodeGen.
const HDR = 'Graphics 320,256,4\n';

// ── Lexer ─────────────────────────────────────────────────────────────────────

console.log('\nLexer');

test('IDENT = INT emits IDENT, EQ, INT tokens', () => {
    const toks = tokenize('x = 42').filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
    assertEqual(toks[0].type,  'IDENT');
    assertEqual(toks[0].value, 'x');
    assertEqual(toks[1].type,  'EQ');
    assertEqual(toks[2].type,  'INT');
    assertEqual(toks[2].value, 42);
});

test('Hex literal $1A tokenises to INT 26', () => {
    const toks = tokenize('$1A').filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
    assertEqual(toks[0].type,  'INT');
    assertEqual(toks[0].value, 26);
});

test('Binary literal %1010 tokenises to INT 10', () => {
    const toks = tokenize('%1010').filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
    assertEqual(toks[0].type,  'INT');
    assertEqual(toks[0].value, 10);
});

test('Arithmetic operator tokens: + * / -', () => {
    const toks = tokenize('a + b * c / d - e')
        .filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
    assertEqual(toks[1].type, 'PLUS');
    assertEqual(toks[3].type, 'STAR');
    assertEqual(toks[5].type, 'SLASH');
    assertEqual(toks[7].type, 'MINUS');
});

test('Comparison operator tokens: = <> < > <= >=', () => {
    const toks = tokenize('a = b <> c < d > e <= f >= g')
        .filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
    assertEqual(toks[1].type, 'EQ');
    assertEqual(toks[3].type, 'NEQ');
    assertEqual(toks[5].type, 'LT');
    assertEqual(toks[7].type, 'GT');
    assertEqual(toks[9].type, 'LTE');
    assertEqual(toks[11].type, 'GTE');
});

// ── Parser ────────────────────────────────────────────────────────────────────

console.log('\nParser');

test('Assignment: x = 5 produces assign node with int expr', () => {
    const ast = parse(HDR + 'x = 5');
    const a   = ast.find(s => s?.type === 'assign');
    assert(a, 'No assign node found');
    assertEqual(a.target,     'x');
    assertEqual(a.expr.type,  'int');
    assertEqual(a.expr.value, 5);
});

test('Assignment: unary minus folds to negative literal', () => {
    const ast = parse(HDR + 'x = -7');
    const a   = ast.find(s => s?.type === 'assign');
    assertEqual(a.expr.type,  'int');
    assertEqual(a.expr.value, -7);
});

test('Operator precedence: a + b * c has + as root', () => {
    const ast = parse(HDR + 'r = a + b * 3');
    const a   = ast.find(s => s?.type === 'assign');
    assertEqual(a.expr.type,        'binop');
    assertEqual(a.expr.op,          '+');
    assertEqual(a.expr.right.type,  'binop');
    assertEqual(a.expr.right.op,    '*');
});

test('Operator precedence: parentheses override — (a + b) * c has * as root', () => {
    const ast = parse(HDR + 'r = (a + b) * 3');
    const a   = ast.find(s => s?.type === 'assign');
    assertEqual(a.expr.op,         '*');
    assertEqual(a.expr.left.type,  'binop');
    assertEqual(a.expr.left.op,    '+');
});

test('Comparison expression: x = 5 produces binop with op "="', () => {
    const ast = parse(HDR + 'r = x = 5');
    const a   = ast.find(s => s?.type === 'assign');
    assertEqual(a.expr.type, 'binop');
    assertEqual(a.expr.op,   '=');
});

test('Variable as command argument: Delay n', () => {
    const ast   = parse(HDR + 'n = 50\nDelay n');
    const delay = ast.find(s => s?.type === 'command' && s.name === 'delay');
    assert(delay, 'No Delay command');
    assertEqual(delay.args[0].type, 'ident');
    assertEqual(delay.args[0].name, 'n');
});

test('Multiple variables collected across statements', () => {
    const ast   = parse(HDR + 'x = 1\ny = 2\nz = x + y');
    const names = ast.filter(s => s?.type === 'assign').map(s => s.target);
    assert(names.includes('x'), 'x missing');
    assert(names.includes('y'), 'y missing');
    assert(names.includes('z'), 'z missing');
});

// ── CodeGen ───────────────────────────────────────────────────────────────────

console.log('\nCodeGen');

test('BSS section "user_vars" emitted when variables are used', () => {
    const asm = compile(HDR + 'x = 5');
    assertContains(asm, 'user_vars,BSS');
    assertContains(asm, '_var_x:');
});

test('Small literal uses moveq; store with move.l d0,_var', () => {
    const asm = compile(HDR + 'x = 42');
    assertContains(asm, 'moveq   #42,d0');
    assertContains(asm, 'move.l  d0,_var_x');
});

test('Large literal uses move.l #n,d0', () => {
    const asm = compile(HDR + 'x = 1000');
    assertContains(asm, 'move.l  #1000,d0');
});

test('Load variable into d0', () => {
    const asm = compile(HDR + 'x = 5\ny = x');
    assertContains(asm, 'move.l  _var_x,d0');
});

test('Addition emits add.l d1,d0', () => {
    const asm = compile(HDR + 'x = 3\ny = x + 1');
    assertContains(asm, 'add.l   d1,d0');
});

test('Subtraction emits sub.l d1,d0', () => {
    const asm = compile(HDR + 'x = 10\ny = x - 3');
    assertContains(asm, 'sub.l   d1,d0');
});

test('Multiplication emits muls.w d1,d0', () => {
    const asm = compile(HDR + 'x = 3\ny = x * 4');
    assertContains(asm, 'muls.w  d1,d0');
});

test('Division emits divs.w + ext.l', () => {
    const asm = compile(HDR + 'x = 10\ny = x / 2');
    assertContains(asm, 'divs.w  d1,d0');
    assertContains(asm, 'ext.l   d0');
});

test('Equality comparison emits seq + ext.w + ext.l', () => {
    const asm = compile(HDR + 'x = 5\ny = x = 5');
    assertContains(asm, 'seq     d0');
    assertContains(asm, 'ext.w   d0');
    assertContains(asm, 'ext.l   d0');
});

test('"<>" comparison emits sne', () => {
    const asm = compile(HDR + 'x = 5\ny = x <> 3');
    assertContains(asm, 'sne     d0');
});

test('"<" comparison emits slt', () => {
    const asm = compile(HDR + 'x = 5\ny = x < 3');
    assertContains(asm, 'slt     d0');
});

test('">" comparison emits sgt', () => {
    const asm = compile(HDR + 'x = 5\ny = x > 3');
    assertContains(asm, 'sgt     d0');
});

test('Unary minus emits neg.l d0 for variable operand', () => {
    const asm = compile(HDR + 'x = 5\ny = -x');
    assertContains(asm, 'neg.l   d0');
});

// ── Summary ───────────────────────────────────────────────────────────────────

summary('M1 Integer Variables & Expressions');
