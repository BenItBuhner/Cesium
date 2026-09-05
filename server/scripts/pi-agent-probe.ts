import "../src/env-bootstrap.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_BACKENDS } from "../src/lib/agents/providers.js";
import { createPiAgentProvider } from "../src/lib/agents/pi-agent-provider.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import { buildPiAgentSeedConfigOptions } from "../src/lib/pi-agent-model-catalog.js";
import { describePiAgentHome } from "../src/lib/pi-agent-settings.js";

/**
 * Live smoke test for the Pi Agent harness. Drives the real `pi-agent`
 * provider (not the raw SDK) with in-memory runtime callbacks, so it exercises
 * event normalization, extension UI bridging, the approval gate, and session
 * persistence exactly as the server does.
 *
 *   npm run sdk:pi-probe -- --prompt "List the files here" [--model provider/id]
 *     [--cwd DIR] [--out FILE.jsonl] [--resume SESSION.jsonl]
 *     [--approval pi|mutations|all] [--answer-permission allow_once|reject_once|cancel]
 *     [--answer-question TEXT] [--cancel-after-ms N]
 *
 * Credentials come from the active Pi agent home (auth.json, models.json),
 * Cesium settings, or provider env vars - same as a real conversation.
 */

type ProbeArgs = {
  cwd: string;
  out: string;
  prompts: string[];
  model?: string;
  resume?: string;
  approval?: string;
  answerPermission: string;
  answerQuestion: string;
  cancelAfterMs?: number;
};

function parseArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> & { prompts: string[] } = { prompts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const take = (): string => {
      index += 1;
      return next ?? "";
    };
    switch (arg) {
      case "--cwd":
        out.cwd = path.resolve(take());
        break;
      case "--out":
        out.out = path.resolve(take());
        break;
      case "--prompt":
        out.prompts.push(take());
        break;
      case "--model":
        out.model = take();
        break;
      case "--resume":
        out.resume = take();
        break;
      case "--approval":
        out.approval = take();
        break;
      case "--answer-permission":
        out.answerPermission = take();
        break;
      case "--answer-question":
        out.answerQuestion = take();
        break;
      case "--cancel-after-ms":
        out.cancelAfterMs = Number(take());
        break;
      default:
        break;
    }
  }
  const cwd = out.cwd ?? path.join(os.tmpdir(), "cesium-pi-agent-probe");
  return {
    cwd,
    out: out.out ?? path.join(cwd, "pi-agent-probe-events.jsonl"),
    prompts:
      out.prompts.length > 0
        ? out.prompts
        : ["List the files in the current directory using a tool, then summarize them in one sentence."],
    model: out.model,
    resume: out.resume,
    approval: out.approval,
    answerPermission: out.answerPermission ?? "allow_once",
    answerQuestion: out.answerQuestion ?? "yes",
    cancelAfterMs: out.cancelAfterMs,
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "README.md"),
    "# Pi Agent Probe\n\nDisposable workspace for Pi harness smoke tests. The magic number is 42.\n",
    "utf8"
  );
}

function summarizeEvent(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "assistant_message_chunk":
      return `text  ${JSON.stringify(event.text)}`;
    case "reasoning":
      return `think ${JSON.stringify(event.text.slice(0, 60))}`;
    case "tool_call":
    case "tool_call_update":
      return `${event.kind === "tool_call" ? "tool " : "tool~"} ${event.status.padEnd(11)} ${event.title ?? ""}${
        event.detail ? ` :: ${event.detail.replace(/\s+/g, " ").slice(0, 100)}` : ""
      }`;
    case "permission_request":
      return `perm? ${event.title ?? ""} [${event.options.map((option) => option.optionId).join(", ")}]`;
    case "permission_resolved":
      return `perm= ${event.outcome} ${event.optionId ?? ""}`;
    case "question":
      return `ask   ${event.status} ${event.prompt} ${event.answer ? `=> ${JSON.stringify(event.answer)}` : ""}`;
    case "system":
      return `sys   [${event.level}] ${event.text}`;
    case "status":
      return `state ${event.status}${event.detail ? ` (${event.detail})` : ""}`;
    case "compression_summary":
      return `pack  ${event.summary.slice(0, 80)}`;
    case "user_message":
      return `user  ${JSON.stringify(event.content.slice(0, 80))}`;
    default:
      return event.kind;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);

  const home = await describePiAgentHome();
  console.log(`[pi-probe] agent home: ${home.agentDir} (${home.agentHome}${home.usesEnvOverride ? ", env override" : ""})`);

  const seedOptions = await buildPiAgentSeedConfigOptions();
  const modelOption = seedOptions.find((option) => option.id === "model");
  const modelId = args.model ?? modelOption?.currentValue ?? "auto";
  console.log(
    `[pi-probe] models: ${modelOption?.options.map((option) => option.value).join(", ") || "(none)"}`
  );
  console.log(`[pi-probe] using model: ${modelId}`);

  let seq = 0;
  const stored: AgentStoredEvent[] = [];
  let handle: AgentSessionHandle | null = null;

  const conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `pi-probe-${randomUUID().slice(0, 8)}`,
    workspaceId: "pi-probe-workspace",
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "pi-agent", mode: "agent", modelId, modelName: modelId },
    providerSessionId: args.resume ?? null,
    configOptions: [],
    capabilities: AGENT_BACKENDS["pi-agent"].capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };

  const autoAnswer = (event: AgentStoredEvent): void => {
    if (event.kind === "permission_request") {
      setTimeout(() => {
        void handle?.answerPermission(
          args.answerPermission === "cancel"
            ? { requestId: event.requestId, cancelled: true }
            : { requestId: event.requestId, optionId: args.answerPermission }
        );
      }, 300);
    }
    if (event.kind === "question" && event.status === "pending") {
      setTimeout(() => {
        void handle?.answerQuestion?.({
          questionId: event.questionId,
          answer: `${event.prompt}: ${args.answerQuestion}`,
        });
      }, 300);
    }
  };

  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "pi-probe-workspace",
      name: "pi-probe",
      root: args.cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (events: AgentEventInput[]) => {
      const rows: AgentStoredEvent[] = [];
      for (const event of events) {
        seq += 1;
        const row = { ...event, seq, createdAt: event.createdAt ?? Date.now() } as AgentStoredEvent;
        stored.push(row);
        rows.push(row);
        const { raw: _raw, ...rest } = row as Record<string, unknown>;
        await appendJsonLine(args.out, { type: "event", event: rest });
        if (row.kind !== "reasoning") {
          console.log(`  ${summarizeEvent(row)}`);
        }
        autoAnswer(row);
      }
      return rows;
    },
    readSnapshot: async () => ({ conversation: callbacks.conversation, events: stored }),
    updateConversation: async (patch) => {
      const next =
        typeof patch === "function"
          ? patch(callbacks.conversation)
          : { ...callbacks.conversation, ...patch };
      if (next.status !== callbacks.conversation.status) {
        console.log(`  conv  status=${next.status}${next.lastError ? ` lastError=${JSON.stringify(next.lastError)}` : ""}`);
      }
      callbacks.conversation = next;
      await appendJsonLine(args.out, {
        type: "conversation",
        status: next.status,
        modelId: next.config.modelId,
        providerSessionId: next.providerSessionId,
        lastError: next.lastError,
      });
      return next;
    },
  };

  const provider = createPiAgentProvider({
    backend: AGENT_BACKENDS["pi-agent"],
    configOptions: seedOptions,
  });
  handle = args.resume
    ? await provider.loadSession(callbacks, args.resume)
    : await provider.startSession(callbacks);
  console.log(`[pi-probe] session: ${handle.sessionId}`);
  console.log(`[pi-probe] model in use: ${callbacks.conversation.config.modelId}`);

  if (args.approval) {
    await handle.setConfigOption("tool_approval", args.approval);
  }

  for (const prompt of args.prompts) {
    console.log(`\n[pi-probe] prompt: ${prompt}`);
    const run = handle.prompt({ text: prompt, userMessageId: randomUUID() });
    if (args.cancelAfterMs && args.cancelAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.cancelAfterMs));
      console.log("[pi-probe] cancelling…");
      await handle.cancel();
    }
    try {
      await run;
    } catch (error) {
      console.log(`[pi-probe] prompt threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const text = stored
    .filter((event): event is Extract<AgentStoredEvent, { kind: "assistant_message_chunk" }> => event.kind === "assistant_message_chunk")
    .map((event) => event.text)
    .join("");
  console.log(`\n[pi-probe] final status: ${callbacks.conversation.status}`);
  console.log(`[pi-probe] assistant text: ${text.slice(0, 400)}`);
  console.log(`[pi-probe] resume with: --resume ${callbacks.conversation.providerSessionId}`);
  console.log(`[pi-probe] events written to ${args.out}`);
  await handle.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
