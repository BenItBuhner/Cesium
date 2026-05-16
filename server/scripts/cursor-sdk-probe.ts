import "../src/env-bootstrap.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, Cursor } from "@cursor/sdk";
import {
  cursorSdkDeltaText,
  cursorSdkStatusToAgentStatus,
  cursorSdkTaskText,
  cursorSdkToolEventToAgentEvent,
  planEntriesFromCursorSdkToolPayload,
  textFromCursorSdkAssistantMessage,
} from "../src/lib/agents/cursor-sdk-normalize.js";
import { getCursorSdkApiKey } from "../src/lib/cursor-sdk-credentials.js";
import type { AgentEventInput } from "../src/lib/agents/types.js";

type ProbeArgs = {
  cwd: string;
  model: string;
  scenario: string;
  out: string;
};

const DEFAULT_SCENARIOS: Record<string, string> = {
  basic:
    "Reply with one short sentence, then list exactly two todo items you would create for this tiny repo.",
  read: "Read package.json and summarize the scripts you find.",
  edit:
    "Create or update a file named cursor-sdk-probe-output.txt with a single line saying Cursor SDK probe succeeded.",
  search: "Search this workspace for the string cursor-sdk-probe-output and report matching paths.",
  shell: "Run a harmless command to print the current working directory.",
  question:
    "If you have an ask-question or request-user-input tool available, use it to ask one multiple-choice question. If not, explain that no such tool is exposed.",
  subagent:
    "If subagents are available, start a small subagent to inspect package.json. If unavailable, explain that subagents are not exposed in this environment.",
};

function parseArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cwd" && next) {
      out.cwd = path.resolve(next);
      index += 1;
    } else if (arg === "--model" && next) {
      out.model = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      out.scenario = next;
      index += 1;
    } else if (arg === "--out" && next) {
      out.out = path.resolve(next);
      index += 1;
    }
  }
  const cwd = out.cwd ?? path.join(os.tmpdir(), "cesium-cursor-sdk-probe");
  return {
    cwd,
    model: out.model ?? "composer-2",
    scenario: out.scenario ?? "all",
    out: out.out ?? path.join(cwd, "cursor-sdk-probe-events.jsonl"),
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "cursor-sdk-probe",
        private: true,
        scripts: { test: "node -e \"console.log('probe test ok')\"" },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "README.md"),
    "# Cursor SDK Probe\n\nDisposable workspace for Cesium SDK event schema capture.\n",
    "utf8"
  );
}

function scenarioNames(selected: string): string[] {
  if (selected === "all") {
    return Object.keys(DEFAULT_SCENARIOS);
  }
  if (!DEFAULT_SCENARIOS[selected]) {
    throw new Error(`Unknown scenario: ${selected}`);
  }
  return [selected];
}

function normalizeEventForReport(event: unknown, conversationId: string): AgentEventInput[] {
  if (!event || typeof event !== "object" || !("type" in event)) {
    return [];
  }
  const record = event as { type: string };
  switch (record.type) {
    case "assistant": {
      const text = textFromCursorSdkAssistantMessage(event as never);
      return text
        ? [
            {
              eventId: randomUUID(),
              conversationId,
              kind: "assistant_message_chunk",
              messageId: "probe-assistant",
              text,
              raw: event,
            },
          ]
        : [];
    }
    case "thinking":
      return [
        {
          eventId: randomUUID(),
          conversationId,
          kind: "reasoning",
          messageId: "probe-thinking",
          text: (event as { text?: string }).text ?? "",
          raw: event,
        },
      ];
    case "tool_call": {
      const toolEvent = event as never;
      const normalized = cursorSdkToolEventToAgentEvent({
        event: toolEvent,
        conversationId,
        eventId: randomUUID(),
      });
      const entries = [
        ...planEntriesFromCursorSdkToolPayload((event as { args?: unknown }).args),
        ...planEntriesFromCursorSdkToolPayload((event as { result?: unknown }).result),
      ];
      return entries.length > 0
        ? [
            normalized,
            {
              eventId: randomUUID(),
              conversationId,
              kind: "plan",
              planId: "probe-todos",
              entries,
              raw: event,
            },
          ]
        : [normalized];
    }
    case "status": {
      const status = cursorSdkStatusToAgentStatus(event as never);
      return status
        ? [
            {
              eventId: randomUUID(),
              conversationId,
              kind: "status",
              status,
              detail: (event as { message?: string }).message,
              raw: event,
            },
          ]
        : [];
    }
    case "task": {
      const text = cursorSdkTaskText(event as never);
      return text
        ? [
            {
              eventId: randomUUID(),
              conversationId,
              kind: "system",
              level: "info",
              text,
              raw: event,
            },
          ]
        : [];
    }
    case "system":
    case "user":
    case "request":
      return [];
    default:
      return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);
  const apiKey = await getCursorSdkApiKey();
  if (!apiKey) {
    throw new Error("Set CURSOR_API_KEY or save a Cursor SDK key in Cesium settings.");
  }
  const me = await Cursor.me({ apiKey });
  await appendJsonLine(args.out, {
    type: "probe_start",
    cwd: args.cwd,
    model: args.model,
    apiKeyName: me.apiKeyName,
    userEmail: me.userEmail,
  });
  const agent = await Agent.create({
    apiKey,
    model: { id: args.model },
    local: {
      cwd: args.cwd,
      settingSources: ["project", "user", "plugins"],
      sandboxOptions: { enabled: false },
    },
  });
  try {
    for (const name of scenarioNames(args.scenario)) {
      const conversationId = `probe-${name}`;
      await appendJsonLine(args.out, { type: "scenario_start", name });
      const run = await agent.send(DEFAULT_SCENARIOS[name]!, {
        onDelta: async ({ update }) => {
          const normalized = cursorSdkDeltaText(update);
          await appendJsonLine(args.out, {
            type: "delta",
            scenario: name,
            update,
            normalized,
          });
        },
      });
      for await (const event of run.stream()) {
        await appendJsonLine(args.out, {
          type: "stream",
          scenario: name,
          event,
          normalized: normalizeEventForReport(event, conversationId),
        });
      }
      const result = await run.wait();
      await appendJsonLine(args.out, { type: "scenario_result", name, result });
    }
  } finally {
    await agent[Symbol.asyncDispose]().catch(() => undefined);
  }
  await appendJsonLine(args.out, { type: "probe_end", out: args.out });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
