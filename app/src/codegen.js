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
        this._arrays        = new Map();  // name → size Expr (populated by _collectVars)
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
        this._loopStack     = [];         // stack of endLabels for Exit — push on loop entry, pop on exit

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

        // ── Build output ──────────────────────────────────────────────────────
        const out = [];

        out.push('; ============================================================');
        out.push('; Generated by BASSM — do not edit');
        out.push(`; Screen: ${W}×${H}, ${D} bitplane${D > 1 ? 's' : ''}, ${colors} colours (PAL lores OCS)`);
        out.push('; ============================================================');
        out.push('');

        // EQUs
        out.push(`${pad('GFXWIDTH',12)} EQU ${W}`);
        out.push(`${pad('GFXHEIGHT',12)} EQU ${H}`);
        out.push(`${pad('GFXDEPTH',12)} EQU ${D}`);
        out.push(`${pad('GFXBPR',12)} EQU (GFXWIDTH/8)`);
        out.push(`${pad('GFXPSIZE',12)} EQU (GFXBPR*GFXHEIGHT)`);
        out.push(`${pad('GFXBUFSIZE',12)} EQU (GFXPSIZE*GFXDEPTH)`);
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
        out.push('');

        // Fragment INCLUDEs
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
        out.push('');
        out.push('        even');
        out.push('');

        // _setup_graphics subroutine
        out.push('        SECTION gfx_init,CODE');
        out.push('');
        out.push('_setup_graphics:');
        out.push('        lea     _gfx_cop_a_bpl_table,a0');
        out.push('        move.l  _gfx_planes,a1');
        out.push('        moveq   #GFXDEPTH,d0');
        out.push('        move.l  #GFXPSIZE,d1');
        out.push('        jsr     _PatchBitplanePtrs');
        out.push('        lea     _gfx_cop_b_bpl_table,a0');
        out.push('        move.l  _gfx_planes_b,a1');
        out.push('        moveq   #GFXDEPTH,d0');
        out.push('        move.l  #GFXPSIZE,d1');
        out.push('        jsr     _PatchBitplanePtrs');
        out.push('        lea     _gfx_copper_a,a0');
        out.push('        jsr     _InstallCopper');
        out.push('        jsr     _InitPalette');
        out.push('        move.l  _gfx_planes_b,a0');
        out.push('        move.l  a0,_back_planes_ptr');
        out.push('        clr.b   _front_is_a');
        out.push('        rts');
        out.push('');

        // _main_program
        out.push('');
        out.push('        XDEF    _main_program');
        out.push('_main_program:');

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

        // User variable BSS — one longword per scalar integer variable
        if (varNames.size > 0 || this._arrays.size > 0 || this._typeInstances.size > 0) {
            out.push('        SECTION user_vars,BSS');
            for (const name of varNames) {
                out.push(`_var_${name}:    ds.l    1`);
            }
            // Arrays: Dim arr(n) → n+1 longwords (indices 0..n, Blitz2D-compatible)
            for (const [name, sizeExpr] of this._arrays) {
                if (sizeExpr.type !== 'int') {
                    throw new Error(`Dim ${name}: array size must be an integer literal`);
                }
                out.push(`_arr_${name}:    ds.l    ${sizeExpr.value + 1}`);
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

        // Bitplane buffer pointer variables live in startup.s BSS (_gfx_planes / _gfx_planes_b).
        // The actual chip RAM data (BSS_C) is emitted below; startup.s sets the pointers via lea.

        // Helper: emit display-setup copper moves (shared header for both lists)
        const emitCopHeader = () => {
            out.push(copMove(0x008E, diwstrt, 'DIWSTRT'));
            out.push(copMove(0x0090, diwstop, 'DIWSTOP'));
            out.push(copMove(0x0092, ddfstrt, 'DDFSTRT'));
            out.push(copMove(0x0094, ddfstop, 'DDFSTOP'));
            out.push(copMove(0x0100, bplcon0, 'BPLCON0'));
            out.push(copMove(0x0102, 0x0000,  'BPLCON1'));
            out.push(copMove(0x0104, 0x0000,  'BPLCON2'));
            out.push(copMove(0x0108, 0x0000,  'BPL1MOD'));
            out.push(copMove(0x010A, 0x0000,  'BPL2MOD'));
        };

        // Chip-RAM DATA — copper list A (bitplane pointers → buffer A)
        out.push('        SECTION gfx_copper,DATA_C');
        out.push('_gfx_copper_a:');
        emitCopHeader();
        out.push('_gfx_cop_a_bpl_table:');
        for (let i = 0; i < D; i++) {
            const [pth, ptl] = BPL_PTR_REGS[i];
            out.push(copMove(pth, 0, `BPL${i+1}PTH`));
            out.push(copMove(ptl, 0, `BPL${i+1}PTL`));
        }
        if (this._usesRaster) {
            const maxLines = Math.min(H, 256 - vStart);
            out.push('        XDEF    _gfx_raster_a');
            out.push('_gfx_raster_a:');
            for (let y = 0; y < maxLines; y++) {
                const vpos = vStart + y;
                out.push(`        dc.w    $${hex((vpos << 8) | 0x01)},$FF00`);
                out.push(`        dc.w    $0180,$0000`);
            }
        }
        out.push('        dc.w    $FFFF,$FFFE             ; END of copper list A');
        out.push('');

        // Chip-RAM DATA — copper list B (bitplane pointers → buffer B)
        out.push('_gfx_copper_b:');
        emitCopHeader();
        out.push('_gfx_cop_b_bpl_table:');
        for (let i = 0; i < D; i++) {
            const [pth, ptl] = BPL_PTR_REGS[i];
            out.push(copMove(pth, 0, `BPL${i+1}PTH`));
            out.push(copMove(ptl, 0, `BPL${i+1}PTL`));
        }
        if (this._usesRaster) {
            const maxLines = Math.min(H, 256 - vStart);
            out.push('        XDEF    _gfx_raster_b');
            out.push('_gfx_raster_b:');
            for (let y = 0; y < maxLines; y++) {
                const vpos = vStart + y;
                out.push(`        dc.w    $${hex((vpos << 8) | 0x01)},$FF00`);
                out.push(`        dc.w    $0180,$0000`);
            }
        }
        out.push('        dc.w    $FFFF,$FFFE             ; END of copper list B');
        out.push('');

        // Chip RAM bitplane buffers — static BSS_C, zeroed by OS loader.
        // startup.s reads their addresses into _gfx_planes / _gfx_planes_b.
        out.push('        SECTION gfx_planes_a,BSS_C');
        out.push('_gfx_planes_data:');
        out.push('        ds.b    GFXBUFSIZE');
        out.push('');
        out.push('        SECTION gfx_planes_b,BSS_C');
        out.push('_gfx_planes_b_data:');
        out.push('        ds.b    GFXBUFSIZE');
        out.push('');

        // ── Audio sample data (chip RAM, one DATA_C section per unique file) ──
        // Each sample is INCBIN'd at assembly time; length computed by the
        // assembler from label difference (_snd_N_end - _snd_N).
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

        // ── Image data (chip RAM, one DATA_C section per unique file) ──────────
        // An 8-byte header (width, height, GFXDEPTH, rowbytes) is prepended
        // before the INCBIN so _DrawImage / _SetImagePalette can read metadata.
        // The .raw file format (from Asset Manager): 2^depth OCS palette words,
        // followed by depth × height × rowbytes bytes of planar bitplane data.
        for (const [, { filename, label: lbl, width, height, rowbytes }] of this._imageAssets) {
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        dc.w    ${width},${height},GFXDEPTH,${rowbytes}`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

        // ── Mask data (chip RAM, raw 1bpp transparency masks for DrawBob) ─────
        // Format: raw bitplane-layout bytes, height × rowbytes bytes, no header.
        // Must be in chip RAM (Blitter A channel pointer must be chip RAM).
        for (const [, { filename, label: lbl }] of this._maskAssets) {
            out.push(`        SECTION ${lbl}_sec,DATA_C`);
            out.push(`        XDEF    ${lbl}`);
            out.push(`${lbl}:`);
            out.push(`        INCBIN  "${filename}"`);
            out.push(`        EVEN`);
            out.push('');
        }

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
        ];
    }

    // ── Variable collection (pre-pass) ────────────────────────────────────────
    //
    // Walks the AST and collects all variable names so we can emit BSS
    // declarations before _main_program.

    _collectVars(ast, varSet) {
        for (const stmt of ast) {
            if (!stmt) continue;
            if (stmt.type === 'assign') {
                varSet.add(stmt.target);
                this._collectVarsInExpr(stmt.expr, varSet);
            } else if (stmt.type === 'dim') {
                this._arrays.set(stmt.name, stmt.size);
            } else if (stmt.type === 'array_assign') {
                this._collectVarsInExpr(stmt.index, varSet);
                this._collectVarsInExpr(stmt.expr,  varSet);
            } else if (stmt.type === 'type_def') {
                this._typeDefs.set(stmt.name, { fields: stmt.fields });
            } else if (stmt.type === 'dim_typed') {
                this._typeInstances.set(stmt.name, { typeName: stmt.typeName, isArray: false, size: null });
            } else if (stmt.type === 'dim_typed_array') {
                this._typeInstances.set(stmt.name, { typeName: stmt.typeName, isArray: true, size: stmt.size });
            } else if (stmt.type === 'type_field_write') {
                if (stmt.index) this._collectVarsInExpr(stmt.index, varSet);
                this._collectVarsInExpr(stmt.expr, varSet);
            } else if (stmt.type === 'command') {
                if (stmt.name === 'coppercolor') this._usesRaster = true;
                if (stmt.name === 'loadsample') {
                    this._usesSound = true;
                    const idxArg  = stmt.args[0];
                    const fileArg = stmt.args[1];
                    if (idxArg && idxArg.type === 'int' && fileArg && fileArg.type === 'string') {
                        if (!this._audioSamples.has(idxArg.value)) {
                            const lbl = `_snd_${this._audioSamples.size}`;
                            this._audioSamples.set(idxArg.value, { filename: fileArg.value, label: lbl });
                        }
                    }
                }
                if (stmt.name === 'loadimage') {
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
                            // rowbytes: bytes per row, word-aligned
                            const rowbytes = Math.ceil(Math.ceil(width / 8) / 2) * 2;
                            this._imageAssets.set(idxArg.value, {
                                filename: fileArg.value, label: lbl, width, height, rowbytes,
                                isAnim: false, frameCount: 1
                            });
                        }
                    }
                }
                if (stmt.name === 'loadanimimage') {
                    // LoadAnimImage n,"f.raw",fw,fh,count — animated sprite strip
                    // Same 8-byte header format as LoadImage; count is compile-time only.
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
                            this._imageAssets.set(idxArg.value, {
                                filename: fileArg.value, label: lbl, width, height, rowbytes,
                                isAnim: true, frameCount
                            });
                        }
                    }
                }
                if (stmt.name === 'loadmask') {
                    this._usesBobs = true;
                    const idxArg  = stmt.args[0];
                    const fileArg = stmt.args[1];
                    if (idxArg?.type === 'int' && fileArg?.type === 'string') {
                        if (!this._maskAssets.has(idxArg.value)) {
                            const lbl = `_mask_${this._maskAssets.size}`;
                            this._maskAssets.set(idxArg.value, { filename: fileArg.value, label: lbl });
                        }
                    }
                }
                if (stmt.name === 'setbackground' || stmt.name === 'drawbob') {
                    this._usesBobs = true;
                    this._usesImage = true;   // bobs.s calls _DrawImageFrame — image.s must be present
                }
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
            if (stmt.type === 'assign') {
                localVarSet.add(stmt.target);
            } else if (stmt.type === 'for') {
                localVarSet.add(stmt.var);
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
                varSet.add(expr.name);
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

    // ── Per-statement code generation ─────────────────────────────────────────

    _genStatement(stmt) {
        const lines = [];

        // ── Variable assignment: target = expr ───────────────────────────────
        if (stmt.type === 'assign') {
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,${this._varRef(stmt.target)}`);
            return lines;
        }

        // ── Dim / Type / Function definition — declaration only, no code ─────
        if (stmt.type === 'dim' || stmt.type === 'type_def' ||
            stmt.type === 'dim_typed' || stmt.type === 'dim_typed_array' ||
            stmt.type === 'function_def') {
            return lines;
        }

        // ── Return — exit current function ───────────────────────────────────
        if (stmt.type === 'return') {
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
            return lines;
        }

        // ── User function call statement: name(args) or name args ─────────────
        if (stmt.type === 'call_stmt') {
            const funcDef = this._userFunctions.get(stmt.name);
            if (!funcDef) {
                throw new Error(`Undeclared function '${stmt.name}' called on line ${stmt.line}`);
            }
            this._emitFunctionCall(stmt.name, stmt.args, lines);
            return lines;
        }

        // ── Type field write: instance\field = expr ───────────────────────────
        if (stmt.type === 'type_field_write') {
            this._genTypeFieldWrite(stmt, lines);
            return lines;
        }

        // ── Array assignment: arr(index) = expr ──────────────────────────────
        // Evaluate expr → push; evaluate index → d0; compute address; store.
        if (stmt.type === 'array_assign') {
            this._genExpr(stmt.expr, lines);
            lines.push(`        move.l  d0,-(sp)`);
            this._genExpr(stmt.index, lines);
            lines.push(`        asl.l   #2,d0`);
            lines.push(`        lea     _arr_${stmt.name},a0`);
            lines.push(`        add.l   d0,a0`);
            lines.push(`        move.l  (sp)+,(a0)`);
            return lines;
        }

        // ── If / ElseIf / Else / EndIf ────────────────────────────────────────
        if (stmt.type === 'if') {
            this._genIf(stmt, lines);
            return lines;
        }

        // ── While / Wend ──────────────────────────────────────────────────────
        if (stmt.type === 'while') {
            this._genWhile(stmt, lines);
            return lines;
        }

        // ── For / To / Step / Next ────────────────────────────────────────────
        if (stmt.type === 'for') {
            this._genFor(stmt, lines);
            return lines;
        }

        // ── Repeat / Until ────────────────────────────────────────────────────
        if (stmt.type === 'repeat') {
            this._genRepeat(stmt, lines);
            return lines;
        }

        // ── Exit [n] ──────────────────────────────────────────────────────────
        if (stmt.type === 'exit') {
            const depth = stmt.count ?? 1;
            const idx   = this._loopStack.length - depth;
            if (idx < 0) throw new Error(`Exit ${depth}: not inside enough loops (line ${stmt.line})`);
            lines.push(`        bra.w   ${this._loopStack[idx]}`);
            return lines;
        }

        // ── Select / Case / Default / EndSelect ───────────────────────────────
        if (stmt.type === 'select') {
            this._genSelect(stmt, lines);
            return lines;
        }

        if (stmt.type !== 'command') return lines;

        const name = stmt.name;

        switch (name) {

            case 'graphics':
                lines.push('        jsr     _setup_graphics');
                if (this._usesMouse) lines.push('        jsr     _MouseInit');
                break;

            case 'cls':
                lines.push('        jsr     _Cls');
                break;

            case 'clscolor': {
                this._genExprArg(stmt, 0, 'ClsColor', lines);
                lines.push('        jsr     _ClsColor');
                break;
            }

            case 'color': {
                this._genExprArg(stmt, 0, 'Color', lines);
                lines.push('        move.w  d0,_draw_color');
                break;
            }

            case 'palettecolor': {
                // If all 4 args are compile-time literals, build the OCS word in the
                // assembler and call the lighter _SetPaletteColor directly (no subroutine
                // overhead for r/g/b assembly).
                // If any arg is a runtime expression, push b/g/r, evaluate n, pop into
                // d1-d3, then call _SetPaletteColorRGB which builds the OCS word at runtime.
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
                    // Evaluate b, g, r and push; evaluate n last (d0=n after push/pop).
                    // movem.l (sp)+,d1-d3 pops in register order: d1=r, d2=g, d3=b.
                    this._genExprArg(stmt, 3, 'PaletteColor b', lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExprArg(stmt, 2, 'PaletteColor g', lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExprArg(stmt, 1, 'PaletteColor r', lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExprArg(stmt, 0, 'PaletteColor n', lines);  // d0 = n
                    lines.push('        movem.l (sp)+,d1-d3');            // d1=r, d2=g, d3=b
                    lines.push('        jsr     _SetPaletteColorRGB');
                }
                break;
            }

            case 'end':
                lines.push('        rts');
                break;

            case 'delay': {
                // Delay n — wait n VBlanks.  n may be any integer expression.
                const loopLbl = this._nextLabel();
                const skipLbl = this._nextLabel();
                this._genExprArg(stmt, 0, 'Delay frames', lines);
                // Guard: skip loop if n <= 0
                lines.push(`        tst.l   d0`);
                lines.push(`        ble.s   ${skipLbl}`);
                lines.push(`        subq.l  #1,d0`);
                lines.push(`        move.l  d0,d7`);
                lines.push(`${loopLbl}:`);
                lines.push(`        jsr     _WaitVBL`);
                lines.push(`        dbra    d7,${loopLbl}`);
                lines.push(`${skipLbl}:`);
                break;
            }

            case 'waitvbl':
                lines.push('        jsr     _WaitVBL');
                break;

            case 'waitkey':
                lines.push('        jsr     _WaitKey');
                break;

            case 'loadsample':
                // LoadSample index, "file" — sample was pre-registered in _collectVars.
                // No assembly code emitted; INCBIN sections appear at end of generate().
                break;

            case 'loadimage':
                // LoadImage 0 automatically applies the image's embedded palette at runtime.
                // Other indices: no code emitted (data only, INCBIN at end of generate()).
                if (stmt.args[0]?.type === 'int' && stmt.args[0].value === 0) {
                    const slot = this._imageAssets.get(0);
                    if (slot) {
                        lines.push(`        lea     ${slot.label},a0`);
                        lines.push(`        jsr     _SetImagePalette`);
                    }
                }
                break;

            case 'loadanimimage':
                // LoadAnimImage index,"f.raw",fw,fh,count — data only; INCBIN at end.
                // No runtime code needed; frame count used only by codegen for DrawImage/DrawBob.
                break;

            case 'drawimage': {
                // DrawImage index, x, y [, frame]
                //   index must be an integer literal (resolved at compile time)
                //   x, y, frame may be any expression
                //   frame (optional, default 0) — requires LoadAnimImage
                // Convention: a0=imgptr, d0=x, d1=y → jsr _DrawImage  (frame 0)
                //             a0=imgptr, d0=x, d1=y, d2=frame → jsr _DrawImageFrame
                const imgIdxArg = stmt.args[0];
                if (!imgIdxArg || imgIdxArg.type !== 'int')
                    throw new Error(`DrawImage: index must be an integer literal (line ${stmt.line})`);
                const imgEntry = this._imageAssets.get(imgIdxArg.value);
                if (!imgEntry)
                    throw new Error(`DrawImage: image index ${imgIdxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);

                const xExpr    = stmt.args[1] ?? { type: 'int', value: 0 };
                const yExpr    = stmt.args[2] ?? { type: 'int', value: 0 };
                const frameArg = stmt.args[3]; // undefined = no frame argument

                if (!frameArg) {
                    // Original 3-arg path — jsr _DrawImage (clears d2 internally)
                    this._genExpr(yExpr, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(xExpr, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push(`        lea     ${imgEntry.label},a0`);
                    lines.push('        jsr     _DrawImage');
                } else if (frameArg.type === 'int') {
                    // Literal frame — moveq #N,d2  (zero Laufzeit-Overhead für N=0..7)
                    this._genExpr(yExpr, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(xExpr, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push(`        moveq   #${frameArg.value},d2`);
                    lines.push(`        lea     ${imgEntry.label},a0`);
                    lines.push('        jsr     _DrawImageFrame');
                } else {
                    // Variable frame — eval frame→push, eval y→push, eval x→d0
                    // pop y→d1, pop frame→d2
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
                break;
            }

            case 'playsample': {
                // PlaySample index, channel [, period [, volume]]
                //   index   = compile-time integer literal (maps to _snd_N label)
                //   channel = required expression (0–3)
                //   period  = optional expression; default 428 (≈8287 Hz PAL)
                //   volume  = optional expression; default 64  (Paula maximum)
                //
                // Calling convention for _PlaySample:
                //   d0 = channel, a0 = ptr, d1 = len_words, d2 = period, d3 = volume
                const idxArg = stmt.args[0];
                if (!idxArg || idxArg.type !== 'int')
                    throw new Error(`PlaySample: index must be an integer literal (line ${stmt.line})`);
                const entry = this._audioSamples.get(idxArg.value);
                if (!entry)
                    throw new Error(`PlaySample: sample index ${idxArg.value} not loaded — use LoadSample first (line ${stmt.line})`);
                const { label: lbl } = entry;

                // Optional args: synthesise a literal int node when omitted
                const volArg = stmt.args[3] ?? { type: 'int', value: 64 };
                const perArg = stmt.args[2] ?? { type: 'int', value: 428 };

                // Push: volume (deepest), period, channel (top)
                this._genExpr(volArg, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExpr(perArg, lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 1, 'PlaySample channel', lines);
                lines.push('        move.l  d0,-(sp)');

                // Set a0 = sample pointer, d1 = length in words (assembler expression)
                lines.push(`        lea     ${lbl},a0`);
                lines.push(`        move.l  #(${lbl}_end-${lbl})/2,d1`);

                // Pop: d0=channel, d2=period, d3=volume  (movem pops in reg-num order)
                lines.push('        movem.l (sp)+,d0/d2-d3');
                lines.push('        jsr     _PlaySample');
                break;
            }

            case 'playsampleonce': {
                // PlaySampleOnce index, channel [, period [, volume]]
                // Identical calling convention to PlaySample; calls _PlaySampleOnce
                // which uses Paula's double-buffering to play exactly once.
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
                break;
            }

            case 'stopsample': {
                // StopSample channel  →  d0=channel, jsr _StopSample
                this._genExprArg(stmt, 0, 'StopSample channel', lines);
                lines.push('        jsr     _StopSample');
                break;
            }

            case 'screenflip':
                if (this._usesBobs) lines.push('        jsr     _FlushBobs');
                lines.push('        jsr     _ScreenFlip');
                break;

            case 'coppercolor': {
                // CopperColor y,r,g,b — patch COLOR00 MOVE entry at scanline y
                // in the back copper list (visible after next ScreenFlip).
                //
                // PERF-C: Intrinsic Inline — both paths expand the bodies of
                // _SetRasterColor/_SetRasterColorRGB directly, eliminating
                // ~120 cycles of movem.l + JSR overhead per call (~3 ms/frame
                // when called 212× for a full rasterbar).
                //
                // Register contract for the runtime path:
                //   d2  — OCS word accumulator ($0RGB built up across three
                //          _genExprArg calls).  Safe: _genExpr only uses d0/d1.
                //   a0  — back raster base; overwritten by lea just before use.
                if (stmt.args.every(a => a.type === 'int')) {
                    // ── Compile-time path: all 4 args are integer literals ────
                    // y*8+6 is known at compile time → direct absolute write,
                    // no register setup needed.
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
                    // ── Runtime path: any arg is a variable/expression ────────
                    // Inline _SetRasterColorRGB + _SetRasterColor bodies.
                    // PERF-3: skip zero-literal channels entirely
                    const lblA = this._nextLabel();
                    const lblW = this._nextLabel();

                    const rArg = stmt.args[1];
                    const gArg = stmt.args[2];
                    const bArg = stmt.args[3];
                    const rIsZero = rArg.type === 'int' && rArg.value === 0;
                    const gIsZero = gArg.type === 'int' && gArg.value === 0;
                    const bIsZero = bArg.type === 'int' && bArg.value === 0;

                    // r → bits 11:8 of OCS word, stored in d2
                    if (rIsZero) {
                        lines.push('        moveq   #0,d2');
                    } else {
                        this._genExprArg(stmt, 1, 'CopperColor r', lines);
                        lines.push('        andi.w  #$F,d0');
                        lines.push('        lsl.w   #8,d0');
                        lines.push('        move.w  d0,d2');
                    }

                    // g → bits 7:4, OR into d2
                    if (!gIsZero) {
                        this._genExprArg(stmt, 2, 'CopperColor g', lines);
                        lines.push('        andi.w  #$F,d0');
                        lines.push('        lsl.w   #4,d0');
                        lines.push('        or.w    d0,d2');
                    }

                    // b → bits 3:0, OR into d2  →  d2 = $0RGB OCS word
                    if (!bIsZero) {
                        this._genExprArg(stmt, 3, 'CopperColor b', lines);
                        lines.push('        andi.w  #$F,d0');
                        lines.push('        or.w    d0,d2');
                    }

                    // y → d0, byte offset = y * 8  (COLOR word is at +6)
                    this._genExprArg(stmt, 0, 'CopperColor y', lines);
                    lines.push('        lsl.l   #3,d0');

                    // Select back raster table (_front_is_a: 0=B is back, 1=A is back)
                    lines.push('        tst.b   _front_is_a');
                    lines.push(`        bne.s   ${lblA}`);
                    lines.push('        lea     _gfx_raster_b,a0');
                    lines.push(`        bra.s   ${lblW}`);
                    lines.push(`${lblA}:`);
                    lines.push('        lea     _gfx_raster_a,a0');
                    lines.push(`${lblW}:`);
                    lines.push('        move.w  d2,6(a0,d0.l)');
                }
                break;
            }

            case 'text': {
                // _Text(a0=str, d0=x, d1=y) — now returns new x in d0.
                // Supports: "literal", Str$(n), and "a" + Str$(n) + "b" concatenation.
                const parts = this._flattenStrArg(stmt.args[2]);
                // Evaluate y first (push), then x (into d0), pop y → d1
                this._genExprArg(stmt, 1, 'Text y', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 0, 'Text x', lines);
                lines.push('        move.l  (sp)+,d1');
                if (parts.length === 1 && parts[0].type === 'lit') {
                    // Fast path: single literal (original behaviour)
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
                    // Multi-part: save y to _text_y, chain _Text calls.
                    // Each _Text call returns new x in d0; reload _text_y into d1 each time.
                    lines.push('        move.l  d1,_text_y');
                    for (const part of parts) {
                        if (part.type === 'lit') {
                            const strLbl  = this._nextLabel();
                            const pastLbl = this._nextLabel();
                            lines.push(`        lea     ${strLbl},a0`);
                            lines.push('        jsr     _Text');     // returns new x in d0
                            lines.push(`        bra.s   ${pastLbl}`);
                            lines.push(`${strLbl}:`);
                            lines.push(`        dc.b    "${this._escapeStr(part.value)}",0`);
                            lines.push('        even');
                            lines.push(`${pastLbl}:`);
                            lines.push('        move.l  _text_y,d1');
                        } else {  // str_expr
                            lines.push('        move.l  d0,-(sp)');   // save current x
                            this._genExpr(part.expr, lines);           // d0 = integer
                            lines.push('        jsr     _IntToStr');   // d0 = string ptr
                            lines.push('        move.l  d0,a0');
                            lines.push('        move.l  (sp)+,d0');    // restore x
                            lines.push('        move.l  _text_y,d1');  // restore y
                            lines.push('        jsr     _Text');
                            lines.push('        move.l  _text_y,d1');
                        }
                    }
                }
                break;
            }

            case 'nprint': {
                // Blitz2D compatibility stub — no-op in bare-metal builds
                break;
            }

            // ── Drawing commands ──────────────────────────────────────────────

            case 'plot': {
                // Plot x, y  →  _Plot(d0=x, d1=y)
                // Evaluate y first (push), then x → d0, pop y → d1
                this._genExprArg(stmt, 1, 'Plot y', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 0, 'Plot x', lines);
                lines.push('        move.l  (sp)+,d1');
                lines.push('        jsr     _Plot');
                break;
            }

            case 'line': {
                // Line x1,y1,x2,y2  →  _Line(d0=x1, d1=y1, d2=x2, d3=y2)
                // Push y2, x2, y1; then x1 → d0; pop y1→d1, x2→d2, y2→d3
                this._genExprArg(stmt, 3, 'Line y2', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 2, 'Line x2', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 1, 'Line y1', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 0, 'Line x1', lines);
                lines.push('        movem.l (sp)+,d1-d3');
                lines.push('        jsr     _Line');
                break;
            }

            case 'rect': {
                // Rect x,y,w,h  →  _Rect(d0=x, d1=y, d2=w, d3=h)
                // Push h, w, y; then x → d0; pop y→d1, w→d2, h→d3
                this._genExprArg(stmt, 3, 'Rect h', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 2, 'Rect w', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 1, 'Rect y', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 0, 'Rect x', lines);
                lines.push('        movem.l (sp)+,d1-d3');
                lines.push('        jsr     _Rect');
                break;
            }

            case 'box': {
                // Box x,y,w,h  →  _Box(d0=x, d1=y, d2=w, d3=h)
                // Push h, w, y; then x → d0; pop y→d1, w→d2, h→d3
                this._genExprArg(stmt, 3, 'Box h', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 2, 'Box w', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 1, 'Box y', lines);
                lines.push('        move.l  d0,-(sp)');
                this._genExprArg(stmt, 0, 'Box x', lines);
                lines.push('        movem.l (sp)+,d1-d3');
                lines.push('        jsr     _Box');
                break;
            }

            case 'pokeb':
            case 'pokew':
            case 'pokel':
            case 'poke': {
                // PokeB/W/L addr, val — write byte/word/longword to arbitrary address.
                // Poke is an alias for PokeL (Blitz2D convention).
                //
                // Three codegen paths (fastest to most general):
                //   1. Both literal → move.sz #val,$ADDR          (single instruction)
                //   2. Literal addr → eval val→d0, move.sz d0,$ADDR
                //   3. Runtime addr → eval addr→d0, push; eval val→d0; pop→a0; move.sz d0,(a0)
                const sz      = stmt.name === 'pokeb' ? 'b' : stmt.name === 'pokew' ? 'w' : 'l';
                const addrArg = stmt.args[0] ?? { type: 'int', value: 0 };
                const valArg  = stmt.args[1] ?? { type: 'int', value: 0 };
                if (addrArg.type === 'int' && valArg.type === 'int') {
                    // Path 1: both literal — single instruction
                    const hex = '$' + (addrArg.value >>> 0).toString(16).toUpperCase();
                    lines.push(`        move.${sz}  #${valArg.value},${hex}`);
                } else if (addrArg.type === 'int') {
                    // Path 2: literal addr, runtime val — eval val, absolute store
                    const hex = '$' + (addrArg.value >>> 0).toString(16).toUpperCase();
                    this._genExprArg(stmt, 1, `Poke${sz.toUpperCase()} val`, lines);
                    lines.push(`        move.${sz}  d0,${hex}`);
                } else {
                    // Path 3: runtime addr — save addr on stack, eval val, pop addr→a0
                    this._genExpr(addrArg, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExprArg(stmt, 1, `Poke${sz.toUpperCase()} val`, lines);
                    lines.push('        move.l  (sp)+,a0');
                    lines.push(`        move.${sz}  d0,(a0)`);
                }
                break;
            }

            case 'setbackground': {
                // SetBackground index — register a full-screen image as the background.
                // _SetBackground(a0=imgptr) computes _bg_bpl_ptr and installs _bg_restore_static.
                const idxArg = stmt.args[0];
                if (!idxArg || idxArg.type !== 'int')
                    throw new Error(`SetBackground: index must be an integer literal (line ${stmt.line})`);
                const bgEntry = this._imageAssets.get(idxArg.value);
                if (!bgEntry)
                    throw new Error(`SetBackground: image index ${idxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);
                lines.push(`        lea     ${bgEntry.label},a0`);
                lines.push('        jsr     _SetBackground');
                break;
            }

            case 'loadmask':
                // LoadMask index, "file.mask" — registered in _collectVars; no runtime code.
                break;

            case 'drawbob': {
                // DrawBob index, x, y [, frame]
                //   index must be an integer literal
                //   x, y, frame may be any expression; frame defaults to 0
                // Calling convention: _AddBob(a0=imgptr, a1=maskptr|0, d0=x, d1=y, d2=frame)
                const idxArg = stmt.args[0];
                if (!idxArg || idxArg.type !== 'int')
                    throw new Error(`DrawBob: index must be an integer literal (line ${stmt.line})`);
                const imgEntry = this._imageAssets.get(idxArg.value);
                if (!imgEntry)
                    throw new Error(`DrawBob: image index ${idxArg.value} not loaded — use LoadImage first (line ${stmt.line})`);
                const maskEntry = this._maskAssets.get(idxArg.value);

                const xExpr    = stmt.args[1] ?? { type: 'int', value: 0 };
                const yExpr    = stmt.args[2] ?? { type: 'int', value: 0 };
                const frameArg = stmt.args[3]; // undefined = no frame (default 0)

                // _AddBob always needs d2=frame.  For the no-frame / frame-0 path,
                // evaluate y→push, x→d0, pop y→d1, then moveq #0,d2 (1 instruction).
                // For a variable frame, push frame first, then y, then x, pop into d1/d2.
                if (!frameArg || (frameArg.type === 'int' && frameArg.value === 0)) {
                    // Common path: no frame or literal 0
                    this._genExpr(yExpr, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(xExpr, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push('        moveq   #0,d2');
                } else if (frameArg.type === 'int') {
                    // Literal non-zero frame
                    this._genExpr(yExpr, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(xExpr, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push(`        moveq   #${frameArg.value},d2`);
                } else {
                    // Variable frame — push frame, push y, eval x→d0, pop y→d1, pop frame→d2
                    this._genExpr(frameArg, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(yExpr, lines);
                    lines.push('        move.l  d0,-(sp)');
                    this._genExpr(xExpr, lines);
                    lines.push('        move.l  (sp)+,d1');
                    lines.push('        move.l  (sp)+,d2');
                }
                // Set a0/a1 AFTER expression eval (_genExpr uses a0 internally)
                lines.push(`        lea     ${imgEntry.label},a0`);
                if (maskEntry) {
                    lines.push(`        lea     ${maskEntry.label},a1`);
                } else {
                    lines.push('        move.l  #0,a1');
                }
                lines.push('        jsr     _AddBob');
                break;
            }

            default:
                lines.push(`; [codegen] Unhandled command: ${stmt.name} (line ${stmt.line})`);
                console.warn(`[CodeGen] No codegen for '${stmt.name}' on line ${stmt.line}`);
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

            case 'ident':
                lines.push(`        move.l  ${this._varRef(expr.name)},d0`);
                break;

            case 'array_read':
                // Evaluate index → d0; multiply by 4; offset from array base.
                this._genExpr(expr.index, lines);
                lines.push(`        asl.l   #2,d0`);
                lines.push(`        lea     _arr_${expr.name},a0`);
                lines.push(`        add.l   d0,a0`);
                lines.push(`        move.l  (a0),d0`);
                break;

            case 'call_expr': {
                // ── Built-in functions ────────────────────────────────────────
                // Checked before user functions so names like 'abs'/'rnd' can
                // never be shadowed by a user-defined function of the same name.

                // Abs(n) — inline: tst.l d0 / bge.s / neg.l d0
                if (expr.name === 'abs') {
                    const doneLbl = this._nextLabel();
                    this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
                    lines.push('        tst.l   d0');
                    lines.push(`        bge.s   ${doneLbl}`);
                    lines.push('        neg.l   d0');
                    lines.push(`${doneLbl}:`);
                    break;
                }

                // Rnd(n) — calls _Rnd; d1 = n (upper bound), result in d0
                if (expr.name === 'rnd') {
                    this._genExpr(expr.args[0] ?? { type: 'int', value: 1 }, lines);
                    lines.push('        move.l  d0,d1');
                    lines.push('        jsr     _Rnd');
                    break;
                }

                // ── JoyUp/JoyDown/JoyLeft/JoyRight(port) — inline joystick read ──
                //
                // JOY0DAT = $DFF00A (port 0),  JOY1DAT = $DFF00C (port 1)
                // XOR decode:  move.w; move.w d0,d1; lsr.w #1,d1; eor.w d0,d1
                //   d1 bit 0  = RIGHT  (bit1 XOR bit0  of raw)
                //   d1 bit 1  = LEFT   (bit1 of raw; bit2 = 0 for digital joystick)
                //   d1 bit 8  = DOWN   (bit9 XOR bit8  of raw)
                //   d1 bit 9  = UP     (bit9 of raw; bit10 = 0 for digital joystick)
                // Returns -1 (pressed) or 0 (not pressed).
                {
                    const joyBit = { joyright: 0, joyleft: 1, joydown: 8, joyup: 9 };
                    if (Object.prototype.hasOwnProperty.call(joyBit, expr.name)) {
                        const bitN   = joyBit[expr.name];
                        const portArg = expr.args[0] ?? { type: 'int', value: 1 };
                        if (portArg.type === 'int') {
                            const addr = portArg.value === 0 ? '$DFF00A' : '$DFF00C';
                            lines.push(`        move.w  ${addr},d0`);
                        } else {
                            // runtime port (0 or 1): JOYxDAT = $DFF00A + port*2
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
                        break;
                    }
                }

                // ── Joyfire(port) — CIAAPRA ($BFE001), active low ────────────────
                // Port 0: bit 7,  Port 1: bit 6.
                // Bit = 0 when fire is pressed (active low) → invert then sne.
                // Returns -1 (pressed) or 0 (not pressed).
                if (expr.name === 'joyfire') {
                    const portArg = expr.args[0] ?? { type: 'int', value: 1 };
                    lines.push('        move.b  $BFE001,d0');
                    lines.push('        not.b   d0');           // invert: pressed → bit set
                    if (portArg.type === 'int') {
                        const bitN = portArg.value === 0 ? 7 : 6;
                        lines.push(`        btst    #${bitN},d0`);
                    } else {
                        // runtime port: fire bit = 7 - port  (port0→7, port1→6)
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
                    break;
                }

                // ── MouseX() / MouseY() — current mouse position ─────────────────
                if (expr.name === 'mousex') {
                    lines.push('        move.w  _mouse_x,d0');
                    lines.push('        ext.l   d0');
                    break;
                }
                if (expr.name === 'mousey') {
                    lines.push('        move.w  _mouse_y,d0');
                    lines.push('        ext.l   d0');
                    break;
                }

                // ── MouseDown(n) — is button n currently held? ───────────────────
                // n=0: left (_mouse_down_0),  n=1: right (_mouse_down_1)
                // Returns -1 (held) or 0 (not held).
                if (expr.name === 'mousedown') {
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
                    break;
                }

                // ── MouseHit(n) — was button n clicked since last call? ───────────
                // Returns -1 if hit, 0 otherwise. Clears the hit flag on read.
                if (expr.name === 'mousehit') {
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
                    break;
                }

                // ── KeyDown(scancode) — non-blocking key state from _kbd_matrix ──
                //
                // _kbd_matrix is a 16-byte (128-bit) array maintained by the Level-2
                // keyboard interrupt handler in startup.s.
                // Bit n of the matrix is set while scancode n is held down.
                //   byte = scancode >> 3,  bit = scancode & 7
                // Returns -1 (held) or 0 (not held).
                if (expr.name === 'keydown') {
                    this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
                    lines.push('        move.l  d0,d1');
                    lines.push('        lsr.l   #3,d1');        // d1 = byte index
                    lines.push('        and.l   #7,d0');        // d0 = bit index
                    lines.push('        lea     _kbd_matrix,a0');
                    lines.push('        add.l   d1,a0');        // a0 → matrix byte
                    lines.push('        btst    d0,(a0)');      // test bit (mod 8 for memory)
                    lines.push('        sne     d0');
                    lines.push('        ext.w   d0');
                    lines.push('        ext.l   d0');
                    break;
                }

                // Str$(n) — integer to decimal ASCII string pointer
                if (expr.name === 'str$') {
                    this._genExpr(expr.args[0] ?? { type: 'int', value: 0 }, lines);
                    lines.push('        jsr     _IntToStr');    // d0 = string ptr
                    break;
                }

                // ── PeekB/PeekW/PeekL(addr) — direct memory/hardware read ───────
                // All three sizes are fully inlined (no fragment needed).
                // Literal addr: direct absolute addressing (1–2 instructions).
                // Runtime addr: eval addr→d0, load into a0, then read via (a0).
                // PeekB zero-extends (0–255); PeekW sign-extends; PeekL full 32-bit.
                {
                    const peekSz = { peekb: 'b', peekw: 'w', peekl: 'l' };
                    if (Object.prototype.hasOwnProperty.call(peekSz, expr.name)) {
                        const sz      = peekSz[expr.name];
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
                        break;
                    }
                }

                // ── RectsOverlap(x1,y1,w1,h1, x2,y2,w2,h2) → -1/0 ─────────────
                // Pure inline AABB test.  No fragment, no JSR.
                // Push all 8 args; movem.l (sp)+,d0-d7 loads them in reverse:
                //   d0=h2  d1=w2  d2=y2  d3=x2  d4=h1  d5=w1  d6=y1  d7=x1
                // a1 saves x1 across test1→test2; a2 saves y1 across test3→test4.
                if (expr.name === 'rectsoverlap') {
                    if (expr.args.length < 8)
                        throw new Error('RectsOverlap: requires 8 arguments (x1,y1,w1,h1,x2,y2,w2,h2)');
                    for (const arg of expr.args) {
                        this._genExpr(arg, lines);
                        lines.push('        move.l  d0,-(sp)');
                    }
                    lines.push('        movem.l (sp)+,d0-d7');
                    // d0=h2, d1=w2, d2=y2, d3=x2, d4=h1, d5=w1, d6=y1, d7=x1
                    const rfLbl = this._nextLabel();
                    const reLbl = this._nextLabel();
                    lines.push('        move.l  d7,a1');       // a1 = x1
                    lines.push('        add.l   d5,d7');       // d7 = x1+w1
                    lines.push('        cmp.l   d3,d7');       // x1+w1 vs x2
                    lines.push(`        ble.s   ${rfLbl}`);
                    lines.push('        add.l   d1,d3');       // d3 = x2+w2
                    lines.push('        cmp.l   a1,d3');       // x2+w2 vs x1
                    lines.push(`        ble.s   ${rfLbl}`);
                    lines.push('        move.l  d6,a2');       // a2 = y1
                    lines.push('        add.l   d4,d6');       // d6 = y1+h1
                    lines.push('        cmp.l   d2,d6');       // y1+h1 vs y2
                    lines.push(`        ble.s   ${rfLbl}`);
                    lines.push('        add.l   d0,d2');       // d2 = y2+h2
                    lines.push('        cmp.l   a2,d2');       // y2+h2 vs y1
                    lines.push(`        ble.s   ${rfLbl}`);
                    lines.push('        moveq   #-1,d0');
                    lines.push(`        bra.s   ${reLbl}`);
                    lines.push(`${rfLbl}:`);
                    lines.push('        moveq   #0,d0');
                    lines.push(`${reLbl}:`);
                    break;
                }

                // ── ImagesOverlap(img1,x1,y1, img2,x2,y2) → -1/0 ───────────────
                // Reads w/h from image headers (compile-time labels); then same
                // inline AABB as RectsOverlap.
                // Push x2,y2,x1,y1; movem→d0-d3 (d0=y1,d1=x1,d2=y2,d3=x2? no ↓)
                //   push order: x1,y1,x2,y2 → d0=y2,d1=x2,d2=y1,d3=x1
                //   d4=w1,d5=h1,d6=w2,d7=h2 from headers.
                if (expr.name === 'imagesoverlap') {
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
                    // Push x1, y1, x2, y2 (in that order → d0=y2, d1=x2, d2=y1, d3=x1)
                    for (const argIdx of [1, 2, 4, 5]) {
                        this._genExpr(expr.args[argIdx], lines);
                        lines.push('        move.l  d0,-(sp)');
                    }
                    lines.push('        movem.l (sp)+,d0-d3');
                    // d0=y2, d1=x2, d2=y1, d3=x1 — load dims from headers
                    lines.push(`        move.w  ${ast1.label}+0,d4`);
                    lines.push('        ext.l   d4');           // d4 = w1
                    lines.push(`        move.w  ${ast1.label}+2,d5`);
                    lines.push('        ext.l   d5');           // d5 = h1
                    lines.push(`        move.w  ${ast2.label}+0,d6`);
                    lines.push('        ext.l   d6');           // d6 = w2
                    lines.push(`        move.w  ${ast2.label}+2,d7`);
                    lines.push('        ext.l   d7');           // d7 = h2
                    // AABB: x1+w1>x2 AND x2+w2>x1 AND y1+h1>y2 AND y2+h2>y1
                    const ifLbl = this._nextLabel();
                    const ieLbl = this._nextLabel();
                    lines.push('        move.l  d3,a1');       // a1 = x1
                    lines.push('        add.l   d4,d3');       // d3 = x1+w1
                    lines.push('        cmp.l   d1,d3');       // x1+w1 vs x2
                    lines.push(`        ble.s   ${ifLbl}`);
                    lines.push('        add.l   d6,d1');       // d1 = x2+w2
                    lines.push('        cmp.l   a1,d1');       // x2+w2 vs x1
                    lines.push(`        ble.s   ${ifLbl}`);
                    lines.push('        move.l  d2,a2');       // a2 = y1
                    lines.push('        add.l   d5,d2');       // d2 = y1+h1
                    lines.push('        cmp.l   d0,d2');       // y1+h1 vs y2
                    lines.push(`        ble.s   ${ifLbl}`);
                    lines.push('        add.l   d7,d0');       // d0 = y2+h2
                    lines.push('        cmp.l   a2,d0');       // y2+h2 vs y1
                    lines.push(`        ble.s   ${ifLbl}`);
                    lines.push('        moveq   #-1,d0');
                    lines.push(`        bra.s   ${ieLbl}`);
                    lines.push(`${ifLbl}:`);
                    lines.push('        moveq   #0,d0');
                    lines.push(`${ieLbl}:`);
                    break;
                }

                // ── ImageRectOverlap(img,x,y, rx,ry,rw,rh) → -1/0 ──────────────
                // img w/h from header; rect dims from args; same inline AABB.
                // Push x,y,rx,ry,rw,rh (6 exprs) → movem→d0-d5:
                //   d0=rh, d1=rw, d2=ry, d3=rx, d4=y, d5=x
                //   d6=img_w, d7=img_h from header.
                if (expr.name === 'imagerectoverlap') {
                    if (expr.args.length < 7)
                        throw new Error('ImageRectOverlap: requires 7 arguments (img,x,y,rx,ry,rw,rh)');
                    const imgIdxA = expr.args[0];
                    if (!imgIdxA || imgIdxA.type !== 'int')
                        throw new Error('ImageRectOverlap: arg 0 (img) must be an integer literal');
                    const imgAst = this._imageAssets.get(imgIdxA.value);
                    if (!imgAst) throw new Error(`ImageRectOverlap: no image at index ${imgIdxA.value}`);
                    // Push x,y,rx,ry,rw,rh in order (→ d0=rh,d1=rw,d2=ry,d3=rx,d4=y,d5=x)
                    for (const argIdx of [1, 2, 3, 4, 5, 6]) {
                        this._genExpr(expr.args[argIdx], lines);
                        lines.push('        move.l  d0,-(sp)');
                    }
                    lines.push('        movem.l (sp)+,d0-d5');
                    // d0=rh, d1=rw, d2=ry, d3=rx, d4=y, d5=x — load img dims
                    lines.push(`        move.w  ${imgAst.label}+0,d6`);
                    lines.push('        ext.l   d6');           // d6 = img_w
                    lines.push(`        move.w  ${imgAst.label}+2,d7`);
                    lines.push('        ext.l   d7');           // d7 = img_h
                    // AABB: x+w>rx AND rx+rw>x AND y+h>ry AND ry+rh>y
                    const ioLbl = this._nextLabel();
                    const ioELbl = this._nextLabel();
                    lines.push('        move.l  d5,a1');       // a1 = x
                    lines.push('        add.l   d6,d5');       // d5 = x+img_w
                    lines.push('        cmp.l   d3,d5');       // x+w vs rx
                    lines.push(`        ble.s   ${ioLbl}`);
                    lines.push('        add.l   d1,d3');       // d3 = rx+rw
                    lines.push('        cmp.l   a1,d3');       // rx+rw vs x
                    lines.push(`        ble.s   ${ioLbl}`);
                    lines.push('        move.l  d4,a2');       // a2 = y
                    lines.push('        add.l   d7,d4');       // d4 = y+img_h
                    lines.push('        cmp.l   d2,d4');       // y+h vs ry
                    lines.push(`        ble.s   ${ioLbl}`);
                    lines.push('        add.l   d0,d2');       // d2 = ry+rh
                    lines.push('        cmp.l   a2,d2');       // ry+rh vs y
                    lines.push(`        ble.s   ${ioLbl}`);
                    lines.push('        moveq   #-1,d0');
                    lines.push(`        bra.s   ${ioELbl}`);
                    lines.push(`${ioLbl}:`);
                    lines.push('        moveq   #0,d0');
                    lines.push(`${ioELbl}:`);
                    break;
                }

                // ── User function call or array read ──────────────────────────
                const funcDef = this._userFunctions.get(expr.name);
                if (funcDef) {
                    if (!funcDef.hasReturn) {
                        throw new Error(
                            `'${expr.name}' is a procedure (no return value) and cannot be used in an expression`
                        );
                    }
                    this._emitFunctionCall(expr.name, expr.args, lines);
                } else {
                    // Array read: treat args[0] as index
                    const index = expr.args[0] ?? { type: 'int', value: 0 };
                    this._genExpr(index, lines);
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
        if (expr.type === 'ident') return this._varRef(expr.name);
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
            lines.push(`        move.l  #${n},d1`);
            lines.push(`        muls.w  d1,d0`);
        }
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
        if (!arg || arg.type !== 'int') {
            throw new Error(
                `${label}: expected integer literal at position ${idx} on line ${stmt.line}`
            );
        }
        return arg.value;
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

        for (const stmt of body) {
            if (!stmt) continue;
            lines.push(...this._genStatement(stmt));
            this._peepholeRedundantReload(lines);
        }

        // Default return value (0) if control falls off the end
        lines.push('        moveq   #0,d0');
        lines.push(`${exitLabel}:`);
        lines.push('        unlk    a6');
        lines.push('        rts');

        this._funcCtx = null;
        return lines;
    }

    /** Return a globally unique local label string. */
    _nextLabel() {
        return `.L${this._labelCount++}`;
    }
}
