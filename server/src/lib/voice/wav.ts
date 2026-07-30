/**
 * Minimal WAV (RIFF/PCM16) encoding for the TTS adapter layer. Every engine
 * normalizes its output to a mono 16-bit PCM WAV so the browser player can
 * treat all engines identically.
 */

export function encodeWavPcm16(
  samples: Float32Array | Int16Array,
  sampleRate: number,
  channels = 1
): Buffer {
  const int16 =
    samples instanceof Int16Array ? samples : floatToPcm16(samples);
  const dataBytes = int16.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < int16.length; i++) {
    buffer.writeInt16LE(int16[i]!, 44 + i * 2);
  }
  return buffer;
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
};

/** Reads the header of a RIFF/WAVE buffer; returns null when not a WAV. */
export function readWavInfo(buffer: Buffer): WavInfo | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!sampleRate || !channels || !bitsPerSample) return null;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationMs: bytesPerSecond > 0 ? (dataBytes / bytesPerSecond) * 1000 : 0,
  };
}
