// ============================================================================
// runner.js — Minimal test framework for BASSM compiler tests
// ============================================================================

let passed = 0;
let failed = 0;

/**
 * Run a single named test.
 * @param {string}   name  Display name
 * @param {Function} fn    Test body — throws on failure
 */
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
        throw new Error(msg ?? `Expected "${sub}" in output:\n${str}`);
    }
}

/** Print suite summary and set process exit code on failure. */
export function summary(suite) {
    const status = failed === 0 ? 'OK' : 'FAILED';
    console.log(`\n[${suite}]  ${passed} passed, ${failed} failed  ${status}`);
    if (failed > 0) process.exitCode = 1;
}
