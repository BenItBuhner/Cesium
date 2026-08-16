import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINTER_CONFIG,
  Endpointer,
  HeuristicTurnDetector,
  type EndpointerEvent,
  type TurnDetector,
} from "../src/lib/voice/endpointing.ts";

const FRAME_MS = DEFAULT_ENDPOINTER_CONFIG.frameMs;

function drive(
  endpointer: Endpointer,
  pattern: Array<{ prob: number; ms: number }>
): EndpointerEvent[] {
  const events: EndpointerEvent[] = [];
  for (const segment of pattern) {
    const frames = Math.round(segment.ms / FRAME_MS);
    for (let i = 0; i < frames; i++) {
      events.push(...endpointer.processFrame(segment.prob));
    }
  }
  return events;
}

test("speech start requires hysteresis; single frames do not trigger", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.9, ms: FRAME_MS }, // one frame of speech: below 80ms hysteresis
    { prob: 0.1, ms: 500 },
  ]);
  assert.equal(events.length, 0);
  assert.equal(endpointer.currentState, "idle");
});

test("sustained speech emits speech_start with pre-roll-eligible timestamp", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.1, ms: 640 },
    { prob: 0.95, ms: 200 },
  ]);
  const start = events.find((event) => event.type === "speech_start");
  assert.ok(start && start.type === "speech_start");
  // Speech began at ~640ms into the stream.
  assert.ok(Math.abs(start.atMs - 640) <= FRAME_MS * 2);
});

test("turn-pause commit includes pre-roll and post-roll bounds", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.05, ms: 640 },
    { prob: 0.95, ms: 1600 }, // long utterance: heuristic commits at 350ms pause
    { prob: 0.05, ms: 2000 },
  ]);
  const commit = events.find((event) => event.type === "utterance_committed");
  assert.ok(commit && commit.type === "utterance_committed");
  assert.equal(commit.reason, "turn_pause");
  // Clip starts pre-roll before speech onset.
  assert.ok(commit.startMs <= 640 - DEFAULT_ENDPOINTER_CONFIG.preRollMs + FRAME_MS);
  assert.ok(commit.startMs >= 640 - DEFAULT_ENDPOINTER_CONFIG.preRollMs - FRAME_MS * 2);
  // Clip ends post-roll after last speech (~2240ms).
  const lastSpeech = 640 + 1600;
  assert.ok(Math.abs(commit.endMs - (lastSpeech + DEFAULT_ENDPOINTER_CONFIG.postRollMs)) <= FRAME_MS * 2);
});

test("hard-silence fallback commits when the detector keeps waiting", () => {
  const alwaysWait: TurnDetector = { assessPause: () => "wait" };
  const endpointer = new Endpointer(DEFAULT_ENDPOINTER_CONFIG, alwaysWait);
  const events = drive(endpointer, [
    { prob: 0.95, ms: 1000 },
    { prob: 0.05, ms: 2500 },
  ]);
  const commit = events.find((event) => event.type === "utterance_committed");
  assert.ok(commit && commit.type === "utterance_committed");
  assert.equal(commit.reason, "hard_silence");
});

test("short blips are cancelled, not committed", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.95, ms: 128 }, // enough for start (80ms) but under min (300ms)
    { prob: 0.05, ms: 2000 },
  ]);
  assert.ok(events.some((event) => event.type === "speech_start"));
  assert.ok(events.some((event) => event.type === "speech_cancelled"));
  assert.ok(!events.some((event) => event.type === "utterance_committed"));
});

test("speech resuming during a candidate pause keeps the utterance open", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.95, ms: 800 },
    { prob: 0.05, ms: 320 }, // candidate pause (short utterance: detector waits)
    { prob: 0.95, ms: 800 }, // resume
    { prob: 0.05, ms: 2000 },
  ]);
  const commits = events.filter((event) => event.type === "utterance_committed");
  assert.equal(commits.length, 1);
  const commit = commits[0]!;
  assert.ok(commit.type === "utterance_committed");
  // Both speech bursts belong to one utterance: speech spans ~1920ms.
  assert.ok(commit.speechMs >= 1800);
});

test("max-length cap commits mid-speech", () => {
  const config = { ...DEFAULT_ENDPOINTER_CONFIG, maxUtteranceMs: 1000 };
  const endpointer = new Endpointer(config);
  const events = drive(endpointer, [{ prob: 0.95, ms: 2000 }]);
  const commit = events.find((event) => event.type === "utterance_committed");
  assert.ok(commit && commit.type === "utterance_committed");
  assert.equal(commit.reason, "max_length");
});

test("long pauses split continuous speech into separate utterances", () => {
  // Two spoken sentences separated by a hard pause must commit as TWO
  // utterances (each round-trips through STT independently), while the
  // trailing silence after each burst stays inside its own clip bounds.
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.05, ms: 640 },
    { prob: 0.95, ms: 1600 }, // sentence one
    { prob: 0.05, ms: 2400 }, // hard pause: well past candidate + hard silence
    { prob: 0.95, ms: 1600 }, // sentence two
    { prob: 0.05, ms: 2400 },
  ]);
  const commits = events.filter((event) => event.type === "utterance_committed");
  assert.equal(commits.length, 2);
  const [first, second] = commits;
  assert.ok(first && first.type === "utterance_committed");
  assert.ok(second && second.type === "utterance_committed");
  // Clips do not overlap: sentence two starts after sentence one ends.
  assert.ok(first.endMs < second.startMs);
  // Each clip covers roughly its 1600ms speech burst plus pre/post roll.
  assert.ok(first.speechMs >= 1400 && first.speechMs <= 1900);
  assert.ok(second.speechMs >= 1400 && second.speechMs <= 1900);
});

test("short mid-sentence pauses do NOT split the utterance", () => {
  const endpointer = new Endpointer();
  const events = drive(endpointer, [
    { prob: 0.05, ms: 640 },
    { prob: 0.95, ms: 900 },
    { prob: 0.05, ms: 256 }, // thinking pause, below commit thresholds
    { prob: 0.95, ms: 900 },
    { prob: 0.05, ms: 2400 },
  ]);
  const commits = events.filter((event) => event.type === "utterance_committed");
  assert.equal(commits.length, 1);
});

test("heuristic turn detector adapts required pause to utterance shape", () => {
  const detector = new HeuristicTurnDetector();
  // Short command, decent pause: commit.
  assert.equal(
    detector.assessPause({ utteranceMs: 400, pauseMs: 320, trailingSpeechProb: 0.7 }),
    "commit"
  );
  // Mid-length utterance with the same pause: wait for more.
  assert.equal(
    detector.assessPause({ utteranceMs: 1200, pauseMs: 320, trailingSpeechProb: 0.7 }),
    "wait"
  );
  // Confident trailing voicing extends the wait.
  assert.equal(
    detector.assessPause({ utteranceMs: 2500, pauseMs: 380, trailingSpeechProb: 0.95 }),
    "wait"
  );
  assert.equal(
    detector.assessPause({ utteranceMs: 2500, pauseMs: 380, trailingSpeechProb: 0.7 }),
    "commit"
  );
});
