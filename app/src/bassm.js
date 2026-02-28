/*
    BASSM — Blitz2D to m68k Assembler
    Blitz2D Source → PreProcessor → Lexer → Parser → CodeGen → m68k Assembly
    → vasmm68k_mot (via Electron IPC) → Amiga HUNK binary → vAmigaWeb preview
*/

import { PreProcessor } from './preprocessor.js';
import { Lexer }        from './lexer.js';
import { Parser }       from './parser.js';
import { CodeGen }      from './codegen.js';

class BASSM {

    constructor() {
        this._preProcessor = new PreProcessor();
        this._parser       = new Parser();
        this._codegen      = new CodeGen();
        this._lexer        = null;  // created after async config load
    }

    // ── Initialise: load command/keyword tables from JSON ────────────────────

    async init() {
        const [commands, keywords] = await Promise.all([
            fetch('./src/commands-map.json').then(r => r.json()),
            fetch('./src/keywords-map.json').then(r => r.json()),
        ]);

        this._lexer = new Lexer(
            commands.map(c => c.name),  // e.g. ['Graphics', 'Cls', 'Color', …]
            keywords                    // e.g. ['If', 'Then', 'While', …]
        );

        return this;
    }

    // ── Main entry point ─────────────────────────────────────────────────────

    /**
     * Compile a Blitz2D source string to m68k assembly text.
     *
     * @param  {string} source  Raw Blitz2D program text
     * @returns {string}        Assembly source ready for vasmm68k_mot
     * @throws  {Error}         On syntax or semantic errors
     */
    compile(source) {
        if (!this._lexer) throw new Error('BASSM.init() must be awaited before compile()');

        const clean  = this._preProcessor.process(source);
        const tokens = this._lexer.tokenize(clean);
        const ast    = this._parser.parse(tokens);
        const asm    = this._codegen.generate(ast);

        return asm;
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Expose a single global instance for the UI layer and browser devtools.

const bassm = new BASSM();

bassm.init()
    .then(() => {
        window.bassm = bassm;
        console.log('[BASSM] Ready — try: bassm.compile("Graphics 320,256,5\\nCls")');
    })
    .catch(err => {
        console.error('[BASSM] Init failed:', err);
    });
