// ============================================================================
// lexer.js — BASSM Blitz2D Tokeniser
// ============================================================================
//
// Converts a pre-processed Blitz2D source string into a flat array of tokens.
//
// TOKEN TYPES (exported as TT)
//   KEYWORD  — control-flow reserved words: If, Then, While, For, …
//   COMMAND  — Blitz2D built-in commands:   Graphics, Cls, Color, …
//   IDENT    — user identifiers / variable names
//   INT      — integer literal (decimal, $hex, %binary)
//   FLOAT    — floating-point literal
//   STRING   — string literal (contents without enclosing quotes)
//   COMMA    — ,
//   LPAREN   — (
//   RPAREN   — )
//   PLUS / MINUS / STAR / SLASH
//   EQ / LT / GT / LTE / GTE / NEQ
//   NEWLINE  — logical statement separator (consecutive newlines → one token)
//   EOF      — end of input
//
// BLITZ2D RULES OBSERVED
//   • All keywords and command names are case-insensitive.
//   • Identifiers preserve their original casing.
//   • Integer literals: 42  $1A  %1010
//   • Comments (; …) are stripped by the PreProcessor before lexing.
//   • Statements are separated by newlines — no semicolons as separators.
// ============================================================================

// ── Token type constants ─────────────────────────────────────────────────────

export const TT = Object.freeze({
    KEYWORD : 'KEYWORD',
    COMMAND : 'COMMAND',
    IDENT   : 'IDENT',
    INT     : 'INT',
    FLOAT   : 'FLOAT',
    STRING  : 'STRING',
    COMMA   : 'COMMA',
    LPAREN  : 'LPAREN',
    RPAREN  : 'RPAREN',
    PLUS    : 'PLUS',
    MINUS   : 'MINUS',
    STAR    : 'STAR',
    SLASH   : 'SLASH',
    EQ      : 'EQ',
    LT      : 'LT',
    GT      : 'GT',
    LTE     : 'LTE',
    GTE     : 'GTE',
    NEQ     : 'NEQ',
    NEWLINE   : 'NEWLINE',
    EOF       : 'EOF',
    DOT       : 'DOT',
    BACKSLASH : 'BACKSLASH',
});

// ── Lexer class ──────────────────────────────────────────────────────────────

export class Lexer {

    /**
     * @param {string[]} commandNames  Command names from commands-map.json
     * @param {string[]} keywordNames  Keyword names from keywords-map.json
     */
    constructor(commandNames, keywordNames) {
        // Store both sets as lowercase for case-insensitive matching
        this._commands = new Set(commandNames.map(n => n.toLowerCase()));
        this._keywords = new Set(keywordNames.map(n => n.toLowerCase()));
    }

    /**
     * Tokenise a pre-processed Blitz2D source string.
     *
     * @param {string} source
     * @returns {{ type: string, value: *, line: number }[]}
     */
    tokenize(source) {
        this._src    = source;
        this._pos    = 0;
        this._line   = 1;
        this._tokens = [];

        while (this._pos < this._src.length) {
            this._readNext();
        }

        this._emit(TT.EOF, null);
        return this._tokens;
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    _emit(type, value) {
        this._tokens.push({ type, value, line: this._line });
    }

    _cur()  { return this._src[this._pos]; }
    _peek1(){ return this._src[this._pos + 1]; }

    // ── Main dispatch ────────────────────────────────────────────────────────

    _readNext() {
        const c = this._cur();

        // ── Whitespace (horizontal) — skip silently ──────────────────────────
        if (c === ' ' || c === '\t' || c === '\r') {
            this._pos++;
            return;
        }

        // ── Newline — emit one NEWLINE token per logical break ───────────────
        if (c === '\n') {
            const last = this._tokens[this._tokens.length - 1];
            if (!last || last.type !== TT.NEWLINE) {
                this._emit(TT.NEWLINE, '\n');
            }
            this._line++;
            this._pos++;
            return;
        }

        // ── String literal  "…" ─────────────────────────────────────────────
        if (c === '"') {
            this._readString();
            return;
        }

        // ── Hex literal  $FF ─────────────────────────────────────────────────
        if (c === '$') {
            this._pos++;
            let hex = '';
            while (this._pos < this._src.length && /[0-9a-fA-F]/.test(this._cur())) {
                hex += this._src[this._pos++];
            }
            this._emit(TT.INT, parseInt(hex || '0', 16));
            return;
        }

        // ── Binary literal  %1010 ────────────────────────────────────────────
        if (c === '%') {
            this._pos++;
            let bin = '';
            while (this._pos < this._src.length && (this._cur() === '0' || this._cur() === '1')) {
                bin += this._src[this._pos++];
            }
            this._emit(TT.INT, parseInt(bin || '0', 2));
            return;
        }

        // ── Decimal integer or float ─────────────────────────────────────────
        if (c >= '0' && c <= '9') {
            this._readNumber();
            return;
        }

        // ── Identifier / keyword / command ───────────────────────────────────
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
            this._readWord();
            return;
        }

        // ── Operators and punctuation ────────────────────────────────────────
        this._readSymbol();
    }

    // ── Token readers ────────────────────────────────────────────────────────

    _readString() {
        this._pos++; // skip opening "
        let s = '';
        while (this._pos < this._src.length && this._cur() !== '"' && this._cur() !== '\n') {
            s += this._src[this._pos++];
        }
        if (this._cur() === '"') this._pos++; // skip closing "
        this._emit(TT.STRING, s);
    }

    _readNumber() {
        let num = '';
        while (this._pos < this._src.length && this._cur() >= '0' && this._cur() <= '9') {
            num += this._src[this._pos++];
        }
        // Check for decimal point (float)
        if (this._cur() === '.' && this._peek1() >= '0' && this._peek1() <= '9') {
            num += this._src[this._pos++]; // consume '.'
            while (this._pos < this._src.length && this._cur() >= '0' && this._cur() <= '9') {
                num += this._src[this._pos++];
            }
            this._emit(TT.FLOAT, parseFloat(num));
        } else {
            this._emit(TT.INT, parseInt(num, 10));
        }
    }

    _readWord() {
        let word = '';
        while (
            this._pos < this._src.length &&
            (   (this._cur() >= 'a' && this._cur() <= 'z') ||
                (this._cur() >= 'A' && this._cur() <= 'Z') ||
                (this._cur() >= '0' && this._cur() <= '9') ||
                this._cur() === '_'
            )
        ) {
            word += this._src[this._pos++];
        }

        // Consume Blitz2D string-function suffix $ (e.g. Str$(n) → ident "str$")
        if (this._pos < this._src.length && this._cur() === '$') {
            word += '$';
            this._pos++;
        }

        const lower = word.toLowerCase();
        if (this._keywords.has(lower))     this._emit(TT.KEYWORD, lower);
        else if (this._commands.has(lower)) this._emit(TT.COMMAND, lower);
        else                                this._emit(TT.IDENT,   word);
    }

    _readSymbol() {
        const c = this._cur();
        this._pos++;

        switch (c) {
            case ',': this._emit(TT.COMMA,  ','); break;
            case '(': this._emit(TT.LPAREN, '('); break;
            case ')': this._emit(TT.RPAREN, ')'); break;
            case '+': this._emit(TT.PLUS,   '+'); break;
            case '-': this._emit(TT.MINUS,  '-'); break;
            case '*': this._emit(TT.STAR,   '*'); break;
            case '/': this._emit(TT.SLASH,  '/'); break;
            case '=': this._emit(TT.EQ,     '='); break;
            case '<':
                if (this._cur() === '=') { this._pos++; this._emit(TT.LTE, '<='); }
                else if (this._cur() === '>') { this._pos++; this._emit(TT.NEQ, '<>'); }
                else this._emit(TT.LT, '<');
                break;
            case '>':
                if (this._cur() === '=') { this._pos++; this._emit(TT.GTE, '>='); }
                else this._emit(TT.GT, '>');
                break;
            case '.': this._emit(TT.DOT,       '.'); break;
            case '\\': this._emit(TT.BACKSLASH, '\\'); break;
            default:
                // Unknown character — skip with a console warning
                console.warn(`[Lexer] Unexpected character '${c}' on line ${this._line}`);
        }
    }
}
