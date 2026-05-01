import { readFile } from "node:fs/promises";

type Scenario = {
  name: string;
  p50: number;
  p95: number;
  p99: number;
  failures?: string[];
};

type PerfReport = {
  at: string;
  scenarios: Scenario[];
};

function pctDelta(before: number, after: number): number | null {
  if (!Number.isFinite(before) || before <= 0) {
    return null;
  }
  return ((after - before) / before) * 100;
}

async function readReport(path: string): Promise<PerfReport> {
  return JSON.parse(await readFile(path, "utf8")) as PerfReport;
}

const [nodePath, bunPath] = process.argv.slice(2);
if (!nodePath || !bunPath) {
  console.error("Usage: tsx scripts/perf-compare.ts <node-report.json> <bun-report.json>");
  process.exit(1);
}

const [nodeReport, bunReport] = await Promise.all([
  readReport(nodePath),
  readReport(bunPath),
]);
const bunByName = new Map(bunReport.scenarios.map((scenario) => [scenario.name, scenario]));
const rows = nodeReport.scenarios.flatMap((nodeScenario) => {
  const bunScenario = bunByName.get(nodeScenario.name);
  if (!bunScenario) {
    return [];
  }
  return [
    {
      name: nodeScenario.name,
      nodeP95: nodeScenario.p95,
      bunP95: bunScenario.p95,
      deltaPct: pctDelta(nodeScenario.p95, bunScenario.p95),
      nodeFailures: nodeScenario.failures?.length ?? 0,
      bunFailures: bunScenario.failures?.length ?? 0,
    },
  ];
});

console.log(
  JSON.stringify(
    {
      node: { path: nodePath, at: nodeReport.at },
      bun: { path: bunPath, at: bunReport.at },
      rows,
    },
    null,
    2
  )
);
