import assert from "node:assert/strict";

import { describe, test } from "node:test";

import {

  computeContextUsageRefreshGeneration,

  CONTEXT_USAGE_RESPONSES_PER_REFRESH,

  CONTEXT_USAGE_TOOL_RESULTS_PER_REFRESH,

} from "../src/lib/context-usage-refresh.ts";

import type { AgentStoredEvent } from "../src/lib/agent-types.ts";



const base = {

  conversationId: "c1",

  eventId: "e",

  createdAt: 1,

};



describe("context usage refresh generation", () => {

  test("bumps every two assistant completions by default", () => {

    const events: AgentStoredEvent[] = [

      {

        ...base,

        kind: "assistant_message_end",

        messageId: "a1",

        seq: 1,

        eventId: "e1",

      },

      {

        ...base,

        kind: "assistant_message_end",

        messageId: "a2",

        seq: 2,

        eventId: "e2",

        createdAt: 2,

      },

      {

        ...base,

        kind: "assistant_message_end",

        messageId: "a3",

        seq: 3,

        eventId: "e3",

        createdAt: 3,

      },

    ];

    assert.equal(computeContextUsageRefreshGeneration(events), 1);

    assert.equal(computeContextUsageRefreshGeneration(events.slice(0, 1)), 0);

    assert.equal(CONTEXT_USAGE_RESPONSES_PER_REFRESH, 2);

  });



  test("bumps on each completed or failed tool result", () => {

    const events: AgentStoredEvent[] = [

      {

        ...base,

        kind: "tool_call_update",

        toolCallId: "t1",

        status: "completed",

        seq: 1,

        eventId: "e1",

      },

      {

        ...base,

        kind: "tool_call_update",

        toolCallId: "t2",

        status: "failed",

        seq: 2,

        eventId: "e2",

        createdAt: 2,

      },

      {

        ...base,

        kind: "tool_call_update",

        toolCallId: "t3",

        status: "running",

        seq: 3,

        eventId: "e3",

        createdAt: 3,

      },

    ];

    assert.equal(computeContextUsageRefreshGeneration(events), 2);

    assert.equal(CONTEXT_USAGE_TOOL_RESULTS_PER_REFRESH, 1);

  });



  test("combines assistant and tool refresh units", () => {

    const events: AgentStoredEvent[] = [

      {

        ...base,

        kind: "assistant_message_end",

        messageId: "a1",

        seq: 1,

        eventId: "e1",

      },

      {

        ...base,

        kind: "tool_call_update",

        toolCallId: "t1",

        status: "completed",

        seq: 2,

        eventId: "e2",

        createdAt: 2,

      },

    ];

    assert.equal(computeContextUsageRefreshGeneration(events), 1);

  });

});

