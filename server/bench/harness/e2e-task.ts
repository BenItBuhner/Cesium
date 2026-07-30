/**
 * End-to-end task bench: implementation after heavy context pressure.
 *
 * A fabricated repository ships with STRUCTURAL tests only. The actual
 * specification (pricing constants, discount rules, surcharges) is delivered
 * conversationally in early turns, then buried under gauntlet noise. The
 * final turn asks the harness to implement the module from memory.
 *
 * Scoring separates two things:
 *  - structuralPass: the repo's own tests pass (function exists, basic shape)
 *  - graderScore:    fraction of hidden ground-truth cases computed correctly —
 *    achievable ONLY by remembering the conversational spec through whatever
 *    compaction the harness performed (the constants appear nowhere on disk).
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateGauntletScript, gauntletToFlatTurns } from "../compaction/gauntlet.js";

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

const REGIONS = ["us-east-1", "eu-west-2", "ap-south-1", "sa-east-1"];

export type PricingSpec = {
  rates: { standard: number; priority: number; bulk: number };
  discountPercent: number;
  discountThreshold: number;
  surcharge: number;
  surchargeRegion: string;
};

export type E2ETask = {
  id: string;
  seed: number;
  spec: PricingSpec;
  repoFiles: Record<string, string>;
  /** Conversation: spec fragments, noise, then the implementation order. */
  turns: string[];
  groundTruthCases: Array<{ tier: string; quantity: number; region: string; expected: number }>;
};

export function computePrice(spec: PricingSpec, tier: string, quantity: number, region: string): number {
  const rate = spec.rates[tier as keyof PricingSpec["rates"]];
  if (rate == null) {
    throw new Error(`unknown tier ${tier}`);
  }
  let total = rate * quantity;
  if (quantity > spec.discountThreshold) {
    total *= 1 - spec.discountPercent / 100;
  }
  if (region === spec.surchargeRegion) {
    total += spec.surcharge;
  }
  return Math.round(total * 100) / 100;
}

export function generateE2ETask(options: { seed?: number; noiseTurns?: number } = {}): E2ETask {
  const seed = options.seed ?? 4242;
  const rand = mulberry32(seed);
  const money = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100) / 100;
  const spec: PricingSpec = {
    rates: {
      standard: money(2, 9),
      priority: money(9, 18),
      bulk: money(0.8, 2.5),
    },
    discountPercent: Math.floor(5 + rand() * 25),
    discountThreshold: Math.floor(8 + rand() * 40),
    surcharge: money(1.5, 9),
    surchargeRegion: REGIONS[Math.floor(rand() * REGIONS.length)]!,
  };

  const repoFiles: Record<string, string> = {
    "package.json": JSON.stringify(
      { name: "pricing-service", version: "0.0.1", type: "commonjs", scripts: { test: "node --test test/" } },
      null,
      2
    ),
    "lib/pricing.js": [
      "'use strict';",
      "",
      "// TODO: implement per the agreed pricing spec (discussed in our session).",
      "// Signature: priceFor(tier, quantity, region) -> number (2-decimal rounded)",
      "function priceFor(tier, quantity, region) {",
      "  throw new Error('not implemented');",
      "}",
      "",
      "module.exports = { priceFor };",
      "",
    ].join("\n"),
    "test/pricing.test.js": [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { priceFor } = require('../lib/pricing.js');",
      "",
      "test('priceFor is a function returning finite numbers for known tiers', () => {",
      "  for (const tier of ['standard', 'priority', 'bulk']) {",
      "    const value = priceFor(tier, 3, 'us-east-1');",
      "    assert.equal(typeof value, 'number');",
      "    assert.ok(Number.isFinite(value));",
      "    assert.ok(value > 0);",
      "  }",
      "});",
      "",
      "test('price scales with quantity', () => {",
      "  assert.ok(priceFor('standard', 4, 'us-east-1') > priceFor('standard', 1, 'us-east-1'));",
      "});",
      "",
      "test('unknown tier throws', () => {",
      "  assert.throws(() => priceFor('platinum', 1, 'us-east-1'));",
      "});",
      "",
    ].join("\n"),
    "README.md": [
      "# pricing-service",
      "",
      "Implements the session-agreed pricing model in `lib/pricing.js`.",
      "The authoritative constants were agreed in conversation, not in this repo.",
      "Run `npm test` for structural checks.",
      "",
    ].join("\n"),
  };

  const specTurns = [
    `Let's lock the pricing model for the pricing-service repo. Base rates per unit: standard = $${spec.rates.standard.toFixed(2)}, priority = $${spec.rates.priority.toFixed(2)}, bulk = $${spec.rates.bulk.toFixed(2)}. Just acknowledge — implementation comes later. Reply: Noted.`,
    `Pricing model continued: quantity discount — STRICTLY more than ${spec.discountThreshold} units gets ${spec.discountPercent}% off the subtotal (applies before any surcharge). Reply: Noted.`,
    `Pricing model final piece: a flat $${spec.surcharge.toFixed(2)} regional surcharge added at the very end, ONLY for region "${spec.surchargeRegion}". Final result rounds to 2 decimals. Unknown tiers must throw an Error. Reply: Noted.`,
  ];
  // Bury the spec under gauntlet noise (facts and logs from an unrelated script).
  const noiseScript = generateGauntletScript({
    preset: "s",
    seed: seed ^ 0x9e3779b9,
    turns: options.noiseTurns ?? 14,
    facts: 80,
    probes: 1,
  });
  const noiseTurns = gauntletToFlatTurns(noiseScript);
  const finalTurn =
    "Back to the pricing-service repo you are sitting in. Implement lib/pricing.js NOW, exactly per the pricing model we agreed earlier in this session (base rates, quantity discount rule, regional surcharge, rounding, unknown-tier behavior). " +
    "Do not invent numbers — use the agreed constants from our conversation. Edit the file and run `npm test` to confirm the structural tests pass, then reply DONE.";

  // Ground truth cases exercising every rule.
  const otherRegion = REGIONS.find((region) => region !== spec.surchargeRegion)!;
  const groundTruthCases = [
    { tier: "standard", quantity: 2, region: otherRegion },
    { tier: "priority", quantity: spec.discountThreshold, region: otherRegion },
    { tier: "priority", quantity: spec.discountThreshold + 1, region: otherRegion },
    { tier: "bulk", quantity: spec.discountThreshold + 20, region: spec.surchargeRegion },
    { tier: "standard", quantity: 1, region: spec.surchargeRegion },
    { tier: "bulk", quantity: 5, region: otherRegion },
  ].map((entry) => ({
    ...entry,
    expected: computePrice(spec, entry.tier, entry.quantity, entry.region),
  }));

  return {
    id: `e2e-pricing-${seed}`,
    seed,
    spec,
    repoFiles,
    turns: [...specTurns, ...noiseTurns, finalTurn],
    groundTruthCases,
  };
}

export function materializeRepo(task: E2ETask, dir: string): void {
  for (const [relative, contents] of Object.entries(task.repoFiles)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function execCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out]` });
    }, timeoutMs);
    child.stdout.on("data", (data) => (stdout += String(data)));
    child.stderr.on("data", (data) => (stderr += String(data)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export type E2EGrade = {
  structuralPass: boolean;
  graderScore: number;
  graderDetails: Array<{ case: string; expected: number; got: number | string; correct: boolean }>;
};

export async function gradeE2ETask(task: E2ETask, repoDir: string): Promise<E2EGrade> {
  const structural = await execCapture("node", ["--test", "test/"], repoDir, 60_000);
  const structuralPass = structural.code === 0;
  const caseScript = [
    "const { priceFor } = require('./lib/pricing.js');",
    `const cases = ${JSON.stringify(task.groundTruthCases.map(({ tier, quantity, region }) => ({ tier, quantity, region })))};`,
    "const out = cases.map((c) => { try { return priceFor(c.tier, c.quantity, c.region); } catch (e) { return String(e && e.message || e); } });",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const grader = await execCapture("node", ["-e", caseScript], repoDir, 30_000);
  const graderDetails: E2EGrade["graderDetails"] = [];
  let correct = 0;
  try {
    const outputs = JSON.parse(grader.stdout.trim().split("\n").pop() ?? "[]") as Array<number | string>;
    task.groundTruthCases.forEach((entry, index) => {
      const got = outputs[index] ?? "missing";
      const ok = typeof got === "number" && Math.abs(got - entry.expected) < 0.005;
      if (ok) correct += 1;
      graderDetails.push({
        case: `${entry.tier} x${entry.quantity} @${entry.region}`,
        expected: entry.expected,
        got,
        correct: ok,
      });
    });
  } catch {
    task.groundTruthCases.forEach((entry) => {
      graderDetails.push({
        case: `${entry.tier} x${entry.quantity} @${entry.region}`,
        expected: entry.expected,
        got: `grader failed: ${(grader.stderr || grader.stdout).slice(0, 120)}`,
        correct: false,
      });
    });
  }
  return {
    structuralPass,
    graderScore: task.groundTruthCases.length ? correct / task.groundTruthCases.length : 0,
    graderDetails,
  };
}
