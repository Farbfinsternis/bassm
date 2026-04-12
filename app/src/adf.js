// ============================================================================
// adf.js — ADF (Amiga Disk File) Generator
// ============================================================================
//
// Pure-JS generator for OFS-formatted 880KB ADF disk images.
// Target: Amiga 500, Kickstart 1.3, Original File System (OFS).
//
// Reference: Laurent Clévy's ADF format specification
// ============================================================================

// ── Disk Geometry ───────────────────────────────��───────────────────────────
export const BLOCK_SIZE   = 512;
export const NUM_TRACKS   = 80;
export const NUM_HEADS    = 2;
export const NUM_SECTORS  = 11;
export const NUM_BLOCKS   = NUM_TRACKS * NUM_HEADS * NUM_SECTORS;  // 1760
export const DISK_SIZE    = NUM_BLOCKS * BLOCK_SIZE;               // 901120

// ── Key Block Positions ─────────────────────────────────────────────────────
export const ROOT_BLOCK   = 880;   // middle of disk (track 40, head 0, sector 0)
export const BITMAP_BLOCK = 881;   // conventionally right after root

// ── Block Types (first long of every block) ─────────────────────────────────
export const T_HEADER = 2;
export const T_DATA   = 8;
export const T_LIST   = 16;       // file extension block

// ── Secondary Types (last long of every header block) ───────────────────────
export const ST_ROOT    = 1;
export const ST_USERDIR = 2;
export const ST_FILE    = -3;     // 0xFFFFFFFD as signed int32

// ── Hash Table ──────────────────────────────��───────────────────────────────
export const HT_SIZE = 72;        // (BLOCK_SIZE / 4) - 56 entries

// ── Bootblock ───────────────────────────────────────────────────────────────
export const BOOTBLOCK_MAGIC = 0x444F5300;  // 'DOS\0' — OFS identifier
export const BOOTBLOCK_SIZE  = BLOCK_SIZE * 2;  // 1024 bytes (blocks 0 + 1)

// ── OFS Data Block Payload ───────────────────────────────���──────────────────
// Data blocks carry a 24-byte header; remaining 488 bytes are file data.
export const OFS_HEADER_SIZE  = 24;
export const OFS_DATA_PAYLOAD = BLOCK_SIZE - OFS_HEADER_SIZE;  // 488

// ── Max Data Block Pointers per Header/Extension ────────────────────────────
export const MAX_BLOCK_PTRS = 72;  // same as HT_SIZE

// ── Bitmap ──────────────────────────────────────────────────────────────────
// Bitmap tracks blocks 2–1759 (bootblock 0–1 not represented).
// 1758 blocks → ceil(1758/32) = 55 longs.
// Bit = 1 → free, Bit = 0 → used.
export const BM_FIRST_BLOCK = 2;        // first block represented in bitmap
export const BM_MAP_LONGS   = 55;       // longs of bitmap data needed
export const BM_MAP_BYTES   = BM_MAP_LONGS * 4;  // 220 bytes

// ── Root Block — Byte Offsets ─────────────────────────────────��─────────────
export const ROOT = Object.freeze({
    TYPE:       0,          // LONG  T_HEADER (2)
    HT_SIZE:    12,         // LONG  72
    CHECKSUM:   20,         // LONG
    HT:         24,         // 72×LONG  hash table (24–311)
    BM_FLAG:    312,        // LONG  -1 = bitmap valid
    BM_PAGES:   316,        // 25×LONG  bitmap block pointers (316–415)
    BM_EXT:     416,        // LONG  bitmap extension block (0 for DD)
    R_DAYS:     420,        // LONG  last root alteration — days since 1978-01-01
    R_MINS:     424,        // LONG  minutes past midnight
    R_TICKS:    428,        // LONG  ticks (1/50 s) past minute
    NAME_LEN:   432,        // BYTE  disk name length (max 30)
    NAME:       433,        // 30 BYTES  disk name (ASCII)
    V_DAYS:     472,        // LONG  last disk alteration — days
    V_MINS:     476,        // LONG  minutes
    V_TICKS:    480,        // LONG  ticks
    C_DAYS:     484,        // LONG  filesystem creation — days
    C_MINS:     488,        // LONG  minutes
    C_TICKS:    492,        // LONG  ticks
    SEC_TYPE:   508,        // LONG  ST_ROOT (1)
});

// ── File Header Block — Byte Offsets ────────────────────────────────────────
export const FH = Object.freeze({
    TYPE:       0,          // LONG  T_HEADER (2)
    HEADER_KEY: 4,          // LONG  own block number
    HIGH_SEQ:   8,          // LONG  number of data block pointers stored
    FIRST_DATA: 16,         // LONG  first data block number
    CHECKSUM:   20,         // LONG
    BLOCK_TABLE: 24,        // 72×LONG  data block pointers, reverse order (24–311)
    PROTECT:    320,        // LONG  protection bits
    BYTE_SIZE:  324,        // LONG  file size in bytes
    COMM_LEN:   328,        // BYTE  comment length
    COMMENT:    329,        // 79 BYTES  comment
    DAYS:       420,        // LONG  last modification — days since 1978-01-01
    MINS:       424,        // LONG  minutes
    TICKS:      428,        // LONG  ticks
    NAME_LEN:   432,        // BYTE  filename length (max 30)
    NAME:       433,        // 30 BYTES  filename (ASCII)
    HASH_CHAIN: 496,        // LONG  next entry with same hash in parent dir
    PARENT:     500,        // LONG  parent directory block number
    EXTENSION:  504,        // LONG  first file extension block (0 if ≤72 data blocks)
    SEC_TYPE:   508,        // LONG  ST_FILE (-3)
});

// ── UserDir Block — Byte Offsets ──────────────────────────────��─────────────
// Same physical layout as file header; hash table replaces block table.
export const UD = Object.freeze({
    TYPE:       0,          // LONG  T_HEADER (2)
    HEADER_KEY: 4,          // LONG  own block number
    CHECKSUM:   20,         // LONG
    HT:         24,         // 72×LONG  hash table for sub-entries (24–311)
    PROTECT:    320,        // LONG  protection bits
    DAYS:       420,        // LONG  last modification — days
    MINS:       424,        // LONG  minutes
    TICKS:      428,        // LONG  ticks
    NAME_LEN:   432,        // BYTE  directory name length (max 30)
    NAME:       433,        // 30 BYTES  directory name (ASCII)
    HASH_CHAIN: 496,        // LONG  next entry with same hash in parent dir
    PARENT:     500,        // LONG  parent directory block number
    SEC_TYPE:   508,        // LONG  ST_USERDIR (2)
});

// ── OFS Data Block — Byte Offsets ─────────────────────────────────���─────────
export const DB = Object.freeze({
    TYPE:       0,          // LONG  T_DATA (8)
    HEADER_KEY: 4,          // LONG  file header block number
    SEQ_NUM:    8,          // LONG  sequence number (1-based)
    DATA_SIZE:  12,         // LONG  bytes of payload in this block (max 488)
    NEXT_DATA:  16,         // LONG  next data block (0 if last)
    CHECKSUM:   20,         // LONG
    DATA:       24,         // 488 BYTES  file data payload
});

// ── File Extension Block — Byte Offsets ─────────────────────────────────────
// Used when a file needs more than 72 data blocks (file > 72 × 488 = 35136 bytes).
export const EXT = Object.freeze({
    TYPE:       0,          // LONG  T_LIST (16)
    HEADER_KEY: 4,          // LONG  own block number
    HIGH_SEQ:   8,          // LONG  number of data block pointers stored
    CHECKSUM:   20,         // LONG
    BLOCK_TABLE: 24,        // 72×LONG  data block pointers, reverse order (24–311)
    PARENT:     500,        // LONG  file header block number
    EXTENSION:  504,        // LONG  next extension block (0 if last)
    SEC_TYPE:   508,        // LONG  ST_FILE (-3)
});

// ── Bitmap Block — Byte Offsets ─────────────────────────────────────────────
export const BM = Object.freeze({
    CHECKSUM:   0,          // LONG
    MAP:        4,          // 55×LONG  bitmap data (4–223)
});

// ── Amiga Date Epoch ────────────────────────────────────────────────────────
// AmigaOS counts days since 1978-01-01 00:00:00 UTC.
export const AMIGA_EPOCH = Date.UTC(1978, 0, 1);  // ms since Unix epoch


// ============================================================================
// Helper — Amiga date conversion
// ============================================================================

/**
 * Convert a JS Date (or Date.now() ms) to Amiga date triplet.
 * @param {Date|number} [date=Date.now()]
 * @returns {{ days: number, mins: number, ticks: number }}
 */
export function amigaDate(date) {
    const ms   = typeof date === 'number' ? date : (date ? date.getTime() : Date.now());
    const diff = ms - AMIGA_EPOCH;                   // ms since 1978-01-01
    const days = Math.floor(diff / 86400000);        // 24*60*60*1000
    const rem  = diff - days * 86400000;
    const mins = Math.floor(rem / 60000);            // 60*1000
    const ticks = Math.floor((rem - mins * 60000) / 20);  // 1 tick = 20 ms (50 Hz)
    return { days, mins, ticks };
}


// ============================================================================
// Helper — Big-endian read/write for the ADF buffer
// ============================================================================
// ADF is an Amiga (68000) disk image — all multi-byte values are big-endian.

/** Write a signed/unsigned 32-bit big-endian long into buf at offset. */
export function writeLong(buf, offset, value) {
    buf[offset]     = (value >>> 24) & 0xFF;
    buf[offset + 1] = (value >>> 16) & 0xFF;
    buf[offset + 2] = (value >>>  8) & 0xFF;
    buf[offset + 3] =  value         & 0xFF;
}

/** Read a signed 32-bit big-endian long from buf at offset. */
export function readLong(buf, offset) {
    return (buf[offset] << 24) | (buf[offset + 1] << 16) |
           (buf[offset + 2] << 8) | buf[offset + 3];
}

/** Return byte offset of the given block number within the ADF buffer. */
export function blockOffset(block) {
    return block * BLOCK_SIZE;
}


// ============================================================================
// T2 — Create empty ADF buffer
// ============================================================================

/**
 * Allocate a zeroed 880 KB buffer representing a blank ADF disk image.
 * @returns {Uint8Array} 901120 bytes, all zero
 */
export function createBuffer() {
    return new Uint8Array(DISK_SIZE);
}


// ============================================================================
// Checksum algorithms
// ============================================================================

/**
 * Compute the ones'-complement checksum for the bootblock (blocks 0+1).
 * The checksum field at offset 4 is excluded from the sum.
 * @param {Uint8Array} buf  ADF buffer (reads bytes 0–1023)
 * @returns {number} Unsigned 32-bit checksum to write at offset 4
 */
export function computeBootChecksum(buf) {
    let sum = 0;
    for (let i = 0; i < 256; i++) {
        if (i === 1) continue;                  // skip checksum field (offset 4)
        const val = readLong(buf, i * 4) >>> 0;  // unsigned
        sum += val;
        if (sum > 0xFFFFFFFF) sum -= 0xFFFFFFFF; // ones' complement carry
    }
    return (~sum) >>> 0;
}

/**
 * Compute the standard block checksum (two's complement).
 * Sum of all 128 longs in the block (excluding the checksum field) is negated
 * so that the total sum equals zero.
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} blockNum  Block number (0–1759)
 * @param {number} [checksumFieldOffset=20]  Byte offset of checksum within the block
 * @returns {number} Signed 32-bit checksum value
 */
export function computeBlockChecksum(buf, blockNum, checksumFieldOffset = 20) {
    const base = blockNum * BLOCK_SIZE;
    let sum = 0;
    for (let i = 0; i < 128; i++) {
        if (i * 4 !== checksumFieldOffset) {
            sum = (sum + readLong(buf, base + i * 4)) | 0;  // int32 wrap
        }
    }
    return (-sum) | 0;
}


// ============================================================================
// T3 — Bootblock
// ============================================================================

// Standard AmigaDOS boot code (36 bytes).
// Byte-exact copy of what `Install DF0:` writes on KS 1.3.
// Called by Kickstart with a6=ExecBase. Finds dos.library's resident tag,
// loads RT_INIT into a0, returns d0=0 — Kickstart then boots via DOS.
const BOOT_CODE = new Uint8Array([
    0x43, 0xFA, 0x00, 0x18,        // lea     DosName(pc),a1
    0x4E, 0xAE, 0xFF, 0xA0,        // jsr     _LVOFindResident(a6)  [-96]
    0x4A, 0x80,                     // tst.l   d0
    0x67, 0x0A,                     // beq.s   .fail                 [+10]
    0x20, 0x40,                     // movea.l d0,a0
    0x20, 0x68, 0x00, 0x16,        // movea.l 22(a0),a0             [RT_INIT]
    0x70, 0x00,                     // moveq   #0,d0
    0x4E, 0x75,                     // rts
    0x70, 0xFF,                     // moveq   #-1,d0               [.fail]
    0x4E, 0x75,                     // rts
    // "dos.library\0"
    0x64, 0x6F, 0x73, 0x2E, 0x6C, 0x69, 0x62, 0x72, 0x61, 0x72, 0x79, 0x00,
]);

/**
 * Write a standard OFS bootblock into blocks 0–1 of the ADF buffer.
 * Sets the DOS\0 magic, root block pointer, boot code, and checksum.
 * @param {Uint8Array} buf  ADF buffer (must be ≥ 1024 bytes)
 */
export function writeBootblock(buf) {
    // DOS\0 magic — identifies this as an OFS disk
    writeLong(buf, 0, BOOTBLOCK_MAGIC);

    // Root block pointer (long at offset 8)
    writeLong(buf, 8, ROOT_BLOCK);

    // Boot code at offset 12
    buf.set(BOOT_CODE, 12);

    // Compute and store ones'-complement checksum at offset 4
    writeLong(buf, 4, computeBootChecksum(buf));
}


// ============================================================================
// T4 — Root Block
// ============================================================================

/**
 * Write the root block at block 880.
 * Creates an empty directory with the given disk name, points to the bitmap
 * block at 881, and stamps all three date fields with the current time.
 * @param {Uint8Array} buf  ADF buffer
 * @param {string} diskName  Volume label (max 30 chars, ASCII)
 */
export function writeRootBlock(buf, diskName) {
    const base = blockOffset(ROOT_BLOCK);
    const now  = amigaDate();
    const name = diskName.slice(0, 30);

    // Type + secondary type
    writeLong(buf, base + ROOT.TYPE, T_HEADER);
    writeLong(buf, base + ROOT.SEC_TYPE, ST_ROOT);

    // Hash table size
    writeLong(buf, base + ROOT.HT_SIZE, HT_SIZE);
    // Hash table entries are already 0 (empty disk)

    // Bitmap valid flag + pointer to bitmap block
    writeLong(buf, base + ROOT.BM_FLAG, -1);             // -1 = valid
    writeLong(buf, base + ROOT.BM_PAGES, BITMAP_BLOCK);  // bm_pages[0]

    // Disk name (BCPL string: length byte + ASCII bytes)
    buf[base + ROOT.NAME_LEN] = name.length;
    for (let i = 0; i < name.length; i++) {
        buf[base + ROOT.NAME + i] = name.charCodeAt(i);
    }

    // Last root alteration
    writeLong(buf, base + ROOT.R_DAYS,  now.days);
    writeLong(buf, base + ROOT.R_MINS,  now.mins);
    writeLong(buf, base + ROOT.R_TICKS, now.ticks);

    // Last disk modification
    writeLong(buf, base + ROOT.V_DAYS,  now.days);
    writeLong(buf, base + ROOT.V_MINS,  now.mins);
    writeLong(buf, base + ROOT.V_TICKS, now.ticks);

    // Filesystem creation date
    writeLong(buf, base + ROOT.C_DAYS,  now.days);
    writeLong(buf, base + ROOT.C_MINS,  now.mins);
    writeLong(buf, base + ROOT.C_TICKS, now.ticks);

    // Checksum (must be last — covers all fields above)
    writeLong(buf, base + ROOT.CHECKSUM, computeBlockChecksum(buf, ROOT_BLOCK));
}


// ============================================================================
// T5 — Bitmap Block
// ============================================================================

/**
 * Clear a single bit in the bitmap (mark block as used).
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} blockNum  Block to mark (must be ≥ 2)
 */
export function bitmapMarkUsed(buf, blockNum) {
    const idx = Math.floor((blockNum - BM_FIRST_BLOCK) / 32);
    const bit = (blockNum - BM_FIRST_BLOCK) % 32;
    const off = blockOffset(BITMAP_BLOCK) + BM.MAP + idx * 4;
    writeLong(buf, off, readLong(buf, off) & ~(1 << bit));
}

/**
 * Write the bitmap block at block 881.
 * Initialises all blocks 2–1759 as free, then marks the root block (880)
 * and the bitmap block itself (881) as used.
 * @param {Uint8Array} buf  ADF buffer
 */
export function writeBitmapBlock(buf) {
    const base = blockOffset(BITMAP_BLOCK);

    // Set all 55 longs to "all free" (bits = 1)
    for (let i = 0; i < BM_MAP_LONGS; i++) {
        writeLong(buf, base + BM.MAP + i * 4, 0xFFFFFFFF);
    }

    // Last long (index 54) covers blocks 1730–1761, but only 1730–1759 exist.
    // Bits 30–31 correspond to non-existent blocks 1760–1761 → must be 0.
    writeLong(buf, base + BM.MAP + 54 * 4, 0x3FFFFFFF);

    // Mark root (880) and bitmap (881) as used
    bitmapMarkUsed(buf, ROOT_BLOCK);
    bitmapMarkUsed(buf, BITMAP_BLOCK);

    // Bitmap checksum — checksum field is at offset 0 (not 20)
    writeLong(buf, base + BM.CHECKSUM, computeBlockChecksum(buf, BITMAP_BLOCK, 0));
}


// ============================================================================
// T6 — Block Allocator
// ============================================================================

/**
 * Allocate the next free block from the bitmap.
 * Scans bitmap longs sequentially, finds the lowest free bit (1),
 * marks it as used (0), and updates the bitmap checksum.
 * @param {Uint8Array} buf  ADF buffer
 * @returns {number} Allocated block number (2–1759)
 * @throws {Error} If the disk is full
 */
export function allocBlock(buf) {
    const bmBase = blockOffset(BITMAP_BLOCK);

    for (let i = 0; i < BM_MAP_LONGS; i++) {
        const off = bmBase + BM.MAP + i * 4;
        const val = readLong(buf, off);
        if (val === 0) continue;                    // no free blocks in this long

        // Lowest set bit: val & (-val) isolates it, clz32 gives position
        const bit = 31 - Math.clz32(val & (-val));  // bit position 0–31
        const blockNum = BM_FIRST_BLOCK + i * 32 + bit;

        if (blockNum >= NUM_BLOCKS) throw new Error('ADF: disk full');

        // Clear the bit (mark as used)
        writeLong(buf, off, val & ~(1 << bit));

        // Update bitmap checksum
        writeLong(buf, bmBase + BM.CHECKSUM, computeBlockChecksum(buf, BITMAP_BLOCK, 0));

        return blockNum;
    }

    throw new Error('ADF: disk full');
}


// ============================================================================
// T7 — OFS Data Blocks
// ============================================================================

/**
 * Write file content as a chain of OFS data blocks.
 * Allocates blocks, splits the payload into 488-byte chunks, writes the
 * OFS header (Type, HeaderKey, SeqNum, DataSize, NextData, Checksum)
 * into each block, and links them via NextData pointers.
 *
 * @param {Uint8Array} buf  ADF buffer
 * @param {Uint8Array} fileData  Raw file content
 * @param {number} headerBlock  Block number of the file's header block
 * @returns {number[]} Allocated data block numbers in sequence order
 */
export function writeDataBlocks(buf, fileData, headerBlock) {
    const count = Math.ceil(fileData.length / OFS_DATA_PAYLOAD) || 0;
    if (count === 0) return [];

    // Allocate all data blocks upfront so we know NextData pointers
    const blocks = [];
    for (let i = 0; i < count; i++) blocks.push(allocBlock(buf));

    for (let i = 0; i < count; i++) {
        const base     = blockOffset(blocks[i]);
        const srcOff   = i * OFS_DATA_PAYLOAD;
        const dataSize = Math.min(OFS_DATA_PAYLOAD, fileData.length - srcOff);
        const nextData = i < count - 1 ? blocks[i + 1] : 0;

        writeLong(buf, base + DB.TYPE,       T_DATA);
        writeLong(buf, base + DB.HEADER_KEY, headerBlock);
        writeLong(buf, base + DB.SEQ_NUM,    i + 1);
        writeLong(buf, base + DB.DATA_SIZE,  dataSize);
        writeLong(buf, base + DB.NEXT_DATA,  nextData);

        // Copy payload
        buf.set(fileData.subarray(srcOff, srcOff + dataSize), base + DB.DATA);

        // Checksum (covers entire 512-byte block, field at offset 20)
        writeLong(buf, base + DB.CHECKSUM, computeBlockChecksum(buf, blocks[i]));
    }

    return blocks;
}


// ============================================================================
// T8 — File Header Block
// ============================================================================

/**
 * Create a file on the ADF: allocates a header block, writes data blocks
 * (via writeDataBlocks), fills the block pointer table (reverse order),
 * and creates extension blocks for files larger than 35136 bytes (72 × 488).
 *
 * Does NOT insert the file into its parent directory's hash table — see T9.
 *
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} parentBlock  Parent directory block number
 * @param {string} name  Filename (max 30 chars, ASCII)
 * @param {Uint8Array} fileData  Raw file content
 * @returns {number} Block number of the file header
 */
export function writeFileHeader(buf, parentBlock, name, fileData) {
    const headerBlock = allocBlock(buf);
    const dataBlocks  = writeDataBlocks(buf, fileData, headerBlock);
    const base        = blockOffset(headerBlock);
    const now         = amigaDate();
    const fname       = name.slice(0, 30);
    const totalData   = dataBlocks.length;

    // ── Fixed fields ───────────────────────────────────────────────────────
    writeLong(buf, base + FH.TYPE,       T_HEADER);
    writeLong(buf, base + FH.SEC_TYPE,   ST_FILE);    // -3
    writeLong(buf, base + FH.HEADER_KEY, headerBlock);
    writeLong(buf, base + FH.FIRST_DATA, totalData > 0 ? dataBlocks[0] : 0);
    writeLong(buf, base + FH.BYTE_SIZE,  fileData.length);
    writeLong(buf, base + FH.PARENT,     parentBlock);

    // ── Filename (BCPL string: length byte + ASCII) ────────────────────────
    buf[base + FH.NAME_LEN] = fname.length;
    for (let i = 0; i < fname.length; i++) {
        buf[base + FH.NAME + i] = fname.charCodeAt(i);
    }

    // ── Date ───────────────────────────────────────────────────────────────
    writeLong(buf, base + FH.DAYS,  now.days);
    writeLong(buf, base + FH.MINS,  now.mins);
    writeLong(buf, base + FH.TICKS, now.ticks);

    // ── Block pointer table (reverse order: index 71 = first data block) ──
    const headerPtrs = Math.min(MAX_BLOCK_PTRS, totalData);
    writeLong(buf, base + FH.HIGH_SEQ, headerPtrs);
    for (let i = 0; i < headerPtrs; i++) {
        writeLong(buf, base + FH.BLOCK_TABLE + (MAX_BLOCK_PTRS - 1 - i) * 4, dataBlocks[i]);
    }

    // ── Extension blocks (files > 72 data blocks / ~35 KB) ────────────────
    if (totalData > MAX_BLOCK_PTRS) {
        const extra        = dataBlocks.slice(MAX_BLOCK_PTRS);
        const numExtBlocks = Math.ceil(extra.length / MAX_BLOCK_PTRS);

        // Allocate all extension blocks upfront so the chain is known
        const extBlocks = [];
        for (let e = 0; e < numExtBlocks; e++) extBlocks.push(allocBlock(buf));

        // Link file header → first extension
        writeLong(buf, base + FH.EXTENSION, extBlocks[0]);

        for (let e = 0; e < numExtBlocks; e++) {
            const extBase  = blockOffset(extBlocks[e]);
            const startIdx = e * MAX_BLOCK_PTRS;
            const extPtrs  = Math.min(MAX_BLOCK_PTRS, extra.length - startIdx);
            const nextExt  = e < numExtBlocks - 1 ? extBlocks[e + 1] : 0;

            writeLong(buf, extBase + EXT.TYPE,       T_LIST);
            writeLong(buf, extBase + EXT.HEADER_KEY, extBlocks[e]);
            writeLong(buf, extBase + EXT.HIGH_SEQ,   extPtrs);
            writeLong(buf, extBase + EXT.PARENT,     headerBlock);
            writeLong(buf, extBase + EXT.EXTENSION,  nextExt);
            writeLong(buf, extBase + EXT.SEC_TYPE,   ST_FILE);    // -3

            for (let i = 0; i < extPtrs; i++) {
                writeLong(buf, extBase + EXT.BLOCK_TABLE + (MAX_BLOCK_PTRS - 1 - i) * 4, extra[startIdx + i]);
            }

            writeLong(buf, extBase + EXT.CHECKSUM, computeBlockChecksum(buf, extBlocks[e]));
        }
    }

    // ── Header checksum (last — covers block table + extension pointer) ───
    writeLong(buf, base + FH.CHECKSUM, computeBlockChecksum(buf, headerBlock));

    return headerBlock;
}


// ============================================================================
// T9 — Hash-Table Entry (Amiga filename hash + collision chain)
// ============================================================================

/**
 * Compute the standard AmigaDOS filename hash.
 * Algorithm: hash = name.length, then for each char:
 *   hash = (hash × 13 + toupper(char)) & 0x7FF
 * Final: hash % 72
 *
 * @param {string} name  Filename (ASCII, max 30 chars)
 * @returns {number} Hash index 0–71
 */
export function amigaHash(name) {
    let hash = name.length;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        hash = ((hash * 13) + (c >= 0x61 && c <= 0x7A ? c - 0x20 : c)) & 0x7FF;
    }
    return hash % HT_SIZE;
}

/**
 * Insert a file or directory header into its parent directory's hash table.
 * Handles collisions by prepending: the new entry takes the hash slot,
 * and the previous occupant (if any) moves to the new entry's HASH_CHAIN.
 *
 * Works for root blocks (ST_ROOT) and user directory blocks (ST_USERDIR)
 * as parent — both share identical hash-table layout at offset 24.
 *
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} parentBlock  Parent directory block number (root or userdir)
 * @param {string} name  Filename/dirname used for hashing
 * @param {number} entryBlock  Block number of the file/dir header to insert
 */
export function insertIntoHashTable(buf, parentBlock, name, entryBlock) {
    const slot       = amigaHash(name);
    const parentBase = blockOffset(parentBlock);
    const slotOff    = parentBase + ROOT.HT + slot * 4;  // ROOT.HT = UD.HT = 24

    // Read existing occupant (0 = empty slot)
    const existing = readLong(buf, slotOff);

    // Place our entry in the slot
    writeLong(buf, slotOff, entryBlock);

    // Collision → chain: our HASH_CHAIN points to previous occupant
    if (existing !== 0) {
        const entryBase = blockOffset(entryBlock);
        writeLong(buf, entryBase + FH.HASH_CHAIN, existing);  // FH.HASH_CHAIN = UD.HASH_CHAIN = 496
        writeLong(buf, entryBase + FH.CHECKSUM, computeBlockChecksum(buf, entryBlock));
    }

    // Recompute parent's checksum (hash table changed)
    writeLong(buf, parentBase + ROOT.CHECKSUM, computeBlockChecksum(buf, parentBlock));
}


// ============================================================================
// T10 — Create Directory
// ============================================================================

/**
 * Create a directory (UserDir block) on the ADF and insert it into the
 * parent directory's hash table.
 *
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} parentBlock  Parent directory block number (root or userdir)
 * @param {string} name  Directory name (max 30 chars, ASCII)
 * @returns {number} Block number of the new directory
 */
export function createDir(buf, parentBlock, name) {
    const dirBlock = allocBlock(buf);
    const base     = blockOffset(dirBlock);
    const now      = amigaDate();
    const dname    = name.slice(0, 30);

    // ── Fixed fields ───────────────────────────────────────────────────────
    writeLong(buf, base + UD.TYPE,       T_HEADER);
    writeLong(buf, base + UD.SEC_TYPE,   ST_USERDIR);  // 2
    writeLong(buf, base + UD.HEADER_KEY, dirBlock);
    writeLong(buf, base + UD.PARENT,     parentBlock);

    // ── Directory name (BCPL string) ───────────────────────────────────────
    buf[base + UD.NAME_LEN] = dname.length;
    for (let i = 0; i < dname.length; i++) {
        buf[base + UD.NAME + i] = dname.charCodeAt(i);
    }

    // ── Date ───────────────────────────────────────────────────────────────
    writeLong(buf, base + UD.DAYS,  now.days);
    writeLong(buf, base + UD.MINS,  now.mins);
    writeLong(buf, base + UD.TICKS, now.ticks);

    // ── Checksum ───────────────────────────────────────────────────────────
    writeLong(buf, base + UD.CHECKSUM, computeBlockChecksum(buf, dirBlock));

    // ── Insert into parent hash table (may update HASH_CHAIN + recompute) ─
    insertIntoHashTable(buf, parentBlock, name, dirBlock);

    return dirBlock;
}


// ============================================================================
// T11 — writeFile + createADF (bootable disk with startup-sequence)
// ============================================================================

/**
 * Write a file to the ADF: creates file header + data blocks (T8)
 * and inserts it into the parent directory's hash table (T9).
 *
 * @param {Uint8Array} buf  ADF buffer
 * @param {number} parentBlock  Parent directory block number
 * @param {string} name  Filename (max 30 chars, ASCII)
 * @param {Uint8Array} data  Raw file content
 * @returns {number} Block number of the file header
 */
export function writeFile(buf, parentBlock, name, data) {
    const headerBlock = writeFileHeader(buf, parentBlock, name, data);
    insertIntoHashTable(buf, parentBlock, name, headerBlock);
    return headerBlock;
}

/**
 * Create a complete bootable OFS ADF disk image.
 *
 * Layout:
 *   /               (root directory, volume label = diskName)
 *   ├── <exeName>   (the compiled executable)
 *   └── s/
 *       └── startup-sequence   (contains: "<exeName>\n")
 *
 * KS 1.3 boot sequence: bootblock → dos.library → s/startup-sequence → executable.
 *
 * @param {string} diskName  Volume label (max 30 chars)
 * @param {string} exeName  Executable filename on disk (e.g. "game")
 * @param {Uint8Array} exeData  Raw Amiga executable (hunk format)
 * @returns {Uint8Array} Complete 880 KB ADF image (901120 bytes)
 */
export function createADF(diskName, exeName, exeData) {
    const buf = createBuffer();

    // ── Disk structure (must come before any allocBlock calls) ──────────
    writeBootblock(buf);
    writeBitmapBlock(buf);
    writeRootBlock(buf, diskName);

    // ── Executable in root directory ───────────────────────────────────
    writeFile(buf, ROOT_BLOCK, exeName, exeData);

    // ── s/startup-sequence ─────────────────────────────────────────────
    const sDir = createDir(buf, ROOT_BLOCK, 's');
    const seq  = new TextEncoder().encode(exeName + '\n');
    writeFile(buf, sDir, 'startup-sequence', seq);

    return buf;
}