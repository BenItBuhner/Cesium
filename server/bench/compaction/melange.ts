/**
 * The melange: multi-domain cross-contamination scenario.
 *
 * A single seeded conversation juggles four domains simultaneously — running
 * mathematics state, research-paper findings, personal/planning chatter, and
 * light software work — switching between them constantly (the way real long
 * conversations actually behave). Probes hit every domain plus CROSS-DOMAIN
 * joins that require combining facts from different threads of the same
 * conversation (e.g. compare a math register against a paper's reported
 * metric).
 *
 * This measures what the SWE-only and fact-only scenarios cannot: whether
 * compaction preserves parallel, interleaved threads without collapsing or
 * cross-contaminating them.
 */

import type { AgentStoredEvent } from "../../src/lib/agents/types.js";
import type { BenchProbe, BenchScenario } from "./scenarios.js";

export type MelangePreset = "s" | "m" | "l";

const PRESETS: Record<MelangePreset, { rounds: number; probes: number }> = {
  s: { rounds: 8, probes: 32 },
  m: { rounds: 24, probes: 48 },
  l: { rounds: 64, probes: 64 },
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

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const AUTHORS = [
  "Okafor", "Lindqvist", "Marchetti", "Devi", "Sokolov", "Tanaka", "Beaumont",
  "Iqbal", "Ferreira", "Novak", "Ahmadi", "Castellanos",
];
const TOPICS = [
  "sparse retrieval", "protein folding", "battery cathodes", "coral bleaching",
  "market microstructure", "gut microbiome", "photonic switching", "soil carbon",
  "sleep consolidation", "glacier dynamics",
];
const METRICS = ["accuracy", "recall", "F1", "yield", "efficiency"];
const FRIENDS = ["Rowan", "Priya", "Mateus", "Keiko", "Amara", "Stefan"];
const CITIES = ["Kyoto", "Oaxaca", "Tallinn", "Valparaiso", "Hoi An", "Marrakesh"];
const FILES = [
  "src/ingest/parser.py", "src/models/ranker.py", "lib/cache/lru.ts",
  "services/api/router.go", "pkg/queue/consumer.rs", "app/jobs/scheduler.rb",
];
const BUGS = [
  "off-by-one in pagination", "stale cache on rename", "race in shutdown hook",
  "float drift in totals", "unbounded retry loop", "timezone mixup in scheduler",
];
const FIXES = [
  "clamped the cursor", "added cache invalidation", "guarded with a mutex",
  "switched to integer cents", "added exponential backoff with cap", "normalized to UTC",
];
const MONTHS = ["March", "April", "May", "June", "September", "October"];

function chatter(rand: () => number, sentences: number): string {
  const bits = [
    "the weather turned properly grim this week",
    "I finally fixed my espresso grinder",
    "the neighbor's dog has opinions about delivery trucks",
    "I keep meaning to reread that essay you mentioned",
    "my calendar is a war crime this month",
    "the plant on my desk refuses to die, respect",
    "someone microwaved fish in the office again",
  ];
  return Array.from({ length: sentences }, () => pick(rand, bits)).join("; ") + ".";
}

export function melangeScenario(
  options: { preset?: MelangePreset; seed?: number } = {}
): BenchScenario {
  const preset = PRESETS[options.preset ?? "m"];
  const seed = options.seed ?? 20260801;
  const rand = mulberry32(seed);

  // --- Domain state -----------------------------------------------------------
  const registers: Record<string, number> = { alpha: 120, beta: 340, gamma: 55 };
  const registerNames = Object.keys(registers);
  const papers: Array<{
    author: string;
    year: number;
    topic: string;
    metric: string;
    value: number;
    sampleSize: number;
  }> = [];
  const usedAuthors = new Set<string>();
  const trips: Array<{ friend: string; city: string; month: string; days: number; revised: boolean }> = [];
  const bugs: Array<{ file: string; bug: string; fix: string }> = [];

  const events: AgentStoredEvent[] = [];
  let seq = 0;
  const base = { conversationId: `melange-${options.preset ?? "m"}` };
  const pushUser = (content: string) => {
    seq += 1;
    events.push({ ...base, seq, eventId: `u-${seq}`, createdAt: seq, kind: "user_message", messageId: `m-${seq}`, content });
  };
  const pushAssistant = (text: string) => {
    seq += 1;
    const chunkSeq = seq;
    seq += 1;
    const messageId = `am-${chunkSeq}`;
    events.push(
      { ...base, seq: chunkSeq, eventId: `ac-${chunkSeq}`, createdAt: chunkSeq, kind: "assistant_message_chunk", messageId, text },
      { ...base, seq, eventId: `ae-${seq}`, createdAt: seq, kind: "assistant_message_end", messageId, stopReason: "end_turn" }
    );
  };

  for (let round = 0; round < preset.rounds; round += 1) {
    // 1. Math thread: mutate 1-2 registers; assistant echoes running totals.
    const mutated: string[] = [];
    const mutationCount = 1 + Math.floor(rand() * 2);
    const deltas: string[] = [];
    for (let index = 0; index < mutationCount; index += 1) {
      const name = pick(rand, registerNames);
      const delta = Math.floor(rand() * 60) - 25;
      registers[name] = registers[name]! + delta;
      deltas.push(`adjust ${name} by ${delta >= 0 ? "+" : ""}${delta}`);
      mutated.push(`${name} is now ${registers[name]}`);
    }
    pushUser(`Math thread: ${deltas.join(" and ")}. Also, unrelated: ${chatter(rand, 2)}`);
    pushAssistant(`Applied. ${mutated.join("; ")}.`);

    // 2. Research thread: a new paper with a metric, or a follow-up comparison.
    if (rand() < 0.75 || papers.length === 0) {
      let author = pick(rand, AUTHORS);
      let guard = 0;
      while (usedAuthors.has(author) && guard < 20) {
        author = pick(rand, AUTHORS);
        guard += 1;
      }
      if (usedAuthors.has(author)) {
        author = `${author}-${papers.length}`;
      }
      usedAuthors.add(author);
      const paper = {
        author,
        year: 2019 + Math.floor(rand() * 7),
        topic: pick(rand, TOPICS),
        metric: pick(rand, METRICS),
        value: Math.round((55 + rand() * 44) * 10) / 10,
        sampleSize: (2 + Math.floor(rand() * 48)) * 10,
      };
      papers.push(paper);
      pushUser(
        `Research thread: found a paper by ${paper.author} et al. (${paper.year}) on ${paper.topic} — ` +
          `reports ${paper.value}% ${paper.metric} on n=${paper.sampleSize}. Log it for the lit review.`
      );
      pushAssistant(
        `Logged: ${paper.author} ${paper.year}, ${paper.topic}, ${paper.value}% ${paper.metric}, n=${paper.sampleSize}.`
      );
    } else {
      const paper = pick(rand, papers);
      pushUser(`Research thread: remind me, what did the ${paper.author} paper measure again? ${chatter(rand, 1)}`);
      pushAssistant(`${paper.author} (${paper.year}): ${paper.value}% ${paper.metric} on ${paper.topic}, n=${paper.sampleSize}.`);
    }

    // 3. Personal thread: trips get planned and REVISED (tests recency).
    if (rand() < 0.5 || trips.length === 0) {
      const trip = {
        friend: pick(rand, FRIENDS),
        city: pick(rand, CITIES),
        month: pick(rand, MONTHS),
        days: 3 + Math.floor(rand() * 12),
        revised: false,
      };
      trips.push(trip);
      pushUser(
        `Life thread: planning a trip with ${trip.friend} to ${trip.city} in ${trip.month}, ${trip.days} days. ${chatter(rand, 1)}`
      );
      pushAssistant(`Trip noted: ${trip.city} with ${trip.friend}, ${trip.month}, ${trip.days} days.`);
    } else {
      const trip = pick(rand, trips);
      const newDays = 3 + Math.floor(rand() * 12);
      const newMonth = pick(rand, MONTHS);
      trip.days = newDays;
      trip.month = newMonth;
      trip.revised = true;
      pushUser(
        `Life thread: change of plans — the ${trip.city} trip with ${trip.friend} moves to ${newMonth} and becomes ${newDays} days.`
      );
      pushAssistant(`Updated: ${trip.city} now ${newMonth}, ${newDays} days.`);
    }

    // 4. Software thread: a bug appears and gets fixed.
    if (rand() < 0.6 || bugs.length === 0) {
      const bug = { file: pick(rand, FILES), bug: pick(rand, BUGS), fix: pick(rand, FIXES) };
      bugs.push(bug);
      pushUser(`Code thread: hit a ${bug.bug} in ${bug.file}. Fixed it — ${bug.fix}. Keep track.`);
      pushAssistant(`Tracked: ${bug.file} had ${bug.bug}; resolution: ${bug.fix}.`);
    }

    // 5. Pure noise round-out.
    pushUser(`Meanwhile: ${chatter(rand, 3)} No action needed.`);
    pushAssistant("Noted.");
  }

  // --- Probes -----------------------------------------------------------------
  const probes: BenchProbe[] = [];
  const quota = (fraction: number): number => Math.max(2, Math.round(preset.probes * fraction));

  for (const name of registerNames) {
    probes.push({
      id: `melange-math-${name}`,
      question: `What is the current value of register "${name}" in our math thread?`,
      expected: [String(registers[name])],
      matcher: "number",
      category: "numeric-state",
      plantedAtTurn: 0,
    });
  }
  const paperSample = [...papers].sort(() => rand() - 0.5).slice(0, quota(0.25));
  for (const paper of paperSample) {
    probes.push({
      id: `melange-paper-${paper.author}`,
      question: `What ${paper.metric} did the ${paper.author} et al. paper report, and on what sample size?`,
      expected: [`${paper.value}`],
      matcher: "contains",
      category: "fact",
      plantedAtTurn: 0,
    });
  }
  const tripSample = [...trips].sort(() => rand() - 0.5).slice(0, quota(0.2));
  for (const trip of tripSample) {
    probes.push({
      id: `melange-trip-${trip.friend}-${trip.city}`,
      question: `As of the latest plan, how many days is the ${trip.city} trip with ${trip.friend}, and in which month?`,
      expected: [`${trip.days}`],
      matcher: "contains",
      category: trip.revised ? "latest-value" : "nuance",
      plantedAtTurn: 0,
    });
  }
  const bugSample = [...bugs].sort(() => rand() - 0.5).slice(0, quota(0.15));
  for (const bug of bugSample) {
    probes.push({
      id: `melange-bug-${bug.file.replace(/[^a-z0-9]/gi, "_")}`,
      question: `What bug did we hit in ${bug.file} and how was it fixed?`,
      expected: [bug.bug, bug.fix],
      matcher: "fuzzy",
      category: "dead-end",
      plantedAtTurn: 0,
    });
  }
  // Cross-domain joins: register vs paper metric comparisons, trip vs paper year.
  const crossCount = quota(0.25);
  for (let index = 0; index < crossCount && papers.length > 0; index += 1) {
    const name = pick(rand, registerNames);
    const paper = pick(rand, papers);
    const answer = registers[name]! > paper.value ? name : `${paper.author}`;
    probes.push({
      id: `melange-cross-${index}`,
      question:
        `Cross-thread check: which is numerically larger right now — the current value of register "${name}" ` +
        `from our math thread, or the ${paper.metric} percentage reported by the ${paper.author} paper? ` +
        `Answer with the register name or the paper author.`,
      expected: [answer],
      matcher: "contains",
      category: "cross-domain",
      plantedAtTurn: 0,
    });
  }

  return {
    id: `melange-${options.preset ?? "m"}`,
    title: `Multi-domain melange (${options.preset ?? "m"}, seed ${seed})`,
    events,
    probes: probes.slice(0, preset.probes),
  };
}
