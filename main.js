const {
  app, BrowserWindow, WebContentsView,
  ipcMain, protocol, net
} = require('electron/main');
const path = require('node:path');
const fs   = require('node:fs');

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
  if (emulatorView) {
    emulatorView.webContents.send('emulator:command', cmd);
  }
});

// Emulator → main: ready signal
ipcMain.on('emulator:ready', () => {
  console.log('[BASSM] Emulator ready');
});

// Emulator → main: status update
ipcMain.on('emulator:status', (_event, text) => {
  console.log('[BASSM] Emulator:', text);
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
