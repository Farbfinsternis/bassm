const {
  app, BrowserWindow, WebContentsView,
  ipcMain, protocol, net, dialog, Menu, shell
} = require('electron/main');

// Allow AudioContext without user gesture (needed for Paula audio in the emulator view)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Project package.json — read once for version etc.
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// ── Workspace bootstrap (W-T01/T02/T05) ────────────────────────────────────
// workspace.js / workspace-bootstrap.js / workspace-settings.js live in
// app/src ("type": "module"), so we load them via dynamic import the same
// way adf.js is loaded later. Bootstrap must run inside app.whenReady()
// because app.getPath() needs the app to be ready. Other handlers can
// `await _workspacePromise` to make sure the workspace is configured before
// they touch any path helper.
let _workspaceModule  = null;   // resolved after configure+bootstrap
let _settingsModule   = null;   // resolved alongside
const _workspacePromise = app.whenReady().then(async () => {
  const wsUrl       = pathToFileURL(path.join(__dirname, 'app', 'src', 'workspace.js')).href;
  const bootUrl     = pathToFileURL(path.join(__dirname, 'app', 'src', 'workspace-bootstrap.js')).href;
  const settingsUrl = pathToFileURL(path.join(__dirname, 'app', 'src', 'workspace-settings.js')).href;
  const ws       = await import(wsUrl);
  const settings = await import(settingsUrl);
  const { bootstrapWorkspace } = await import(bootUrl);

  // In dev mode, redirect the settings file out of <Documents>/BASSM/ —
  // the dev-isolation rule says nothing of ours lands in Documents during
  // `npm start`. <repoRoot>/.bassm-dev/ is gitignored alongside dist/.
  const settingsPathOverride = app.isPackaged
    ? null
    : path.join(__dirname, '.bassm-dev', 'bassm.json');

  ws.configure({
    documentsDir:         app.getPath('documents'),
    isPackaged:           app.isPackaged,
    resourcesPath:        process.resourcesPath || null,
    repoRoot:             __dirname,
    settingsPathOverride,
  });

  const report = bootstrapWorkspace({ appVersion: PKG.version });
  if (report.skipped) {
    console.log('[workspace] dev mode — bootstrap skipped');
    // Make sure the dev settings file's parent exists so saves don't ENOENT.
    if (settingsPathOverride) {
      fs.mkdirSync(path.dirname(settingsPathOverride), { recursive: true });
    }
  } else {
    const c = report.created;
    const fresh = c.root || c.settings;
    console.log(`[workspace] root: ${report.root}${fresh ? ' (first run)' : ''}`);
    if (c.settings) console.log('[workspace]   created bassm.json');
  }

  _workspaceModule = ws;
  _settingsModule  = settings;
  return ws;
}).catch(err => {
  // Fatal: without a working workspace we can't open or save projects.
  console.error('[workspace] bootstrap failed:', err);
  throw err;
});

// ── Paths ──────────────────────────────────────────────────────────────────
const IS_WIN    = process.platform === 'win32';
const BIN_EXT   = IS_WIN ? '.exe' : '';
const VASM      = path.join(__dirname, 'bin', `vasmm68k_mot${BIN_EXT}`);

// ── Project file watcher ────────────────────────────────────────────────────
// Watches the open project directory (recursive) and notifies the main
// editor window when files are added, changed, or
// removed externally. Debounced so burst-saves don't flood the renderers.
let _projectWatcher  = null;
let _watchDebounce   = null;
const WATCH_DEBOUNCE = 300; // ms

function startProjectWatcher(projectDir) {
  stopProjectWatcher();
  if (!projectDir) return;
  try {
    // recursive is only supported on Windows and macOS; Linux falls back to root-only watch
    _projectWatcher = fs.watch(projectDir, { recursive: IS_WIN }, (_type, filename) => {
      if (!filename) return;
      if (_watchDebounce) clearTimeout(_watchDebounce);
      _watchDebounce = setTimeout(() => {
        _watchDebounce = null;
        // Notify main editor window(s)
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('project:files-changed', { filename });
          }
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
const VLINK     = path.join(__dirname, 'bin', `vlink${BIN_EXT}`);

// Ensure vasm + vlink are executable on Linux (git on Windows loses the +x bit)
if (!IS_WIN) {
  try { fs.chmodSync(VASM,  0o755); } catch (_) {}
  try { fs.chmodSync(VLINK, 0o755); } catch (_) {}
}
// Fragments are read by the external vasm process via the `-I` flag.
// In the packaged build __dirname points inside app.asar (a virtual path
// only Electron's patched fs APIs understand). vasm — being a native
// process — cannot read inside ASAR, so we point it at app.asar.unpacked.
// Listed in package.json `build.asarUnpack` so electron-builder mirrors
// the directory next to the asar.
const FRAGMENTS = path.join(__dirname, 'app', 'src', 'm68k', 'fragments')
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
const ROM_MAIN  = path.join(__dirname, 'emulator', 'vAmigaWeb', 'roms', 'aros.bin');
const ROM_EXT   = path.join(__dirname, 'emulator', 'vAmigaWeb', 'roms', 'aros_ext.bin');

// Bundled-examples fallback (dev mode dialog default; in packaged mode the
// workspace mirror is the authoritative source).
const REPO_EXAMPLES = path.join(__dirname, 'examples');

/**
 * Resolve the directory dialogs ("Open Project", "New Project") should
 * default to. Packaged → <workspace>/projects/. Dev → repo's examples/.
 * Caller must `await _workspacePromise` first.
 */
function _projectsDirForDialog() {
  if (!_workspaceModule) return REPO_EXAMPLES;
  return _workspaceModule.isDevMode()
    ? REPO_EXAMPLES
    : _workspaceModule.getProjectsDir();
}

/**
 * Resolve the build-tmp directory for an assemble pass.
 * - With projectDir → <projectDir>/.tmp/  (per-project cache, dev + packaged).
 * - Without projectDir (welcome demo, no project loaded) →
 *     packaged: <workspace>/tmp/, dev: os.tmpdir().
 */
function _buildTmpDir(projectDir) {
  if (projectDir && _workspaceModule) {
    return _workspaceModule.getProjectTmpDir(projectDir);
  }
  if (_workspaceModule && !_workspaceModule.isDevMode()) {
    return _workspaceModule.getTmpDir();
  }
  return os.tmpdir();
}

// ── Sprite-sheet reorder ────────────────────────────────────────────────────
// .iraw files store frames as the user painted them (horizontal strip or
// grid).  The runtime engine, however, is built around a single layout:
// `count` frames stacked vertically, each fw × fh.  At build time we read
// the source file, walk the sheet in row-major order, and emit a copy where
// the frames are stacked.  The original asset in the project is untouched —
// only the build copy in tmpDir is rewritten.
//
// Entry args (for both): xform = { fileW, fileH, fw, fh, cols, rows, count }
// Output bytes: header (12) + palette + interleaved bitplanes for `count`
// vertically-stacked frames, depth carried over from the source header.

function _frameRowbytes(fw) {
  return Math.ceil(Math.ceil(fw / 8) / 2) * 2;
}

function _reorderIrawSheet(buf, xform) {
  const { fileW, fileH, fw, fh, cols, count } = xform;
  if (buf.length < 12 ||
      buf[0] !== 0x49 || buf[1] !== 0x52 || buf[2] !== 0x41 || buf[3] !== 0x57)
    throw new Error('not an IRAW v2 file');
  const hdrW    = (buf[4] << 8) | buf[5];
  const hdrH    = (buf[6] << 8) | buf[7];
  const depth   = (buf[8] << 8) | buf[9];
  const srcRb   = (buf[10] << 8) | buf[11];
  if (hdrW !== fileW || hdrH !== fileH)
    throw new Error(`IRAW header dims ${hdrW}×${hdrH} disagree with reader (${fileW}×${fileH})`);

  const palBytes  = (1 << depth) * 2;
  const palOffset = 12;
  const dataOffset = palOffset + palBytes;
  const expectedPx = srcRb * fileH * depth;
  if (dataOffset + expectedPx > buf.length)
    throw new Error(`IRAW pixel block truncated (need ${expectedPx} bytes after palette)`);

  const dstFw = fw;
  const dstFh = fh * count;
  const dstRb = _frameRowbytes(dstFw);
  const frameRb = _frameRowbytes(fw);
  if (frameRb !== dstRb) throw new Error('frame rowbytes mismatch (internal)');

  const dstPx = dstRb * dstFh * depth;
  const out = Buffer.alloc(12 + palBytes + dstPx);
  out[0] = 0x49; out[1] = 0x52; out[2] = 0x41; out[3] = 0x57;
  out[4] = (dstFw >> 8) & 0xFF; out[5] = dstFw & 0xFF;
  out[6] = (dstFh >> 8) & 0xFF; out[7] = dstFh & 0xFF;
  out[8] = (depth >> 8) & 0xFF; out[9] = depth & 0xFF;
  out[10] = (dstRb >> 8) & 0xFF; out[11] = dstRb & 0xFF;
  buf.copy(out, palOffset, palOffset, dataOffset);

  // Walk frames in row-major order. Each frame is fh pixel-rows; in the
  // interleaved layout each pixel row holds `depth` plane-rows, each
  // `srcRb` bytes wide in the source and `dstRb` bytes in the destination.
  // The source X offset for column c is `c * frameRb` bytes.
  let dstCursor = dataOffset;
  for (let f = 0; f < count; f++) {
    const col = f % cols;
    const row = Math.floor(f / cols);
    const srcXBytes = col * frameRb;
    for (let py = 0; py < fh; py++) {
      const srcPixelRow = row * fh + py;
      // depth plane-rows for this pixel row, each row is srcRb in source
      let srcRowBase = dataOffset + (srcPixelRow * depth) * srcRb + srcXBytes;
      for (let p = 0; p < depth; p++) {
        buf.copy(out, dstCursor, srcRowBase, srcRowBase + frameRb);
        dstCursor  += frameRb;
        srcRowBase += srcRb;
      }
    }
  }
  return out;
}

// .imask is interleaved 1-bit-per-pixel: same row geometry as the .iraw, but
// each "row" is the mask repeated `depth` times so a single blit feeds all
// planes.  Layout-wise it behaves like an IRAW with no header and depth=1
// per visible row but the row repeated `depth` times — so the easiest way
// to reorder is to treat the mask as having "depth=1" rows and `fh×depth`
// total mask-rows per source pixel-row.  In effect: the mask file is just
// `depth × fileH` rows of `srcRb` bytes, no header, no palette.
//
// We rebuild the mask the same way: walk frames in row-major order; for
// each frame copy `fh × depth` mask-rows out of the source, taking the
// `frameRb`-wide column slice.
function _reorderImaskSheet(buf, xform) {
  const { fileW, fileH, fw, fh, cols, count } = xform;
  // The .imask has no header — depth must be inferred. Since the sibling
  // .iraw is what drives the geometry, we derive it from the mask size:
  // total bytes = srcRb × fileH × depth, where srcRb is for fileW.
  const srcRb = _frameRowbytes(fileW);
  if (buf.length % (srcRb * fileH) !== 0)
    throw new Error(`.imask size ${buf.length} not a multiple of ${srcRb}×${fileH}`);
  const depth = buf.length / (srcRb * fileH);
  if (depth < 1 || depth > 6)
    throw new Error(`.imask implied depth ${depth} out of range (1..6)`);

  const frameRb = _frameRowbytes(fw);
  const dstSize = frameRb * fh * depth * count;
  const out = Buffer.alloc(dstSize);
  let dstCursor = 0;
  for (let f = 0; f < count; f++) {
    const col = f % cols;
    const row = Math.floor(f / cols);
    const srcXBytes = col * frameRb;
    for (let py = 0; py < fh; py++) {
      const srcPixelRow = row * fh + py;
      let srcRowBase = (srcPixelRow * depth) * srcRb + srcXBytes;
      for (let p = 0; p < depth; p++) {
        buf.copy(out, dstCursor, srcRowBase, srcRowBase + frameRb);
        dstCursor  += frameRb;
        srcRowBase += srcRb;
      }
    }
  }
  return out;
}

// ── Protocol: serve emulator/preview/ with correct MIME types ─────────────
// WASM files need application/wasm — Electron's file:// doesn't set this.
app.whenReady().then(() => {
  protocol.handle('emulator', (request) => {
    const url  = new URL(request.url);
    const file = path.join(__dirname, 'emulator', 'preview', url.pathname);
    return net.fetch(`file://${file}`);
  });
});

// Renderer → main: synchronous version query (used in preload.js)
ipcMain.on('bassm:get-version', (event) => { event.returnValue = app.getVersion(); });

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
// Accepts { asm: string, assetFiles: string[], fontAssets?: [...], projectDir?: string }
// Returns { ok: true, data: Buffer, warnings: string[] } or { ok: false, error: string }
ipcMain.handle('bassm:assemble', async (_event, payload) => {
  await _workspacePromise;
  return new Promise((resolve) => {
    const { asm: asmText, assetFiles = [], fontAssets = [], assetTransforms = [], projectDir } = payload;
    const transformsByFile = new Map(assetTransforms.map(t => [t.filename, t]));
    // Asset-bearing builds require an open project — we have nowhere to
    // resolve relative INCBIN paths from otherwise. Pure-code builds
    // (welcome demo etc.) still work without a project.
    if ((assetFiles.length > 0 || fontAssets.length > 0) && !projectDir) {
      resolve({ ok: false, error: 'Asset references require an open project — Open or create a project before building.' });
      return;
    }
    // Asset root is the project folder. Filenames may be relative paths
    // (e.g. "sounds/boing.raw") — directory structure is mirrored into
    // tmpDir so INCBIN resolves them correctly.
    const assetSrcDir = projectDir;
    const tmpDir = _buildTmpDir(projectDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    const srcFile = path.join(tmpDir, 'bassm_src.s');
    const objFile = path.join(tmpDir, 'bassm_out.o');
    const outFile = path.join(tmpDir, 'bassm_out.exe');

    for (const filename of assetFiles) {
      const src = path.join(assetSrcDir, filename);
      const dst = path.join(tmpDir, filename);
      const xform = transformsByFile.get(filename);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (xform) {
          const buf = fs.readFileSync(src);
          let out;
          if (xform.kind === 'iraw-sheet')      out = _reorderIrawSheet(buf, xform);
          else if (xform.kind === 'imask-sheet') out = _reorderImaskSheet(buf, xform);
          else                                   out = buf;
          fs.writeFileSync(dst, out);
        } else {
          fs.copyFileSync(src, dst);
        }
      } catch (e) {
        resolve({ ok: false, error: `Asset error (${filename}): ${e.message}` });
        return;
      }
    }

    // M3-T04: .bfnt-Files werden durch die generische assetFiles-Schleife
    // oben kopiert; codegen.js INCBIN-pfad inkludiert sie unverändert.
    // Die ehemalige .raw → glyph-major-Konversion und numPlanes-Warnung
    // (fontAssets-Spezialschleife) ist entfallen — Legacy-.raw-Fonts werden
    // vom Compiler nicht mehr akzeptiert.
    const warnings = [];

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
          // Mirror the executable next to the project's main.bassm so users
          // can grab it for transfer to a real Amiga without diving into .tmp/.
          if (projectDir) {
            fs.copyFileSync(outFile, path.join(projectDir, 'bassm_out.exe'));
          }

          resolve({ ok: true, data, warnings });
        } catch (readErr) {
          resolve({ ok: false, error: readErr.message });
        }
      });
    });
  });
});

// Renderer → main: create bootable ADF disk image, show save dialog, write to disk.
// Accepts { projectName: string, exeData: number[] | Buffer }
// Returns { ok: true, filePath: string } | { ok: false, error: string } | { ok: false, cancelled: true }
ipcMain.handle('bassm:create-adf', async (_event, { projectName, projectDir, exeData }) => {
  try {
    await _workspacePromise;
    const adfUrl = pathToFileURL(path.join(__dirname, 'app', 'src', 'adf.js'));
    const { createADF } = await import(adfUrl.href);
    const adf = createADF(projectName, 'bassm_out', new Uint8Array(exeData));

    // Default save path: <projectDir>/adf/<name>.adf if a project is open,
    // otherwise plain <name>.adf in whatever directory the dialog opens to.
    let defaultPath = `${projectName}.adf`;
    if (projectDir && _workspaceModule) {
      const adfDir = _workspaceModule.getProjectAdfDir(projectDir);
      fs.mkdirSync(adfDir, { recursive: true });
      defaultPath = path.join(adfDir, `${projectName}.adf`);
    }

    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: 'Amiga Disk File', extensions: ['adf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

    fs.writeFileSync(result.filePath, Buffer.from(adf));
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
// Returns { projectDir, projectName, source, isVBE } or null if cancelled
ipcMain.handle('bassm:open-project', async (_event) => {
  await _workspacePromise;
  const result = await dialog.showOpenDialog({
    title: 'Open BASSM Project Folder',
    defaultPath: _projectsDirForDialog(),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const projectDir  = result.filePaths[0];
  const projectName = path.basename(projectDir);
  
  let source = '';
  let isVBE  = false;
  if (fs.existsSync(path.join(projectDir, 'main.bnode'))) {
    source = fs.readFileSync(path.join(projectDir, 'main.bnode'), 'utf8');
    isVBE = true;
  } else {
    try { source = fs.readFileSync(path.join(projectDir, 'main.bassm'), 'utf8'); } catch (_) {}
  }
  
  startProjectWatcher(projectDir);
  return { projectDir, projectName, source, isVBE };
});

// Renderer → main: create a new project folder and open it.
// Accepts { type: 'code' | 'vbe' }
// Returns { projectDir, projectName, source: '', isVBE } or null if cancelled.
ipcMain.handle('bassm:new-project', async (_event, { type }) => {
  await _workspacePromise;
  const result = await dialog.showSaveDialog({
    title: 'Choose Folder for New BASSM Project',
    buttonLabel: 'Create Project',
    defaultPath: path.join(_projectsDirForDialog(), 'my-game'),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  const projectDir  = result.filePath;
  const projectName = path.basename(projectDir);
  fs.mkdirSync(projectDir, { recursive: true });
  
  const isVBE = type === 'vbe';
  const entryFile = isVBE ? 'main.bnode' : 'main.bassm';
  const initialContent = isVBE ? JSON.stringify({nodes: [], edges: []}) : '';
  fs.writeFileSync(path.join(projectDir, entryFile), initialContent, 'utf8');
  
  startProjectWatcher(projectDir);
  return { projectDir, projectName, source: initialContent, isVBE };
});

// Renderer → main: create a temporary scratch project under <workspace>/tmp/.
// No SaveDialog — the renderer triggers this directly when "New File" is
// clicked without an open project. Folder name is `tmp-YYYYMMDD-HHMMSS`,
// entry file is main.bassm with a working Graphics boilerplate so the first
// Run produces visible output instead of the no-Graphics hint.
// Returns { projectDir, projectName, source, isVBE: false, isScratch: true }.
ipcMain.handle('bassm:new-scratch-project', async (_event) => {
  await _workspacePromise;
  if (!_workspaceModule) throw new Error('workspace not ready');
  const tmpRoot = _workspaceModule.getTmpDir();
  fs.mkdirSync(tmpRoot, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
              + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const projectDir  = path.join(tmpRoot, `tmp-${stamp}`);
  const projectName = path.basename(projectDir);
  fs.mkdirSync(projectDir, { recursive: true });

  const { helloWorld: boilerplate } = require('./app/src/boilerplate.json');
  fs.writeFileSync(path.join(projectDir, 'main.bassm'), boilerplate, 'utf8');

  startProjectWatcher(projectDir);
  return { projectDir, projectName, source: boilerplate, isVBE: false, isScratch: true };
});

// Renderer → main: open a project by directory path (used by recent projects list)
// Returns { projectDir, projectName, source, isVBE } or null if directory not found
ipcMain.handle('bassm:open-project-dir', async (_event, { dir }) => {
  if (!fs.existsSync(dir)) return null;
  const projectDir  = dir;
  const projectName = path.basename(projectDir);

  let source = '';
  let isVBE  = false;
  if (fs.existsSync(path.join(projectDir, 'main.bnode'))) {
    source = fs.readFileSync(path.join(projectDir, 'main.bnode'), 'utf8');
    isVBE = true;
  } else {
    try { source = fs.readFileSync(path.join(projectDir, 'main.bassm'), 'utf8'); } catch (_) {}
  }

  startProjectWatcher(projectDir);
  return { projectDir, projectName, source, isVBE };
});

// ── Examples mirror (W-T06) ────────────────────────────────────────────────
// Examples live read-only in <workspace>/examples/ (packaged) or
// <repoRoot>/examples/ (dev). To edit one, the user clones it into
// <projects>/<name>/, where it becomes a regular project.

/**
 * Source directory the example listing/clone reads from.
 * Packaged: workspace mirror (kept in sync by W-T03 bootstrap).
 * Dev:      repo's examples/ — the workspace mirror doesn't exist
 *           in dev because bootstrap is skipped.
 */
function _examplesSourceDir() {
  if (!_workspaceModule) return REPO_EXAMPLES;
  return _workspaceModule.isDevMode()
    ? _workspaceModule.getBundledExamplesDir()
    : _workspaceModule.getExamplesDir();
}

/**
 * Where Clone-Example writes the editable copy.
 * Packaged: <workspace>/projects/.
 * Dev:      <repoRoot>/.bassm-dev/projects/ (gitignored, parallels the
 *           dev settings file under .bassm-dev/).
 */
function _cloneTargetDir() {
  if (_workspaceModule && !_workspaceModule.isDevMode()) {
    return _workspaceModule.getProjectsDir();
  }
  return path.join(__dirname, '.bassm-dev', 'projects');
}

/**
 * Recursive directory copy. Strips any read-only flag the source might
 * carry (the W-T03 plan envisioned chmod 0444 on mirror files; W-T03 did
 * not actually set it, but this keeps the workflow robust if it's added
 * later or if a user marked a bundled file read-only manually).
 */
function _copyDirRecursive(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      try { fs.chmodSync(dst, 0o644); } catch (_) { /* Windows: noop */ }
    }
    // symlinks etc. are intentionally skipped (the mirror sync also
    // skips them, so they shouldn't appear here in practice).
  }
}

// Renderer → main: list example projects available for cloning.
// Returns [{ name, isVBE, cloned }] — only directories with a
// main.bassm or main.bnode are reported. Hidden / underscore-prefixed
// directories are filtered. `cloned` means a copy already lives in the
// projects dir under the same name; the renderer uses it to prompt the
// user before re-cloning.
ipcMain.handle('bassm:list-examples', async () => {
  await _workspacePromise;
  const sourceDir   = _examplesSourceDir();
  const projectsDir = _cloneTargetDir();
  if (!fs.existsSync(sourceDir)) return [];
  let entries;
  try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }); }
  catch (_) { return []; }

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir       = path.join(sourceDir, e.name);
    const hasBassm  = fs.existsSync(path.join(dir, 'main.bassm'));
    const hasBnode  = fs.existsSync(path.join(dir, 'main.bnode'));
    if (!hasBassm && !hasBnode) continue;
    const cloned = fs.existsSync(path.join(projectsDir, e.name));
    out.push({ name: e.name, isVBE: hasBnode && !hasBassm, cloned });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

// Renderer → main: clone an example into the projects dir.
//
// Three flows:
//  1. Default-target free → copy straight to <projects>/<exampleName>.
//  2. Default-target exists, mode='open-existing' → open the existing
//     project, no copy.
//  3. Default-target exists, mode='copy-new' → SaveDialog defaulting to
//     <exampleName>-copy lets the user choose a unique destination.
//
// Returns the same shape as bassm:open-project — { projectDir,
// projectName, source, isVBE } — so the renderer can route it through
// _openProjectResult unchanged. Returns null when the user cancels.
ipcMain.handle('bassm:clone-example', async (_event, { exampleName, mode }) => {
  await _workspacePromise;
  if (!exampleName || typeof exampleName !== 'string') {
    throw new Error('clone-example: exampleName required');
  }
  // Guard against path traversal — exampleName is a single directory
  // name from the listing, never a path.
  if (exampleName.includes('/') || exampleName.includes('\\') || exampleName.startsWith('.')) {
    throw new Error(`clone-example: invalid exampleName "${exampleName}"`);
  }

  const sourceRoot = _examplesSourceDir();
  const sourceDir  = path.join(sourceRoot, exampleName);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`clone-example: example "${exampleName}" not found`);
  }

  const projectsDir   = _cloneTargetDir();
  fs.mkdirSync(projectsDir, { recursive: true });
  const defaultTarget = path.join(projectsDir, exampleName);
  const targetExists  = fs.existsSync(defaultTarget);

  let projectDir;

  if (targetExists && mode === 'open-existing') {
    projectDir = defaultTarget;
  } else if (targetExists || mode === 'copy-new') {
    // User wants a fresh copy; let them pick the destination name.
    const result = await dialog.showSaveDialog({
      title:        `Clone Example "${exampleName}"`,
      buttonLabel:  'Create Copy',
      defaultPath:  path.join(projectsDir, `${exampleName}-copy`),
      properties:   ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    projectDir = result.filePath;
    if (fs.existsSync(projectDir)) {
      // showOverwriteConfirmation already asked the user. Wipe and recopy.
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    _copyDirRecursive(sourceDir, projectDir);
  } else {
    // Fresh clone, no conflict — straight copy.
    _copyDirRecursive(sourceDir, defaultTarget);
    projectDir = defaultTarget;
  }

  const projectName = path.basename(projectDir);
  let source = '';
  let isVBE  = false;
  if (fs.existsSync(path.join(projectDir, 'main.bnode'))) {
    source = fs.readFileSync(path.join(projectDir, 'main.bnode'), 'utf8');
    isVBE  = true;
  } else {
    try { source = fs.readFileSync(path.join(projectDir, 'main.bassm'), 'utf8'); } catch (_) {}
  }

  startProjectWatcher(projectDir);
  return { projectDir, projectName, source, isVBE };
});

// ── Settings IPC (W-T05) ───────────────────────────────────────────────────
// All settings handlers wait on _workspacePromise so the settings module is
// guaranteed loaded; renderer-side calls return defaults if the workspace
// hasn't been configured yet (shouldn't happen — the renderer only loads
// after createWindow which awaits _workspacePromise).

ipcMain.handle('bassm:get-recent-projects', async () => {
  await _workspacePromise;
  return _settingsModule.getRecent();
});

ipcMain.handle('bassm:add-recent-project', async (_event, { name, dir }) => {
  await _workspacePromise;
  return _settingsModule.addRecent(name, dir);
});

ipcMain.handle('bassm:get-preferences', async () => {
  await _workspacePromise;
  return _settingsModule.getPreferences();
});

ipcMain.handle('bassm:set-preferences', async (_event, prefsPatch) => {
  await _workspacePromise;
  return _settingsModule.setPreferences(prefsPatch || {});
});

ipcMain.handle('bassm:get-first-run-state', async () => {
  await _workspacePromise;
  return _settingsModule.getFirstRunState();
});

ipcMain.handle('bassm:mark-first-run-complete', async () => {
  await _workspacePromise;
  _settingsModule.markFirstRunCompleted();
  return true;
});

ipcMain.handle('bassm:get-workspace-root', async () => {
  await _workspacePromise;
  return _workspaceModule.getWorkspaceRoot();
});

// Renderer → main: reveal the workspace root in the OS file manager.
// Used by the first-run modal's "Open Folder" button (W-T07).
// Returns '' on success, or an error string from shell.openPath.
ipcMain.handle('bassm:open-workspace-folder', async () => {
  await _workspacePromise;
  const root = _workspaceModule.getWorkspaceRoot();
  // In dev mode the workspace root may not exist on disk; create it on
  // demand so shell.openPath has a target. Packaged builds always have
  // it (bootstrap created it).
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return shell.openPath(root);
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

// Renderer → main: read first N bytes of a binary asset (sync IPC).
// Used by codegen to parse .tset headers at compile time.
// Accepts { projectDir: string, filename: string, bytes: number }
// Returns { ok: true, data: number[] } | { ok: false, error: string }
ipcMain.on('bassm:read-binary-header', (event, { projectDir, filename, bytes }) => {
  try {
    const base     = path.resolve(projectDir);
    const resolved = path.resolve(projectDir, filename);
    if (!resolved.startsWith(base + path.sep)) {
      throw new Error(`Asset path escapes project directory: "${filename}"`);
    }
    const fd  = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    event.returnValue = { ok: true, data: Array.from(buf) };
  } catch (err) {
    event.returnValue = { ok: false, error: err.message };
  }
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
// Used by editors (Image, Font, Sound) to load assets from the project directory.
ipcMain.handle('bassm:read-asset', (_event, { projectDir, path: relPath }) => {
  const base     = path.resolve(projectDir);
  const resolved = path.resolve(projectDir, relPath);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes project directory: "${relPath}"`);
  }
  return Array.from(fs.readFileSync(resolved));
});

// Renderer → main: write to an absolute path without a dialog.
// Accepts { path: string, data: number[] }
// Used to auto-save companion files (e.g. .pal/.imask alongside .iraw).
ipcMain.handle('bassm:save-asset-path', (_event, { path: filePath, data }) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(data));
});

// Renderer → main: show OS save dialog, then write the file.
// Accepts { defaultPath: string, filters: Array<{name,extensions}>, data: number[] }
// Returns { saved: true, filePath: string } | { saved: false }
ipcMain.handle('bassm:save-asset-dialog', async (_event, { defaultPath, filters = [], data }) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, Buffer.from(data));
  return { saved: true, filePath: result.filePath };
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

// ── File-system operations ──────────────────────────────────────────────────
// Path traversal guard: resolved target must be inside projectDir.
function _assertInProject(projectDir, relPath) {
  const base   = path.resolve(projectDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep))
    throw new Error('Path traversal rejected');
  return target;
}

ipcMain.handle('bassm:create-file', (_event, { projectDir, relPath }) => {
  const target = _assertInProject(projectDir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, '');
  return true;
});

ipcMain.handle('bassm:create-dir', (_event, { projectDir, relPath }) => {
  const target = _assertInProject(projectDir, relPath);
  fs.mkdirSync(target, { recursive: true });
  return true;
});

ipcMain.handle('bassm:delete-item', (_event, { projectDir, relPath }) => {
  const target = _assertInProject(projectDir, relPath);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else                     fs.unlinkSync(target);
  return true;
});

ipcMain.handle('bassm:rename-item', (_event, { projectDir, relPath, newName }) => {
  const base    = path.resolve(projectDir);
  const target  = _assertInProject(projectDir, relPath);
  const newPath = path.join(path.dirname(target), newName);
  if (!newPath.startsWith(base + path.sep)) throw new Error('Path traversal rejected');
  fs.renameSync(target, newPath);
  return path.relative(base, newPath).replace(/\\/g, '/');
});

ipcMain.handle('bassm:move-item', (_event, { projectDir, srcPath, destDir }) => {
  const base    = path.resolve(projectDir);
  const srcAbs  = _assertInProject(projectDir, srcPath);
  const destAbs = destDir ? _assertInProject(projectDir, destDir) : base;
  const name    = path.basename(srcAbs);
  const target  = path.join(destAbs, name);
  if (!target.startsWith(base + path.sep)) throw new Error('Path traversal rejected');
  if (target === srcAbs) return path.relative(base, target).replace(/\\/g, '/'); // no-op
  if (target.startsWith(srcAbs + path.sep)) throw new Error('Ordner kann nicht in sich selbst verschoben werden');
  if (fs.existsSync(target)) throw new Error(`"${name}" existiert bereits am Zielort`);
  fs.renameSync(srcAbs, target);
  return path.relative(base, target).replace(/\\/g, '/');
});

// ── Main window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'app', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.maximize();
  win.show();

  createEmulatorView(win);
  win.loadFile('app/index.html');

  win.on('closed', () => {});

  // DevTools only in dev (`npm start`). The packaged build must not auto-open
  // them — users hit Ctrl+Shift+I if they need to inspect.
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
    emulatorView.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

app.whenReady().then(async () => {
  // Workspace must be set up before the renderer starts hitting any path.
  await _workspacePromise;

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
