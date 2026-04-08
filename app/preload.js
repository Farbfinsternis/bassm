/**
 * Electron preload script for the main app window.
 * Exposes IPC to the renderer so it can control the emulator.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  version: ipcRenderer.sendSync('bassm:get-version'),
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
  // Create a new project folder via Save dialog; returns { projectDir, projectName, source } or null
  newProject: (payload) => ipcRenderer.invoke('bassm:new-project', payload),
  // Open a project folder; returns { projectDir, projectName, source } or null
  openProject: () => ipcRenderer.invoke('bassm:open-project'),
  // Open a project by path (recent list); returns { projectDir, projectName, source } or null
  openProjectDir: ({ dir }) => ipcRenderer.invoke('bassm:open-project-dir', { dir }),
  // Save source text to <projectDir>/main.bassm
  saveSource: (payload) => ipcRenderer.invoke('bassm:save-source', payload),
  // Read an included source file from the project directory (for Include "file.bassm")
  readFile: (payload) => ipcRenderer.invoke('bassm:read-file', payload),
  // Read first N bytes of a binary asset (sync, for .tset header parsing at compile time)
  readBinaryHeader: (payload) => ipcRenderer.sendSync('bassm:read-binary-header', payload),
  // Show OS save dialog and write binary file. { defaultPath, filters, data: number[] } → { saved, filePath? }
  saveAssetWithDialog: (payload) => ipcRenderer.invoke('bassm:save-asset-dialog', payload),
  // List all .bassm files in the project directory; returns string[]
  listFiles: (payload) => ipcRenderer.invoke('bassm:list-files', payload),
  // Read a binary asset file from the project directory. Returns number[] (byte array).
  readAsset: (payload) => ipcRenderer.invoke('bassm:read-asset', payload),
  // Write a file to an absolute path without showing a dialog. { path, data: number[] }
  saveAsset: (payload) => ipcRenderer.invoke('bassm:save-asset-path', payload),
  // File-system operations for the project tree
  createFile: (payload) => ipcRenderer.invoke('bassm:create-file', payload),
  createDir:  (payload) => ipcRenderer.invoke('bassm:create-dir',  payload),
  deleteItem: (payload) => ipcRenderer.invoke('bassm:delete-item', payload),
  renameItem: (payload) => ipcRenderer.invoke('bassm:rename-item', payload),
  moveItem:   (payload) => ipcRenderer.invoke('bassm:move-item',   payload),
  // Called when any file in the project directory changes externally.
  // callback receives { filename: string } (relative path within projectDir).
  onFilesChanged: (callback) => {
    ipcRenderer.on('project:files-changed', (_e, data) => callback(data));
  },
});
