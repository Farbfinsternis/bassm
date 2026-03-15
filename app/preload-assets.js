/**
 * Electron preload for the Asset Manager window.
 * Exposes assetAPI to the renderer via contextBridge.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assetAPI', {
    // Scan project directory for asset files.
    // Returns { palettes: [{name,path}], images: [{name,path}], sounds: [{name,path}] }
    listAssets: (payload) => ipcRenderer.invoke('bassm:list-assets', payload),

    // Write a converted asset file into <projectDir>/<subdir>/<filename>.
    // data must be a regular Array of bytes (Uint8Array → Array.from()).
    writeAsset: (payload) => ipcRenderer.invoke('bassm:write-asset', payload),

    // Read a binary asset file from the project directory.
    // Returns a number[] (byte array) suitable for new Uint8Array(bytes).
    readAsset: (payload) => ipcRenderer.invoke('bassm:read-asset', payload),

    // Receive project dir from the main editor window.
    // callback is called with { projectDir: string }
    onSetProject: (callback) => {
        ipcRenderer.on('assets:set-project', (_e, data) => callback(data));
    },

    // Called when any file in the project directory changes externally.
    // callback receives { filename: string } (relative path within projectDir).
    onFilesChanged: (callback) => {
        ipcRenderer.on('assets:files-changed', (_e, data) => callback(data));
    },
});
