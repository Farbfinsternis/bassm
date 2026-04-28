// ============================================================================
// m2-builtins.test.js — M2-T07 SSOT-Konsistenz für builtins-map.json
// ============================================================================
// Akzeptanz: editor-init.js liest die Map; codegen `_builtinHandlers` dispatched
// auf dasselbe Set. Codegen lädt die JSON nicht direkt (Browser/Node-Bridge),
// daher schließt dieser Test Drift formal über einen Set-Vergleich aus.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, test, assert, assertEqual } from './_runner.js';
import { CodeGen } from '../codegen.js';

const _here       = dirname(fileURLToPath(import.meta.url));
const _builtins   = JSON.parse(readFileSync(resolve(_here, '..', 'builtins-map.json'), 'utf8'));

describe('M2-T07 — builtins-map.json ↔ codegen._builtinHandlers Konsistenz', () => {
    test('Jede Map-Entry hat einen Codegen-Handler', () => {
        const codegen = new CodeGen();
        // _initBuiltinHandlers() wird im Konstruktor aufgerufen — Handler-Tabelle ist gesetzt.
        // (Falls nicht, hier defensiv aufrufen.)
        if (!codegen._builtinHandlers) codegen._initBuiltinHandlers();

        const missing = [];
        for (const entry of _builtins) {
            const key = entry.name.toLowerCase();
            if (typeof codegen._builtinHandlers[key] !== 'function') missing.push(entry.name);
        }
        assert(missing.length === 0,
            `Builtins in JSON ohne Handler: ${missing.join(', ')}`);
    });

    test('Jeder Codegen-Handler hat einen Map-Eintrag (umgekehrte Richtung)', () => {
        const codegen = new CodeGen();
        if (!codegen._builtinHandlers) codegen._initBuiltinHandlers();

        const mapKeys = new Set(_builtins.map(e => e.name.toLowerCase()));
        const orphan  = Object.keys(codegen._builtinHandlers).filter(k => !mapKeys.has(k));
        assert(orphan.length === 0,
            `Handler ohne Map-Eintrag: ${orphan.join(', ')}`);
    });

    test('Map enthält genau die erwarteten 22 Built-ins (Drift-Sentinel)', () => {
        // Schutz gegen versehentliches Löschen — wenn dieser Test fehlschlägt,
        // wurde absichtlich ein Builtin entfernt: die Zahl unten anpassen.
        assertEqual(_builtins.length, 22);
    });

    test('Jede Map-Entry hat Pflichtfelder name/description/snippet/type/return/args', () => {
        for (const entry of _builtins) {
            assert(typeof entry.name === 'string' && entry.name.length > 0,
                `entry without name: ${JSON.stringify(entry)}`);
            assert(typeof entry.description === 'string' && entry.description.length > 0,
                `${entry.name}: missing description`);
            assert(typeof entry.snippet === 'string' && entry.snippet.length > 0,
                `${entry.name}: missing snippet`);
            assertEqual(entry.type, 'expression', `${entry.name}: type must be "expression"`);
            assert(typeof entry.return === 'string', `${entry.name}: missing return`);
            assert(Array.isArray(entry.args), `${entry.name}: args must be array`);
        }
    });
});
