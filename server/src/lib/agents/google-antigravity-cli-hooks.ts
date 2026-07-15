import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type GoogleAntigravityHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PreInvocation"
  | "PostInvocation"
  | "Stop";

export type GoogleAntigravityHookRecord = {
  event: GoogleAntigravityHookEventName;
  input: Record<string, unknown>;
  receivedAt: string;
};

const HOOK_NAME = "opencursor-antigravity-event-bridge";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function workspaceAgentsDir(workspace: string): string {
  return join(workspace, ".agents");
}

export class GoogleAntigravityHookBridge {
  readonly workspace: string;
  readonly hooksPath: string;
  readonly sinkPath: string;
  readonly helperPath: string;

  constructor(options: { workspace: string; sinkPath?: string; helperPath?: string }) {
    const agentsDir = workspaceAgentsDir(options.workspace);
    this.workspace = options.workspace;
    this.hooksPath = join(agentsDir, "hooks.json");
    this.sinkPath =
      options.sinkPath ?? join(agentsDir, ".opencursor-antigravity-events.jsonl");
    this.helperPath =
      options.helperPath ?? join(agentsDir, ".opencursor-antigravity-hook.cjs");
  }

  async install(options: { mergeExistingHooks?: boolean } = {}): Promise<{
    hooksPath: string;
    sinkPath: string;
    helperPath: string;
  }> {
    await mkdir(dirname(this.hooksPath), { recursive: true });
    await writeFile(this.helperPath, hookHelperSource(this.sinkPath), "utf8");

    const existing = await this.readHooks();
    if (
      Object.keys(existing).length > 0 &&
      !existing[HOOK_NAME] &&
      !options.mergeExistingHooks
    ) {
      throw new Error(
        `Existing Antigravity hooks found at ${this.hooksPath}; OpenCursor did not merge them automatically.`
      );
    }

    const next = {
      ...existing,
      [HOOK_NAME]: hookDefinition(this.helperPath),
    };
    const tmpPath = `${this.hooksPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.hooksPath);
    return {
      hooksPath: this.hooksPath,
      sinkPath: this.sinkPath,
      helperPath: this.helperPath,
    };
  }

  async readNewRecords(offset = 0): Promise<{
    offset: number;
    records: GoogleAntigravityHookRecord[];
  }> {
    if (!(await fileExists(this.sinkPath))) {
      return { offset, records: [] };
    }
    const raw = await readFile(this.sinkPath, "utf8");
    const slice = raw.slice(offset);
    const records = slice
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as GoogleAntigravityHookRecord];
        } catch {
          return [];
        }
      });
    return { offset: raw.length, records };
  }

  private async readHooks(): Promise<Record<string, unknown>> {
    if (!(await fileExists(this.hooksPath))) {
      return {};
    }
    const parsed = JSON.parse(await readFile(this.hooksPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
}

function hookDefinition(helperPath: string): Record<string, unknown> {
  const command = jsonCommand(helperPath);
  const matchedToolHandler = {
    matcher: "*",
    hooks: [{ type: "command", command, timeout: 10 }],
  };
  const lifecycleHandler = [{ type: "command", command, timeout: 10 }];

  return {
    enabled: true,
    PreToolUse: [matchedToolHandler],
    PostToolUse: [matchedToolHandler],
    PreInvocation: lifecycleHandler,
    PostInvocation: lifecycleHandler,
    Stop: lifecycleHandler,
  };
}

function jsonCommand(helperPath: string): string {
  const escaped = helperPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `node "${escaped}"`;
}

function hookHelperSource(sinkPath: string): string {
  const escapedSink = sinkPath.replace(/\\/g, "\\\\");
  return `const fs = require("node:fs");
const path = require("node:path");
const sinkPath = "${escapedSink}";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(input || "{}"); } catch (error) { parsed = { parseError: String(error), raw: input }; }
  const event = inferEvent(parsed);
  fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
  fs.appendFileSync(sinkPath, JSON.stringify({ event, input: parsed, receivedAt: new Date().toISOString() }) + "\\n");
  process.stdout.write(JSON.stringify(defaultResponse(event)));
});
function inferEvent(payload) {
  if (payload && payload.toolCall) return "PreToolUse";
  if (payload && Object.prototype.hasOwnProperty.call(payload, "executionNum")) return "Stop";
  if (payload && Object.prototype.hasOwnProperty.call(payload, "error") && Object.prototype.hasOwnProperty.call(payload, "stepIdx")) return "PostToolUse";
  if (payload && Object.prototype.hasOwnProperty.call(payload, "invocationNum")) return "PreInvocation";
  return "PostInvocation";
}
function defaultResponse(event) {
  if (event === "PreToolUse") return { decision: "allow", reason: "Observed by OpenCursor Antigravity event bridge." };
  if (event === "PostToolUse") return {};
  if (event === "Stop") return { decision: "" };
  return { injectSteps: [] };
}
`;
}
