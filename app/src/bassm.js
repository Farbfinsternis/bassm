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
    for (const itemDef of items) {
        if (!itemDef) {
            const sep = document.createElement('div');
            sep.className = 'ctx-sep';
            menu.appendChild(sep);
            continue;
        }
        const { label, action } = itemDef;
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

// ── Drag & Drop state ─────────────────────────────────────────────────────────
let _dragSrcPath      = null;   // relative path of item being dragged
let _dragSrcType      = null;   // 'file' | 'dir'
let _currentDropTarget = null;  // element currently highlighted as drop target

function _setDropTarget(el) {
    if (_currentDropTarget === el) return;
    if (_currentDropTarget) _currentDropTarget.classList.remove('tree-drop-target');
    _currentDropTarget = el;
    if (el) el.classList.add('tree-drop-target');
}

function _isDragValid(destDir) {
    if (!_dragSrcPath) return false;
    // Same directory — already there
    const srcParent = _dragSrcPath.includes('/')
        ? _dragSrcPath.substring(0, _dragSrcPath.lastIndexOf('/')) : '';
    if (destDir === srcParent) return false;
    // Prevent moving a dir into itself or a descendant
    if (_dragSrcType === 'dir') {
        if (destDir === _dragSrcPath) return false;
        if (destDir.startsWith(_dragSrcPath + '/')) return false;
    }
    return true;
}

async function _moveItem(srcPath, destDir) {
    try {
        const newRelPath = await window.electronAPI.moveItem({ projectDir: _projectDir, srcPath, destDir });
        // Update _currentFile if the moved item is or contains it
        if (srcPath === _currentFile) {
            _currentFile = newRelPath;
        } else if (_dragSrcType === 'dir' && _currentFile.startsWith(srcPath + '/')) {
            _currentFile = newRelPath + '/' + _currentFile.substring(srcPath.length + 1);
        }
        _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
        renderProjectTree();
    } catch (err) {
        logLine(`Verschieben fehlgeschlagen: ${err.message}`, 'error');
    }
}

// Clean up on any drag end (drop, cancel, ESC)
document.addEventListener('dragend', () => { _dragSrcPath = null; _dragSrcType = null; _setDropTarget(null); });

// ── Collapse state ─────────────────────────────────────────────────────────────
// dir paths (relative to projectDir) that are currently collapsed
const _treeCollapsed = new Set();

function _loadTreeState() {
    if (!_projectDir) return;
    try {
        const key  = 'bassm-tree-collapsed:' + _projectDir;
        const data = JSON.parse(localStorage.getItem(key) || '[]');
        _treeCollapsed.clear();
        data.forEach(p => _treeCollapsed.add(p));
    } catch (_) {}
}

function _saveTreeState() {
    if (!_projectDir) return;
    const key = 'bassm-tree-collapsed:' + _projectDir;
    localStorage.setItem(key, JSON.stringify([..._treeCollapsed]));
}

function renderProjectTree() {
    const el = document.getElementById('project-tree-content');
    el.innerHTML = '';
    renderTreeNodes(_projectFiles, el, 0, '');
}

function renderTreeNodes(nodes, container, depth, parentPath) {
    const indent = 8 + depth * 14;
    for (const node of nodes) {
        if (node.type === 'dir') {
            const dirPath    = parentPath ? `${parentPath}/${node.name}` : node.name;
            const isCollapsed = _treeCollapsed.has(dirPath);

            const hdr = document.createElement('div');
            hdr.className = 'tree-dir';
            hdr.style.paddingLeft = indent + 'px';
            hdr.title = node.name;

            const iconSpan = document.createElement('span');
            iconSpan.className = isCollapsed
                ? 'tree-icon codicon codicon-folder'
                : 'tree-icon codicon codicon-folder-opened';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = node.name;

            hdr.appendChild(iconSpan);
            hdr.appendChild(nameSpan);

            const body = document.createElement('div');
            body.style.display = isCollapsed ? 'none' : '';
            renderTreeNodes(node.children, body, depth + 1, dirPath);

            hdr.addEventListener('click', () => {
                const collapsed = body.style.display === 'none';
                body.style.display = collapsed ? '' : 'none';
                iconSpan.className = collapsed
                    ? 'tree-icon codicon codicon-folder-opened'
                    : 'tree-icon codicon codicon-folder';
                if (collapsed) _treeCollapsed.delete(dirPath);
                else           _treeCollapsed.add(dirPath);
                _saveTreeState();
            });

            hdr.addEventListener('contextmenu', e => {
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY, [
                    { label: 'New File\u2026',   action: () => {
                        if (body.style.display === 'none') hdr.click();
                        _startInlineInput(body, 'file', dirPath, depth + 1);
                    }},
                    { label: 'New Folder\u2026', action: () => {
                        if (body.style.display === 'none') hdr.click();
                        _startInlineInput(body, 'dir', dirPath, depth + 1);
                    }},
                    null,
                    { label: 'Delete Folder', action: () => _deleteItem(dirPath, 'dir') },
                ]);
            });

            // ── Drag (source) ──────────────────────────────────────────────
            hdr.setAttribute('draggable', 'true');
            hdr.addEventListener('dragstart', e => {
                e.stopPropagation();
                _dragSrcPath = dirPath;
                _dragSrcType = 'dir';
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', dirPath);
            });

            // ── Drop (target) ──────────────────────────────────────────────
            hdr.addEventListener('dragover', e => {
                e.stopPropagation();
                if (!_isDragValid(dirPath)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                _setDropTarget(hdr);
            });
            hdr.addEventListener('drop', async e => {
                e.preventDefault();
                e.stopPropagation();
                _setDropTarget(null);
                if (!_dragSrcPath) return;
                const src = _dragSrcPath; _dragSrcPath = null;
                await _moveItem(src, dirPath);
            });

            container.appendChild(hdr);
            container.appendChild(body);
        } else {
            const ext     = node.name.split('.').pop().toLowerCase();
            const isBassm = ext === 'bassm';
            const isPng   = ext === 'png';
            const isAudio = ['raw', 'iff', 'wav', 'aiff', '8svx'].includes(ext);
            const isMask  = ext === 'mask';
            const isEntry = node.name === 'main.bassm';

            let typeClass = 'tree-item-other';
            let iconClass = 'codicon-file';
            if (isBassm)      { typeClass = 'tree-item-bassm';  iconClass = isEntry ? 'codicon-home' : 'codicon-file-code'; }
            else if (isPng)   { typeClass = 'tree-item-img';    iconClass = 'codicon-file-media'; }
            else if (isAudio) { typeClass = 'tree-item-audio';  iconClass = 'codicon-music'; }
            else if (isMask)  { typeClass = 'tree-item-mask';   iconClass = 'codicon-filter'; }

            const item = document.createElement('div');
            item.className = `tree-item ${typeClass}`
                + (node.path === _currentFile ? ' active'      : '')
                + (isEntry                    ? ' entry-point' : '');
            item.style.paddingLeft = indent + 'px';
            item.title = node.path;

            const iconSpan = document.createElement('span');
            iconSpan.className = `tree-icon codicon ${iconClass}`;

            const nameSpan = document.createElement('span');
            nameSpan.textContent = node.name;

            item.appendChild(iconSpan);
            item.appendChild(nameSpan);

            if (isBassm) {
                item.addEventListener('click', () => loadProjectFile(node.path));
                item.addEventListener('dblclick', e => {
                    e.stopPropagation();
                    if (!isEntry) _startInlineRename(item, nameSpan, node.path);
                });
            }

            // ── Drag (source) ──────────────────────────────────────────────
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', e => {
                e.stopPropagation();
                _dragSrcPath = node.path;
                _dragSrcType = 'file';
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.path);
            });

            const ctxItems = [];
            if (isPng) {
                ctxItems.push({ label: 'Convert', action: () => window.electronAPI.openAssetManager({ projectDir: _projectDir, preloadFile: node.path }) });
                ctxItems.push(null);
            }
            if (isBassm && !isEntry) {
                ctxItems.push({ label: 'Rename', action: () => _startInlineRename(item, nameSpan, node.path) });
            }
            if (!isEntry) {
                ctxItems.push({ label: 'Delete', action: () => _deleteItem(node.path, 'file') });
            }
            if (ctxItems.length > 0) {
                item.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    showContextMenu(e.clientX, e.clientY, ctxItems);
                });
            }

            container.appendChild(item);
        }
    }
}

// ── Tree: inline new file / new folder ────────────────────────────────────────

function _startInlineInput(parentBody, kind, dirPath, depth) {
    const existing = parentBody.querySelector('.tree-inline-input');
    if (existing) existing.remove();

    const indent = 8 + depth * 14;
    const row = document.createElement('div');
    row.className = 'tree-inline-input';
    row.style.paddingLeft = indent + 'px';

    const iconSpan = document.createElement('span');
    iconSpan.className = kind === 'dir'
        ? 'tree-icon codicon codicon-folder'
        : 'tree-icon codicon codicon-file-code';
    row.appendChild(iconSpan);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = kind === 'dir' ? 'folder-name' : 'file.bassm';
    row.appendChild(input);

    parentBody.insertBefore(row, parentBody.firstChild);
    input.focus();

    const commit = async () => {
        const name = input.value.trim();
        if (!name) { row.remove(); return; }
        const relPath = dirPath ? `${dirPath}/${name}` : name;
        try {
            if (kind === 'dir') await window.electronAPI.createDir({ projectDir: _projectDir, relPath });
            else                 await window.electronAPI.createFile({ projectDir: _projectDir, relPath });
            row.remove();
            _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
            renderProjectTree();
            if (kind === 'file' && name.endsWith('.bassm')) loadProjectFile(relPath);
        } catch (err) {
            logLine(`Fehler: ${err.message}`, 'error');
            row.remove();
        }
    };

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { row.remove(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (row.isConnected) row.remove(); }, 200));
}

// ── Tree: inline rename ────────────────────────────────────────────────────────

function _startInlineRename(item, nameSpan, relPath) {
    if (item.querySelector('.tree-rename-input')) return; // already renaming
    const oldName = nameSpan.textContent;
    nameSpan.style.display = 'none';

    const input = document.createElement('input');
    input.className = 'tree-rename-input';
    input.type  = 'text';
    input.value = oldName;
    item.appendChild(input);
    input.focus();
    input.select();

    const cancel = () => { input.remove(); nameSpan.style.display = ''; };

    const commit = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) { cancel(); return; }
        try {
            const newRelPath = await window.electronAPI.renameItem({ projectDir: _projectDir, relPath, newName });
            if (relPath === _currentFile) _currentFile = newRelPath;
            _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
            renderProjectTree();
        } catch (err) {
            logLine(`Rename-Fehler: ${err.message}`, 'error');
            cancel();
        }
    };

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { cancel(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected) cancel(); }, 200));
}

// ── Tree: delete item ──────────────────────────────────────────────────────────

async function _deleteItem(relPath, kind) {
    const name = relPath.split('/').pop();
    const msg  = kind === 'dir'
        ? `Ordner "${name}" und seinen gesamten Inhalt löschen?`
        : `Datei "${name}" löschen?`;
    if (!confirm(msg)) return;
    try {
        await window.electronAPI.deleteItem({ projectDir: _projectDir, relPath });
        if (kind === 'file' && relPath === _currentFile) _currentFile = 'main.bassm';
        _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
        renderProjectTree();
    } catch (err) {
        logLine(`Löschen-Fehler: ${err.message}`, 'error');
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
    const icon = _btnEmuFull.querySelector('.codicon');
    if (icon) icon.className = on ? 'codicon codicon-screen-normal' : 'codicon codicon-screen-full';
    // ResizeObserver fires when #emulator-view changes size, but call
    // manually too in case the layout change happens before the observer.
    setTimeout(updateEmulatorBounds, 30);
}

_btnEmuFull.addEventListener('click', _toggleEmuFull);
document.getElementById('btn-emulator-exit').addEventListener('click', _toggleEmuFull);

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

// ── Welcome Panel & Recent Projects ───────────────────────────────────────────

const _RECENT_KEY = 'bassm-recent';
const _RECENT_MAX = 8;

function _getRecent() {
    try { return JSON.parse(localStorage.getItem(_RECENT_KEY) || '[]'); } catch { return []; }
}

function _addRecent(name, dir) {
    const list = _getRecent().filter(r => r.dir !== dir);
    list.unshift({ name, dir });
    localStorage.setItem(_RECENT_KEY, JSON.stringify(list.slice(0, _RECENT_MAX)));
}

function _showWelcome() {
    document.body.classList.add('state-welcome');
}

function _showEditor() {
    document.body.classList.remove('state-welcome');
    setTimeout(() => window._monacoEditor?.layout(), 0);
}

function _renderWelcomeRecent(openFn) {
    const el = document.getElementById('welcome-recent-list');
    if (!el) return;
    el.innerHTML = '';
    const list = _getRecent();
    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'welcome-recent-empty';
        empty.textContent = 'No recent projects';
        el.appendChild(empty);
        return;
    }
    for (const { name, dir } of list) {
        const item = document.createElement('div');
        item.className = 'welcome-recent-item';
        item.title     = dir;

        const icon = document.createElement('span');
        icon.className   = 'recent-icon';
        icon.textContent = '\u25C7';

        const nameSpan = document.createElement('span');
        nameSpan.className   = 'recent-name';
        nameSpan.textContent = name;

        const pathSpan = document.createElement('span');
        pathSpan.className   = 'recent-path';
        pathSpan.textContent = dir;

        item.appendChild(icon);
        item.appendChild(nameSpan);
        item.appendChild(pathSpan);
        item.addEventListener('click', () => openFn(dir));
        el.appendChild(item);
    }
}

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

        // ── Welcome panel ──────────────────────────────────────────────────────
        async function _openProjectResult(result) {
            _projectDir  = result.projectDir;
            _currentFile = 'main.bassm';
            _loadTreeState();
            _addRecent(result.projectName, result.projectDir);
            projectName.textContent = result.projectName;
            window._monacoEditor.setValue(result.source ?? '');
            status.textContent = 'Ready';
            console_.innerHTML = '';
            _projectFiles = await window.electronAPI.listFiles({ projectDir: _projectDir });
            renderProjectTree();
            renderOutline(buildOutline(result.source ?? ''));
            _showEditor();
        }

        _renderWelcomeRecent(async (dir) => {
            const result = await window.electronAPI.openProjectDir({ dir });
            if (!result) { logLine(`Projekt nicht gefunden: ${dir}`, 'warn'); return; }
            await _openProjectResult(result);
        });

        document.getElementById('welcome-btn-new').addEventListener('click',
            () => document.getElementById('btn-new').click());
        document.getElementById('welcome-btn-open').addEventListener('click',
            () => btnOpen.click());

        document.getElementById('btn-assets').addEventListener('click', () => {
            window.electronAPI.openAssetManager({ projectDir: _projectDir });
        });

        // Root-level context menu on the project panel header
        document.querySelector('#project-tree .panel-header').addEventListener('contextmenu', e => {
            if (!_projectDir) return;
            e.preventDefault();
            const content = document.getElementById('project-tree-content');
            showContextMenu(e.clientX, e.clientY, [
                { label: 'New File\u2026',   action: () => _startInlineInput(content, 'file', '', 0) },
                { label: 'New Folder\u2026', action: () => _startInlineInput(content, 'dir',  '', 0) },
            ]);
        });

        // Root-level context menu when right-clicking empty space in tree content
        document.getElementById('project-tree-content').addEventListener('contextmenu', e => {
            if (!_projectDir || e.target !== document.getElementById('project-tree-content')) return;
            e.preventDefault();
            const content = document.getElementById('project-tree-content');
            showContextMenu(e.clientX, e.clientY, [
                { label: 'New File\u2026',   action: () => _startInlineInput(content, 'file', '', 0) },
                { label: 'New Folder\u2026', action: () => _startInlineInput(content, 'dir',  '', 0) },
            ]);
        });

        // Root drop target — catches drags that are not claimed by a dir header
        const _treeContentEl = document.getElementById('project-tree-content');
        _treeContentEl.addEventListener('dragover', e => {
            if (!_isDragValid('')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            _setDropTarget(_treeContentEl);
        });
        _treeContentEl.addEventListener('dragleave', e => {
            if (!_treeContentEl.contains(e.relatedTarget)) _setDropTarget(null);
        });
        _treeContentEl.addEventListener('drop', async e => {
            e.preventDefault();
            _setDropTarget(null);
            if (!_dragSrcPath) return;
            const src = _dragSrcPath; _dragSrcPath = null;
            await _moveItem(src, '');
        });

        document.getElementById('btn-new').addEventListener('click', async () => {
            const result = await window.electronAPI.newProject();
            if (!result) return;
            await _openProjectResult({ ...result, source: '' });
        });

        btnOpen.addEventListener('click', async () => {
            const result = await window.electronAPI.openProject();
            if (!result) return;
            await _openProjectResult(result);
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
