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

let _projectDir   = null;
let _currentFile  = 'main.bassm';
let _projectFiles = [];

// ── Logging ───────────────────────────────────────────────────────────────────

function logLine(text, cls = '') {
    const el   = document.getElementById('console');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// ── Outliner ──────────────────────────────────────────────────────────────────

function buildOutline(source) {
    const RE = /^\s*Function\s+(\w+)(\s*\()?/i;
    return source.split('\n').flatMap((line, i) => {
        const m = RE.exec(line);
        return m ? [{ name: m[1], line: i + 1, type: m[2] ? 'fn' : 'proc' }] : [];
    });
}

function renderOutline(items) {
    const el = document.getElementById('outliner-content');
    el.innerHTML = '';
    for (const { name, line, type } of items) {
        const item = document.createElement('div');
        item.className = `outline-item ${type}`;
        item.textContent = name;
        item.title = `line ${line}`;
        item.addEventListener('click', () => {
            const ed = window._monacoEditor;
            if (!ed) return;
            ed.revealLineInCenter(line);
            ed.setPosition({ lineNumber: line, column: 1 });
            ed.focus();
        });
        el.appendChild(item);
    }
}

let _outlineTimer = null;
function scheduleOutlineUpdate() {
    clearTimeout(_outlineTimer);
    _outlineTimer = setTimeout(() => {
        const ed = window._monacoEditor;
        if (ed) renderOutline(buildOutline(ed.getValue()));
    }, 400);
}

// ── Project Tree ──────────────────────────────────────────────────────────────

function renderProjectTree() {
    const el = document.getElementById('project-tree-content');
    el.innerHTML = '';
    renderTreeNodes(_projectFiles, el, 0);
}

function renderTreeNodes(nodes, container, depth) {
    const indent = 8 + depth * 12;
    for (const node of nodes) {
        if (node.type === 'dir') {
            const hdr = document.createElement('div');
            hdr.className = 'tree-dir';
            hdr.style.paddingLeft = indent + 'px';
            hdr.textContent = '\u25BE ' + node.name;
            hdr.title = node.name;

            const body = document.createElement('div');
            renderTreeNodes(node.children, body, depth + 1);

            hdr.addEventListener('click', () => {
                const collapsed = body.style.display === 'none';
                body.style.display  = collapsed ? '' : 'none';
                hdr.textContent = (collapsed ? '\u25BE ' : '\u25B8 ') + node.name;
            });

            container.appendChild(hdr);
            container.appendChild(body);
        } else {
            const isBassm = node.name.endsWith('.bassm');
            const item = document.createElement('div');
            item.className = 'tree-item'
                + (node.path === _currentFile ? ' active'      : '')
                + (node.name === 'main.bassm' ? ' entry-point' : '')
                + (isBassm                    ? ''             : ' tree-asset');
            item.style.paddingLeft = indent + 'px';
            item.textContent = node.name;
            item.title = node.path;
            if (isBassm) item.addEventListener('click', () => loadProjectFile(node.path));
            container.appendChild(item);
        }
    }
}

async function loadProjectFile(filename) {
    if (!_projectDir) return;
    try {
        const source = await window.electronAPI.readFile({ projectDir: _projectDir, filename });
        _currentFile = filename;
        window._monacoEditor.setValue(source);
        renderProjectTree();
        renderOutline(buildOutline(source));
    } catch (err) {
        logLine(`Cannot open ${filename}: ${err.message}`, 'error');
    }
}

// ── Emulator view bounds ──────────────────────────────────────────────────────

function updateEmulatorBounds() {
    const el = document.getElementById('emulator-view');
    const r  = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
        window.electronAPI.emulator.setBounds({
            x: Math.round(r.left), y: Math.round(r.top),
            width: Math.round(r.width), height: Math.round(r.height),
        });
    }
}

new ResizeObserver(updateEmulatorBounds)
    .observe(document.getElementById('emulator-view'));

// ── Wait for Monaco, then wire up outline listener ───────────────────────────

(function pollForEditor() {
    if (window._monacoEditor) {
        window._monacoEditor.onDidChangeModelContent(scheduleOutlineUpdate);
        renderOutline(buildOutline(window._monacoEditor.getValue()));
    } else {
        setTimeout(pollForEditor, 50);
    }
})();

// ── BASSM compiler init ───────────────────────────────────────────────────────

bassm.init()
    .then(() => {
        window.bassm = bassm;

        const btnRun      = document.getElementById('btn-run');
        const btnOpen     = document.getElementById('btn-open');
        const status      = document.getElementById('status');
        const projectName = document.getElementById('project-name');
        const console_    = document.getElementById('console');

        status.textContent = 'Ready';

        document.getElementById('btn-assets').addEventListener('click', () => {
            window.electronAPI.openAssetManager({ projectDir: _projectDir });
        });

        btnOpen.addEventListener('click', async () => {
            const result = await window.electronAPI.openProject();
            if (!result) return;
            _projectDir  = result.projectDir;
            _currentFile = 'main.bassm';
            projectName.textContent = result.projectName;
            window._monacoEditor.setValue(result.source);
            status.textContent = 'Ready';
            console_.innerHTML = '';
            _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
            renderProjectTree();
            renderOutline(buildOutline(result.source));
        });

        btnRun.addEventListener('click', async () => {
            const source = window._monacoEditor.getValue();
            console_.innerHTML = '';
            btnRun.disabled = true;
            status.textContent = 'Compiling…';

            // Auto-save current file before building
            if (_projectDir) {
                await window.electronAPI.saveSource({
                    projectDir: _projectDir,
                    filename:   _currentFile,
                    source,
                });
            }

            try {
                const { asm } = await bassm.run(source, _projectDir);
                logLine('── Generated assembly ──────────────────', 'info');
                logLine(asm);
                status.textContent = 'Running';
            } catch (err) {
                logLine(err.message, 'error');
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
