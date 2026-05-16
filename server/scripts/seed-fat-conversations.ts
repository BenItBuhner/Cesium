/**
 * Heavy stress seed: long synthetic chats with *dense* tool traffic (bursts before the first
 * assistant chunk and large clusters between every assistant chunk), plus reasoning/plans.
 * Wipes prior runs (titles starting with "Stress seed") unless --skip-wipe.
 *
 * Bun: bun scripts/seed-fat-conversations.ts (from server/)
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { AGENT_BACKENDS } from "../src/lib/agents/providers.js";
import {
  appendConversationEvents,
  createConversationId,
  deleteConversationFromStore,
  listWorkspaceConversationRecords,
  saveConversationRecord,
} from "../src/lib/agents/session-store.js";
import type { AgentConversationRecord, AgentEventInput } from "../src/lib/agents/types.js";
import { ensureDataDir } from "../src/lib/persistence.js";
import { listWorkspaces } from "../src/lib/workspace-registry.js";

const backend = AGENT_BACKENDS["cursor-acp"];
const STRESS_TITLE_PREFIX = "Stress seed";

/** Rich turns per chat — same marathon depth as the legacy megascript, now tool-dense. */
const DEFAULT_TURNS = 3500;
const DEFAULT_CONVERSATIONS = 30;
const FLUSH_EVENT_THRESHOLD = 4000;

function parseArgs() {
  const raw = process.argv.slice(2);
  const out = {
    match: ["cesium", "polysaturate", "bot"] as string[],
    conversations: DEFAULT_CONVERSATIONS,
    turns: DEFAULT_TURNS,
    dryRun: false,
    skipWipe: false,
    wipeOnly: false,
  };
  for (const a of raw) {
    if (a === "--help" || a === "-h") {
      console.log(`Usage: bun scripts/seed-fat-conversations.ts [options]

  --match=a,b           Workspace name/root substrings (default: cesium,polysaturate,bot)
  --conversations=N    Per workspace (default ${DEFAULT_CONVERSATIONS})
  --turns=N            Rich turns per chat (default ${DEFAULT_TURNS}; each turn is tool-dense)
  --skip-wipe          Keep existing "Stress seed …" conversations
  --wipe-only          Delete all "Stress seed …" conversations in every workspace and exit
  --dry-run            Plan only
`);
      process.exit(0);
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--skip-wipe") {
      out.skipWipe = true;
      continue;
    }
    if (a === "--wipe-only") {
      out.wipeOnly = true;
      continue;
    }
    const m = a.match(/^--match=(.+)$/);
    if (m) {
      out.match = m[1]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    const c = a.match(/^--conversations=(\d+)$/);
    if (c) {
      out.conversations = Math.max(1, Number(c[1]));
      continue;
    }
    const t = a.match(/^--turns=(\d+)$/);
    if (t) {
      out.turns = Math.max(1, Number(t[1]));
      continue;
    }
    console.error("Unknown argument:", a);
    process.exit(1);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fatParagraph(seed: string, turn: number, part: number): string {
  const filler =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";
  return `${seed} · t${turn} · p${part} · ${filler.repeat(10).trim()}`;
}

const TOOL_KINDS = [
  "read",
  "write",
  "search",
  "grep",
  "bash",
  "terminal",
  "edit",
  "list_dir",
  "glob",
  "apply_patch",
  "codebase_search",
  "delete_file",
  "mkdir",
  "rename",
  "http_fetch",
  "mcp_call",
  "npm",
  "pnpm",
  "git_status",
  "git_diff",
  "git_log",
  "git_checkout",
  "docker",
  "sqlite",
  "format",
  "lint",
  "test",
  "typecheck",
  "bundle_analyze",
  "env",
  "dotenv_load",
  "ripgrep_files",
  "ast_grep",
  "tree_sitter_query",
  "symbol_find_refs",
  "notebook_run_cell",
  "image_read",
  "pdf_extract",
  "csv_query",
  "json_schema_validate",
  "openapi_fetch",
  "redis_get",
  "postgres_query",
] as const;

const TOOL_TITLES: Record<(typeof TOOL_KINDS)[number], string> = {
  read: "Read file",
  write: "Write file",
  search: "Semantic / embedding search",
  grep: "Ripgrep content search",
  bash: "Shell command",
  terminal: "PTY session",
  edit: "Str replace edit",
  list_dir: "List directory",
  glob: "Glob files",
  apply_patch: "Unified diff apply",
  codebase_search: "Codebase-wide symbol search",
  delete_file: "Delete path",
  mkdir: "Create directory",
  rename: "Move / rename",
  http_fetch: "HTTP request",
  mcp_call: "MCP tool invoke",
  npm: "npm exec",
  pnpm: "pnpm run",
  git_status: "git status",
  git_diff: "git diff",
  git_log: "git log",
  git_checkout: "git checkout",
  docker: "docker compose",
  sqlite: "sqlite query",
  format: "Formatter",
  lint: "ESLint / Ruff",
  test: "Test runner",
  typecheck: "tsc --noEmit",
  bundle_analyze: "Bundle analyzer",
  env: "Read env",
  dotenv_load: "Load .env",
  ripgrep_files: "Files-with-matches mode",
  ast_grep: "AST pattern match",
  tree_sitter_query: "Tree-sitter query",
  symbol_find_refs: "Find references",
  notebook_run_cell: "Jupyter cell",
  image_read: "Vision decode",
  pdf_extract: "PDF text extract",
  csv_query: "CSV filter",
  json_schema_validate: "JSON schema check",
  openapi_fetch: "OpenAPI pull",
  redis_get: "Redis GET",
  postgres_query: "PostgreSQL query",
};

const SAMPLE_PATHS = [
  "src/index.ts",
  "server/src/lib/agents/session-store.ts",
  "server/scripts/seed-fat-conversations.ts",
  "package.json",
  "src/components/chat/MessageList.tsx",
  "src/lib/agent-chat.ts",
  "README.md",
  "server/src/lib/agents/types.ts",
  "src/contexts/WorkspaceContext.tsx",
  "docker-compose.yml",
  "vitest.config.ts",
  "eslint.config.js",
  "tsconfig.json",
  "src/app/layout.tsx",
  "server/src/lib/persistence.ts",
  "pnpm-lock.yaml",
  ".env.example",
  "scripts/migrate.sql",
  "tests/e2e/chat.spec.ts",
];

/**
 * ~20× prior per-turn tool volume: one big burst before the assistant streams, then another
 * cluster after every assistant chunk (mirrors “think → tools → speak → tools → speak …”).
 */
const PRE_STREAM_TOOLS_MIN = 14;
const PRE_STREAM_TOOLS_SPREAD = 22;
const BETWEEN_CHUNK_TOOLS_MIN = 10;
const BETWEEN_CHUNK_TOOLS_SPREAD = 22;

function pushSyntheticToolLifecycle(
  out: AgentEventInput[],
  conversationId: string,
  rand: () => number,
  turn: number,
  burstLabel: string,
  toolIndex: number,
  label: string
): void {
  const toolCallId = randomUUID();
  const tk = TOOL_KINDS[Math.floor(rand() * TOOL_KINDS.length)]!;
  const pathLabel = SAMPLE_PATHS[Math.floor(rand() * SAMPLE_PATHS.length)]!;
  const line = 1 + Math.floor(rand() * 620);
  const shortDetail = `${tk} · ${pathLabel}:${line} · ${burstLabel}-u${toolIndex}`;

  out.push({
    eventId: randomUUID(),
    conversationId,
    kind: "tool_call",
    toolCallId,
    title: `${TOOL_TITLES[tk]} — ${pathLabel}`,
    toolKind: tk,
    status: "pending",
    detail: `Queued ${shortDetail}`,
    locations: [{ path: pathLabel, line }],
  });

  const streamStages = rand() < 0.72 ? 1 : 2;
  for (let s = 0; s < streamStages; s++) {
    if (rand() < 0.82) {
      out.push({
        eventId: randomUUID(),
        conversationId,
        kind: "tool_call_update",
        toolCallId,
        status: "in_progress",
        detail:
          s === 0
            ? `Spawning · ${shortDetail}\n\`\`\`text\n${fatParagraph(`${label}-tool-${burstLabel}`, turn, toolIndex * 10 + s).slice(0, 520)}\n\`\`\``
            : `Streaming chunk ${s + 1}…`,
      });
    }
  }

  if (rand() < 0.09) {
    out.push({
      eventId: randomUUID(),
      conversationId,
      kind: "tool_call_update",
      toolCallId,
      status: "in_progress",
      detail: "Backpressure · flushing stderr ring buffer…",
    });
  }

  const roll = rand();
  const ok = roll < 0.78;
  const cancelled = !ok && roll < 0.86;
  out.push({
    eventId: randomUUID(),
    conversationId,
    kind: "tool_call_update",
    toolCallId,
    status: ok ? "completed" : cancelled ? "cancelled" : "failed",
    detail: ok
      ? `Done · ${400 + Math.floor(rand() * 12000)}b · ${pathLabel}`
      : cancelled
        ? `Cancelled (${tk}) — user stopped tool storm`
        : `Tool ${tk} failed: non-zero exit (mock)`,
  });
}

function pushToolBurst(
  out: AgentEventInput[],
  conversationId: string,
  rand: () => number,
  turn: number,
  burstLabel: string,
  count: number,
  label: string
): void {
  for (let i = 0; i < count; i++) {
    pushSyntheticToolLifecycle(out, conversationId, rand, turn, burstLabel, i, label);
  }
}

function buildRichTurn(
  conversationId: string,
  turn: number,
  label: string,
  rand: () => number
): AgentEventInput[] {
  const out: AgentEventInput[] = [];
  const assistantMessageId = randomUUID();

  const userParts = 4 + Math.floor(rand() * 8);
  const userChunks: string[] = [];
  for (let p = 0; p < userParts; p++) {
    userChunks.push(fatParagraph(`${label}-user`, turn, p));
  }
  out.push({
    eventId: randomUUID(),
    conversationId,
    kind: "user_message",
    messageId: randomUUID(),
    content: userChunks.join("\n\n"),
  });

  if (rand() < 0.44) {
    out.push({
      eventId: randomUUID(),
      conversationId,
      kind: "reasoning",
      messageId: randomUUID(),
      text:
        `Reasoning (turn ${turn}): plan a dense tool graph (reads → transforms → writes), watch for pagination churn, cap worst-case trace sizes.\n\n` +
        fatParagraph(`${label}-reason`, turn, 0),
    });
  }

  const preStreamTools = PRE_STREAM_TOOLS_MIN + Math.floor(rand() * PRE_STREAM_TOOLS_SPREAD);
  pushToolBurst(out, conversationId, rand, turn, "pre", preStreamTools, label);

  const streamChunks = 3 + Math.floor(rand() * 9);
  for (let si = 0; si < streamChunks; si++) {
    out.push({
      eventId: randomUUID(),
      conversationId,
      kind: "assistant_message_chunk",
      messageId: assistantMessageId,
      text:
        (si > 0 ? "\n\n" : "") +
        fatParagraph(`${label}-assistant`, turn * 97 + si, si),
    });

    if (si < streamChunks - 1) {
      const between =
        BETWEEN_CHUNK_TOOLS_MIN + Math.floor(rand() * BETWEEN_CHUNK_TOOLS_SPREAD);
      pushToolBurst(out, conversationId, rand, turn, `gap${si}`, between, label);
    }
  }

  out.push({
    eventId: randomUUID(),
    conversationId,
    kind: "assistant_message_end",
    messageId: assistantMessageId,
    stopReason: "end_turn",
  });

  if (rand() < 0.07) {
    out.push({
      eventId: randomUUID(),
      conversationId,
      kind: "plan",
      planId: randomUUID(),
      entries: [
        {
          id: `p-${turn}-1`,
          content: "Validate tail window against fixture transcripts",
          status: "completed",
        },
        {
          id: `p-${turn}-2`,
          content: "Soften layout thrash under 10k+ events",
          status: "in_progress",
        },
        {
          id: `p-${turn}-3`,
          content: "Add chunked flush integration test",
          status: "pending",
        },
      ],
    });
  }

  if (rand() < 0.03) {
    out.push({
      eventId: randomUUID(),
      conversationId,
      kind: "system",
      level: rand() < 0.85 ? "info" : "warning",
      text: `[checkpoint] turn ${turn}: persisted snapshot (mock).`,
    });
  }

  return out;
}

function createBlankRecord(workspaceId: string, title: string): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: createConversationId(),
    workspaceId,
    title,
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: backend.id,
      mode: backend.defaultMode,
      modelId: backend.defaultModelId,
      modelName: backend.defaultModelName,
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    lastError: null,
    experimental: Boolean(backend.experimental),
    archivedAt: null,
    lastReadSeq: 0,
  };
}

function findWorkspacesByMatchers(
  workspaces: Awaited<ReturnType<typeof listWorkspaces>>,
  matchers: string[]
): Map<string, (typeof workspaces)[0]> {
  const picked = new Map<string, (typeof workspaces)[0]>();
  for (const sub of matchers) {
    const hit = workspaces.find((w) => {
      const name = w.name.toLowerCase();
      const root = w.root.toLowerCase();
      const base = basename(w.root).toLowerCase();
      return name.includes(sub) || root.includes(sub) || base.includes(sub);
    });
    if (hit) {
      picked.set(hit.id, hit);
    } else {
      console.warn(`No workspace matched substring "${sub}" (check name or root path).`);
    }
  }
  return picked;
}

async function wipeStressSeeds(): Promise<number> {
  let removed = 0;
  const workspaces = await listWorkspaces();
  for (const ws of workspaces) {
    const convs = await listWorkspaceConversationRecords(ws.id);
    for (const c of convs) {
      if (c.title.startsWith(STRESS_TITLE_PREFIX)) {
        await deleteConversationFromStore(ws.id, c.id);
        removed += 1;
      }
    }
  }
  return removed;
}

async function main() {
  const opts = parseArgs();
  await ensureDataDir();

  if (opts.wipeOnly) {
    if (opts.dryRun) {
      const workspaces = await listWorkspaces();
      let would = 0;
      for (const ws of workspaces) {
        const convs = await listWorkspaceConversationRecords(ws.id);
        for (const c of convs) {
          if (c.title.startsWith(STRESS_TITLE_PREFIX)) {
            would += 1;
          }
        }
      }
      console.log(`Dry-run: would remove ${would} "${STRESS_TITLE_PREFIX} …" conversations.`);
      process.exit(0);
    }
    const n = await wipeStressSeeds();
    console.log(`Removed ${n} "${STRESS_TITLE_PREFIX} …" conversations from all workspaces.`);
    process.exit(0);
  }

  const workspaces = await listWorkspaces();
  const targets = findWorkspacesByMatchers(workspaces, opts.match);

  if (targets.size === 0) {
    console.error("No workspaces matched. Known workspaces:");
    for (const w of workspaces) {
      console.error(`  - ${w.name}  (${w.root})  id=${w.id}`);
    }
    process.exit(1);
  }

  const targetNames = [...targets.values()].map((w) => w.name).join(", ");
  console.log(
    `Targets: ${targetNames}\n${opts.conversations} chats / workspace · ${opts.turns} rich turns each · tool-heavy synthetic events`
  );

  if (opts.dryRun) {
    process.exit(0);
  }

  if (!opts.skipWipe) {
    const n = await wipeStressSeeds();
    console.log(`Removed ${n} prior "${STRESS_TITLE_PREFIX} …" conversations from all workspaces.`);
  }

  let convCreated = 0;
  let eventsAppended = 0;

  for (const ws of targets.values()) {
    const seedTag = basename(ws.root).slice(0, 24) || ws.name;
    for (let c = 0; c < opts.conversations; c += 1) {
      const day = new Date().toISOString().slice(0, 10);
      const title = `${STRESS_TITLE_PREFIX} · deep · ${convCreated + 1} · ${seedTag} · ${day}`;
      const record = createBlankRecord(ws.id, title);
      await saveConversationRecord(record);
      convCreated += 1;

      const rand = mulberry32((c + 1) * 977 * opts.turns + ws.id.length);
      const batch: AgentEventInput[] = [];
      let eventsThisConv = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await appendConversationEvents(ws.id, record.id, batch);
        eventsAppended += batch.length;
        eventsThisConv += batch.length;
        batch.length = 0;
      };

      const logEvery = Math.max(200, Math.floor(opts.turns / 20));
      for (let turn = 0; turn < opts.turns; turn += 1) {
        batch.push(
          ...buildRichTurn(record.id, turn, `${seedTag}-c${c}-t${turn}`, rand)
        );
        if (batch.length >= FLUSH_EVENT_THRESHOLD) {
          await flush();
        }
        if (turn > 0 && turn % logEvery === 0) {
          process.stdout.write(`  ${ws.name} #${convCreated}: ${turn}/${opts.turns} turns\r`);
        }
      }
      await flush();
      console.log(
        `  ${ws.name}: ${title.slice(0, 72)}… id=${record.id} · ${eventsThisConv} events`
      );
    }
  }

  console.log(
    `\nDone. ${convCreated} new conversations · ${eventsAppended} events total. Reload the app / agent rail.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
