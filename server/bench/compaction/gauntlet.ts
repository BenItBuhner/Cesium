/**
 * The compaction gauntlet: an aggressively scaled memory benchmark.
 *
 * A seeded generator produces a long working session containing hundreds to
 * thousands of factual articles interleaved with hostile noise:
 *
 *  - typed entities (services, incidents, people, config keys) with attributes
 *  - fact REVISIONS: values rotate mid-conversation; probes demand the LATEST
 *  - lookalike entities: near-identical names with different values
 *  - authority traps: mock/sample dumps carry WRONG values, clearly labeled
 *    non-authoritative; probes demand the authoritative value
 *  - facts that exist ONLY in tool output (punishes user-message-only retention)
 *  - dead ends: approaches tried and failed with specific errors
 *  - subagent lineage: spawned agents with ids and outcomes
 *  - multi-hop probes joining 2-3 facts
 *  - absent probes: the correct answer is UNKNOWN (punishes hallucinating
 *    compactors that invent detail)
 *
 * Two materializations from one abstract script:
 *  - `toScenario()`  → AgentStoredEvent[] for the in-process strategy bench
 *  - `toFlatTurns()` → plain user-message strings (tool output quoted inline)
 *    so REAL harnesses (Codex CLI, Claude Code, OpenCode, Cesium) receive
 *    byte-identical input and only their compaction differs.
 *
 * Anti-overfitting: everything derives from `seed`; evaluate on unseen seeds.
 */

import type { AgentStoredEvent } from "../../src/lib/agents/types.js";
import type { BenchProbe, BenchScenario } from "./scenarios.js";

export type GauntletPreset = "s" | "m" | "l";

export type GauntletOptions = {
  preset?: GauntletPreset;
  seed?: number;
  /** Override turn count (feeding turns, excluding probes). */
  turns?: number;
  /** Override total planted facts. */
  facts?: number;
  /** Override probe count. */
  probes?: number;
};

const PRESETS: Record<GauntletPreset, { turns: number; facts: number; probes: number }> = {
  s: { turns: 28, facts: 140, probes: 40 },
  m: { turns: 120, facts: 480, probes: 56 },
  l: { turns: 400, facts: 1500, probes: 72 },
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

const NOUNS = [
  "lattice", "quartz", "meridian", "harbor", "cobalt", "ember", "juniper", "krypton",
  "monsoon", "nebula", "obsidian", "pylon", "quiver", "rampart", "saffron", "tundra",
  "umbra", "vertex", "willow", "zephyr", "basalt", "cinder", "delta", "echo",
  "fjord", "garnet", "helix", "isthmus", "jasper", "kelp", "lumen", "mica",
];
const REGIONS = ["us-east-1", "eu-west-2", "ap-south-1", "sa-east-1", "af-south-1"];
const FIRST_NAMES = [
  "Priya", "Marcus", "Yuki", "Amara", "Diego", "Ingrid", "Tomás", "Wren",
  "Kofi", "Leila", "Bram", "Suki", "Otis", "Nadia", "Ravi", "Freya",
];
const TIMEZONES = ["UTC-8", "UTC-5", "UTC", "UTC+1", "UTC+5:30", "UTC+9"];

type EntityKind = "service" | "person" | "incident" | "config";

type Fact = {
  id: string;
  kind: EntityKind;
  entity: string;
  attribute: string;
  /** Value history; last entry is authoritative. */
  values: string[];
  /** Turn indexes at which each value was planted. */
  plantTurns: number[];
  /** Channel of the FINAL (authoritative) plant. */
  finalChannel: "user" | "tool" | "assistant";
  lookalikeOf?: string;
};

type TurnItem =
  | { kind: "fact-plant"; fact: Fact; valueIndex: number; channel: "user" | "tool" | "assistant" }
  | { kind: "mock-dump"; lines: string[] }
  | { kind: "chatter"; text: string }
  | { kind: "log-noise"; lines: number }
  | { kind: "dead-end"; id: string; approach: string; error: string; alternative: string }
  | { kind: "subagent"; id: string; task: string; outcome: string };

export type GauntletScript = {
  id: string;
  title: string;
  seed: number;
  turns: TurnItem[][];
  facts: Fact[];
  probes: BenchProbe[];
};

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function shuffle<T>(rand: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function token(rand: () => number): string {
  return `${pick(rand, NOUNS)}_${Math.floor(rand() * 9000) + 1000}`;
}

function chatter(rand: () => number, sentences: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    parts.push(
      `The ${pick(rand, NOUNS)} pipeline processed the ${pick(rand, NOUNS)} batch and emitted ${
        Math.floor(rand() * 900) + 100
      } records into the ${pick(rand, NOUNS)} store without incident.`
    );
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

export function generateGauntletScript(options: GauntletOptions = {}): GauntletScript {
  const preset = PRESETS[options.preset ?? "m"];
  const seed = options.seed ?? 1337;
  const turnCount = options.turns ?? preset.turns;
  const factCount = options.facts ?? preset.facts;
  const probeCount = options.probes ?? preset.probes;
  const rand = mulberry32(seed);

  // --- Entity + fact corpus -------------------------------------------------
  const facts: Fact[] = [];
  const usedEntityNames = new Set<string>();
  const serviceNames: string[] = [];
  const people: Array<{ name: string; timezone: string; ownsService?: string }> = [];

  let entityCounter = 0;
  const uniqueEntity = (make: () => string): string => {
    // Bounded retries, then force uniqueness with a counter suffix — generator
    // namespaces are finite and large presets exhaust them.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const name = make();
      if (!usedEntityNames.has(name)) {
        usedEntityNames.add(name);
        return name;
      }
    }
    for (;;) {
      entityCounter += 1;
      const name = `${make()}-${entityCounter}`;
      if (!usedEntityNames.has(name)) {
        usedEntityNames.add(name);
        return name;
      }
    }
  };

  const factBudget = { count: 0 };
  const addFact = (fact: Omit<Fact, "plantTurns" | "finalChannel">): Fact | null => {
    if (factBudget.count >= factCount) {
      return null;
    }
    factBudget.count += 1;
    const full: Fact = { ...fact, plantTurns: [], finalChannel: "user" };
    facts.push(full);
    return full;
  };

  // Services: token, port, region, owner (join target), replica count.
  const serviceTarget = Math.max(8, Math.floor(factCount / 8));
  for (let index = 0; index < serviceTarget; index += 1) {
    const name = uniqueEntity(() => `${pick(rand, NOUNS)}-${Math.floor(rand() * 90) + 10}`);
    serviceNames.push(name);
    const owner = pick(rand, FIRST_NAMES);
    const revisions = rand() < 0.3 ? 2 + Math.floor(rand() * 2) : 1;
    addFact({
      id: `svc-token-${name}`, kind: "service", entity: name, attribute: "access token",
      values: Array.from({ length: revisions }, () => token(rand)),
    });
    addFact({
      id: `svc-port-${name}`, kind: "service", entity: name, attribute: "port",
      values: [String(Math.floor(rand() * 40000) + 1024)],
    });
    addFact({
      id: `svc-region-${name}`, kind: "service", entity: name, attribute: "region",
      values: [pick(rand, REGIONS)],
    });
    addFact({
      id: `svc-owner-${name}`, kind: "service", entity: name, attribute: "owner",
      values: [owner],
    });
    if (people.length < FIRST_NAMES.length && !people.some((p) => p.name === owner)) {
      people.push({ name: owner, timezone: pick(rand, TIMEZONES), ownsService: name });
    }
    // Lookalike sibling with a DIFFERENT token, planted separately.
    if (rand() < 0.35) {
      const sibling = uniqueEntity(() => {
        const parts = name.split("-");
        const digits = parts[1]!;
        const swapped = digits.length >= 2 ? `${digits[1]}${digits[0]}` : `${digits}0`;
        return `${parts[0]}-${swapped}`;
      });
      serviceNames.push(sibling);
      addFact({
        id: `svc-token-${sibling}`, kind: "service", entity: sibling, attribute: "access token",
        values: [token(rand)], lookalikeOf: name,
      });
    }
  }
  // People facts.
  for (const person of people) {
    addFact({
      id: `person-tz-${person.name}`, kind: "person", entity: person.name,
      attribute: "timezone", values: [person.timezone],
    });
  }
  // Incidents: id, root cause, resolution.
  const incidentTarget = Math.max(4, Math.floor(factCount / 20));
  const incidents: string[] = [];
  for (let index = 0; index < incidentTarget; index += 1) {
    const id = `INC-${Math.floor(rand() * 9000) + 1000}`;
    if (usedEntityNames.has(id)) continue;
    usedEntityNames.add(id);
    incidents.push(id);
    const cause = `${pick(rand, NOUNS)} ${pick(rand, ["cache stampede", "clock skew", "connection pool exhaustion", "TLS cert expiry", "split-brain failover", "orphaned lock"])}`;
    addFact({ id: `inc-cause-${id}`, kind: "incident", entity: id, attribute: "root cause", values: [cause] });
    addFact({
      id: `inc-fix-${id}`, kind: "incident", entity: id, attribute: "resolution",
      values: [`${pick(rand, ["rolled back", "hotfixed", "feature-flagged off", "rate-limited"])} by ${pick(rand, FIRST_NAMES)}`],
    });
  }
  // Config keys (some revised, some planted ONLY via tool output).
  while (factBudget.count < factCount) {
    const key = uniqueEntity(() => `${pick(rand, NOUNS)}.${pick(rand, ["ttl", "quota", "threshold", "namespace", "batch_size", "retries"])}`);
    const revisions = rand() < 0.25 ? 2 : 1;
    const fact = addFact({
      id: `cfg-${key}`, kind: "config", entity: key, attribute: "value",
      values: Array.from({ length: revisions }, () =>
        rand() < 0.5 ? String(Math.floor(rand() * 10000)) : token(rand)
      ),
    });
    if (!fact) break;
  }

  // --- Schedule plants across turns ------------------------------------------
  const turns: TurnItem[][] = Array.from({ length: turnCount }, () => []);
  const plantTurnFor = (index: number, total: number): number =>
    Math.min(turnCount - 1, Math.floor((index / total) * (turnCount * 0.92)));

  const shuffledFacts = shuffle(rand, [...facts]);
  shuffledFacts.forEach((fact, index) => {
    const first = plantTurnFor(index, shuffledFacts.length);
    fact.values.forEach((_, valueIndex) => {
      const turn =
        valueIndex === 0
          ? first
          : Math.min(
              turnCount - 1,
              first + 1 + Math.floor(rand() * Math.max(1, turnCount - first - 2))
            );
      // ~18% of FINAL values live only in tool output; a few in assistant acks.
      const isFinal = valueIndex === fact.values.length - 1;
      const roll = rand();
      const channel: "user" | "tool" | "assistant" =
        isFinal && roll < 0.18 ? "tool" : roll < 0.26 ? "assistant" : "user";
      fact.plantTurns.push(turn);
      if (isFinal) {
        fact.finalChannel = channel;
      }
      turns[turn]!.push({ kind: "fact-plant", fact, valueIndex, channel });
    });
  });

  // Dead ends and subagents sprinkled through the first 80% of turns.
  const deadEnds: Array<{ id: string; approach: string; error: string; alternative: string }> = [];
  const deadEndCount = Math.max(3, Math.floor(turnCount / 18));
  for (let index = 0; index < deadEndCount; index += 1) {
    const id = `deadend-${index}`;
    const entry = {
      id,
      approach: `${pick(rand, ["raw websocket feed", "polling scraper", "shared memory cache", "sqlite queue", "fork-per-request model", "regex-based parser"])} for ${pick(rand, NOUNS)}`,
      error: `${pick(rand, ["HTTP 403 bot challenge", "EMFILE fd exhaustion", "deadlock under load", "silent data corruption past 2GB", "p99 latency 30x budget", "GIL contention"])}`,
      alternative: `${pick(rand, ["authenticated SDK stream", "event-driven watcher", "redis-backed queue", "streaming parser", "worker pool"])}`,
    };
    deadEnds.push(entry);
    turns[Math.floor(rand() * turnCount * 0.8)]!.push({ kind: "dead-end", ...entry });
  }
  const subagents: Array<{ id: string; task: string; outcome: string }> = [];
  const subagentCount = Math.max(3, Math.floor(turnCount / 20));
  for (let index = 0; index < subagentCount; index += 1) {
    const entry = {
      id: `sub-${pick(rand, NOUNS)}-${Math.floor(rand() * 900) + 100}`,
      task: `${pick(rand, ["backtest", "audit", "profile", "fuzz", "migrate", "benchmark"])} the ${pick(rand, NOUNS)} ${pick(rand, ["sizing model", "fee handling", "hot path", "input parser", "schema", "allocator"])}`,
      outcome: `${pick(rand, ["found", "fixed", "confirmed", "rejected"])} ${pick(rand, NOUNS)} issue; metric moved ${(rand() * 40).toFixed(1)}% — details recorded`,
    };
    subagents.push(entry);
    turns[Math.floor(rand() * turnCount * 0.8)]!.push({ kind: "subagent", ...entry });
  }

  // Authority traps: mock dumps quoting WRONG values for real entities.
  const mockDumpCount = Math.max(3, Math.floor(turnCount / 10));
  for (let index = 0; index < mockDumpCount; index += 1) {
    const lines: string[] = [];
    for (let line = 0; line < 6; line += 1) {
      const fact = pick(rand, facts);
      if (fact.kind === "service" && fact.attribute === "access token") {
        lines.push(`${fact.entity}.token = "${token(rand)}"  # SAMPLE VALUE, not real`);
      } else if (fact.kind === "config") {
        lines.push(`${fact.entity} = ${Math.floor(rand() * 9999)}  # placeholder for docs`);
      } else {
        lines.push(`${pick(rand, NOUNS)}.example = "${token(rand)}"`);
      }
    }
    turns[Math.floor(rand() * turnCount)]!.push({ kind: "mock-dump", lines });
  }

  // Ambient noise on every turn.
  for (let index = 0; index < turnCount; index += 1) {
    turns[index]!.push({ kind: "chatter", text: chatter(rand, 2 + Math.floor(rand() * 3)) });
    if (rand() < 0.55) {
      turns[index]!.push({ kind: "log-noise", lines: 14 + Math.floor(rand() * 26) });
    }
  }

  // --- Probes -----------------------------------------------------------------
  const probes: BenchProbe[] = [];
  const factByAttr = (kind: EntityKind, attribute: string): Fact[] =>
    facts.filter((fact) => fact.kind === kind && fact.attribute === attribute);

  const revisedFacts = shuffle(rand, facts.filter((fact) => fact.values.length > 1));
  const lookalikeFacts = shuffle(rand, facts.filter((fact) => fact.lookalikeOf));
  const toolOnlyFacts = shuffle(rand, facts.filter((fact) => fact.finalChannel === "tool"));
  const plainFacts = shuffle(
    rand,
    facts.filter((fact) => fact.values.length === 1 && !fact.lookalikeOf && fact.finalChannel === "user")
  );

  const questionFor = (fact: Fact): string => {
    switch (fact.kind) {
      case "service":
        return `What is the ${fact.attribute} of service "${fact.entity}"?`;
      case "person":
        return `What is ${fact.entity}'s ${fact.attribute}?`;
      case "incident":
        return `What was the ${fact.attribute} of incident ${fact.entity}?`;
      case "config":
        return `What is the current value of config key "${fact.entity}"?`;
    }
  };

  const pushProbe = (
    category: BenchProbe["category"],
    id: string,
    question: string,
    expected: string[],
    plantedAtTurn: number,
    matcher: "contains" | "number" = "contains"
  ) => {
    probes.push({ id, question, expected, matcher, category, plantedAtTurn });
  };

  const quota = (fraction: number): number => Math.max(2, Math.round(probeCount * fraction));

  for (const fact of plainFacts.slice(0, quota(0.24))) {
    pushProbe("fact", `plain-${fact.id}`, questionFor(fact), [fact.values[0]!], fact.plantTurns[0]!);
  }
  for (const fact of revisedFacts.slice(0, quota(0.16))) {
    pushProbe(
      "latest-value",
      `latest-${fact.id}`,
      `${questionFor(fact)} (give the CURRENT value after all rotations)`,
      [fact.values[fact.values.length - 1]!],
      fact.plantTurns[fact.plantTurns.length - 1]!
    );
  }
  for (const fact of lookalikeFacts.slice(0, quota(0.12))) {
    pushProbe(
      "lookalike",
      `lookalike-${fact.id}`,
      `Careful — there are similarly named services. What is the ${fact.attribute} of service "${fact.entity}" exactly?`,
      [fact.values[fact.values.length - 1]!],
      fact.plantTurns[0]!
    );
  }
  for (const fact of toolOnlyFacts.slice(0, quota(0.12))) {
    pushProbe(
      "tool-only",
      `toolonly-${fact.id}`,
      `${questionFor(fact)} (this was recorded in a command/config dump)`,
      [fact.values[fact.values.length - 1]!],
      fact.plantTurns[fact.plantTurns.length - 1]!
    );
  }
  // Authority: probe a fact that mock dumps also mention with wrong values.
  for (const fact of shuffle(rand, factByAttr("service", "access token")).slice(0, quota(0.08))) {
    pushProbe(
      "authority",
      `authority-${fact.id}`,
      `Ignoring any sample/placeholder values from docs or mock dumps, what is the authoritative ${fact.attribute} of service "${fact.entity}"?`,
      [fact.values[fact.values.length - 1]!],
      fact.plantTurns[0]!
    );
  }
  // Multi-hop: owner-of-service joins.
  const ownerFacts = factByAttr("service", "owner");
  for (const ownerFact of shuffle(rand, ownerFacts).slice(0, quota(0.1))) {
    const portFact = facts.find(
      (fact) => fact.id === `svc-port-${ownerFact.entity}`
    );
    if (!portFact) continue;
    pushProbe(
      "multi-hop",
      `hop-${ownerFact.entity}`,
      `Which port does the service owned by ${ownerFact.values[0]} use? (The one they own is ${ownerFact.entity}.)`,
      [portFact.values[0]!],
      Math.max(ownerFact.plantTurns[0]!, portFact.plantTurns[0]!),
      "number"
    );
  }
  for (const entry of shuffle(rand, deadEnds).slice(0, quota(0.08))) {
    pushProbe(
      "dead-end",
      `dead-${entry.id}`,
      `Why was the "${entry.approach}" approach abandoned?`,
      [entry.error],
      0
    );
  }
  for (const entry of shuffle(rand, subagents).slice(0, quota(0.06))) {
    pushProbe(
      "subagent",
      `subagent-${entry.id}`,
      `A subagent was spawned to ${entry.task}. What was its id?`,
      [entry.id],
      0
    );
  }
  // Absent probes: entity names never planted anywhere.
  for (let index = 0; index < quota(0.06); index += 1) {
    const ghost = uniqueEntity(() => `${pick(rand, NOUNS)}-${Math.floor(rand() * 900) + 100}`);
    pushProbe(
      "absent",
      `absent-${ghost}`,
      `What is the access token of service "${ghost}"?`,
      ["unknown"],
      0
    );
  }

  return {
    id: `gauntlet-${options.preset ?? "m"}`,
    title: `Compaction gauntlet (${options.preset ?? "m"}, seed ${seed})`,
    seed,
    turns,
    facts,
    probes: shuffle(rand, probes).slice(0, probeCount),
  };
}

// ---------------------------------------------------------------------------
// Materialization: text fragments
// ---------------------------------------------------------------------------

function factSentence(fact: Fact, valueIndex: number): string {
  const value = fact.values[valueIndex]!;
  const isRevision = valueIndex > 0;
  switch (fact.kind) {
    case "service":
      return isRevision
        ? `Update: service "${fact.entity}" rotated its ${fact.attribute}; it is now "${value}" (previous value is dead).`
        : `For the record: service "${fact.entity}" has ${fact.attribute} "${value}".`;
    case "person":
      return `${fact.entity} works in ${value} — remember that for scheduling.`;
    case "incident":
      return `Incident ${fact.entity}: the ${fact.attribute} was ${value}.`;
    case "config":
      return isRevision
        ? `Config change: "${fact.entity}" is now ${value} (supersedes the old value).`
        : `Config note: "${fact.entity}" is set to ${value}.`;
  }
}

function toolDumpForPlants(plants: Array<{ fact: Fact; valueIndex: number }>, rand: () => number): string {
  const lines = plants.map(({ fact, valueIndex }) => {
    const value = fact.values[valueIndex]!;
    if (fact.kind === "service") {
      return `${fact.entity}.${fact.attribute.replace(/\s+/g, "_")} = "${value}"  # AUTHORITATIVE (live registry)`;
    }
    return `${fact.entity} = "${value}"  # AUTHORITATIVE (live registry)`;
  });
  const noise: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    noise.push(
      `${pick(rand, NOUNS)}.heartbeat_${index} = ok  # ${(rand() * 90 + 5).toFixed(1)}ms`
    );
  }
  return shuffle(rand, [...lines, ...noise]).join("\n");
}

function logNoise(rand: () => number, lines: number): string {
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    parts.push(
      `[${String(index).padStart(4, "0")}] ${pick(rand, NOUNS)}.service latency=${(rand() * 90 + 5).toFixed(1)}ms status=ok shard=${Math.floor(rand() * 16)} checksum=${Math.floor(rand() * 0xffffffff).toString(16)}`
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Materialization: in-process scenario (events)
// ---------------------------------------------------------------------------

export function gauntletToScenario(script: GauntletScript): BenchScenario {
  const rand = mulberry32(script.seed ^ 0x5eed);
  const events: AgentStoredEvent[] = [];
  let seq = 0;
  const base = { conversationId: script.id };
  const next = () => {
    seq += 1;
    return seq;
  };
  const pushUser = (content: string) => {
    const s = next();
    events.push({ ...base, seq: s, eventId: `u-${s}`, createdAt: s, kind: "user_message", messageId: `m-${s}`, content });
  };
  const pushAssistant = (text: string) => {
    const s1 = next();
    const s2 = next();
    const messageId = `am-${s1}`;
    events.push(
      { ...base, seq: s1, eventId: `ac-${s1}`, createdAt: s1, kind: "assistant_message_chunk", messageId, text },
      { ...base, seq: s2, eventId: `ae-${s2}`, createdAt: s2, kind: "assistant_message_end", messageId, stopReason: "end_turn" }
    );
  };
  const pushTool = (name: string, args: Record<string, unknown>, result: string, status: "completed" | "failed" = "completed") => {
    const s1 = next();
    const s2 = next();
    const toolCallId = `tc-${s1}`;
    events.push(
      { ...base, seq: s1, eventId: `tcall-${s1}`, createdAt: s1, kind: "tool_call", toolCallId, title: name, toolKind: "execute", status: "running", raw: { request: { name, arguments: args } } },
      { ...base, seq: s2, eventId: `tup-${s2}`, createdAt: s2, kind: "tool_call_update", toolCallId, title: name, toolKind: "execute", status, detail: result }
    );
  };
  const pushSubagent = (id: string, title: string, activity: string) => {
    const s = next();
    events.push({ ...base, seq: s, eventId: `sub-${s}`, createdAt: s, kind: "subagent", subagentId: id, title, status: "completed", transcript: [], recentActivity: activity });
  };

  for (const turn of script.turns) {
    const userParts: string[] = [];
    const assistantParts: string[] = [];
    const toolPlants: Array<{ fact: Fact; valueIndex: number }> = [];
    let logLines = 0;
    for (const item of turn) {
      switch (item.kind) {
        case "fact-plant":
          if (item.channel === "user") {
            userParts.push(factSentence(item.fact, item.valueIndex));
          } else if (item.channel === "assistant") {
            userParts.push(
              item.fact.kind === "service"
                ? `Check the ${item.fact.attribute} of service "${item.fact.entity}" and confirm it back to me.`
                : `Confirm the current value of "${item.fact.entity}" back to me.`
            );
            assistantParts.push(`Confirmed: ${factSentence(item.fact, item.valueIndex)}`);
          } else {
            toolPlants.push({ fact: item.fact, valueIndex: item.valueIndex });
          }
          break;
        case "mock-dump":
          userParts.push(
            `Here is a sample config snippet for the docs (values are placeholders, NOT real):\n${item.lines.join("\n")}`
          );
          break;
        case "chatter":
          userParts.push(item.text);
          break;
        case "log-noise":
          logLines += item.lines;
          break;
        case "dead-end":
          userParts.push(`Try the ${item.approach} next.`);
          assistantParts.push(
            `Tried the ${item.approach}: failed with ${item.error}. Abandoning it; switching to the ${item.alternative} instead.`
          );
          break;
        case "subagent":
          userParts.push(`Spawn a subagent to ${item.task}.`);
          pushSubagent(item.id, item.task, item.outcome);
          assistantParts.push(`Subagent ${item.id} finished: ${item.outcome}.`);
          break;
      }
    }
    pushUser(userParts.join("\n\n") || "Continue.");
    if (toolPlants.length > 0) {
      pushTool("terminal", { command: "registry dump --live" }, toolDumpForPlants(toolPlants, rand));
    }
    if (logLines > 0) {
      pushTool("terminal", { command: "tail -n 40 service.log" }, logNoise(rand, logLines));
    }
    pushAssistant(assistantParts.join(" ") || "Noted.");
  }
  return { id: script.id, title: script.title, events, probes: script.probes };
}

// ---------------------------------------------------------------------------
// Materialization: flat turns for real harnesses (byte-identical user input)
// ---------------------------------------------------------------------------

export function gauntletToFlatTurns(script: GauntletScript): string[] {
  const rand = mulberry32(script.seed ^ 0x5eed);
  const turns: string[] = [];
  for (const turn of script.turns) {
    const parts: string[] = [];
    const toolPlants: Array<{ fact: Fact; valueIndex: number }> = [];
    let logLines = 0;
    for (const item of turn) {
      switch (item.kind) {
        case "fact-plant":
          if (item.channel === "tool") {
            toolPlants.push({ fact: item.fact, valueIndex: item.valueIndex });
          } else {
            // For flat mode both user- and assistant-channel plants arrive as
            // user text (real harnesses control their own assistant turns).
            parts.push(factSentence(item.fact, item.valueIndex));
          }
          break;
        case "mock-dump":
          parts.push(
            `Here is a sample config snippet for the docs (values are placeholders, NOT real):\n${item.lines.join("\n")}`
          );
          break;
        case "chatter":
          parts.push(item.text);
          break;
        case "log-noise":
          logLines += item.lines;
          break;
        case "dead-end":
          parts.push(
            `Progress note for the record: we tried the ${item.approach} and it failed with ${item.error}; we abandoned it and switched to the ${item.alternative}.`
          );
          break;
        case "subagent":
          parts.push(
            `Progress note: subagent ${item.id} was spawned to ${item.task}; it finished with outcome: ${item.outcome}.`
          );
          break;
      }
    }
    if (toolPlants.length > 0) {
      parts.push(
        `Output of \`registry dump --live\` (this is AUTHORITATIVE):\n${toolDumpForPlants(toolPlants, rand)}`
      );
    }
    if (logLines > 0) {
      parts.push(`Service log tail:\n${logNoise(rand, logLines)}`);
    }
    parts.push("No action needed — just retain all of the above. Reply with exactly: Noted.");
    turns.push(parts.join("\n\n"));
  }
  return turns;
}
