/**
 * Framework-free turn engine for the conversation-bound voice agent session.
 *
 * Owns the hardened lifecycle primitives so they are unit-testable without a
 * browser: a session epoch (generation counter), AbortController threading
 * through STT and submission, a bounded pending-turn queue that drops the
 * oldest utterance under pressure, and a single serialized drain loop. Any
 * `stop()` bumps the epoch and aborts in-flight work, so no side effect from
 * a stale turn (transcript entries, submissions, errors) can land after the
 * session ended.
 */

export type VoiceTurnStatus = "idle" | "transcribing" | "sending";

export type VoiceTurnInput =
  | { kind: "clip"; clip: Float32Array }
  | { kind: "text"; text: string };

export type VoiceTurnEngineCallbacks = {
  /** Speech-to-text for a committed mic clip (16 kHz mono PCM). */
  transcribe: (clip: Float32Array, signal: AbortSignal) => Promise<string>;
  /** Deliver the utterance to the bound conversation (create or prompt). */
  submit: (text: string, signal: AbortSignal) => Promise<boolean>;
  onStatus?: (status: VoiceTurnStatus) => void;
  /** Fired once per turn with the final utterance text (sttMs null for text turns). */
  onHeard?: (text: string, sttMs: number | null) => void;
  onError?: (message: string, stage: "transcribe" | "submit") => void;
  onTurnDropped?: (input: VoiceTurnInput) => void;
};

/** Newest speech wins: beyond this many queued turns the oldest is dropped. */
export const MAX_PENDING_VOICE_TURNS = 2;

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class VoiceTurnEngine {
  private epoch = 0;
  private active = false;
  private pending: VoiceTurnInput[] = [];
  private draining = false;
  private currentAbort: AbortController | null = null;
  private status: VoiceTurnStatus = "idle";

  constructor(
    private readonly callbacks: VoiceTurnEngineCallbacks,
    private readonly now: () => number = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now()
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentStatus(): VoiceTurnStatus {
    return this.status;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.epoch += 1;
  }

  /**
   * Ends the session generation: aborts in-flight STT/submission, clears the
   * queue, and guarantees no callback from a stale turn fires afterwards.
   */
  stop(): void {
    if (!this.active && this.pending.length === 0 && !this.currentAbort) {
      return;
    }
    this.active = false;
    this.epoch += 1;
    if (this.pending.length > 0) {
      for (const dropped of this.pending) {
        this.callbacks.onTurnDropped?.(dropped);
      }
      this.pending = [];
    }
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.setStatus("idle");
  }

  /** Returns false when the engine is inactive or the input is empty. */
  enqueue(input: VoiceTurnInput): boolean {
    if (!this.active) return false;
    if (input.kind === "text" && !input.text.trim()) return false;
    if (input.kind === "clip" && input.clip.length === 0) return false;
    this.pending.push(input);
    while (this.pending.length > MAX_PENDING_VOICE_TURNS) {
      const dropped = this.pending.shift();
      if (dropped) this.callbacks.onTurnDropped?.(dropped);
    }
    void this.drain();
    return true;
  }

  private setStatus(next: VoiceTurnStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatus?.(next);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active && this.pending.length > 0) {
        const input = this.pending.shift();
        if (!input) break;
        await this.runTurn(input, this.epoch);
      }
    } finally {
      this.draining = false;
      this.setStatus("idle");
    }
  }

  private async runTurn(
    input: VoiceTurnInput,
    epochAtStart: number
  ): Promise<void> {
    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      let text: string;
      let sttMs: number | null = null;
      if (input.kind === "clip") {
        this.setStatus("transcribing");
        const sttStart = this.now();
        try {
          text = (await this.callbacks.transcribe(input.clip, abort.signal)).trim();
        } catch (error) {
          if (this.epoch === epochAtStart && !abort.signal.aborted) {
            this.callbacks.onError?.(
              toErrorMessage(error, "Transcription failed."),
              "transcribe"
            );
          }
          return;
        }
        if (this.epoch !== epochAtStart || abort.signal.aborted) return;
        if (!text) return;
        sttMs = Math.round(this.now() - sttStart);
      } else {
        text = input.text.trim();
      }

      this.callbacks.onHeard?.(text, sttMs);
      this.setStatus("sending");
      try {
        await this.callbacks.submit(text, abort.signal);
      } catch (error) {
        if (this.epoch === epochAtStart && !abort.signal.aborted) {
          this.callbacks.onError?.(
            toErrorMessage(error, "Sending the utterance failed."),
            "submit"
          );
        }
      }
    } finally {
      if (this.currentAbort === abort) {
        this.currentAbort = null;
      }
    }
  }
}
