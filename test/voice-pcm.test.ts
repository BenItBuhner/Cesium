import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeWavPcm16,
  floatToPcm16,
  LinearResampler,
  PcmRingBuffer,
  rmsLevel,
} from "../src/lib/voice/pcm.ts";

test("ring buffer preserves absolute indexing across wrap-around", () => {
  const ring = new PcmRingBuffer(8);
  ring.write(Float32Array.from([1, 2, 3, 4, 5, 6]));
  ring.write(Float32Array.from([7, 8, 9, 10])); // wraps: total 10, capacity 8
  assert.equal(ring.totalWritten, 10);
  assert.equal(ring.oldestAvailable, 2);
  const slice = ring.slice(4, 10);
  assert.deepEqual(Array.from(slice), [5, 6, 7, 8, 9, 10]);
});

test("ring buffer zero-fills evicted history", () => {
  const ring = new PcmRingBuffer(4);
  ring.write(Float32Array.from([1, 2, 3, 4, 5, 6]));
  const slice = ring.slice(0, 6);
  // Samples 0 and 1 were evicted.
  assert.deepEqual(Array.from(slice), [0, 0, 3, 4, 5, 6]);
});

test("ring buffer handles chunks larger than capacity", () => {
  const ring = new PcmRingBuffer(4);
  const big = Float32Array.from({ length: 10 }, (_, i) => i + 1);
  ring.write(big);
  assert.equal(ring.totalWritten, 10);
  assert.deepEqual(Array.from(ring.slice(6, 10)), [7, 8, 9, 10]);
});

test("resampler halves sample count at 2:1 and preserves duration", () => {
  const resampler = new LinearResampler(32000, 16000);
  let total = 0;
  for (let chunk = 0; chunk < 10; chunk++) {
    const input = new Float32Array(320); // 10ms at 32kHz
    total += resampler.process(input).length;
  }
  // 100ms of audio -> 1600 samples at 16kHz (allow +-2 for phase carry).
  assert.ok(Math.abs(total - 1600) <= 2, `expected ~1600, got ${total}`);
});

test("resampler interpolates a ramp without discontinuities across chunks", () => {
  const resampler = new LinearResampler(48000, 16000);
  const ramp = Float32Array.from({ length: 480 }, (_, i) => i / 480);
  const out1 = resampler.process(ramp.subarray(0, 240));
  const out2 = resampler.process(ramp.subarray(240));
  const merged = [...out1, ...out2];
  for (let i = 1; i < merged.length; i++) {
    const delta = merged[i]! - merged[i - 1]!;
    assert.ok(delta >= 0, `ramp output must be monotonic at ${i}`);
    assert.ok(delta < 0.02, `no jumps expected, got ${delta} at ${i}`);
  }
});

test("wav encoding produces a valid RIFF header with PCM16 payload", () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const wav = new DataView(encodeWavPcm16(samples, 16000));
  const ascii = (offset: number, length: number) =>
    Array.from({ length }, (_, i) =>
      String.fromCharCode(wav.getUint8(offset + i))
    ).join("");
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint16(22, true), 1); // mono
  assert.equal(wav.getUint32(40, true), samples.length * 2);
  assert.equal(wav.getInt16(44 + 6, true), 32767); // 1.0 -> max
  assert.equal(wav.getInt16(44 + 8, true), -32768); // -1.0 -> min
});

test("float-to-pcm16 clamps out-of-range samples", () => {
  const pcm = floatToPcm16(Float32Array.from([2, -2]));
  assert.equal(pcm[0], 32767);
  assert.equal(pcm[1], -32768);
});

test("rms level reflects signal energy", () => {
  assert.equal(rmsLevel(new Float32Array(100)), 0);
  const loud = rmsLevel(Float32Array.from({ length: 100 }, () => 0.5));
  assert.ok(Math.abs(loud - 0.5) < 1e-6);
});
