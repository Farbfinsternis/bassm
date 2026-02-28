// ============================================================================
// preprocessor.js — BASSM Source PreProcessor
// ============================================================================
//
// Runs before the Lexer.  Responsibilities:
//   1. Normalise line endings (\r\n / \r → \n)
//   2. Strip line comments  (; … and // …)
//      Aware of string literals — semicolons inside "…" are not comments.
//   3. Return the cleaned source string unchanged in all other respects
//      (blank lines, indentation, etc. — the Lexer handles those).
// ============================================================================

export class PreProcessor {

    /**
     * @param {string} source  Raw Blitz2D source text
     * @returns {string}       Cleaned source (same line count, comments removed)
     */
    process(source) {
        // Normalise line endings so we only deal with \n
        const normalised = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Process line by line so stripping is cheap and unambiguous
        return normalised
            .split('\n')
            .map(line => this._stripComment(line))
            .join('\n');
    }

    // -------------------------------------------------------------------------
    // Strip the first un-quoted ; or // comment from a single source line.
    // Characters inside "…" string literals are never treated as comment starts.
    // -------------------------------------------------------------------------
    _stripComment(line) {
        let inString = false;

        for (let i = 0; i < line.length; i++) {
            const c = line[i];

            if (c === '"') {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            // Semicolon comment
            if (c === ';') return line.slice(0, i).trimEnd();

            // C-style double-slash comment
            if (c === '/' && line[i + 1] === '/') return line.slice(0, i).trimEnd();
        }

        return line;
    }
}
