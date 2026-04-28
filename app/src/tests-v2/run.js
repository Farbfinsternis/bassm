// ============================================================================
// tests-v2/run.js — Auto-discovery test runner for the v2 test suite
// ============================================================================
//
// Walks tests-v2/ recursively, imports every *.test.js file in deterministic
// (sorted) order, then prints a single summary. Replaces the legacy `&&`-chain
// in package.json#scripts.test (which breaks on the first failure and skips the
// rest of the suite).

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { summaryAll } from './_runner.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

function* walk(dir) {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            yield* walk(full);
        } else if (st.isFile() && name.endsWith('.test.js')) {
            yield full;
        }
    }
}

const files = [...walk(ROOT)];
if (files.length === 0) {
    console.error('[tests-v2] No *.test.js files found under tests-v2/');
    process.exit(1);
}

console.log(`[tests-v2] Discovered ${files.length} test file(s)`);
for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    console.log(`\n── ${rel} ──`);
    await import(pathToFileURL(file).href);
}

summaryAll();
