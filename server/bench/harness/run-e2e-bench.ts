/**
 * End-to-end cross-harness task bench.
 *
 * Each REAL harness gets its own copy of a fabricated repo, receives the
 * pricing spec conversationally, suffers gauntlet noise (heavy enough to force
 * compaction at the constrained window), and is then ordered to implement the
 * module from memory. Scored by (a) the repo's structural tests and (b) a
 * hidden ground-truth grader whose constants exist only in the conversation.
 *
 * Usage (from server/):
 *   bun bench/harness/run-e2e-bench.ts \
 *     --drivers cesium,codex,opencode \
 *     --seed 4242 --window 16000 --model kimi-k3 \
 *     --cesium-server http://localhost:9100 \
 *     --out bench-results/e2e-seed4242.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { generateE2ETask, gradeE2ETask, materializeRepo, type E2EGrade } from "./e2e-task.js";
import { benchApiKey, benchBaseUrl } from "../compaction/model-client.js";
import { resolveDrivers, type HarnessDriver } from "./drivers.js";

type CliOptions = {
  drivers: string;
  seed: number;
  window: number;
  model: string;
  noiseTurns: number;
  cesiumServer: string;
  cesiumWorkspace: string;
  cesiumModelId: string;
  out: string | null;
  sendTimeoutMs: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    drivers: "cesium,codex,opencode",
    seed: 4242,
    window: 16_000,
    model: "kimi-k3",
    noiseTurns: 14,
    cesiumServer: process.env.CESIUM_BENCH_SERVER ?? "http://localhost:9100",
    cesiumWorkspace: process.env.CESIUM_BENCH_WORKSPACE ?? "",
    cesiumModelId: process.env.CESIUM_BENCH_MODEL ?? "techlit/kimi-k3",
    out: null,
    sendTimeoutMs: 600_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index]!;
    switch (arg) {
      case "--drivers": options.drivers = next(); break;
      case "--seed": options.seed = Number(next()); break;
      case "--window": options.window = Number(next()); break;
      case "--model": options.model = next(); break;
      case "--noise-turns": options.noiseTurns = Number(next()); break;
      case "--cesium-server": options.cesiumServer = next(); break;
      case "--cesium-workspace": options.cesiumWorkspace = next(); break;
      case "--cesium-model": options.cesiumModelId = next(); break;
      case "--out": options.out = next(); break;
      case "--send-timeout": options.sendTimeoutMs = Number(next()); break;
      default:
        throw new Error(`Unknown flag ${arg}`);
    }
  }
  return options;
}

export type E2EResult = {
  driverId: string;
  seed: number;
  windowTokens: number;
  turns: number;
  feedErrors: number;
  grade: E2EGrade | null;
  wallTimeMs: number;
  finalReply?: string;
  error?: string;
};

async function runDriver(input: {
  driver: HarnessDriver;
  options: CliOptions;
}): Promise<E2EResult> {
  const { driver, options } = input;
  const startedAt = Date.now();
  const task = generateE2ETask({ seed: options.seed, noiseTurns: options.noiseTurns });
  const workDir = path.join(os.tmpdir(), `e2e-bench-${driver.id}-${options.seed}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  materializeRepo(task, workDir);
  // A real git repo keeps harnesses comfortable (codex, claude expect one).
  spawnSync("git", ["init", "-q"], { cwd: workDir });
  spawnSync("git", ["add", "-A"], { cwd: workDir });
  spawnSync("git", ["-c", "user.email=bench@bench", "-c", "user.name=bench", "commit", "-qm", "scaffold"], {
    cwd: workDir,
  });
  try {
    const session = await driver.createSession({
      baseUrl: benchBaseUrl(),
      apiKey: benchApiKey(),
      model: options.model,
      contextWindowTokens: options.window,
      workDir,
      sendTimeoutMs: options.sendTimeoutMs,
      allowTools: true,
    });
    let feedErrors = 0;
    let finalReply = "";
    for (let index = 0; index < task.turns.length; index += 1) {
      const isFinal = index === task.turns.length - 1;
      try {
        const reply = await session.send(task.turns[index]!);
        if (isFinal) {
          finalReply = reply;
        }
      } catch (error) {
        feedErrors += 1;
        console.warn(
          `  [${driver.id}] turn ${index + 1}/${task.turns.length} failed: ${
            error instanceof Error ? error.message.slice(0, 200) : String(error)
          }`
        );
        if (isFinal) {
          throw error;
        }
      }
      if ((index + 1) % 5 === 0) {
        process.stdout.write(`  [${driver.id}] ${index + 1}/${task.turns.length} turns\n`);
      }
    }
    await session.dispose();
    const grade = await gradeE2ETask(task, workDir);
    return {
      driverId: driver.id,
      seed: options.seed,
      windowTokens: options.window,
      turns: task.turns.length,
      feedErrors,
      grade,
      finalReply: finalReply.slice(0, 500),
      wallTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      driverId: driver.id,
      seed: options.seed,
      windowTokens: options.window,
      turns: task.turns.length,
      feedErrors: 0,
      grade: null,
      wallTimeMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const drivers = resolveDrivers(options.drivers, {
    serverUrl: options.cesiumServer,
    workspaceId: options.cesiumWorkspace,
    modelId: options.cesiumModelId,
  });
  const task = generateE2ETask({ seed: options.seed, noiseTurns: options.noiseTurns });
  console.log(
    `E2E task bench: seed=${options.seed} turns=${task.turns.length} window=${options.window} model=${options.model}`
  );
  console.log(`Spec (hidden from repos): ${JSON.stringify(task.spec)}\n`);
  const results: E2EResult[] = [];
  for (const driver of drivers) {
    console.log(`▸ ${driver.id} …`);
    const result = await runDriver({ driver, options });
    results.push(result);
    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else if (result.grade) {
      console.log(
        `  structural=${result.grade.structuralPass ? "PASS" : "FAIL"} grader=${(result.grade.graderScore * 100).toFixed(0)}% ` +
          `feedErrors=${result.feedErrors} ${(result.wallTimeMs / 60000).toFixed(1)}min`
      );
      for (const detail of result.grade.graderDetails) {
        console.log(
          `    ${detail.correct ? "OK  " : "MISS"} ${detail.case}: expected ${detail.expected}, got ${detail.got}`
        );
      }
    }
  }
  console.log("\ndriver     structural  grader");
  console.log("-".repeat(34));
  for (const result of results) {
    console.log(
      `${result.driverId.padEnd(10)} ${result.grade ? (result.grade.structuralPass ? "PASS" : "FAIL") : "ERR "}        ${
        result.grade ? `${(result.grade.graderScore * 100).toFixed(0)}%` : "-"
      }`
    );
  }
  if (options.out) {
    const outPath = path.resolve(options.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify({ ranAt: new Date().toISOString(), options, results }, null, 2)
    );
    console.log(`\nResults written to ${outPath}`);
  }
}

const invokedDirectly =
  process.argv[1]?.endsWith("run-e2e-bench.ts") || process.argv[1]?.endsWith("run-e2e-bench.js");
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
