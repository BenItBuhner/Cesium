import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PENDING_VOICE_TURNS,
  VoiceTurnEngine,
  type VoiceTurnInput,
  type VoiceTurnStatus,
} from "../src/lib/voice/session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clip(samples = 4): VoiceTurnInput {
  return { kind: "clip", clip: new Float32Array(samples) };
}

async function settle(): Promise<void> {
  // Drains the microtask queue a few times so chained awaits resolve.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

test("clip turn: transcribes then submits, with status transitions", async () => {
  const statuses: VoiceTurnStatus[] = [];
  const heard: Array<{ text: string; sttMs: number | null }> = [];
  const submitted: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => "hello there",
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onStatus: (status) => statuses.push(status),
    onHeard: (text, sttMs) => heard.push({ text, sttMs }),
  });
  engine.start();
  assert.equal(engine.enqueue(clip()), true);
  await settle();
  assert.deepEqual(submitted, ["hello there"]);
  assert.equal(heard.length, 1);
  assert.equal(heard[0]!.text, "hello there");
  assert.ok(typeof heard[0]!.sttMs === "number");
  assert.deepEqual(statuses, ["transcribing", "sending", "idle"]);
});

test("text turn: skips transcription entirely", async () => {
  const submitted: string[] = [];
  const heard: Array<number | null> = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => {
      throw new Error("must not be called");
    },
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onHeard: (_text, sttMs) => heard.push(sttMs),
  });
  engine.start();
  engine.enqueue({ kind: "text", text: "  typed input  " });
  await settle();
  assert.deepEqual(submitted, ["typed input"]);
  assert.deepEqual(heard, [null]);
});

test("inactive engine and empty inputs are rejected", () => {
  const engine = new VoiceTurnEngine({
    transcribe: async () => "x",
    submit: async () => true,
  });
  assert.equal(engine.enqueue(clip()), false);
  engine.start();
  assert.equal(engine.enqueue({ kind: "text", text: "   " }), false);
  assert.equal(engine.enqueue({ kind: "clip", clip: new Float32Array(0) }), false);
});

test("stop aborts in-flight STT and gates every side effect", async () => {
  const stt = deferred<string>();
  let sawAbort = false;
  const submitted: string[] = [];
  const errors: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async (_clip, signal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        stt.reject(new DOMException("Aborted", "AbortError"));
      });
      return stt.promise;
    },
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onError: (message) => errors.push(message),
  });
  engine.start();
  engine.enqueue(clip());
  await settle();
  engine.stop();
  await settle();
  assert.equal(sawAbort, true);
  assert.deepEqual(submitted, []);
  // Aborted turns are silent: no error surfaces after stop.
  assert.deepEqual(errors, []);
  assert.equal(engine.currentStatus, "idle");
});

test("stale STT result resolving after stop is discarded", async () => {
  const stt = deferred<string>();
  const submitted: string[] = [];
  const heard: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => stt.promise,
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onHeard: (text) => heard.push(text),
  });
  engine.start();
  engine.enqueue(clip());
  await settle();
  engine.stop();
  // The fetch settled anyway (e.g. response already in flight).
  stt.resolve("ghost reply");
  await settle();
  assert.deepEqual(submitted, []);
  assert.deepEqual(heard, []);
});

test("restarting after stop bumps the epoch so old turns stay dead", async () => {
  const stt = deferred<string>();
  const submitted: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async (input) =>
      input.length === 4 ? stt.promise : "fresh utterance",
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
  });
  engine.start();
  engine.enqueue(clip(4));
  await settle();
  engine.stop();
  engine.start();
  engine.enqueue(clip(8));
  stt.resolve("stale utterance");
  await settle();
  assert.deepEqual(submitted, ["fresh utterance"]);
});

test("bounded queue drops the oldest pending turn under pressure", async () => {
  const gate = deferred<string>();
  const submitted: string[] = [];
  const dropped: VoiceTurnInput[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => "clip text",
    submit: async (text) => {
      if (text === "first") {
        await gate.promise;
      }
      submitted.push(text);
      return true;
    },
    onTurnDropped: (input) => dropped.push(input),
  });
  engine.start();
  engine.enqueue({ kind: "text", text: "first" });
  await settle();
  // First turn is mid-submit; now overfill the pending queue.
  engine.enqueue({ kind: "text", text: "pending-1" });
  engine.enqueue({ kind: "text", text: "pending-2" });
  engine.enqueue({ kind: "text", text: "pending-3" });
  assert.equal(engine.pendingCount, MAX_PENDING_VOICE_TURNS);
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0], { kind: "text", text: "pending-1" });
  gate.resolve("go");
  await settle();
  assert.deepEqual(submitted, ["first", "pending-2", "pending-3"]);
});

test("stop drops queued turns and reports them", async () => {
  const gate = deferred<string>();
  const dropped: VoiceTurnInput[] = [];
  const submitted: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => "x",
    submit: async (text) => {
      if (text === "first") {
        await gate.promise;
      }
      submitted.push(text);
      return true;
    },
    onTurnDropped: (input) => dropped.push(input),
  });
  engine.start();
  engine.enqueue({ kind: "text", text: "first" });
  await settle();
  engine.enqueue({ kind: "text", text: "queued" });
  engine.stop();
  gate.resolve("go");
  await settle();
  assert.deepEqual(
    dropped.map((input) => (input.kind === "text" ? input.text : "clip")),
    ["queued"]
  );
  // The in-flight submit finished server-side, but no queued replay happened.
  assert.deepEqual(submitted, ["first"]);
});

test("transcribe errors surface once and do not kill the engine", async () => {
  const errors: Array<{ message: string; stage: string }> = [];
  const submitted: string[] = [];
  let calls = 0;
  const engine = new VoiceTurnEngine({
    transcribe: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stt exploded");
      }
      return "second try";
    },
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onError: (message, stage) => errors.push({ message, stage }),
  });
  engine.start();
  engine.enqueue(clip());
  await settle();
  engine.enqueue(clip());
  await settle();
  assert.deepEqual(errors, [{ message: "stt exploded", stage: "transcribe" }]);
  assert.deepEqual(submitted, ["second try"]);
});

test("empty transcription is dropped without submitting", async () => {
  const submitted: string[] = [];
  const heard: string[] = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => "   ",
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    onHeard: (text) => heard.push(text),
  });
  engine.start();
  engine.enqueue(clip());
  await settle();
  assert.deepEqual(submitted, []);
  assert.deepEqual(heard, []);
});

test("submit errors surface with the submit stage", async () => {
  const errors: Array<{ message: string; stage: string }> = [];
  const engine = new VoiceTurnEngine({
    transcribe: async () => "hello",
    submit: async () => {
      throw new Error("conversation gone");
    },
    onError: (message, stage) => errors.push({ message, stage }),
  });
  engine.start();
  engine.enqueue(clip());
  await settle();
  assert.deepEqual(errors, [{ message: "conversation gone", stage: "submit" }]);
});
