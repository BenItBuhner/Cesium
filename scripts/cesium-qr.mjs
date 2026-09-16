#!/usr/bin/env bun
/**
 * Dependency-free QR code generator for the terminal.
 *
 * Byte mode, error-correction level L or M, versions 1-10 (up to 271 bytes at
 * L) - plenty for a connect link. Implements the ISO/IEC 18004 pipeline:
 * data encoding, Reed-Solomon over GF(2^8), block interleaving, function
 * pattern placement, zigzag data placement, all eight masks with penalty
 * scoring, BCH-coded format and version information. Rendering uses Unicode
 * half blocks so one text row carries two module rows.
 *
 *   bun scripts/cesium-qr.mjs "https://example.test/connect/abc"   # prints the code
 *   import { encodeQr, renderQrHalfBlocks } from "./cesium-qr.mjs";
 */

// --- Reed-Solomon over GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 -------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    GF_EXP[index] = GF_EXP[index - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPolynomial(degree) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[index]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const generator = rsGeneratorPolynomial(ecCount);
  const remainder = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let index = 0; index < ecCount; index += 1) {
        remainder[index] ^= gfMul(generator[index + 1], factor);
      }
    }
  }
  return remainder;
}

// --- Version tables (ISO 18004 table 9, levels L and M, versions 1-10) ------

/** [ecCodewordsPerBlock, [blockCount, dataCodewordsPerBlock], ...] */
const VERSIONS = {
  L: {
    1: [7, [1, 19]],
    2: [10, [1, 34]],
    3: [15, [1, 55]],
    4: [20, [1, 80]],
    5: [26, [1, 108]],
    6: [18, [2, 68]],
    7: [20, [2, 78]],
    8: [24, [2, 97]],
    9: [30, [2, 116]],
    10: [18, [2, 68], [2, 69]],
  },
  M: {
    1: [10, [1, 16]],
    2: [16, [1, 28]],
    3: [26, [1, 44]],
    4: [18, [2, 32]],
    5: [24, [2, 43]],
    6: [16, [4, 27]],
    7: [18, [4, 31]],
    8: [22, [2, 38], [2, 39]],
    9: [22, [3, 36], [2, 37]],
    10: [26, [4, 43], [1, 44]],
  },
};

const ALIGNMENT_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const EC_LEVEL_BITS = { L: 0b01, M: 0b00 };

function dataCapacity(spec) {
  let total = 0;
  for (const [count, size] of spec.slice(1)) total += count * size;
  return total;
}

function pickVersion(byteLength, level) {
  for (let version = 1; version <= 10; version += 1) {
    const spec = VERSIONS[level][version];
    const capacityBits = dataCapacity(spec) * 8;
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= capacityBits) {
      return version;
    }
  }
  throw new Error(`QR payload too long for byte mode at level ${level} (max version 10).`);
}

// --- Data encoding ----------------------------------------------------------

function encodeDataCodewords(bytes, version, level) {
  const spec = VERSIONS[level][version];
  const capacity = dataCapacity(spec);
  const bits = [];
  const push = (value, length) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const terminator = Math.min(4, capacity * 8 - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index + bit];
    codewords.push(value);
  }
  for (let pad = 0; codewords.length < capacity; pad += 1) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

function interleave(dataCodewords, version, level) {
  const spec = VERSIONS[level][version];
  const ecCount = spec[0];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of spec.slice(1)) {
    for (let index = 0; index < count; index += 1) {
      const data = dataCodewords.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: rsEncode(data, ecCount) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < maxData; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) out.push(block.data[index]);
    }
  }
  for (let index = 0; index < ecCount; index += 1) {
    for (const block of blocks) out.push(block.ec[index]);
  }
  return out;
}

// --- Matrix construction ----------------------------------------------------

function createMatrix(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFunction(matrix, row, col, dark) {
  matrix.modules[row][col] = dark;
  matrix.reserved[row][col] = true;
}

function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= matrix.size || cc >= matrix.size) continue;
      const onRing = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const separator = r === -1 || r === 7 || c === -1 || c === 7;
      setFunction(matrix, rr, cc, !separator && (onRing || inCore));
    }
  }
}

function placeAlignment(matrix, row, col) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setFunction(matrix, row + r, col + c, dark);
    }
  }
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.size;
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);
  for (let index = 8; index < size - 8; index += 1) {
    setFunction(matrix, 6, index, index % 2 === 0);
    setFunction(matrix, index, 6, index % 2 === 0);
  }
  const positions = ALIGNMENT_POSITIONS[version];
  for (const row of positions) {
    for (const col of positions) {
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (!nearFinder) placeAlignment(matrix, row, col);
    }
  }
  setFunction(matrix, size - 8, 8, true);
  // Reserve format information areas (filled in after masking).
  for (let index = 0; index < 8; index += 1) {
    matrix.reserved[8][index] = true;
    matrix.reserved[index][8] = true;
    matrix.reserved[8][size - 1 - index] = true;
    matrix.reserved[size - 1 - index][8] = true;
  }
  matrix.reserved[8][8] = true;
  if (version >= 7) {
    for (let index = 0; index < 6; index += 1) {
      for (let j = 0; j < 3; j += 1) {
        matrix.reserved[index][size - 11 + j] = true;
        matrix.reserved[size - 11 + j][index] = true;
      }
    }
  }
}

function placeData(matrix, codewords) {
  const size = matrix.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (matrix.reserved[row][col]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
        }
        matrix.modules[row][col] = dark;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix, mask) {
  const out = matrix.modules.map((row) => row.slice());
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (!matrix.reserved[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function bchFormat(data) {
  // BCH(15,5) with generator 0x537, then XOR mask 0x5412.
  let value = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >> index) & 1) value ^= 0x537 << (index - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function bchVersion(version) {
  // BCH(18,6) with generator 0x1f25.
  let value = version << 12;
  for (let index = 17; index >= 12; index -= 1) {
    if ((value >> index) & 1) value ^= 0x1f25 << (index - 12);
  }
  return (version << 12) | value;
}

function writeFormat(modules, size, level, mask) {
  const bits = bchFormat((EC_LEVEL_BITS[level] << 3) | mask);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >> index) & 1) === 1;
    // Copy 1: down column 8 beside the top-left finder, continuing beside
    // the bottom-left finder. Copy 2: along row 8, right-to-left from the
    // top-right finder, finishing left of the top-left finder.
    if (index < 6) modules[index][8] = dark;
    else if (index < 8) modules[index + 1][8] = dark;
    else modules[size - 15 + index][8] = dark;
    if (index < 8) modules[8][size - index - 1] = dark;
    else if (index < 9) modules[8][15 - index] = dark;
    else modules[8][15 - index - 1] = dark;
  }
  modules[size - 8][8] = true;
}

function writeVersion(modules, size, version) {
  if (version < 7) return;
  const bits = bchVersion(version);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >> index) & 1) === 1;
    const a = Math.floor(index / 3);
    const b = (index % 3) + size - 11;
    modules[a][b] = dark;
    modules[b][a] = dark;
  }
}

function penalty(modules, size) {
  let score = 0;
  // Rule 1: runs of 5+ same-colored modules in rows and columns.
  for (let r = 0; r < size; r += 1) {
    let runRow = 1;
    let runCol = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === modules[r][c - 1]) {
        runRow += 1;
        if (runRow === 5) score += 3;
        else if (runRow > 5) score += 1;
      } else runRow = 1;
      if (modules[c][r] === modules[c - 1][r]) {
        runCol += 1;
        if (runCol === 5) score += 3;
        else if (runCol > 5) score += 1;
      } else runCol = 1;
    }
  }
  // Rule 2: 2x2 blocks of the same color.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns with 4 light modules on a side.
  const pattern = [true, false, true, true, true, false, true];
  const matchesAt = (get, start) => {
    for (let index = 0; index < 7; index += 1) if (get(start + index) !== pattern[index]) return false;
    return true;
  };
  const lightRun = (get, start, length) => {
    for (let index = 0; index < length; index += 1) {
      const value = get(start + index);
      if (value !== false) return false;
    }
    return true;
  };
  for (let r = 0; r < size; r += 1) {
    const getRow = (c) => (c >= 0 && c < size ? modules[r][c] : null);
    const getCol = (rr) => (rr >= 0 && rr < size ? modules[rr][r] : null);
    for (let c = 0; c <= size - 7; c += 1) {
      for (const get of [getRow, getCol]) {
        if (matchesAt(get, c) && (lightRun(get, c - 4, 4) || lightRun(get, c + 7, 4))) score += 40;
      }
    }
  }
  // Rule 4: dark module proportion.
  let dark = 0;
  for (const row of modules) for (const value of row) if (value) dark += 1;
  const percent = (dark * 100) / (size * size);
  const deviation = Math.floor(Math.abs(percent - 50) / 5);
  score += deviation * 10;
  return score;
}

/**
 * Encode `text` (UTF-8) and return `{ version, size, mask, modules }` where
 * `modules[row][col]` is `true` for dark modules.
 */
export function encodeQr(text, level = "L") {
  if (!VERSIONS[level]) throw new Error("QR level must be L or M.");
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, level);
  const size = version * 4 + 17;
  const codewords = interleave(encodeDataCodewords(bytes, version, level), version, level);
  const matrix = createMatrix(size);
  placeFunctionPatterns(matrix, version);
  placeData(matrix, codewords);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = applyMask(matrix, mask);
    writeFormat(modules, size, level, mask);
    writeVersion(modules, size, version);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { mask, modules, score };
  }
  return { version, size, mask: best.mask, modules: best.modules };
}

/**
 * Render as text using half blocks: two module rows per text row. Light
 * modules are drawn as blocks (white on a dark terminal) and dark modules as
 * spaces, so the code reads correctly on the dark terminals engines usually
 * run in; phone scanners also handle the inverted case on light themes.
 */
export function renderQrHalfBlocks(qr, { quietZone = 2, invert = false } = {}) {
  const size = qr.size + quietZone * 2;
  const isDark = (row, col) => {
    const r = row - quietZone;
    const c = col - quietZone;
    const dark = r >= 0 && c >= 0 && r < qr.size && c < qr.size ? qr.modules[r][c] : false;
    return invert ? !dark : dark;
  };
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col += 1) {
      const top = isDark(row, col);
      const bottom = row + 1 < size ? isDark(row + 1, col) : true;
      // Light modules render as blocks - see the doc comment above.
      if (!top && !bottom) line += "█";
      else if (!top && bottom) line += "▀";
      else if (top && !bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const [text, level = "L"] = process.argv.slice(2);
  if (!text) {
    console.error("Usage: cesium-qr.mjs <text> [L|M]");
    process.exit(2);
  }
  process.stdout.write(`${renderQrHalfBlocks(encodeQr(text, level))}\n`);
}
