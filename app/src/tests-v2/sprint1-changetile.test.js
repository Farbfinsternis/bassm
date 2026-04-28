// ============================================================================
// sprint1-changetile.test.js — Regeltests für M1-T05
// ============================================================================
// ChangeTile must emit bounds-checks before the memory write so OOB
// (negative or >= map_pixel_dimension) becomes a no-op instead of
// trashing arbitrary memory.

import { describe, test, assertContains, assertThrows } from './_runner.js';
import { makePipeline, makeBmapHeader, HDR } from './_pipeline.js';

// ChangeTile in isolation needs no tilemap — codegen just emits the bounds-check
// + indexed write referencing _active_tilemap_ptr. Linking happens later.
const PROG = HDR + 'ChangeTile 8,16,3\n';

describe('Sprint-1 / M1-T05 — ChangeTile bounds-check ASM', () => {
    test('Negative-x guard: tst.l d0 + bmi to skip', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'tst.l   d0');
        assertContains(asm, 'bmi     ');           // skip-on-negative
    });

    test('Negative-y guard: tst.l d1', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'tst.l   d1');
    });

    test('Upper-bound x guard: mulu.w 4(a0),d3 + cmp.l d3,d0 + bcc skip', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'mulu.w  4(a0),d3');   // map_w * tile_w
        assertContains(asm, 'cmp.l   d3,d0');
        assertContains(asm, 'bcc     ');
    });

    test('Upper-bound y guard: mulu.w 6(a0),d3 + cmp.l d3,d1', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'mulu.w  6(a0),d3');   // map_h * tile_h
        assertContains(asm, 'cmp.l   d3,d1');
    });

    test('tile_w and tile_h are read separately (not assumed equal)', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'move.w  4(a0),d3');   // tile_w
        assertContains(asm, 'move.w  6(a0),d3');   // tile_h
    });

    test('Bounds-check skip label is reachable from bcc', () => {
        const { compile } = makePipeline();
        const asm = compile(PROG);
        assertContains(asm, 'move.w  d2,8(a0,d1.l)');
        // The skip label is generated via _nextLabel() — format is .Ln (local label)
        const skipLabelMatch = asm.match(/bcc\s+(\.L\d+)/);
        if (!skipLabelMatch) {
            const tail = asm.slice(asm.indexOf('ChangeTile') > -1 ? asm.indexOf('ChangeTile') : asm.length - 800);
            throw new Error(`expected bcc to a .L label, tail:\n${tail}`);
        }
    });

    test('ChangeTile with fewer than 3 args throws', () => {
        const { compile } = makePipeline();
        assertThrows(
            () => compile(HDR + 'ChangeTile 8,16\n'),
            'requires 3 arguments'
        );
    });
});
