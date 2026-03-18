const {
  app, BrowserWindow, WebContentsView,
  ipcMain, protocol, net, dialog, Menu
} = require('electron/main');

// Allow AudioContext without user gesture (needed for Paula audio in the emulator view)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { execFile } = require('node:child_process');

// ── Paths ──────────────────────────────────────────────────────────────────
const VASM      = path.join(__dirname, 'bin', 'vasmm68k_mot.exe');

// ── Project file watcher ────────────────────────────────────────────────────
// Watches the open project directory (recursive) and notifies both the main
// editor window and the Asset Manager when files are added, changed, or
// removed externally. Debounced so burst-saves don't flood the renderers.
let _projectWatcher  = null;
let _watchDebounce   = null;
const WATCH_DEBOUNCE = 300; // ms

function startProjectWatcher(projectDir) {
  stopProjectWatcher();
  if (!projectDir) return;
  try {
    _projectWatcher = fs.watch(projectDir, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      if (_watchDebounce) clearTimeout(_watchDebounce);
      _watchDebounce = setTimeout(() => {
        _watchDebounce = null;
        // Notify main editor window(s)
        for (const win of BrowserWindow.getAllWindows()) {
          if (win !== assetManagerWindow && !win.isDestroyed()) {
            win.webContents.send('project:files-changed', { filename });
          }
        }
        // Notify Asset Manager window
        if (assetManagerWindow && !assetManagerWindow.isDestroyed()) {
          assetManagerWindow.webContents.send('assets:files-changed', { filename });
        }
      }, WATCH_DEBOUNCE);
    });
    _projectWatcher.on('error', () => stopProjectWatcher());
  } catch (_) { /* projectDir inaccessible — ignore */ }
}

function stopProjectWatcher() {
  if (_watchDebounce) { clearTimeout(_watchDebounce); _watchDebounce = null; }
  if (_projectWatcher) { _projectWatcher.close(); _projectWatcher = null; }
}
const VLINK     = path.join(__dirname, 'bin', 'vlink.exe');
const FRAGMENTS = path.join(__dirname, 'app', 'src', 'm68k', 'fragments');
const ROM_MAIN  = path.join(__dirname, 'emulator', 'vAmigaWeb', 'roms', 'aros.bin');
const ROM_EXT   = path.join(__dirname, 'emulator', 'vAmigaWeb', 'roms', 'aros_ext.bin');
const OUT_DIR   = path.join(__dirname, 'out');
const ASSETS    = path.join(__dirname, 'app', 'assets');

// ── Protocol: serve emulator/preview/ with correct MIME types ─────────────
// WASM files need application/wasm — Electron's file:// doesn't set this.
app.whenReady().then(() => {
  protocol.handle('emulator', (request) => {
    const url  = new URL(request.url);
    const file = path.join(__dirname, 'emulator', 'preview', url.pathname);
    return net.fetch(`file://${file}`);
  });
});

// ── Asset Manager Window ───────────────────────────────────────────────────
let assetManagerWindow = null;

function createAssetManagerWindow(projectDir) {
  if (assetManagerWindow && !assetManagerWindow.isDestroyed()) {
    assetManagerWindow.focus();
    if (projectDir) {
      assetManagerWindow.webContents.send('assets:set-project', { projectDir });
    }
    return;
  }

  assetManagerWindow = new BrowserWindow({
    width:  960,
    height: 680,
    minWidth:  700,
    minHeight: 480,
    title: 'BASSM – Asset Manager',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'app', 'preload-assets.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  assetManagerWindow.loadFile('app/asset-manager.html');

  if (projectDir) {
    assetManagerWindow.webContents.once('did-finish-load', () => {
      assetManagerWindow.webContents.send('assets:set-project', { projectDir });
    });
  }

  assetManagerWindow.on('closed', () => { assetManagerWindow = null; });
}

// Renderer (editor) → main: open or focus the Asset Manager window
ipcMain.on('bassm:open-asset-manager', (_event, { projectDir } = {}) => {
  createAssetManagerWindow(projectDir || null);
});

// Renderer (asset manager) → main: list assets in project directory
// Returns { palettes: [{name,path}], images: [{name,path}], sounds: [{name,path}] }
ipcMain.handle('bassm:list-assets', (_event, { projectDir }) => {
  if (!projectDir) return { palettes: [], images: [], sounds: [] };

  function listDir(subdir, exts) {
    const dir = path.join(projectDir, subdir);
    try {
      return fs.readdirSync(dir)
        .filter(f => !f.startsWith('.') && exts.some(e => f.toLowerCase().endsWith(e)))
        .sort()
        .map(name => ({ name, path: subdir + '/' + name }));
    } catch (_) { return []; }
  }

  // Palettes: root-level JSON files whose names start with "palette"
  let palettes = [];
  try {
    palettes = fs.readdirSync(projectDir)
      .filter(f => f.toLowerCase().startsWith('palette') && f.toLowerCase().endsWith('.json'))
      .sort()
      .map(name => ({ name, path: name }));
  } catch (_) {}

  return {
    palettes,
    images: listDir('images', ['.raw', '.bmp', '.iff', '.png', '.jpg']),
    sounds: listDir('sounds', ['.raw', '.wav', '.mp3', '.ogg', '.aiff']),
  };
});

// ── Emulator WebContentsView ───────────────────────────────────────────────
let emulatorView = null;

function createEmulatorView(parentWindow) {
  emulatorView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'emulator', 'preview', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // WASM requires these
      webSecurity: true,
    }
  });

  parentWindow.contentView.addChildView(emulatorView);

  // Position the emulator view — will be resized by the renderer via IPC
  positionEmulatorView(parentWindow);
  parentWindow.on('resize', () => positionEmulatorView(parentWindow));

  // Load the emulator HTML (built by GitHub Actions, placed in emulator/preview/)
  const previewPath = path.join(__dirname, 'emulator', 'preview', 'preview.html');
  if (fs.existsSync(previewPath)) {
    emulatorView.webContents.loadFile(previewPath);
  } else {
    // Placeholder until first WASM build is available
    emulatorView.webContents.loadURL(
      'data:text/html,<body style="background:#111;color:#555;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:24px;margin-bottom:8px">◻</div><div>Emulator not built yet</div><div style="font-size:11px;margin-top:4px">Run the GitHub Actions workflow to build the WASM</div></div>'
    );
  }

  return emulatorView;
}

function positionEmulatorView(win) {
  if (!emulatorView) return;
  const [w, h] = win.getContentSize();
  // Approximate layout: left panel 200px, right panel 380px, toolbar 28px, console 140px.
  // The renderer's ResizeObserver sends pixel-perfect bounds via emulator:bounds IPC
  // shortly after load and on every resize, so this is only a brief fallback.
  const TOOLBAR_H = 28;
  const RIGHT_W   = 380;
  const CONSOLE_H = 140;
  emulatorView.setBounds({
    x: w - RIGHT_W,
    y: TOOLBAR_H,
    width: RIGHT_W,
    height: h - TOOLBAR_H - CONSOLE_H,
  });
}

// ── IPC handlers ───────────────────────────────────────────────────────────

// Renderer (editor) → main: set emulator bounds
ipcMain.on('emulator:bounds', (_event, bounds) => {
  if (emulatorView) emulatorView.setBounds(bounds);
});

// Renderer (editor) → main: send command to emulator
ipcMain.on('emulator:send', (_event, cmd) => {
  console.log('[BASSM] emulator:send', cmd.type, cmd.data ? `(${cmd.data.length} bytes)` : '');
  if (emulatorView) {
    emulatorView.webContents.send('emulator:command', cmd);
  }
});

// Emulator → main: ready signal → auto-load AROS ROM for development
ipcMain.on('emulator:ready', () => {
  console.log('[BASSM] Emulator ready — auto-loading AROS ROM');
  if (!emulatorView) return;
  try {
    const romMain = fs.readFileSync(ROM_MAIN);
    const romExt  = fs.readFileSync(ROM_EXT);
    emulatorView.webContents.send('emulator:command', { type: 'load-rom', data: romMain });
    emulatorView.webContents.send('emulator:command', { type: 'load-ext', data: romExt });
    console.log('[BASSM] ROM sent to emulator');
  } catch (e) {
    console.error('[BASSM] Failed to load ROM:', e.message);
  }
});

// Emulator → main: status update
ipcMain.on('emulator:status', (_event, text) => {
  console.log('[BASSM] Emulator:', text);
});

// Renderer → main: assemble m68k source with vasmm68k_mot
// Accepts { asm: string, assetFiles: string[], projectDir?: string }
// Returns { ok: true, data: Buffer } or { ok: false, error: string }
ipcMain.handle('bassm:assemble', (_event, payload) => {
  return new Promise((resolve) => {
    const { asm: asmText, assetFiles = [], projectDir } = payload;
    // Asset root: project folder when open, app/assets/ for the built-in demo.
    // Filenames may be relative paths (e.g. "sounds/boing.raw") — directory
    // structure is mirrored into tmpDir so INCBIN resolves them correctly.
    const assetSrcDir = projectDir || ASSETS;
    const tmpDir = os.tmpdir();
    const srcFile = path.join(tmpDir, 'bassm_src.s');
    const objFile = path.join(tmpDir, 'bassm_out.o');
    const outFile = path.join(tmpDir, 'bassm_out.exe');

    for (const filename of assetFiles) {
      const src = path.join(assetSrcDir, filename);
      const dst = path.join(tmpDir, filename);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (e) {
        resolve({ ok: false, error: `Asset not found: ${filename} (expected at ${src})` });
        return;
      }
    }

    fs.writeFileSync(srcFile, asmText, 'utf8');

    // Step 1: assemble → hunk object file
    execFile(VASM, ['-Fhunk', '-I', FRAGMENTS, '-o', objFile, srcFile], (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr || err.message });
        return;
      }

      // Step 2: link → AmigaOS hunk executable
      // vlink merges same-type sections: all CODE into one hunk, DATA_C into
      // one CHIP hunk, BSS_C into one CHIP BSS hunk — producing a clean,
      // Kickstart-compatible executable.
      execFile(VLINK, ['-bamigahunk', '-e', 'start', '-o', outFile, objFile], (err2, _stdout2, stderr2) => {
        if (err2) {
          resolve({ ok: false, error: stderr2 || err2.message });
          return;
        }
        try {
          const data = fs.readFileSync(outFile);
          fs.mkdirSync(OUT_DIR, { recursive: true });
          fs.copyFileSync(outFile, path.join(OUT_DIR, 'bassm_out.exe'));
          
          if (projectDir) {
            fs.copyFileSync(outFile, path.join(projectDir, 'bassm_out.exe'));
          }

          resolve({ ok: true, data });
        } catch (readErr) {
          resolve({ ok: false, error: readErr.message });
        }
      });
    });
  });
});

// Renderer → main: load AROS ROM bytes
// Returns { main: number[], ext: number[] }
ipcMain.handle('bassm:rom', () => {
  return {
    main: fs.readFileSync(ROM_MAIN),
    ext:  fs.readFileSync(ROM_EXT),
  };
});

// Renderer → main: open project folder dialog
// Returns { projectDir, projectName, source } or null if cancelled
ipcMain.handle('bassm:open-project', async (_event) => {
  const result = await dialog.showOpenDialog({
    title: 'Open BASSM Project Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const projectDir  = result.filePaths[0];
  const projectName = path.basename(projectDir);
  const sourceFile  = path.join(projectDir, 'main.bassm');
  let source = '';
  try { source = fs.readFileSync(sourceFile, 'utf8'); } catch (_) { /* new project — empty editor */ }
  startProjectWatcher(projectDir);
  return { projectDir, projectName, source };
});

// Renderer → main: read an included source file from projectDir
// Accepts { projectDir: string, filename: string }
// Returns the file content as a UTF-8 string.
// Security: resolves path strictly within projectDir (no path traversal).
ipcMain.handle('bassm:read-file', (_event, { projectDir, filename }) => {
  const base     = path.resolve(projectDir);
  const resolved = path.resolve(projectDir, filename);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Include path escapes project directory: "${filename}"`);
  }
  return fs.readFileSync(resolved, 'utf8');
});

// Renderer → main: save source file back to project
// Accepts { projectDir: string, filename?: string, source: string }
// filename defaults to 'main.bassm'; path traversal is rejected.
ipcMain.handle('bassm:save-source', (_event, { projectDir, filename = 'main.bassm', source }) => {
  const base     = path.resolve(projectDir);
  const resolved = path.resolve(projectDir, filename);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes project directory: "${filename}"`);
  }
  fs.writeFileSync(resolved, source, 'utf8');
});

// Renderer → main: read a binary asset file from the project directory.
// Returns the file contents as a plain number[] (Array.from(Buffer)) so it
// can be transferred over the context-isolated IPC bridge.
// Used by the Asset Manager to load source images (PNG/JPG) directly from
// the left-panel file list without requiring drag & drop.
ipcMain.handle('bassm:read-asset', (_event, { projectDir, path: relPath }) => {
  const base     = path.resolve(projectDir);
  const resolved = path.resolve(projectDir, relPath);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes project directory: "${relPath}"`);
  }
  return Array.from(fs.readFileSync(resolved));
});

// Renderer (asset manager) → main: write a converted asset into the project
// Accepts { projectDir, subdir, filename, data: number[] }
ipcMain.handle('bassm:write-asset', (_event, { projectDir, subdir, filename, data }) => {
  const base    = path.resolve(projectDir);
  const outDir  = path.join(projectDir, subdir);
  const outFile = path.join(outDir, filename);
  if (!path.resolve(outFile).startsWith(base + path.sep)) {
    throw new Error(`Path escapes project directory: "${filename}"`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(data));
});

// Renderer → main: recursively scan project directory
// Returns a tree: Array<{ name, type:'dir'|'file', path?, children? }>
// path is the slash-normalized relative path from projectDir (files only).
// Dirs sort before files; main.bassm is always first among files.
ipcMain.handle('bassm:list-files', (_event, { projectDir }) => {
  function scanDir(dir, base) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return []; }
    const dirs  = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        const children = scanDir(path.join(dir, e.name), base);
        dirs.push({ name: e.name, type: 'dir', children });
      } else {
        const rel = path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/');
        files.push({ name: e.name, type: 'file', path: rel });
      }
    }
    dirs.sort( (a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => {
      if (a.name === 'main.bassm') return -1;
      if (b.name === 'main.bassm') return 1;
      return a.name.localeCompare(b.name);
    });
    return [...dirs, ...files];
  }
  try { return scanDir(projectDir, projectDir); }
  catch (_) { return []; }
});

// ── Main window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'app', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  createEmulatorView(win);
  win.loadFile('app/index.html');

  win.on('closed', () => {
    if (assetManagerWindow && !assetManagerWindow.isDestroyed()) {
      assetManagerWindow.close();
    }
  });

  // DevTools for both views — remove or guard with isDev check for production
  win.webContents.openDevTools({ mode: 'detach' });
  emulatorView.webContents.openDevTools({ mode: 'detach' });

  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Quit', accelerator: 'Alt+F4', click: () => app.quit() }
      ]
    }
  ]));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
