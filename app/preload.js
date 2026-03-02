/**
 * Electron preload script for the main app window.
 * Exposes IPC to the renderer so it can control the emulator.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send a command to the emulator (load-rom, load-ext, load-exe, run, halt, reset, power-on)
  emulator: {
    send: (cmd) => ipcRenderer.send('emulator:send', cmd),
    setBounds: (bounds) => ipcRenderer.send('emulator:bounds', bounds),
  },
  // Assemble m68k source with vasmm68k_mot
  // Returns { ok: true, data: number[] } | { ok: false, error: string }
  assemble: (asmText) => ipcRenderer.invoke('bassm:assemble', asmText),
  // Load AROS ROM bytes from disk
  // Returns { main: number[], ext: number[] }
  loadRom: () => ipcRenderer.invoke('bassm:rom'),
});
