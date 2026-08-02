/**
 * Decodes compressed/encoded audio (e.g. a WAV from the TTS route) into
 * mono 16 kHz Float32 PCM, used by the voice pipeline self-test to feed
 * synthetic utterances through the exact capture -> VAD -> endpointing ->
 * STT path without a physical microphone.
 */

import { VOICE_SAMPLE_RATE } from "./pcm";

export async function decodeToPcm16k(data: ArrayBuffer): Promise<Float32Array> {
  const probeContext = new AudioContext();
  try {
    const decoded = await probeContext.decodeAudioData(data.slice(0));
    const durationSamples = Math.ceil(decoded.duration * VOICE_SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, durationSamples, VOICE_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await probeContext.close().catch(() => {});
  }
}
