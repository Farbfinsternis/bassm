// ============================================================================
// tests-v2/_runner.js — Test framework for the v2 test suite
// ============================================================================
//
// Module-level state accumulates across all imported test files; run.js calls
// summaryAll() once at the end. Two small additions over the legacy runner:
//   - describe(name, fn)  — groups related tests under a heading
//   - assertThrows(fn, expectedMessageSubstring) — for negative compiler tests

let passed       = 0;
let failed       = 0;
let currentGroup = '(top-level)';

/** Group related tests under a heading. */
export function describe(name, fn) {
    const previous = currentGroup;
    currentGroup = name;
    console.log(`\n${name}`);
    try {
        fn();
    } finally {
        currentGroup = previous;
    }
}

/** Run a single named test. */
export function test(name, fn) {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${e.message}`);
        failed++;
    }
}

/** Throw if condition is falsy. */
export function assert(cond, msg) {
    if (!cond) throw new Error(msg ?? 'Assertion failed');
}

/** Throw if a !== b. */
export function assertEqual(a, b, msg) {
    if (a !== b) {
        throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
}

/** Throw if string does not contain substring. */
export function assertContains(str, sub, msg) {
    if (!str.includes(sub)) {
        throw new Error(msg ?? `Expected "${sub}" in output:\n${str.slice(0, 400)}…`);
    }
}

/** Throw if string does contain substring. */
export function assertNotContains(str, sub, msg) {
    if (str.includes(sub)) {
        throw new Error(msg ?? `Did not expect "${sub}" in output:\n${str.slice(0, 400)}…`);
    }
}

/**
 * Throw if fn() does NOT throw, or if the error message doesn't contain
 * `expectedMsg`. Used for negative compiler tests (Sprint-1 rules etc.).
 */
export function assertThrows(fn, expectedMsg) {
    let thrown;
    try { fn(); } catch (e) { thrown = e; }
    if (!thrown) throw new Error(`Expected throw containing "${expectedMsg}", but no error was thrown`);
    if (expectedMsg && !thrown.message.includes(expectedMsg)) {
        throw new Error(`Expected error message to contain "${expectedMsg}", got "${thrown.message}"`);
    }
}

/** Print final summary across all loaded test files. */
export function summaryAll() {
    const status = failed === 0 ? 'OK' : 'FAILED';
    console.log(`\n[tests-v2]  ${passed} passed, ${failed} failed  ${status}`);
    if (failed > 0) process.exitCode = 1;
    return failed === 0;
}
