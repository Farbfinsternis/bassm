// ============================================================================
// sprint1-depth.test.js — Regeltests für M1-T01 / M1-T02
// ============================================================================
// Graphics depth must be in [1..5] (OCS without EHB/HAM). Depth 6+ throws.

import { describe, test, assertContains, assertThrows } from './_runner.js';
import { makePipeline } from './_pipeline.js';

const { compile } = makePipeline();

describe('Sprint-1 / M1-T01 — Graphics depth bound (1..5)', () => {
    for (const d of [1, 2, 3, 4, 5]) {
        test(`Graphics 320,256,${d} compiles successfully`, () => {
            const asm = compile(`Graphics 320,256,${d}\n`);
            assertContains(asm, `GFXDEPTH     EQU ${d}`);
        });
    }

    test('Graphics 320,256,6 throws "out of range"', () => {
        assertThrows(() => compile('Graphics 320,256,6\n'), 'out of range');
    });

    test('Graphics 320,256,7 throws "out of range"', () => {
        assertThrows(() => compile('Graphics 320,256,7\n'), 'out of range');
    });

    test('Graphics 320,256,0 throws "out of range"', () => {
        assertThrows(() => compile('Graphics 320,256,0\n'), 'out of range');
    });
});

describe('Sprint-1 / M1-T02 — Error message names range "1–5"', () => {
    test('Depth-6 error message contains "1–5 bitplanes"', () => {
        let msg = '';
        try { compile('Graphics 320,256,6\n'); } catch (e) { msg = e.message; }
        assertContains(msg, '1–5 bitplanes');
    });

    test('Depth-6 error message does NOT contain stale "1–6"', () => {
        let msg = '';
        try { compile('Graphics 320,256,6\n'); } catch (e) { msg = e.message; }
        if (msg.includes('1–6')) {
            throw new Error(`Error message still says "1–6": ${msg}`);
        }
    });
});
