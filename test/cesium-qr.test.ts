import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { encodeQr, renderQrHalfBlocks } from "../scripts/cesium-qr.mjs";

type Qr = { version: number; size: number; mask: number; modules: boolean[][] };

function digest(qr: Qr): string {
  const flat = qr.modules.map((row) => row.map((v) => (v ? "1" : "0")).join("")).join("\n");
  return createHash("sha256").update(flat).digest("hex");
}

const CONNECT_URL = "https://cesium.techlitnow.com/connect/pbuuqg3u9cz3k4z65rb7ufuyse";

/**
 * Golden matrices were cross-checked module-for-module against the `qrcode`
 * npm package (same version/level/mask) and decoded with jsQR in both
 * polarities before being pinned here.
 */
const GOLDEN: Array<{ text: string; level: "L" | "M"; version: number; mask: number; sha256: string }> = [
  { text: "hi", level: "L", version: 1, mask: 2, sha256: "97314de84ccfecea9f2d18e3d42127c25b51fec65408a08118d4da75b2075197" },
  { text: CONNECT_URL, level: "L", version: 4, mask: 2, sha256: "f6178e72a3d76d348243088f396ae084d4d8f2285285cebd580e63d131dd035b" },
  { text: CONNECT_URL, level: "M", version: 5, mask: 2, sha256: "aefe27b2194cce1968909d44159263661e0737e90c519b85866e3b8ced5b57f5" },
  { text: "z".repeat(270), level: "L", version: 10, mask: 1, sha256: "8088b910b27c6207211d30727fdd0cbe1d4d82444527bcb1dc08df53cf88fbb9" },
];

function isFinderAt(qr: Qr, row: number, col: number): boolean {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (qr.modules[row + r]![col + c] !== (ring || core)) {
        return false;
      }
    }
  }
  return true;
}

describe("terminal QR encoder", () => {
  test("matches the pinned reference matrices", () => {
    for (const golden of GOLDEN) {
      const qr = encodeQr(golden.text, golden.level) as Qr;
      assert.equal(qr.version, golden.version, `${golden.level} version`);
      assert.equal(qr.size, golden.version * 4 + 17);
      assert.equal(qr.mask, golden.mask, `${golden.level} mask`);
      assert.equal(digest(qr), golden.sha256, `${golden.level} ${golden.text.slice(0, 20)}`);
    }
  });

  test("places the three finder patterns and the dark module", () => {
    const qr = encodeQr(CONNECT_URL) as Qr;
    assert.equal(isFinderAt(qr, 0, 0), true);
    assert.equal(isFinderAt(qr, 0, qr.size - 7), true);
    assert.equal(isFinderAt(qr, qr.size - 7, 0), true);
    assert.equal(qr.modules[qr.size - 8]![8], true);
  });

  test("rejects payloads beyond version 10 and unknown levels", () => {
    assert.throws(() => encodeQr("z".repeat(300), "L"), /too long/);
    assert.throws(() => encodeQr("hi", "Q" as never), /level/);
  });

  test("renders two module rows per text line with a quiet zone", () => {
    const qr = encodeQr("hi") as Qr;
    const text = renderQrHalfBlocks(qr, { quietZone: 2 });
    const lines = text.split("\n");
    assert.equal(lines.length, Math.ceil((qr.size + 4) / 2));
    assert.equal(lines.every((line) => [...line].length === qr.size + 4), true);
    // Quiet zone rows are all light (rendered as full blocks).
    assert.equal(lines[0], "█".repeat(qr.size + 4));
    assert.equal(/^[█▀▄ ]+$/u.test(text.replace(/\n/g, "")), true);
  });
});
