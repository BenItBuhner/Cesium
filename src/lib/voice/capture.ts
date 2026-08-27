/**
 * Persistent AudioWorklet microphone capture for the ambient voice path -
 * NOT MediaRecorder. The worklet forwards raw mono PCM at the context rate;
 * the main thread resamples to 16 kHz, maintains the bounded ring buffer,
 * and yields 512-sample VAD frames. Echo cancellation, noise suppression,
 * and AGC are requested, and the ACTUAL track settings are reported, since
 * Chromium is free to ignore constraints.
 */

import {
  LinearResampler,
  PcmRingBuffer,
  rmsLevel,
  VOICE_SAMPLE_RATE,
} from "./pcm";
import { VAD_FRAME_SAMPLES } from "./vad";

const WORKLET_SOURCE = `
class CesiumVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("cesium-voice-capture", CesiumVoiceCaptureProcessor);
`;

export type CaptureTrackSettings = {
  sampleRate: number | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  deviceLabel: string | null;
};

export type VoiceCaptureCallbacks = {
  /** Called for every 512-sample 16 kHz frame with its absolute end index. */
  onFrame: (frame: Float32Array, frameEndSample: number) => void;
  onLevel?: (rms: number) => void;
  onSettings?: (settings: CaptureTrackSettings) => void;
  onError?: (error: Error) => void;
};

const RING_BUFFER_SECONDS = 30;

export class VoiceCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private resampler: LinearResampler | null = null;
  private pending = new Float32Array(0);
  private running = false;

  readonly ringBuffer = new PcmRingBuffer(
    VOICE_SAMPLE_RATE * RING_BUFFER_SECONDS
  );

  constructor(private readonly callbacks: VoiceCaptureCallbacks) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Extracts a clip by stream milliseconds (as reported by the endpointer). */
  clipByMs(startMs: number, endMs: number): Float32Array {
    const from = Math.floor((startMs / 1000) * VOICE_SAMPLE_RATE);
    const to = Math.ceil((endMs / 1000) * VOICE_SAMPLE_RATE);
    return this.ringBuffer.slice(from, to);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track && this.callbacks.onSettings) {
      const settings = track.getSettings();
      this.callbacks.onSettings({
        sampleRate: settings.sampleRate ?? null,
        echoCancellation: settings.echoCancellation ?? null,
        noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null,
        deviceLabel: track.label || null,
      });
    }

    const context = new AudioContext();
    this.context = context;
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" })
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    this.resampler = new LinearResampler(context.sampleRate, VOICE_SAMPLE_RATE);
    this.sourceNode = context.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(context, "cesium-voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      try {
        this.handleChunk(event.data);
      } catch (error) {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };
    this.sourceNode.connect(this.workletNode);
    if (context.state === "suspended") {
      await context.resume();
    }
    this.running = true;
  }

  /** Feeds pre-recorded 16 kHz PCM through the exact same frame pipeline. */
  injectPcm16k(samples: Float32Array): void {
    this.dispatchResampled(samples);
  }

  private handleChunk(chunk: Float32Array): void {
    if (!this.resampler) return;
    const resampled = this.resampler.process(chunk);
    this.dispatchResampled(resampled);
  }

  private dispatchResampled(resampled: Float32Array): void {
    if (resampled.length === 0) return;
    this.ringBuffer.write(resampled);
    this.callbacks.onLevel?.(rmsLevel(resampled));

    const combined = new Float32Array(this.pending.length + resampled.length);
    combined.set(this.pending);
    combined.set(resampled, this.pending.length);
    let offset = 0;
    // Frame end indices align with the ring buffer's absolute counter.
    let frameEnd =
      this.ringBuffer.totalWritten - combined.length + VAD_FRAME_SAMPLES;
    while (offset + VAD_FRAME_SAMPLES <= combined.length) {
      this.callbacks.onFrame(
        combined.subarray(offset, offset + VAD_FRAME_SAMPLES),
        frameEnd
      );
      offset += VAD_FRAME_SAMPLES;
      frameEnd += VAD_FRAME_SAMPLES;
    }
    this.pending = combined.slice(offset);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.workletNode = null;
    this.sourceNode = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.pending = new Float32Array(0);
    this.resampler = null;
  }
}
