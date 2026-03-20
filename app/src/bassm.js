/*
    BASSM — Blitz2D to m68k Assembler
    Blitz2D Source → PreProcessor → Lexer → Parser → CodeGen → m68k Assembly
    → vasmm68k_mot (via Electron IPC) → Amiga HUNK binary → vAmigaWeb preview
*/

import { PreProcessor } from './preprocessor.js';
import { Lexer }        from './lexer.js';
import { Parser }       from './parser.js';
import { CodeGen }      from './codegen.js';
import { Peephole }     from './peephole.js';
import { analyzeBudget } from './budget.js';

class BASSM {

    constructor() {
        this._preProcessor = new PreProcessor();
        this._parser       = new Parser();
        this._codegen      = new CodeGen();
        this._peephole     = new Peephole();
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

        return this._peephole.optimize(asm);
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
        const asm        = this.compile(expanded);
        const assetFiles = this._codegen.getAssetRefs();
        const fontAssets = this._codegen.getFontAssets();

        // 2. Assemble with vasmm68k_mot via Electron IPC
        const result = await window.electronAPI.assemble({ asm, assetFiles, fontAssets, projectDir });
        if (!result.ok) throw new Error(result.error);
        for (const w of (result.warnings || [])) logLine(`Warnung: ${w}`, 'warn');

        // 3. Send HUNK binary to emulator — triggers reset + boot from virtual disk
        window.electronAPI.emulator.send({ type: 'load-exe', data: result.data });

        return { asm, binary: result.data };
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const bassm = new BASSM();

let _projectDir   = null;
let _currentFile  = 'main.bassm';
let _projectFiles = [];
let _lastBinary   = null;   // cached from last successful build — used by F6

// ── Logging ───────────────────────────────────────────────────────────────────

function logLine(text, cls = '') {
    const el   = document.getElementById('console');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const ts = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Only prefix short single-line messages; leave ASM dumps etc. undecorated
    line.textContent = (text.length < 200 && !text.includes('\n')) ? `[${ts}] ${text}` : text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// ── Monaco error markers ───────────────────────────────────────────────────────

function _setErrorMarker(message) {
    const ed = window._monacoEditor;
    if (!ed || !window.monaco) return;
    const model = ed.getModel();
    if (!model) return;

    // Extract line number from messages like "(line 5)", "Zeile 5", "on line 5"
    const m = /(?:line|Zeile)\s+(\d+)/i.exec(message);
    const lineNumber = m ? parseInt(m[1]) : 1;
    const lineCount  = model.getLineCount();
    const safeeLine  = Math.min(Math.max(lineNumber, 1), lineCount);

    window.monaco.editor.setModelMarkers(model, 'bassm', [{
        startLineNumber: safeeLine,
        endLineNumber:   safeeLine,
        startColumn:     1,
        endColumn:       model.getLineMaxColumn(safeeLine),
        message,
        severity:        window.monaco.MarkerSeverity.Error,
    }]);
}

function _clearMarkers() {
    const ed = window._monacoEditor;
    if (!ed || !window.monaco) return;
    const model = ed.getModel();
    if (model) window.monaco.editor.setModelMarkers(model, 'bassm', []);
}

// ── Outliner ──────────────────────────────────────────────────────────────────

function buildOutline(source) {
    const items = [];
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ln   = i + 1;

        // Functions / Procedures
        let m = /^\s*Function\s+(\w+)(\s*\()?/i.exec(line);
        if (m) {
            items.push({ icon: m[2] ? 'ƒ' : '⊳', name: m[1], line: ln, type: m[2] ? 'fn' : 'proc' });
            continue;
        }

        // While loops — show truncated condition
        m = /^\s*While\s+(.+)/i.exec(line);
        if (m) {
            const cond = m[1].trim();
            items.push({ icon: '↻', name: cond.length > 20 ? cond.slice(0, 19) + '…' : cond, line: ln, type: 'loop' });
            continue;
        }

        // Repeat loops
        if (/^\s*Repeat\s*(?:;.*)?$/i.test(line)) {
            items.push({ icon: '↻', name: 'Repeat', line: ln, type: 'loop' });
            continue;
        }

        // LoadImage / LoadAnimImage → image asset
        m = /^\s*Load(?:Anim)?Image\s+(\d+)\s*,\s*"([^"]+)"/i.exec(line);
        if (m) {
            items.push({ icon: '▣', name: m[1] + '  ' + m[2].replace(/.*[\\/]/, ''), line: ln, type: 'asset-img' });
            continue;
        }

        // LoadSample → audio asset
        m = /^\s*LoadSample\s+(\d+)\s*,\s*"([^"]+)"/i.exec(line);
        if (m) {
            items.push({ icon: '♪', name: m[1] + '  ' + m[2].replace(/.*[\\/]/, ''), line: ln, type: 'asset-snd' });
            continue;
        }

        // LoadFont → font asset (file is 3rd arg, after index and chars string)
        m = /^\s*LoadFont\s+(\d+)\s*,\s*"[^"]*"\s*,\s*"([^"]+)"/i.exec(line);
        if (m) {
            items.push({ icon: 'A', name: m[1] + '  ' + m[2].replace(/.*[\\/]/, ''), line: ln, type: 'asset-fnt' });
            continue;
        }
    }

    return items;
}

function renderOutline(items) {
    const el = document.getElementById('outliner-content');
    el.innerHTML = '';
    for (const { icon, name, line, type } of items) {
        const item = document.createElement('div');
        item.className = `outline-item ${type}`;
        item.title = `Line ${line}`;

        const iSpan = document.createElement('span');
        iSpan.className = 'ol-icon';
        iSpan.textContent = icon;

        const nSpan = document.createElement('span');
        nSpan.textContent = '\u00a0\u00a0' + name;  // non-breaking spaces for indent

        item.appendChild(iSpan);
        item.appendChild(nSpan);

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
        if (ed) {
            renderOutline(buildOutline(ed.getValue()));
        }
    }, 400);
}

// ── Budget bars ───────────────────────────────────────────────────────────────

let _budgetTimer = null;
function scheduleBudgetUpdate() {
    clearTimeout(_budgetTimer);
    _budgetTimer = setTimeout(() => {
        const ed = window._monacoEditor;
        if (ed) renderBudget(analyzeBudget(ed.getValue()));
    }, 600);
}

function renderBudget(result) {
    const cpuTrack = document.getElementById('budget-cpu-track');
    const cpuFill  = document.getElementById('budget-cpu-fill');
    const cpuPct   = document.getElementById('budget-cpu-pct');
    const memTrack = document.getElementById('budget-mem-track');
    const memFill  = document.getElementById('budget-mem-fill');
    const memPct   = document.getElementById('budget-mem-pct');
    const hint     = document.getElementById('budget-hint');

    if (!result) {
        cpuTrack.className  = 'budget-track';
        cpuFill.style.width = '0%';
        cpuPct.textContent  = '—';   cpuPct.className = 'budget-pct';
        memTrack.className  = 'budget-track';
        memFill.style.width = '0%';
        memPct.textContent  = '—';   memPct.className = 'budget-pct';
        hint.textContent    = '';
        return;
    }

    const cpuRatio = result.cyclesUsed  / result.cyclesTotal;
    const memRatio = result.chipRamUsed / result.chipRamTotal;
    const cpuCls   = _budgetClass(cpuRatio);
    const memCls   = _budgetClass(memRatio);

    // Glow on track (outside overflow:hidden — not clipped)
    cpuTrack.className  = 'budget-track ' + cpuCls;
    cpuFill.style.width = Math.min(cpuRatio * 100, 100) + '%';
    cpuPct.textContent  = '~' + Math.round(cpuRatio * 100) + '%';
    cpuPct.className    = 'budget-pct ' + cpuCls;

    memTrack.className  = 'budget-track ' + memCls;
    memFill.style.width = Math.min(memRatio * 100, 100) + '%';
    memPct.textContent  = '~' + Math.round(memRatio * 100) + '%' + (result.chipRamPlus ? '+' : '');
    memPct.className    = 'budget-pct ' + memCls;

    const warnings = [];
    if (cpuRatio > 1.0) warnings.push('CPU overbudget');
    if (memRatio > 1.0) warnings.push('CHIP RAM voll');
    hint.textContent = warnings.join('  ');
}

function _budgetClass(ratio) {
    if (ratio < 0.65) return 'ok';
    if (ratio < 0.88) return 'warn';
    return 'crit';
}

// ── Context Menu ──────────────────────────────────────────────────────────────

let _ctxMenu = null;

function showContextMenu(x, y, items) {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const { label, action } of items) {
        const item = document.createElement('div');
        item.className   = 'ctx-item';
        item.textContent = label;
        item.addEventListener('click', e => {
            e.stopPropagation();
            menu.remove(); _ctxMenu = null;
            action();
        });
        menu.appendChild(item);
    }
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    document.body.appendChild(menu);
    _ctxMenu = menu;
    // Nudge inside viewport if it overflows
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
}

document.addEventListener('click',   () => { if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; } });
document.addEventListener('keydown',  e => { if (e.key === 'Escape' && _ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; } });

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
            const isPng   = node.name.toLowerCase().endsWith('.png');
            const item = document.createElement('div');
            item.className = 'tree-item'
                + (node.path === _currentFile ? ' active'      : '')
                + (node.name === 'main.bassm' ? ' entry-point' : '')
                + (isBassm ? '' : isPng ? ' tree-png' : ' tree-asset');
            item.style.paddingLeft = indent + 'px';
            item.textContent = node.name;
            item.title = node.path;
            if (isBassm) item.addEventListener('click', () => loadProjectFile(node.path));
            if (isPng) {
                item.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    showContextMenu(e.clientX, e.clientY, [{
                        label: 'Convert',
                        action: () => window.electronAPI.openAssetManager({
                            projectDir: _projectDir,
                            preloadFile: node.path,
                        }),
                    }]);
                });
            }
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

// ── Pane resizing ─────────────────────────────────────────────────────────────

const LEFT_MIN  = 120;  const LEFT_MAX  = 500;
const RIGHT_MIN = 240;  const RIGHT_MAX = 700;

function initPaneDivider(dividerId, panelId, side) {
    const divider = document.getElementById(dividerId);
    const panel   = document.getElementById(panelId);

    // Restore saved width
    const saved = localStorage.getItem('bassm-pane-' + side);
    if (saved) panel.style.width = saved + 'px';

    divider.addEventListener('mousedown', e => {
        e.preventDefault();
        const startX     = e.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        const min        = side === 'left' ? LEFT_MIN  : RIGHT_MIN;
        const max        = side === 'left' ? LEFT_MAX  : RIGHT_MAX;

        divider.classList.add('dragging');
        document.body.style.cursor     = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
            const delta    = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
            const newWidth = Math.min(max, Math.max(min, startWidth + delta));
            panel.style.width = newWidth + 'px';
            updateEmulatorBounds();
        }

        function onUp() {
            divider.classList.remove('dragging');
            document.body.style.cursor     = '';
            document.body.style.userSelect = '';
            localStorage.setItem('bassm-pane-' + side, parseInt(panel.style.width));
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

initPaneDivider('divider-left',  'left-panel',  'left');
initPaneDivider('divider-right', 'right-panel', 'right');

// ── Vertical pane resizing (tree/outliner + emulator/console) ─────────────────

const TREE_MIN    = 60;   const TREE_MAX    = 600;
const CONSOLE_MIN = 62;   const CONSOLE_MAX = 522;   // 22px for console-bar + content

function initPaneDividerH(dividerId, panelId, direction, min, max) {
    const divider = document.getElementById(dividerId);
    const panel   = document.getElementById(panelId);

    const saved = localStorage.getItem('bassm-pane-' + panelId);
    if (saved) panel.style.height = saved + 'px';

    divider.addEventListener('mousedown', e => {
        e.preventDefault();
        const startY      = e.clientY;
        const startHeight = panel.getBoundingClientRect().height;

        divider.classList.add('dragging');
        document.body.style.cursor     = 'row-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
            const delta     = direction === 'down' ? ev.clientY - startY : startY - ev.clientY;
            const newHeight = Math.min(max, Math.max(min, startHeight + delta));
            panel.style.height = newHeight + 'px';
            if (panelId === 'console-panel') updateEmulatorBounds();
        }

        function onUp() {
            divider.classList.remove('dragging');
            document.body.style.cursor     = '';
            document.body.style.userSelect = '';
            localStorage.setItem('bassm-pane-' + panelId, parseInt(panel.style.height));
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

// direction 'down' = panel is above divider (dragging down = taller)
// direction 'up'   = panel is below divider (dragging up = taller)
initPaneDividerH('divider-tree',    'project-tree', 'down', TREE_MIN,    TREE_MAX);
initPaneDividerH('divider-console', 'console-panel', 'up',   CONSOLE_MIN, CONSOLE_MAX);

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

// ── Emulator fullscreen toggle (F11 / ESC) ────────────────────────────────────

const _btnEmuFull = document.getElementById('btn-emulator-full');

function _toggleEmuFull() {
    const on = document.body.classList.toggle('emu-full');
    _btnEmuFull.classList.toggle('active', on);
    // ResizeObserver fires when #emulator-view changes size, but call
    // manually too in case the layout change happens before the observer.
    setTimeout(updateEmulatorBounds, 30);
}

_btnEmuFull.addEventListener('click', _toggleEmuFull);

document.addEventListener('keydown', async e => {
    if (e.key === 'F11') { e.preventDefault(); _toggleEmuFull(); return; }
    if (e.key === 'Escape' && document.body.classList.contains('emu-full')) { _toggleEmuFull(); return; }

    // F5 — Run (compile + run)
    if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('btn-run').click();
        return;
    }

    // F6 — Re-run last binary without recompiling
    if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (_lastBinary) {
            document.getElementById('status').textContent = 'Running';
            window.electronAPI.emulator.send({ type: 'load-exe', data: _lastBinary });
            logLine('Re-run (no recompile)', 'info');
        } else {
            logLine('Nothing to re-run — press F5 to compile first.', 'warn');
        }
        return;
    }

    // Ctrl+S / Cmd+S — Save current file
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.altKey) {
        e.preventDefault();
        const ed = window._monacoEditor;
        if (!ed || !_projectDir) return;
        try {
            await window.electronAPI.saveSource({
                projectDir: _projectDir,
                filename:   _currentFile,
                source:     ed.getValue(),
            });
            logLine('Saved.', 'info');
        } catch (err) {
            logLine('Save failed: ' + err.message, 'error');
        }
        return;
    }
}, true);  // capture phase — fires before Monaco's own keydown handlers

// ── Wait for Monaco, then wire up outline listener ───────────────────────────

(function pollForEditor() {
    if (window._monacoEditor) {
        window._monacoEditor.onDidChangeModelContent(() => {
            scheduleOutlineUpdate();
            scheduleBudgetUpdate();
        });
        const src = window._monacoEditor.getValue();
        renderOutline(buildOutline(src));
        renderBudget(analyzeBudget(src));
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
        const btnClear    = document.getElementById('btn-clear-console');
        const status      = document.getElementById('status');
        const projectName = document.getElementById('project-name');
        const console_    = document.getElementById('console');

        btnClear?.addEventListener('click', () => { console_.innerHTML = ''; });

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

        window.electronAPI.onFilesChanged(async () => {
            if (!_projectDir) return;
            _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
            renderProjectTree();
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
                const { asm, binary } = await bassm.run(source, _projectDir);
                _lastBinary = binary;
                _clearMarkers();

                // Save generated assembly next to the source file for code review
                if (_projectDir) {
                    const asmFile = _currentFile.replace(/\.bassm$/i, '.s');
                    await window.electronAPI.saveSource({
                        projectDir: _projectDir,
                        filename:   asmFile,
                        source:     asm,
                    });
                    const lineCount = asm.split('\n').length;
                    logLine(`Build OK — ${lineCount} lines  (ASM saved as ${asmFile})`, 'info');
                } else {
                    const lineCount = asm.split('\n').length;
                    logLine(`Build OK — ${lineCount} lines`, 'info');
                }

                status.textContent = 'Running';
            } catch (err) {
                _setErrorMarker(err.message);
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
