import test from "node:test";
import assert from "node:assert/strict";
import {
  compactVoiceHistory,
  DEFAULT_VOICE_COMPACTION,
  estimateVoiceTokens,
  summarizeVoiceEntries,
  summaryPromptMessage,
  voiceCompactionConfig,
  type VoiceHistoryEntry,
} from "../src/lib/voice/compaction.js";
import { parseControllerPayload } from "../src/lib/voice/controller.js";

function turns(count: number, contentLength = 40): VoiceHistoryEntry[] {
  const history: VoiceHistoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    history.push({ role: "user", content: `user turn ${i} ${"x".repeat(contentLength)}` });
    history.push({
      role: "assistant",
      content: `assistant reply ${i} ${"y".repeat(contentLength)}`,
    });
  }
  return history;
}

test("no compaction below both thresholds", () => {
  const history = turns(10);
  const result = compactVoiceHistory(null, history);
  assert.equal(result.compacted, false);
  assert.equal(result.history, history);
  assert.equal(result.summary, null);
  assert.equal(result.retainedTurnCount, 10);
});

test("turn-limit trigger keeps the last targetTurns user turns", () => {
  const history = turns(DEFAULT_VOICE_COMPACTION.turnLimit + 5);
  const result = compactVoiceHistory(null, history);
  assert.equal(result.compacted, true);
  const retainedUsers = result.history.filter((entry) => entry.role === "user");
  assert.equal(retainedUsers.length, DEFAULT_VOICE_COMPACTION.targetTurns);
  assert.equal(
    result.compressedTurnCount,
    DEFAULT_VOICE_COMPACTION.turnLimit + 5 - DEFAULT_VOICE_COMPACTION.targetTurns
  );
  // Retained history starts on a user turn and ends with the newest reply.
  assert.equal(result.history[0]!.role, "user");
  assert.match(
    result.history[result.history.length - 1]!.content,
    /assistant reply 44/
  );
  // The summary is a transcript of what got folded.
  assert.ok(result.summary);
  assert.match(result.summary!, /^User: user turn 0/);
});

test("token-threshold trigger fires before the turn limit", () => {
  // 20 turns of very long content: ~20k tokens, above the 6k default.
  const history = turns(20, 2000);
  const result = compactVoiceHistory(null, history);
  assert.equal(result.compacted, true);
  assert.equal(
    result.history.filter((entry) => entry.role === "user").length,
    DEFAULT_VOICE_COMPACTION.targetTurns
  );
  // Long turns genuinely compress: transcript lines truncate at 400 chars.
  assert.ok(result.estimatedTokensAfter < result.estimatedTokensBefore);
});

test("existing summary is preserved and extended", () => {
  const history = turns(DEFAULT_VOICE_COMPACTION.turnLimit + 1);
  const result = compactVoiceHistory("User: ancient context", history);
  assert.ok(result.summary!.startsWith("User: ancient context"));
  assert.match(result.summary!, /user turn 0/);
});

test("summary overflow keeps the tail (most recent context wins)", () => {
  const config = { ...DEFAULT_VOICE_COMPACTION, summaryCharCap: 400 };
  const history = turns(config.turnLimit + 10, 120);
  const result = compactVoiceHistory("User: ancient context", history, config);
  assert.ok(result.summary!.length <= config.summaryCharCap);
  // The oldest content fell off; newer compressed turns survive.
  assert.ok(!result.summary!.includes("ancient context"));
});

test("token estimation is chars/4 like the harness", () => {
  assert.equal(estimateVoiceTokens(null, []), 0);
  assert.equal(
    estimateVoiceTokens("aaaa", [{ role: "user", content: "bbbb" }]),
    2
  );
});

test("summarize + prompt message match the harness format", () => {
  const summary = summarizeVoiceEntries([
    { role: "user", content: "  fix   the\nbug " },
    { role: "assistant", content: "Started an agent." },
  ]);
  assert.equal(summary, "User: fix the bug\nAssistant: Started an agent.");
  assert.equal(
    summaryPromptMessage("S"),
    "[Compressed earlier conversation]\nS"
  );
});

test("compaction env knobs override defaults", () => {
  const config = voiceCompactionConfig({
    OPENCURSOR_VOICE_TURN_LIMIT: "6",
    OPENCURSOR_VOICE_TARGET_TURNS: "3",
    OPENCURSOR_VOICE_TOKEN_THRESHOLD: "999999",
  } as NodeJS.ProcessEnv);
  assert.equal(config.turnLimit, 6);
  assert.equal(config.targetTurns, 3);
  const history = turns(7);
  const result = compactVoiceHistory(null, history, config);
  assert.equal(result.compacted, true);
  assert.equal(result.retainedTurnCount, 3);
  assert.equal(result.compressedTurnCount, 4);
});

test("controller payload parses the open (present session) field", () => {
  const parsed = parseControllerPayload(
    '{"spoken":"Started it.","display":"Started","notify":"speak","confirm":false,"open":"d99ee1bc-aa05-422a-9743-771a55061361"}'
  );
  assert.equal(parsed.open, "d99ee1bc-aa05-422a-9743-771a55061361");
  // Garbage open values are rejected.
  assert.equal(
    parseControllerPayload('{"spoken":"Hi.","open":"x"}').open,
    null
  );
  assert.equal(parseControllerPayload('{"spoken":"Hi."}').open, null);
});
