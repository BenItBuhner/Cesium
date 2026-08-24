import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ICO_SIZES,
  assertValidDesktopIco,
  buildIco,
  parseIco,
} from "../scripts/desktop-icons.mjs";

const iconIco = join(process.cwd(), "public", "desktop", "icon.ico");

test("committed desktop ICO is a multi-size PNG-in-ICO (not a renamed PNG)", () => {
  const buffer = readFileSync(iconIco);
  const parsed = assertValidDesktopIco(buffer, "public/desktop/icon.ico");
  for (const size of ICO_SIZES) {
    assert.ok(
      parsed.images.some((image) => image.width === size),
      `missing ${size}px ICO image`
    );
  }
  assert.ok(parsed.images.every((image) => image.isPng), "every ICO payload should be PNG");
});

test("buildIco/parseIco round-trips PNG payloads", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
  ]);
  const ico = buildIco([
    { size: 16, buf: png },
    { size: 32, buf: png },
    { size: 48, buf: png },
    { size: 256, buf: png },
  ]);
  const parsed = parseIco(ico);
  assert.equal(parsed.count, 4);
  assert.equal(parsed.images[3].width, 256);
  assert.ok(parsed.images[0].isPng);
});

test("assertValidDesktopIco rejects a bare PNG pretending to be an ICO", () => {
  const png = readFileSync(join(process.cwd(), "public", "desktop", "256x256.png"));
  assert.throws(() => assertValidDesktopIco(png, "fake.ico"), /Not an ICO file/);
});
