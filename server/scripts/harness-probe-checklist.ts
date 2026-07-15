import { buildHarnessProbeChecklist } from "../src/lib/agents/harness-probe-scenarios.js";

const checklist = buildHarnessProbeChecklist();

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      total: checklist.length,
      checklist,
    },
    null,
    2
  )}\n`
);
