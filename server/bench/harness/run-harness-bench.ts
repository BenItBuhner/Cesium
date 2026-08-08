/**
 * Cross-harness compaction benchmark.
 *
 * Feeds byte-identical user turns (a gauntlet script in flat form) through the
 * REAL harnesses — Codex CLI, Claude Code, OpenCode, and the Cesium agent —
 * each connected to the same Model-Proxy model, each running its OWN
 * history/compaction machinery. After feeding, recall probes are asked
 * in-session and scored per category.
 *
 * Usage (from server/):
 *   bun bench/harness/run-harness-bench.ts \
 *     --drivers cesium,codex,opencode,claude \
 *     --preset s --seed 42 --window 16000 \
 *     --model kimi-k3 \
 *     --cesium-server http://localhost:9100 \
 *     --cesium-workspace <workspaceId> \
 *     --out bench-results/harness-s-seed42.json
 *
 * Notes:
 *  - Codex + OpenCode + Cesium honor the window override; Claude Code manages
 *    its own window, so a forced "/compact" is issued after feeding to make it
 *    exercise its compaction machinery (flagged in results).
 *  - Env: TECHLIT/OPENAI key via BENCH_API_KEY / CESIUM_API_KEY / OPENAI_API_KEY.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateGauntletScript, gauntletToFlatTurns, type GauntletPreset } from "../compaction/gauntlet.js";
import type { BenchProbe } from "../compaction/scenarios.js";
import { scoreProbe } from "../compaction/run-bench.js";
import { benchApiKey, benchBaseUrl } from "../compaction/model-client.js";
import { resolveDrivers, type HarnessDriver } from "./drivers.js";

type CliOptions = {
  drivers: string;
  preset: GauntletPreset;
  seed: number;
  window: number;
  model: string;
  cesiumServer: string;
  cesiumWorkspace: string;
  cesiumModelId: string;
  out: string | null;
  sendTimeoutMs: number;
  maxTurnRetries: number;
  /** Smoke-test overrides. */
  turns: number | undefined;
  facts: number | undefined;
  probes: number | undefined;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    drivers: "cesium,codex,opencode",
    preset: "s",
    seed: 42,
    window: 16_000,
    model: "kimi-k3",
    cesiumServer: process.env.CESIUM_BENCH_SERVER ?? "http://localhost:9100",
    cesiumWorkspace: process.env.CESIUM_BENCH_WORKSPACE ?? "",
    cesiumModelId: process.env.CESIUM_BENCH_MODEL ?? "techlit/kimi-k3",
    out: null,
    sendTimeoutMs: 420_000,
    maxTurnRetries: 2,
    turns: undefined,
    facts: undefined,
    probes: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index]!;
    switch (arg) {
      case "--drivers": options.drivers = next(); break;
      case "--preset": options.preset = next() as GauntletPreset; break;
      case "--seed": options.seed = Number(next()); break;
      case "--window": options.window = Number(next()); break;
      case "--model": options.model = next(); break;
      case "--cesium-server": options.cesiumServer = next(); break;
      case "--cesium-workspace": options.cesiumWorkspace = next(); break;
      case "--cesium-model": options.cesiumModelId = next(); break;
      case "--out": options.out = next(); break;
      case "--send-timeout": options.sendTimeoutMs = Number(next()); break;
      case "--turns": options.turns = Number(next()); break;
      case "--facts": options.facts = Number(next()); break;
      case "--probes": options.probes = Number(next()); break;
      case "--help":
        console.log(
          "Flags: --drivers a,b --preset s|m|l --seed N --window N --model M --cesium-server URL --cesium-workspace ID --cesium-model ID --out file.json --send-timeout MS"
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag ${arg}`);
    }
  }
  return options;
}

const PROBE_PREAMBLE =
  "Now I need precise answers from everything above in this session. Answer from your memory of THIS conversation only. " +
  "Reply with only the answer, no explanation. If the information truly never appeared, reply exactly UNKNOWN.";

export type HarnessProbeResult = {
  probeId: string;
  category: string;
  question: string;
  expected: string[];
  answer: string;
  correct: boolean;
};

export type HarnessRunResult = {
  driverId: string;
  preset: string;
  seed: number;
  windowTokens: number;
  windowEnforced: boolean;
  feedTurns: number;
  feedErrors: number;
  forcedCompact: boolean;
  probes: HarnessProbeResult[];
  accuracy: number;
  byCategory: Record<string, { correct: number; total: number }>;
  wallTimeMs: number;
  error?: string;
};

async function runDriver(input: {
  driver: HarnessDriver;
  turns: string[];
  probes: BenchProbe[];
  options: CliOptions;
}): Promise<HarnessRunResult> {
  const { driver, turns, probes, options } = input;
  const startedAt = Date.now();
  const workDir = path.join(
    os.tmpdir(),
    `harness-bench-${driver.id}-${options.preset}-${options.seed}-${Date.now()}`
  );
  mkdirSync(workDir, { recursive: true });
  const base: Omit<HarnessRunResult, "probes" | "accuracy" | "byCategory" | "wallTimeMs"> = {
    driverId: driver.id,
    preset: options.preset,
    seed: options.seed,
    windowTokens: options.window,
    windowEnforced: driver.supportsWindowOverride,
    feedTurns: turns.length,
    feedErrors: 0,
    forcedCompact: false,
  };
  try {
    const session = await driver.createSession({
      baseUrl: benchBaseUrl(),
      apiKey: benchApiKey(),
      model: options.model,
      contextWindowTokens: options.window,
      workDir,
      sendTimeoutMs: options.sendTimeoutMs,
      allowTools: false,
    });
    let feedErrors = 0;
    for (let index = 0; index < turns.length; index += 1) {
      const text = turns[index]!;
      let sent = false;
      for (let attempt = 0; attempt <= options.maxTurnRetries && !sent; attempt += 1) {
        try {
          await session.send(text);
          sent = true;
        } catch (error) {
          if (attempt === options.maxTurnRetries) {
            feedErrors += 1;
            console.warn(
              `  [${driver.id}] feed turn ${index + 1}/${turns.length} failed permanently: ${
                error instanceof Error ? error.message.slice(0, 200) : String(error)
              }`
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
        }
      }
      if ((index + 1) % 10 === 0) {
        process.stdout.write(`  [${driver.id}] fed ${index + 1}/${turns.length} turns\n`);
      }
    }
    // Claude Code cannot be window-constrained for third-party models; force a
    // compaction so its machinery is actually exercised before probing.
    let forcedCompact = false;
    if (!driver.supportsWindowOverride) {
      try {
        await session.send("/compact");
        forcedCompact = true;
      } catch (error) {
        console.warn(
          `  [${driver.id}] forced /compact failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`
        );
      }
    }
    // Probe in-session, one at a time (the preamble rides on the first probe).
    const probeResults: HarnessProbeResult[] = [];
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index]!;
      const prompt = `${index === 0 ? `${PROBE_PREAMBLE}\n\n` : ""}Question: ${probe.question}`;
      let answer = "";
      try {
        answer = await session.send(prompt);
      } catch (error) {
        answer = `PROBE-ERROR: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
      }
      probeResults.push({
        probeId: probe.id,
        category: probe.category,
        question: probe.question,
        expected: probe.expected,
        answer: answer.trim(),
        correct: scoreProbe(probe, answer),
      });
      if ((index + 1) % 10 === 0) {
        process.stdout.write(`  [${driver.id}] probed ${index + 1}/${probes.length}\n`);
      }
    }
    await session.dispose();
    const byCategory: Record<string, { correct: number; total: number }> = {};
    for (const probe of probeResults) {
      const bucket = (byCategory[probe.category] ??= { correct: 0, total: 0 });
      bucket.total += 1;
      if (probe.correct) bucket.correct += 1;
    }
    return {
      ...base,
      feedErrors,
      forcedCompact,
      probes: probeResults,
      accuracy: probeResults.length
        ? probeResults.filter((probe) => probe.correct).length / probeResults.length
        : 0,
      byCategory,
      wallTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      probes: [],
      accuracy: 0,
      byCategory: {},
      wallTimeMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatCategoryTable(results: HarnessRunResult[]): string {
  const categories = [
    ...new Set(results.flatMap((result) => Object.keys(result.byCategory))),
  ].sort();
  const rows: string[] = [];
  rows.push(
    ["driver".padEnd(10), "TOTAL".padEnd(12), ...categories.map((cat) => cat.padEnd(13))].join(" ")
  );
  rows.push("-".repeat(12 + 13 + categories.length * 14));
  for (const result of results) {
    const cells = [result.driverId.padEnd(10)];
    const total = result.probes.length;
    const correct = result.probes.filter((probe) => probe.correct).length;
    cells.push(
      `${total ? Math.round((correct / total) * 100) : 0}% (${correct}/${total})`.padEnd(12)
    );
    for (const category of categories) {
      const bucket = result.byCategory[category];
      cells.push(
        (bucket ? `${Math.round((bucket.correct / bucket.total) * 100)}% (${bucket.correct}/${bucket.total})` : "-").padEnd(13)
      );
    }
    rows.push(cells.join(" "));
  }
  return rows.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const script = generateGauntletScript({
    preset: options.preset,
    seed: options.seed,
    turns: options.turns,
    facts: options.facts,
    probes: options.probes,
  });
  const turns = gauntletToFlatTurns(script);
  const drivers = resolveDrivers(options.drivers, {
    serverUrl: options.cesiumServer,
    workspaceId: options.cesiumWorkspace,
    modelId: options.cesiumModelId,
  });
  console.log(
    `Cross-harness gauntlet: preset=${options.preset} seed=${options.seed} turns=${turns.length} probes=${script.probes.length} window=${options.window} model=${options.model}`
  );
  console.log(`Drivers: ${drivers.map((driver) => driver.id).join(", ")}\n`);
  const results: HarnessRunResult[] = [];
  for (const driver of drivers) {
    console.log(`▸ ${driver.id} (${driver.label}) …`);
    const result = await runDriver({ driver, turns, probes: script.probes, options });
    results.push(result);
    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      console.log(
        `  ${(result.accuracy * 100).toFixed(0)}% (${result.probes.filter((probe) => probe.correct).length}/${result.probes.length}) ` +
          `feedErrors=${result.feedErrors} forcedCompact=${result.forcedCompact} ${(result.wallTimeMs / 60000).toFixed(1)}min`
      );
    }
  }
  console.log(`\n${formatCategoryTable(results)}\n`);
  if (options.out) {
    const outPath = path.resolve(options.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify({ ranAt: new Date().toISOString(), options, results }, null, 2)
    );
    console.log(`Results written to ${outPath}`);
  }
}

const invokedDirectly =
  process.argv[1]?.endsWith("run-harness-bench.ts") ||
  process.argv[1]?.endsWith("run-harness-bench.js");
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
