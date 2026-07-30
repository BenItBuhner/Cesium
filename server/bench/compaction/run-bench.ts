/**
 * Compaction benchmark runner.
 *
 * Replays deterministic long conversations through each compaction strategy
 * inside an artificially constrained context window (forcing multiple
 * compaction generations), then asks recall probes against the final compacted
 * context and scores the answers.
 *
 * Usage (from server/):
 *   bun bench/compaction/run-bench.ts \
 *     --scenarios fact-thread,swe-sim,math-state,chat-nuance \
 *     --strategies oracle,truncate,cesium-legacy,codex-style,claude-style,gemini-style,opencode-style,cesium-ledger@0.35 \
 *     --window 16000 \
 *     --compactor-model turbo \
 *     --probe-model kimi-k3 \
 *     --out bench-results/run.json
 *
 * Env: BENCH_API_KEY / CESIUM_API_KEY / OPENAI_API_KEY, BENCH_BASE_URL (optional).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentStoredEvent } from "../../src/lib/agents/types.js";
import type { CesiumHistoryMessage } from "../../src/lib/agents/cesium/cesium-types.js";
import {
  chatNuanceScenario,
  factThreadScenario,
  mathStateScenario,
  sweSimScenario,
  type BenchProbe,
  type BenchScenario,
} from "./scenarios.js";
import { generateGauntletScript, gauntletToScenario, type GauntletPreset } from "./gauntlet.js";
import { resolveStrategies, type Strategy, type StrategyStats } from "./strategies.js";
import { benchChat, benchModelUsage, makeBenchCaller } from "./model-client.js";

export function resolveScenarios(spec: string, seed?: number): BenchScenario[] {
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => {
      const gauntlet = id.match(/^gauntlet-([sml])$/);
      if (gauntlet) {
        return gauntletToScenario(
          generateGauntletScript({ preset: gauntlet[1] as GauntletPreset, seed })
        );
      }
      switch (id) {
        case "fact-thread":
          return factThreadScenario({ seed });
        case "swe-sim":
          return sweSimScenario({ seed });
        case "math-state":
          return mathStateScenario({ seed });
        case "chat-nuance":
          return chatNuanceScenario({ seed });
        default:
          throw new Error(
            `Unknown scenario "${id}". Known: fact-thread, swe-sim, math-state, chat-nuance, gauntlet-s, gauntlet-m, gauntlet-l`
          );
      }
    });
}

type CliOptions = {
  scenarios: string;
  strategies: string;
  window: number;
  compactorModel: string;
  probeModel: string;
  out: string | null;
  probeConcurrency: number;
  seed: number | undefined;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenarios: "fact-thread,swe-sim,math-state,chat-nuance",
    strategies:
      "oracle,truncate,cesium-legacy,codex-style,claude-style,gemini-style,opencode-style,cesium-ledger@0.35",
    window: 16_000,
    compactorModel: "turbo",
    probeModel: "kimi-k3",
    out: null,
    probeConcurrency: 4,
    seed: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index]!;
    switch (arg) {
      case "--scenarios":
        options.scenarios = next();
        break;
      case "--strategies":
        options.strategies = next();
        break;
      case "--window":
        options.window = Number(next());
        break;
      case "--compactor-model":
        options.compactorModel = next();
        break;
      case "--probe-model":
        options.probeModel = next();
        break;
      case "--out":
        options.out = next();
        break;
      case "--probe-concurrency":
        options.probeConcurrency = Number(next());
        break;
      case "--seed":
        options.seed = Number(next());
        break;
      case "--help":
        console.log(
          "Flags: --scenarios a,b --strategies x,y --window N --compactor-model M --probe-model M --out file.json --probe-concurrency N --seed N"
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag ${arg}`);
    }
  }
  return options;
}

/** Split a scenario's events into turn batches (user message → next user message). */
function turnBatches(events: AgentStoredEvent[]): AgentStoredEvent[][] {
  const batches: AgentStoredEvent[][] = [];
  let current: AgentStoredEvent[] = [];
  for (const event of events) {
    if (event.kind === "user_message" && current.length > 0) {
      batches.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function scoreProbe(probe: BenchProbe, answer: string): boolean {
  const normalized = normalizeAnswer(answer);
  if (probe.matcher === "number") {
    const numbers = normalized.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return probe.expected.some((expected) => numbers.includes(expected));
  }
  return probe.expected.some((expected) => normalized.includes(normalizeAnswer(expected)));
}

async function askProbe(input: {
  messages: CesiumHistoryMessage[];
  probe: BenchProbe;
  probeModel: string;
}): Promise<{ answer: string; correct: boolean }> {
  const chatMessages = input.messages
    .filter((message) => message.role !== "tool")
    .map((message) => ({
      role: message.role as "system" | "user" | "assistant",
      content:
        message.toolCalls && message.toolCalls.length > 0
          ? `${message.content}\n[called tools: ${message.toolCalls.map((call) => call.name).join(", ")}]`
          : message.content,
    }))
    .filter((message) => message.content.trim().length > 0);
  chatMessages.push({
    role: "user",
    content:
      `Answer strictly from the conversation context above (including any context ledger or summaries). ` +
      `Question: ${input.probe.question}\n` +
      `Reply with only the answer — no explanation. If the information is truly absent, reply exactly UNKNOWN.`,
  });
  const answer = await benchChat({
    model: input.probeModel,
    messages: chatMessages,
    maxTokens: 8_000,
    temperature: 0,
  });
  return { answer: answer.trim(), correct: scoreProbe(input.probe, answer) };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export type ProbeResult = {
  probeId: string;
  category: string;
  question: string;
  expected: string[];
  answer: string;
  correct: boolean;
};

export type StrategyScenarioResult = {
  scenarioId: string;
  strategyId: string;
  windowTokens: number;
  stats: StrategyStats;
  probes: ProbeResult[];
  accuracy: number;
  byCategory: Record<string, { correct: number; total: number }>;
  wallTimeMs: number;
  error?: string;
};

async function runOne(input: {
  scenario: BenchScenario;
  strategy: Strategy;
  windowTokens: number;
  compactorModel: string;
  probeModel: string;
  probeConcurrency: number;
}): Promise<StrategyScenarioResult> {
  const startedAt = Date.now();
  const callModel = makeBenchCaller(input.compactorModel);
  const run = input.strategy.createRun({ windowTokens: input.windowTokens, callModel });
  try {
    for (const batch of turnBatches(input.scenario.events)) {
      await run.feed(batch);
    }
    const { messages, stats } = await run.finalize();
    const probes = await mapWithConcurrency(
      input.scenario.probes,
      input.probeConcurrency,
      async (probe): Promise<ProbeResult> => {
        try {
          const { answer, correct } = await askProbe({
            messages,
            probe,
            probeModel: input.probeModel,
          });
          return {
            probeId: probe.id,
            category: probe.category,
            question: probe.question,
            expected: probe.expected,
            answer,
            correct,
          };
        } catch (error) {
          return {
            probeId: probe.id,
            category: probe.category,
            question: probe.question,
            expected: probe.expected,
            answer: `PROBE-ERROR: ${error instanceof Error ? error.message : String(error)}`,
            correct: false,
          };
        }
      }
    );
    const byCategory: Record<string, { correct: number; total: number }> = {};
    for (const probe of probes) {
      const bucket = (byCategory[probe.category] ??= { correct: 0, total: 0 });
      bucket.total += 1;
      if (probe.correct) {
        bucket.correct += 1;
      }
    }
    return {
      scenarioId: input.scenario.id,
      strategyId: input.strategy.id,
      windowTokens: input.windowTokens,
      stats,
      probes,
      accuracy: probes.length ? probes.filter((probe) => probe.correct).length / probes.length : 0,
      byCategory,
      wallTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenarioId: input.scenario.id,
      strategyId: input.strategy.id,
      windowTokens: input.windowTokens,
      stats: { compactions: 0, compactorCalls: 0, finalTokens: 0, peakTokens: 0 },
      probes: [],
      accuracy: 0,
      byCategory: {},
      wallTimeMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatTable(results: StrategyScenarioResult[]): string {
  const scenarioIds = [...new Set(results.map((result) => result.scenarioId))];
  const strategyIds = [...new Set(results.map((result) => result.strategyId))];
  const rows: string[] = [];
  const header = ["strategy".padEnd(26), ...scenarioIds.map((id) => id.padEnd(13)), "MEAN".padEnd(6), "cmp", "tok(final)"];
  rows.push(header.join(" "));
  rows.push("-".repeat(header.join(" ").length));
  for (const strategyId of strategyIds) {
    const cells: string[] = [strategyId.padEnd(26)];
    const accuracies: number[] = [];
    let compactions = 0;
    let finalTokens = 0;
    let count = 0;
    for (const scenarioId of scenarioIds) {
      const result = results.find(
        (candidate) => candidate.scenarioId === scenarioId && candidate.strategyId === strategyId
      );
      if (!result || result.error) {
        cells.push((result?.error ? "ERROR" : "-").padEnd(13));
        continue;
      }
      accuracies.push(result.accuracy);
      compactions += result.stats.compactions;
      finalTokens += result.stats.finalTokens;
      count += 1;
      const correct = result.probes.filter((probe) => probe.correct).length;
      cells.push(`${(result.accuracy * 100).toFixed(0)}% (${correct}/${result.probes.length})`.padEnd(13));
    }
    const mean = accuracies.length
      ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length
      : 0;
    cells.push(`${(mean * 100).toFixed(0)}%`.padEnd(6));
    cells.push(String(compactions).padEnd(3));
    cells.push(count ? String(Math.round(finalTokens / count)) : "-");
    rows.push(cells.join(" "));
  }
  return rows.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = resolveScenarios(options.scenarios, options.seed);
  if (scenarios.length === 0) {
    throw new Error(`No scenarios matched "${options.scenarios}".`);
  }
  const strategies = resolveStrategies(options.strategies);
  console.log(
    `Compaction bench: window=${options.window} tokens, compactor=${options.compactorModel}, probe=${options.probeModel}`
  );
  console.log(
    `Scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")} | Strategies: ${strategies
      .map((strategy) => strategy.id)
      .join(", ")}\n`
  );
  const results: StrategyScenarioResult[] = [];
  for (const scenario of scenarios) {
    for (const strategy of strategies) {
      process.stdout.write(`▸ ${scenario.id} × ${strategy.id} … `);
      const result = await runOne({
        scenario,
        strategy,
        windowTokens: options.window,
        compactorModel: options.compactorModel,
        probeModel: options.probeModel,
        probeConcurrency: options.probeConcurrency,
      });
      results.push(result);
      if (result.error) {
        console.log(`ERROR: ${result.error}`);
      } else {
        console.log(
          `${(result.accuracy * 100).toFixed(0)}% (${result.probes.filter((probe) => probe.correct).length}/${result.probes.length}) ` +
            `compactions=${result.stats.compactions} finalTok=${result.stats.finalTokens} ${(result.wallTimeMs / 1000).toFixed(1)}s`
        );
      }
    }
  }
  console.log(`\n${formatTable(results)}\n`);
  console.log(`Model usage: ${JSON.stringify(benchModelUsage())}`);
  if (options.out) {
    const outPath = path.resolve(options.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          options,
          results,
        },
        null,
        2
      )
    );
    console.log(`Results written to ${outPath}`);
  }
}

// Run only when executed directly (not imported by tests).
const invokedDirectly =
  process.argv[1]?.endsWith("run-bench.ts") || process.argv[1]?.endsWith("run-bench.js");
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
