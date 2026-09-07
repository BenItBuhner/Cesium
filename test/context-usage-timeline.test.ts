import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentContextUsageSegment } from "../packages/core/src/protocol.ts";
import {
  CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY,
  condenseContextTimeline,
  contextTimelineCondenseThreshold,
  describeContextSegmentKind,
  largestContextSegments,
  readStoredContextUsageViewMode,
  writeStoredContextUsageViewMode,
} from "../packages/client/src/context-usage-timeline.ts";

function segment(
  id: string,
  kind: AgentContextUsageSegment["kind"],
  categoryId: AgentContextUsageSegment["categoryId"],
  tokens: number,
  seq: number
): AgentContextUsageSegment {
  return {
    id,
    kind,
    categoryId,
    label: id,
    tokens,
    colorKey: categoryId === "mcp" ? "mcp" : "conversation",
    seqStart: seq,
    seqEnd: seq,
  };
}

describe("condenseContextTimeline", () => {
  const timeline: AgentContextUsageSegment[] = [
    { id: "system_prompt", kind: "system_prompt", categoryId: "system_prompt", label: "System prompt", tokens: 4_000, colorKey: "system" },
    { id: "tool_definitions", kind: "tool_definitions", categoryId: "tool_definitions", label: "Tool definitions", tokens: 9_000, colorKey: "tools" },
    segment("u1", "user_message", "conversation", 40, 1),
    segment("a1", "assistant_message", "conversation", 60, 2),
    segment("t1", "tool_call", "conversation", 12_000, 3),
    segment("t2", "tool_call", "conversation", 80, 4),
    segment("t3", "tool_call", "conversation", 90, 5),
    segment("m1", "tool_call", "mcp", 70, 6),
    segment("c1", "compaction_summary", "summarized_conversation", 3_000, 7),
    segment("u2", "user_message", "conversation", 30, 8),
  ];

  test("keeps large blocks standalone and groups runs of small same-category blocks", () => {
    const rows = condenseContextTimeline(timeline, { minTokens: 500 });
    assert.deepEqual(
      rows.map((row) => row.id),
      [
        "system_prompt",
        "tool_definitions",
        "group:u1:a1",
        "t1",
        "group:t2:t3",
        "m1",
        "c1",
        "u2",
      ]
    );
    const firstGroup = rows[2]!;
    assert.equal(firstGroup.kind, "group");
    assert.equal(firstGroup.count, 2);
    assert.equal(firstGroup.tokens, 100);
    assert.equal(firstGroup.label, "2 conversation blocks");
    assert.equal(firstGroup.detail, "1 user message, 1 assistant reply");
    assert.deepEqual(firstGroup.segmentIds, ["u1", "a1"]);
    assert.equal(firstGroup.seqStart, 1);
    assert.equal(firstGroup.seqEnd, 2);
    // A single small block of a different category never merges into a neighbouring run.
    const mcp = rows[5]!;
    assert.equal(mcp.kind, "tool_call");
    assert.equal(mcp.categoryId, "mcp");
    assert.equal(mcp.count, 1);
  });

  test("preserves chronological order and total tokens", () => {
    const rows = condenseContextTimeline(timeline, { minTokens: 500 });
    const total = timeline.reduce((sum, item) => sum + item.tokens, 0);
    assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), total);
    const starts = rows.map((row) => row.seqStart ?? -1);
    for (let index = 1; index < starts.length; index += 1) {
      assert.ok(starts[index]! >= starts[index - 1]!);
    }
  });

  test("a threshold of zero leaves every block standalone", () => {
    const rows = condenseContextTimeline(timeline, { minTokens: 0 });
    assert.equal(rows.length, timeline.length);
    assert.ok(rows.every((row) => row.count === 1));
  });

  test("threshold scales with the window but never drops below 500 tokens", () => {
    assert.equal(contextTimelineCondenseThreshold(1_000_000), 5_000);
    assert.equal(contextTimelineCondenseThreshold(200_000), 1_000);
    assert.equal(contextTimelineCondenseThreshold(8_000), 500);
    assert.equal(contextTimelineCondenseThreshold(0), 500);
  });

  test("largest blocks surface first", () => {
    assert.deepEqual(
      largestContextSegments(timeline, 3).map((item) => item.id),
      ["t1", "tool_definitions", "system_prompt"]
    );
    assert.deepEqual(largestContextSegments(timeline, 0), []);
  });

  test("segment kinds read as plain English", () => {
    assert.equal(describeContextSegmentKind("tool_call"), "tool call");
    assert.equal(describeContextSegmentKind("tool_call", 3), "tool calls");
    assert.equal(describeContextSegmentKind("assistant_message", 2), "assistant replies");
    assert.equal(describeContextSegmentKind("compaction_summary"), "compaction summary");
  });
});

describe("context usage view mode persistence", () => {
  function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
  }

  test("defaults to pooled and round-trips sequential", () => {
    const storage = memoryStorage();
    assert.equal(readStoredContextUsageViewMode(storage), "pooled");
    writeStoredContextUsageViewMode(storage, "sequential");
    assert.equal(storage.data.get(CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY), "sequential");
    assert.equal(readStoredContextUsageViewMode(storage), "sequential");
  });

  test("ignores garbage and missing storage", () => {
    const storage = memoryStorage();
    storage.data.set(CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY, "sideways");
    assert.equal(readStoredContextUsageViewMode(storage), "pooled");
    assert.equal(readStoredContextUsageViewMode(null), "pooled");
    assert.doesNotThrow(() => writeStoredContextUsageViewMode(null, "sequential"));
    assert.doesNotThrow(() =>
      writeStoredContextUsageViewMode(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        "pooled"
      )
    );
  });
});
