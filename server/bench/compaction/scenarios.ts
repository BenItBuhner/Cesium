/**
 * Deterministic benchmark scenarios: long synthetic agentic conversations with
 * planted "memory probes" — facts whose answers live in spans that compaction
 * will evict. Probe recall after (multiple generations of) compaction measures
 * exactly how lossy each strategy is, per information category.
 *
 * All generators are seeded (mulberry32) so runs are reproducible.
 */

import type { AgentStoredEvent } from "../../src/lib/agents/types.js";

export type BenchProbeCategory =
  | "user-directive"
  | "fact"
  | "numeric-state"
  | "artifact"
  | "subagent"
  | "dead-end"
  | "nuance"
  // Gauntlet categories:
  | "latest-value"
  | "lookalike"
  | "authority"
  | "multi-hop"
  | "tool-only"
  | "absent"
  | "spec-detail"
  // LoCoMo / melange categories:
  | "temporal"
  | "cross-domain";

export type BenchProbe = {
  id: string;
  question: string;
  /** Any-of acceptable answers. */
  expected: string[];
  /** fuzzy = normalized containment OR token-F1 (for third-party datasets). */
  matcher: "contains" | "number" | "fuzzy";
  category: BenchProbeCategory;
  /** Turn index where the answer was planted (0-based). Higher = later = easier. */
  plantedAtTurn: number;
};

export type BenchScenario = {
  id: string;
  title: string;
  events: AgentStoredEvent[];
  probes: BenchProbe[];
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class EventBuilder {
  events: AgentStoredEvent[] = [];
  private seq = 0;
  constructor(private readonly conversationId: string) {}

  private next(): number {
    this.seq += 1;
    return this.seq;
  }

  user(content: string): void {
    const seq = this.next();
    this.events.push({
      seq,
      eventId: `u-${seq}`,
      conversationId: this.conversationId,
      createdAt: seq,
      kind: "user_message",
      messageId: `m-${seq}`,
      content,
    });
  }

  assistant(text: string): void {
    const chunkSeq = this.next();
    const endSeq = this.next();
    const messageId = `am-${chunkSeq}`;
    this.events.push(
      {
        seq: chunkSeq,
        eventId: `ac-${chunkSeq}`,
        conversationId: this.conversationId,
        createdAt: chunkSeq,
        kind: "assistant_message_chunk",
        messageId,
        text,
      },
      {
        seq: endSeq,
        eventId: `ae-${endSeq}`,
        conversationId: this.conversationId,
        createdAt: endSeq,
        kind: "assistant_message_end",
        messageId,
        stopReason: "end_turn",
      }
    );
  }

  tool(name: string, args: Record<string, unknown>, result: string, status: "completed" | "failed" = "completed"): void {
    const callSeq = this.next();
    const updateSeq = this.next();
    const toolCallId = `tc-${callSeq}`;
    this.events.push(
      {
        seq: callSeq,
        eventId: `tcall-${callSeq}`,
        conversationId: this.conversationId,
        createdAt: callSeq,
        kind: "tool_call",
        toolCallId,
        title: `${name}`,
        toolKind: "execute",
        status: "running",
        raw: { request: { name, arguments: args } },
      },
      {
        seq: updateSeq,
        eventId: `tup-${updateSeq}`,
        conversationId: this.conversationId,
        createdAt: updateSeq,
        kind: "tool_call_update",
        toolCallId,
        title: `${name}`,
        toolKind: "execute",
        status,
        detail: result,
      }
    );
  }

  subagent(id: string, title: string, activity: string): void {
    const seq = this.next();
    this.events.push({
      seq,
      eventId: `sub-${seq}`,
      conversationId: this.conversationId,
      createdAt: seq,
      kind: "subagent",
      subagentId: id,
      title,
      status: "completed",
      transcript: [],
      recentActivity: activity,
    });
  }
}

const WORDS = [
  "lattice", "quartz", "meridian", "harbor", "cobalt", "ember", "juniper", "krypton",
  "monsoon", "nebula", "obsidian", "pylon", "quiver", "rampart", "saffron", "tundra",
  "umbra", "vertex", "willow", "zephyr", "basalt", "cinder", "delta", "echo",
];

function pick(rand: () => number, items: string[]): string {
  return items[Math.floor(rand() * items.length)]!;
}

function filler(rand: () => number, sentences: number): string {
  const parts: string[] = [];
  for (let index = 0; index < sentences; index += 1) {
    parts.push(
      `The ${pick(rand, WORDS)} pipeline processed the ${pick(rand, WORDS)} batch and emitted ${
        Math.floor(rand() * 900) + 100
      } records into the ${pick(rand, WORDS)} store without incident.`
    );
  }
  return parts.join(" ");
}

function logNoise(rand: () => number, lines: number): string {
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    parts.push(
      `[${String(index).padStart(4, "0")}] ${pick(rand, WORDS)}.service latency=${(rand() * 90 + 5).toFixed(1)}ms status=ok shard=${Math.floor(rand() * 16)}`
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Scenario 1: fact-thread (menial fact retention across many turns)
// ---------------------------------------------------------------------------

export function factThreadScenario(options: { turns?: number; seed?: number } = {}): BenchScenario {
  const turns = options.turns ?? 36;
  const rand = mulberry32(options.seed ?? 1101);
  const builder = new EventBuilder("bench-fact-thread");
  const probes: BenchProbe[] = [];
  const facts: Array<{ codename: string; value: string; turn: number }> = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const codename = `${pick(rand, WORDS)}-${Math.floor(rand() * 90) + 10}`;
    const value = `${pick(rand, WORDS)}_${Math.floor(rand() * 9000) + 1000}`;
    facts.push({ codename, value, turn });
    builder.user(
      `Quick note before we continue: the access token for service "${codename}" is "${value}". Remember it. ` +
        `Now, unrelated: ${filler(rand, 3)}`
    );
    builder.tool("terminal", { command: `check ${codename}` }, logNoise(rand, 24));
    builder.assistant(
      `Noted: ${codename} -> ${value}. On the other matter: ${filler(rand, 4)}`
    );
  }
  // Probe 12 facts spread across depth.
  const probeTurns = new Set<number>();
  for (let index = 0; index < 12; index += 1) {
    probeTurns.add(Math.floor((index / 12) * turns));
  }
  for (const turn of probeTurns) {
    const fact = facts[turn]!;
    probes.push({
      id: `fact-${turn}`,
      question: `What is the access token for service "${fact.codename}"?`,
      expected: [fact.value],
      matcher: "contains",
      category: "fact",
      plantedAtTurn: turn,
    });
  }
  return { id: "fact-thread", title: "Menial fact retention", events: builder.events, probes };
}

// ---------------------------------------------------------------------------
// Scenario 2: swe-sim (simulated SWE session with subagents & dead ends)
// ---------------------------------------------------------------------------

export function sweSimScenario(options: { seed?: number } = {}): BenchScenario {
  const rand = mulberry32(options.seed ?? 2202);
  const builder = new EventBuilder("bench-swe-sim");
  const probes: BenchProbe[] = [];

  builder.user(
    "We're building the polymarket arbitrage bot. Hard constraints you must never violate: " +
      "(1) position size is capped at 4.5% of bankroll per market, " +
      '(2) never trade markets that resolve in under 36 hours, ' +
      "(3) all order code lives in src/exec/order_router.py. Keep these in mind forever."
  );
  builder.assistant("Understood. Constraints recorded: 4.5% cap, no sub-36h markets, order code in src/exec/order_router.py.");
  probes.push(
    {
      id: "swe-directive-cap",
      question: "What is the maximum position size per market, as a percent of bankroll?",
      expected: ["4.5"],
      matcher: "contains",
      category: "user-directive",
      plantedAtTurn: 0,
    },
    {
      id: "swe-directive-hours",
      question: "Markets resolving in under how many hours must never be traded?",
      expected: ["36"],
      matcher: "contains",
      category: "user-directive",
      plantedAtTurn: 0,
    }
  );

  // Work phase 1: failed approach (dead end).
  builder.user("Start by wiring the websocket feed for orderbook deltas.");
  builder.tool(
    "write_file",
    { path: "src/feeds/ws_orderbook.py" },
    "Wrote src/feeds/ws_orderbook.py (188 lines)"
  );
  builder.tool(
    "terminal",
    { command: "python -m src.feeds.ws_orderbook --smoke" },
    "Traceback: websockets.exceptions.InvalidStatusCode: server rejected WebSocket connection: HTTP 403 (cloudflare bot challenge)",
    "failed"
  );
  builder.assistant(
    "Direct websocket connection is blocked by a Cloudflare bot challenge (HTTP 403). Abandoning the raw websocket approach; switching to the authenticated CLOB SDK stream instead."
  );
  builder.tool(
    "write_file",
    { path: "src/feeds/clob_stream.py" },
    "Wrote src/feeds/clob_stream.py (241 lines)"
  );
  builder.tool(
    "terminal",
    { command: "python -m src.feeds.clob_stream --smoke" },
    `Connected. ${logNoise(rand, 30)}`
  );
  builder.assistant("CLOB SDK stream works. Feed layer done via src/feeds/clob_stream.py.");
  probes.push(
    {
      id: "swe-deadend-ws",
      question: "Why was the raw websocket approach for the orderbook feed abandoned?",
      expected: ["403", "cloudflare", "bot challenge"],
      matcher: "contains",
      category: "dead-end",
      plantedAtTurn: 1,
    },
    {
      id: "swe-artifact-feed",
      question: "Which file implements the working orderbook feed?",
      expected: ["src/feeds/clob_stream.py", "clob_stream.py"],
      matcher: "contains",
      category: "artifact",
      plantedAtTurn: 1,
    }
  );

  // Work phase 2: subagents.
  builder.user("Spawn subagents to backtest the kelly sizing and to audit fee handling, then keep building.");
  builder.subagent(
    "sub-kelly-9f3",
    "Backtest kelly sizing",
    "Backtest complete: fractional kelly 0.31 optimal, full kelly drawdown 61% — recommend 0.31."
  );
  builder.subagent(
    "sub-fees-2c7",
    "Audit fee handling",
    "Found taker fee double-counted in pnl.py line 88; patched. Net edge improves by 22 bps."
  );
  builder.assistant(
    "Both subagents finished. sub-kelly-9f3: fractional kelly 0.31 recommended. sub-fees-2c7: fixed double-counted taker fee in pnl.py (+22 bps)."
  );
  probes.push(
    {
      id: "swe-subagent-kelly",
      question: "What fractional kelly value did the backtest subagent recommend?",
      expected: ["0.31"],
      matcher: "contains",
      category: "subagent",
      plantedAtTurn: 2,
    },
    {
      id: "swe-subagent-fees",
      question: "What bug did the fee-audit subagent find?",
      expected: ["double-counted", "double counted", "pnl.py"],
      matcher: "contains",
      category: "subagent",
      plantedAtTurn: 2,
    }
  );

  // Noise phase: long grinding tool work to force compactions.
  for (let phase = 0; phase < 14; phase += 1) {
    builder.user(`Continue with integration milestone ${phase}. ${filler(rand, 2)}`);
    builder.tool(
      "terminal",
      { command: `pytest tests/milestone_${phase}` },
      `${logNoise(rand, 60)}\n${Math.floor(rand() * 40) + 10} passed in ${(rand() * 30 + 2).toFixed(2)}s`
    );
    builder.tool(
      "read_file",
      { path: `src/exec/module_${phase}.py` },
      logNoise(rand, 50)
    );
    builder.assistant(`Milestone ${phase} green. ${filler(rand, 3)}`);
  }

  // Late config value.
  builder.user('One more thing: set the redis cache namespace to "pm-arb-prod-v7" everywhere.');
  builder.tool("edit_file", { path: "src/config.py" }, "Updated REDIS_NAMESPACE to pm-arb-prod-v7");
  builder.assistant('Done — REDIS_NAMESPACE is now "pm-arb-prod-v7" in src/config.py.');
  probes.push({
    id: "swe-fact-redis",
    question: "What is the redis cache namespace?",
    expected: ["pm-arb-prod-v7"],
    matcher: "contains",
    category: "fact",
    plantedAtTurn: 17,
  });

  // Final grinding phase so the late fact also gets compacted at small windows.
  for (let phase = 0; phase < 8; phase += 1) {
    builder.user(`Polish pass ${phase}: run the full suite and lint. ${filler(rand, 2)}`);
    builder.tool(
      "terminal",
      { command: "pytest -q && ruff check ." },
      `${logNoise(rand, 70)}\nAll checks passed.`
    );
    builder.assistant(`Polish pass ${phase} complete. ${filler(rand, 3)}`);
  }

  return { id: "swe-sim", title: "SWE session with subagents & dead ends", events: builder.events, probes };
}

// ---------------------------------------------------------------------------
// Scenario 3: math-state (running numeric state through compaction)
// ---------------------------------------------------------------------------

export function mathStateScenario(options: { turns?: number; seed?: number } = {}): BenchScenario {
  const turns = options.turns ?? 30;
  const rand = mulberry32(options.seed ?? 3303);
  const builder = new EventBuilder("bench-math-state");
  const registers: Record<string, number> = { alpha: 100, beta: 250, gamma: 40 };
  const names = Object.keys(registers);
  for (let turn = 0; turn < turns; turn += 1) {
    const name = names[Math.floor(rand() * names.length)]!;
    const delta = Math.floor(rand() * 40) - 15;
    registers[name] = registers[name]! + delta;
    builder.user(
      `Ledger update: adjust register "${name}" by ${delta >= 0 ? "+" : ""}${delta}. Also, ${filler(rand, 2)}`
    );
    builder.tool("terminal", { command: `ledger apply ${name} ${delta}` }, logNoise(rand, 20));
    builder.assistant(
      `Applied. Register ${name} is now ${registers[name]}. ${filler(rand, 2)}`
    );
  }
  const probes: BenchProbe[] = names.map((name) => ({
    id: `math-${name}`,
    question: `What is the current value of register "${name}"?`,
    expected: [String(registers[name])],
    matcher: "number",
    category: "numeric-state",
    plantedAtTurn: turns - 1,
  }));
  return { id: "math-state", title: "Running numeric state", events: builder.events, probes };
}

// ---------------------------------------------------------------------------
// Scenario 4: chat-nuance (general conversation, soft preferences)
// ---------------------------------------------------------------------------

export function chatNuanceScenario(options: { seed?: number } = {}): BenchScenario {
  const rand = mulberry32(options.seed ?? 4404);
  const builder = new EventBuilder("bench-chat-nuance");
  const probes: BenchProbe[] = [];

  builder.user(
    "Hey! Before anything: I go by Rowan (never 'Row'), my cat is named Pickle, and I'm planning a trip to Kyoto in April. " +
      "Also, when you explain things, I like cooking analogies."
  );
  builder.assistant("Got it, Rowan. Pickle the cat, Kyoto in April, and cooking analogies it is.");
  probes.push(
    {
      id: "nuance-name",
      question: "What name does the user go by?",
      expected: ["Rowan"],
      matcher: "contains",
      category: "nuance",
      plantedAtTurn: 0,
    },
    {
      id: "nuance-cat",
      question: "What is the user's cat's name?",
      expected: ["Pickle"],
      matcher: "contains",
      category: "nuance",
      plantedAtTurn: 0,
    },
    {
      id: "nuance-trip",
      question: "Where and when is the user planning a trip?",
      expected: ["Kyoto"],
      matcher: "contains",
      category: "nuance",
      plantedAtTurn: 0,
    },
    {
      id: "nuance-style",
      question: "What kind of analogies does the user prefer in explanations?",
      expected: ["cooking"],
      matcher: "contains",
      category: "nuance",
      plantedAtTurn: 0,
    }
  );

  const topics = [
    "the history of tea ceremonies",
    "how sourdough starters work",
    "training for a 10k",
    "learning the piano as an adult",
    "keeping houseplants alive",
    "budgeting for travel",
    "photography basics",
    "note-taking systems",
  ];
  for (let turn = 0; turn < 26; turn += 1) {
    const topic = topics[Math.floor(rand() * topics.length)]!;
    builder.user(`Let's chat about ${topic}. ${filler(rand, 3)}`);
    builder.assistant(`${filler(rand, 6)} Anyway — ${topic} is a great topic. ${filler(rand, 4)}`);
  }

  builder.user("By the way, I decided the Kyoto trip will be 9 days, and I booked a ryokan near Gion.");
  builder.assistant("Nine days in Kyoto with a ryokan near Gion — lovely.");
  probes.push({
    id: "nuance-trip-length",
    question: "How many days will the user's Kyoto trip be?",
    expected: ["9", "nine"],
    matcher: "contains",
    category: "nuance",
    plantedAtTurn: 27,
  });

  for (let turn = 0; turn < 10; turn += 1) {
    const topic = topics[Math.floor(rand() * topics.length)]!;
    builder.user(`More on ${topic}: ${filler(rand, 3)}`);
    builder.assistant(`${filler(rand, 7)}`);
  }

  return { id: "chat-nuance", title: "General conversation nuance", events: builder.events, probes };
}

export function allScenarios(): BenchScenario[] {
  return [factThreadScenario(), sweSimScenario(), mathStateScenario(), chatNuanceScenario()];
}
