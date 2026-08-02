/**
 * Layered utterance endpointing, per the voice control plane blueprint:
 *
 * 1. A VAD probability stream marks when speech starts and when a possible
 *    pause occurs (start hysteresis avoids triggering on clicks/pops).
 * 2. A turn detector decides whether a candidate pause sounds like a
 *    completed thought (Smart Turn slot; ships with a prosody-lite
 *    heuristic that adapts the pause requirement to utterance length and
 *    trailing energy).
 * 3. A longer hard-silence timeout guarantees progress when the semantic
 *    detector keeps waiting.
 *
 * The state machine is pure (frame-driven, no timers, no DOM) so the exact
 * commit behavior is unit-testable.
 */

export type EndpointerConfig = {
  /** Duration of one processed frame in ms (512 samples @ 16 kHz = 32 ms). */
  frameMs: number;
  /** Consecutive speech required before an utterance officially starts. */
  startHysteresisMs: number;
  /** Audio kept before the detected start (rescues soft first syllables). */
  preRollMs: number;
  /** Silence run that triggers a semantic end-of-turn check. */
  candidatePauseMs: number;
  /** Audio kept after the last speech frame in the committed clip. */
  postRollMs: number;
  /** Guaranteed commit after this much silence, detector notwithstanding. */
  hardSilenceMs: number;
  /** Absolute utterance cap; commits mid-speech. */
  maxUtteranceMs: number;
  /** Commits shorter than this are dropped as blips. */
  minUtteranceMs: number;
  /** VAD probability to count a frame as speech. */
  speechThreshold: number;
  /** Lower release threshold (hysteresis) to count a frame as silence. */
  releaseThreshold: number;
};

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
  frameMs: 32,
  startHysteresisMs: 80,
  preRollMs: 200,
  candidatePauseMs: 300,
  postRollMs: 200,
  hardSilenceMs: 1500,
  maxUtteranceMs: 30_000,
  minUtteranceMs: 300,
  speechThreshold: 0.6,
  releaseThreshold: 0.4,
};

export type TurnAssessment = "commit" | "wait";

export type TurnDetectorContext = {
  /** Speech duration so far (start hysteresis to last speech frame), ms. */
  utteranceMs: number;
  /** Current silence run length, ms. */
  pauseMs: number;
  /** Mean VAD probability over the last few speech frames before the pause. */
  trailingSpeechProb: number;
};

export interface TurnDetector {
  assessPause(context: TurnDetectorContext): TurnAssessment;
}

/**
 * Prosody-lite stand-in for the Smart Turn model, behind the same interface
 * so a real audio-native classifier can drop in later:
 * - Very short utterances ("no", "stop") commit fast; hesitation after two
 *   words usually means more is coming, so mid-length utterances wait
 *   longer.
 * - A confidently-voiced trailing edge (high prob right before the pause)
 *   reads as an unfinished clause and extends the wait.
 */
export class HeuristicTurnDetector implements TurnDetector {
  assessPause(context: TurnDetectorContext): TurnAssessment {
    const { utteranceMs, pauseMs, trailingSpeechProb } = context;
    let requiredPauseMs: number;
    if (utteranceMs < 600) {
      requiredPauseMs = 300;
    } else if (utteranceMs < 2000) {
      requiredPauseMs = 450;
    } else {
      requiredPauseMs = 350;
    }
    if (trailingSpeechProb > 0.85) {
      requiredPauseMs += 150;
    }
    return pauseMs >= requiredPauseMs ? "commit" : "wait";
  }
}

export type CommitReason = "turn_pause" | "hard_silence" | "max_length";

export type EndpointerEvent =
  | { type: "speech_start"; atMs: number }
  | { type: "speech_cancelled"; atMs: number }
  | {
      type: "utterance_committed";
      reason: CommitReason;
      /** Clip bounds in stream time, pre-roll/post-roll included. */
      startMs: number;
      endMs: number;
      /** Speech-only duration, hysteresis start to last speech frame. */
      speechMs: number;
    };

type EndpointerState = "idle" | "arming" | "speaking" | "candidate_pause";

const TRAILING_PROB_WINDOW = 6;

export class Endpointer {
  private state: EndpointerState = "idle";
  private streamMs = 0;
  private armingStartMs = 0;
  private armingRunMs = 0;
  private speechStartMs = 0;
  private lastSpeechMs = 0;
  private silenceRunMs = 0;
  private recentSpeechProbs: number[] = [];

  constructor(
    private readonly config: EndpointerConfig = DEFAULT_ENDPOINTER_CONFIG,
    private readonly turnDetector: TurnDetector = new HeuristicTurnDetector()
  ) {}

  get currentState(): EndpointerState {
    return this.state;
  }

  reset(): void {
    this.state = "idle";
    this.armingRunMs = 0;
    this.silenceRunMs = 0;
    this.recentSpeechProbs = [];
  }

  /** Feeds one VAD frame; returns zero or more endpointing events. */
  processFrame(speechProb: number): EndpointerEvent[] {
    const { config } = this;
    const events: EndpointerEvent[] = [];
    const frameStart = this.streamMs;
    this.streamMs += config.frameMs;
    const isSpeech = speechProb >= config.speechThreshold;
    const isSilence = speechProb < config.releaseThreshold;

    switch (this.state) {
      case "idle": {
        if (isSpeech) {
          this.state = "arming";
          this.armingStartMs = frameStart;
          this.armingRunMs = config.frameMs;
        }
        break;
      }

      case "arming": {
        if (isSpeech) {
          this.armingRunMs += config.frameMs;
          if (this.armingRunMs >= config.startHysteresisMs) {
            this.state = "speaking";
            this.speechStartMs = this.armingStartMs;
            this.lastSpeechMs = this.streamMs;
            this.silenceRunMs = 0;
            this.recentSpeechProbs = [speechProb];
            events.push({ type: "speech_start", atMs: this.speechStartMs });
          }
        } else {
          this.state = "idle";
          this.armingRunMs = 0;
        }
        break;
      }

      case "speaking":
      case "candidate_pause": {
        if (isSpeech) {
          this.state = "speaking";
          this.lastSpeechMs = this.streamMs;
          this.silenceRunMs = 0;
          this.recentSpeechProbs.push(speechProb);
          if (this.recentSpeechProbs.length > TRAILING_PROB_WINDOW) {
            this.recentSpeechProbs.shift();
          }
        } else if (isSilence) {
          this.silenceRunMs += config.frameMs;
          if (this.silenceRunMs >= config.candidatePauseMs) {
            this.state = "candidate_pause";
            const assessment = this.turnDetector.assessPause({
              utteranceMs: this.lastSpeechMs - this.speechStartMs,
              pauseMs: this.silenceRunMs,
              trailingSpeechProb: this.meanTrailingProb(),
            });
            if (
              assessment === "commit" ||
              this.silenceRunMs >= config.hardSilenceMs
            ) {
              events.push(
                this.commit(
                  this.silenceRunMs >= config.hardSilenceMs
                    ? "hard_silence"
                    : "turn_pause"
                )
              );
            }
          }
        }
        // Ambiguous frames (between thresholds) neither extend speech nor
        // count as silence; they simply pass.
        if (
          (this.state === "speaking" || this.state === "candidate_pause") &&
          this.streamMs - this.speechStartMs >= config.maxUtteranceMs
        ) {
          events.push(this.commit("max_length"));
        }
        break;
      }
    }
    return events;
  }

  private meanTrailingProb(): number {
    if (this.recentSpeechProbs.length === 0) return 0;
    const sum = this.recentSpeechProbs.reduce((acc, p) => acc + p, 0);
    return sum / this.recentSpeechProbs.length;
  }

  private commit(reason: CommitReason): EndpointerEvent {
    const { config } = this;
    const speechMs = Math.max(0, this.lastSpeechMs - this.speechStartMs);
    const startMs = Math.max(0, this.speechStartMs - config.preRollMs);
    const endMs =
      reason === "max_length"
        ? this.streamMs
        : Math.min(this.streamMs, this.lastSpeechMs + config.postRollMs);
    this.state = "idle";
    this.silenceRunMs = 0;
    this.armingRunMs = 0;
    this.recentSpeechProbs = [];
    if (speechMs < config.minUtteranceMs) {
      return { type: "speech_cancelled", atMs: this.streamMs };
    }
    return { type: "utterance_committed", reason, startMs, endMs, speechMs };
  }
}
