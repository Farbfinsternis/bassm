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
  assemble: (payload) => ipcRenderer.invoke('bassm:assemble', payload),
  // Load AROS ROM bytes from disk
  // Returns { main: number[], ext: number[] }
  loadRom: () => ipcRenderer.invoke('bassm:rom'),
  // Open a project folder; returns { projectDir, projectName, source } or null
  openProject: () => ipcRenderer.invoke('bassm:open-project'),
  // Save source text to <projectDir>/main.bassm
  saveSource: (payload) => ipcRenderer.invoke('bassm:save-source', payload),
  // Read an included source file from the project directory (for Include "file.bassm")
  readFile: (payload) => ipcRenderer.invoke('bassm:read-file', payload),
});
