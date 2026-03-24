// ============================================================================
// parser.js — BASSM Token-Stream → AST
// ============================================================================
//
// Consumes the flat token array produced by the Lexer and returns an array
// of statement AST nodes.
//
// STATEMENT NODES
//   { type: 'command',      name: string, args: Expr[], line: number }
//   { type: 'assign',       target: string, expr: Expr, line: number }
//   { type: 'if',           cond: Expr, then: Stmt[], elseIfs: [{cond,body}[]], else: Stmt[], line: number }
//   { type: 'while',        cond: Expr, body: Stmt[], line: number }
//   { type: 'for',          var: string, from: Expr, to: Expr, step: Expr|null, body: Stmt[], line: number }
//   { type: 'repeat',       cond: Expr, body: Stmt[], line: number }
//   { type: 'exit',         count: number, line: number }
//   { type: 'select',       expr: Expr, cases: [{values: Expr[], body: Stmt[]}[]], default: Stmt[], line: number }
//   { type: 'function_def', name: string, params: string[], hasReturn: bool, body: Stmt[], line: number }
//   { type: 'local_decl',  name: string, expr: Expr|null, line: number }
//   { type: 'return',       expr: Expr|null, line: number }
//   { type: 'call_stmt',    name: string, args: Expr[], line: number }
//
// EXPRESSION NODES
//   { type: 'int',       value: number }
//   { type: 'float',     value: number }
//   { type: 'string',    value: string }
//   { type: 'ident',     name: string }          — variable reference
//   { type: 'binop',     op: string, left: Expr, right: Expr }
//   { type: 'unary',     op: string, operand: Expr }
//   { type: 'call_expr', name: string, args: Expr[] }  — user func call or array read
//
// EXPRESSION PRECEDENCE (low → high)
//   or          Or
//   and         And
//   comparison  =  <>  <  >  <=  >=   (non-associative, one per expression)
//   add/sub     +  -
//   mul/div     *  /  Mod
//   unary       -  Not
//   primary     literal | identifier | ( expr )
//
// RULES
//   • Statements are separated by NEWLINE tokens.
//   • A command statement begins with a COMMAND token followed by
//     zero or more comma-separated expressions until end of line.
//   • Parentheses after a command name are optional.
//   • An assignment begins with an IDENT token followed by EQ ('=').
//   • Inside expressions '=' is a comparison operator, not assignment.
//   • Lines that begin with an unrecognised token are skipped.
//   • Function definitions are top-level: Function name(p1,p2…) … EndFunction.
//   • Return [expr] exits the enclosing function.
//   • A bare IDENT at statement level (not followed by =, (, or \) is parsed
//     as a user function call statement with optional space-separated args.
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
            // COMMAND + '=' means the user is using a command name as a variable
            // (e.g. `line = 5`).  Treat as variable assignment rather than command.
            const next = this._peekAt(1);
            if (next && next.type === TT.EQ) return this._parseAssignment();
            return this._parseCommand();
        }

        // Variable assignment, array assignment, or type field write
        if (tok.type === TT.IDENT) {
            const next = this._peekAt(1);
            if (next && next.type === TT.EQ)        return this._parseAssignment();
            if (next && next.type === TT.BACKSLASH) return this._parseFieldWrite();
            if (next && next.type === TT.LPAREN)    return this._parseArrayAssignOrFieldWrite();
        }

        // Control-flow and declaration keywords
        if (tok.type === TT.KEYWORD) {
            if (tok.value === 'if')          return this._parseIf();
            if (tok.value === 'while')       return this._parseWhile();
            if (tok.value === 'for')         return this._parseFor();
            if (tok.value === 'repeat')      return this._parseRepeat();
            if (tok.value === 'exit')        return this._parseExit();
            if (tok.value === 'select')      return this._parseSelect();
            if (tok.value === 'dim')         return this._parseDim();
            if (tok.value === 'type')        return this._parseTypeDef();
            if (tok.value === 'function')    return this._parseFunctionDef();
            if (tok.value === 'return')      return this._parseReturn();
            if (tok.value === 'local')       return this._parseLocal();
            if (tok.value === 'const')       return this._parseConst();
            if (tok.value === 'data')        return this._parseData();
            if (tok.value === 'read')        return this._parseRead();
            if (tok.value === 'restore')     return this._parseRestore();
        }

        // Bare IDENT at statement level (no =, (, \) → user function call statement
        // Special case: bare IDENT directly followed by NEWLINE then 'data' keyword
        // means it is a Data label (from preprocessor splitting "label: Data ..." on ':').
        if (tok.type === TT.IDENT) {
            const _next2 = this._peekAt(1);
            if (_next2 && _next2.type === TT.NEWLINE) {
                const _afterNL = this._peekAt(2);
                if (_afterNL && _afterNL.type === TT.KEYWORD && _afterNL.value === 'data') {
                    const labelName = this._advance().value.toLowerCase(); // consume IDENT
                    this._advance();                                        // consume NEWLINE
                    const dataStmt = this._parseData();
                    dataStmt.label = labelName;
                    return dataStmt;
                }
            }
        }

        if (tok.type === TT.IDENT) {
            return this._parseFunctionCallStmt();
        }

        // Unknown — skip tokens until next NEWLINE
        console.warn(`[Parser] Unhandled token '${tok.type}' ("${tok.value}") on line ${tok.line}`);
        this._skipToNewline();
        return null;
    }

    // ── Assignment statement: <ident> = <expr> ───────────────────────────────

    _parseAssignment() {
        const nameTok = this._advance();            // consume IDENT
        this._advance();                             // consume EQ
        const expr = this._parseExpr();
        return {
            type:   'assign',
            target: nameTok.value.toLowerCase(),
            expr,
            line:   nameTok.line,
        };
    }

    // ── Array assign, typed-array field write, or function call statement ────
    //
    // name(args…)          → call_stmt  (no '=' after closing paren)
    // name(index) = expr   → array_assign
    // name(index)\f = expr → type_field_write

    _parseArrayAssignOrFieldWrite() {
        const nameTok = this._advance();            // consume IDENT
        const name    = nameTok.value.toLowerCase();
        this._advance();                             // consume LPAREN

        // Collect comma-separated arguments (support multi-arg function calls)
        const args = [];
        while (!this._atEnd() &&
               this._peek().type !== TT.RPAREN &&
               this._peek().type !== TT.NEWLINE &&
               this._peek().type !== TT.EOF) {
            if (this._peek().type === TT.COMMA) { this._advance(); continue; }
            const expr = this._parseExpr();
            if (expr !== null) args.push(expr);
        }
        if (this._peek().type === TT.RPAREN) this._advance();   // consume RPAREN

        // name(index)\field = expr — typed array field write (single-arg only)
        if (this._peek().type === TT.BACKSLASH && args.length === 1) {
            this._advance();                         // consume BACKSLASH
            if (this._peek().type !== TT.IDENT) {
                console.warn(`[Parser] Field write: expected field name on line ${nameTok.line}`);
                this._skipToNewline();
                return null;
            }
            const fieldTok = this._advance();        // consume field IDENT
            if (this._peek().type !== TT.EQ) {
                console.warn(`[Parser] Field write: expected '=' on line ${nameTok.line}`);
                this._skipToNewline();
                return null;
            }
            this._advance();                         // consume EQ
            const expr = this._parseExpr();
            return {
                type:     'type_field_write',
                instance: name,
                field:    fieldTok.value.toLowerCase(),
                index:    args[0],
                expr,
                line:     nameTok.line,
            };
        }

        // name(indices…) = expr — array assignment (1D, 2D, ND)
        if (this._peek().type === TT.EQ && args.length >= 1) {
            this._advance();                         // consume EQ
            const expr = this._parseExpr();
            return {
                type:    'array_assign',
                name,
                indices: args,
                expr,
                line:    nameTok.line,
            };
        }

        // name(args…) — function call statement (result discarded)
        return { type: 'call_stmt', name, args, line: nameTok.line };
    }

    // ── Scalar type field write: <ident> '\' <field> = <expr> ─────────────────

    _parseFieldWrite() {
        const nameTok = this._advance();            // consume IDENT
        this._advance();                             // consume BACKSLASH
        if (this._peek().type !== TT.IDENT) {
            console.warn(`[Parser] Field write: expected field name on line ${nameTok.line}`);
            this._skipToNewline();
            return null;
        }
        const fieldTok = this._advance();           // consume field IDENT
        if (this._peek().type !== TT.EQ) {
            console.warn(`[Parser] Field write: expected '=' on line ${nameTok.line}`);
            this._skipToNewline();
            return null;
        }
        this._advance();                             // consume EQ
        const expr = this._parseExpr();
        return {
            type:     'type_field_write',
            instance: nameTok.value.toLowerCase(),
            field:    fieldTok.value.toLowerCase(),
            index:    null,
            expr,
            line:     nameTok.line,
        };
    }

    // ── Type definition: Type <name> NEWLINE (Field …)* EndType ──────────────

    _parseTypeDef() {
        const typeTok = this._advance();            // consume 'type' keyword
        const nt0 = this._peek().type;
        if (nt0 !== TT.IDENT && nt0 !== TT.COMMAND) {
            console.warn(`[Parser] Type: expected name on line ${typeTok.line}`);
            this._skipToNewline();
            return null;
        }
        const nameTok = this._advance();            // consume type name
        this._skipToNewline();

        const fields = [];
        while (!this._atEnd()) {
            if (this._peek().type === TT.NEWLINE) { this._advance(); continue; }
            if (this._peek().type === TT.EOF) break;
            const tok = this._peek();
            if (tok.type === TT.KEYWORD && tok.value === 'endtype') break;
            if (tok.type === TT.KEYWORD && tok.value === 'field') {
                this._advance();                    // consume 'field'
                while (!this._atEnd() &&
                       this._peek().type !== TT.NEWLINE &&
                       this._peek().type !== TT.EOF) {
                    if (this._peek().type === TT.COMMA) { this._advance(); continue; }
                    if (this._peek().type === TT.IDENT) {
                        fields.push(this._advance().value.toLowerCase());
                    } else {
                        this._advance();            // skip unexpected
                    }
                }
            }
            this._skipToNewline();
        }

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'endtype') {
            this._advance();                        // consume 'endtype'
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected EndType but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return {
            type:   'type_def',
            name:   nameTok.value.toLowerCase(),
            fields,
            line:   typeTok.line,
        };
    }

    // ── Dim statement: Dim <ident>(<size>) ───────────────────────────────────

    _parseLocal() {
        const tok = this._advance();                // consume 'local'
        if (this._peek().type !== TT.IDENT) {
            throw new Error(`[Parser] Local: expected variable name on line ${tok.line}`);
        }
        const name = this._advance().value.toLowerCase();
        let expr = null;
        if (this._peek().type === TT.EQ) {
            this._advance();                        // consume '='
            expr = this._parseExpr();
        }
        this._skipToNewline();
        return { type: 'local_decl', name, expr, line: tok.line };
    }

    _parseConst() {
        const kwTok  = this._advance();                    // consume 'const'
        const nameTok = this._peek();
        if (!nameTok || nameTok.type !== TT.IDENT) {
            throw new Error(`[Parser] Const: expected name on line ${kwTok.line}`);
        }
        this._advance();                                   // consume name
        if (this._peek().type !== TT.EQ) {
            throw new Error(`[Parser] Const ${nameTok.value}: expected '=' on line ${nameTok.line}`);
        }
        this._advance();                                   // consume '='
        // Allow optional unary minus for negative literals
        let sign = 1;
        if (this._peek().type === TT.MINUS) {
            sign = -1;
            this._advance();
        }
        const valTok = this._peek();
        if (!valTok || valTok.type !== TT.INT) {
            throw new Error(
                `[Parser] Const ${nameTok.value}: value must be an integer literal on line ${nameTok.line}`
            );
        }
        this._advance();                                   // consume literal
        return {
            type:  'const_def',
            name:  nameTok.value.toLowerCase(),
            value: sign * valTok.value,
            line:  kwTok.line,
        };
    }

    // ── Data statement: Data val1, val2, ... ──────────────────────────────────
    // Values must be compile-time integer literals or Const references.
    // label is set by the caller when a "label: Data …" pattern is detected.

    _parseData() {
        const tok = this._advance();                // consume 'data'
        const values = [];
        while (!this._atEnd() &&
               this._peek().type !== TT.NEWLINE &&
               this._peek().type !== TT.EOF) {
            if (this._peek().type === TT.COMMA) { this._advance(); continue; }
            const expr = this._parseExpr();
            if (expr !== null) values.push(expr);
        }
        return { type: 'data_stmt', values, label: null, line: tok.line };
    }

    // ── Read statement: Read varName ───────────────────────────────────────────
    // Reads the next value from the Data table into the given variable.

    _parseRead() {
        const tok = this._advance();                // consume 'read'
        const next = this._peek();
        if (!next || (next.type !== TT.IDENT && next.type !== TT.COMMAND)) {
            throw new Error(`[Parser] Read: expected variable name on line ${tok.line}`);
        }
        const target = this._advance().value.toLowerCase();
        return { type: 'read_stmt', target, line: tok.line };
    }

    // ── Restore statement: Restore [label] ────────────────────────────────────
    // Resets the data pointer to _data_start (no label) or a labeled position.

    _parseRestore() {
        const tok = this._advance();                // consume 'restore'
        let label = null;
        const next = this._peek();
        if (next && next.type === TT.IDENT) {
            label = this._advance().value.toLowerCase();
        }
        return { type: 'restore_stmt', label, line: tok.line };
    }

    _parseDim() {
        const dimTok = this._advance();             // consume 'dim'
        if (this._peek().type !== TT.IDENT) {
            console.warn(`[Parser] Dim: expected name on line ${dimTok.line}`);
            this._skipToNewline();
            return null;
        }
        const nameTok = this._advance();            // consume IDENT

        // Typed variable: Dim name.TypeName  or  Dim name.TypeName(size)
        if (this._peek().type === TT.DOT) {
            this._advance();                        // consume DOT
            const nt1 = this._peek().type;
            if (nt1 !== TT.IDENT && nt1 !== TT.COMMAND) {
                console.warn(`[Parser] Dim: expected type name after '.' on line ${dimTok.line}`);
                this._skipToNewline();
                return null;
            }
            const typeTok  = this._advance();       // consume TypeName IDENT/COMMAND
            const typeName = typeTok.value.toLowerCase();
            if (this._peek().type === TT.LPAREN) {
                this._advance();                    // consume LPAREN
                const size = this._parseExpr();
                if (this._peek().type === TT.RPAREN) this._advance();
                this._skipToNewline();
                return { type: 'dim_typed_array', name: nameTok.value.toLowerCase(), typeName, size, line: dimTok.line };
            }
            this._skipToNewline();
            return { type: 'dim_typed', name: nameTok.value.toLowerCase(), typeName, line: dimTok.line };
        }

        // N-dimensional array: Dim name(d0 [, d1 [, d2 …]])
        if (this._peek().type !== TT.LPAREN) {
            console.warn(`[Parser] Dim: expected '(' on line ${dimTok.line}`);
            this._skipToNewline();
            return null;
        }
        this._advance();                             // consume LPAREN
        const dims = [this._parseExpr()];
        while (this._peek().type === TT.COMMA) {
            this._advance();                         // consume COMMA
            dims.push(this._parseExpr());
        }
        if (this._peek().type === TT.RPAREN) this._advance();   // consume RPAREN
        this._skipToNewline();
        return { type: 'dim', name: nameTok.value.toLowerCase(), dims, line: dimTok.line };
    }

    // ── Command statement ────────────────────────────────────────────────────

    _parseCommand() {
        const nameTok = this._advance();            // consume COMMAND token
        const args    = [];

        // Optional opening parenthesis: Graphics(320,256,5)
        const hasParen = this._peek().type === TT.LPAREN;
        if (hasParen) this._advance();

        // Collect comma-separated argument expressions
        while (!this._atEnd() &&
               this._peek().type !== TT.NEWLINE &&
               this._peek().type !== TT.EOF) {

            if (this._peek().type === TT.RPAREN) { this._advance(); break; }
            if (this._peek().type === TT.COMMA)  { this._advance(); continue; }

            const expr = this._parseExpr();
            if (expr !== null) args.push(expr);
        }

        return { type: 'command', name: nameTok.value, args, line: nameTok.line };
    }

    // ── Expression parser — recursive descent ────────────────────────────────
    //
    // Entry point.  Parses one comparison (or lower-precedence expression).

    _parseExpr() {
        return this._parseOr();
    }

    // or: and { (Or|Xor) and }

    _parseOr() {
        let left = this._parseAnd();
        while (this._peek()?.type === TT.KEYWORD &&
               (this._peek().value === 'or' || this._peek().value === 'xor')) {
            const op = this._advance().value;
            const right = this._parseAnd();
            left = { type: 'binop', op, left, right };
        }
        return left;
    }

    // and: comparison { And comparison }

    _parseAnd() {
        let left = this._parseComparison();
        while (this._peek()?.type === TT.KEYWORD && this._peek().value === 'and') {
            this._advance();
            const right = this._parseComparison();
            left = { type: 'binop', op: 'and', left, right };
        }
        return left;
    }

    // comparison: addSub [ (= | <> | < | > | <= | >=) addSub ]
    //
    // Non-associative: only one comparison per expression.
    // Inside expressions, '=' is always a comparison, never assignment.

    _parseComparison() {
        const left = this._parseAddSub();
        const tok  = this._peek();

        if (tok && this._isCompOp(tok.type)) {
            this._advance();
            const right = this._parseAddSub();
            return { type: 'binop', op: tok.value, left, right };
        }

        return left;
    }

    // addSub: mulDiv { (+|-) mulDiv }

    _parseAddSub() {
        let left = this._parseMulDiv();

        while (true) {
            const tok = this._peek();
            if (!tok || (tok.type !== TT.PLUS && tok.type !== TT.MINUS)) break;
            this._advance();
            const right = this._parseMulDiv();
            left = { type: 'binop', op: tok.value, left, right };
        }

        return left;
    }

    // mulDiv: unary { (*|/|Mod|Shl|Shr) unary }

    _parseMulDiv() {
        let left = this._parseUnary();

        while (true) {
            const tok = this._peek();
            const isMulDiv = tok && (tok.type === TT.STAR || tok.type === TT.SLASH);
            const isMod    = tok && tok.type === TT.KEYWORD && tok.value === 'mod';
            const isShift  = tok && tok.type === TT.KEYWORD && (tok.value === 'shl' || tok.value === 'shr');
            if (!isMulDiv && !isMod && !isShift) break;
            this._advance();
            const right = this._parseUnary();
            const op = isMod ? 'mod' : isShift ? tok.value : tok.value;
            left = { type: 'binop', op, left, right };
        }

        return left;
    }

    // unary: Not unary | - unary | primary

    _parseUnary() {
        // Not — bitwise complement (also serves as logical NOT for boolean values)
        if (this._peek().type === TT.KEYWORD && this._peek().value === 'not') {
            this._advance();
            const operand = this._parseUnary();
            // Fold constant Not at parse time (~n matches 68000 NOT.L behaviour)
            if (operand && operand.type === 'int') {
                return { type: 'int', value: ~operand.value };
            }
            return { type: 'unary', op: 'not', operand };
        }
        if (this._peek().type === TT.MINUS) {
            this._advance();
            const operand = this._parseUnary();
            // Fold constant unary minus at parse time
            if (operand && (operand.type === 'int' || operand.type === 'float')) {
                return { ...operand, value: -operand.value };
            }
            return { type: 'unary', op: '-', operand };
        }
        return this._parsePrimary();
    }

    // primary: INT | FLOAT | STRING | IDENT | ( expr )

    _parsePrimary() {
        const tok = this._peek();

        if (!tok) return null;

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
            case TT.COMMAND: {
                // COMMAND tokens in expression context are treated as variable
                // references — command names are only meaningful at statement-start.
                this._advance();
                const name = tok.value.toLowerCase();
                // Function call or array read: name(args…)[\field]
                if (this._peek().type === TT.LPAREN) {
                    this._advance();                        // consume LPAREN
                    const args = [];
                    while (!this._atEnd() &&
                           this._peek().type !== TT.RPAREN &&
                           this._peek().type !== TT.NEWLINE &&
                           this._peek().type !== TT.EOF) {
                        if (this._peek().type === TT.COMMA) { this._advance(); continue; }
                        const arg = this._parseExpr();
                        if (arg !== null) args.push(arg);
                    }
                    if (this._peek().type === TT.RPAREN) this._advance();  // consume RPAREN
                    // Typed array field read: name(index)\field — single-arg only
                    if (this._peek().type === TT.BACKSLASH && args.length === 1) {
                        this._advance();                    // consume BACKSLASH
                        const fTok = this._advance();       // consume field IDENT
                        return { type: 'type_field_read', instance: name, field: fTok.value.toLowerCase(), index: args[0] };
                    }
                    // call_expr: codegen resolves as user function or array read
                    return { type: 'call_expr', name, args };
                }
                // Scalar typed field read: name\field
                if (this._peek().type === TT.BACKSLASH) {
                    this._advance();                        // consume BACKSLASH
                    const fTok = this._advance();           // consume field IDENT
                    return { type: 'type_field_read', instance: name, field: fTok.value.toLowerCase(), index: null };
                }
                return { type: 'ident', name };
            }

            case TT.LPAREN: {
                this._advance();
                const expr = this._parseExpr();
                if (this._peek().type === TT.RPAREN) this._advance();
                return expr;
            }

            // These tokens end an expression — return null without consuming
            case TT.NEWLINE:
            case TT.EOF:
            case TT.COMMA:
            case TT.RPAREN:
                return null;

            default:
                console.warn(`[Parser] Unexpected token in expression: '${tok.type}' ("${tok.value}") on line ${tok.line}`);
                this._advance();
                return null;
        }
    }

    // ── Function definition: Function name(p1,p2…) … EndFunction ─────────────
    //
    // Blitz2D signature convention:
    //   Function MyProc param1, param2   → procedure (no return value, NO parens)
    //   Function MyFunc(param1, param2)  → function   (has return value, WITH parens)
    //
    // The presence of parentheses after the name is the distinguishing marker.

    _parseFunctionDef() {
        const fnTok = this._advance();              // consume 'function' KEYWORD
        const nt = this._peek().type;
        if (nt !== TT.IDENT && nt !== TT.COMMAND) {
            console.warn(`[Parser] Function: expected name on line ${fnTok.line}`);
            this._skipToNewline();
            return null;
        }
        const nameTok = this._advance();            // consume function name

        const params = [];
        let hasReturn;

        if (this._peek().type === TT.LPAREN) {
            // ── Function with return value: name(p1, p2, …) ──────────────────
            hasReturn = true;
            this._advance();                        // consume LPAREN
            while (!this._atEnd() &&
                   this._peek().type !== TT.RPAREN &&
                   this._peek().type !== TT.NEWLINE &&
                   this._peek().type !== TT.EOF) {
                if (this._peek().type === TT.COMMA) { this._advance(); continue; }
                if (this._peek().type === TT.IDENT) {
                    params.push(this._advance().value.toLowerCase());
                } else {
                    this._advance();                // skip unexpected token
                }
            }
            if (this._peek().type === TT.RPAREN) this._advance();  // consume RPAREN
        } else {
            // ── Procedure without return value: name p1, p2, … (no parens) ───
            hasReturn = false;
            while (!this._atEnd() &&
                   this._peek().type !== TT.NEWLINE &&
                   this._peek().type !== TT.EOF) {
                if (this._peek().type === TT.COMMA) { this._advance(); continue; }
                if (this._peek().type === TT.IDENT) {
                    params.push(this._advance().value.toLowerCase());
                } else {
                    this._advance();                // skip unexpected token
                }
            }
        }
        this._skipToNewline();

        // ── Parse body — stop on 'EndFunction' or two-token 'End Function' ─────
        // Blitz2D standard is "End Function" (two words). The lexer emits these
        // as COMMAND("end") + KEYWORD("function"). We also accept the single
        // keyword form "EndFunction" for convenience.
        const body = [];
        while (!this._atEnd() && this._peek().type !== TT.EOF) {
            if (this._peek().type === TT.NEWLINE) { this._advance(); continue; }
            const t = this._peek();
            if (t.type === TT.KEYWORD && t.value === 'endfunction') break;
            if (t.type === TT.COMMAND && t.value === 'end') {
                const t2 = this._peekAt(1);
                if (t2 && t2.type === TT.KEYWORD && t2.value === 'function') break;
            }
            const stmt = this._parseStatement();
            if (stmt !== null) body.push(stmt);
        }

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'endfunction') {
            this._advance();                        // consume 'EndFunction'
        } else if (this._peek().type === TT.COMMAND && this._peek().value === 'end') {
            this._advance();                        // consume 'End'
            if (this._peek().type === TT.KEYWORD && this._peek().value === 'function') {
                this._advance();                    // consume 'Function'
            }
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected EndFunction but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return {
            type:      'function_def',
            name:      nameTok.value.toLowerCase(),
            params,
            hasReturn,          // true = function (with parens); false = procedure (no parens)
            body,
            line:      fnTok.line,
        };
    }

    // ── Return statement: Return [expr] ───────────────────────────────────────

    _parseReturn() {
        const retTok = this._advance();             // consume 'return' KEYWORD
        let expr = null;
        if (this._peek().type !== TT.NEWLINE && this._peek().type !== TT.EOF) {
            expr = this._parseExpr();
        }
        return { type: 'return', expr, line: retTok.line };
    }

    // ── Bare-IDENT call statement: name [arg, arg…] ───────────────────────────
    //
    // Called when an IDENT appears at statement level without '=', '(' or '\'.
    // Parses as a user function call statement with space/comma-separated args.

    _parseFunctionCallStmt() {
        const nameTok = this._advance();            // consume IDENT
        const name    = nameTok.value.toLowerCase();
        const args    = [];

        while (!this._atEnd() &&
               this._peek().type !== TT.NEWLINE &&
               this._peek().type !== TT.EOF) {
            if (this._peek().type === TT.COMMA) { this._advance(); continue; }
            const expr = this._parseExpr();
            if (expr !== null) args.push(expr);
        }

        return { type: 'call_stmt', name, args, line: nameTok.line };
    }

    // ── If statement ──────────────────────────────────────────────────────────
    //
    // Single-line:  If <cond> Then <stmt>
    // Block form:   If <cond> NEWLINE … [ElseIf <cond> NEWLINE …]* [Else NEWLINE …] EndIf

    _parseIf() {
        const ifTok = this._advance();              // consume 'if' KEYWORD
        const cond  = this._parseExpr();

        // Single-line form: If <cond> Then <stmt>
        if (this._peek().type === TT.KEYWORD && this._peek().value === 'then') {
            this._advance();                        // consume 'then'
            const stmt = this._parseStatement();
            return {
                type:    'if',
                cond,
                then:    stmt ? [stmt] : [],
                elseIfs: [],
                else:    [],
                line:    ifTok.line,
            };
        }

        // Block form
        this._skipToNewline();                      // skip any trailing tokens on the If line
        const thenBody = this._parseBlock(['elseif', 'else', 'endif']);

        const elseIfs = [];
        while (this._peek().type === TT.KEYWORD && this._peek().value === 'elseif') {
            this._advance();                        // consume 'elseif'
            const eiCond = this._parseExpr();
            this._skipToNewline();
            const eiBody = this._parseBlock(['elseif', 'else', 'endif']);
            elseIfs.push({ cond: eiCond, body: eiBody });
        }

        let elseBody = [];
        if (this._peek().type === TT.KEYWORD && this._peek().value === 'else') {
            this._advance();                        // consume 'else'
            this._skipToNewline();
            elseBody = this._parseBlock(['endif']);
        }

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'endif') {
            this._advance();                        // consume 'endif'
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected EndIf but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return {
            type:    'if',
            cond,
            then:    thenBody,
            elseIfs,
            else:    elseBody,
            line:    ifTok.line,
        };
    }

    // ── While statement ───────────────────────────────────────────────────────
    //
    // While <cond> NEWLINE … Wend

    _parseWhile() {
        const whileTok = this._advance();           // consume 'while'
        const cond     = this._parseExpr();
        this._skipToNewline();
        const body     = this._parseBlock(['wend']);

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'wend') {
            this._advance();                        // consume 'wend'
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected Wend but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return { type: 'while', cond, body, line: whileTok.line };
    }

    // ── Repeat / Until statement ──────────────────────────────────────────────
    //
    // Repeat NEWLINE … Until <cond>
    //
    // Executes the body at least once; repeats while <cond> is false (exits
    // when <cond> is true) — the opposite sense from While.

    _parseRepeat() {
        const repTok = this._advance();             // consume 'repeat'
        this._skipToNewline();
        const body   = this._parseBlock(['until']);

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'until') {
            this._advance();                        // consume 'until'
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected Until but got '${t?.value}' on line ${t?.line}`);
        }
        const cond = this._parseExpr();
        this._skipToNewline();

        return { type: 'repeat', cond, body, line: repTok.line };
    }

    // ── Exit statement ────────────────────────────────────────────────────────
    //
    // Exit [n]
    //
    // Exits n enclosing loops (While, For, Repeat). Default n = 1.

    _parseExit() {
        const exitTok = this._advance();            // consume 'exit'
        // Optional integer: Exit 2 exits 2 loops. Must be on the same line.
        let count = 1;
        if (this._pos < this._tokens.length &&
            this._peek().type === TT.INT &&
            this._peek().line === exitTok.line) {
            count = this._advance().value;
        }
        this._skipToNewline();
        return { type: 'exit', count, line: exitTok.line };
    }

    // ── For statement ─────────────────────────────────────────────────────────
    //
    // For <var> = <from> To <to> [Step <step>] NEWLINE … Next [<var>]

    _parseFor() {
        const forTok = this._advance();             // consume 'for'

        if (this._peek().type !== TT.IDENT && this._peek().type !== TT.COMMAND) {
            console.warn(`[Parser] For: expected variable name on line ${forTok.line}`);
            this._skipToNewline();
            return null;
        }
        const nameTok = this._advance();            // consume IDENT (or COMMAND used as variable)

        if (this._peek().type !== TT.EQ) {
            console.warn(`[Parser] For: expected '=' on line ${forTok.line}`);
            this._skipToNewline();
            return null;
        }
        this._advance();                            // consume '='

        const from = this._parseExpr();

        if (!(this._peek().type === TT.KEYWORD && this._peek().value === 'to')) {
            console.warn(`[Parser] For: expected 'To' on line ${forTok.line}`);
            this._skipToNewline();
            return null;
        }
        this._advance();                            // consume 'to'

        const to = this._parseExpr();

        let step = null;
        if (this._peek().type === TT.KEYWORD && this._peek().value === 'step') {
            this._advance();                        // consume 'step'
            step = this._parseExpr();
        }

        this._skipToNewline();
        const body = this._parseBlock(['next']);

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'next') {
            this._advance();                        // consume 'next'
            // Optional: Next i  (variable name may be IDENT or COMMAND)
            const nt = this._peek().type;
            if (nt === TT.IDENT || nt === TT.COMMAND) this._advance();
        } else {
            const t = this._peek();
            console.warn(`[Parser] For: expected 'Next' but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return {
            type: 'for',
            var:  nameTok.value.toLowerCase(),
            from,
            to,
            step,
            body,
            line: forTok.line,
        };
    }

    // ── Block parser — parses statements until a stop keyword is peeked ───────
    //
    // Does NOT consume the stop keyword itself; the caller does that.

    _parseBlock(stopKeywords) {
        const stmts = [];
        while (!this._atEnd()) {
            if (this._peek().type === TT.NEWLINE) { this._advance(); continue; }
            if (this._peek().type === TT.EOF)     break;
            const tok = this._peek();
            if (tok.type === TT.KEYWORD && stopKeywords.includes(tok.value)) break;
            const stmt = this._parseStatement();
            if (stmt !== null) stmts.push(stmt);
        }
        return stmts;
    }

    // ── Select statement ──────────────────────────────────────────────────────
    //
    // Select <expr>
    //   Case <val>[, <val>…]   — one or more values per Case
    //     <stmts>
    //   [Default
    //     <stmts>]
    // EndSelect

    _parseSelect() {
        const selTok = this._advance();             // consume 'select'
        const expr   = this._parseExpr();
        this._skipToNewline();

        const cases  = [];
        let defBody  = [];

        outer:
        while (!this._atEnd()) {
            if (this._peek().type === TT.NEWLINE) { this._advance(); continue; }
            if (this._peek().type === TT.EOF)     break;

            const tok = this._peek();
            if (tok.type !== TT.KEYWORD) { this._advance(); continue; } // skip junk

            switch (tok.value) {

                case 'endselect':
                    break outer;

                case 'case': {
                    this._advance();                // consume 'case'

                    // Parse comma-separated case values on the same line
                    const values = [];
                    while (!this._atEnd() &&
                           this._peek().type !== TT.NEWLINE &&
                           this._peek().type !== TT.EOF) {
                        if (this._peek().type === TT.COMMA) { this._advance(); continue; }
                        const v = this._parseExpr();
                        if (v) values.push(v);
                    }
                    this._skipToNewline();

                    const body = this._parseBlock(['case', 'default', 'endselect']);
                    cases.push({ values, body });
                    break;
                }

                case 'default':
                    this._advance();                // consume 'default'
                    this._skipToNewline();
                    defBody = this._parseBlock(['endselect']);
                    break outer;

                default:
                    this._advance();                // skip unknown keyword
                    break;
            }
        }

        if (this._peek().type === TT.KEYWORD && this._peek().value === 'endselect') {
            this._advance();                        // consume 'endselect'
        } else {
            const t = this._peek();
            console.warn(`[Parser] Expected EndSelect but got '${t?.value}' on line ${t?.line}`);
        }
        this._skipToNewline();

        return {
            type:    'select',
            expr,
            cases,
            default: defBody,
            line:    selTok.line,
        };
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _isCompOp(type) {
        return type === TT.EQ  || type === TT.NEQ ||
               type === TT.LT  || type === TT.GT  ||
               type === TT.LTE || type === TT.GTE;
    }

    _skipToNewline() {
        while (!this._atEnd() &&
               this._peek().type !== TT.NEWLINE &&
               this._peek().type !== TT.EOF) {
            this._advance();
        }
    }

    // ── Cursor helpers ───────────────────────────────────────────────────────

    _peek()          { return this._tokens[this._pos]; }
    _peekAt(offset)  { return this._tokens[this._pos + offset]; }
    _advance()       { return this._tokens[this._pos++]; }
    _atEnd() {
        return this._pos >= this._tokens.length ||
               this._tokens[this._pos].type === TT.EOF;
    }
}
