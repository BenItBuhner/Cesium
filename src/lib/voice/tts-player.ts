/**
 * Cancellable clause-streaming TTS playback through Web Audio (never an
 * <audio> element): synthesis of clause N+1 overlaps playback of clause N,
 * so speech starts after the first stable clause. Supports ducking and
 * instant cancellation for barge-in.
 */

import { splitIntoClauses } from "./clauses";

export type TtsPlayerState = "idle" | "synthesizing" | "speaking";

export type TtsPlayerCallbacks = {
  synthesize: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  onStateChange?: (state: TtsPlayerState) => void;
  /** Fired when the first audible sample of an utterance is scheduled. */
  onFirstAudio?: () => void;
  onError?: (error: Error) => void;
};

const DUCK_GAIN = 0.15;
const DUCK_RAMP_S = 0.08;

export class TtsPlayer {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private abortController: AbortController | null = null;
  private generation = 0;
  private state: TtsPlayerState = "idle";
  private ducked = false;

  constructor(private readonly callbacks: TtsPlayerCallbacks) {}

  get currentState(): TtsPlayerState {
    return this.state;
  }

  get isActive(): boolean {
    return this.state !== "idle";
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.gainNode = this.context.createGain();
      this.gainNode.connect(this.context.destination);
    }
    return this.context;
  }

  private setState(state: TtsPlayerState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  /**
   * Speaks `text`, clause by clause. Resolves when playback finishes or the
   * utterance is cancelled. A new `speak` call cancels the previous one.
   */
  async speak(
    text: string,
    options?: { onFirstAudio?: () => void }
  ): Promise<void> {
    this.cancel();
    const clauses = splitIntoClauses(text);
    if (clauses.length === 0) return;

    const generation = ++this.generation;
    const abortController = new AbortController();
    this.abortController = abortController;
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume().catch(() => {});
    }
    this.setState("synthesizing");

    let playCursor = context.currentTime;
    let firstAudioFired = false;
    const playbackDone: Promise<void>[] = [];

    try {
      // Pipeline: kick off the next synthesis while the previous clause is
      // being scheduled/played.
      let nextSynthesis = this.callbacks.synthesize(
        clauses[0]!,
        abortController.signal
      );
      for (let i = 0; i < clauses.length; i++) {
        const audioData = await nextSynthesis;
        if (generation !== this.generation) return;
        if (i + 1 < clauses.length) {
          nextSynthesis = this.callbacks.synthesize(
            clauses[i + 1]!,
            abortController.signal
          );
        }
        const buffer = await context.decodeAudioData(audioData.slice(0));
        if (generation !== this.generation) return;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode!);
        const startAt = Math.max(playCursor, context.currentTime);
        source.start(startAt);
        playCursor = startAt + buffer.duration;
        this.activeSources.add(source);
        playbackDone.push(
          new Promise<void>((resolve) => {
            source.onended = () => {
              this.activeSources.delete(source);
              resolve();
            };
          })
        );
        if (!firstAudioFired) {
          firstAudioFired = true;
          options?.onFirstAudio?.();
          this.callbacks.onFirstAudio?.();
          this.setState("speaking");
        }
      }
      await Promise.all(playbackDone);
      if (generation === this.generation) {
        this.setState("idle");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState("idle");
      if ((error as Error | null)?.name !== "AbortError") {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  /** Barge-in step 1: fade under probable user speech without giving up. */
  duck(): void {
    if (!this.gainNode || !this.context || this.ducked) return;
    this.ducked = true;
    this.gainNode.gain.cancelScheduledValues(this.context.currentTime);
    this.gainNode.gain.linearRampToValueAtTime(
      DUCK_GAIN,
      this.context.currentTime + DUCK_RAMP_S
    );
  }

  unduck(): void {
    if (!this.gainNode || !this.context || !this.ducked) return;
    this.ducked = false;
    this.gainNode.gain.cancelScheduledValues(this.context.currentTime);
    this.gainNode.gain.linearRampToValueAtTime(
      1,
      this.context.currentTime + DUCK_RAMP_S
    );
  }

  /** Barge-in step 2: hard stop. Safe to call at any time. */
  cancel(): void {
    this.generation++;
    this.abortController?.abort();
    this.abortController = null;
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Sources that already ended throw; ignore.
      }
    }
    this.activeSources.clear();
    if (this.gainNode && this.context) {
      this.ducked = false;
      this.gainNode.gain.cancelScheduledValues(this.context.currentTime);
      this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
    }
    this.setState("idle");
  }
}
