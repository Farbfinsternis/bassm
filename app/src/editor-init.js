'use strict';

// ── Monaco worker setup ───────────────────────────────────────────────────────
// Return a local file path so Monaco never creates blob: workers (CSP-safe).
window.MonacoEnvironment = {
    getWorker(_moduleId, _label) {
        return new Worker(
            new URL('../node_modules/monaco-editor/min/vs/assets/editor.worker-Be8ye1pW.js', window.location.href)
        );
    }
};

// ── AMD loader config ─────────────────────────────────────────────────────────
require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

require(['vs/editor/editor.main'], async function () {

    // ── Single source of truth: load command + keyword maps from JSON ─────────
    // S0-T02/T03 (Sprint-Ticketliste): COMMAND_SIGS, hover docs, snippets and
    // the syntax-highlighting keyword list all derive from commands-map.json /
    // keywords-map.json. No duplicate command list, no duplicate doc text and
    // no duplicate snippet table.

    const _cmdRaw      = await fetch('./src/commands-map.json').then(r => r.json());
    const _kwRaw       = await fetch('./src/keywords-map.json').then(r => r.json());
    const _builtinsRaw = await fetch('./src/builtins-map.json').then(r => r.json());

    // Defensive fallback: if a future command is added to commands-map.json
    // without a `snippet` field, derive one from the args list so completions
    // still work. Required args become `${N:name}` placeholders; string args
    // get wrapped in quotes; optional args are dropped from the default form.
    function _autoSnippet(entry) {
        const required = entry.args.filter(a => !a.optional);
        if (required.length === 0) return entry.name;
        const ph = required.map((a, i) =>
            a.type === 'string' ? `"\${${i+1}:${a.name}}"` : `\${${i+1}:${a.name}}`);
        return `${entry.name} ${ph.join(', ')}`;
    }

    function _formatDetail(entry) {
        if (entry.args.length === 0) return '';
        return entry.args.map(a => a.optional ? `[${a.name}]` : a.name).join(', ');
    }

    const COMMAND_SIGS = _cmdRaw.map(entry => ({
        label:      entry.name,
        insertText: entry.snippet || _autoSnippet(entry),
        detail:     _formatDetail(entry),
        doc:        entry.description,
    }));

    // Include is a preprocessor directive (not in commands-map.json) — kept here.
    COMMAND_SIGS.push({
        label:      'Include',
        insertText: 'Include "${1:filename.bassm}"',
        detail:     'filename',
        doc:        'Include and compile another BASSM source file at this point. Path is relative to the current file.',
    });

    // ── Control-flow keyword snippets ─────────────────────────────────────────
    // Multi-line templates for structural keywords — shown alongside commands.

    const KEYWORD_SNIPPETS = [
        {
            label:       'For/Next',
            filterText:  'For',
            insertText:  'For ${1:i} = ${2:0} To ${3:n}\n  ${4}\nNext',
            detail:      'i = from To n [Step s]',
        },
        {
            label:       'While/Wend',
            filterText:  'While',
            insertText:  'While ${1:condition}\n  ${2}\nWend',
            detail:      'condition',
        },
        {
            label:       'Repeat/Until',
            filterText:  'Repeat',
            insertText:  'Repeat\n  ${1}\nUntil ${2:condition}',
            detail:      'body runs at least once',
        },
        {
            label:       'If/EndIf',
            filterText:  'If',
            insertText:  'If ${1:condition}\n  ${2}\nEndIf',
            detail:      'condition',
        },
        {
            label:       'If/Else/EndIf',
            filterText:  'If',
            insertText:  'If ${1:condition}\n  ${2}\nElse\n  ${3}\nEndIf',
            detail:      'condition / Else',
        },
        {
            label:       'If/ElseIf/EndIf',
            filterText:  'If',
            insertText:  'If ${1:cond1}\n  ${2}\nElseIf ${3:cond2}\n  ${4}\nEndIf',
            detail:      'condition / ElseIf chain',
        },
        {
            label:       'Select/EndSelect',
            filterText:  'Select',
            insertText:  'Select ${1:expr}\n  Case ${2:0}\n    ${3}\n  Default\n    ${4}\nEndSelect',
            detail:      'expr',
        },
        {
            label:       'Function (value)',
            filterText:  'Function',
            insertText:  'Function ${1:Name}(${2:a}, ${3:b})\n  ${4}\n  Return ${5:0}\nEndFunction',
            detail:      'Name(args) — returns a value',
        },
        {
            label:       'Function (procedure)',
            filterText:  'Function',
            insertText:  'Function ${1:Name} ${2:a}, ${3:b}\n  ${4}\nEndFunction',
            detail:      'Name args — no return value',
        },
        {
            label:       'Type/EndType',
            filterText:  'Type',
            insertText:  'Type ${1:Name}\n  Field ${2:x}\n  Field ${3:y}\nEndType',
            detail:      'struct definition',
        },
        {
            label:       'Dim (1D)',
            filterText:  'Dim',
            insertText:  'Dim ${1:arr}(${2:9})',
            detail:      'name(maxIndex)',
        },
        {
            label:       'Dim (2D)',
            filterText:  'Dim',
            insertText:  'Dim ${1:map}(${2:19}, ${3:14})',
            detail:      'name(width, height)',
        },
        {
            label:       'Const',
            filterText:  'Const',
            insertText:  'Const ${1:NAME} = ${2:0}',
            detail:      'NAME = value  — compile-time constant, no BSS',
        },
        {
            label:       'Data',
            filterText:  'Data',
            insertText:  'Data ${1:0}, ${2:0}',
            detail:      'val1, val2, ...  — static data table (no runtime cost)',
        },
        {
            label:       'Read',
            filterText:  'Read',
            insertText:  'Read ${1:variable}',
            detail:      'variable  — read next value from Data table',
        },
        {
            label:       'Restore',
            filterText:  'Restore',
            insertText:  'Restore',
            detail:      '— reset Data pointer to beginning',
        },
    ];

    // M2-T07: Built-in expression-functions are now in builtins-map.json (SSOT).
    // `detail` is the short signature/return-shape; `description` is the hover doc.
    // Auto-snippet for entries without an explicit one (none in v1, defensive).
    function _autoBuiltinSnippet(entry) {
        if (entry.args.length === 0) return `${entry.name}()`;
        const ph = entry.args.map((a, i) => `\${${i+1}:${a.name}}`);
        return `${entry.name}(${ph.join(', ')})`;
    }

    const BUILTIN_SIGS = _builtinsRaw.map(entry => ({
        label:      entry.name,
        insertText: entry.snippet || _autoBuiltinSnippet(entry),
        detail:     entry.detail || '',
        doc:        entry.description,
    }));

    // ── Blitz2D language definition ───────────────────────────────────────────
    monaco.languages.register({ id: 'blitz2d' });

    // Build flat keyword list from all sigs + control-flow keywords
    const _kwCommands = COMMAND_SIGS.map(s => s.label);
    const _kwBuiltins = BUILTIN_SIGS.map(s => s.label.replace('$', ''));  // Str$ → Str

    monaco.languages.setMonarchTokensProvider('blitz2d', {
        ignoreCase: true,
        keywords: [
            ..._kwRaw,        // Control-flow / declaration keywords from keywords-map.json
            ..._kwCommands,   // Commands from commands-map.json
            ..._kwBuiltins,   // Built-in functions (BUILTIN_SIGS — see M2-T07)
        ],
        tokenizer: {
            root: [
                [/;.*$/,            'comment'],
                [/"[^"]*"/,         'string'],
                [/\$[0-9A-Fa-f]+/,  'number'],
                [/\b\d+\b/,         'number'],
                [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
                [/[=+\-*\/<>\\]/,   'operator'],
            ]
        }
    });

    // ── Completion provider ───────────────────────────────────────────────────
    monaco.languages.registerCompletionItemProvider('blitz2d', {
        provideCompletionItems(model, position) {
            const word  = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber:   position.lineNumber,
                startColumn:     word.startColumn,
                endColumn:       word.endColumn,
            };

            const toItem = (s, kind) => ({
                label:           s.label,
                kind,
                detail:          s.detail,
                insertText:      s.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
            });

            return {
                suggestions: [
                    ...COMMAND_SIGS.map(s => toItem(s, monaco.languages.CompletionItemKind.Function)),
                    ...BUILTIN_SIGS.map(s => toItem(s, monaco.languages.CompletionItemKind.Function)),
                    ...KEYWORD_SNIPPETS.map(s => ({
                        label:           s.label,
                        filterText:      s.filterText,
                        kind:            monaco.languages.CompletionItemKind.Keyword,
                        detail:          s.detail,
                        insertText:      s.insertText,
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        range,
                    })),
                ],
            };
        }
    });

    // ── Hover provider ────────────────────────────────────────────────────────
    // Build a lookup map: lowercase label → sig entry (handles Str$ → "str$" or "str")
    const _hoverMap = new Map();
    for (const s of [...COMMAND_SIGS, ...BUILTIN_SIGS]) {
        _hoverMap.set(s.label.toLowerCase(), s);
        // Also register without $ so hovering on "Str" matches "Str$"
        const noSign = s.label.replace('$', '').toLowerCase();
        if (noSign !== s.label.toLowerCase()) _hoverMap.set(noSign, s);
    }

    monaco.languages.registerHoverProvider('blitz2d', {
        provideHover(model, position) {
            const word = model.getWordAtPosition(position);
            if (!word) return null;

            // Check if the character immediately after the word is '$' (e.g. Str$)
            let name = word.word;
            const lineText  = model.getLineContent(position.lineNumber);
            const charAfter = lineText[word.endColumn - 1];  // endColumn is 1-based exclusive
            if (charAfter === '$') name += '$';

            const sig = _hoverMap.get(name.toLowerCase());
            if (!sig) return null;

            // Build signature line: CommandName detail
            const sigText = sig.detail
                ? `**${sig.label}** *${sig.detail}*`
                : `**${sig.label}**`;

            const contents = [{ value: sigText }];
            if (sig.doc) contents.push({ value: sig.doc });

            return {
                range: new monaco.Range(
                    position.lineNumber, word.startColumn,
                    position.lineNumber, word.endColumn,
                ),
                contents,
            };
        }
    });

    // ── Theme ─────────────────────────────────────────────────────────────────
    monaco.editor.defineTheme('bassm-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment',    foreground: '608060', fontStyle: 'italic' },
            { token: 'keyword',    foreground: '569cd6', fontStyle: 'bold'   },
            { token: 'string',     foreground: 'ce9178' },
            { token: 'number',     foreground: 'b5cea8' },
            { token: 'operator',   foreground: 'cccccc' },
            { token: 'identifier', foreground: 'd4d4d4' },
        ],
        colors: {
            'editor.background':                '#111111',
            'editorLineNumber.foreground':       '#444444',
            'editorLineNumber.activeForeground': '#888888',
            'editorCursor.foreground':           '#aeafad',
            'editor.lineHighlightBackground':    '#1a1a1a',
            'editorGutter.background':           '#111111',
        }
    });

    // ── Create editor ─────────────────────────────────────────────────────────
    const initialContent = '';

    window._monacoEditor = monaco.editor.create(document.getElementById('editor'), {
        value:                initialContent,
        language:             'blitz2d',
        theme:                'bassm-dark',
        fontSize:             13,
        fontFamily:           '"Fira Code", Consolas, "Courier New", monospace',
        fontLigatures:        true,
        lineNumbers:          'on',
        glyphMargin:          true,    // required for color swatch decorations
        minimap:              { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout:      true,
        tabSize:              2,
        insertSpaces:         true,
        renderWhitespace:     'none',
        overviewRulerLanes:   0,
    });

    // ── Color swatch decorations ── BUG-8: nicht funktionsfähig, siehe ROADMAP.md
});
