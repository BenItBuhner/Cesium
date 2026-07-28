/**
 * Remembered-permission reliability stress harness.
 *
 * Exercises the exact persistence pipeline every harness shares — the shared
 * remember/resolve helpers, the global-settings store mutation chain, the
 * settings routes, and the on-disk legacy-json driver — under hostile
 * conditions:
 *
 *   - storage latency jitter (lossy/slow disk or pg connection)
 *   - transient storage failures (connection drops)
 *   - long stalls on a percentage of ops (hanging harness / starved compute)
 *   - concurrent save bursts from parallel sessions
 *   - stale full-settings PUTs racing agent saves (lossy client sync)
 *
 * Per harness it runs ITERATIONS_PER_HARNESS save→resolve cycles using the
 * production toolKey builders for that harness, plus upsert hammering,
 * concurrency bursts, and route-level delete/clear verification.
 *
 * Usage:
 *   bun scripts/remembered-permissions-stress.ts
 *   STRESS_ITERATIONS=2000 STRESS_FAILURE_RATE=0.05 bun scripts/remembered-permissions-stress.ts
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-perm-stress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = DATA_DIR;
process.env.NODE_ENV = "test";

const ITERATIONS_PER_HARNESS = Number(process.env.STRESS_ITERATIONS ?? 1000);
const FAILURE_RATE = Number(process.env.STRESS_FAILURE_RATE ?? 0.03);
const LATENCY_JITTER_MAX_MS = Number(process.env.STRESS_JITTER_MS ?? 6);
const STALL_RATE = Number(process.env.STRESS_STALL_RATE ?? 0.002);
const STALL_MS = Number(process.env.STRESS_STALL_MS ?? 150);
const BURST_SIZE = Number(process.env.STRESS_BURST_SIZE ?? 40);
const BURSTS_PER_HARNESS = Number(process.env.STRESS_BURSTS ?? 4);

const storeModule = await import("../src/lib/global-settings-store.js");
const helperModule = await import("../src/lib/agents/remembered-permissions.js");
const { settingsRoutes } = await import("../src/routes/settings.js");
const { getStorage, __setStorageForTesting } = await import("../src/storage/runtime.js");
const { buildPermissionToolSignature } = await import(
  "../src/lib/agents/acp/acp-tool-parse.js"
);

const {
  clearRememberedAgentPermissionRules,
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} = storeModule;
const {
  buildRememberedPermissionToolKey,
  persistRememberedPermissionChoice,
  resolveRememberedPermissionDecision,
} = helperModule;

type HarnessSpec = {
  backendId: string;
  label: string;
  toolKey: (iteration: number) => string;
};

/** Production toolKey shapes per harness (same builders where exported). */
const HARNESSES: HarnessSpec[] = [
  {
    backendId: "cesium-agent",
    label: "Cesium Agent",
    toolKey: (i) => `cesium:terminal:npm run task-${i}`,
  },
  {
    backendId: "claude-code-sdk",
    label: "Claude Code SDK",
    toolKey: (i) => `Bash:npm run task-${i}`,
  },
  {
    backendId: "cursor-sdk",
    label: "Cursor SDK (ACP)",
    toolKey: (i) =>
      buildPermissionToolSignature({
        record: {},
        toolCall: { title: `Run npm task-${i}`, kind: "execute" },
        title: `Run npm task-${i}`,
        detail: `npm run task-${i}`,
      }).toolKey,
  },
  {
    backendId: "devin-acp",
    label: "Devin (ACP)",
    toolKey: (i) =>
      buildPermissionToolSignature({
        record: {},
        toolCall: { title: `Edit file-${i}.ts`, kind: "edit" },
        title: `Edit file-${i}.ts`,
      }).toolKey,
  },
  {
    backendId: "opencode-server",
    label: "OpenCode Server",
    toolKey: (i) =>
      buildRememberedPermissionToolKey("opencode-server", "Run command", `pwd-${i}`),
  },
  {
    backendId: "opencode-v2-beta",
    label: "OpenCode v2 Beta",
    toolKey: (i) =>
      buildRememberedPermissionToolKey("opencode-v2", "OpenCode requests shell", `task-${i}`),
  },
  {
    backendId: "codex-app-server",
    label: "Codex App Server",
    toolKey: (i) =>
      buildRememberedPermissionToolKey(
        "codex-app-server",
        "item/commandExecution/requestApproval",
        "Approve command",
        `npm run task-${i}`
      ),
  },
  {
    backendId: "google-antigravity-cli",
    label: "Google Antigravity CLI",
    toolKey: (i) =>
      buildRememberedPermissionToolKey(
        "google-antigravity",
        "run_command",
        `target-${i}`,
        "requires shell"
      ),
  },
];

// ---------------------------------------------------------------------------
// Fault injection: wrap the storage driver with latency jitter, transient
// failures, and occasional long stalls on global-settings reads/writes.
// ---------------------------------------------------------------------------

const faultStats = {
  injectedFailures: 0,
  injectedStalls: 0,
  totalOps: 0,
};

let faultsEnabled = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectFaults(op: string): Promise<void> {
  faultStats.totalOps += 1;
  if (!faultsEnabled) return;
  if (Math.random() < STALL_RATE) {
    faultStats.injectedStalls += 1;
    await sleep(STALL_MS);
  } else if (LATENCY_JITTER_MAX_MS > 0) {
    await sleep(Math.random() * LATENCY_JITTER_MAX_MS);
  }
  if (Math.random() < FAILURE_RATE) {
    faultStats.injectedFailures += 1;
    throw new Error(`[stress] injected transient ${op} failure`);
  }
}

const realDriver = await getStorage();
const faultyDriver = new Proxy(realDriver, {
  get(target, prop, receiver) {
    if (prop === "getGlobalSettings") {
      return async () => {
        await injectFaults("getGlobalSettings");
        return target.getGlobalSettings();
      };
    }
    if (prop === "saveGlobalSettings") {
      return async (settings: unknown) => {
        await injectFaults("saveGlobalSettings");
        return target.saveGlobalSettings(settings as never);
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});
__setStorageForTesting(faultyDriver as typeof realDriver);

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

type HarnessReport = {
  backendId: string;
  label: string;
  iterations: number;
  persisted: number;
  resolvedRemembered: number;
  persistDroppedByFaults: number;
  resolveMissesAfterPersist: number;
  resolveTransientPromptFallbacks: number;
  upsertViolations: number;
  burstRulesExpected: number;
  burstRulesRetained: number;
  stalePutInterferenceChecks: number;
  stalePutRuleLosses: number;
  routeDeleteFailures: number;
  durationMs: number;
};

async function readRulesWithRetry(): Promise<
  Awaited<ReturnType<typeof getGlobalSettings>>["agents"]["rememberedPermissions"]
> {
  for (;;) {
    try {
      const settings = await getGlobalSettings();
      return settings.agents.rememberedPermissions;
    } catch {
      await sleep(5);
    }
  }
}

async function clearAllRulesReliably(): Promise<void> {
  for (;;) {
    try {
      await clearRememberedAgentPermissionRules();
      return;
    } catch {
      await sleep(5);
    }
  }
}

async function fireStaleFullPut(): Promise<boolean> {
  try {
    const settings = await getGlobalSettings();
    const stale = {
      ...settings,
      agents: {
        ...settings.agents,
        // Hostile client: stale snapshot with an empty remembered list and a
        // toggled unrelated flag, exactly what a delayed keepalive PUT sends.
        rememberedPermissions: [],
        submitCtrlEnter: !settings.agents.submitCtrlEnter,
      },
    };
    const response = await settingsRoutes.request("/api/settings/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: stale }),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-harness stress phases
// ---------------------------------------------------------------------------

async function stressHarness(spec: HarnessSpec): Promise<HarnessReport> {
  const startedAt = Date.now();
  const workspaceId = `stress-${spec.backendId}`;
  const report: HarnessReport = {
    backendId: spec.backendId,
    label: spec.label,
    iterations: ITERATIONS_PER_HARNESS,
    persisted: 0,
    resolvedRemembered: 0,
    persistDroppedByFaults: 0,
    resolveMissesAfterPersist: 0,
    resolveTransientPromptFallbacks: 0,
    upsertViolations: 0,
    burstRulesExpected: 0,
    burstRulesRetained: 0,
    stalePutInterferenceChecks: 0,
    stalePutRuleLosses: 0,
    routeDeleteFailures: 0,
    durationMs: 0,
  };

  await clearAllRulesReliably();

  // Phase 1: sequential save→resolve cycles with faults + interleaved stale PUTs.
  // Rules are cleared periodically to stay under the 250-rule cap; presence is
  // asserted before each clear so the cap never masks a loss.
  const CLEAR_EVERY = 120;
  let sinceClear: Array<{ toolKey: string; optionId: "allow_always" | "reject_always" }> = [];
  for (let i = 0; i < ITERATIONS_PER_HARNESS; i += 1) {
    const toolKey = spec.toolKey(i);
    const optionId = i % 3 === 0 ? "reject_always" : "allow_always";
    const saved = await persistRememberedPermissionChoice({
      workspaceId,
      backendId: spec.backendId,
      toolKey,
      toolLabel: `${spec.label} stress ${i}`,
      optionId,
    });
    if (!saved) {
      // All 3 persist attempts hit injected faults; tracked, not a bug.
      report.persistDroppedByFaults += 1;
      continue;
    }
    report.persisted += 1;
    sinceClear.push({ toolKey, optionId });

    // Lossy client interference on ~10% of iterations.
    if (i % 10 === 3) {
      const ok = await fireStaleFullPut();
      if (ok) report.stalePutInterferenceChecks += 1;
    }

    const resolved = await resolveRememberedPermissionDecision({
      workspaceId,
      backendId: spec.backendId,
      toolKey,
    });
    if (resolved.kind === "remembered") {
      report.resolvedRemembered += 1;
      const expected = optionId === "allow_always" ? "allow" : "reject";
      if (resolved.decision !== expected) {
        report.upsertViolations += 1;
      }
    } else {
      // Prompt fallback under injected storage faults is the designed fail-safe
      // (never auto-allow on a failed read). Only count a real loss when the
      // rule is genuinely absent from a successful read.
      const rules = await readRulesWithRetry();
      const present = rules.some(
        (rule) =>
          rule.workspaceId === workspaceId &&
          rule.backendId === spec.backendId &&
          rule.toolKey === toolKey
      );
      if (present) {
        report.resolveTransientPromptFallbacks += 1;
      } else {
        report.resolveMissesAfterPersist += 1;
      }
    }

    if (sinceClear.length >= CLEAR_EVERY || i === ITERATIONS_PER_HARNESS - 1) {
      // Verify every rule saved since the last clear is still on disk despite
      // the interleaved stale PUTs, then clear for the next window.
      const rules = await readRulesWithRetry();
      for (const entry of sinceClear) {
        const match = rules.find(
          (rule) =>
            rule.workspaceId === workspaceId &&
            rule.backendId === spec.backendId &&
            rule.toolKey === entry.toolKey
        );
        if (!match) {
          report.stalePutRuleLosses += 1;
        }
      }
      sinceClear = [];
      await clearAllRulesReliably();
    }
  }

  // Phase 2: concurrency bursts — BURST_SIZE parallel saves of distinct rules
  // must all land (lost-update detection).
  for (let burst = 0; burst < BURSTS_PER_HARNESS; burst += 1) {
    await clearAllRulesReliably();
    const keys = Array.from({ length: BURST_SIZE }, (_, i) =>
      spec.toolKey(100000 + burst * BURST_SIZE + i)
    );
    report.burstRulesExpected += keys.length;
    const results = await Promise.all(
      keys.map((toolKey, i) =>
        persistRememberedPermissionChoice({
          workspaceId,
          backendId: spec.backendId,
          toolKey,
          toolLabel: `${spec.label} burst ${burst}-${i}`,
          optionId: "allow_always",
        })
      )
    );
    const rules = await readRulesWithRetry();
    for (let i = 0; i < keys.length; i += 1) {
      if (!results[i]) {
        // Persist reported failure (triple fault) — excluded from retention math.
        report.burstRulesExpected -= 1;
        continue;
      }
      const present = rules.some(
        (rule) =>
          rule.workspaceId === workspaceId &&
          rule.backendId === spec.backendId &&
          rule.toolKey === keys[i]
      );
      if (present) {
        report.burstRulesRetained += 1;
      }
    }
  }

  // Phase 3: upsert hammering — 60 alternating saves on ONE key must end as a
  // single rule with the final decision.
  await clearAllRulesReliably();
  const hammerKey = spec.toolKey(999999);
  let lastOption: "allow_always" | "reject_always" = "allow_always";
  for (let i = 0; i < 60; i += 1) {
    lastOption = i % 2 === 0 ? "allow_always" : "reject_always";
    for (;;) {
      const saved = await persistRememberedPermissionChoice({
        workspaceId,
        backendId: spec.backendId,
        toolKey: hammerKey,
        toolLabel: `${spec.label} hammer`,
        optionId: lastOption,
      });
      if (saved) break;
      await sleep(2);
    }
  }
  const hammerRules = (await readRulesWithRetry()).filter(
    (rule) =>
      rule.workspaceId === workspaceId &&
      rule.backendId === spec.backendId &&
      rule.toolKey === hammerKey
  );
  if (hammerRules.length !== 1) {
    report.upsertViolations += 1;
  } else {
    const expected = lastOption === "allow_always" ? "allow" : "reject";
    if (hammerRules[0]!.decision !== expected) {
      report.upsertViolations += 1;
    }
  }

  // Phase 4: route-level delete + clear (faults disabled: route handlers are
  // asserted deterministically).
  faultsEnabled = false;
  await clearAllRulesReliably();
  const deletable = await saveRememberedAgentPermissionRule({
    workspaceId,
    backendId: spec.backendId,
    toolKey: spec.toolKey(888888),
    toolLabel: `${spec.label} delete target`,
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });
  const deleteResponse = await settingsRoutes.request(
    `/api/settings/remembered-permissions/${encodeURIComponent(deletable.id)}`,
    { method: "DELETE" }
  );
  if (deleteResponse.status !== 200) {
    report.routeDeleteFailures += 1;
  } else {
    const after = await readRulesWithRetry();
    if (after.some((rule) => rule.id === deletable.id)) {
      report.routeDeleteFailures += 1;
    }
  }
  faultsEnabled = true;

  report.durationMs = Date.now() - startedAt;
  return report;
}

// ---------------------------------------------------------------------------
// Cross-harness phases
// ---------------------------------------------------------------------------

async function stressCrossHarnessConcurrency(): Promise<{
  expected: number;
  retained: number;
}> {
  await clearAllRulesReliably();
  const jobs: Array<Promise<unknown>> = [];
  const expectedKeys: Array<{ workspaceId: string; backendId: string; toolKey: string }> = [];
  // All 8 harnesses saving concurrently while stale PUTs rain down.
  for (const spec of HARNESSES) {
    for (let i = 0; i < 10; i += 1) {
      const toolKey = spec.toolKey(700000 + i);
      const workspaceId = `xh-${spec.backendId}`;
      expectedKeys.push({ workspaceId, backendId: spec.backendId, toolKey });
      jobs.push(
        (async () => {
          for (;;) {
            const saved = await persistRememberedPermissionChoice({
              workspaceId,
              backendId: spec.backendId,
              toolKey,
              toolLabel: `xh ${spec.backendId} ${i}`,
              optionId: "allow_always",
            });
            if (saved) return;
            await sleep(2);
          }
        })()
      );
    }
  }
  for (let i = 0; i < 12; i += 1) {
    jobs.push(fireStaleFullPut());
  }
  await Promise.all(jobs);
  const rules = await readRulesWithRetry();
  let retained = 0;
  for (const expected of expectedKeys) {
    if (
      rules.some(
        (rule) =>
          rule.workspaceId === expected.workspaceId &&
          rule.backendId === expected.backendId &&
          rule.toolKey === expected.toolKey
      )
    ) {
      retained += 1;
    }
  }
  return { expected: expectedKeys.length, retained };
}

async function verifyCapBehavior(): Promise<{ ok: boolean; count: number }> {
  faultsEnabled = false;
  await clearAllRulesReliably();
  for (let i = 0; i < 300; i += 1) {
    await saveRememberedAgentPermissionRule({
      workspaceId: "cap-workspace",
      backendId: "cesium-agent",
      toolKey: `cesium:terminal:cap-${i}`,
      toolLabel: `Cap ${i}`,
      decision: "allow",
      optionId: "allow_always",
      optionKind: "allow_always",
    });
  }
  const rules = await readRulesWithRetry();
  const newestPresent = rules.some((rule) => rule.toolKey === "cesium:terminal:cap-299");
  const oldestEvicted = !rules.some((rule) => rule.toolKey === "cesium:terminal:cap-0");
  faultsEnabled = true;
  return { ok: rules.length === 250 && newestPresent && oldestEvicted, count: rules.length };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(
  `[stress] iterations/harness=${ITERATIONS_PER_HARNESS} failureRate=${FAILURE_RATE} ` +
    `jitter<=${LATENCY_JITTER_MAX_MS}ms stallRate=${STALL_RATE}@${STALL_MS}ms ` +
    `bursts=${BURSTS_PER_HARNESS}x${BURST_SIZE}`
);

const reports: HarnessReport[] = [];
for (const spec of HARNESSES) {
  const report = await stressHarness(spec);
  reports.push(report);
  console.log(
    `[stress] ${report.label.padEnd(24)} persisted=${report.persisted}/${report.iterations} ` +
      `resolved=${report.resolvedRemembered} persistFaultDrops=${report.persistDroppedByFaults} ` +
      `transientPromptFallbacks=${report.resolveTransientPromptFallbacks} ` +
      `resolveMisses=${report.resolveMissesAfterPersist} upsertViolations=${report.upsertViolations} ` +
      `burst=${report.burstRulesRetained}/${report.burstRulesExpected} ` +
      `stalePutLosses=${report.stalePutRuleLosses} routeDeleteFailures=${report.routeDeleteFailures} ` +
      `(${(report.durationMs / 1000).toFixed(1)}s)`
  );
}

const crossHarness = await stressCrossHarnessConcurrency();
console.log(
  `[stress] cross-harness concurrent retention: ${crossHarness.retained}/${crossHarness.expected}`
);

const cap = await verifyCapBehavior();
console.log(`[stress] 250-rule cap: ok=${cap.ok} count=${cap.count}`);

console.log(
  `[stress] fault injection totals: ops=${faultStats.totalOps} ` +
    `failures=${faultStats.injectedFailures} stalls=${faultStats.injectedStalls}`
);

let failed = false;
for (const report of reports) {
  const problems: string[] = [];
  if (report.resolveMissesAfterPersist > 0) {
    problems.push(`resolveMissesAfterPersist=${report.resolveMissesAfterPersist}`);
  }
  if (report.upsertViolations > 0) {
    problems.push(`upsertViolations=${report.upsertViolations}`);
  }
  if (report.burstRulesRetained !== report.burstRulesExpected) {
    problems.push(`burstLoss=${report.burstRulesExpected - report.burstRulesRetained}`);
  }
  if (report.stalePutRuleLosses > 0) {
    problems.push(`stalePutRuleLosses=${report.stalePutRuleLosses}`);
  }
  if (report.routeDeleteFailures > 0) {
    problems.push(`routeDeleteFailures=${report.routeDeleteFailures}`);
  }
  if (problems.length > 0) {
    failed = true;
    console.error(`[stress] FAIL ${report.backendId}: ${problems.join(", ")}`);
  }
}
if (crossHarness.retained !== crossHarness.expected) {
  failed = true;
  console.error(
    `[stress] FAIL cross-harness: lost ${crossHarness.expected - crossHarness.retained} rules`
  );
}
if (!cap.ok) {
  failed = true;
  console.error(`[stress] FAIL cap behavior: count=${cap.count}`);
}

__setStorageForTesting(realDriver);
await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);

if (failed) {
  console.error("[stress] RESULT: FAILED");
  process.exit(1);
}
console.log("[stress] RESULT: PASSED — no rule loss, no upsert corruption, no route failures");
