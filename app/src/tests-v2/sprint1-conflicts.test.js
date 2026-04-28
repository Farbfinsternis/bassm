// ============================================================================
// sprint1-conflicts.test.js — Regeltests für M1-T06 + S0-T04 (M1-T07)
// ============================================================================
// Inkompatible Feature-Kombis und unbekannte Commands schlagen jetzt zur
// Compile-Zeit fehl (vorher: silent warn / silent ignore).

import { describe, test, assertThrows } from './_runner.js';
import { makePipeline, HDR } from './_pipeline.js';

// Viewports must tile the full screen [0..GFXHEIGHT-1]. The simplest
// trigger for the conflict checks is a single VP covering [0..255].
const VP_FULL = 'SetViewport 0, 0, 255\n';

describe('Sprint-1 / M1-T06 — CopperColor + SetViewport throws', () => {
    test('CopperColor before SetViewport throws when both are present', () => {
        const { compile } = makePipeline();
        const src = HDR + 'CopperColor 100,15,15,15\n' + VP_FULL;
        assertThrows(() => compile(src), 'CopperColor is not compatible with SetViewport');
    });

    test('CopperColor alone (no SetViewport) compiles fine', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + 'CopperColor 100,15,15,15\n');
        if (!asm) throw new Error('expected ASM output');
    });

    test('SetViewport alone (no CopperColor) compiles fine', () => {
        const { compile } = makePipeline();
        const asm = compile(HDR + VP_FULL);
        if (!asm) throw new Error('expected ASM output');
    });
});

describe('Sprint-1 / M1-T06 — SetCamera in Viewport without scroll buffer throws', () => {
    test('SetCamera in non-scroll viewport throws "no scroll buffer"', () => {
        const { compile } = makePipeline();
        const src = HDR + VP_FULL + 'SetCamera 50, 50\n';
        assertThrows(() => compile(src), 'no scroll buffer');
    });

    test('Error message hints at SetTilemap', () => {
        const { compile } = makePipeline();
        const src = HDR + VP_FULL + 'SetCamera 50, 50\n';
        assertThrows(() => compile(src), 'Call SetTilemap');
    });
});

describe('Sprint-1 / S0-T04 (M1-T07) — Unknown command in dispatch throws', () => {
    test('Codegen with fake command stmt throws "Unknown command"', () => {
        const { codegen, compile } = makePipeline();
        compile(HDR);   // initialise _cmdHandlers via the normal entry point
        const fakeStmt = { type: 'command', name: 'TotallyFakeCommand', args: [], line: 42 };
        assertThrows(() => codegen._genStmt_command(fakeStmt, []), 'Unknown command');
    });

    test('Unknown-command error names the line and hints at _initCommandHandlers', () => {
        const { codegen, compile } = makePipeline();
        compile(HDR);
        const fakeStmt = { type: 'command', name: 'XyzFoobar', args: [], line: 99 };
        let msg = '';
        try { codegen._genStmt_command(fakeStmt, []); } catch (e) { msg = e.message; }
        if (!msg.includes('line 99')) throw new Error(`expected "line 99" in: ${msg}`);
        if (!msg.includes('_initCommandHandlers')) throw new Error(`expected "_initCommandHandlers" in: ${msg}`);
    });
});
