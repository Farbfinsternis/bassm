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

    // ── Command signatures (used for completions, hover, and keyword list) ────

    const COMMAND_SIGS = [
        // Core
        { label: 'Graphics',       insertText: 'Graphics ${1:320}, ${2:256}, ${3:4}',                                      detail: 'width, height, depth',
          doc: 'Set up the display. **depth** = bitplanes (1–5), giving 2^depth colours. Must be called before any drawing.' },
        { label: 'ScreenFlip',     insertText: 'ScreenFlip',                                                                detail: '',
          doc: 'Swap front and back buffers. Call once per frame after all drawing is done. Also triggers the copper-list swap.' },
        { label: 'WaitVbl',        insertText: 'WaitVbl',                                                                   detail: '',
          doc: 'Wait for the next vertical blank without flipping buffers. Useful for timing-only synchronisation.' },
        { label: 'Delay',          insertText: 'Delay ${1:50}',                                                             detail: 'frames',
          doc: 'Pause for *frames* vertical blanks (1 frame ≈ 20 ms PAL / 17 ms NTSC).' },
        { label: 'End',            insertText: 'End',                                                                       detail: '',
          doc: 'Exit the program immediately and restore the OS.' },
        // Drawing
        { label: 'Cls',            insertText: 'Cls',                                                                       detail: '',
          doc: 'Clear the back buffer using the blitter. Fill colour is set by **ClsColor**.' },
        { label: 'ClsColor',       insertText: 'ClsColor ${1:0}',                                                           detail: 'colorIndex',
          doc: 'Set the palette index used by **Cls** to fill the background. Default is 0 (black).' },
        { label: 'Color',          insertText: 'Color ${1:1}',                                                              detail: 'paletteIndex',
          doc: 'Set the current drawing colour to a palette index (0–31). Used by Plot, Line, Rect, Box, and Text.' },
        { label: 'PaletteColor',   insertText: 'PaletteColor ${1:0}, ${2:15}, ${3:0}, ${4:0}',                              detail: 'n, r, g, b  (0–15 each)',
          doc: 'Set palette entry **n**. r, g, b are OCS 4-bit values (0–15). Takes effect at the next ScreenFlip.' },
        { label: 'CopperColor',    insertText: 'CopperColor ${1:0}, ${2:15}, ${3:0}, ${4:0}',                               detail: 'y, r, g, b  (y = scanline)',
          doc: 'Change the background colour (COLOR00) at scanline **y** via the copper. r, g, b are 0–15. Enables raster bars.' },
        { label: 'Plot',           insertText: 'Plot ${1:x}, ${2:y}',                                                       detail: 'x, y',
          doc: 'Draw a single pixel at *(x, y)* in the current colour.' },
        { label: 'Line',           insertText: 'Line ${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}',                                   detail: 'x1, y1, x2, y2',
          doc: 'Draw a line from *(x1, y1)* to *(x2, y2)* in the current colour.' },
        { label: 'Rect',           insertText: 'Rect ${1:x}, ${2:y}, ${3:w}, ${4:h}',                                       detail: 'x, y, w, h  (outline)',
          doc: 'Draw a hollow rectangle outline at *(x, y)* with the given width and height.' },
        { label: 'Box',            insertText: 'Box ${1:x}, ${2:y}, ${3:w}, ${4:h}',                                        detail: 'x, y, w, h  (filled)',
          doc: 'Draw a filled rectangle at *(x, y)* with the given width and height using the blitter.' },
        // Text
        { label: 'Text',           insertText: 'Text ${1:0}, ${2:0}, "${3:}"',                                              detail: 'x, y, string',
          doc: 'Draw a string at *(x, y)* using the current font and colour. Supports `\\n` for newlines.' },
        { label: 'LoadFont',       insertText: 'LoadFont ${1:0}, "${2:ABCDEFGHIJKLMNOPQRSTUVWXYZ}", "${3:font.raw}", ${4:8}, ${5:8}', detail: 'index, chars, file, charW, charH',
          doc: 'Load a raw font image. **chars** defines the character set order in the image; charW/charH define glyph size in pixels.' },
        { label: 'UseFont',        insertText: 'UseFont ${1:0}',                                                            detail: '[index]  — omit to reset to built-in',
          doc: 'Switch to a previously loaded font. Omit index to revert to the built-in 8×8 font.' },
        // Images & Animation
        { label: 'LoadImage',      insertText: 'LoadImage ${1:0}, "${2:image.raw}", ${3:32}, ${4:32}',                      detail: 'index, file, width, height',
          doc: 'Load a raw planar image from disk into chip RAM. width/height must match the actual image dimensions.' },
        { label: 'DrawImage',      insertText: 'DrawImage ${1:0}, ${2:x}, ${3:y}',                                          detail: 'index, x, y [, frame]',
          doc: 'Draw a loaded image at *(x, y)*. Optional **frame** selects a frame from an animation strip (0-based).' },
        { label: 'LoadAnimImage',  insertText: 'LoadAnimImage ${1:0}, "${2:anim.raw}", ${3:32}, ${4:32}, ${5:8}',           detail: 'index, file, width, height, frameCount',
          doc: 'Load an animation strip. **frameCount** sets how many frames are in the strip; each frame is width×height pixels.' },
        // Bobs
        { label: 'SetBackground',  insertText: 'SetBackground ${1:0}',                                                      detail: 'imageIndex',
          doc: 'Set the image used as the static background for Bob restore. Must be called before any DrawBob.' },
        { label: 'LoadMask',       insertText: 'LoadMask ${1:0}, "${2:sprite.mask}"',                                       detail: 'imageIndex, file',
          doc: 'Load a 1-bpp mask file for a Bob image. The mask determines which pixels are transparent during DrawBob.' },
        { label: 'DrawBob',        insertText: 'DrawBob ${1:0}, ${2:x}, ${3:y}',                                            detail: 'index, x, y [, frame]',
          doc: 'Queue a Bob (blitter object) to be drawn at *(x, y)*. Optional **frame** for animated bobs. Bobs are flushed automatically before ScreenFlip.' },
        // Sound
        { label: 'LoadSample',     insertText: 'LoadSample ${1:0}, "${2:sound.raw}"',                                       detail: 'index, file',
          doc: 'Register a raw PCM audio sample. File must be 8-bit unsigned, mono. Only declares the asset — no chip RAM is used until PlaySample.' },
        { label: 'PlaySample',     insertText: 'PlaySample ${1:0}, ${2:0}, ${3:428}, ${4:64}',                              detail: 'index, channel, period, volume',
          doc: 'Play a sample on Paula channel 0–3, looping continuously. **period** controls pitch (lower = higher pitch; 428 ≈ middle C). **volume** is 0–64.' },
        { label: 'PlaySampleOnce', insertText: 'PlaySampleOnce ${1:0}, ${2:0}, ${3:428}, ${4:64}',                          detail: 'index, channel, period, volume',
          doc: 'Play a sample once on Paula channel 0–3, then go silent. Uses the same period/volume as PlaySample.' },
        { label: 'StopSample',     insertText: 'StopSample ${1:0}',                                                         detail: 'channel  (0–3)',
          doc: 'Stop DMA playback on Paula channel 0–3 immediately.' },
        // Input
        { label: 'WaitKey',        insertText: 'WaitKey',                                                                   detail: '',
          doc: 'Halt execution until a key is pressed. Uses interrupt-driven CIA-A keyboard input.' },
        // Hardware access
        { label: 'PokeB',          insertText: 'PokeB ${1:\\$DFF180}, ${2:0}',                                              detail: 'addr, val  (8-bit write)',
          doc: 'Write an 8-bit value to an absolute hardware address. No bounds checking — direct chip register access.' },
        { label: 'PokeW',          insertText: 'PokeW ${1:\\$DFF180}, ${2:0}',                                              detail: 'addr, val  (16-bit write)',
          doc: 'Write a 16-bit value to an absolute hardware address. Address should be word-aligned.' },
        { label: 'PokeL',          insertText: 'PokeL ${1:\\$DFF000}, ${2:0}',                                              detail: 'addr, val  (32-bit write)',
          doc: 'Write a 32-bit value to an absolute hardware address. Address should be longword-aligned.' },
        { label: 'Poke',           insertText: 'Poke ${1:\\$DFF000}, ${2:0}',                                               detail: 'addr, val  (alias for PokeL)',
          doc: 'Alias for PokeL. Write a 32-bit value to an absolute hardware address.' },
        // Project
        { label: 'Include',        insertText: 'Include "${1:filename.bassm}"',                                             detail: 'filename',
          doc: 'Include and compile another BASSM source file at this point. Path is relative to the current file.' },
    ];

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
    ];

    const BUILTIN_SIGS = [
        // Hardware read
        { label: 'PeekB',            insertText: 'PeekB(${1:addr})',                                                                    detail: '(addr) → byte  (zero-extended)',
          doc: 'Read an 8-bit byte from an absolute hardware address. Result is zero-extended to 32 bits.' },
        { label: 'PeekW',            insertText: 'PeekW(${1:addr})',                                                                    detail: '(addr) → word  (sign-extended)',
          doc: 'Read a 16-bit word from an absolute hardware address. Result is sign-extended to 32 bits.' },
        { label: 'PeekL',            insertText: 'PeekL(${1:addr})',                                                                    detail: '(addr) → long',
          doc: 'Read a 32-bit longword from an absolute hardware address.' },
        // Collision
        { label: 'RectsOverlap',     insertText: 'RectsOverlap(${1:x1}, ${2:y1}, ${3:w1}, ${4:h1}, ${5:x2}, ${6:y2}, ${7:w2}, ${8:h2})', detail: '(x1,y1,w1,h1, x2,y2,w2,h2) → -1/0',
          doc: 'Test if two axis-aligned rectangles overlap. Returns **-1** (true) or **0** (false). Width/height are exclusive.' },
        { label: 'ImagesOverlap',    insertText: 'ImagesOverlap(${1:img1}, ${2:x1}, ${3:y1}, ${4:img2}, ${5:x2}, ${6:y2})',             detail: '(img1,x1,y1, img2,x2,y2) → -1/0',
          doc: 'Test if two placed images overlap using their bounding boxes. Returns **-1** (true) or **0** (false).' },
        { label: 'ImageRectOverlap', insertText: 'ImageRectOverlap(${1:img}, ${2:x}, ${3:y}, ${4:rx}, ${5:ry}, ${6:rw}, ${7:rh})',      detail: '(img,x,y, rx,ry,rw,rh) → -1/0',
          doc: 'Test if an image\'s bounding box overlaps a given rectangle. Returns **-1** (true) or **0** (false).' },
        // String / Math
        { label: 'Str$',             insertText: 'Str$(${1:n})',                                                                         detail: '(n) → string pointer (shared buffer)',
          doc: 'Convert an integer to a decimal string. Returns a pointer to a shared buffer — copy before the next call.' },
        { label: 'Rnd',              insertText: 'Rnd(${1:n})',                                                                          detail: '(n) → random 0..n-1  (n must be 1..32767)',
          doc: 'Return a pseudo-random integer in the range **0** to **n−1**. n must be between 1 and 32767.' },
        { label: 'Abs',              insertText: 'Abs(${1:n})',                                                                          detail: '(n) → absolute value',
          doc: 'Return the absolute (non-negative) value of n.' },
        // Input functions
        { label: 'KeyDown',          insertText: 'KeyDown(${1:scancode})',                                                               detail: '(scancode) → -1/0  (non-blocking)',
          doc: 'Return **-1** if the key with the given Amiga raw scancode is currently held down, **0** otherwise. Non-blocking.' },
        { label: 'JoyUp',            insertText: 'JoyUp(${1:0})',                                                                        detail: '(port) → -1/0',
          doc: 'Return **-1** if the joystick on port 0 or 1 is pushed up.' },
        { label: 'JoyDown',          insertText: 'JoyDown(${1:0})',                                                                      detail: '(port) → -1/0',
          doc: 'Return **-1** if the joystick on port 0 or 1 is pushed down.' },
        { label: 'JoyLeft',          insertText: 'JoyLeft(${1:0})',                                                                      detail: '(port) → -1/0',
          doc: 'Return **-1** if the joystick on port 0 or 1 is pushed left.' },
        { label: 'JoyRight',         insertText: 'JoyRight(${1:0})',                                                                     detail: '(port) → -1/0',
          doc: 'Return **-1** if the joystick on port 0 or 1 is pushed right.' },
        { label: 'JoyFire',          insertText: 'JoyFire(${1:0})',                                                                      detail: '(port) → -1/0  (port 0 or 1)',
          doc: 'Return **-1** if the fire button on port 0 or 1 is pressed.' },
        { label: 'MouseX',           insertText: 'MouseX()',                                                                             detail: '() → x position (0..screenW-1)',
          doc: 'Return the current mouse X position in screen pixels (0 to screenWidth−1).' },
        { label: 'MouseY',           insertText: 'MouseY()',                                                                             detail: '() → y position (0..screenH-1)',
          doc: 'Return the current mouse Y position in screen pixels (0 to screenHeight−1).' },
        { label: 'MouseDown',        insertText: 'MouseDown(${1:0})',                                                                    detail: '(button) → -1/0  (0=left, 1=right)',
          doc: 'Return **-1** if the given mouse button is currently held. 0 = left button, 1 = right button.' },
        { label: 'MouseHit',         insertText: 'MouseHit(${1:0})',                                                                     detail: '(button) → -1/0  (one-shot, clears flag)',
          doc: 'Return **-1** if the given mouse button was pressed since the last call. Clears the flag — one-shot read.' },
    ];

    // ── Blitz2D language definition ───────────────────────────────────────────
    monaco.languages.register({ id: 'blitz2d' });

    // Build flat keyword list from all sigs + control-flow keywords
    const _kwCommands = COMMAND_SIGS.map(s => s.label);
    const _kwBuiltins = BUILTIN_SIGS.map(s => s.label.replace('$', ''));  // Str$ → Str

    monaco.languages.setMonarchTokensProvider('blitz2d', {
        ignoreCase: true,
        keywords: [
            // Control flow & language structure
            'For', 'Next', 'To', 'Step',
            'While', 'Wend',
            'Repeat', 'Until',
            'If', 'Then', 'Else', 'ElseIf', 'EndIf',
            'Select', 'Case', 'Default', 'EndSelect',
            'Dim', 'Type', 'Field', 'EndType',
            'Function', 'EndFunction', 'Return',
            'Exit', 'And', 'Or', 'Xor', 'Not', 'Mod', 'Shl', 'Shr',
            // All commands
            ..._kwCommands,
            // All built-in functions
            ..._kwBuiltins,
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
    const initialContent = document.getElementById('initial-source').textContent.trim();

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
