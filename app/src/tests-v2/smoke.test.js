// ============================================================================
// smoke.test.js — Pipeline-up-and-running smoke check
// ============================================================================

import { describe, test, assert, assertContains, assertEqual } from './_runner.js';
import { makePipeline, HDR } from './_pipeline.js';

const { tokenize, parse, compile } = makePipeline();

describe('Smoke', () => {
    test('Lexer tokenises a trivial program', () => {
        const toks = tokenize(HDR + 'x = 42').filter(t => t.type !== 'NEWLINE' && t.type !== 'EOF');
        assert(toks.length > 0, 'expected some tokens');
    });

    test('Parser produces an AST', () => {
        const ast = parse(HDR + 'x = 42');
        assert(Array.isArray(ast), 'AST must be an array');
        assert(ast.length >= 2, `expected >= 2 statements (Graphics + assign), got ${ast.length}`);
    });

    test('CodeGen emits the program label and the user variable', () => {
        const asm = compile(HDR + 'x = 42');
        assertContains(asm, '_var_x:');
        assertContains(asm, '_main_program:');
    });

    test('CodeGen emits valid Graphics setup at depth 4', () => {
        const asm = compile(HDR);
        assertContains(asm, 'GFXDEPTH     EQU 4');
    });

    test('Empty body still compiles when Graphics is present', () => {
        const asm = compile('Graphics 320,200,3\n');
        assertContains(asm, '_main_program:');
        assertContains(asm, 'GFXDEPTH     EQU 3');
    });
});
