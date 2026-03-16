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

require(['vs/editor/editor.main'], function () {

    // ── Blitz2D language definition ───────────────────────────────────────────
    monaco.languages.register({ id: 'blitz2d' });

    monaco.languages.setMonarchTokensProvider('blitz2d', {
        ignoreCase: true,
        keywords: [
            'For', 'Next', 'To', 'Step',
            'While', 'Wend',
            'Repeat', 'Until',
            'If', 'Then', 'Else', 'ElseIf', 'EndIf',
            'Select', 'Case', 'Default', 'EndSelect',
            'Dim', 'Type', 'Field', 'EndType',
            'Function', 'EndFunction', 'Return',
            'Exit', 'And', 'Or', 'Xor', 'Not', 'Mod', 'Shl', 'Shr',
            'Graphics', 'Color', 'Cls', 'ClsColor',
            'Box', 'Line', 'Rect', 'Plot', 'Text',
            'ScreenFlip', 'PaletteColor', 'CopperColor',
            'LoadSample', 'PlaySample', 'PlaySampleOnce', 'StopSample',
            'LoadImage', 'DrawImage',
            'WaitKey', 'Include',
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
            'editor.background':              '#111111',
            'editorLineNumber.foreground':     '#444444',
            'editorLineNumber.activeForeground': '#888888',
            'editorCursor.foreground':         '#aeafad',
            'editor.lineHighlightBackground':  '#1a1a1a',
        }
    });

    // ── Create editor ─────────────────────────────────────────────────────────
    const initialContent = document.getElementById('initial-source').textContent.trim();

    window._monacoEditor = monaco.editor.create(document.getElementById('editor'), {
        value:                initialContent,
        language:             'blitz2d',
        theme:                'bassm-dark',
        fontSize:             13,
        fontFamily:           'Consolas, "Courier New", monospace',
        lineNumbers:          'on',
        minimap:              { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout:      true,
        tabSize:              2,
        insertSpaces:         true,
        renderWhitespace:     'none',
        overviewRulerLanes:   0,
    });
});
