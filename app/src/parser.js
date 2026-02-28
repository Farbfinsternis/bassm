// ============================================================================
// parser.js — BASSM Token-Stream → AST
// ============================================================================
//
// Consumes the flat token array produced by the Lexer and returns an array
// of statement AST nodes.
//
// STATEMENT NODES (current)
//   { type: 'command', name: string, args: Expr[], line: number }
//
// EXPRESSION NODES (current)
//   { type: 'int',    value: number }
//   { type: 'float',  value: number }
//   { type: 'string', value: string }
//   { type: 'ident',  name:  string }
//
// RULES
//   • Statements are separated by NEWLINE tokens.
//   • A command statement begins with a COMMAND token and is followed by
//     zero or more comma-separated expressions until end of line.
//   • Parentheses after a command name are optional:
//       Graphics 320,256,5   and   Graphics(320,256,5)  both parse.
//   • Lines that begin with an unrecognised token are skipped with a warning
//     (forward-compatibility for features not yet implemented).
// ============================================================================

import { TT } from './lexer.js';

export class Parser {

    /**
     * @param {{ type, value, line }[]} tokens  Output of Lexer.tokenize()
     * @returns {object[]}  Array of statement AST nodes
     */
    parse(tokens) {
        this._tokens = tokens;
        this._pos    = 0;
        const stmts  = [];

        while (!this._atEnd()) {
            // Skip blank lines
            if (this._peek().type === TT.NEWLINE) { this._advance(); continue; }
            if (this._peek().type === TT.EOF)     { break; }

            const stmt = this._parseStatement();
            if (stmt !== null) stmts.push(stmt);
        }

        return stmts;
    }

    // ── Statement dispatch ───────────────────────────────────────────────────

    _parseStatement() {
        const tok = this._peek();

        if (tok.type === TT.COMMAND) {
            return this._parseCommand();
        }

        // TODO: KEYWORD → control flow (If, While, For, …)
        // TODO: IDENT   → variable assignment or procedure call

        // Unknown — skip tokens until the next NEWLINE so we stay in sync
        console.warn(`[Parser] Unhandled token type '${tok.type}' ("${tok.value}") on line ${tok.line}`);
        while (!this._atEnd() && this._peek().type !== TT.NEWLINE && this._peek().type !== TT.EOF) {
            this._advance();
        }
        return null;
    }

    // ── Command statement ────────────────────────────────────────────────────

    _parseCommand() {
        const nameTok = this._advance();        // consume COMMAND token
        const args    = [];

        // Optional opening parenthesis: Graphics(320,256,5)
        const hasParen = this._peek().type === TT.LPAREN;
        if (hasParen) this._advance();

        // Collect comma-separated argument expressions
        while (!this._atEnd() && this._peek().type !== TT.NEWLINE && this._peek().type !== TT.EOF) {
            if (this._peek().type === TT.RPAREN) { this._advance(); break; }
            if (this._peek().type === TT.COMMA)  { this._advance(); continue; }

            const expr = this._parseExpr();
            if (expr !== null) args.push(expr);
        }

        return { type: 'command', name: nameTok.value, args, line: nameTok.line };
    }

    // ── Expression parser (minimal — literals + identifiers) ─────────────────

    _parseExpr() {
        const tok = this._peek();

        // Unary minus: -42
        if (tok.type === TT.MINUS) {
            this._advance();
            const operand = this._peek();
            if (operand.type === TT.INT || operand.type === TT.FLOAT) {
                this._advance();
                return { type: operand.type, value: -operand.value };
            }
            return null;
        }

        switch (tok.type) {
            case TT.INT:
                this._advance();
                return { type: 'int', value: tok.value };

            case TT.FLOAT:
                this._advance();
                return { type: 'float', value: tok.value };

            case TT.STRING:
                this._advance();
                return { type: 'string', value: tok.value };

            case TT.IDENT:
                this._advance();
                return { type: 'ident', name: tok.value };

            default:
                // Unexpected token in argument position — skip it
                console.warn(`[Parser] Unexpected token in expression: '${tok.type}' on line ${tok.line}`);
                this._advance();
                return null;
        }
    }

    // ── Cursor helpers ───────────────────────────────────────────────────────

    _peek()    { return this._tokens[this._pos]; }
    _advance() { return this._tokens[this._pos++]; }
    _atEnd()   {
        return this._pos >= this._tokens.length ||
               this._tokens[this._pos].type === TT.EOF;
    }
}
