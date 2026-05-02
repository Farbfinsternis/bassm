// ============================================================================
// workspace.js — Path helpers for the BASSM workspace (<Documents>/BASSM/)
// ============================================================================
//
// Pure path computation only. No mkdir, no fs writes, no I/O at module load
// time. Side effects (bootstrap, sync, settings persistence) belong in the
// bootstrap module (W-T02) and the settings module (W-T05).
//
// Electron's `app` is injected via configure() so this module is testable
// in plain Node without an Electron context. main.js calls
//   workspace.configure({ documentsDir, isPackaged, resourcesPath, repoRoot })
// once at startup; tests stub the same fields.
//
// ESM (app/src is a "type": "module" scope). main.js loads this via
// `await import(pathToFileURL(...))`, the same pattern already used for adf.js.

import path from 'node:path';

let _ctx = null;

// ── configure / context ─────────────────────────────────────────────────────

/**
 * Initialise the workspace module with platform context.
 * Must be called exactly once at app startup before any path getter is used.
 *
 * @param {object}  ctx
 * @param {string}  ctx.documentsDir              OS Documents folder
 *                                                 (e.g. `app.getPath('documents')`).
 * @param {boolean} ctx.isPackaged                `app.isPackaged`.
 * @param {string}  [ctx.resourcesPath]           `process.resourcesPath` —
 *                                                 required in packaged mode.
 * @param {string}  [ctx.repoRoot]                Repo root — required in dev
 *                                                 mode (so bundled-examples
 *                                                 lookup works from the source
 *                                                 tree).
 * @param {string}  [ctx.workspaceRootOverride]   Override from `bassm.json`,
 *                                                 wired up by W-T05. Null/
 *                                                 undefined falls through to
 *                                                 the Documents-based default.
 * @param {string}  [ctx.settingsPathOverride]    Absolute path to the settings
 *                                                 file. Used in dev mode to
 *                                                 keep settings out of
 *                                                 Documents/BASSM/ (per the
 *                                                 dev-isolation rule); also
 *                                                 useful for tests.
 */
export function configure(ctx) {
    if (!ctx || typeof ctx.documentsDir !== 'string' || !ctx.documentsDir) {
        throw new Error('workspace.configure: { documentsDir } is required');
    }
    _ctx = {
        documentsDir:          ctx.documentsDir,
        isPackaged:            !!ctx.isPackaged,
        resourcesPath:         ctx.resourcesPath || null,
        repoRoot:              ctx.repoRoot      || null,
        workspaceRootOverride: ctx.workspaceRootOverride || null,
        settingsPathOverride:  ctx.settingsPathOverride  || null,
    };
}

function _ctxOrThrow() {
    if (!_ctx) {
        throw new Error('workspace not configured — call workspace.configure({...}) before any getter');
    }
    return _ctx;
}

// ── primary getters ─────────────────────────────────────────────────────────

/** True when running unpacked from the repo (`!app.isPackaged`). */
export function isDevMode() {
    return !_ctxOrThrow().isPackaged;
}

/**
 * Workspace root. By default `<Documents>/BASSM/`; if a settings override
 * is configured, that absolute path wins.
 */
export function getWorkspaceRoot() {
    const c = _ctxOrThrow();
    if (c.workspaceRootOverride) return path.resolve(c.workspaceRootOverride);
    return path.join(c.documentsDir, 'BASSM');
}

export function getExamplesDir() { return path.join(getWorkspaceRoot(), 'examples'); }
export function getProjectsDir() { return path.join(getWorkspaceRoot(), 'projects'); }
export function getTmpDir()      { return path.join(getWorkspaceRoot(), 'tmp'); }
export function getSettingsPath() {
    const c = _ctxOrThrow();
    if (c.settingsPathOverride) return path.resolve(c.settingsPathOverride);
    return path.join(getWorkspaceRoot(), 'bassm.json');
}

// ── per-project paths ───────────────────────────────────────────────────────

/**
 * Build-artifact directory for a project (<projectDir>/.tmp/).
 * Replaces the previous global `os.tmpdir()` use in main.js so each project
 * keeps its own .s/.o/.exe cache.
 */
export function getProjectTmpDir(projectDir) {
    _requireAbsolute(projectDir, 'getProjectTmpDir');
    return path.join(projectDir, '.tmp');
}

/** Default location for ADF exports (<projectDir>/adf/). */
export function getProjectAdfDir(projectDir) {
    _requireAbsolute(projectDir, 'getProjectAdfDir');
    return path.join(projectDir, 'adf');
}

function _requireAbsolute(p, fn) {
    if (typeof p !== 'string' || !p) {
        throw new Error(`${fn}: projectDir must be a non-empty string`);
    }
    if (!path.isAbsolute(p)) {
        throw new Error(`${fn}: projectDir must be absolute (got "${p}")`);
    }
}

// ── bundled-examples source ─────────────────────────────────────────────────

/**
 * Absolute source path of the bundled examples folder.
 * - Packaged build: `<resourcesPath>/app/examples` (with `asar: false`,
 *   electron-builder extracts the project tree to `resources/app/`,
 *   so examples live one level deeper than `resourcesPath` itself).
 * - Dev mode:      `<repoRoot>/examples`.
 *
 * The bootstrap step (W-T03) syncs from this location into
 * `<workspaceRoot>/examples` on every app start.
 */
export function getBundledExamplesDir() {
    const c = _ctxOrThrow();
    if (c.isPackaged) {
        if (!c.resourcesPath) {
            throw new Error('workspace.getBundledExamplesDir: resourcesPath required in packaged mode');
        }
        return path.join(c.resourcesPath, 'app', 'examples');
    }
    if (!c.repoRoot) {
        throw new Error('workspace.getBundledExamplesDir: repoRoot required in dev mode');
    }
    return path.join(c.repoRoot, 'examples');
}

// ── test helpers ────────────────────────────────────────────────────────────

/** Drop the configured context. Tests only — never call from production. */
export function _resetForTests() { _ctx = null; }

/** Inspect the configured context (returns a copy). Tests only. */
export function _peekContextForTests() { return _ctx ? { ..._ctx } : null; }
