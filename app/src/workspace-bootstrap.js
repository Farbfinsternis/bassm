// ============================================================================
// workspace-bootstrap.js — First-run workspace setup (W-T02 / W-T03)
// ============================================================================
//
// Idempotent setup of <Documents>/BASSM/ on every app start in a packaged
// build. Creates the workspace directory tree, copies the bundled examples
// into the read-only mirror, and writes default settings if they don't
// exist yet. Never overwrites user data under projects/.
//
// Skipped entirely in dev mode (`npm start` from the repo) — devs work
// against the repo tree, not Documents/BASSM/.
//
// Settings persistence with full schema is W-T05.
//
// All fs operations are synchronous: bootstrap runs once at startup before
// any window is shown, and we want the workspace to exist before the
// renderer starts hitting it.

import fs   from 'node:fs';
import path from 'node:path';
import {
    isDevMode,
    getWorkspaceRoot,
    getProjectsDir,
    getTmpDir,
    getExamplesDir,
    getSettingsPath,
    getBundledExamplesDir,
} from './workspace.js';

// Schema is intentionally minimal here. T05 expands it (preferences,
// version-pinning, migration). The `version` field is filled at call time
// from package.json so we don't have a stale literal hanging around.
function _defaultSettings(version) {
    return {
        version,
        workspaceRoot: null,        // null = follow Documents/BASSM/ default
        recentProjects: [],
        lastOpenedProject: null,
        firstRunCompleted: false,   // T07 flips this once the modal was shown
        preferences: {},
    };
}

/**
 * Run workspace bootstrap.
 *
 * Pre-condition: `workspace.configure({...})` was called by the caller
 * (main.js wires it up with the live Electron `app`).
 *
 * @param {object}  [opts]
 * @param {string}  [opts.appVersion='0.0.0']  Version string written to a
 *                                              fresh bassm.json (typically
 *                                              from package.json).
 * @returns {object} Report describing what happened, useful for logs/tests:
 *   { skipped: boolean, reason?: string, root?: string,
 *     created: { root, projects, tmp, examples, settings }: boolean }
 */
export function bootstrapWorkspace(opts = {}) {
    if (isDevMode()) {
        return { skipped: true, reason: 'dev mode (app.isPackaged === false)' };
    }

    const appVersion = opts.appVersion || '0.0.0';
    const root         = getWorkspaceRoot();
    const projectsDir  = getProjectsDir();
    const tmpDir       = getTmpDir();
    const examplesDir  = getExamplesDir();
    const settingsPath = getSettingsPath();

    const created = {
        root:     !fs.existsSync(root),
        projects: !fs.existsSync(projectsDir),
        tmp:      !fs.existsSync(tmpDir),
        examples: !fs.existsSync(examplesDir),
        settings: !fs.existsSync(settingsPath),
    };

    // mkdir -p is no-op when the directory already exists, so this is
    // safe to run on every start. User-created subdirectories under
    // projects/ are untouched.
    fs.mkdirSync(root,         { recursive: true });
    fs.mkdirSync(projectsDir,  { recursive: true });
    fs.mkdirSync(tmpDir,       { recursive: true });
    fs.mkdirSync(examplesDir,  { recursive: true });

    if (created.settings) {
        const json = JSON.stringify(_defaultSettings(appVersion), null, 2);
        // Atomic-ish write: tmp + rename so a concurrent reader (unlikely
        // at startup, but cheap to guarantee) never sees a half-written file.
        const tmpPath = settingsPath + '.tmp';
        fs.writeFileSync(tmpPath, json, 'utf8');
        fs.renameSync(tmpPath, settingsPath);
    }

    // Mirror bundled examples into <workspace>/examples/.
    let examplesSync = null;
    try {
        examplesSync = syncExamples();
    } catch (err) {
        examplesSync = { skipped: true, reason: `error: ${err.message}` };
    }

    return {
        skipped: false,
        root,
        projectsDir,
        tmpDir,
        examplesDir,
        settingsPath,
        created,
        examplesSync,
    };
}

// ── Examples mirror (W-T03) ────────────────────────────────────────────────

/**
 * Mirror the bundled examples folder into <workspace>/examples/.
 * Read-only authoritative: any file present in the mirror but absent
 * in the bundle is removed; any file with different size/mtime is
 * overwritten. User edits to mirror files are discarded by design —
 * the "open example" workflow (W-T06) clones to projects/ for editing.
 *
 * @returns {object} Report:
 *   { skipped: boolean, reason?: string,
 *     sourceDir, targetDir,
 *     copied: number, unchanged: number, deleted: number,
 *     errors: Array<{ path, message }> }
 */
export function syncExamples() {
    const sourceDir = getBundledExamplesDir();
    const targetDir = getExamplesDir();

    if (!fs.existsSync(sourceDir)) {
        return { skipped: true, reason: `bundle source missing: ${sourceDir}` };
    }
    fs.mkdirSync(targetDir, { recursive: true });

    const stats = {
        skipped: false,
        sourceDir,
        targetDir,
        copied: 0,
        unchanged: 0,
        deleted: 0,
        errors: [],
    };

    const sourceRels = _walkFiles(sourceDir);
    const sourceSet  = new Set(sourceRels.map(_normRel));

    // 1. Copy / refresh files from source.
    for (const rel of sourceRels) {
        const src = path.join(sourceDir, rel);
        const dst = path.join(targetDir, rel);
        try {
            if (_filesDiffer(src, dst)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
                stats.copied++;
            } else {
                stats.unchanged++;
            }
        } catch (err) {
            stats.errors.push({ path: rel, message: err.message });
        }
    }

    // 2. Delete files in target that are no longer in source.
    const targetRels = _walkFiles(targetDir);
    for (const rel of targetRels) {
        if (sourceSet.has(_normRel(rel))) continue;
        try {
            fs.unlinkSync(path.join(targetDir, rel));
            stats.deleted++;
        } catch (err) {
            stats.errors.push({ path: rel, message: err.message });
        }
    }

    // 3. Prune now-empty directories under target so removed sub-trees
    //    don't leave behind ghost folders.
    _pruneEmptyDirs(targetDir, /* keepRoot */ true);

    return stats;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Recursively list relative paths of all *files* under `dir`. */
function _walkFiles(dir) {
    const out = [];
    function walk(rel) {
        const abs = path.join(dir, rel);
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            const childRel = rel ? path.join(rel, e.name) : e.name;
            if (e.isDirectory())      walk(childRel);
            else if (e.isFile())      out.push(childRel);
            // symlinks / sockets / fifos: skipped intentionally
        }
    }
    walk('');
    return out;
}

/** Normalise a relative path for cross-platform set membership. */
function _normRel(rel) {
    return rel.split(path.sep).join('/');
}

/**
 * Cheap "needs-copy" check: target missing → differs; size mismatch →
 * differs; mtime older than source → differs. Same-size / same-or-newer
 * mtime → assumed equal. Cheap is the point — examples are dozens of
 * files at most, full-content hashing would just slow the boot.
 */
function _filesDiffer(src, dst) {
    let dstStat;
    try { dstStat = fs.statSync(dst); }
    catch { return true; }
    const srcStat = fs.statSync(src);
    if (srcStat.size !== dstStat.size) return true;
    // mtime granularity differs across filesystems; allow ≥ source mtime
    // (target was overwritten by an older sync — that's fine).
    return dstStat.mtimeMs < srcStat.mtimeMs;
}

/**
 * Recursively remove empty directories under `dir`. Optionally keeps
 * `dir` itself even when empty (root of the mirror should remain).
 */
function _pruneEmptyDirs(dir, keepRoot) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const child = path.join(dir, e.name);
        _pruneEmptyDirs(child, false);
    }
    if (!keepRoot) {
        try {
            const remaining = fs.readdirSync(dir);
            if (remaining.length === 0) fs.rmdirSync(dir);
        } catch { /* swallow — best-effort cleanup */ }
    }
}
