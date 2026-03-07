// ============================================================================
// helpers.js — Shared pipeline factory for BASSM compiler tests
// ============================================================================
//
// Avoids fetch() by wiring up Lexer/Parser/CodeGen directly with the same
// command and keyword lists that the browser loads from JSON.

import { PreProcessor } from '../preprocessor.js';
import { Lexer }        from '../lexer.js';
import { Parser }       from '../parser.js';
import { CodeGen }      from '../codegen.js';

const COMMANDS = [
    'Graphics', 'Cls', 'ClsColor', 'Color', 'PaletteColor',
    'WaitVbl', 'Text', 'NPrint', 'End', 'Delay',
    'Plot', 'Line', 'Rect', 'Box',
    'WaitKey', 'ScreenFlip', 'CopperColor',
];

const KEYWORDS = [
    'If', 'Then', 'Else', 'ElseIf', 'EndIf',
    'While', 'Wend', 'For', 'To', 'Step', 'Next',
    'Select', 'Case', 'Default', 'EndSelect',
    'Dim',
];

/**
 * Returns helper functions that run the full compiler pipeline.
 * Each function accepts a Blitz2D source string.
 */
export function makePipeline() {
    const pre    = new PreProcessor();
    const lexer  = new Lexer(COMMANDS, KEYWORDS);
    const parser = new Parser();
    const codegen = new CodeGen();

    const process = src => pre.process(src);
    const tokenize = src => lexer.tokenize(process(src));
    const parse    = src => parser.parse(tokenize(src));
    const compile  = src => codegen.generate(parse(src));

    return { tokenize, parse, compile };
}
