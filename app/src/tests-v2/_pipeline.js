// ============================================================================
// tests-v2/_pipeline.js — Canonical compiler-pipeline factory for tests
// ============================================================================
//
// Single source of truth for both the v2 suite and the legacy tests/ suite
// (helpers.js re-exports from here). Reads commands-map.json + keywords-map.json
// at module-load time — the same JSONs the IDE and lexer consume at runtime.
//
// Exposes:
//   COMMANDS, KEYWORDS                — string lists derived from JSON
//   HDR                               — boilerplate Graphics statement for tests
//   makePipeline({ headerReader? })   — full pipeline; optional asset-header stub
//   makeIrawHeader(w, h, depth)       — build a 12-byte .iraw v2 header
//   makeBmapHeader(mw, mh, tw, th, p) — build a 24-byte .bmap v2 fixed header

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PreProcessor } from '../preprocessor.js';
import { Lexer }        from '../lexer.js';
import { Parser }       from '../parser.js';
import { CodeGen }      from '../codegen.js';

const _here     = dirname(fileURLToPath(import.meta.url));
const _readJSON = name => JSON.parse(readFileSync(resolve(_here, '..', name), 'utf8'));

export const COMMANDS = _readJSON('commands-map.json').map(c => c.name);
export const KEYWORDS = _readJSON('keywords-map.json');

export const HDR = 'Graphics 320,256,4\n';

/**
 * Build a fresh end-to-end pipeline. All four phases (preprocess → lex → parse
 * → codegen) get fresh instances on every call so tests can't leak state.
 *
 * @param {object}   [options]
 * @param {Function} [options.headerReader] — (filename, bytes) => {ok,data}|{ok:false,error}
 *                   Injected into the codegen for LoadImage/LoadTilemap/LoadTileset
 *                   asset-header parsing. Without it, asset-loading commands throw
 *                   "kein Projekt-Verzeichnis".
 * @returns {{tokenize, parse, compile, codegen}}
 */
export function makePipeline(options = {}) {
    const pre     = new PreProcessor();
    const lexer   = new Lexer(COMMANDS, KEYWORDS);
    const parser  = new Parser();
    const codegen = new CodeGen();
    if (options.headerReader) codegen.setAssetHeaderReader(options.headerReader);

    const process  = src => pre.process(src);
    const tokenize = src => lexer.tokenize(process(src));
    const parse    = src => parser.parse(tokenize(src));
    const compile  = src => codegen.generate(parse(src));
    return { tokenize, parse, compile, codegen };
}

/** Build a 12-byte .iraw v2 header for tests. */
export function makeIrawHeader(width, height, depth) {
    const rowbytes = Math.ceil(Math.ceil(width / 8) / 2) * 2;
    return [
        0x49, 0x52, 0x41, 0x57,                       // 'IRAW'
        (width  >> 8) & 0xFF, width  & 0xFF,
        (height >> 8) & 0xFF, height & 0xFF,
        (depth  >> 8) & 0xFF, depth  & 0xFF,
        (rowbytes >> 8) & 0xFF, rowbytes & 0xFF,
    ];
}

/** Build a 16-byte .bfnt header for tests (font-chain-fix M1-T10 layout). */
export function makeBfntHeader(charW, charH, charCount, flags = 0, tracking = 1, spaceW = 0) {
    return [
        0x42, 0x46, 0x4E, 0x54,                       // 'BFNT'
        (charW     >> 8) & 0xFF, charW     & 0xFF,
        (charH     >> 8) & 0xFF, charH     & 0xFF,
        (charCount >> 8) & 0xFF, charCount & 0xFF,
        flags & 0xFF,
        tracking & 0xFF,
        (spaceW >> 8) & 0xFF, spaceW & 0xFF,
        0, 0,                                          // reserved
    ];
}

/** Build a 24-byte .bmap v2 fixed header (no path bytes) for tests. */
export function makeBmapHeader(mapW, mapH, tileW, tileH, tilesetLen = 0) {
    return [
        0x42, 0x4D, 0x41, 0x50,                       // 'BMAP'
        0x00, 0x02,                                   // version
        0x00, 0x00,                                   // flags
        (mapW  >> 8) & 0xFF, mapW  & 0xFF,
        (mapH  >> 8) & 0xFF, mapH  & 0xFF,
        (tileW >> 8) & 0xFF, tileW & 0xFF,
        (tileH >> 8) & 0xFF, tileH & 0xFF,
        (tilesetLen >> 8) & 0xFF, tilesetLen & 0xFF,
        0, 0, 0, 0, 0, 0,                             // reserved
    ];
}

/**
 * Build a full .bmap v2 binary file (header + tileset path + optional pad +
 * row-major u16 BE indices). Indices default to 0..N-1 if omitted, useful
 * for round-trip tests where exact values don't matter.
 *
 * @returns {Uint8Array} full file content; size = 24 + tilesetLen + pad + mapW*mapH*2
 */
export function makeBmapFile({ mapW, mapH, tileW, tileH, tilesetPath = '', indices }) {
    const pathBytes  = new TextEncoder().encode(tilesetPath);
    const tilesetLen = pathBytes.length;
    const pad        = (tilesetLen & 1) ? 1 : 0;
    const cellCount  = mapW * mapH;
    if (!indices) indices = Array.from({ length: cellCount }, (_, i) => i & 0xFFFF);
    if (indices.length !== cellCount) {
        throw new Error(`makeBmapFile: indices length ${indices.length} ≠ ${mapW}×${mapH}=${cellCount}`);
    }

    const total = 24 + tilesetLen + pad + cellCount * 2;
    const buf   = new Uint8Array(total);

    buf.set(makeBmapHeader(mapW, mapH, tileW, tileH, tilesetLen), 0);
    buf.set(pathBytes, 24);
    // pad byte stays 0 (Uint8Array zero-init)

    const indicesOffset = 24 + tilesetLen + pad;
    for (let i = 0; i < cellCount; i++) {
        buf[indicesOffset + i * 2]     = (indices[i] >> 8) & 0xFF;
        buf[indicesOffset + i * 2 + 1] =  indices[i]       & 0xFF;
    }
    return buf;
}

/**
 * Build a headerReader that serves byte slices from a {filename: Uint8Array}
 * map. Codegen calls `reader(filename, n)` and gets the first n bytes.
 * Files not in the map return { ok: false }.
 */
export function makeAssetMapReader(files) {
    return (filename, bytes) => {
        const blob = files[filename];
        if (!blob) return { ok: false, error: 'file not found' };
        return { ok: true, data: Array.from(blob.slice(0, bytes)) };
    };
}
