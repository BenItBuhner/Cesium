/**
 * PCM primitives for the ambient voice path: a bounded ring buffer with
 * absolute sample addressing (so the endpointer can cut utterances by
 * timestamp, including pre-roll), a stateful linear resampler for
 * context-rate -> 16 kHz conversion, and PCM16/WAV encoding for STT upload.
 *
 * Everything here is DOM-free and covered by unit tests.
 */

export const VOICE_SAMPLE_RATE = 16_000;

/**
 * Bounded mono Float32 ring buffer. `write` advances an absolute sample
 * counter; `slice(fromSample, toSample)` returns audio by absolute index,
 * zero-filling anything already evicted. Bounded pre-roll falls out of the
 * capacity: older audio simply ages out.
 */
export class PcmRingBuffer {
  private readonly data: Float32Array;
  private total = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
    this.data = new Float32Array(capacity);
  }

  get totalWritten(): number {
    return this.total;
  }

  get oldestAvailable(): number {
    return Math.max(0, this.total - this.capacity);
  }

  write(samples: Float32Array): void {
    let src = samples;
    if (src.length >= this.capacity) {
      // Only the trailing `capacity` samples survive; skip the rest while
      // keeping the absolute counter (and thus modulo alignment) intact.
      const skipped = src.length - this.capacity;
      this.total += skipped;
      src = src.subarray(skipped);
    }
    const writeAt = this.total % this.capacity;
    const tail = Math.min(src.length, this.capacity - writeAt);
    this.data.set(src.subarray(0, tail), writeAt);
    if (tail < src.length) {
      this.data.set(src.subarray(tail), 0);
    }
    this.total += src.length;
  }

  slice(fromSample: number, toSample: number): Float32Array {
    const clampedTo = Math.min(toSample, this.total);
    const out = new Float32Array(Math.max(0, toSample - fromSample));
    const readable = Math.max(fromSample, this.oldestAvailable);
    for (let abs = readable; abs < clampedTo; abs++) {
      out[abs - fromSample] = this.data[abs % this.capacity]!;
    }
    return out;
  }
}

/**
 * Stateful linear-interpolation resampler. Chromium rarely honors a
 * requested 16 kHz capture rate, so worklet chunks arrive at the context
 * rate (44.1/48 kHz) and are folded down here, preserving fractional
 * position across chunk boundaries.
 */
export class LinearResampler {
  private readonly ratio: number;
  private position = 0;
  private lastSample = 0;
  private primed = false;

  constructor(inputRate: number, outputRate: number = VOICE_SAMPLE_RATE) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error("sample rates must be positive");
    }
    this.ratio = inputRate / outputRate;
  }

  process(chunk: Float32Array): Float32Array {
    if (chunk.length === 0) return new Float32Array(0);
    if (this.ratio === 1) return chunk.slice();
    const out: number[] = [];
    // `position` is the fractional read index into the virtual stream formed
    // by [lastSample, ...chunk]; index 0 refers to lastSample.
    while (this.position < chunk.length) {
      const idx = Math.floor(this.position);
      const frac = this.position - idx;
      const s0 = idx === 0 ? (this.primed ? this.lastSample : chunk[0]!) : chunk[idx - 1]!;
      const s1 = chunk[Math.min(idx, chunk.length - 1)]!;
      out.push(s0 + (s1 - s0) * frac);
      this.position += this.ratio;
    }
    this.position -= chunk.length;
    this.lastSample = chunk[chunk.length - 1]!;
    this.primed = true;
    return Float32Array.from(out);
  }
}

export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sum / samples.length);
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/** Encodes mono float samples as a PCM16 RIFF/WAVE buffer for STT upload. */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE
): ArrayBuffer {
  const pcm = floatToPcm16(samples);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i]!, true);
  }
  return buffer;
}
