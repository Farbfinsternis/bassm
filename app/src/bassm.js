import { PreProcessor } from "./preprocessor.js";
import { Lexer } from "./lexer.js";
import { Parser } from "./parser.js";

/*
    BASSM - Basic Assembler
    Blitz2D Code -> m68k Assembler -> vasm -> Amiga HUNK binary -> vAmigaWeb Emulator
*/


class BASSM{
    constructor(){
        this.preProcessor = new PreProcessor();
        this.lexer = new Lexer();
        this.parser = new Parser();
    }
}