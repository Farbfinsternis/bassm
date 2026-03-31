// ============================================================================
// codegen.js — BASSM AST → m68k Assembly
// ============================================================================
//
// Converts the AST produced by the Parser into a complete vasm-compatible
// m68k assembly source file that targets bare-metal OCS/ECS Amiga (PAL).
//
// OUTPUT STRUCTURE
//   1.  Header comment
//   2.  Screen EQUs  (computed from the Graphics statement)
//   3.  Fragment INCLUDEs
//   4.  Chip-RAM DATA section (_gfx_copper) + user var BSS
//   5.  User variable BSS section  (_var_*)  — one ds.l per integer variable
//   7.  _setup_graphics CODE
//   8.  _main_program CODE   (one instruction sequence per Blitz2D statement)
//
// EXPRESSION EVALUATION CONVENTION
//   • All expressions evaluate to a 32-bit signed integer in d0.
//   • Temporaries are pushed on the system stack; the stack is always clean
//     at the point of any subroutine call.
//   • Comparison operators produce Blitz2D boolean values: -1 (true) / 0 (false).
//   • Multiplication uses muls.w (16×16→32); operands must fit in 16 bits.
//   • Division uses divs.w (32÷16→16q); operands must fit accordingly.
// ============================================================================

// ── Helpers ──────────────────────────────────────────────────────────────────

const hex = (n, digits = 4) =>
    n.toString(16).toUpperCase().padStart(digits, '0');

const pad = (s, w) => s.padEnd(w, ' ');

const copMove = (reg, val, comment) =>
    `        dc.w    $${hex(reg)},$${hex(val)}${comment ? `             ; ${comment}` : ''}`;

// ── Bitplane pointer register pairs (OCS, 1-indexed) ─────────────────────────

const BPL_PTR_REGS = [
    [0x00E0, 0x00E2],
    [0x00E4, 0x00E6],
    [0x00E8, 0x00EA],
    [0x00EC, 0x00EE],
    [0x00F0, 0x00F2],
    [0x00F4, 0x00F6],
];

// ── CodeGen class ─────────────────────────────────────────────────────────────

export class CodeGen {

    /**
     * Generate a complete m68k assembly source from a BASSM AST.
     *
     * @param {object[]} ast  Statement nodes from Parser.parse()
     * @returns {string}      Assembly source text
     */
    generate(ast) {
        // Reset per-compilation state
        this._labelCount    = 0;
        this._arrays        = new Map();  // name → dims Expr[] (populated by _collectVars; N-dimensional)
        this._usesRaster    = false;      // true if any CopperColor command present
        this._usesSound     = false;      // true if any LoadSample command present
        this._audioSamples  = new Map();  // index (int) → { filename, label }
        this._usesImage     = false;      // true if any LoadImage command present
        this._imageAssets   = new Map();  // index (int) → { filename, label, width, height, rowbytes }
        this._typeDefs      = new Map();  // typeName → { fields: string[] }
        this._typeInstances = new Map();  // instanceName → { typeName, isArray, size: Expr|null }
        this._ptrCacheCtx   = null;       // PERF-2: active pointer cache { instName, regName }
        this._userFunctions = new Map();  // name → { params, localVars, body, line }
        this._funcCtx       = null;       // non-null when generating a function body
        this._usesRnd       = false;      // true if any Rnd() call present
        this._usesMouse     = false;      // true if any MouseX/Y/Down/Hit used
        this._usesBobs      = false;      // true if any DrawBob/SetBackground used
        this._maskAssets    = new Map();  // index (int) → { filename, label }
        this._fontAssets    = new Map();  // index (int) → { filename, label, chars, charW, charH }
        this._loopStack     = [];         // stack of endLabels for Exit — push on loop entry, pop on exit
        this._consts        = new Map();  // name → value (compile-time constants, no BSS)
        this._usesData      = false;      // true if any Data/Read/Restore present
        this._dataStmts     = [];         // ordered data_stmt nodes (values → dc.l in DATA section)
        this._usesTilemap   = false;      // true if any LoadTileset/LoadTilemap/DrawTilemap/SetTilemap present
        this._tilesetAssets = new Map();  // slot (int) → { filename, label, tileW, tileH, rowbytes }
        this._tilemapAssets = new Map();  // slot (int) → { filename, label }
        this._viewports            = new Map();   // index → { y1, y2, height, scroll } (T3)
        this._hasExplicitViewports = false;        // true iff user wrote at least one SetViewport (T3)
        this._activeViewportIdx    = 0;            // compile-time active viewport (T15)
        this._cameraVPs            = new Set();    // VP indices that use SetCamera (T19)
        this._gfxHeight            = 0;            // set after Graphics validation; used by T32

        this._initStatementHandlers();
        this._initCommandHandlers();
        this._initBuiltinHandlers();
        this._initCollectHandlers();

        // ── Collect Const definitions first (pre-pass, before _collectVars) ───
        for (const stmt of ast) {
            if (stmt && stmt.type === 'const_def') this._consts.set(stmt.name, stmt.value);
        }

        // ── Locate and validate the Graphics statement ────────────────────────
        const gfxStmt = ast.find(s => s && s.type === 'command' && s.name === 'graphics');
        if (!gfxStmt) {
            throw new Error('Every BASSM program must begin with a Graphics statement.');
        }

        const W = this._intArg(gfxStmt, 0, 'Graphics width');
        const H = this._intArg(gfxStmt, 1, 'Graphics height');
        const D = this._intArg(gfxStmt, 2, 'Graphics depth');

        if (W !== 320) {
            throw new Error(`Graphics width ${W} not supported — only 320px lores OCS.`);
        }
        if (H < 1 || H > 256) {
            throw new Error(`Graphics height ${H} out of range — must be 1–256 for OCS PAL lores.`);
        }
        if (D < 1 || D > 6) {
            throw new Error(`Graphics depth ${D} out of range — must be 1–6 bitplanes.`);
        }
        this._gfxHeight = H;

        // ── Display timing constants ──────────────────────────────────────────
        const colors  = 1 << D;
        const bplcon0 = (D << 12) | 0x0200;
        const hStart  = 0x81;
        const vStart  = 0x2C;
        const diwstrt = (vStart << 8) | hStart;
        const hStop   = (hStart + W) & 0xFF;
        const vStop   = (vStart + H) & 0xFF;
        const diwstop = (vStop  << 8) | hStop;
        const ddfstrt = 0x0038;
        const ddfstop = 0x00D0;

        // ── Collect scalar variable names and array declarations ─────────────
        const varNames = new Set();
        this._collectVars(ast, varNames);

        // ── Collect and validate SetViewport declarations (T3) ────────────────
        this._collectViewports(ast, H);

        // ── T32: Inject implicit VP0 when no explicit SetViewport present ─────
        if (!this._hasExplicitViewports) {
            this._viewports.set(0, { y1: 0, y2: H - 1, height: H, scroll: false });
        }

        // ── Build output ──────────────────────────────────────────────────────
        const out = [];

        out.push('; ============================================================');
        out.push('; Generated by BASSM — do not edit');
        out.push(`; Screen: ${W}×${H}, ${D} bitplane${D > 1 ? 's' : ''}, ${colors} colours (PAL lores OCS)`);
        out.push('; ============================================================');
        out.push('');

        this._emitEQUs(out, W, H, D, bplcon0, vStart, diwstrt, diwstop, ddfstrt, ddfstop);
        this._emitIncludes(out);

        this._emitSetupGraphics(out);

        // _main_program
        out.push('');
        out.push('        XDEF    _main_program');
        out.push('_main_program:');

        // Initialise data pointer to _data_start on program entry
        if (this._usesData) {
            out.push('        lea     _data_start,a0');
            out.push('        move.l  a0,_data_ptr');
        }

        for (const stmt of ast) {
            if (!stmt) continue;
            out.push(...this._genStatement(stmt));
            this._peepholeRedundantReload(out);
        }
        out.push('        rts');
        out.push('');

        // ── User-defined function definitions ─────────────────────────────────
        for (const [, funcDef] of this._userFunctions) {
            out.push(...this._genFunctionDef(funcDef));
        }

        // ── DATA & BSS SECTIONS (Must come after CODE for WinUAE compatibility) ──
        this._emitUserVarsBSS(out, varNames);
        this._emitDataSection(out);
        this._emitCopperLists(out, D, H, vStart, diwstrt, diwstop, ddfstrt, ddfstop, bplcon0);
        this._emitBufferBSS(out);
        this._emitAssetData(out);

        return out.join('\n');
    }

    /**
     * Returns the list of asset filenames referenced by the last compile()
     * (e.g. ["beep.raw", "music.raw"]).  Used by bassm.js to pass files to
     * the main process for inclusion in the assembly temp directory.
     */
    getAssetRefs() {
        return [
            ...[...this._audioSamples.values()].map(e => e.filename),
            ...[...this._imageAssets.values()].map(e => e.filename),
            ...[...this._maskAssets.values()].map(e => e.filename),
            ...[...this._fontAssets.values()].map(e => e.filename),
            ...[...this._tilesetAssets.values()].map(e => e.filename),
            ...[...this._tilemapAssets.values()].map(e => e.filename),
        ];
    }

    /**
     * Returns font asset metadata for numPlanes validation in main.js.
     * Each entry: { filename, numChars, charH }
     */
    getFontAssets() {
        return [...this._fontAssets.values()].map(({ filename, chars, charW, charH }) => ({
            filename, numChars: chars.length, charW, charH
        }));
    }

    // ── Variable collection (pre-pass) ────────────────────────────────────────
    //
    // Walks the AST and collects all variable names so we can emit BSS
    // declarations before _main_program.

    _collectVars(ast, varSet) {
        for (const stmt of ast) {
            if (!stmt) continue;
            if (stmt.type === 'const_def') {
                // Already registered in this._consts pre-pass; no BSS needed.
            } else if (stmt.type === 'assign') {
                if (!this._consts.has(stmt.target)) varSet.add(stmt.target);
                this._collectVarsInExpr(stmt.expr, varSet);
            } else if (stmt.type === 'dim') {
                this._arrays.set(stmt.name, stmt.dims);
            } else if (stmt.type === 'array_assign') {
                for (const idx of stmt.indices) this._collectVarsInExpr(idx, varSet);
                this._collectVarsInExpr(stmt.expr, varSet);
            } else if (stmt.type === 'type_def') {
                this._typeDefs.set(stmt.name, { fields: stmt.fields });
            } else if (stmt.type === 'dim_typed') {
                this._typeInstances.set(stmt.name, { typeName: stmt.typeName, isArray: false, size: null });
            } else if (stmt.type === 'dim_typed_array') {
                this._typeInstances.set(stmt.name, { typeName: stmt.typeName, isArray: true, size: stmt.size });
            } else if (stmt.type === 'type_field_write') {
                if (stmt.index) this._collectVarsInExpr(stmt.index, varSet);
                this._collectVarsInExpr(stmt.expr, varSet);
            } else if (stmt.type === 'data_stmt') {
                this._usesData = true;
                this._dataStmts.push(stmt);
                for (const val of stmt.values) this._collectVarsInExpr(val, varSet);
            } else if (stmt.type === 'read_stmt') {
                this._usesData = true;
                if (!this._consts.has(stmt.target)) varSet.add(stmt.target);
            } else if (stmt.type === 'restore_stmt') {
                this._usesData = true;
            } else if (stmt.type === 'command') {
                const collectHandler = this._collectCmdHandlers[stmt.name];
                if (collectHandler) collectHandler(stmt);
                for (const arg of stmt.args) {
                    this._collectVarsInExpr(arg, varSet);
                }
            } else if (stmt.type === 'if') {
                this._collectVarsInExpr(stmt.cond, varSet);
                this._collectVars(stmt.then, varSet);
                for (const ei of stmt.elseIfs) {
                    this._collectVarsInExpr(ei.cond, varSet);
                    this._collectVars(ei.body, varSet);
                }
                this._collectVars(stmt.else, varSet);
            } else if (stmt.type === 'while') {
                this._collectVarsInExpr(stmt.cond, varSet);
                this._collectVars(stmt.body, varSet);
            } else if (stmt.type === 'repeat') {
                this._collectVarsInExpr(stmt.cond, varSet);
                this._collectVars(stmt.body, varSet);
            } else if (stmt.type === 'for') {
                varSet.add(stmt.var);
                this._collectVarsInExpr(stmt.from, varSet);
                this._collectVarsInExpr(stmt.to,   varSet);
                if (stmt.step) this._collectVarsInExpr(stmt.step, varSet);
                this._collectVars(stmt.body, varSet);
            } else if (stmt.type === 'select') {
                this._collectVarsInExpr(stmt.expr, varSet);
                for (const c of stmt.cases) {
                    for (const v of c.values) this._collectVarsInExpr(v, varSet);
                    this._collectVars(c.body, varSet);
                }
                this._collectVars(stmt.default, varSet);
            } else if (stmt.type === 'function_def') {
                // Collect function-local vars into a separate set (NOT global BSS)
                const localVars = new Set(stmt.params);
                this._collectVarsInFunction(stmt.body, localVars);
                this._userFunctions.set(stmt.name, {
                    name:      stmt.name,
                    params:    stmt.params,
                    hasReturn: stmt.hasReturn,
                    localVars,
                    body:      stmt.body,
                    line:      stmt.line,
                });
            } else if (stmt.type === 'call_stmt') {
                // Global-scope function call: collect vars from arguments
                for (const arg of stmt.args) this._collectVarsInExpr(arg, varSet);
            }
        }
    }

    // ── Collect local variables inside a function body ─────────────────────────
    //
    // Walks only the function's own body. Variables assigned here are local.
    // Does NOT recurse into nested function definitions (not supported).

    _collectVarsInFunction(body, localVarSet) {
        for (const stmt of body) {
            if (!stmt) continue;
            if (stmt.type === 'local_decl') {
                // Only explicit 'Local' declarations create frame-local variables.
                // All other assignments inside a function access the global BSS,
                // matching Blitz2D semantics where variables are global by default.
                localVarSet.add(stmt.name);
            } else if (stmt.type === 'for') {
                this._collectVarsInFunction(stmt.body, localVarSet);
            } else if (stmt.type === 'if') {
                this._collectVarsInFunction(stmt.then, localVarSet);
                for (const ei of stmt.elseIfs) {
                    this._collectVarsInFunction(ei.body, localVarSet);
                }
                this._collectVarsInFunction(stmt.else, localVarSet);
            } else if (stmt.type === 'while' || stmt.type === 'repeat') {
                this._collectVarsInFunction(stmt.body, localVarSet);
            } else if (stmt.type === 'select') {
                for (const c of stmt.cases) {
                    this._collectVarsInFunction(c.body, localVarSet);
                }
                this._collectVarsInFunction(stmt.default, localVarSet);
            }
            // dim, type_def inside functions are treated as global declarations
        }
    }

    _collectVarsInExpr(expr, varSet) {
        if (!expr) return;
        switch (expr.type) {
            case 'ident':
                if (!this._consts.has(expr.name)) varSet.add(expr.name);
                break;
            case 'array_read':
                // array name is NOT a scalar — only collect vars used in the index
                this._collectVarsInExpr(expr.index, varSet);
                break;
            case 'call_expr':
                // function/array name is NOT a scalar — collect vars from args
                if (expr.name === 'rnd') this._usesRnd = true;
                if (expr.name === 'mousex' || expr.name === 'mousey' ||
                    expr.name === 'mousedown' || expr.name === 'mousehit') this._usesMouse = true;
                for (const arg of expr.args) this._collectVarsInExpr(arg, varSet);
                break;
            case 'type_field_read':
                if (expr.index) this._collectVarsInExpr(expr.index, varSet);
                break;
            case 'binop':
                this._collectVarsInExpr(expr.left,    varSet);
                this._collectVarsInExpr(expr.right,   varSet);
                break;
            case 'unary':
                this._collectVarsInExpr(expr.operand, varSet);
                break;
        }
    }

    // ── T3: SetViewport pre-pass — collect, sort and validate all viewports ─────
    //
    // Called after _collectVars so _usesRaster is already set.
    // Populates this._viewports and this._hasExplicitViewports.
    // Does NOT inject the implicit VP0 — that is done in T32 just before codegen.

    _collectViewports(ast, H) {
        const vpNodes = ast.filter(s => s && s.type === 'set_viewport');

        if (vpNodes.length === 0) {
            this._hasExplicitViewports = false;
            return;
        }

        // Sort by declared index so validation order is predictable
        vpNodes.sort((a, b) => a.index - b.index);

        // Indices must be contiguous starting at 0
        for (let i = 0; i < vpNodes.length; i++) {
            if (vpNodes[i].index !== i) {
                throw new Error(
                    `SetViewport: indices must be contiguous starting at 0 — ` +
                    `expected index ${i}, got ${vpNodes[i].index} on line ${vpNodes[i].line}`
                );
            }
        }

        // First viewport must start at y1 = 0
        if (vpNodes[0].y1 !== 0) {
            throw new Error(
                `SetViewport 0: y1 must be 0, got ${vpNodes[0].y1} on line ${vpNodes[0].line}`
            );
        }

        // Last viewport must end at y2 = H-1
        const last = vpNodes[vpNodes.length - 1];
        if (last.y2 !== H - 1) {
            throw new Error(
                `SetViewport ${last.index}: y2 must be ${H - 1} (GFXHEIGHT-1), ` +
                `got ${last.y2} on line ${last.line}`
            );
        }

        // Each viewport: 0 ≤ y1 < y2 ≤ H-1, and no gaps between consecutive viewports
        for (let i = 0; i < vpNodes.length; i++) {
            const vp = vpNodes[i];
            if (vp.y1 < 0 || vp.y1 >= vp.y2 || vp.y2 > H - 1) {
                throw new Error(
                    `SetViewport ${vp.index}: invalid range y1=${vp.y1} y2=${vp.y2} ` +
                    `(must satisfy 0 ≤ y1 < y2 ≤ ${H - 1}) on line ${vp.line}`
                );
            }
            if (i > 0 && vp.y1 !== vpNodes[i - 1].y2 + 1) {
                throw new Error(
                    `SetViewport: gap between viewport ${i - 1} (y2=${vpNodes[i - 1].y2}) ` +
                    `and viewport ${i} (y1=${vp.y1}) — viewports must be contiguous on line ${vp.line}`
                );
            }
            this._viewports.set(vp.index, {
                y1:     vp.y1,
                y2:     vp.y2,
                height: vp.y2 - vp.y1 + 1,
                scroll: false,   // T32 / T9 may set this true when SetTilemap is used in this VP
            });
        }

        this._hasExplicitViewports = true;

        // D9: CopperColor raster effects are incompatible with multi-viewport (V1)
        if (this._usesRaster) {
            console.warn(
                `[CodeGen] Warning: CopperColor is not supported together with SetViewport ` +
                `(D9) — raster effects will be ignored.`
            );
        }
    }

    // ── Per-statement code generation ─────────────────────────────────────────

    _genStatement(stmt) {
        const lines = [];
        const handler = this._stmtHandlers[stmt.type];
        if (handler) {
            handler(stmt, lines);
        }
        return lines;
    }

    // ── If statement code generation ──────────────────────────────────────────
    //
    // Evaluates cond into d0; tst.l; beq.w branches to else/endif.
    // Uses .w branches so bodies can be arbitrarily large.

    _genIf(stmt, lines) {
        const hasElseIf = stmt.elseIfs.length > 0;
        const hasElse   = stmt.else.length > 0;
        const endLbl    = this._nextLabel();

        if (hasElseIf || hasElse) {
            const firstAltLbl = this._nextLabel();
            // PERF-A: emit cmp+Bcc directly for comparison conditions
            this._genCondBranch(stmt.cond, firstAltLbl, lines);

            // Then body
            for (const s of stmt.then) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
            lines.push(`        bra.w   ${endLbl}`);
            lines.push(`${firstAltLbl}:`);

            // ElseIf chain — each produces its own branch-to-endif
            for (const ei of stmt.elseIfs) {
                const nextAltLbl = this._nextLabel();
                this._genCondBranch(ei.cond, nextAltLbl, lines);
                for (const s of ei.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
                lines.push(`        bra.w   ${endLbl}`);
                lines.push(`${nextAltLbl}:`);
            }

            // Else body (empty if none)
            for (const s of stmt.else) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
        } else {
            // Simple If without any alternate branch
            this._genCondBranch(stmt.cond, endLbl, lines);
            for (const s of stmt.then) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
        }

        lines.push(`${endLbl}:`);
    }

    // ── While statement code generation ───────────────────────────────────────
    //
    // While <cond> … Wend
    //   Condition is re-evaluated at the top of every iteration.

    _genWhile(stmt, lines) {
        const topLbl = this._nextLabel();
        const endLbl = this._nextLabel();

        this._loopStack.push(endLbl);

        // Constant-true condition (While 1, While -1, …): no test needed.
        // Emits just a top label + body + unconditional branch — saves 3 instructions
        // per iteration compared to the generic moveq/tst.l/beq.w sequence.
        if (stmt.cond.type === 'int' && stmt.cond.value !== 0) {
            lines.push(`${topLbl}:`);
            for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
            lines.push(`        bra.w   ${topLbl}`);
        } else {
            lines.push(`${topLbl}:`);
            // PERF-A: emit cmp+Bcc directly for comparison conditions
            this._genCondBranch(stmt.cond, endLbl, lines);
            for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
            lines.push(`        bra.w   ${topLbl}`);
        }

        lines.push(`${endLbl}:`);
        this._loopStack.pop();
    }

    // ── For statement code generation ─────────────────────────────────────────
    //
    // For <var> = <from> To <to> [Step <step>] … Next [<var>]
    //
    // Literal step (known at compile time):
    //   Step >= 0 → bgt.w to exit; addq.l / add.l for increment.
    //   Step <  0 → blt.w to exit; subq.l / sub.l for decrement.
    //
    // Expression step (not a literal integer):
    //   Runtime sign check — re-evaluates step and limit each iteration.

    _genFor(stmt, lines) {
        const topLbl = this._nextLabel();
        const endLbl = this._nextLabel();

        this._loopStack.push(endLbl);

        // Determine step value at compile time (null = unknown / expression)
        const stepLit = stmt.step === null       ? 1
                      : stmt.step.type === 'int' ? stmt.step.value
                      :                            null;

        // Initialise loop variable
        this._genExpr(stmt.from, lines);
        lines.push(`        move.l  d0,${this._varRef(stmt.var)}`);

        lines.push(`${topLbl}:`);

        // ── DBRA Fast Path ────────────────────────────────────────────────────────
        if (stepLit === -1 && stmt.to.type === 'int' && stmt.to.value === 0) {
            this._activeLoopRegs = this._activeLoopRegs || 0;
            if (this._activeLoopRegs < 4) {
                const regIdx = 7 - this._activeLoopRegs;
                const regNm = `d${regIdx}`;
                this._activeLoopRegs++;
                
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                lines.push(`        tst.l   d0`);
                lines.push(`        blt.w   ${endLbl}`);
                lines.push(`        move.w  d0,${regNm}`);
                
                const loopLbl = this._nextLabel();
                lines.push(`${loopLbl}:`);
                
                const cacheCandidate = (this._ptrCacheCtx === null && !this._funcCtx)
                    ? this._detectPointerCacheCandidate(stmt.body, stmt.var)
                    : null;
                    
                lines.push(`        move.w  ${regNm},d0`);
                lines.push(`        ext.l   d0`);
                lines.push(`        move.l  d0,${this._varRef(stmt.var)}`);
                
                if (cacheCandidate) {
                    lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                    this._emitMultiplyByConst(cacheCandidate.stride, lines);
                    lines.push(`        lea     _tinst_${cacheCandidate.instName},a1`);
                    lines.push(`        add.l   d0,a1`);
                    this._ptrCacheCtx = { instName: cacheCandidate.instName, regName: 'a1' };
                }
                
                for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
                
                if (cacheCandidate) this._ptrCacheCtx = null;
                
                lines.push(`        dbra    ${regNm},${loopLbl}`);
                lines.push(`        move.l  #-1,${this._varRef(stmt.var)}`);
                
                lines.push(`${endLbl}:`);
                this._loopStack.pop();
                this._activeLoopRegs--;
                return;
            }
        }

        // PERF-2: detect if body exclusively accesses one typed array via loop var.
        // Disabled when already inside an outer cached loop (no nested caching).
        // Also disabled inside functions (frame-relative loop vars not cache-compatible).
        const cacheCandidate = (this._ptrCacheCtx === null && !this._funcCtx)
            ? this._detectPointerCacheCandidate(stmt.body, stmt.var)
            : null;

        if (stepLit !== null) {
            // ── Literal step: direction known at compile time ─────────────────
            // PERF-5: avoid stack round-trip when limit is known at compile time
            if (stmt.to.type === 'int') {
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                lines.push(`        cmp.l   #${stmt.to.value},d0`);
            } else if (this._isSimpleExpr(stmt.to)) {
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                lines.push(`        cmp.l   ${this._simpleOperand(stmt.to)},d0`);
            } else {
                this._genExpr(stmt.to, lines);
                lines.push('        move.l  d0,-(sp)');
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                lines.push('        move.l  (sp)+,d1');
                lines.push('        cmp.l   d1,d0');
            }
            lines.push(stepLit >= 0
                ? `        bgt.w   ${endLbl}`              // i > limit → exit
                : `        blt.w   ${endLbl}`);            // i < limit → exit

            // PERF-2: emit pointer cache prologue — a1 = &instName[i]
            if (cacheCandidate) {
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                this._emitMultiplyByConst(cacheCandidate.stride, lines);
                lines.push(`        lea     _tinst_${cacheCandidate.instName},a1`);
                lines.push(`        add.l   d0,a1`);
                this._ptrCacheCtx = { instName: cacheCandidate.instName, regName: 'a1' };
            }

            for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }

            if (cacheCandidate) this._ptrCacheCtx = null;

            // Step increment / decrement
            const av = Math.abs(stepLit);
            if (av >= 1 && av <= 8) {
                const op = stepLit > 0 ? 'addq.l' : 'subq.l';
                lines.push(`        ${op}  #${av},${this._varRef(stmt.var)}`);
            } else {
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                lines.push(`        add.l   #${stepLit},d0`);
                lines.push(`        move.l  d0,${this._varRef(stmt.var)}`);
            }

        } else {
            // ── Expression step: runtime sign check ───────────────────────────
            const negLbl  = this._nextLabel();
            const bodyLbl = this._nextLabel();

            // Check sign of step to pick branch direction
            this._genExpr(stmt.step, lines);
            lines.push('        tst.l   d0');
            lines.push(`        bmi.s   ${negLbl}`);       // step < 0?

            // step >= 0: exit if i > limit
            this._genExpr(stmt.to, lines);
            lines.push('        move.l  d0,-(sp)');
            lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
            lines.push('        move.l  (sp)+,d1');
            lines.push('        cmp.l   d1,d0');
            lines.push(`        bgt.w   ${endLbl}`);
            lines.push(`        bra.s   ${bodyLbl}`);

            lines.push(`${negLbl}:`);
            // step < 0: exit if i < limit
            this._genExpr(stmt.to, lines);
            lines.push('        move.l  d0,-(sp)');
            lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
            lines.push('        move.l  (sp)+,d1');
            lines.push('        cmp.l   d1,d0');
            lines.push(`        blt.w   ${endLbl}`);

            lines.push(`${bodyLbl}:`);

            // PERF-2: emit pointer cache prologue
            if (cacheCandidate) {
                lines.push(`        move.l  ${this._varRef(stmt.var)},d0`);
                this._emitMultiplyByConst(cacheCandidate.stride, lines);
                lines.push(`        lea     _tinst_${cacheCandidate.instName},a1`);
                lines.push(`        add.l   d0,a1`);
                this._ptrCacheCtx = { instName: cacheCandidate.instName, regName: 'a1' };
            }

            for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }

            if (cacheCandidate) this._ptrCacheCtx = null;

            // Step: i += step (re-evaluate)
            this._genExpr(stmt.step, lines);
            lines.push(`        add.l   ${this._varRef(stmt.var)},d0`);
            lines.push(`        move.l  d0,${this._varRef(stmt.var)}`);
        }

        lines.push(`        bra.w   ${topLbl}`);
        lines.push(`${endLbl}:`);
        this._loopStack.pop();
    }

    // ── Repeat / Until statement code generation ──────────────────────────────
    //
    // Repeat … Until <cond>
    //   Body always executes at least once.
    //   At the bottom: if cond is FALSE → jump back to top (keep looping).
    //                  if cond is TRUE  → fall through (exit loop).
    //
    //   _genCondBranch(cond, topLbl) branches to topLbl when cond is false —
    //   exactly the semantics we need.

    _genRepeat(stmt, lines) {
        const topLbl = this._nextLabel();
        const endLbl = this._nextLabel();

        this._loopStack.push(endLbl);

        lines.push(`${topLbl}:`);
        for (const s of stmt.body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }

        // Until cond: repeat while cond is false
        this._genCondBranch(stmt.cond, topLbl, lines);

        lines.push(`${endLbl}:`);
        this._loopStack.pop();
    }

    // ── Select statement code generation ─────────────────────────────────────
    //
    // Select <expr>
    //   Case <val>[, <val>…]  — multiple values per Case share one jump target
    //   Default
    // EndSelect
    //
    // Pattern:
    //   Evaluate selector → push on stack.
    //   Comparison chain: for each Case value, peek selector, compare, beq.w.
    //   No match → bra.w to default or end.
    //   Case bodies follow, each ending with bra.w to end.
    //   Default body (if any).
    //   End label + addq.l #4,sp (pop selector).
    //
    // For literal integer Case values: optimised to move.l (sp),d0 / cmp.l #n,d0.
    // For expression values: general 4-instruction push/peek/pop/cmp sequence.

    _genSelect(stmt, lines) {
        const endLbl  = this._nextLabel();
        const defLbl  = stmt.default.length > 0 ? this._nextLabel() : endLbl;

        // Evaluate selector → push on stack
        this._genExpr(stmt.expr, lines);
        lines.push('        move.l  d0,-(sp)');

        // Assign one label per Case block
        const caseLabels = stmt.cases.map(() => this._nextLabel());

        // ── Comparison chain ──────────────────────────────────────────────────
        for (let i = 0; i < stmt.cases.length; i++) {
            const caseLbl = caseLabels[i];
            for (const val of stmt.cases[i].values) {
                if (val.type === 'int') {
                    // Optimised: peek selector, compare with immediate
                    lines.push('        move.l  (sp),d0');
                    lines.push(`        cmp.l   #${val.value},d0`);
                } else {
                    // General: eval value → push; peek selector; pop value → d1; cmp
                    this._genExpr(val, lines);              // value → d0
                    lines.push('        move.l  d0,-(sp)'); // push value
                    lines.push('        move.l  4(sp),d0'); // peek selector (below value)
                    lines.push('        move.l  (sp)+,d1'); // pop value → d1
                    lines.push('        cmp.l   d1,d0');    // selector - value
                }
                lines.push(`        beq.w   ${caseLbl}`);
            }
        }
        // No match → jump to default (or end if none)
        lines.push(`        bra.w   ${defLbl}`);

        // ── Case bodies ───────────────────────────────────────────────────────
        for (let i = 0; i < stmt.cases.length; i++) {
            lines.push(`${caseLabels[i]}:`);
            for (const s of stmt.cases[i].body) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
            lines.push(`        bra.w   ${endLbl}`);
        }

        // ── Default body ──────────────────────────────────────────────────────
        if (stmt.default.length > 0) {
            lines.push(`${defLbl}:`);
            for (const s of stmt.default) { lines.push(...this._genStatement(s)); this._peepholeRedundantReload(lines); }
        }

        // ── Pop selector + end ────────────────────────────────────────────────
        lines.push(`${endLbl}:`);
        lines.push('        addq.l  #4,sp');
    }

    // ── Type field write code generation ──────────────────────────────────────
    //
    // instance\field = expr  (scalar)
    // instance(index)\field = expr  (array)
    //
    // AoS layout: fieldOffset = fieldIndex * 4
    //             instanceOffset = instanceIndex * stride  (stride = fieldCount * 4)
    //
    // Variable index pattern: eval expr → push; eval index → d0; muls stride;
    // lea base → a0; add d0 → a0; pop d0; store to fieldOff(a0).
    // Stack safety: _genExpr is balanced (equal pushes and pops), so the value
    // pushed before index evaluation is still at (sp) when we restore it.

    _genTypeFieldWrite(stmt, lines) {
        const inst = this._typeInstances.get(stmt.instance);
        if (!inst) throw new Error(`Undeclared type instance '${stmt.instance}' (line ${stmt.line})`);
        const typeDef = this._typeDefs.get(inst.typeName);
        if (!typeDef) throw new Error(`Undeclared type '${inst.typeName}' (line ${stmt.line})`);
        const fieldIdx = typeDef.fields.indexOf(stmt.field);
        if (fieldIdx < 0) throw new Error(`Type '${inst.typeName}' has no field '${stmt.field}' (line ${stmt.line})`);
        const fieldOff = fieldIdx * 4;
        const stride   = typeDef.fields.length * 4;

        if (!inst.isArray) {
            // Scalar instance: direct absolute write
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,_tinst_${stmt.instance}+${fieldOff}`);
        } else if (stmt.index && stmt.index.type === 'int') {
            // Constant index: offset known at compile time
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,_tinst_${stmt.instance}+${stmt.index.value * stride + fieldOff}`);
        } else if (this._ptrCacheCtx && this._ptrCacheCtx.instName === stmt.instance
                   && stmt.index && stmt.index.type === 'ident') {
            // PERF-2: pointer cache active — a1 already points to &inst[i]
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,${fieldOff}(${this._ptrCacheCtx.regName})`);
        } else {
            // Variable index: push value, compute index offset, store
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,-(sp)`);
            this._genExpr(stmt.index, lines);
            this._emitMultiplyByConst(stride, lines);
            lines.push(`        lea     _tinst_${stmt.instance},a0`);
            lines.push(`        add.l   d0,a0`);
            lines.push(`        move.l  (sp)+,${fieldOff}(a0)`);
        }
    }

    // ── Expression code generation ────────────────────────────────────────────
    //
    // Emits code that evaluates `expr` and leaves the result in d0.
    // Uses the system stack for sub-expression temporaries.

    _genExpr(expr, lines) {
        if (!expr) {
            lines.push('        moveq   #0,d0');
            return;
        }

        switch (expr.type) {

            case 'int':
                if (expr.value >= -128 && expr.value <= 127) {
                    lines.push(`        moveq   #${expr.value},d0`);
                } else {
                    lines.push(`        move.l  #${expr.value},d0`);
                }
                break;

            case 'ident': {
                const _cv = this._consts.get(expr.name);
                if (_cv !== undefined) {
                    lines.push(`        move.l  #${_cv},d0`);
                } else {
                    lines.push(`        move.l  ${this._varRef(expr.name)},d0`);
                }
                break;
            }

            case 'array_read':
                // Evaluate index → d0; multiply by 4; offset from array base.
                this._genExpr(expr.index, lines);
                lines.push(`        asl.l   #2,d0`);
                lines.push(`        lea     _arr_${expr.name},a0`);
                lines.push(`        add.l   d0,a0`);
                lines.push(`        move.l  (a0),d0`);
                break;

            case 'call_expr': {
                // ── Built-in function dispatch (Phase 3 refactoring) ─────────
                const builtinFn = this._builtinHandlers[expr.name];
                if (builtinFn) { builtinFn(expr, lines); break; }

                // ── User function call or array read ──────────────────────────
                const funcDef = this._userFunctions.get(expr.name);
                if (funcDef) {
                    if (!funcDef.hasReturn) {
                        throw new Error(
                            `'${expr.name}' is a procedure (no return value) and cannot be used in an expression`
                        );
                    }
                    this._emitFunctionCall(expr.name, expr.args, lines);
                } else if (this._arrays.has(expr.name)) {
                    // N-dimensional array read: flat index via _genFlatIndex
                    const dimsExprs = this._arrays.get(expr.name);
                    const dims = dimsExprs.map(d => d.value);
                    this._genFlatIndex(dims, expr.args, lines);
                    lines.push(`        asl.l   #2,d0`);
                    lines.push(`        lea     _arr_${expr.name},a0`);
                    lines.push(`        add.l   d0,a0`);
                    lines.push(`        move.l  (a0),d0`);
                }
                break;
            }

            case 'type_field_read': {
                const inst    = this._typeInstances.get(expr.instance);
                if (!inst) throw new Error(`Undeclared type instance '${expr.instance}'`);
                const typeDef = this._typeDefs.get(inst.typeName);
                if (!typeDef) throw new Error(`Undeclared type '${inst.typeName}'`);
                const fieldIdx = typeDef.fields.indexOf(expr.field);
                if (fieldIdx < 0) throw new Error(`Type '${inst.typeName}' has no field '${expr.field}'`);
                const fieldOff = fieldIdx * 4;
                const stride   = typeDef.fields.length * 4;
                if (!inst.isArray) {
                    // Scalar instance: direct absolute read
                    lines.push(`        move.l  _tinst_${expr.instance}+${fieldOff},d0`);
                } else if (expr.index && expr.index.type === 'int') {
                    // Constant index: offset known at compile time
                    lines.push(`        move.l  _tinst_${expr.instance}+${expr.index.value * stride + fieldOff},d0`);
                } else if (this._ptrCacheCtx && this._ptrCacheCtx.instName === expr.instance
                           && expr.index.type === 'ident') {
                    // PERF-2: pointer cache active — a1 already points to &inst[i]
                    lines.push(`        move.l  ${fieldOff}(${this._ptrCacheCtx.regName}),d0`);
                } else {
                    // Variable index: compute at runtime
                    this._genExpr(expr.index, lines);
                    this._emitMultiplyByConst(stride, lines);
                    lines.push(`        lea     _tinst_${expr.instance},a0`);
                    lines.push(`        add.l   d0,a0`);
                    lines.push(`        move.l  ${fieldOff}(a0),d0`);
                }
                break;
            }

            case 'unary':
                if (expr.op === '-') {
                    this._genExpr(expr.operand, lines);
                    lines.push('        neg.l   d0');
                } else if (expr.op === 'not') {
                    this._genExpr(expr.operand, lines);
                    lines.push('        not.l   d0');
                }
                break;

            case 'binop':
                this._genBinop(expr, lines);
                break;

            case 'float':
                throw new Error(`Float expressions are not yet supported (line ${expr.line ?? '?'})`);

            case 'string':
                throw new Error(`String expressions cannot be used as integer values`);

            default:
                lines.push('        moveq   #0,d0');
                console.warn(`[CodeGen] Unknown expression type: ${expr.type}`);
        }
    }

    // ── PERF-B helpers ────────────────────────────────────────────────────────

    /** True when expr is a compile-time constant or a single variable reference.
     *  These can be used directly as m68k immediate/memory operands — no push/pop needed. */
    _isSimpleExpr(expr) {
        return expr.type === 'int' || expr.type === 'ident';
    }

    /** Return the m68k source operand string for a simple expression. */
    _simpleOperand(expr) {
        if (expr.type === 'int')   return `#${expr.value}`;
        if (expr.type === 'ident') {
            const _cv = this._consts.get(expr.name);
            if (_cv !== undefined) return `#${_cv}`;
            return this._varRef(expr.name);
        }
        throw new Error('[CodeGen] _simpleOperand called on non-simple expr');
    }

    /** Return the m68k operand string (memory ref or BSS label) for a variable. */
    _varRef(name) {
        if (this._funcCtx) {
            const off = this._funcCtx.localOffset[name];
            if (off !== undefined) return `${off}(a6)`;
        }
        return `_var_${name}`;
    }

    /** Emit m68k code to call a user-defined function with given args. */
    _emitFunctionCall(name, args, lines) {
        // Push arguments right-to-left (last arg first → arg[0] at 8(a6) after LINK)
        for (let i = args.length - 1; i >= 0; i--) {
            this._genExpr(args[i], lines);
            lines.push('        move.l  d0,-(sp)');
        }
        lines.push(`        jsr     _func_${name}`);
        // Caller cleanup
        const bytes = args.length * 4;
        if (bytes > 0) {
            if (bytes <= 8) {
                lines.push(`        addq.l  #${bytes},sp`);
            } else {
                lines.push(`        adda.l  #${bytes},sp`);
            }
        }
        // return value is in d0
    }

    // ── N-dimensional flat index ─────────────────────────────────────────────
    //
    // dims    = [maxIdx0, maxIdx1, ...] — integer values of declared dimension bounds
    // indices = [expr0, expr1, ...]    — AST expressions for runtime indices
    //
    // Formula (row-major, innermost dimension first):
    //   flat = i0 + (d0+1)*(i1 + (d1+1)*(i2 + ...))
    //
    // Code: evaluate from outermost index inward, using stack for partial sums.
    // Stack depth is at most 1 at any point (each push is immediately consumed).
    _genFlatIndex(dims, indices, lines) {
        // Evaluate outermost (last) index first
        this._genExpr(indices[indices.length - 1] ?? { type: 'int', value: 0 }, lines);
        // Fold inward: for each inner dimension, multiply accumulated value by
        // the current stride, then add the next index.
        for (let k = dims.length - 2; k >= 0; k--) {
            const stride = dims[k] + 1;
            if (stride !== 1) this._emitMultiplyByConst(stride, lines);
            lines.push(`        move.l  d0,-(sp)`);
            this._genExpr(indices[k] ?? { type: 'int', value: 0 }, lines);
            lines.push(`        add.l   (sp)+,d0`);
        }
    }

    // ── PERF-1: lsl.l instead of muls.w for power-of-two constants ───────────
    //
    // muls.w costs 38–70 cycles on 68000 (depends on set bits in multiplier).
    // For power-of-two strides (e.g. struct with 8 fields → stride=32 → lsl.l #5)
    // lsl.l #n costs 8+2n cycles (max 18 for n=5) — up to 4× faster.
    /** Emit `d0 *= n`. Uses lsl.l #shift if n is a power of two, else muls.w. */
    _emitMultiplyByConst(n, lines) {
        const shift = 31 - Math.clz32(n);
        if (n > 0 && (1 << shift) === n) {
            lines.push(`        lsl.l   #${shift},d0`);
        } else {
            if (n > 32767 || n < -32768) {
                throw new Error(`Multiplikation: Literal ${n} liegt außerhalb des 16-Bit-Bereichs (−32768..32767) — muls.w würde falsche Ergebnisse liefern. Weise den Wert einer Variable zu und multipliziere damit.`);
            }
            lines.push(`        move.l  #${n},d1`);
            lines.push(`        muls.w  d1,d0`);
        }
    }

    // ── T20: EQU definitions ──────────────────────────────────────────────────
    _emitEQUs(out, W, H, D, bplcon0, vStart, diwstrt, diwstop, ddfstrt, ddfstop) {
        // Overscan border: 32px on every side — drawing area larger than display
        const GFXBORDER = 32;
        out.push(`${pad('GFXWIDTH',12)} EQU ${W}`);
        out.push(`${pad('GFXHEIGHT',12)} EQU ${H}`);
        out.push(`${pad('GFXDEPTH',12)} EQU ${D}`);
        out.push(`${pad('GFXBORDER',12)} EQU ${GFXBORDER}`);
        out.push(`${pad('GFXVWIDTH',12)} EQU (GFXWIDTH+GFXBORDER*2)`);
        out.push(`${pad('GFXVHEIGHT',12)} EQU (GFXHEIGHT+GFXBORDER*2)`);
        out.push(`${pad('GFXBPR',12)} EQU (GFXVWIDTH/8)`);
        out.push(`${pad('GFXDBPR',12)} EQU (GFXWIDTH/8)`);
        out.push(`${pad('GFXIBPR',12)} EQU (GFXBPR*GFXDEPTH)`);
        out.push(`${pad('GFXBPLMOD',12)} EQU (GFXIBPR-GFXDBPR)`);
        out.push(`${pad('GFXPSIZE',12)} EQU (GFXBPR*GFXVHEIGHT)`);
        out.push(`${pad('GFXBUFSIZE',12)} EQU (GFXPSIZE*GFXDEPTH)`);
        if (this._usesTilemap && this._tilesetAssets.size > 0) {
            const tileH = this._tilesetAssets.get(0)?.tileH ?? 16;
            out.push(`${pad('GFXVPAD',12)} EQU ${tileH}`);
            out.push(`${pad('GFXBUFSIZE_VSCROLL',12)} EQU ((GFXVHEIGHT+GFXVPAD)*GFXBPR*GFXDEPTH)`);
        }
        out.push(`${pad('GFXPLANEOFS',12)} EQU (GFXBORDER*GFXIBPR+GFXBORDER/8)`);
        out.push(`${pad('GFXCOLORS',12)} EQU (1<<GFXDEPTH)`);
        out.push(`${pad('GFXBPLCON0',12)} EQU $${hex(bplcon0)}`);
        out.push(`${pad('GFXDIWSTRT',12)} EQU $${hex(diwstrt)}`);
        out.push(`${pad('GFXDIWSTOP',12)} EQU $${hex(diwstop)}`);
        out.push(`${pad('GFXDDFSTRT',12)} EQU $${hex(ddfstrt)}`);
        out.push(`${pad('GFXDDFSTOP',12)} EQU $${hex(ddfstop)}`);
        if (this._usesRaster) {
            const maxLines = Math.min(H, 256 - vStart);
            out.push(`${pad('GFXRASTER',12)} EQU ${maxLines}`);
        }
        if (this._usesBobs) {
            out.push(`${pad('BOBS_MAX',12)} EQU 32`);
        }
        // T4: Viewport Copper-Section offsets — only when explicit viewports are used.
        // Offsets are relative to the section-base label (_vpN_cop_a/b:).
        // Each Copper move is a dc.w pair (4 bytes): register word + value word.
        // VP_COP_x points to the VALUE word that needs to be patched at runtime.
        if (this._hasExplicitViewports) {
            out.push('');
            out.push('; ── Viewport Copper-Section offsets (relative to _vpN_cop_a/b:) ─');
            out.push(`${pad('VP_COP_DDFSTRT',16)} EQU 2`);   // value word of DDFSTRT move (+0/+2)
            out.push(`${pad('VP_COP_BPLCON1',16)} EQU 14`);  // value word of BPLCON1 move (+12/+14)
            out.push(`${pad('VP_COP_BPL1MOD',16)} EQU 22`);  // value word of BPL1MOD move (+20/+22)
            out.push(`${pad('VP_COP_BPL2MOD',16)} EQU 26`);  // value word of BPL2MOD move (+24/+26)
            out.push(`${pad('VP_COP_BPL',16)} EQU 28`);      // start of BPLxPT table (+28)

            // T8: Per-Viewport geometry EQUs
            out.push('');
            out.push('; ── Per-Viewport geometry ───────────────────────────────────────');
            out.push(`${pad('VP_COUNT',16)} EQU ${this._viewports.size}`);
            for (const [vpIdx, vp] of this._viewports) {
                const N = vpIdx;
                out.push(`${pad(`VP_${N}_Y1`,16)} EQU ${vp.y1}`);
                out.push(`${pad(`VP_${N}_Y2`,16)} EQU ${vp.y2}`);
                out.push(`${pad(`VP_${N}_HEIGHT`,16)} EQU ${vp.height}`);
                out.push(`${pad(`VP_${N}_VHEIGHT`,16)} EQU (VP_${N}_HEIGHT+GFXBORDER*2)`);
                out.push(`${pad(`VP_${N}_PSIZE`,16)} EQU (GFXBPR*VP_${N}_VHEIGHT)`);
                out.push(`${pad(`VP_${N}_BUFSIZE`,16)} EQU (VP_${N}_PSIZE*GFXDEPTH)`);
                if (vp.scroll) {
                    out.push(`${pad(`VP_${N}_BUFSIZE_SCROLL`,16)} EQU ((VP_${N}_VHEIGHT+GFXVPAD)*GFXBPR*GFXDEPTH)`);
                }
            }
        }
        out.push('');
    }

    // ── T20: Fragment INCLUDEs ──────────────────────────────────────────────
    _emitIncludes(out) {
        out.push('        INCLUDE "startup.s"');
        out.push('        INCLUDE "offload.s"');
        out.push('        INCLUDE "graphics.s"');
        out.push('        INCLUDE "cls.s"');
        out.push('        INCLUDE "clscolor.s"');
        out.push('        INCLUDE "color.s"');
        out.push('        INCLUDE "palette.s"');
        out.push('        INCLUDE "text.s"');
        out.push('        INCLUDE "plot.s"');
        out.push('        INCLUDE "line.s"');
        out.push('        INCLUDE "rect.s"');
        out.push('        INCLUDE "box.s"');
        out.push('        INCLUDE "waitkey.s"');
        out.push('        INCLUDE "flip.s"');
        if (this._usesRaster) {
            out.push('        INCLUDE "copper_raster.s"');
        }
        if (this._usesSound) {
            out.push('        INCLUDE "sound.s"');
        }
        if (this._usesImage || this._usesBobs) {
            out.push('        INCLUDE "image.s"');
        }
        if (this._usesBobs) {
            out.push('        INCLUDE "bobs.s"');
        }
        if (this._usesRnd) {
            out.push('        INCLUDE "rnd.s"');
        }
        if (this._usesMouse) {
            out.push('        INCLUDE "mouse.s"');
        }
        if (this._usesTilemap) {
            out.push('        INCLUDE "tilemap.s"');
        }
        out.push('');
        out.push('        even');
        out.push('');
    }

    // ── T5: Copper lists (DATA_C) — one section per viewport ─────────────────
    _emitCopperLists(out, D, H, vStart, diwstrt, diwstop, ddfstrt, ddfstop, bplcon0) {
        const GFXBORDER  = 32;
        const GFXBPR_val = Math.floor((320 + GFXBORDER * 2) / 8);
        const bplmod     = GFXBPR_val * D - Math.floor(320 / 8);
        const colors     = 1 << D;

        const emitList = (ab) => {
            // ── Global list header ───────────────────────────────────────────
            // _gfx_copper_a/b always marks the list start (used by flip.s etc.)
            out.push(`        XDEF    _gfx_copper_${ab}`);
            out.push(`_gfx_copper_${ab}:`);

            if (!this._hasExplicitViewports) {
                // Legacy: _vp0_cop_x shares the list-start position (before DIWSTRT).
                // T7 alias strategy: double-label so both old and new names resolve.
                out.push(`        XDEF    _vp0_cop_${ab}`);
                out.push(`_vp0_cop_${ab}:`);
            }

            // DIWSTRT / DIWSTOP are global (precede all viewport sections)
            out.push(copMove(0x008E, diwstrt, 'DIWSTRT'));
            out.push(copMove(0x0090, diwstop, 'DIWSTOP'));

            // ── One section per viewport ─────────────────────────────────────
            for (const [vpIdx, vp] of this._viewports) {
                // T6: WAIT before VP 1..N so the copper only applies the section
                //     when the beam has reached that viewport's first line.
                if (vpIdx > 0) {
                    const display_line = vStart + vp.y1;
                    if (display_line < 256) {
                        out.push(`        dc.w    $${hex((display_line << 8) | 0x01)},$FF00` +
                                 `             ; WAIT VP${vpIdx} y=${vp.y1} (beam line ${display_line})`);
                    } else {
                        // Lines ≥ 256 need the V8 trick: first WAIT to end-of-255,
                        // then a second WAIT with the line relative to 256.
                        out.push(`        dc.w    $FFDF,$FFFE` +
                                 `             ; WAIT end-of-line-255 (V8 flag trick)`);
                        out.push(`        dc.w    $${hex(((display_line - 256) << 8) | 0x01)},$FF00` +
                                 `             ; WAIT VP${vpIdx} y=${vp.y1} (beam line ${display_line})`);
                    }
                }
                this._emitViewportCopSection(out, ab, vpIdx, D, bplmod, bplcon0, ddfstrt, ddfstop, colors);
            }

            // Raster — only available in legacy (single-VP) mode.
            // D9: CopperColor is incompatible with explicit multi-viewport (warning issued in T3).
            if (this._usesRaster && !this._hasExplicitViewports) {
                const maxLines = Math.min(H, 256 - vStart);
                out.push(`        XDEF    _gfx_raster_${ab}`);
                out.push(`_gfx_raster_${ab}:`);
                for (let y = 0; y < maxLines; y++) {
                    const vpos = vStart + y;
                    out.push(`        dc.w    $${hex((vpos << 8) | 0x01)},$FF00`);
                    out.push(`        dc.w    $0180,$0000`);
                }
            }

            out.push(`        dc.w    $FFFF,$FFFE             ; END of copper list ${ab.toUpperCase()}`);
            out.push('');
        };

        out.push('        SECTION gfx_copper,DATA_C');
        emitList('a');
        emitList('b');
    }

    // ── T5: Viewport Copper Section emitter ───────────────────────────────────
    //
    // Emits the register moves and tables for one viewport in one copper list.
    //
    // Layout (offsets relative to _vpN_cop_x: in multi-VP mode):
    //   +0 /+2   DDFSTRT reg/val   ← VP_COP_DDFSTRT = 2
    //   +4 /+6   DDFSTOP reg/val
    //   +8 /+10  BPLCON0 reg/val
    //   +12/+14  BPLCON1 reg/val   ← VP_COP_BPLCON1 = 14  (tilemap patches BPLCON1)
    //   +16/+18  BPLCON2 reg/val
    //   +20/+22  BPL1MOD reg/val   ← VP_COP_BPL1MOD = 22  (tilemap patches BPLxMOD)
    //   +24/+26  BPL2MOD reg/val   ← VP_COP_BPL2MOD = 26
    //   +28      BPLxPT table      ← VP_COP_BPL     = 28
    //
    // In legacy mode (implicit VP0, !_hasExplicitViewports):
    //   _vp0_cop_x: is at the list start (before DIWSTRT, emitted by caller).
    //   The section label is therefore NOT re-emitted here.
    //   Legacy aliases (_gfx_cop_x_bpl_table:) are emitted alongside new labels.

    _emitViewportCopSection(out, ab, vpIdx, D, bplmod, bplcon0, ddfstrt, ddfstop, colors) {
        const sectionLabel = `_vp${vpIdx}_cop_${ab}`;
        const bplLabel     = `_vp${vpIdx}_cop_${ab}_bpl`;
        const palLabel     = `_vp${vpIdx}_cop_${ab}_pal`;

        // In multi-VP mode: emit section-base label here (after global DIWSTRT/DIWSTOP).
        // In legacy mode:   section-base was already emitted by _emitCopperLists (before DIWSTRT).
        if (this._hasExplicitViewports) {
            out.push(`        XDEF    ${sectionLabel}`);
            out.push(`${sectionLabel}:`);
        }

        out.push(copMove(0x0092, ddfstrt, 'DDFSTRT'));
        out.push(copMove(0x0094, ddfstop, 'DDFSTOP'));
        out.push(copMove(0x0100, bplcon0, 'BPLCON0'));
        out.push(copMove(0x0102, 0x0000,  'BPLCON1'));
        out.push(copMove(0x0104, 0x0000,  'BPLCON2'));
        out.push(copMove(0x0108, bplmod,  'BPL1MOD (interleaved)'));
        out.push(copMove(0x010A, bplmod,  'BPL2MOD (interleaved)'));

        // BPLxPT table — T7: legacy alias for VP0
        if (vpIdx === 0 && !this._hasExplicitViewports) {
            out.push(`        XDEF    _gfx_cop_${ab}_bpl_table`);
            out.push(`_gfx_cop_${ab}_bpl_table:`);
        }
        out.push(`        XDEF    ${bplLabel}`);
        out.push(`${bplLabel}:`);
        for (let i = 0; i < D; i++) {
            const [pth, ptl] = BPL_PTR_REGS[i];
            out.push(copMove(pth, 0, `BPL${i+1}PTH`));
            out.push(copMove(ptl, 0, `BPL${i+1}PTL`));
        }

        // Per-VP palette — only in explicit multi-VP mode.
        // Legacy: colors are managed by CPU writes in color.s / palette.s (unchanged).
        if (this._hasExplicitViewports) {
            out.push(`        XDEF    ${palLabel}`);
            out.push(`${palLabel}:`);
            for (let c = 0; c < colors; c++) {
                out.push(copMove(0x0180 + c * 2, 0x0000,
                    c === 0 ? `COLOR00 (VP${vpIdx})` : null));
            }
        }
    }

    // ── T22 / T10: User variable BSS section ──────────────────────────────────
    _emitUserVarsBSS(out, varNames) {
        if (varNames.size > 0 || this._arrays.size > 0 || this._typeInstances.size > 0
                || this._usesData || this._usesTilemap || this._viewports.size > 0) {
            out.push('        SECTION user_vars,BSS');
            for (const name of varNames) {
                out.push(`_var_${name}:    ds.l    1`);
            }
            if (this._usesData) {
                out.push('_data_ptr:      ds.l    1');
            }
            if (this._usesTilemap) {
                out.push('_active_tilemap_ptr: ds.l    1');
                out.push('_active_tileset_ptr: ds.l    1');
                out.push('_active_scroll_x:    ds.l    1');
                out.push('_active_scroll_y:    ds.l    1');
            }
            if (this._usesBobs || this._usesTilemap) {
                out.push('_active_fine_y:      ds.w    1');  // written by DrawTilemap, read by FlushBobs (0 = no scroll)
            }
            // T10: Per-viewport state variables
            for (const [vpIdx] of this._viewports) {
                const N = vpIdx;
                out.push(`_vp${N}_back_ptr:     ds.l    1`);   // visible origin of back-buffer
                out.push(`_vp${N}_cam_x:        ds.l    1`);   // camera X (world space)
                out.push(`_vp${N}_cam_y:        ds.l    1`);   // camera Y (world space)
                out.push(`_vp${N}_cop_a_base:   ds.l    1`);   // address of _vpN_cop_a section
                out.push(`_vp${N}_cop_b_base:   ds.l    1`);   // address of _vpN_cop_b section
                // Per-VP tilemap state (multi-VP mode only; legacy uses global _active_* vars)
                if (this._hasExplicitViewports && this._usesTilemap) {
                    out.push(`_vp${N}_tilemap_ptr: ds.l    1`);
                    out.push(`_vp${N}_tileset_ptr: ds.l    1`);
                    out.push(`_vp${N}_scroll_x:    ds.l    1`);
                    out.push(`_vp${N}_scroll_y:    ds.l    1`);
                }
            }
            // T10: Global active-state variables
            out.push('_active_vp_idx:      ds.w    1');   // index of currently active viewport
            out.push('_active_cop_base:    ds.l    1');   // copper section base of active VP (back-copper)
            if (this._usesBobs) {
                out.push('_active_bob_state:  ds.l    1');   // ptr to active VP Bob-State-Block (T26)
            }
            // Arrays: Dim arr(n) → n+1 longwords (indices 0..n, Blitz2D-compatible)
            // N-dimensional arrays: Dim arr(d0[, d1[, ...]]) → (d0+1)*…*(dn+1) longwords
            for (const [name, dims] of this._arrays) {
                for (const d of dims) {
                    if (d.type !== 'int') throw new Error(`Dim ${name}: array sizes must be integer literals`);
                }
                const count = dims.reduce((acc, d) => acc * (d.value + 1), 1);
                out.push(`_arr_${name}:    ds.l    ${count}`);
            }
            // Type instances: AoS layout — fieldCount longwords per instance
            for (const [instName, inst] of this._typeInstances) {
                const typeDef = this._typeDefs.get(inst.typeName);
                if (!typeDef) throw new Error(`Undeclared type '${inst.typeName}' for Dim ${instName}`);
                if (inst.isArray) {
                    if (!inst.size || inst.size.type !== 'int')
                        throw new Error(`Dim ${instName}: typed array size must be an integer literal`);
                    const count = inst.size.value + 1;   // 0..n inclusive
                    out.push(`_tinst_${instName}:    ds.l    ${count * typeDef.fields.length}`);
                } else {
                    out.push(`_tinst_${instName}:    ds.l    ${typeDef.fields.length}`);
                }
            }
            out.push('');
        }
    }

    // ── T22: User Data table (Data/Read/Restore) ───────────────────────────
    _emitDataSection(out) {
        if (this._usesData) {
            out.push('        SECTION user_data,DATA');
            out.push('_data_start:');
            for (const stmt of this._dataStmts) {
                if (stmt.label) {
                    out.push(`_data_label_${stmt.label}:`);
                }
                if (stmt.values.length > 0) {
                    const vals = stmt.values.map(v => this._evalDataValue(v, stmt.line));
                    out.push(`        dc.l    ${vals.join(', ')}`);
                }
            }
            if (this._dataStmts.length === 0) {
                out.push('        dc.l    0                       ; placeholder — no Data statements');
            }
            out.push('');
        }
    }

    // ── T7/T9: Chip RAM bitplane buffers (BSS_C) ─────────────────────────────
    //
    // Legacy mode (implicit VP0, !_hasExplicitViewports):
    //   Single buffer pair with T7 double-labels (_gfx_planes_data + _vp0_planes_a_data).
    //   Buffer size uses the global GFXBUFSIZE / GFXBUFSIZE_VSCROLL EQUs.
    //
    // Multi-VP mode (_hasExplicitViewports):
    //   One buffer pair per viewport, using per-VP VP_N_BUFSIZE EQUs (T8).
    //   No legacy labels; startup.s updated in T12.
    _emitBufferBSS(out) {
        if (!this._hasExplicitViewports) {
            // ── Legacy path (T7) ─────────────────────────────────────────────
            const planeBufSize = (this._usesTilemap && this._tilesetAssets.size > 0)
                ? 'GFXBUFSIZE_VSCROLL' : 'GFXBUFSIZE';
            out.push('        SECTION gfx_planes_a,BSS_C');
            out.push('        XDEF    _gfx_planes_data');
            out.push('_gfx_planes_data:');
            out.push('        XDEF    _vp0_planes_a_data');
            out.push('_vp0_planes_a_data:');
            out.push(`        ds.b    ${planeBufSize}`);
            out.push('');
            out.push('        SECTION gfx_planes_b,BSS_C');
            out.push('        XDEF    _gfx_planes_b_data');
            out.push('_gfx_planes_b_data:');
            out.push('        XDEF    _vp0_planes_b_data');
            out.push('_vp0_planes_b_data:');
            out.push(`        ds.b    ${planeBufSize}`);
            out.push('');
        } else {
            // ── T9: Per-viewport BSS_C buffer pair ───────────────────────────
            for (const [vpIdx, vp] of this._viewports) {
                const N       = vpIdx;
                const bufSize = vp.scroll ? `VP_${N}_BUFSIZE_SCROLL` : `VP_${N}_BUFSIZE`;
                out.push(`        SECTION vp_${N}_planes_a,BSS_C`);
                out.push(`        XDEF    _vp${N}_planes_a_data`);
                out.push(`_vp${N}_planes_a_data:`);
                out.push(`        ds.b    ${bufSize}`);
                out.push('');
                out.push(`        SECTION vp_${N}_planes_b,BSS_C`);
                out.push(`        XDEF    _vp${N}_planes_b_data`);
                out.push(`_vp${N}_planes_b_data:`);
                out.push(`        ds.b    ${bufSize}`);
                out.push('');
            }
        }

        // ── T26: Per-viewport Bob-State-Block (regular BSS, not chip RAM) ────
        if (this._usesBobs) {
            for (const [vpIdx] of this._viewports) {
                out.push(`        SECTION vp_${vpIdx}_bob_state_sec,BSS`);
                out.push(`        XDEF    _vp${vpIdx}_bob_state`);
                out.push(`_vp${vpIdx}_bob_state:  ds.b    BOB_ST_SIZE`);
                out.push('');
            }
        }
    }

    // ── T22: Asset data sections (audio, images, masks, tilesets, tilemaps, fonts) ──
    _emitAssetData(out) {
        // Audio sample data (chip RAM, one DATA_C section per unique file)
        for (const [, { filename, label: lbl }] of this._audioSamples) {
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push(`        XDEF    ${lbl}_end`);
            out.push(`${lbl}_end:`);
            out.push('');
        }

        // Image data (chip RAM, one DATA_C section per unique file)
        for (const [, { filename, label: lbl, width, height, rowbytes, isInterleaved }] of this._imageAssets) {
            const depthWord = isInterleaved ? 'GFXDEPTH+$8000' : 'GFXDEPTH';
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        dc.w    ${width},${height},${depthWord},${rowbytes}`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

        // Mask data (chip RAM, raw 1bpp transparency masks for DrawBob)
        for (const [, { filename, label: lbl }] of this._maskAssets) {
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

        // Tileset data (chip RAM — Blitter source for DrawTilemap / _bg_restore_tilemap)
        for (const [, { filename, label: lbl, tileW, tileH, rowbytes }] of this._tilesetAssets) {
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        dc.w    ${tileW},${tileH},GFXDEPTH+$8000,${rowbytes}`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

        // Tilemap data (normal RAM — CPU index lookup only, no Blitter access)
        for (const [, { filename, label: lbl }] of this._tilemapAssets) {
            out.push(`        SECTION ${lbl}_sec,DATA`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

        // Font data (fast RAM — CPU renderer, no Blitter access needed)
        for (const [, { filename, label: lbl, chars }] of this._fontAssets) {
            const lookup = new Uint8Array(128).fill(0xFF);
            for (let i = 0; i < chars.length; i++) {
                const code = chars.charCodeAt(i);
                if (code < 128) lookup[code] = i;
            }
            const lookupDc = Array.from(lookup).join(',');

            out.push(`        SECTION ${lbl}_sec,DATA`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push(`        XDEF    ${lbl}_lookup`);
            out.push(`${lbl}_lookup:`);
            out.push(`        dc.b    ${lookupDc}`);
            out.push('');
        }
    }

    // ── T11/T12/T23: _setup_graphics subroutine ───────────────────────────────
    _emitSetupGraphics(out) {
        out.push('        SECTION gfx_init,CODE');
        out.push('');
        out.push('_setup_graphics:');

        // T11: BPLxPT patch + copper base cache — one pass per viewport (both modes).
        // Uses VP-namespaced labels which exist in legacy mode too (T7 double-labels).
        for (const [vpIdx] of this._viewports) {
            const N = vpIdx;
            // Copper A: wire BPLxPT table to planes_a visible origin
            out.push(`        lea     _vp${N}_cop_a_bpl,a0`);
            out.push(`        lea     _vp${N}_planes_a_data+GFXPLANEOFS,a1`);
            out.push('        moveq   #GFXDEPTH,d0');
            out.push('        move.l  #GFXBPR,d1');
            out.push('        jsr     _PatchBitplanePtrs');
            // Copper B: wire BPLxPT table to planes_b visible origin
            out.push(`        lea     _vp${N}_cop_b_bpl,a0`);
            out.push(`        lea     _vp${N}_planes_b_data+GFXPLANEOFS,a1`);
            out.push('        moveq   #GFXDEPTH,d0');
            out.push('        move.l  #GFXBPR,d1');
            out.push('        jsr     _PatchBitplanePtrs');
            // Cache copper section base addresses (used by Viewport command and DrawTilemap)
            out.push(`        lea     _vp${N}_cop_a,a0`);
            out.push(`        move.l  a0,_vp${N}_cop_a_base`);
            out.push(`        lea     _vp${N}_cop_b,a0`);
            out.push(`        move.l  a0,_vp${N}_cop_b_base`);
        }

        // Install front copper (A) and init palette
        out.push('        lea     _gfx_copper_a,a0');
        out.push('        jsr     _InstallCopper');
        out.push('        jsr     _InitPalette');

        // T12: initial back-buffer pointers — one per viewport.
        // Front = Copper A (installed above), Back = Buffer-Set B.
        for (const [vpIdx] of this._viewports) {
            out.push(`        move.l  #_vp${vpIdx}_planes_b_data+GFXPLANEOFS,_vp${vpIdx}_back_ptr`);
        }
        // Default drawing target: VP0
        out.push('        move.l  _vp0_back_ptr,_back_planes_ptr');
        out.push('        clr.b   _front_is_a');
        // Legacy mode: initialise _active_cop_base to VP0 back-copper (B) section
        out.push('        move.l  _vp0_cop_b_base,_active_cop_base');
        // T26: initialise _active_bob_state to VP0
        if (this._usesBobs) {
            out.push('        lea     _vp0_bob_state,a0');
            out.push('        move.l  a0,_active_bob_state');
        }
        out.push('        rts');
        out.push('');
    }

    /** PERF-4: Remove `move.l d0,_var_X` immediately followed by `move.l _var_X,d0`. */
    _peepholeRedundantReload(lines) {
        const n = lines.length;
        if (n < 2) return;
        const prev = lines[n - 2].trim();
        const curr = lines[n - 1].trim();
        if (curr.endsWith(':')) return;
        const storeRe = /^move\.l\s+d0,(_var_\w+)$/;
        const loadRe  = /^move\.l\s+(_var_\w+),d0$/;
        const storeM  = storeRe.exec(prev);
        const loadM   = loadRe.exec(curr);
        if (storeM && loadM && storeM[1] === loadM[1]) lines.pop();
    }


    // ── PERF-2: struct pointer caching in For-loops ──────────────────────────
    //
    // When a For-loop body exclusively accesses one typed array via the loop
    // variable (b(i)\field), the base pointer is computed once per iteration
    // into a1, and all field reads/writes become OFFSET(a1) — 1 instruction
    // instead of lsl + lea + add.l + move (4-5 instructions).
    //
    // Fragment safety: box.s saves/restores d0-d7/a0-a2 (movem.l); sound.s
    // saves/restores d0-d5/a0-a1.  All BASSM subroutines preserve a1.
    // Nested loops: outer _ptrCacheCtx blocks inner activation (no a1 clash).

    /** Collect all variable-indexed type_field accesses in stmts.
     *  Does NOT recurse into nested For/While bodies. */
    _collectTypeFieldAccesses(stmts, accesses) {
        for (const s of stmts) {
            if (!s) continue;
            if (s.type === 'for' || s.type === 'while' || s.type === 'repeat') continue;
            if (s.type === 'type_field_write') {
                if (s.index) accesses.push({ instance: s.instance, index: s.index });
                this._collectTypeFieldAccessesInExpr(s.expr, accesses);
            } else if (s.type === 'assign') {
                this._collectTypeFieldAccessesInExpr(s.expr, accesses);
            } else if (s.type === 'array_assign') {
                this._collectTypeFieldAccessesInExpr(s.index, accesses);
                this._collectTypeFieldAccessesInExpr(s.expr, accesses);
            } else if (s.type === 'command') {
                for (const arg of s.args) this._collectTypeFieldAccessesInExpr(arg, accesses);
            } else if (s.type === 'if') {
                this._collectTypeFieldAccesses(s.then, accesses);
                for (const ei of s.elseIfs) this._collectTypeFieldAccesses(ei.body, accesses);
                this._collectTypeFieldAccesses(s.else, accesses);
            }
        }
    }

    _collectTypeFieldAccessesInExpr(expr, accesses) {
        if (!expr) return;
        switch (expr.type) {
            case 'type_field_read':
                if (expr.index) accesses.push({ instance: expr.instance, index: expr.index });
                break;
            case 'binop':
                this._collectTypeFieldAccessesInExpr(expr.left,    accesses);
                this._collectTypeFieldAccessesInExpr(expr.right,   accesses);
                break;
            case 'unary':
                this._collectTypeFieldAccessesInExpr(expr.operand, accesses);
                break;
            case 'array_read':
                this._collectTypeFieldAccessesInExpr(expr.index, accesses);
                break;
            case 'call_expr':
                for (const arg of expr.args) this._collectTypeFieldAccessesInExpr(arg, accesses);
                break;
        }
    }

    /** Returns {instName, stride} when the loop body exclusively accesses one
     *  typed array via the loop variable; null otherwise. */
    _detectPointerCacheCandidate(body, loopVar) {
        if (this._bodyAssignsVar(body, loopVar)) return null;
        const accesses = [];
        this._collectTypeFieldAccesses(body, accesses);
        const varAccesses = accesses.filter(a => a.index.type !== 'int');
        if (varAccesses.length === 0) return null;
        if (!varAccesses.every(a => a.index.type === 'ident' && a.index.name === loopVar)) return null;
        const instances = new Set(varAccesses.map(a => a.instance));
        if (instances.size !== 1) return null;
        const instName = [...instances][0];
        const inst = this._typeInstances.get(instName);
        if (!inst || !inst.isArray) return null;
        const typeDef = this._typeDefs.get(inst.typeName);
        if (!typeDef) return null;
        return { instName, stride: typeDef.fields.length * 4 };
    }

    /** True if any statement in stmts (not recursing into nested loops) assigns varName. */
    _bodyAssignsVar(stmts, varName) {
        for (const s of stmts) {
            if (!s) continue;
            if (s.type === 'for' || s.type === 'while' || s.type === 'repeat') continue;
            if (s.type === 'assign' && s.target === varName) return true;
            if (s.type === 'if') {
                if (this._bodyAssignsVar(s.then, varName)) return true;
                for (const ei of s.elseIfs) if (this._bodyAssignsVar(ei.body, varName)) return true;
                if (this._bodyAssignsVar(s.else, varName)) return true;
            }
        }
        return false;
    }

    // ── PERF-A: direct conditional branch ────────────────────────────────────
    //
    // When the condition is a direct comparison (binop = <> < > <= >=) this
    // emits a CMP + Bcc pair instead of the Scc + ext.w + ext.l + tst.l + beq.w
    // sequence, saving 4 instructions per conditional every iteration.
    //
    // falseLbl: label to branch to when the condition is FALSE (i.e. the
    //           inverse branch: if `a < b` → jump when a >= b → bge).
    //
    // Only call this for conditions inside If/While, NOT when a comparison
    // result is used as a value (e.g. `x = a < b`).

    _genCondBranch(expr, falseLbl, lines) {
        // Map each operator to the Bcc that branches on the OPPOSITE condition.
        const bccFalseMap = {
            '=':  'bne', '<>': 'beq',
            '<':  'bge', '>':  'ble',
            '<=': 'bgt', '>=': 'blt',
        };

        if (expr.type === 'binop' && bccFalseMap[expr.op]) {
            if (this._isSimpleExpr(expr.right)) {
                // PERF-A + PERF-B: load left → d0, cmp immediate/memory, branch
                this._genExpr(expr.left, lines);
                lines.push(`        cmp.l   ${this._simpleOperand(expr.right)},d0`);
            } else {
                // PERF-A only: generic eval — push right, load left, pop d1, cmp
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push('        cmp.l   d1,d0');
            }
            lines.push(`        ${bccFalseMap[expr.op]}.w   ${falseLbl}`);
            return;
        }

        // Fallback: evaluate expression as boolean value, test, branch
        this._genExpr(expr, lines);
        lines.push('        tst.l   d0');
        lines.push(`        beq.w   ${falseLbl}`);
    }

    _genBinop(expr, lines) {
        const op = expr.op;

        // ── Bitwise / logical: And Or Xor ────────────────────────────────────
        // In Blitz2D, And/Or/Xor operate on 32-bit integers — bitwise AND/OR/XOR.
        // This also works correctly for boolean values (-1/0): -1 AND -1 = -1, etc.
        // PERF-B: skip push/pop when right is a literal or single ident.
        // Note: 68000 eor only has register-source form (no eor.l #n,Dn) — use eori.
        if (op === 'and' || op === 'or' || op === 'xor') {
            const instr = op === 'and' ? 'and' : op === 'or' ? 'or' : null; // null = xor
            if (op === 'xor') {
                if (expr.right.type === 'int') {
                    this._genExpr(expr.left, lines);
                    lines.push(`        eori.l  #${expr.right.value},d0`);
                } else {
                    this._genExpr(expr.right, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(expr.left, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push('        eor.l   d1,d0');
                }
            } else if (this._isSimpleExpr(expr.right)) {
                this._genExpr(expr.left, lines);
                lines.push(`        ${instr}.l   ${this._simpleOperand(expr.right)},d0`);
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push(`        ${instr}.l   d1,d0`);
            }
            return;
        }

        // ── Shifts: Shl Shr ──────────────────────────────────────────────────
        // 68000: lsl.l #n,Dn for n=1..8; lsl.l d1,d0 for register count.
        // Shr uses asr (arithmetic/signed shift right) to preserve sign.
        if (op === 'shl' || op === 'shr') {
            const shiftInstr = op === 'shl' ? 'lsl' : 'asr';
            if (expr.right.type === 'int') {
                const n = expr.right.value;
                this._genExpr(expr.left, lines);
                if (n >= 1 && n <= 8) {
                    lines.push(`        ${shiftInstr}.l  #${n},d0`);
                } else {
                    // n > 8 or 0: use register form (move count to d1)
                    lines.push(`        move.l  d0,d1`);
                    lines.push(`        move.l  #${n},d0`);
                    lines.push(`        exg     d0,d1`);
                    lines.push(`        ${shiftInstr}.l  d1,d0`);
                }
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push(`        ${shiftInstr}.l  d1,d0`);
            }
            return;
        }

        // ── Arithmetic: + - ───────────────────────────────────────────────────
        // PERF-B: if right is a literal or single ident, skip push/pop entirely.
        if (op === '+' || op === '-') {
            if (this._isSimpleExpr(expr.right)) {
                this._genExpr(expr.left, lines);
                const v = expr.right;
                if (v.type === 'int' && v.value >= 1 && v.value <= 8) {
                    // addq/subq: 1-word instruction for 1..8
                    lines.push(`        ${op === '+' ? 'addq' : 'subq'}.l  #${v.value},d0`);
                } else {
                    lines.push(`        ${op === '+' ? 'add' : 'sub'}.l   ${this._simpleOperand(v)},d0`);
                }
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push(`        ${op === '+' ? 'add' : 'sub'}.l   d1,d0`);
            }
            return;
        }

        // ── Arithmetic: * / ───────────────────────────────────────────────────
        if (op === '*') {
            // PERF-1: if right operand is a power-of-two literal, use lsl.l
            if (expr.right.type === 'int') {
                this._genExpr(expr.left, lines);
                this._emitMultiplyByConst(expr.right.value, lines);
            } else if (expr.left.type === 'int') {
                this._genExpr(expr.right, lines);
                this._emitMultiplyByConst(expr.left.value, lines);
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push('        muls.w  d1,d0');
            }
            return;
        }
        if (op === '/') {
            // divs.w requires a register source — keep generic push/pop path.
            this._genExpr(expr.right, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(expr.left, lines);
            lines.push('        move.l  (sp)+,d1');   // d0=left, d1=right
            // divs.w: d0.l ÷ d1.w → d0.w quotient; ext.l to 32 bits
            lines.push('        divs.w  d1,d0');
            lines.push('        ext.l   d0');
            return;
        }

        // ── Modulo ────────────────────────────────────────────────────────────
        // divs.w d1,d0: d0.l ÷ d1.w → d0.hi = remainder, d0.lo = quotient
        // swap d0 puts remainder in d0.lo; ext.l sign-extends to 32 bits.
        // Divisor must fit in 16 bits (-32768..32767) — valid for all typical
        // game use cases (screen width, palette size, frame counts, etc.).
        // PERF: literal divisor → immediate form avoids push/pop.
        if (op === 'mod') {
            if (expr.right.type === 'int') {
                this._genExpr(expr.left, lines);
                lines.push(`        divs.w  #${expr.right.value},d0`);
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push('        divs.w  d1,d0');
            }
            lines.push('        swap    d0');
            lines.push('        ext.l   d0');
            return;
        }

        // ── Comparison: = <> < > <= >= ────────────────────────────────────────
        // Produces Blitz2D boolean: -1 (true) or 0 (false).
        // PERF-B: skip push/pop when right is a literal or single ident.
        const sccMap = {
            '=':  'seq',
            '<>': 'sne',
            '<':  'slt',
            '>':  'sgt',
            '<=': 'sle',
            '>=': 'sge',
        };
        if (sccMap[op]) {
            if (this._isSimpleExpr(expr.right)) {
                this._genExpr(expr.left, lines);
                lines.push(`        cmp.l   ${this._simpleOperand(expr.right)},d0`);
            } else {
                this._genExpr(expr.right, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(expr.left, lines);
                lines.push('        move.l  (sp)+,d1');   // d0=left, d1=right
                lines.push('        cmp.l   d1,d0');       // flags: d0 - d1 (left - right)
            }
            lines.push(`        ${sccMap[op]}     d0`); // d0.b = $FF (true) or $00 (false)
            lines.push('        ext.w   d0');           // sign-extend to word
            lines.push('        ext.l   d0');           // sign-extend to long (-1 or 0)
            return;
        }

        lines.push('        moveq   #0,d0');
        console.warn(`[CodeGen] Unknown binary operator: '${op}'`);
    }

    // ── Argument helpers ──────────────────────────────────────────────────────

    /** Evaluate stmt.args[idx] into d0 via _genExpr. */
    _genExprArg(stmt, idx, label, lines) {
        const arg = stmt.args[idx];
        if (!arg) throw new Error(`${label}: missing argument at position ${idx} on line ${stmt.line}`);
        this._genExpr(arg, lines);
    }

    /** Extract a compile-time integer literal (for Graphics and similar). */
    _intArg(stmt, idx, label) {
        const arg = stmt.args[idx];
        if (!arg) throw new Error(`${label}: missing argument at position ${idx} on line ${stmt.line}`);
        if (arg.type === 'int') return arg.value;
        if (arg.type === 'ident') {
            const cv = this._consts.get(arg.name);
            if (cv !== undefined) return cv;
        }
        throw new Error(`${label}: expected integer literal at position ${idx} on line ${stmt.line}`);
    }

    /**
     * Evaluate a Data-statement value to an integer at compile time.
     * Accepts: int literals, Const references, unary minus applied to either.
     */
    _evalDataValue(expr, line) {
        if (expr.type === 'int') return expr.value;
        if (expr.type === 'ident') {
            const cv = this._consts.get(expr.name);
            if (cv !== undefined) return cv;
        }
        if (expr.type === 'unary' && expr.op === '-') {
            return -this._evalDataValue(expr.operand, line);
        }
        throw new Error(`Data: value must be a compile-time integer literal (line ${line})`);
    }

    /** Extract a compile-time string literal. */
    _strArg(stmt, idx, label) {
        const arg = stmt.args[idx];
        if (!arg || arg.type !== 'string') {
            throw new Error(
                `${label}: expected string literal at position ${idx} on line ${stmt.line}`
            );
        }
        return arg.value;
    }

    /**
     * Decompose a Text string argument into flat parts for multi-part rendering.
     * Each part is either {type:'lit', value:'...'} or {type:'str_expr', expr:...}.
     * Supports: "literal", Str$(n), and (+)-concatenation of the two.
     */
    _flattenStrArg(arg) {
        if (!arg) throw new Error('Text: missing string argument');
        if (arg.type === 'string') return [{ type: 'lit', value: arg.value }];
        if (arg.type === 'call_expr' && arg.name === 'str$')
            return [{ type: 'str_expr', expr: arg.args[0] ?? { type: 'int', value: 0 } }];
        if (arg.type === 'binop' && arg.op === '+')
            return [...this._flattenStrArg(arg.left), ...this._flattenStrArg(arg.right)];
        throw new Error(`Text: expected string literal, Str$(n), or concatenation (+); got ${arg.type}`);
    }

    /** Escape double-quotes and backslashes inside a dc.b string literal. */
    _escapeStr(s) {
        return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // ── User-defined function code generation ─────────────────────────────────
    //
    // Emits a separate CODE section for each Function … EndFunction block.
    //
    // Stack frame layout (after LINK a6,#-localSpace):
    //   4(a6)               = return address   (pushed by JSR)
    //   8(a6)               = param[0]         (last thing caller pushed)
    //   12(a6)              = param[1]
    //   …
    //   -4(a6)              = local var 0
    //   -8(a6)              = local var 1
    //   …
    //
    // Calling convention: caller pushes args RIGHT-TO-LEFT, caller cleans up.
    // Return value: d0.  a6 is preserved across the call via LINK/UNLK.

    _genFunctionDef(funcDef) {
        const lines = [];
        const { name, params, localVars, body } = funcDef;

        // Local vars = vars assigned in body that are not parameters
        const localVarList = [...localVars].filter(v => !params.includes(v));
        const localSpace   = localVarList.length * 4;  // bytes for LINK displacement

        // Build offset map
        const localOffset = {};
        for (let i = 0; i < params.length; i++) {
            localOffset[params[i]] = 8 + i * 4;          // 8(a6), 12(a6), …
        }
        for (let i = 0; i < localVarList.length; i++) {
            localOffset[localVarList[i]] = -(4 + i * 4); // -4(a6), -8(a6), …
        }

        const exitLabel = this._nextLabel();
        this._funcCtx = { name, hasReturn: funcDef.hasReturn, localOffset, exitLabel };

        lines.push('');
        lines.push(`        SECTION func_${name},CODE`);
        lines.push(`        XDEF    _func_${name}`);
        lines.push(`_func_${name}:`);
        lines.push(`        link    a6,#${localSpace > 0 ? -localSpace : 0}`);
        lines.push('        movem.l d4-d7,-(sp)');

        for (const stmt of body) {
            if (!stmt) continue;
            lines.push(...this._genStatement(stmt));
            this._peepholeRedundantReload(lines);
        }

        // Default return value (0) if control falls off the end
        lines.push('        moveq   #0,d0');
        lines.push(`${exitLabel}:`);
        lines.push('        movem.l (sp)+,d4-d7');
        lines.push('        unlk    a6');
        lines.push('        rts');

        this._funcCtx = null;
        return lines;
    }

    // ── Statement handler methods (Phase 2 refactoring) ─────────────────────

    _genStmt_assign(stmt, lines) {
        const ref  = this._varRef(stmt.target);
        const expr = stmt.expr;

        // PERF-D: direct memory operations — avoid d0 round-trip
        if (expr.type === 'int' && expr.value === 0) {
            lines.push(`        clr.l   ${ref}`);
            return;
        }
        if (expr.type === 'int') {
            lines.push(`        move.l  #${expr.value},${ref}`);
            return;
        }
        if (expr.type === 'binop' && (expr.op === '+' || expr.op === '-')) {
            const isAdd = expr.op === '+';
            if (expr.left.type === 'ident' && expr.left.name === stmt.target &&
                expr.right.type === 'int' &&
                expr.right.value >= 1 && expr.right.value <= 8) {
                lines.push(`        ${isAdd ? 'addq.l' : 'subq.l'}  #${expr.right.value},${ref}`);
                return;
            }
            if (isAdd &&
                expr.right.type === 'ident' && expr.right.name === stmt.target &&
                expr.left.type === 'int' &&
                expr.left.value >= 1 && expr.left.value <= 8) {
                lines.push(`        addq.l  #${expr.left.value},${ref}`);
                return;
            }
            if (expr.left.type === 'ident' && expr.left.name === stmt.target &&
                expr.right.type === 'ident') {
                const op = isAdd ? 'add.l' : 'sub.l';
                lines.push(`        move.l  ${this._varRef(expr.right.name)},d0`);
                lines.push(`        ${op}   d0,${ref}`);
                return;
            }
            if (isAdd &&
                expr.right.type === 'ident' && expr.right.name === stmt.target &&
                expr.left.type === 'ident') {
                lines.push(`        move.l  ${this._varRef(expr.left.name)},d0`);
                lines.push(`        add.l   d0,${ref}`);
                return;
            }
        }
        // Generic fallback
        this._genExpr(expr, lines);
        lines.push(`        move.l  d0,${ref}`);
    }

    _genStmt_read(stmt, lines) {
        const ref = this._varRef(stmt.target);
        lines.push(`        move.l  _data_ptr,a0`);
        lines.push(`        move.l  (a0)+,d0`);
        lines.push(`        move.l  a0,_data_ptr`);
        lines.push(`        move.l  d0,${ref}`);
    }

    _genStmt_restore(stmt, lines) {
        const target = stmt.label ? `_data_label_${stmt.label}` : '_data_start';
        lines.push(`        lea     ${target},a0`);
        lines.push(`        move.l  a0,_data_ptr`);
    }

    // ── T13: Viewport N — switch drawing context to viewport N ───────────────
    _genStmt_viewport(stmt, lines) {
        const N = stmt.index;
        if (!this._viewports.has(N)) {
            throw new Error(`Viewport ${N}: not defined — use SetViewport first (line ${stmt.line})`);
        }

        // T15: update compile-time active viewport
        this._activeViewportIdx = N;

        // 1. Drawing-Target umschalten
        lines.push(`        move.l  _vp${N}_back_ptr,_back_planes_ptr`);

        // 2. Active-Copper-Base setzen (für DrawTilemap-Patches)
        const copALbl = this._nextLabel();
        const copDone = this._nextLabel();
        lines.push('        tst.b   _front_is_a');
        lines.push(`        bne.s   ${copALbl}`);
        lines.push(`        lea     _vp${N}_cop_b,a0`);  // front=A → back=B
        lines.push(`        bra.s   ${copDone}`);
        lines.push(`${copALbl}:`);
        lines.push(`        lea     _vp${N}_cop_a,a0`);  // front=B → back=A
        lines.push(`${copDone}:`);
        lines.push('        move.l  a0,_active_cop_base');

        // 3. Active-VP-Index setzen
        lines.push(`        move.w  #${N},_active_vp_idx`);
    }

    _genStmt_setCamera(stmt, lines) {
        const N = this._activeViewportIdx;
        this._cameraVPs.add(N);
        // eval y → d0, store to _vpN_cam_y
        this._genExpr(stmt.y, lines);
        lines.push(`        move.l  d0,_vp${N}_cam_y`);
        // eval x → d0, store to _vpN_cam_x
        this._genExpr(stmt.x, lines);
        lines.push(`        move.l  d0,_vp${N}_cam_x`);
    }

    _genStmt_local(stmt, lines) {
        if (!this._funcCtx) throw new Error(`'Local' is only valid inside a Function (line ${stmt.line})`);
        const ref = this._varRef(stmt.name);
        if (stmt.expr) {
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,${ref}`);
        } else {
            lines.push(`        clr.l   ${ref}`);
        }
    }

    _genStmt_return(stmt, lines) {
        if (!this._funcCtx) throw new Error(`'Return' outside of a Function (line ${stmt.line})`);
        if (stmt.expr) {
            if (!this._funcCtx.hasReturn) {
                throw new Error(
                    `'Return <expr>' in procedure '${this._funcCtx.name}' — procedures have no return value. ` +
                    `Use parentheses in the Function declaration to mark it as a value-returning function.`
                );
            }
            this._genExpr(stmt.expr, lines);
        } else {
            lines.push('        moveq   #0,d0');
        }
        lines.push(`        bra.w   ${this._funcCtx.exitLabel}`);
    }

    _genStmt_call(stmt, lines) {
        const funcDef = this._userFunctions.get(stmt.name);
        if (!funcDef) {
            throw new Error(`Undeclared function '${stmt.name}' called on line ${stmt.line}`);
        }
        this._emitFunctionCall(stmt.name, stmt.args, lines);
    }

    _genStmt_typeFieldWrite(stmt, lines) {
        this._genTypeFieldWrite(stmt, lines);
    }

    _genStmt_arrayAssign(stmt, lines) {
        const dimsExprs = this._arrays.get(stmt.name);
        if (!dimsExprs) throw new Error(`Undeclared array '${stmt.name}' (line ${stmt.line})`);
        const dims = dimsExprs.map(d => d.value);
        this._genExpr(stmt.expr, lines);
        lines.push(`        move.l  d0,-(sp)`);
        this._genFlatIndex(dims, stmt.indices, lines);
        lines.push(`        asl.l   #2,d0`);
        lines.push(`        lea     _arr_${stmt.name},a0`);
        lines.push(`        add.l   d0,a0`);
        lines.push(`        move.l  (sp)+,(a0)`);
    }

    _genStmt_exit(stmt, lines) {
        const depth = stmt.count ?? 1;
        const idx   = this._loopStack.length - depth;
        if (idx < 0) throw new Error(`Exit ${depth}: not inside enough loops (line ${stmt.line})`);
        lines.push(`        bra.w   ${this._loopStack[idx]}`);
    }

    _genStmt_command(stmt, lines) {
        const handler = this._cmdHandlers[stmt.name];
        if (handler) {
            handler(stmt, lines);
        } else {
            lines.push(`; [codegen] Unhandled command: ${stmt.name} (line ${stmt.line})`);
            console.warn(`[CodeGen] No codegen for '${stmt.name}' on line ${stmt.line}`);
        }
    }

    // ── Command handler table (Phase 1 refactoring) ─────────────────────────

    _initStatementHandlers() {
        const noop = () => {};
        this._stmtHandlers = {
            assign:           (s, l) => this._genStmt_assign(s, l),
            dim:              noop,
            type_def:         noop,
            dim_typed:        noop,
            dim_typed_array:  noop,
            function_def:     noop,
            const_def:        noop,
            set_viewport:     noop,       // handled in pre-pass (T3)
            set_camera:       (s, l) => this._genStmt_setCamera(s, l),
            viewport_cmd:     (s, l) => this._genStmt_viewport(s, l),
            data_stmt:        noop,
            read_stmt:        (s, l) => this._genStmt_read(s, l),
            restore_stmt:     (s, l) => this._genStmt_restore(s, l),
            local_decl:       (s, l) => this._genStmt_local(s, l),
            return:           (s, l) => this._genStmt_return(s, l),
            call_stmt:        (s, l) => this._genStmt_call(s, l),
            type_field_write: (s, l) => this._genStmt_typeFieldWrite(s, l),
            array_assign:     (s, l) => this._genStmt_arrayAssign(s, l),
            exit:             (s, l) => this._genStmt_exit(s, l),
            if:               (s, l) => this._genIf(s, l),
            while:            (s, l) => this._genWhile(s, l),
            for:              (s, l) => this._genFor(s, l),
            repeat:           (s, l) => this._genRepeat(s, l),
            select:           (s, l) => this._genSelect(s, l),
            command:          (s, l) => this._genStmt_command(s, l),
        };
    }

    _initCommandHandlers() {
        this._cmdHandlers = {
            cls:        (stmt, lines) => this._cmd_cls(stmt, lines),
            clscolor:   (stmt, lines) => this._cmd_clscolor(stmt, lines),
            color:      (stmt, lines) => this._cmd_color(stmt, lines),
            end:        (stmt, lines) => this._cmd_end(stmt, lines),
            waitvbl:    (stmt, lines) => this._cmd_waitvbl(stmt, lines),
            waitkey:    (stmt, lines) => this._cmd_waitkey(stmt, lines),
            graphics:   (stmt, lines) => this._cmd_graphics(stmt, lines),
            screenflip: (stmt, lines) => this._cmd_screenflip(stmt, lines),
            plot:       (stmt, lines) => this._cmd_plot(stmt, lines),
            line:       (stmt, lines) => this._cmd_line(stmt, lines),
            rect:       (stmt, lines) => this._cmd_rect(stmt, lines),
            box:        (stmt, lines) => this._cmd_box(stmt, lines),
            playsample:     (stmt, lines) => this._cmd_playsample(stmt, lines),
            playsampleonce: (stmt, lines) => this._cmd_playsampleonce(stmt, lines),
            stopsample:     (stmt, lines) => this._cmd_stopsample(stmt, lines),
            loadsample:     (stmt, lines) => this._cmd_loadsample(stmt, lines),
            loadfont:       (stmt, lines) => this._cmd_loadfont(stmt, lines),
            loadimage:      (stmt, lines) => this._cmd_loadimage(stmt, lines),
            loadanimimage:  (stmt, lines) => this._cmd_loadanimimage(stmt, lines),
            loadmask:       (stmt, lines) => this._cmd_loadmask(stmt, lines),
            drawimage:      (stmt, lines) => this._cmd_drawimage(stmt, lines),
            drawbob:        (stmt, lines) => this._cmd_drawbob(stmt, lines),
            setbackground:  (stmt, lines) => this._cmd_setbackground(stmt, lines),
            text:           (stmt, lines) => this._cmd_text(stmt, lines),
            usefont:        (stmt, lines) => this._cmd_usefont(stmt, lines),
            pokeb:          (stmt, lines) => this._cmd_poke(stmt, lines),
            pokew:          (stmt, lines) => this._cmd_poke(stmt, lines),
            pokel:          (stmt, lines) => this._cmd_poke(stmt, lines),
            poke:           (stmt, lines) => this._cmd_poke(stmt, lines),
            palettecolor:   (stmt, lines) => this._cmd_palettecolor(stmt, lines),
            coppercolor:    (stmt, lines) => this._cmd_coppercolor(stmt, lines),
            loadtileset:    (stmt, lines) => this._cmd_loadtileset(stmt, lines),
            loadtilemap:    (stmt, lines) => this._cmd_loadtilemap(stmt, lines),
            drawtilemap:    (stmt, lines) => this._cmd_drawtilemap(stmt, lines),
            settilemap:     (stmt, lines) => this._cmd_settilemap(stmt, lines),
            delay:          (stmt, lines) => this._cmd_delay(stmt, lines),
        };
    }

    _cmd_cls(stmt, lines) {
        // T14: per-viewport BLTSIZE — visible height of active VP, per-plane
        const vp = this._viewports.get(this._activeViewportIdx);
        lines.push(`        move.w  #(${vp.height}<<6|(GFXBPR/2)),d0`);
        lines.push('        jsr     _Cls');
    }

    _cmd_clscolor(stmt, lines) {
        this._genExprArg(stmt, 0, 'ClsColor', lines);
        lines.push('        jsr     _ClsColor');
    }

    _cmd_color(stmt, lines) {
        this._genExprArg(stmt, 0, 'Color', lines);
        lines.push('        move.w  d0,_draw_color');
    }

    _cmd_end(stmt, lines) {
        lines.push('        rts');
    }

    _cmd_waitvbl(stmt, lines) {
        lines.push('        jsr     _WaitVBL');
    }

    _cmd_waitkey(stmt, lines) {
        lines.push('        jsr     _WaitKey');
    }

    _cmd_graphics(stmt, lines) {
        lines.push('        jsr     _setup_graphics');
        if (this._usesMouse) lines.push('        jsr     _MouseInit');
    }

    _cmd_screenflip(stmt, lines) {
        if (this._usesBobs) lines.push('        jsr     _FlushBobs');
        lines.push('        jsr     _ScreenFlip');

        // T16: inline VP-pointer swap — _ScreenFlip toggled _front_is_a,
        // now update all per-VP back pointers accordingly.
        const flipBLbl = this._nextLabel();
        const flipDone = this._nextLabel();
        lines.push('        tst.b   _front_is_a');
        lines.push(`        bne.s   ${flipBLbl}`);

        // front_is_a = 0 → Back is Buffer-Set B
        for (const [vpIdx] of this._viewports) {
            lines.push(`        move.l  #_vp${vpIdx}_planes_b_data+GFXPLANEOFS,_vp${vpIdx}_back_ptr`);
        }
        lines.push('        move.l  _vp0_cop_b_base,_active_cop_base');
        lines.push(`        bra.s   ${flipDone}`);

        // front_is_a = 1 → Back is Buffer-Set A
        lines.push(`${flipBLbl}:`);
        for (const [vpIdx] of this._viewports) {
            lines.push(`        move.l  #_vp${vpIdx}_planes_a_data+GFXPLANEOFS,_vp${vpIdx}_back_ptr`);
        }
        lines.push('        move.l  _vp0_cop_a_base,_active_cop_base');

        lines.push(`${flipDone}:`);
        // Default drawing target: VP0
        lines.push('        move.l  _vp0_back_ptr,_back_planes_ptr');
    }

    _cmd_plot(stmt, lines) {
        // Plot x, y  →  _Plot(d0=x, d1=y)
        this._genExprArg(stmt, 1, 'Plot y', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 0, 'Plot x', lines);
        lines.push('        move.l  (sp)+,d1');
        lines.push('        jsr     _Plot');
    }

    _cmd_line(stmt, lines) {
        // Line x1,y1,x2,y2  →  _Line(d0=x1, d1=y1, d2=x2, d3=y2)
        this._genExprArg(stmt, 3, 'Line y2', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 2, 'Line x2', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 1, 'Line y1', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 0, 'Line x1', lines);
        lines.push('        movem.l (sp)+,d1-d3');
        lines.push('        jsr     _Line');
    }

    _cmd_rect(stmt, lines) {
        // Rect x,y,w,h  →  _Rect(d0=x, d1=y, d2=w, d3=h)
        this._genExprArg(stmt, 3, 'Rect h', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 2, 'Rect w', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 1, 'Rect y', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 0, 'Rect x', lines);
        lines.push('        movem.l (sp)+,d1-d3');
        lines.push('        jsr     _Rect');
    }

    _cmd_box(stmt, lines) {
        // Box x,y,w,h  →  _Box(d0=x, d1=y, d2=w, d3=h)
        this._genExprArg(stmt, 3, 'Box h', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 2, 'Box w', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 1, 'Box y', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 0, 'Box x', lines);
        lines.push('        movem.l (sp)+,d1-d3');
        lines.push('        jsr     _Box');
    }

    _cmd_playsample(stmt, lines) {
        // PlaySample index, channel [, period [, volume]]
        const idxArg = stmt.args[0];
        if (!idxArg || idxArg.type !== 'int')
            throw new Error(`PlaySample: index must be an integer literal (line ${stmt.line})`);
        const entry = this._audioSamples.get(idxArg.value);
        if (!entry)
            throw new Error(`PlaySample: sample index ${idxArg.value} not loaded — use LoadSample first (line ${stmt.line})`);
        const { label: lbl } = entry;

        const volArg = stmt.args[3] ?? { type: 'int', value: 64 };
        const perArg = stmt.args[2] ?? { type: 'int', value: 428 };

        this._genExpr(volArg, lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExpr(perArg, lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 1, 'PlaySample channel', lines);
        lines.push('        move.l  d0,-(sp)');

        lines.push(`        lea     ${lbl},a0`);
        lines.push(`        move.l  #(${lbl}_end-${lbl})/2,d1`);

        lines.push('        movem.l (sp)+,d0/d2-d3');
        lines.push('        jsr     _PlaySample');
    }

    _cmd_playsampleonce(stmt, lines) {
        // PlaySampleOnce index, channel [, period [, volume]]
        const idxArg = stmt.args[0];
        if (!idxArg || idxArg.type !== 'int')
            throw new Error(`PlaySampleOnce: index must be an integer literal (line ${stmt.line})`);
        const entry = this._audioSamples.get(idxArg.value);
        if (!entry)
            throw new Error(`PlaySampleOnce: sample index ${idxArg.value} not loaded — use LoadSample first (line ${stmt.line})`);
        const { label: lbl } = entry;

        const volArg = stmt.args[3] ?? { type: 'int', value: 64 };
        const perArg = stmt.args[2] ?? { type: 'int', value: 428 };

        this._genExpr(volArg, lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExpr(perArg, lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 1, 'PlaySampleOnce channel', lines);
        lines.push('        move.l  d0,-(sp)');

        lines.push(`        lea     ${lbl},a0`);
        lines.push(`        move.l  #(${lbl}_end-${lbl})/2,d1`);

        lines.push('        movem.l (sp)+,d0/d2-d3');
        lines.push('        jsr     _PlaySampleOnce');
    }

    _cmd_stopsample(stmt, lines) {
        // StopSample channel  →  d0=channel, jsr _StopSample
        this._genExprArg(stmt, 0, 'StopSample channel', lines);
        lines.push('        jsr     _StopSample');
    }

    _cmd_loadsample(stmt, lines) {
        // LoadSample index, "file" — pre-registered in _collectVars; no runtime code.
    }

    _cmd_loadfont(stmt, lines) {
        // LoadFont index, "chars", "file", charW, charH — pre-registered in _collectVars; no runtime code.
    }

    _cmd_loadimage(stmt, lines) {
        // LoadImage 0 automatically applies the image's embedded palette at runtime.
        // Other indices: no code emitted (data only, INCBIN at end of generate()).
        if (stmt.args[0]?.type === 'int' && stmt.args[0].value === 0) {
            const slot = this._imageAssets.get(0);
            if (slot) {
                lines.push(`        lea     ${slot.label},a0`);
                lines.push(`        jsr     _SetImagePalette`);
            }
        }
    }

    _cmd_loadanimimage(stmt, lines) {
        // LoadAnimImage index,"f.raw",fw,fh,count — data only; INCBIN at end.
        // Index 0: apply embedded palette at runtime (same as LoadImage).
        if (stmt.args[0]?.type === 'int' && stmt.args[0].value === 0) {
            const slot = this._imageAssets.get(0);
            if (slot) {
                lines.push(`        lea     ${slot.label},a0`);
                lines.push(`        jsr     _SetImagePalette`);
            }
        }
    }

    _cmd_loadmask(stmt, lines) {
        // LoadMask index, "file.mask" — registered in _collectVars; no runtime code.
    }

    _cmd_drawimage(stmt, lines) {
        // DrawImage index, x, y [, frame]
        const imgIdxArg = stmt.args[0];
        if (!imgIdxArg || imgIdxArg.type !== 'int')
            throw new Error(`DrawImage: index must be an integer literal (line ${stmt.line})`);
        const imgEntry = this._imageAssets.get(imgIdxArg.value);
        if (!imgEntry)
            throw new Error(`DrawImage: image index ${imgIdxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);

        const xExpr    = stmt.args[1] ?? { type: 'int', value: 0 };
        const yExpr    = stmt.args[2] ?? { type: 'int', value: 0 };
        const frameArg = stmt.args[3];

        if (frameArg && !imgEntry.isAnim)
            throw new Error(`DrawImage: frame argument requires LoadAnimImage (image ${imgIdxArg.value} was loaded with LoadImage) — line ${stmt.line}`);

        if (!frameArg) {
            this._genExpr(yExpr, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            lines.push('        move.l  (sp)+,d1');
            lines.push(`        lea     ${imgEntry.label},a0`);
            lines.push('        jsr     _DrawImage');
        } else if (frameArg.type === 'int') {
            this._genExpr(yExpr, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            lines.push('        move.l  (sp)+,d1');
            lines.push(`        moveq   #${frameArg.value},d2`);
            lines.push(`        lea     ${imgEntry.label},a0`);
            lines.push('        jsr     _DrawImageFrame');
        } else {
            this._genExpr(frameArg, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(yExpr, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            lines.push('        move.l  (sp)+,d1');
            lines.push('        move.l  (sp)+,d2');
            lines.push(`        lea     ${imgEntry.label},a0`);
            lines.push('        jsr     _DrawImageFrame');
        }
    }

    _cmd_drawbob(stmt, lines) {
        // DrawBob index, x, y [, frame]
        const idxArg = stmt.args[0];
        if (!idxArg || idxArg.type !== 'int')
            throw new Error(`DrawBob: index must be an integer literal (line ${stmt.line})`);
        const imgEntry = this._imageAssets.get(idxArg.value);
        if (!imgEntry)
            throw new Error(`DrawBob: image index ${idxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);
        const maskEntry = this._maskAssets.get(idxArg.value);

        const xExpr    = stmt.args[1] ?? { type: 'int', value: 0 };
        const yExpr    = stmt.args[2] ?? { type: 'int', value: 0 };
        const frameArg = stmt.args[3];

        if (frameArg && !imgEntry.isAnim)
            throw new Error(`DrawBob: frame argument requires LoadAnimImage (image ${idxArg.value} was loaded with LoadImage) — line ${stmt.line}`);

        const N = this._activeViewportIdx;
        const hasCam = this._cameraVPs.has(N);

        if (!frameArg || (frameArg.type === 'int' && frameArg.value === 0)) {
            this._genExpr(yExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_y,d0`);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_x,d0`);
            lines.push('        move.l  (sp)+,d1');
            lines.push('        moveq   #0,d2');
        } else if (frameArg.type === 'int') {
            this._genExpr(yExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_y,d0`);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_x,d0`);
            lines.push('        move.l  (sp)+,d1');
            lines.push(`        moveq   #${frameArg.value},d2`);
        } else {
            this._genExpr(frameArg, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(yExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_y,d0`);
            lines.push('        move.l  d0,-(sp)');
            this._genExpr(xExpr, lines);
            if (hasCam) lines.push(`        sub.l   _vp${N}_cam_x,d0`);
            lines.push('        move.l  (sp)+,d1');
            lines.push('        move.l  (sp)+,d2');
        }
        lines.push(`        lea     ${imgEntry.label},a0`);
        if (maskEntry) {
            lines.push(`        lea     ${maskEntry.label},a1`);
        } else {
            lines.push('        move.l  #0,a1');
        }
        lines.push('        jsr     _AddBob');
    }

    _cmd_setbackground(stmt, lines) {
        // SetBackground index — register a full-screen image as the background.
        const idxArg = stmt.args[0];
        if (!idxArg || idxArg.type !== 'int')
            throw new Error(`SetBackground: index must be an integer literal (line ${stmt.line})`);
        const bgEntry = this._imageAssets.get(idxArg.value);
        if (!bgEntry)
            throw new Error(`SetBackground: image index ${idxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);
        lines.push(`        lea     ${bgEntry.label},a0`);
        lines.push('        jsr     _SetBackground');
    }

    _cmd_delay(stmt, lines) {
        const loopLbl = this._nextLabel();
        const skipLbl = this._nextLabel();
        this._genExprArg(stmt, 0, 'Delay frames', lines);
        lines.push(`        tst.l   d0`);
        lines.push(`        ble.s   ${skipLbl}`);
        lines.push(`        subq.l  #1,d0`);
        lines.push(`        move.l  d0,d7`);
        lines.push(`${loopLbl}:`);
        lines.push(`        jsr     _WaitVBL`);
        lines.push(`        dbra    d7,${loopLbl}`);
        lines.push(`${skipLbl}:`);
    }

    // ── T6: Text Commands ─────────────────────────────────────────────────────

    _cmd_text(stmt, lines) {
        const parts = this._flattenStrArg(stmt.args[2]);
        this._genExprArg(stmt, 1, 'Text y', lines);
        lines.push('        move.l  d0,-(sp)');
        this._genExprArg(stmt, 0, 'Text x', lines);
        lines.push('        move.l  (sp)+,d1');
        if (parts.length === 1 && parts[0].type === 'lit') {
            const strLbl  = this._nextLabel();
            const pastLbl = this._nextLabel();
            lines.push(`        lea     ${strLbl},a0`);
            lines.push('        jsr     _Text');
            lines.push(`        bra.s   ${pastLbl}`);
            lines.push(`${strLbl}:`);
            lines.push(`        dc.b    "${this._escapeStr(parts[0].value)}",0`);
            lines.push('        even');
            lines.push(`${pastLbl}:`);
        } else {
            lines.push('        move.l  d1,_text_y');
            for (const part of parts) {
                if (part.type === 'lit') {
                    const strLbl  = this._nextLabel();
                    const pastLbl = this._nextLabel();
                    lines.push(`        lea     ${strLbl},a0`);
                    lines.push('        jsr     _Text');
                    lines.push(`        bra.s   ${pastLbl}`);
                    lines.push(`${strLbl}:`);
                    lines.push(`        dc.b    "${this._escapeStr(part.value)}",0`);
                    lines.push('        even');
                    lines.push(`${pastLbl}:`);
                    lines.push('        move.l  _text_y,d1');
                } else {
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(part.expr, lines);
                    lines.push('        jsr     _IntToStr');
                    lines.push('        move.l  d0,a0');
                    lines.push('        move.l  (sp)+,d0');
                    lines.push('        move.l  _text_y,d1');
                    lines.push('        jsr     _Text');
                    lines.push('        move.l  _text_y,d1');
                }
            }
        }
    }

    _cmd_usefont(stmt, lines) {
        const idxArg = stmt.args[0];
        const lc = this._labelCount++;
        if (!idxArg) {
            lines.push('        ; UseFont — built-in font');
            lines.push('        move.w  #8,_active_font_charW');
            lines.push('        move.w  #8,_active_font_charH');
            lines.push('        move.w  #7,_active_font_charH_m1');
            lines.push('        move.l  #_font8x8,_active_font_data');
            lines.push('        lea     _builtin_font_lookup,a0');
            lines.push('        lea     _active_font_lookup,a1');
            lines.push('        moveq   #31,d0');
            lines.push(`.uf_${lc}:  move.l  (a0)+,(a1)+`);
            lines.push(`        dbra    d0,.uf_${lc}`);
        } else {
            if (idxArg.type !== 'int')
                throw new Error(`UseFont: Index muss ein Integer-Literal sein (Zeile ${stmt.line})`);
            const fontEntry = this._fontAssets.get(idxArg.value);
            if (!fontEntry)
                throw new Error(`UseFont: Font ${idxArg.value} nicht geladen — LoadFont zuerst aufrufen (Zeile ${stmt.line})`);
            const { label: lbl, charW, charH } = fontEntry;
            lines.push(`        ; UseFont ${idxArg.value} — ${fontEntry.filename}`);
            lines.push(`        move.w  #${charW},_active_font_charW`);
            lines.push(`        move.w  #${charH},_active_font_charH`);
            lines.push(`        move.w  #${charH - 1},_active_font_charH_m1`);
            lines.push(`        move.l  #${lbl},_active_font_data`);
            lines.push(`        lea     ${lbl}_lookup,a0`);
            lines.push('        lea     _active_font_lookup,a1');
            lines.push('        moveq   #31,d0');
            lines.push(`.uf_${lc}:  move.l  (a0)+,(a1)+`);
            lines.push(`        dbra    d0,.uf_${lc}`);
        }
    }

    // ── T7: Poke/Palette Commands ─────────────────────────────────────────────

    _cmd_poke(stmt, lines) {
        const sz      = stmt.name === 'pokeb' ? 'b' : stmt.name === 'pokew' ? 'w' : 'l';
        const addrArg = stmt.args[0] ?? { type: 'int', value: 0 };
        const valArg  = stmt.args[1] ?? { type: 'int', value: 0 };
        if (addrArg.type === 'int' && valArg.type === 'int') {
            const hex = '$' + (addrArg.value >>> 0).toString(16).toUpperCase();
            lines.push(`        move.${sz}  #${valArg.value},${hex}`);
        } else if (addrArg.type === 'int') {
            const hex = '$' + (addrArg.value >>> 0).toString(16).toUpperCase();
            this._genExprArg(stmt, 1, `Poke${sz.toUpperCase()} val`, lines);
            lines.push(`        move.${sz}  d0,${hex}`);
        } else {
            this._genExpr(addrArg, lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExprArg(stmt, 1, `Poke${sz.toUpperCase()} val`, lines);
            lines.push('        move.l  (sp)+,a0');
            lines.push(`        move.${sz}  d0,(a0)`);
        }
    }

    _cmd_palettecolor(stmt, lines) {
        if (stmt.args.every(a => a.type === 'int')) {
            const n   = stmt.args[0].value;
            const r   = stmt.args[1].value & 0xF;
            const g   = stmt.args[2].value & 0xF;
            const b   = stmt.args[3].value & 0xF;
            const rgb = (r << 8) | (g << 4) | b;
            lines.push(`        moveq   #${n},d0`);
            lines.push(`        move.w  #$${hex(rgb)},d1`);
            lines.push('        jsr     _SetPaletteColor');
        } else {
            this._genExprArg(stmt, 3, 'PaletteColor b', lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExprArg(stmt, 2, 'PaletteColor g', lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExprArg(stmt, 1, 'PaletteColor r', lines);
            lines.push('        move.l  d0,-(sp)');
            this._genExprArg(stmt, 0, 'PaletteColor n', lines);
            lines.push('        movem.l (sp)+,d1-d3');
            lines.push('        jsr     _SetPaletteColorRGB');
        }
    }

    // ── T8: CopperColor ───────────────────────────────────────────────────────

    _cmd_coppercolor(stmt, lines) {
        if (stmt.args.every(a => a.type === 'int')) {
            const y      = stmt.args[0].value;
            const r      = stmt.args[1].value & 0xF;
            const g      = stmt.args[2].value & 0xF;
            const b      = stmt.args[3].value & 0xF;
            const rgb    = (r << 8) | (g << 4) | b;
            const offset = y * 8 + 6;
            const lblA   = this._nextLabel();
            const lblEnd = this._nextLabel();
            lines.push(`        tst.b   _front_is_a`);
            lines.push(`        bne.s   ${lblA}`);
            lines.push(`        move.w  #$${hex(rgb)},_gfx_raster_b+${offset}`);
            lines.push(`        bra.s   ${lblEnd}`);
            lines.push(`${lblA}:`);
            lines.push(`        move.w  #$${hex(rgb)},_gfx_raster_a+${offset}`);
            lines.push(`${lblEnd}:`);
        } else {
            const lblA = this._nextLabel();
            const lblW = this._nextLabel();

            const rArg = stmt.args[1];
            const gArg = stmt.args[2];
            const bArg = stmt.args[3];
            const rIsZero = rArg.type === 'int' && rArg.value === 0;
            const gIsZero = gArg.type === 'int' && gArg.value === 0;
            const bIsZero = bArg.type === 'int' && bArg.value === 0;

            if (rIsZero) {
                lines.push('        moveq   #0,d2');
            } else {
                this._genExprArg(stmt, 1, 'CopperColor r', lines);
                lines.push('        andi.w  #$F,d0');
                lines.push('        lsl.w   #8,d0');
                lines.push('        move.w  d0,d2');
            }

            if (!gIsZero) {
                this._genExprArg(stmt, 2, 'CopperColor g', lines);
                lines.push('        andi.w  #$F,d0');
                lines.push('        lsl.w   #4,d0');
                lines.push('        or.w    d0,d2');
            }

            if (!bIsZero) {
                this._genExprArg(stmt, 3, 'CopperColor b', lines);
                lines.push('        andi.w  #$F,d0');
                lines.push('        or.w    d0,d2');
            }

            this._genExprArg(stmt, 0, 'CopperColor y', lines);
            lines.push('        lsl.l   #3,d0');

            lines.push('        tst.b   _front_is_a');
            lines.push(`        bne.s   ${lblA}`);
            lines.push('        lea     _gfx_raster_b,a0');
            lines.push(`        bra.s   ${lblW}`);
            lines.push(`${lblA}:`);
            lines.push('        lea     _gfx_raster_a,a0');
            lines.push(`${lblW}:`);
            lines.push('        move.w  d2,6(a0,d0.l)');
        }
    }

    // ── T9: Tilemap Commands ──────────────────────────────────────────────────

    _cmd_loadtileset(stmt, lines) {
        if (stmt.args[0]?.type === 'int' && stmt.args[0].value === 0) {
            const tsEntry = this._tilesetAssets.get(0);
            if (tsEntry) {
                lines.push(`        lea     ${tsEntry.label},a0`);
                lines.push('        jsr     _SetImagePalette');
            }
        }
    }

    _cmd_loadtilemap(stmt, lines) {
        // LoadTilemap slot, "file.bmap" — data only; no runtime code.
    }

    _cmd_drawtilemap(stmt, lines) {
        const tmIdxArg = stmt.args[0];
        const tsIdxArg = stmt.args[1];
        if (!tmIdxArg || tmIdxArg.type !== 'int')
            throw new Error(`DrawTilemap: tmSlot must be an integer literal (line ${stmt.line})`);
        if (!tsIdxArg || tsIdxArg.type !== 'int')
            throw new Error(`DrawTilemap: tsSlot must be an integer literal (line ${stmt.line})`);
        const tmEntry = this._tilemapAssets.get(tmIdxArg.value);
        if (!tmEntry)
            throw new Error(`DrawTilemap: tilemap slot ${tmIdxArg.value} not loaded — use LoadTilemap first (line ${stmt.line})`);
        const tsEntry = this._tilesetAssets.get(tsIdxArg.value);
        if (!tsEntry)
            throw new Error(`DrawTilemap: tileset slot ${tsIdxArg.value} not loaded — use LoadTileset first (line ${stmt.line})`);

        const argc = stmt.args.length;

        const vpN = this._activeViewportIdx;
        const multiVP = this._hasExplicitViewports;

        if (argc === 2) {
            // Camera-Modus: scrollX/Y aus aktiver Viewport-Kamera
            if (!multiVP)
                throw new Error(`DrawTilemap camera mode requires explicit viewports — use SetViewport first (line ${stmt.line})`);
            if (!this._cameraVPs.has(vpN))
                throw new Error(`DrawTilemap camera mode requires SetCamera in Viewport ${vpN} (line ${stmt.line})`);
            lines.push(`        move.l  _vp${vpN}_cam_x,d0`);
            lines.push('        move.l  d0,_active_scroll_x');
            lines.push(`        move.l  _vp${vpN}_cam_y,d1`);
            lines.push('        move.l  d1,_active_scroll_y');
        } else {
            // Explicit scroll: 3 args → scrollX only (scrollY=0), 4 args → both
            const scrollXExpr = stmt.args[2];
            const scrollYExpr = stmt.args[3] ?? { type: 'int', value: 0 };
            this._genExpr(scrollXExpr, lines);
            lines.push('        move.l  d0,_active_scroll_x');
            this._genExpr(scrollYExpr, lines);
            lines.push('        move.l  d0,d1');
            lines.push('        move.l  d0,_active_scroll_y');
            lines.push('        move.l  _active_scroll_x,d0');
        }
        // T23: mirror scroll state into per-VP variables for _bg_restore_tilemap
        if (multiVP) {
            lines.push(`        move.l  d0,_vp${vpN}_scroll_x`);
            lines.push(`        move.l  d1,_vp${vpN}_scroll_y`);
        }
        lines.push(`        lea     ${tmEntry.label},a0`);
        lines.push(`        lea     ${tsEntry.label},a1`);
        lines.push('        jsr     _DrawTilemap');
    }

    _cmd_settilemap(stmt, lines) {
        const tmIdxArg = stmt.args[0];
        const tsIdxArg = stmt.args[1];
        if (!tmIdxArg || tmIdxArg.type !== 'int')
            throw new Error(`SetTilemap: tmSlot must be an integer literal (line ${stmt.line})`);
        if (!tsIdxArg || tsIdxArg.type !== 'int')
            throw new Error(`SetTilemap: tsSlot must be an integer literal (line ${stmt.line})`);
        const tmEntry = this._tilemapAssets.get(tmIdxArg.value);
        if (!tmEntry)
            throw new Error(`SetTilemap: tilemap slot ${tmIdxArg.value} not loaded — use LoadTilemap first (line ${stmt.line})`);
        const tsEntry = this._tilesetAssets.get(tsIdxArg.value);
        if (!tsEntry)
            throw new Error(`SetTilemap: tileset slot ${tsIdxArg.value} not loaded — use LoadTileset first (line ${stmt.line})`);

        lines.push(`        lea     ${tmEntry.label},a0`);
        lines.push('        move.l  a0,_active_tilemap_ptr');
        lines.push(`        lea     ${tsEntry.label},a0`);
        lines.push('        move.l  a0,_active_tileset_ptr');
        if (this._hasExplicitViewports) {
            const N = this._activeViewportIdx;
            lines.push(`        move.l  _active_tilemap_ptr,_vp${N}_tilemap_ptr`);
            lines.push(`        move.l  a0,_vp${N}_tileset_ptr`);
        }
        lines.push('        move.l  _active_bob_state,a0');
        lines.push('        lea     _bg_restore_tilemap,a1');
        lines.push('        move.l  a1,BOB_ST_RESTORE_FN(a0)');
    }

    // ── Built-in function handler table (Phase 3 refactoring) ───────────────

    _initBuiltinHandlers() {
        this._builtinHandlers = {
            abs:    (expr, lines) => this._builtin_abs(expr, lines),
            rnd:    (expr, lines) => this._builtin_rnd(expr, lines),
            'str$': (expr, lines) => this._builtin_str(expr, lines),
            // T15: Joystick
            joyup:      (expr, lines) => this._builtin_joydir(expr, lines, 9),
            joydown:    (expr, lines) => this._builtin_joydir(expr, lines, 8),
            joyleft:    (expr, lines) => this._builtin_joydir(expr, lines, 1),
            joyright:   (expr, lines) => this._builtin_joydir(expr, lines, 0),
            joyfire:    (expr, lines) => this._builtin_joyfire(expr, lines),
            // T16: Mouse
            mousex:     (expr, lines) => this._builtin_mousex(expr, lines),
            mousey:     (expr, lines) => this._builtin_mousey(expr, lines),
            mousedown:  (expr, lines) => this._builtin_mousedown(expr, lines),
            mousehit:   (expr, lines) => this._builtin_mousehit(expr, lines),
            // T17: Keyboard + Peek
            keydown:    (expr, lines) => this._builtin_keydown(expr, lines),
            peekb:      (expr, lines) => this._builtin_peek(expr, lines, 'b'),
            peekw:      (expr, lines) => this._builtin_peek(expr, lines, 'w'),
            peekl:      (expr, lines) => this._builtin_peek(expr, lines, 'l'),
            // T18: Collision
            rectsoverlap:     (expr, lines) => this._builtin_rectsoverlap(expr, lines),
            imagesoverlap:    (expr, lines) => this._builtin_imagesoverlap(expr, lines),
            imagerectoverlap: (expr, lines) => this._builtin_imagerectoverlap(expr, lines),
        };
    }

    // ── T24: _collectVars command handler map ─────────────────────────────────
    _initCollectHandlers() {
        this._collectCmdHandlers = {
            coppercolor: () => { this._usesRaster = true; },

            loadsample: (stmt) => {
                this._usesSound = true;
                const idxArg  = stmt.args[0];
                const fileArg = stmt.args[1];
                if (idxArg && idxArg.type === 'int' && fileArg && fileArg.type === 'string') {
                    if (!this._audioSamples.has(idxArg.value)) {
                        const lbl = `_snd_${this._audioSamples.size}`;
                        this._audioSamples.set(idxArg.value, { filename: fileArg.value, label: lbl });
                    }
                }
            },

            loadimage: (stmt) => {
                this._usesImage = true;
                const idxArg  = stmt.args[0];
                const fileArg = stmt.args[1];
                const wArg    = stmt.args[2];
                const hArg    = stmt.args[3];
                if (idxArg?.type === 'int' && fileArg?.type === 'string' &&
                    wArg?.type === 'int'   && hArg?.type  === 'int') {
                    if (!this._imageAssets.has(idxArg.value)) {
                        const lbl      = `_img_${this._imageAssets.size}`;
                        const width    = wArg.value;
                        const height   = hArg.value;
                        const rowbytes = Math.ceil(Math.ceil(width / 8) / 2) * 2;
                        const isInterleaved = fileArg.value.toLowerCase().endsWith('.iraw');
                        this._imageAssets.set(idxArg.value, {
                            filename: fileArg.value, label: lbl, width, height, rowbytes,
                            isAnim: false, frameCount: 1, isInterleaved
                        });
                    }
                }
            },

            loadanimimage: (stmt) => {
                this._usesImage = true;
                const idxArg    = stmt.args[0];
                const fileArg   = stmt.args[1];
                const wArg      = stmt.args[2];
                const hArg      = stmt.args[3];
                const countArg  = stmt.args[4];
                if (idxArg?.type === 'int' && fileArg?.type === 'string' &&
                    wArg?.type === 'int'   && hArg?.type  === 'int' &&
                    countArg?.type === 'int') {
                    if (!this._imageAssets.has(idxArg.value)) {
                        const lbl        = `_img_${this._imageAssets.size}`;
                        const width      = wArg.value;
                        const height     = hArg.value;
                        const frameCount = countArg.value;
                        const rowbytes   = Math.ceil(Math.ceil(width / 8) / 2) * 2;
                        const isInterleaved = fileArg.value.toLowerCase().endsWith('.iraw');
                        this._imageAssets.set(idxArg.value, {
                            filename: fileArg.value, label: lbl, width, height, rowbytes,
                            isAnim: true, frameCount, isInterleaved
                        });
                    }
                }
            },

            loadmask: (stmt) => {
                this._usesBobs = true;
                const idxArg  = stmt.args[0];
                const fileArg = stmt.args[1];
                if (idxArg?.type === 'int' && fileArg?.type === 'string') {
                    if (!this._maskAssets.has(idxArg.value)) {
                        const lbl = `_mask_${this._maskAssets.size}`;
                        this._maskAssets.set(idxArg.value, { filename: fileArg.value, label: lbl });
                    }
                }
            },

            loadfont: (stmt) => {
                const idxArg   = stmt.args[0];
                const charsArg = stmt.args[1];
                const fileArg  = stmt.args[2];
                const wArg     = stmt.args[3];
                const hArg     = stmt.args[4];
                if (idxArg?.type !== 'int')
                    throw new Error(`LoadFont: erstes Argument (Index) muss ein Integer-Literal sein — Zeile ${stmt.line}`);
                if (charsArg?.type !== 'string')
                    throw new Error(`LoadFont: zweites Argument (Zeichensatz) muss ein String-Literal sein — Zeile ${stmt.line}`);
                if (fileArg?.type !== 'string')
                    throw new Error(`LoadFont: drittes Argument (Dateiname) muss ein String-Literal sein — Zeile ${stmt.line}`);
                if (wArg?.type !== 'int' || hArg?.type !== 'int')
                    throw new Error(`LoadFont: Syntax ist LoadFont index, "chars", "file.raw", charW, charH — charW/charH fehlen oder sind keine Ganzzahlen (Zeile ${stmt.line})`);
                const charW = wArg.value;
                const charH = hArg.value;
                if (charW > 8)
                    throw new Error(`LoadFont: charW darf maximal 8 sein (${charW} angegeben) — Zeile ${stmt.line}`);
                if (!this._fontAssets.has(idxArg.value)) {
                    const lbl = `_font_${this._fontAssets.size}`;
                    this._fontAssets.set(idxArg.value, {
                        filename: fileArg.value, label: lbl,
                        chars: charsArg.value, charW, charH
                    });
                }
            },

            setbackground: () => { this._usesBobs = true; this._usesImage = true; },
            drawbob:       () => { this._usesBobs = true; this._usesImage = true; },

            loadtileset: (stmt) => {
                this._usesTilemap = true;
                this._usesImage   = true;
                const idxArg  = stmt.args[0];
                const fileArg = stmt.args[1];
                const wArg    = stmt.args[2];
                const hArg    = stmt.args[3];
                if (idxArg?.type !== 'int')
                    throw new Error(`LoadTileset: slot muss ein Integer-Literal sein — Zeile ${stmt.line}`);
                if (fileArg?.type !== 'string')
                    throw new Error(`LoadTileset: Dateiname muss ein String-Literal sein — Zeile ${stmt.line}`);
                if (wArg?.type !== 'int' || hArg?.type !== 'int')
                    throw new Error(`LoadTileset: tileW und tileH müssen Integer-Literale sein — Zeile ${stmt.line}`);
                if (!this._tilesetAssets.has(idxArg.value)) {
                    const lbl      = `_tileset_${this._tilesetAssets.size}`;
                    const tileW    = wArg.value;
                    const tileH    = hArg.value;
                    const rowbytes = Math.ceil(Math.ceil(tileW / 8) / 2) * 2;
                    this._tilesetAssets.set(idxArg.value, { filename: fileArg.value, label: lbl, tileW, tileH, rowbytes });
                }
            },

            loadtilemap: (stmt) => {
                this._usesTilemap = true;
                const idxArg  = stmt.args[0];
                const fileArg = stmt.args[1];
                if (idxArg?.type !== 'int')
                    throw new Error(`LoadTilemap: slot muss ein Integer-Literal sein — Zeile ${stmt.line}`);
                if (fileArg?.type !== 'string')
                    throw new Error(`LoadTilemap: Dateiname muss ein String-Literal sein — Zeile ${stmt.line}`);
                if (!this._tilemapAssets.has(idxArg.value)) {
                    const lbl = `_tilemap_${this._tilemapAssets.size}`;
                    this._tilemapAssets.set(idxArg.value, { filename: fileArg.value, label: lbl });
                }
            },

            drawtilemap: () => { this._usesTilemap = true; this._usesImage = true; },

            settilemap: () => {
                this._usesTilemap = true;
                this._usesImage   = true;
                this._usesBobs    = true; // _bg_restore_fn and _bg_restore_tilemap live in bobs.s
            },
        };
    }

    _builtin_abs(expr, lines) {
        const doneLbl = this._nextLabel();
        this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
        lines.push('        tst.l   d0');
        lines.push(`        bge.s   ${doneLbl}`);
        lines.push('        neg.l   d0');
        lines.push(`${doneLbl}:`);
    }

    _builtin_rnd(expr, lines) {
        this._genExpr(expr.args[0] ?? { type: 'int', value: 1 }, lines);
        lines.push('        move.l  d0,d1');
        lines.push('        jsr     _Rnd');
    }

    _builtin_str(expr, lines) {
        this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
        lines.push('        jsr     _IntToStr');
    }

    // ── T15: Joystick ─────────────────────────────────────────────────────────

    _builtin_joydir(expr, lines, bitN) {
        const portArg = expr.args[0] ?? { type: 'int', value: 1 };
        if (portArg.type === 'int') {
            const addr = portArg.value === 0 ? '$DFF00A' : '$DFF00C';
            lines.push(`        move.w  ${addr},d0`);
        } else {
            this._genExpr(portArg, lines);
            lines.push('        add.l   d0,d0');
            lines.push('        lea     $DFF00A,a0');
            lines.push('        move.w  0(a0,d0.w),d0');
        }
        lines.push('        move.w  d0,d1');
        lines.push('        lsr.w   #1,d1');
        lines.push('        eor.w   d0,d1');
        lines.push(`        btst    #${bitN},d1`);
        lines.push('        sne     d0');
        lines.push('        ext.w   d0');
        lines.push('        ext.l   d0');
    }

    _builtin_joyfire(expr, lines) {
        const portArg = expr.args[0] ?? { type: 'int', value: 1 };
        lines.push('        move.b  $BFE001,d0');
        lines.push('        not.b   d0');
        if (portArg.type === 'int') {
            const bitN = portArg.value === 0 ? 7 : 6;
            lines.push(`        btst    #${bitN},d0`);
        } else {
            this._genExpr(portArg, lines);
            lines.push('        move.l  d0,d1');
            lines.push('        moveq   #7,d0');
            lines.push('        sub.l   d1,d0');
            lines.push('        move.l  d0,d1');
            lines.push('        move.b  $BFE001,d0');
            lines.push('        not.b   d0');
            lines.push('        btst    d1,d0');
        }
        lines.push('        sne     d0');
        lines.push('        ext.w   d0');
        lines.push('        ext.l   d0');
    }

    // ── T16: Mouse ────────────────────────────────────────────────────────────

    _builtin_mousex(expr, lines) {
        lines.push('        move.w  _mouse_x,d0');
        lines.push('        ext.l   d0');
    }

    _builtin_mousey(expr, lines) {
        lines.push('        move.w  _mouse_y,d0');
        lines.push('        ext.l   d0');
    }

    _builtin_mousedown(expr, lines) {
        const btn = expr.args[0] ?? { type: 'int', value: 0 };
        if (btn.type === 'int') {
            const v = btn.value === 0 ? '_mouse_down_0' : '_mouse_down_1';
            lines.push(`        move.b  ${v},d0`);
        } else {
            this._genExpr(btn, lines);
            lines.push('        move.l  d0,d1');
            lines.push('        lea     _mouse_down_0,a0');
            lines.push('        move.b  0(a0,d1.l),d0');
        }
        lines.push('        ext.w   d0');
        lines.push('        ext.l   d0');
    }

    _builtin_mousehit(expr, lines) {
        const btn = expr.args[0] ?? { type: 'int', value: 0 };
        if (btn.type === 'int') {
            const v = btn.value === 0 ? '_mouse_hit_0' : '_mouse_hit_1';
            lines.push(`        move.b  ${v},d0`);
            lines.push(`        clr.b   ${v}`);
        } else {
            this._genExpr(btn, lines);
            lines.push('        move.l  d0,d1');
            lines.push('        lea     _mouse_hit_0,a0');
            lines.push('        move.b  0(a0,d1.l),d0');
            lines.push('        clr.b   0(a0,d1.l)');
        }
        lines.push('        ext.w   d0');
        lines.push('        ext.l   d0');
    }

    // ── T17: Keyboard + Peek ──────────────────────────────────────────────────

    _builtin_keydown(expr, lines) {
        this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
        lines.push('        move.l  d0,d1');
        lines.push('        lsr.l   #3,d1');
        lines.push('        and.l   #7,d0');
        lines.push('        lea     _kbd_matrix,a0');
        lines.push('        add.l   d1,a0');
        lines.push('        btst    d0,(a0)');
        lines.push('        sne     d0');
        lines.push('        ext.w   d0');
        lines.push('        ext.l   d0');
    }

    _builtin_peek(expr, lines, sz) {
        const addrArg = expr.args[0] ?? { type: 'int', value: 0 };
        if (addrArg.type === 'int') {
            const hex = '$' + (addrArg.value >>> 0).toString(16).toUpperCase();
            if (sz === 'b') {
                lines.push('        moveq   #0,d0');
                lines.push(`        move.b  ${hex},d0`);
            } else if (sz === 'w') {
                lines.push(`        move.w  ${hex},d0`);
                lines.push('        ext.l   d0');
            } else {
                lines.push(`        move.l  ${hex},d0`);
            }
        } else {
            this._genExpr(addrArg, lines);
            lines.push('        move.l  d0,a0');
            if (sz === 'b') {
                lines.push('        moveq   #0,d0');
                lines.push('        move.b  (a0),d0');
            } else if (sz === 'w') {
                lines.push('        move.w  (a0),d0');
                lines.push('        ext.l   d0');
            } else {
                lines.push('        move.l  (a0),d0');
            }
        }
    }

    // ── T18: Collision ────────────────────────────────────────────────────────

    _builtin_rectsoverlap(expr, lines) {
        if (expr.args.length < 8)
            throw new Error('RectsOverlap: requires 8 arguments (x1,y1,w1,h1,x2,y2,w2,h2)');
        for (const arg of expr.args) {
            this._genExpr(arg, lines);
            lines.push('        move.l  d0,-(sp)');
        }
        lines.push('        movem.l d4-d7,-(sp)    ; save loop registers');
        lines.push('        movem.l 16(sp),d0-d7   ; peek args');
        lines.push('        add.w   #32,sp         ; pop args');
        const rfLbl = this._nextLabel();
        const reLbl = this._nextLabel();
        lines.push('        move.l  d7,a1');
        lines.push('        add.l   d5,d7');
        lines.push('        cmp.l   d3,d7');
        lines.push(`        ble.s   ${rfLbl}`);
        lines.push('        add.l   d1,d3');
        lines.push('        cmp.l   a1,d3');
        lines.push(`        ble.s   ${rfLbl}`);
        lines.push('        move.l  d6,a2');
        lines.push('        add.l   d4,d6');
        lines.push('        cmp.l   d2,d6');
        lines.push(`        ble.s   ${rfLbl}`);
        lines.push('        add.l   d0,d2');
        lines.push('        cmp.l   a2,d2');
        lines.push(`        ble.s   ${rfLbl}`);
        lines.push('        moveq   #-1,d0');
        lines.push(`        bra.s   ${reLbl}`);
        lines.push(`${rfLbl}:`);
        lines.push('        moveq   #0,d0');
        lines.push(`${reLbl}:`);
        lines.push('        movem.l (sp)+,d4-d7');
    }

    _builtin_imagesoverlap(expr, lines) {
        if (expr.args.length < 6)
            throw new Error('ImagesOverlap: requires 6 arguments (img1,x1,y1,img2,x2,y2)');
        const idx1a = expr.args[0], idx2a = expr.args[3];
        if (!idx1a || idx1a.type !== 'int')
            throw new Error('ImagesOverlap: arg 0 (img1) must be an integer literal');
        if (!idx2a || idx2a.type !== 'int')
            throw new Error('ImagesOverlap: arg 3 (img2) must be an integer literal');
        const ast1 = this._imageAssets.get(idx1a.value);
        const ast2 = this._imageAssets.get(idx2a.value);
        if (!ast1) throw new Error(`ImagesOverlap: no image at index ${idx1a.value}`);
        if (!ast2) throw new Error(`ImagesOverlap: no image at index ${idx2a.value}`);
        for (const argIdx of [1, 2, 4, 5]) {
            this._genExpr(expr.args[argIdx], lines);
            lines.push('        move.l  d0,-(sp)');
        }
        lines.push('        movem.l d4-d7,-(sp)    ; save loop registers');
        lines.push('        movem.l 16(sp),d0-d3');
        lines.push('        add.w   #16,sp');
        lines.push(`        move.w  ${ast1.label}+0,d4`);
        lines.push('        ext.l   d4');
        lines.push(`        move.w  ${ast1.label}+2,d5`);
        lines.push('        ext.l   d5');
        lines.push(`        move.w  ${ast2.label}+0,d6`);
        lines.push('        ext.l   d6');
        lines.push(`        move.w  ${ast2.label}+2,d7`);
        lines.push('        ext.l   d7');
        const ifLbl = this._nextLabel();
        const ieLbl = this._nextLabel();
        lines.push('        move.l  d3,a1');
        lines.push('        add.l   d4,d3');
        lines.push('        cmp.l   d1,d3');
        lines.push(`        ble.s   ${ifLbl}`);
        lines.push('        add.l   d6,d1');
        lines.push('        cmp.l   a1,d1');
        lines.push(`        ble.s   ${ifLbl}`);
        lines.push('        move.l  d2,a2');
        lines.push('        add.l   d5,d2');
        lines.push('        cmp.l   d0,d2');
        lines.push(`        ble.s   ${ifLbl}`);
        lines.push('        add.l   d7,d0');
        lines.push('        cmp.l   a2,d0');
        lines.push(`        ble.s   ${ifLbl}`);
        lines.push('        moveq   #-1,d0');
        lines.push(`        bra.s   ${ieLbl}`);
        lines.push(`${ifLbl}:`);
        lines.push('        moveq   #0,d0');
        lines.push(`${ieLbl}:`);
        lines.push('        movem.l (sp)+,d4-d7');
    }

    _builtin_imagerectoverlap(expr, lines) {
        if (expr.args.length < 7)
            throw new Error('ImageRectOverlap: requires 7 arguments (img,x,y,rx,ry,rw,rh)');
        const imgIdxA = expr.args[0];
        if (!imgIdxA || imgIdxA.type !== 'int')
            throw new Error('ImageRectOverlap: arg 0 (img) must be an integer literal');
        const imgAst = this._imageAssets.get(imgIdxA.value);
        if (!imgAst) throw new Error(`ImageRectOverlap: no image at index ${imgIdxA.value}`);
        for (const argIdx of [1, 2, 3, 4, 5, 6]) {
            this._genExpr(expr.args[argIdx], lines);
            lines.push('        move.l  d0,-(sp)');
        }
        lines.push('        movem.l d4-d7,-(sp)    ; save loop registers');
        lines.push('        movem.l 16(sp),d0-d5');
        lines.push('        add.w   #24,sp');
        lines.push(`        move.w  ${imgAst.label}+0,d6`);
        lines.push('        ext.l   d6');
        lines.push(`        move.w  ${imgAst.label}+2,d7`);
        lines.push('        ext.l   d7');
        const ioLbl = this._nextLabel();
        const ioELbl = this._nextLabel();
        lines.push('        move.l  d5,a1');
        lines.push('        add.l   d6,d5');
        lines.push('        cmp.l   d3,d5');
        lines.push(`        ble.s   ${ioLbl}`);
        lines.push('        add.l   d1,d3');
        lines.push('        cmp.l   a1,d3');
        lines.push(`        ble.s   ${ioLbl}`);
        lines.push('        move.l  d4,a2');
        lines.push('        add.l   d7,d4');
        lines.push('        cmp.l   d2,d4');
        lines.push(`        ble.s   ${ioLbl}`);
        lines.push('        add.l   d0,d2');
        lines.push('        cmp.l   a2,d2');
        lines.push(`        ble.s   ${ioLbl}`);
        lines.push('        moveq   #-1,d0');
        lines.push(`        bra.s   ${ioELbl}`);
        lines.push(`${ioLbl}:`);
        lines.push('        moveq   #0,d0');
        lines.push(`${ioELbl}:`);
        lines.push('        movem.l (sp)+,d4-d7');
    }

    /** Return a globally unique local label string. */
    _nextLabel() {
        return `.L${this._labelCount++}`;
    }
}
