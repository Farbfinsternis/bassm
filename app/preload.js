/**
 * Electron preload script for the main app window.
 * Exposes IPC to the renderer so it can control the emulator.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send a command to the emulator (load-rom, load-exe, run, halt, reset, power-on)
  emulator: {
    send: (cmd) => ipcRenderer.send('emulator:send', cmd),
    setBounds: (bounds) => ipcRenderer.send('emulator:bounds', bounds),
  }
});
