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
     * Asynchronously expand Include "filename" directives, recursively.
     * All filenames are resolved relative to the project directory via readFile.
     * Must be called BEFORE process() — operates on raw source text.
     *
     * @param {string} source
     * @param {{ readFile: (filename: string) => Promise<string>, _visited?: Set<string> }} opts
     * @returns {Promise<string>}
     */
    async expandIncludes(source, { readFile, _visited = new Set() } = {}) {
        const normalised = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalised.split('\n');
        const result = [];

        for (const line of lines) {
            // Match:  Include "filename"  (optional trailing ; comment)
            const m = line.match(/^\s*Include\s+"([^"]+)"\s*(?:;.*)?$/i);
            if (!m) { result.push(line); continue; }

            const filename = m[1];

            if (!readFile) {
                throw new Error(`Include requires an open project folder: "${filename}"`);
            }
            if (_visited.has(filename)) {
                throw new Error(`Circular Include detected: "${filename}"`);
            }

            const visited2 = new Set(_visited);
            visited2.add(filename);

            let included;
            try {
                included = await readFile(filename);
            } catch (e) {
                throw new Error(`Include: file not found: "${filename}"`);
            }

            const expanded = await this.expandIncludes(included, { readFile, _visited: visited2 });
            result.push(expanded);
        }

        return result.join('\n');
    }

    /**
     * @param {string} source  Raw Blitz2D source text
     * @returns {string}       Cleaned source (same line count, comments removed)
     */
    process(source) {
        // Normalise line endings so we only deal with \n
        const normalised = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Process line by line: strip comments, then split on ':' (statement separator)
        return normalised
            .split('\n')
            .map(line => this._stripComment(line))
            .flatMap(line => this._splitColons(line))
            .join('\n');
    }

    // -------------------------------------------------------------------------
    // Split a line on ':' statement separators, ignoring ':' inside "…" strings.
    // Returns an array of sub-lines (at least one element).
    // -------------------------------------------------------------------------
    _splitColons(line) {
        const parts = [];
        let current = '';
        let inString = false;

        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') { inString = !inString; current += c; continue; }
            if (inString)  { current += c; continue; }
            if (c === ':') { parts.push(current); current = ''; continue; }
            current += c;
        }
        parts.push(current);
        return parts;
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
