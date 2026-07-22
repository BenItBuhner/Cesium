import { cpus } from "node:os";
import { Script, createContext } from "node:vm";
import {
  appendWorkflowJournal,
  appendWorkflowLog,
  hashWorkflowAgentCall,
  updateWorkflowRunStatus,
  upsertWorkflowRun,
} from "./workflow-store.js";
import {
  WORKFLOW_DEFAULT_MAX_AGENTS,
  WORKFLOW_DEFAULT_MAX_CONCURRENT,
  type WorkflowAgentSpawner,
  type WorkflowJournalEntry,
  type WorkflowMeta,
  type WorkflowPhaseMeta,
  type WorkflowRunRecord,
} from "./workflow-types.js";

const NOW_ERR =
  "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
const RANDOM_ERR =
  "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";

export type CompileWorkflowResult =
  | { ok: true; meta: WorkflowMeta; body: string }
  | { ok: false; error: string };

function stripExportMeta(script: string): { metaSource: string; body: string } | null {
  const trimmed = script.replace(/^\uFEFF/, "").trimStart();
  const prefix = "export const meta =";
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  let i = prefix.length;
  while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;
  if (trimmed[i] !== "{") {
    return null;
  }
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const metaSource = trimmed.slice(prefix.length, i + 1).trim();
        let rest = trimmed.slice(i + 1).trimStart();
        if (rest.startsWith(";")) {
          rest = rest.slice(1).trimStart();
        }
        return { metaSource, body: rest };
      }
    }
  }
  return null;
}

function assertPureMetaLiteral(metaSource: string): void {
  // Reject obvious non-literals without pulling in an AST dependency.
  if (
    /\b(?:require|import|Date|Math|process|globalThis|Function|eval)\b/.test(metaSource) ||
    /\$\{/.test(metaSource) ||
    /\.\.\./.test(metaSource)
  ) {
    throw new Error(
      "meta must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation."
    );
  }
}

function normalizeMeta(raw: unknown): WorkflowMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("meta must be an object literal with name, description, and optional phases.");
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (!name) {
    throw new Error("meta.name is required.");
  }
  if (!description) {
    throw new Error("meta.description is required.");
  }
  const whenToUse =
    typeof record.whenToUse === "string" && record.whenToUse.trim()
      ? record.whenToUse.trim()
      : undefined;
  const phasesRaw = Array.isArray(record.phases) ? record.phases : [];
  const phases: WorkflowPhaseMeta[] = phasesRaw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const phase = item as Record<string, unknown>;
    const title = typeof phase.title === "string" ? phase.title.trim() : "";
    if (!title) return [];
    return [
      {
        title,
        detail:
          typeof phase.detail === "string" && phase.detail.trim()
            ? phase.detail.trim()
            : undefined,
        model:
          typeof phase.model === "string" && phase.model.trim()
            ? phase.model.trim()
            : undefined,
      },
    ];
  });
  return { name, description, whenToUse, phases };
}

export function compileWorkflowScript(script: string): CompileWorkflowResult {
  try {
    const split = stripExportMeta(script);
    if (!split) {
      return {
        ok: false,
        error:
          "`export const meta = { name, description, phases }` must be the FIRST statement in the script",
      };
    }
    assertPureMetaLiteral(split.metaSource);
    const meta = normalizeMeta(
      new Script(`(${split.metaSource})`, { filename: "workflow-meta.js" }).runInNewContext(
        Object.create(null),
        { timeout: 1000 }
      )
    );
    // Syntax-check the body in isolation (async wrapper).
    new Script(`(async () => {\n${split.body}\n})`, { filename: "workflow.js" });
    if (/\bDate\.now\b|\bMath\.random\b/.test(split.body)) {
      return {
        ok: false,
        error:
          "Date.now() / Math.random() are unavailable in workflow scripts (breaks resume).",
      };
    }
    return { ok: true, meta, body: split.body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 240);
  try {
    return JSON.stringify(value)?.slice(0, 240) ?? "";
  } catch {
    return String(value).slice(0, 240);
  }
}

export async function executeWorkflowRun(input: {
  run: WorkflowRunRecord;
  spawnAgent: WorkflowAgentSpawner;
  journalSeed?: WorkflowJournalEntry[];
  onUpdate?: (run: WorkflowRunRecord) => void | Promise<void>;
}): Promise<WorkflowRunRecord> {
  let run = input.run;
  const compiled = compileWorkflowScript(run.script);
  if (!compiled.ok) {
    run = await updateWorkflowRunStatus(run, "failed", { error: compiled.error });
    await input.onUpdate?.(run);
    return run;
  }

  run = await updateWorkflowRunStatus(run, "running", {
    meta: compiled.meta,
    error: null,
    completedAt: null,
  });
  await input.onUpdate?.(run);

  const journal = new Map<string, WorkflowJournalEntry>();
  for (const entry of input.journalSeed ?? run.journal) {
    journal.set(entry.key, entry);
  }

  const maxConcurrent = Math.max(
    1,
    Math.min(
      run.maxConcurrent || WORKFLOW_DEFAULT_MAX_CONCURRENT,
      Math.max(1, cpus().length),
      WORKFLOW_DEFAULT_MAX_CONCURRENT
    )
  );
  const maxAgents = run.maxAgents || WORKFLOW_DEFAULT_MAX_AGENTS;
  const semaphore = new Semaphore(maxConcurrent);
  let currentPhase: string | null = null;
  let cancelled = false;
  let writeChain: Promise<void> = Promise.resolve();

  const withRunLock = async <T>(
    fn: (current: WorkflowRunRecord) => Promise<T> | T
  ): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = writeChain;
    writeChain = previous.then(() => gate);
    await previous;
    try {
      return await fn(run);
    } finally {
      release();
    }
  };

  const persist = async (next: WorkflowRunRecord) => {
    run = await upsertWorkflowRun(next);
    await input.onUpdate?.(run);
  };

  const budget = {
    total: run.tokenBudget,
    spent(): number {
      return run.tokensUsed;
    },
    remaining(): number {
      if (run.tokenBudget == null) return Number.POSITIVE_INFINITY;
      return Math.max(0, run.tokenBudget - run.tokensUsed);
    },
  };

  const phase = (title: string) => {
    const nextPhase = String(title ?? "").trim() || null;
    currentPhase = nextPhase;
    void withRunLock(async () => {
      run = await appendWorkflowLog(
        { ...run, currentPhase: nextPhase },
        nextPhase ? `Phase: ${nextPhase}` : "Phase cleared",
        nextPhase
      );
      await input.onUpdate?.(run);
    });
  };

  const log = (message: string) => {
    const phaseName = currentPhase;
    const messageText = String(message ?? "");
    void withRunLock(async () => {
      run = await appendWorkflowLog(run, messageText, phaseName);
      await input.onUpdate?.(run);
    });
  };

  const agent = async (
    prompt: string,
    opts: Record<string, unknown> = {}
  ): Promise<unknown> => {
    if (cancelled) return null;
    const promptText = String(prompt ?? "");
    if (!promptText.trim()) {
      throw new Error("agent(prompt) requires a non-empty prompt string.");
    }

    const label =
      typeof opts.label === "string" && opts.label.trim()
        ? opts.label.trim()
        : null;
    const phaseName =
      typeof opts.phase === "string" && opts.phase.trim()
        ? opts.phase.trim()
        : currentPhase;
    const schema =
      opts.schema && typeof opts.schema === "object" && !Array.isArray(opts.schema)
        ? (opts.schema as Record<string, unknown>)
        : undefined;
    const model =
      typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined;
    const effort =
      typeof opts.effort === "string" && opts.effort.trim() ? opts.effort.trim() : undefined;

    const resolvedLabel = label ?? `agent-pending`;
    const optsForHash = {
      label: resolvedLabel,
      phase: phaseName,
      schema: schema ?? null,
      model: model ?? null,
      effort: effort ?? null,
    };

    const begin = await withRunLock(async () => {
      if (run.agentsUsed >= maxAgents) {
        throw new Error(
          `Workflow agent() call cap reached (${maxAgents}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`
        );
      }
      if (run.tokenBudget != null && run.tokensUsed >= run.tokenBudget) {
        throw new Error("Workflow token budget exhausted.");
      }
      const finalLabel = label ?? `agent-${run.agentsUsed + 1}`;
      const hashOpts = { ...optsForHash, label: finalLabel };
      const key = hashWorkflowAgentCall(promptText, hashOpts);
      const cached = journal.get(key);
      if (cached) {
        run = {
          ...run,
          agentsUsed: run.agentsUsed + 1,
          agents: [
            ...run.agents,
            {
              id: key.slice(0, 12),
              label: finalLabel,
              phase: phaseName,
              prompt: promptText,
              status: "cached",
              startedAt: Date.now(),
              completedAt: Date.now(),
              resultPreview: previewValue(cached.result),
            },
          ],
        };
        await persist(run);
        return { kind: "cached" as const, value: cached.result };
      }

      const agentId = key.slice(0, 12);
      const startedAt = Date.now();
      run = {
        ...run,
        agentsUsed: run.agentsUsed + 1,
        agents: [
          ...run.agents,
          {
            id: agentId,
            label: finalLabel,
            phase: phaseName,
            prompt: promptText,
            status: "running",
            startedAt,
            completedAt: null,
          },
        ],
      };
      await persist(run);
      return {
        kind: "live" as const,
        key,
        agentId,
        startedAt,
        finalLabel,
        hashOpts,
      };
    });

    if (begin.kind === "cached") {
      return begin.value;
    }

    return semaphore.run(async () => {
      if (cancelled) return null;
      try {
        const result = await input.spawnAgent({
          prompt: promptText,
          label: begin.finalLabel,
          phase: phaseName,
          schema,
          model,
          effort,
        });
        const entry: WorkflowJournalEntry = {
          key: begin.key,
          prompt: promptText,
          optsHash: begin.key,
          result: result.value,
          completedAt: Date.now(),
        };
        journal.set(begin.key, entry);
        await withRunLock(async () => {
          run = await appendWorkflowJournal(
            {
              ...run,
              tokensUsed: run.tokensUsed + Math.max(0, result.tokensUsed ?? 0),
              agents: run.agents.map((item) =>
                item.id === begin.agentId && item.startedAt === begin.startedAt
                  ? {
                      ...item,
                      status: "completed",
                      completedAt: Date.now(),
                      resultPreview: previewValue(result.value),
                    }
                  : item
              ),
            },
            entry
          );
          await input.onUpdate?.(run);
        });
        return result.value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await withRunLock(async () => {
          run = {
            ...run,
            agents: run.agents.map((item) =>
              item.id === begin.agentId && item.startedAt === begin.startedAt
                ? {
                    ...item,
                    status: "failed",
                    completedAt: Date.now(),
                    error: message,
                  }
                : item
            ),
          };
          await persist(run);
        });
        return null;
      }
    });
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() expects an array of functions");
    }
    if (thunks.some((item) => typeof item !== "function")) {
      throw new Error(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)"
      );
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await (thunk as () => Promise<unknown>)();
        } catch {
          return null;
        }
      })
    );
  };

  const pipeline = async (
    items: unknown,
    ...stages: Array<(prev: unknown, original: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new Error("pipeline() expects an array of items as its first argument");
    }
    if (stages.length === 0) {
      return items.slice();
    }
    return Promise.all(
      items.map(async (original, index) => {
        let current: unknown = original;
        for (const stage of stages) {
          try {
            current = await stage(current, original, index);
          } catch {
            return null;
          }
        }
        return current;
      })
    );
  };

  const nestedWorkflow = async () => {
    throw new Error(
      "workflow() nesting is limited to one level and is not available inside Cesium workflow runs yet."
    );
  };

  const sandbox = {
    args: run.args,
    budget,
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow: nestedWorkflow,
    console: {
      log: (...args: unknown[]) => {
        void log(args.map((value) => String(value)).join(" "));
      },
    },
    Math: Object.create(Math, {
      random: {
        configurable: true,
        enumerable: false,
        writable: true,
        value() {
          throw new Error(RANDOM_ERR);
        },
      },
    }),
    Date: new Proxy(Date, {
      apply() {
        throw new Error(NOW_ERR);
      },
      construct(target, argsList: unknown[]) {
        if (argsList.length === 0) {
          throw new Error(NOW_ERR);
        }
        return Reflect.construct(target, argsList);
      },
      get(target, prop, receiver) {
        if (prop === "now") {
          return () => {
            throw new Error(NOW_ERR);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
    Promise,
    Array,
    Object,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RangeError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    RegExp,
    Symbol,
    Reflect,
    Proxy,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    undefined,
  };

  const context = createContext(sandbox);
  const wrapped = `(async () => {\n${compiled.body}\n})()`;

  try {
    const script = new Script(wrapped, {
      filename: "workflow.js",
    });
    const result = await script.runInContext(context, {
      timeout: 600_000,
      breakOnSigint: true,
    });
    const safeReturnValue =
      result === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(result)) as unknown);
    run = await withRunLock(async () => {
      return updateWorkflowRunStatus(run, "completed", {
        returnValue: safeReturnValue,
        error: null,
      });
    });
    await input.onUpdate?.(run);
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cancelled = true;
    run = await withRunLock(async () => {
      return updateWorkflowRunStatus(run, "failed", { error: message });
    });
    await input.onUpdate?.(run);
    return run;
  }
}
