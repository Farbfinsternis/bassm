// ============================================================================
// m2-budget.test.js — M2-T08 budget.js JSON-getriebene Analyse
// ============================================================================
// Akzeptanz: Budget-Werte korrekt für alle Asset-Commands; Signaturwechsel
// automatisch erfasst. Tests:
//   1. budget-costs.json ist konsistent mit commands-map.json (keine
//      Phantom-Einträge, jeder Cost-Eintrag matched einen echten Command).
//   2. Schema-Validierung für jeden Cost-Eintrag.
//   3. analyzeBudget liefert sinnvolle Werte für ein Programm, das alle
//      Cost-Kinds mindestens einmal benutzt.
//   4. Unbekannte (in JSON noch nicht annotierte) Commands fallen auf den
//      generischen 15-Zyklen-Default — kein Crash.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, test, assert, assertEqual } from './_runner.js';
import { analyzeBudget, CYCLES_FRAME, CHIP_RAM_BYTES } from '../budget.js';

const _here     = dirname(fileURLToPath(import.meta.url));
const _commands = JSON.parse(readFileSync(resolve(_here, '..', 'commands-map.json'), 'utf8'));
const _costs    = JSON.parse(readFileSync(resolve(_here, '..', 'budget-costs.json'), 'utf8'));

const _commandNames = new Set(_commands.map(c => c.name));
const _costEntries  = Object.entries(_costs).filter(([k]) => !k.startsWith('_'));

describe('M2-T08 — budget-costs.json ↔ commands-map.json Konsistenz', () => {
    test('Jeder Cost-Eintrag matched einen Command-Namen (keine Phantome)', () => {
        const phantoms = _costEntries
            .map(([name]) => name)
            .filter(name => !_commandNames.has(name));
        assert(phantoms.length === 0,
            `Cost entries without matching command: ${phantoms.join(', ')}`);
    });

    test('Schema: jeder Cost-Eintrag hat kind ∈ {fixed,init,screen,rect,outline,image,bob,text}', () => {
        const ALLOWED = new Set(['fixed', 'init', 'screen', 'rect', 'outline', 'image', 'bob', 'text']);
        for (const [name, cost] of _costEntries) {
            assert(ALLOWED.has(cost.kind),
                `${name}: invalid kind "${cost.kind}" (allowed: ${[...ALLOWED].join(', ')})`);
            if (cost.kind === 'fixed') {
                assert(typeof cost.cycles === 'number',
                    `${name}: kind=fixed requires numeric cycles`);
            }
            if (['screen', 'rect', 'outline', 'image', 'bob', 'text'].includes(cost.kind)) {
                assert(typeof cost.factor === 'number' && cost.factor > 0,
                    `${name}: kind=${cost.kind} requires positive numeric factor`);
            }
        }
    });

    test('Sentinel: alle Commands haben einen Cost-Eintrag (keine stille Drift)', () => {
        // Wenn Commands fehlen, neuen Eintrag in budget-costs.json hinzufügen
        // ODER hier explizit als bewusst-ungetagged markieren. Default-Verhalten
        // (15 cycles) ist OK; das Sentinel zwingt zur bewussten Entscheidung.
        const annotated = new Set(_costEntries.map(([n]) => n));
        const missing = [...(_commandNames)].filter(n => !annotated.has(n));
        assertEqual(missing.length, 0,
            `Commands without budget annotation: ${missing.join(', ')}`);
    });
});

describe('M2-T08 — analyzeBudget Verhalten', () => {
    test('Programm ohne Graphics → null', () => {
        assertEqual(analyzeBudget('Print "hi"\n'), null);
    });

    test('Smoke: Graphics + leere Loop → null cycles, korrektes Chip-RAM', () => {
        const src = 'Graphics 320,256,4\nWhile 0=0\nScreenFlip\nWend\n';
        const r   = analyzeBudget(src);
        assert(r !== null, 'expected non-null result');
        assertEqual(r.cyclesTotal, CYCLES_FRAME);
        assertEqual(r.chipRamTotal, CHIP_RAM_BYTES);
        // 320×256×4 double-buffered = 2 × 4 × 40 × 256 = 81,920 bytes
        assertEqual(r.chipRamUsed, 2 * 4 * Math.ceil(320 / 16) * 2 * 256);
    });

    test('Loop mit ScreenFlip + Cls + Box ergibt cycles > 0', () => {
        const src = 'Graphics 320,256,4\n' +
                    'While 0=0\n' +
                    'Cls\nBox 10,10,32,32\nScreenFlip\n' +
                    'Wend\n';
        const r = analyzeBudget(src);
        assert(r.cyclesUsed > 0, `expected cycles > 0, got ${r.cyclesUsed}`);
    });

    test('LoadImage flagged Chip-RAM als + (Header-Größe nicht parseable)', () => {
        const src = 'Graphics 320,256,4\nLoadImage 0,"x.iraw"\n' +
                    'While 0=0\nScreenFlip\nWend\n';
        const r = analyzeBudget(src);
        assertEqual(r.chipRamPlus, true);
    });

    test('DrawTilemap kostet 70000 cycles (fixed)', () => {
        const src = 'Graphics 320,256,4\n' +
                    'While 0=0\nDrawTilemap 0,0,0,0\nScreenFlip\nWend\n';
        const r = analyzeBudget(src);
        // DrawTilemap=70000 + ScreenFlip=800 = 70800
        assert(r.cyclesUsed >= 70000,
            `expected >=70000 cycles for DrawTilemap, got ${r.cyclesUsed}`);
    });

    test('Generischer Statement (assignment) bekommt 15 cycles', () => {
        const src = 'Graphics 320,256,4\n' +
                    'While 0=0\nx=5\nScreenFlip\nWend\n';
        const r = analyzeBudget(src);
        // x=5 → 15 cycles, ScreenFlip → 800 cycles = 815
        assertEqual(r.cyclesUsed, 815);
    });

    test('Unbekannter Identifier (User-Funktion) fällt auf 15 cycles, kein Crash', () => {
        const src = 'Graphics 320,256,4\n' +
                    'While 0=0\nMyFunc()\nScreenFlip\nWend\n';
        const r = analyzeBudget(src);
        assertEqual(r.cyclesUsed, 815);  // 15 + 800
    });
});
