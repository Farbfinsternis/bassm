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
  // Create bootable ADF, show save dialog, write to disk
  // { projectName, projectDir?, exeData: number[] } → { ok, filePath?, error?, cancelled? }
  createAdf: (payload) => ipcRenderer.invoke('bassm:create-adf', payload),
  // Load AROS ROM bytes from disk
  // Returns { main: number[], ext: number[] }
  loadRom: () => ipcRenderer.invoke('bassm:rom'),
  // Create a new project folder via Save dialog; returns { projectDir, projectName, source } or null
  newProject: (payload) => ipcRenderer.invoke('bassm:new-project', payload),
  // Create a temporary scratch project under <workspace>/tmp/ (no dialog).
  // Returns { projectDir, projectName, source, isVBE, isScratch: true }.
  newScratchProject: () => ipcRenderer.invoke('bassm:new-scratch-project'),
  // Open a project folder; returns { projectDir, projectName, source } or null
  openProject: () => ipcRenderer.invoke('bassm:open-project'),
  // Open a project by path (recent list); returns { projectDir, projectName, source } or null
  openProjectDir: ({ dir }) => ipcRenderer.invoke('bassm:open-project-dir', { dir }),
  // List clonable examples; returns Array<{ name, isVBE }>.
  listExamples: () => ipcRenderer.invoke('bassm:list-examples'),
  // Clone (or open) an example. mode: undefined=auto-clone, 'open-existing'=open
  // the already-cloned copy, 'copy-new'=force a fresh copy via SaveDialog.
  // Returns { projectDir, projectName, source, isVBE } or null on cancel.
  cloneExample: (payload) => ipcRenderer.invoke('bassm:clone-example', payload),
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

  // ── Settings IPC (W-T05) — talks to <workspace>/bassm.json ──────────
  // Recent projects: array of { name, dir, openedAt? }, freshest first, max 8.
  getRecentProjects: () => ipcRenderer.invoke('bassm:get-recent-projects'),
  addRecentProject:  (payload) => ipcRenderer.invoke('bassm:add-recent-project', payload),
  // Preferences: free-form object merged on set (patch semantics).
  getPreferences:    () => ipcRenderer.invoke('bassm:get-preferences'),
  setPreferences:    (patch) => ipcRenderer.invoke('bassm:set-preferences', patch),
  // First-run modal hooks (consumed by W-T07).
  getFirstRunState:        () => ipcRenderer.invoke('bassm:get-first-run-state'),
  markFirstRunComplete:    () => ipcRenderer.invoke('bassm:mark-first-run-complete'),
  // Where the workspace lives — useful for the first-run modal and "open folder" buttons.
  getWorkspaceRoot:  () => ipcRenderer.invoke('bassm:get-workspace-root'),
  // Reveal the workspace root in the OS file manager (W-T07).
  openWorkspaceFolder: () => ipcRenderer.invoke('bassm:open-workspace-folder'),
});
