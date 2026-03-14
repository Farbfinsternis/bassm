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

    /**
     * Full pipeline: Blitz2D source → m68k asm → HUNK binary → emulator.
     *
     * @param  {string} source  Raw Blitz2D program text
     * @returns {{ asm: string }}   The generated assembly (for display)
     * @throws  {Error}             On compile or assemble error
     */
    async run(source, projectDir) {
        // 0. Expand Include directives (requires an open project folder)
        const readFile = projectDir
            ? (filename) => window.electronAPI.readFile({ projectDir, filename })
            : null;
        const expanded = await this._preProcessor.expandIncludes(source, { readFile });

        // 1. Blitz2D → m68k assembly
        const asm = this.compile(expanded);
        const assetFiles = this._codegen.getAssetRefs();

        // 2. Assemble with vasmm68k_mot via Electron IPC
        const result = await window.electronAPI.assemble({ asm, assetFiles, projectDir });
        if (!result.ok) throw new Error(result.error);

        // 3. Send HUNK binary to emulator — triggers reset + boot from virtual disk
        window.electronAPI.emulator.send({ type: 'load-exe', data: result.data });

        return { asm };
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const bassm = new BASSM();

let _projectDir = null;

bassm.init()
    .then(() => {
        window.bassm = bassm;

        const btnRun     = document.getElementById('btn-run');
        const btnOpen    = document.getElementById('btn-open');
        const status     = document.getElementById('status');
        const projectName = document.getElementById('project-name');
        const console_   = document.getElementById('console');

        status.textContent = 'Ready';

        function log(text, cls = '') {
            const line = document.createElement('div');
            if (cls) line.className = cls;
            line.textContent = text;
            console_.appendChild(line);
            console_.scrollTop = console_.scrollHeight;
        }

        btnOpen.addEventListener('click', async () => {
            const result = await window.electronAPI.openProject();
            if (!result) return;
            _projectDir = result.projectDir;
            projectName.textContent = result.projectName;
            window._monacoEditor.setValue(result.source);
            status.textContent = 'Ready';
            console_.innerHTML = '';
        });

        btnRun.addEventListener('click', async () => {
            const source = window._monacoEditor.getValue();
            console_.innerHTML = '';
            btnRun.disabled = true;
            status.textContent = 'Compiling…';

            // Auto-save to project file before building
            if (_projectDir) {
                await window.electronAPI.saveSource({ projectDir: _projectDir, source });
            }

            try {
                const { asm } = await bassm.run(source, _projectDir);
                log('── Generated assembly ──────────────────', 'info');
                log(asm);
                status.textContent = 'Running';
            } catch (err) {
                log(err.message, 'error');
                status.textContent = 'Error';
            } finally {
                btnRun.disabled = false;
            }
        });
    })
    .catch(err => {
        console.error('[BASSM] Init failed:', err);
        const s = document.getElementById('status');
        if (s) s.textContent = 'Init failed';
    });
