import assert from "node:assert/strict";
import test from "node:test";
import { buildCesiumModeReminder } from "../src/lib/agents/cesium-mode-reminders.js";
import {
  CESIUM_TIME_GAP_REMINDER_MS,
  cesiumEnvironmentChangeNotice,
  formatCesiumDateLabel,
  formatCesiumTimeGapDuration,
  mcpReminderChangeNotice,
  mcpReminderSnapshot,
} from "../src/lib/agents/cesium/cesium-environment-reminders.js";

test("formatCesiumDateLabel accepts an IANA timezone", () => {
  const label = formatCesiumDateLabel(Date.UTC(2026, 6, 28, 7, 0, 0), "America/Los_Angeles");
  assert.match(label, /2026/);
  assert.match(label, /Pacific|PDT|GMT-7|a\.m\.|p\.m\.|AM|PM/i);
});

test("cesiumEnvironmentChangeNotice emits model switch notices", () => {
  const notice = cesiumEnvironmentChangeNotice({
    previous: {
      dateMs: Date.now(),
      dateLabel: "earlier",
      modelId: "anthropic/claude-sonnet-4-5",
      modelName: "Anthropic/Claude Sonnet 4.5",
    },
    current: {
      dateMs: Date.now(),
      dateLabel: "now",
      modelId: "anthropic/claude-opus-5",
      modelName: "Anthropic/Claude Opus 5",
    },
  });
  assert.ok(notice);
  assert.match(notice!, /switched the active model/i);
  assert.match(notice!, /Claude Sonnet 4\.5/);
  assert.match(notice!, /Claude Opus 5/);
});

test("cesiumEnvironmentChangeNotice emits time-gap notices only after a full day", () => {
  const now = Date.UTC(2026, 6, 28, 18, 0, 0);
  const previousAt = now - CESIUM_TIME_GAP_REMINDER_MS - 60_000;
  const notice = cesiumEnvironmentChangeNotice({
    previous: {
      dateMs: previousAt,
      dateLabel: "Sunday, July 27, 2026 at 5:59 PM",
      modelId: "openai/gpt-5.1",
      modelName: "OpenAI/GPT 5.1",
    },
    current: {
      dateMs: now,
      dateLabel: formatCesiumDateLabel(now, "UTC"),
      timeZone: "UTC",
      modelId: "openai/gpt-5.1",
      modelName: "OpenAI/GPT 5.1",
    },
    previousUserMessageAt: previousAt,
  });
  assert.ok(notice);
  assert.match(notice!, /full day or more has passed/i);
  assert.match(notice!, /UTC/);

  // Same-day / multi-hour gaps stay quiet - these notices are intentionally rare.
  assert.equal(
    cesiumEnvironmentChangeNotice({
      previous: {
        dateMs: now - 12 * 60 * 60 * 1000,
        modelId: "openai/gpt-5.1",
        modelName: "OpenAI/GPT 5.1",
      },
      current: {
        dateMs: now,
        modelId: "openai/gpt-5.1",
        modelName: "OpenAI/GPT 5.1",
      },
      previousUserMessageAt: now - 12 * 60 * 60 * 1000,
    }),
    null
  );
  assert.equal(
    cesiumEnvironmentChangeNotice({
      previous: {
        dateMs: now - 60_000,
        modelId: "openai/gpt-5.1",
        modelName: "OpenAI/GPT 5.1",
      },
      current: {
        dateMs: now,
        modelId: "openai/gpt-5.1",
        modelName: "OpenAI/GPT 5.1",
      },
      previousUserMessageAt: now - 60_000,
    }),
    null
  );
});

test("formatCesiumTimeGapDuration summarizes multi-day gaps", () => {
  assert.match(formatCesiumTimeGapDuration(26 * 60 * 60 * 1000), /1 day/);
  assert.match(formatCesiumTimeGapDuration(50 * 60 * 60 * 1000), /2 days/);
});

test("mcpReminderChangeNotice no longer fires on every dateLabel tick", () => {
  const previous = mcpReminderSnapshot({
    revision: 1,
    dateLabel: "Monday",
    summaries: [],
  });
  const current = mcpReminderSnapshot({
    revision: 1,
    dateLabel: "Tuesday",
    summaries: [],
  });
  assert.equal(mcpReminderChangeNotice(previous, current), null);
});

test("buildCesiumModeReminder includes environment change notices and model", () => {
  const reminder = buildCesiumModeReminder({
    mode: "agent",
    modelName: "Anthropic/Claude Opus 5",
    workspaceRoot: "/tmp/workspace",
    dateLabel: "Tuesday, July 28, 2026 at 12:00 AM",
    gitSummary: "main clean",
    mcpSummaries: [],
    environmentChangeNotice:
      "- The user switched the active model from Anthropic/Claude Sonnet 4.5 to Anthropic/Claude Opus 5. You are now Anthropic/Claude Opus 5.",
  });
  assert.match(reminder, /Model: Anthropic\/Claude Opus 5/);
  assert.match(reminder, /Environment Changes Since Last Turn/);
  assert.match(reminder, /switched the active model/);
});
