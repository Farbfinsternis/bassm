// ============================================================================
// workspace-settings.js — Read/write <workspace>/bassm.json (W-T05)
// ============================================================================
//
// Schema (current, written fresh by workspace-bootstrap.js):
//   {
//     "version":          string,
//     "workspaceRoot":    null | string,
//     "recentProjects":   [ { name, dir, openedAt } ],
//     "lastOpenedProject": null | string,
//     "firstRunCompleted": boolean,
//     "preferences":      object
//   }
//
// Reads are best-effort: a missing or corrupt file falls back to a default
// snapshot rather than throwing. Writes are atomic (tmp file + rename) so
// a crashed write never leaves a half-baked JSON behind.
//
// ESM, depends on workspace.js for the settings file path. Tests inject a
// fake workspace context (see W-T09).

import fs from 'node:fs';
import { getSettingsPath } from './workspace.js';

const RECENT_MAX = 8;

/** Snapshot of a freshly initialised settings object. */
function _defaults() {
    return {
        version: '0.0.0',
        workspaceRoot: null,
        recentProjects: [],
        lastOpenedProject: null,
        firstRunCompleted: false,
        preferences: {},
    };
}

/**
 * Read bassm.json. Missing file or parse failure → defaults (no throw).
 * Always returns a fresh object so callers can mutate without leaking.
 */
export function loadSettings() {
    const p = getSettingsPath();
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); }
    catch { return _defaults(); }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
        console.warn(`[workspace-settings] corrupt ${p} — falling back to defaults`);
        return _defaults();
    }
    return _coerce(parsed);
}

/**
 * Write a settings object atomically. Caller is responsible for passing a
 * complete shape; we coerce to schema defaults to keep the file healthy.
 */
export function saveSettings(obj) {
    const merged = _coerce(obj || {});
    const p      = getSettingsPath();
    const tmp    = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return merged;
}

// ── high-level helpers used by IPC handlers ────────────────────────────────

export function getRecent() {
    return loadSettings().recentProjects;
}

/**
 * Add a project to the recent list. Dedups by `dir`, moves freshest to
 * front, caps at RECENT_MAX. `openedAt` is set to the current ISO time
 * unless explicitly provided (test stub).
 */
export function addRecent(name, dir, openedAt) {
    if (!name || !dir) return getRecent();
    const s    = loadSettings();
    const ts   = openedAt || new Date().toISOString();
    const next = [ { name, dir, openedAt: ts },
                   ...s.recentProjects.filter(r => r.dir !== dir) ]
                 .slice(0, RECENT_MAX);
    saveSettings({ ...s, recentProjects: next });
    return next;
}

export function getPreferences() {
    return loadSettings().preferences;
}

export function setPreferences(prefsPatch) {
    const s = loadSettings();
    saveSettings({ ...s, preferences: { ...s.preferences, ...(prefsPatch || {}) } });
    return loadSettings().preferences;
}

export function getLastOpenedProject() {
    return loadSettings().lastOpenedProject;
}

export function setLastOpenedProject(dir) {
    const s = loadSettings();
    saveSettings({ ...s, lastOpenedProject: dir || null });
}

export function getFirstRunState() {
    return loadSettings().firstRunCompleted;
}

export function markFirstRunCompleted() {
    const s = loadSettings();
    saveSettings({ ...s, firstRunCompleted: true });
}

// ── schema coercion ────────────────────────────────────────────────────────

/**
 * Bring a possibly-old or partial object up to the current schema. Drops
 * unknown keys, fills missing fields with defaults, sanity-checks types.
 * Lets us add new fields in future versions without rewriting the file
 * just to read it.
 */
function _coerce(input) {
    const d = _defaults();
    const out = {
        version:           typeof input.version === 'string' ? input.version : d.version,
        workspaceRoot:     (typeof input.workspaceRoot === 'string' && input.workspaceRoot)
                            ? input.workspaceRoot : d.workspaceRoot,
        recentProjects:    Array.isArray(input.recentProjects)
                            ? input.recentProjects
                                .filter(r => r && typeof r.name === 'string' && typeof r.dir === 'string')
                                .map(r => ({
                                    name: r.name,
                                    dir:  r.dir,
                                    openedAt: typeof r.openedAt === 'string' ? r.openedAt : null,
                                }))
                                .slice(0, RECENT_MAX)
                            : [],
        lastOpenedProject: (typeof input.lastOpenedProject === 'string' && input.lastOpenedProject)
                            ? input.lastOpenedProject : null,
        firstRunCompleted: input.firstRunCompleted === true,
        preferences:       (input.preferences && typeof input.preferences === 'object' && !Array.isArray(input.preferences))
                            ? { ...input.preferences } : {},
    };
    return out;
}
