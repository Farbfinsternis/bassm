// ============================================================================
// sprint1-loadimage.test.js — Regeltests für M1-T03 / M1-T04
// ============================================================================
// LoadImage signature is now `LoadImage index, "file.iraw"` (2 args).
// width/height are read from the .iraw v2 12-byte header.

import { describe, test, assertContains, assertThrows } from './_runner.js';
import { makePipeline, makeIrawHeader, HDR } from './_pipeline.js';

// ── Stub asset-header reader: serves a v2 IRAW header for "good.iraw" and a
//    legacy v1 (no magic) blob for "legacy.iraw"; everything else fails.
function makeStubReader() {
    return (filename, bytes) => {
        if (filename === 'good.iraw') {
            return { ok: true, data: makeIrawHeader(64, 32, 4).slice(0, bytes) };
        }
        if (filename === 'legacy.iraw') {
            // Old format: starts with palette bytes (no magic)
            return { ok: true, data: [0x00, 0x00, 0x0F, 0xFF, 0x00, 0xF0, 0x0F, 0x00, 0xFF, 0x00, 0x00, 0xFF].slice(0, bytes) };
        }
        return { ok: false, error: 'file not found' };
    };
}

describe('Sprint-1 / M1-T03 — LoadImage 2-arg signature', () => {
    test('LoadImage 0,"good.iraw" registers the asset', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        const asm = compile(HDR + 'LoadImage 0,"good.iraw"\n');
        assertContains(asm, 'INCBIN  "good.iraw",12');   // skips v2 header
        assertContains(asm, 'dc.w    64,32');             // width/height from header
    });

    test('LoadImage with 4 args (legacy w,h) throws migration hint', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        assertThrows(
            () => compile(HDR + 'LoadImage 0,"good.iraw",16,16\n'),
            'width/height entfallen'
        );
    });

    test('LoadImage with non-.iraw extension throws', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        assertThrows(
            () => compile(HDR + 'LoadImage 0,"bad.raw"\n'),
            'nur .iraw-Dateien werden unterstützt'
        );
    });

    test('LoadImage on legacy v1 .iraw (missing IRAW magic) throws migration hint', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        assertThrows(
            () => compile(HDR + 'LoadImage 0,"legacy.iraw"\n'),
            'legacy v1'
        );
    });

    test('LoadImage without project-dir (no headerReader) throws clear error', () => {
        const { compile } = makePipeline();    // no headerReader → simulate "no project"
        assertThrows(
            () => compile(HDR + 'LoadImage 0,"good.iraw"\n'),
            'kein Projekt-Verzeichnis'
        );
    });

    test('LoadImage with non-integer index throws', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        assertThrows(
            () => compile(HDR + 'LoadImage "x","good.iraw"\n'),
            'Integer-Literal'
        );
    });
});

describe('Sprint-1 / M1-T04 — Asset registration enables DrawImage', () => {
    test('LoadImage then DrawImage compiles without "not loaded"', () => {
        const { compile } = makePipeline({ headerReader: makeStubReader() });
        const asm = compile(HDR + 'LoadImage 0,"good.iraw"\nDrawImage 0,10,20\n');
        assertContains(asm, '_img_0');             // asset label was emitted
        assertContains(asm, 'INCBIN  "good.iraw",12');
    });
});
