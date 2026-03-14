const {
  app, BrowserWindow, WebContentsView,
  ipcMain, protocol, net, dialog
} = require('electron/main');

// Allow AudioContext without user gesture (needed for Paula audio in the emulator view)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { execFile } = require('node:child_process');

// ── Paths ──────────────────────────────────────────────────────────────────
const VASM      = path.join(__dirname, 'bin', 'vasmm68k_mot.exe');
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
  // Right half of the window — layout managed by the main renderer
  // This will be updated dynamically once the UI is built
  const TOOLBAR_H = 28;
  emulatorView.setBounds({
    x: Math.floor(w / 2),
    y: TOOLBAR_H,
    width: Math.floor(w / 2),
    height: h - TOOLBAR_H
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
// Accepts { projectDir: string, source: string }
ipcMain.handle('bassm:save-source', (_event, { projectDir, source }) => {
  const sourceFile = path.join(projectDir, 'main.bassm');
  fs.writeFileSync(sourceFile, source, 'utf8');
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

  // DevTools for both views — remove or guard with isDev check for production
  win.webContents.openDevTools({ mode: 'detach' });
  emulatorView.webContents.openDevTools({ mode: 'detach' });

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
