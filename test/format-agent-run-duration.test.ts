import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatAgentRunDuration } from "../src/lib/format-agent-run-duration.ts";

describe("formatAgentRunDuration", () => {
  test("formats sub-minute runs as <1m", () => {
    assert.equal(formatAgentRunDuration(0), "<1m");
    assert.equal(formatAgentRunDuration(45_000), "<1m");
  });

  test("formats minutes, hours, and days", () => {
    assert.equal(formatAgentRunDuration(5 * 60_000), "5m");
    assert.equal(formatAgentRunDuration((2 * 60 + 15) * 60_000), "2h 15m");
    assert.equal(
      formatAgentRunDuration(((1 * 24 + 3) * 60 + 2) * 60_000),
      "1d 3h 2m"
    );
  });
});
