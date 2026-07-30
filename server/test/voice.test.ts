import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeWavPcm16,
  floatToPcm16,
  readWavInfo,
} from "../src/lib/voice/wav.js";
import { parseControllerPayload } from "../src/lib/voice/controller.js";
import { lastAssistantText } from "../src/lib/voice/tools.js";
import {
  voiceControllerEnv,
  voiceControllerExtraBody,
} from "../src/lib/voice/voice-env.js";
import { espeakEngine } from "../src/lib/voice/tts/espeak.js";
import { listTtsEngineStatuses } from "../src/lib/voice/tts/registry.js";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

test("wav encode/read round trip", () => {
  const samples = new Float32Array(1600).fill(0.25);
  const wav = encodeWavPcm16(samples, 16000);
  const info = readWavInfo(wav);
  assert.ok(info);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, samples.length * 2);
  assert.ok(Math.abs(info.durationMs - 100) < 1);
});

test("float-to-pcm16 clamps", () => {
  const pcm = floatToPcm16(Float32Array.from([1.5, -1.5, 0]));
  assert.deepEqual(Array.from(pcm), [32767, -32768, 0]);
});

test("controller payload parses strict JSON", () => {
  const parsed = parseControllerPayload(
    '{"spoken":"Two sessions are running.","display":"**2 running**","notify":"speak","confirm":false}'
  );
  assert.equal(parsed.spoken, "Two sessions are running.");
  assert.equal(parsed.display, "**2 running**");
  assert.equal(parsed.notify, "speak");
  assert.equal(parsed.confirm, false);
});

test("controller payload tolerates fences and trailing prose", () => {
  const fenced = parseControllerPayload(
    '```json\n{"spoken":"Started the agent.","display":"Started","notify":"speak","confirm":false}\n```'
  );
  assert.equal(fenced.spoken, "Started the agent.");
  const trailing = parseControllerPayload(
    'Sure! {"spoken":"Okay.","display":"Okay {with braces}","notify":"show","confirm":true} extra words'
  );
  assert.equal(trailing.spoken, "Okay.");
  assert.equal(trailing.display, "Okay {with braces}");
  assert.equal(trailing.notify, "show");
  assert.equal(trailing.confirm, true);
});

test("controller payload falls back to plain text", () => {
  const parsed = parseControllerPayload("Just a plain sentence.");
  assert.equal(parsed.spoken, "Just a plain sentence.");
  assert.equal(parsed.notify, "speak");
});

test("voice env resolves fallback chain", () => {
  const env = {
    CESIUM_BASE_URL: "https://example.com/v1/",
    OPENAI_API_KEY: "sk-test",
  } as NodeJS.ProcessEnv;
  const resolved = voiceControllerEnv(env);
  assert.equal(resolved.baseUrl, "https://example.com/v1");
  assert.equal(resolved.apiKey, "sk-test");
  assert.equal(resolved.model, "glm-5.2");
  const overridden = voiceControllerEnv({
    ...env,
    OPENCURSOR_VOICE_BASE_URL: "https://voice.example.com/v1",
    OPENCURSOR_VOICE_MODEL: "turbo",
  } as NodeJS.ProcessEnv);
  assert.equal(overridden.baseUrl, "https://voice.example.com/v1");
  assert.equal(overridden.model, "turbo");
});

test("voice extra body ignores malformed JSON", () => {
  assert.deepEqual(
    voiceControllerExtraBody({
      OPENCURSOR_VOICE_EXTRA_BODY: "{not json",
    } as NodeJS.ProcessEnv),
    {}
  );
  assert.deepEqual(
    voiceControllerExtraBody({
      OPENCURSOR_VOICE_EXTRA_BODY: '{"temperature":0.1}',
    } as NodeJS.ProcessEnv),
    { temperature: 0.1 }
  );
});

test("lastAssistantText reassembles the trailing assistant message", () => {
  const base = { conversationId: "c", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "e1",
      kind: "assistant_message_chunk",
      messageId: "m1",
      text: "old ",
    },
    {
      ...base,
      seq: 2,
      eventId: "e2",
      kind: "assistant_message_chunk",
      messageId: "m1",
      text: "message",
    },
    {
      ...base,
      seq: 3,
      eventId: "e3",
      kind: "user_message",
      messageId: "u1",
      content: "hi",
    },
    {
      ...base,
      seq: 4,
      eventId: "e4",
      kind: "assistant_message_chunk",
      messageId: "m2",
      text: "The tests ",
    },
    {
      ...base,
      seq: 5,
      eventId: "e5",
      kind: "assistant_message_chunk",
      messageId: "m2",
      text: "pass now.",
    },
  ] as AgentStoredEvent[];
  assert.equal(lastAssistantText(events), "The tests pass now.");
  assert.equal(lastAssistantText([]), null);
});

test("tts engine registry reports statuses; espeak synthesizes when present", async () => {
  const statuses = await listTtsEngineStatuses();
  const ids = statuses.map((status) => status.id);
  assert.deepEqual(
    ids,
    ["piper", "kokoro", "cartesia", "openai-compatible", "espeak"],
    "registry preference order"
  );
  const espeakStatus = statuses.find((status) => status.id === "espeak");
  assert.ok(espeakStatus);
  if (!espeakStatus.available) {
    // Environment without espeak-ng: nothing further to assert here.
    return;
  }
  const result = await espeakEngine.synthesize({
    text: "Cesium voice control plane test.",
  });
  assert.equal(result.engineId, "espeak");
  const info = readWavInfo(result.audio);
  assert.ok(info, "espeak output is a parseable WAV");
  assert.ok(info.durationMs > 400, `expected speech-length audio, got ${info.durationMs}ms`);
});
