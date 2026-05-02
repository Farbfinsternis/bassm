// ============================================================================
// workspace.test.js — Workspace bootstrap, examples mirror, settings (W-T09)
// ============================================================================
//
// Covers the three workspace modules end-to-end without spinning up Electron:
//   - workspace.js          — pure path helpers + configure()/_resetForTests()
//   - workspace-bootstrap.js — first-run mkdir + mirror sync
//   - workspace-settings.js  — bassm.json read/write, recents, first-run flag
//
// Each test owns a fresh tmpHome and calls workspace._resetForTests() up
// front so the module-level `_ctx` cannot leak between tests. The
// bootstrap and settings modules are stateless (they walk fs on each
// call), so a single import is enough — we only reset workspace.js.
//
// Bundle source: <repoRoot>/examples/ — the live tree on disk. Any test
// that mutates the mirror does so under <tmpHome>/BASSM/, never in the
// real repo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, assert, assertEqual, assertContains, assertThrows } from './_runner.js';

import * as ws from '../workspace.js';
import * as wb from '../workspace-bootstrap.js';
import * as st from '../workspace-settings.js';

// Resolve the repo root from this file's location (works packaged or dev).
const HERE      = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const REPO_ROOT = path.resolve(HERE, '../../..');

function makeTmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bassm-w-t09-'));
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Build a fake `resourcesPath` directory under `tmpHome` that mirrors the
 * packaged bundle layout: `<resourcesPath>/app/examples/` points at the
 * real repo's examples via a directory junction (no admin needed on
 * Windows). Returns the fake resourcesPath. Used by tests that exercise
 * the examples-mirror sync.
 */
function makeFakeResourcesPath(tmpHome) {
    const resourcesPath = path.join(tmpHome, 'fake-resources');
    fs.mkdirSync(path.join(resourcesPath, 'app'), { recursive: true });
    const target = path.join(REPO_ROOT, 'examples');
    const link   = path.join(resourcesPath, 'app', 'examples');
    if (fs.existsSync(link)) return resourcesPath; // idempotent — second configure() in same test
    try {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (_) {
        // Symlink unsupported (rare CI fallback) — just copy. Slower but works.
        fs.cpSync(target, link, { recursive: true });
    }
    return resourcesPath;
}

/** Reset workspace.js context and reconfigure with packaged + tmpHome.
 *  Defaults `resourcesPath` to a fake bundle so the examples-mirror sync
 *  finds `<resourcesPath>/app/examples/`. */
function configurePackaged(tmpHome, extra = {}) {
    ws._resetForTests();
    ws.configure({
        documentsDir: tmpHome,
        isPackaged:   true,
        resourcesPath: makeFakeResourcesPath(tmpHome),
        repoRoot:     REPO_ROOT,
        ...extra,
    });
}

/** Reset workspace.js context and reconfigure with dev + tmpHome. */
function configureDev(tmpHome, extra = {}) {
    ws._resetForTests();
    ws.configure({
        documentsDir: tmpHome,
        isPackaged:   false,
        repoRoot:     REPO_ROOT,
        ...extra,
    });
}

// ── 1. Path helpers ────────────────────────────────────────────────────────

describe('W-T09 / workspace.js — path helpers', () => {
    test('getWorkspaceRoot defaults to <Documents>/BASSM', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            assertEqual(ws.getWorkspaceRoot(), path.join(tmpHome, 'BASSM'));
            assertEqual(ws.getExamplesDir(),   path.join(tmpHome, 'BASSM', 'examples'));
            assertEqual(ws.getProjectsDir(),   path.join(tmpHome, 'BASSM', 'projects'));
            assertEqual(ws.getTmpDir(),        path.join(tmpHome, 'BASSM', 'tmp'));
            assertEqual(ws.getSettingsPath(),  path.join(tmpHome, 'BASSM', 'bassm.json'));
        } finally { cleanup(tmpHome); }
    });

    test('workspaceRootOverride wins over Documents-based default', () => {
        const tmpHome  = makeTmpHome();
        const override = path.join(tmpHome, 'custom-bassm-root');
        try {
            configurePackaged(tmpHome, { workspaceRootOverride: override });
            assertEqual(ws.getWorkspaceRoot(), override);
            assertEqual(ws.getExamplesDir(),   path.join(override, 'examples'));
        } finally { cleanup(tmpHome); }
    });

    test('settingsPathOverride routes settings to dev-isolated path', () => {
        const tmpHome  = makeTmpHome();
        const override = path.join(tmpHome, '.bassm-dev', 'bassm.json');
        try {
            configureDev(tmpHome, { settingsPathOverride: override });
            assertEqual(ws.getSettingsPath(), override);
            assertEqual(ws.isDevMode(), true);
        } finally { cleanup(tmpHome); }
    });

    test('isDevMode reflects isPackaged flag', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            assertEqual(ws.isDevMode(), false);
        } finally { cleanup(tmpHome); }
    });

    test('getter throws before configure()', () => {
        ws._resetForTests();
        assertThrows(() => ws.getWorkspaceRoot(), 'workspace not configured');
        assertThrows(() => ws.getExamplesDir(),   'workspace not configured');
    });

    test('per-project getters reject relative or non-string paths', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            assertThrows(() => ws.getProjectTmpDir(''),           'non-empty string');
            assertThrows(() => ws.getProjectTmpDir('./relative'), 'must be absolute');
            assertThrows(() => ws.getProjectAdfDir(42),           'non-empty string');
            const abs = path.join(tmpHome, 'projects', 'demo');
            assertEqual(ws.getProjectTmpDir(abs), path.join(abs, '.tmp'));
            assertEqual(ws.getProjectAdfDir(abs), path.join(abs, 'adf'));
        } finally { cleanup(tmpHome); }
    });

    test('getBundledExamplesDir requires resourcesPath in packaged mode', () => {
        const tmpHome = makeTmpHome();
        try {
            ws._resetForTests();
            ws.configure({ documentsDir: tmpHome, isPackaged: true, repoRoot: REPO_ROOT /* no resourcesPath */ });
            assertThrows(() => ws.getBundledExamplesDir(), 'resourcesPath required');
        } finally { cleanup(tmpHome); }
    });

    test('getBundledExamplesDir requires repoRoot in dev mode', () => {
        const tmpHome = makeTmpHome();
        try {
            ws._resetForTests();
            ws.configure({ documentsDir: tmpHome, isPackaged: false /* no repoRoot */ });
            assertThrows(() => ws.getBundledExamplesDir(), 'repoRoot required');
        } finally { cleanup(tmpHome); }
    });
});

// ── 2. Bootstrap ───────────────────────────────────────────────────────────

describe('W-T09 / workspace-bootstrap.js', () => {
    test('first run creates the full directory tree + bassm.json', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            const r = wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            assertEqual(r.skipped, false);
            assert(fs.existsSync(ws.getWorkspaceRoot()),  'workspace root missing');
            assert(fs.existsSync(ws.getProjectsDir()),    'projects dir missing');
            assert(fs.existsSync(ws.getTmpDir()),         'tmp dir missing');
            assert(fs.existsSync(ws.getExamplesDir()),    'examples dir missing');
            assert(fs.existsSync(ws.getSettingsPath()),   'bassm.json missing');
            const json = JSON.parse(fs.readFileSync(ws.getSettingsPath(), 'utf8'));
            assertEqual(json.firstRunCompleted, false, 'firstRunCompleted should default to false');
            assertEqual(json.version, '0.0.0-test', 'appVersion should be persisted');
        } finally { cleanup(tmpHome); }
    });

    test('bootstrap is idempotent — second call leaves user data + settings intact', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            // User project that must survive a re-bootstrap.
            const userProjDir = path.join(ws.getProjectsDir(), 'my-game');
            fs.mkdirSync(userProjDir, { recursive: true });
            fs.writeFileSync(path.join(userProjDir, 'main.bassm'), 'Graphics 320,256,4\n');
            // Mutate settings to verify they survive too.
            const settingsPath = ws.getSettingsPath();
            const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            before.recentProjects = [{ name: 'demo', dir: userProjDir, openedAt: '2026-05-01T00:00:00Z' }];
            fs.writeFileSync(settingsPath, JSON.stringify(before));

            const r2 = wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            assertEqual(r2.skipped, false);
            assertEqual(r2.created.settings, false, 'settings file should already exist on second run');
            assert(fs.existsSync(path.join(userProjDir, 'main.bassm')), 'user project file deleted by re-bootstrap');
            const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            assertEqual(after.recentProjects.length, 1, 'recentProjects must survive re-bootstrap');
            assertEqual(after.recentProjects[0].name, 'demo');
        } finally { cleanup(tmpHome); }
    });

    test('dev mode skips bootstrap entirely (no Documents/BASSM/ created)', () => {
        const tmpHome = makeTmpHome();
        try {
            configureDev(tmpHome);
            const r = wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            assertEqual(r.skipped, true);
            assertContains(r.reason, 'dev mode');
            assertEqual(fs.existsSync(path.join(tmpHome, 'BASSM')), false,
                'dev mode must not touch Documents/BASSM');
        } finally { cleanup(tmpHome); }
    });

    test('examples mirror sync copies bundle, deletes stale, leaves user files alone', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            const examplesDir = ws.getExamplesDir();

            // Bundle has a real "breakout" — verify it's mirrored.
            assert(fs.existsSync(path.join(examplesDir, 'breakout', 'main.bassm')),
                'breakout/main.bassm not mirrored');

            // Plant a stale file in target that the bundle does NOT have.
            const stalePath = path.join(examplesDir, 'old-example', 'leftover.bassm');
            fs.mkdirSync(path.dirname(stalePath), { recursive: true });
            fs.writeFileSync(stalePath, 'old data\n');

            // Plant a user file in projects/ that must NOT be touched.
            const userFile = path.join(ws.getProjectsDir(), 'my-game', 'main.bassm');
            fs.mkdirSync(path.dirname(userFile), { recursive: true });
            fs.writeFileSync(userFile, 'Graphics 320,256,4\n');

            // Re-run bootstrap → sync should delete the stale file and prune
            // the empty old-example/ directory; user project is untouched.
            const r = wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            const sync = r.examplesSync;
            assert(sync && !sync.skipped, 'sync skipped unexpectedly');
            assert(sync.deleted >= 1, `expected >=1 stale file deleted, got ${sync.deleted}`);
            assertEqual(fs.existsSync(stalePath), false, 'stale file not deleted');
            assertEqual(fs.existsSync(path.dirname(stalePath)), false, 'empty stale dir not pruned');
            assert(fs.existsSync(userFile), 'user project deleted by sync');
            assertEqual(fs.readFileSync(userFile, 'utf8'), 'Graphics 320,256,4\n');
        } finally { cleanup(tmpHome); }
    });

    test('syncExamples skips gracefully when bundle source is missing', () => {
        const tmpHome  = makeTmpHome();
        const fakeRoot = path.join(tmpHome, 'fake-repo'); // no examples/ here
        fs.mkdirSync(fakeRoot, { recursive: true });
        try {
            ws._resetForTests();
            ws.configure({ documentsDir: tmpHome, isPackaged: true, resourcesPath: fakeRoot, repoRoot: fakeRoot });
            const r = wb.syncExamples();
            assertEqual(r.skipped, true);
            assertContains(r.reason, 'bundle source missing');
        } finally { cleanup(tmpHome); }
    });
});

// ── 3. Settings ────────────────────────────────────────────────────────────

describe('W-T09 / workspace-settings.js', () => {
    test('loadSettings returns defaults when file is missing', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            const s = st.loadSettings();
            assertEqual(s.firstRunCompleted, false);
            assertEqual(s.recentProjects.length, 0);
            assertEqual(s.lastOpenedProject, null);
            assert(s.preferences && typeof s.preferences === 'object');
        } finally { cleanup(tmpHome); }
    });

    test('loadSettings recovers from corrupt JSON without throwing', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            fs.writeFileSync(ws.getSettingsPath(), '{ this is not valid json');
            const s = st.loadSettings();
            assertEqual(s.firstRunCompleted, false, 'corrupt → defaults');
            assertEqual(s.recentProjects.length, 0);
        } finally { cleanup(tmpHome); }
    });

    test('addRecent dedups, caps at 8, freshest first', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });

            for (let i = 0; i < 10; i++) {
                st.addRecent(`p${i}`, `/abs/p${i}`, `2026-05-02T00:00:0${i}Z`);
            }
            let list = st.getRecent();
            assertEqual(list.length, 8, 'should cap at 8');
            assertEqual(list[0].name, 'p9', 'freshest must be first');

            st.addRecent('p5', '/abs/p5', '2026-05-02T01:00:00Z');
            list = st.getRecent();
            assertEqual(list.length, 8, 'still capped at 8');
            assertEqual(list[0].dir, '/abs/p5', 'p5 must be at front after re-add');
            const dupCount = list.filter(r => r.dir === '/abs/p5').length;
            assertEqual(dupCount, 1, 'must dedup by dir');
        } finally { cleanup(tmpHome); }
    });

    test('first-run flag flips persistently', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            assertEqual(st.getFirstRunState(), false);
            st.markFirstRunCompleted();
            assertEqual(st.getFirstRunState(), true);
            // Simulate "app restart" by reconfiguring a fresh ctx pointing
            // at the same tmpHome → flag persisted on disk.
            configurePackaged(tmpHome);
            assertEqual(st.getFirstRunState(), true, 'must survive reconfigure');
        } finally { cleanup(tmpHome); }
    });

    test('setPreferences merges (patch semantics, does not clobber)', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            st.setPreferences({ theme: 'dark', warpFrame: 300 });
            st.setPreferences({ warpFrame: 500 }); // patch only one
            const p = st.getPreferences();
            assertEqual(p.theme, 'dark', 'theme must survive patch');
            assertEqual(p.warpFrame, 500, 'warpFrame must update');
        } finally { cleanup(tmpHome); }
    });

    test('saveSettings is atomic — tmp file is renamed, never left behind', () => {
        const tmpHome = makeTmpHome();
        try {
            configurePackaged(tmpHome);
            wb.bootstrapWorkspace({ appVersion: '0.0.0-test' });
            st.addRecent('foo', '/abs/foo');
            const settingsPath = ws.getSettingsPath();
            assert(fs.existsSync(settingsPath), 'settings file missing after save');
            assertEqual(fs.existsSync(settingsPath + '.tmp'), false, 'tmp file leaked from atomic write');
        } finally { cleanup(tmpHome); }
    });
});
