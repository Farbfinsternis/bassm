/**
 * Electron preload script for the emulator WebContentsView.
 * Exposes a minimal IPC bridge via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Main process → Emulator: receive commands (load-rom, load-exe, run, halt, reset)
  onCommand: (callback) => {
    ipcRenderer.on('emulator:command', (_event, cmd) => callback(cmd));
  },

  // Emulator → Main process: signal ready
  ready: () => {
    ipcRenderer.send('emulator:ready');
  },

  // Emulator → Main process: report status updates
  status: (text) => {
    ipcRenderer.send('emulator:status', text);
  }
});
