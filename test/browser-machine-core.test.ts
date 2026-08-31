import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  dirname,
  joinPath,
  normalizePath,
  resolveSafePath,
  toRelativePath,
} from "../packages/browser-machine/src/paths.ts";
import { inferLanguage, inferMimeType } from "../packages/browser-machine/src/lang.ts";
import { parseScript, tokenize } from "../packages/browser-machine/src/shell/parser.ts";
import { Vfs } from "../packages/browser-machine/src/vfs.ts";
import { parseSemver, satisfies } from "../packages/browser-machine/src/npm/registry.ts";
import { buildHistoryFromEvents } from "../packages/browser-machine/src/harness/history.ts";
import {
  buildBrowserMachineReminder,
  formatGitSummary,
} from "../packages/browser-machine/src/harness/reminder.ts";
import { ShellRuntime } from "../packages/browser-machine/src/shell/runtime.ts";
import { BrowserGit } from "../packages/browser-machine/src/git/browser-git.ts";
import type { AgentStoredEvent, WorkspaceRecord } from "@cesium/core";

describe("browser machine paths", () => {
  test("normalizes and joins POSIX paths", () => {
    assert.equal(normalizePath("/a//b/../c/"), "/a/c");
    assert.equal(joinPath("/workspaces", "repo", "src/index.ts"), "/workspaces/repo/src/index.ts");
    assert.equal(dirname("/a/b/c"), "/a/b");
    assert.equal(toRelativePath("/workspaces/repo", "/workspaces/repo/src/a.ts"), "src/a.ts");
  });

  test("refuses workspace escapes", () => {
    assert.equal(resolveSafePath("/workspaces/repo", "src/../a.ts"), "/workspaces/repo/a.ts");
    assert.throws(() => resolveSafePath("/workspaces/repo", "../../etc/passwd"));
  });
});

describe("browser machine language inference", () => {
  test("matches the engine's language and mime mapping", () => {
    assert.equal(inferLanguage("src/app.tsx"), "typescript");
    assert.equal(inferLanguage("Dockerfile"), "dockerfile");
    assert.equal(inferLanguage(".env.local"), "dotenv");
    assert.equal(inferMimeType("logo.svg"), "image/svg+xml; charset=utf-8");
  });
});

describe("browser machine shell parser", () => {
  test("tokenizes quotes and operators", () => {
    const tokens = tokenize(`echo "hello world" | grep -i 'HELLO' > out.txt`);
    assert.equal(tokens.filter((token) => token.kind === "op").length, 2);
  });

  test("parses pipelines, logic chains, and redirects", () => {
    const script = parseScript("mkdir -p a && echo hi > a/f.txt; cat a/f.txt | wc -l");
    assert.equal(script.length, 3);
    assert.equal(script[0]?.next, "&&");
    assert.equal(script[1]?.pipeline.commands[0]?.redirects[0]?.kind, ">");
    assert.equal(script[2]?.pipeline.commands.length, 2);
  });

  test("parses env assignments and command substitution", () => {
    const script = parseScript('FOO=bar node -e "x" && echo $(cat version.txt)');
    assert.equal(script[0]?.pipeline.commands[0]?.assignments[0]?.name, "FOO");
    const echoWord = script[1]?.pipeline.commands[0]?.words[1];
    assert.equal(echoWord?.parts[0]?.kind, "command");
  });
});

describe("browser machine VFS", () => {
  test("write/read/rename/delete round trip with change semantics", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspaces/demo", { recursive: true });
    vfs.writeFile("/workspaces/demo/a.txt", "hello");
    assert.equal(vfs.readTextFile("/workspaces/demo/a.txt"), "hello");
    vfs.mkdir("/workspaces/demo/sub");
    vfs.rename("/workspaces/demo/a.txt", "/workspaces/demo/sub/b.txt");
    assert.equal(vfs.exists("/workspaces/demo/a.txt"), false);
    assert.equal(vfs.readTextFile("/workspaces/demo/sub/b.txt"), "hello");
    assert.deepEqual(vfs.readDir("/workspaces/demo"), ["sub"]);
    const stat = vfs.stat("/workspaces/demo/sub/b.txt");
    assert.equal(stat.isFile(), true);
    assert.equal(stat.size, 5);
    vfs.rm("/workspaces/demo");
    assert.equal(vfs.exists("/workspaces/demo"), false);
  });

  test("symlinks resolve through stat and readFile", () => {
    const vfs = new Vfs();
    vfs.mkdir("/workspaces/demo", { recursive: true });
    vfs.writeFile("/workspaces/demo/real.txt", "content");
    vfs.symlink("real.txt", "/workspaces/demo/link.txt");
    assert.equal(vfs.readTextFile("/workspaces/demo/link.txt"), "content");
    assert.equal(vfs.lstat("/workspaces/demo/link.txt").isSymbolicLink(), true);
  });
});

describe("browser machine shell execution", () => {
  const makeShell = (): { shell: ShellRuntime; vfs: Vfs } => {
    const vfs = new Vfs();
    vfs.mkdir("/workspaces/demo", { recursive: true });
    const shell = new ShellRuntime(vfs, new BrowserGit(vfs));
    return { shell, vfs };
  };

  test("pipes, redirects, and logic operators work end to end", async () => {
    const { shell, vfs } = makeShell();
    const result = await shell.exec(
      'echo "alpha\nbeta\ngamma" | grep am | wc -l && echo ok > done.txt',
      { cwd: "/workspaces/demo" }
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "1");
    assert.equal(vfs.readTextFile("/workspaces/demo/done.txt").trim(), "ok");
  });

  test("variable expansion and command substitution", async () => {
    const { shell } = makeShell();
    const result = await shell.exec('NAME=world; echo "hello $NAME $(echo nested)"', {
      cwd: "/workspaces/demo",
    });
    assert.equal(result.stdout.trim(), "hello world nested");
  });

  test("cd/pwd, mkdir -p, ls, find, and sed", async () => {
    const { shell } = makeShell();
    const result = await shell.exec(
      "mkdir -p src/deep && echo const x = 1 > src/deep/a.ts && cd src && pwd && find . -name '*.ts' && sed 's/const/let/' deep/a.ts",
      { cwd: "/workspaces/demo" }
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\/workspaces\/demo\/src/);
    assert.match(result.stdout, /a\.ts/);
    assert.match(result.stdout, /let x = 1/);
  });

  test("unknown commands exit 127 with guidance", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("definitely-not-a-command", { cwd: "/workspaces/demo" });
    assert.equal(result.exitCode, 127);
    assert.match(result.stderr, /command not found on the browser machine/);
  });

  test("git init + add + commit + log work against the VFS", async () => {
    const { shell } = makeShell();
    const result = await shell.exec(
      'git init && echo hi > readme.md && git add . && git commit -m "first" && git log --oneline',
      { cwd: "/workspaces/demo" }
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /first/);
  });
});

describe("browser machine npm semver", () => {
  test("caret, tilde, and comparator ranges", () => {
    const v = parseSemver("1.4.2");
    assert.ok(v);
    assert.equal(satisfies(v, "^1.2.0"), true);
    assert.equal(satisfies(v, "^2.0.0"), false);
    assert.equal(satisfies(v, "~1.4.0"), true);
    assert.equal(satisfies(v, "~1.3.0"), false);
    assert.equal(satisfies(v, ">=1.0.0 <2"), true);
    assert.equal(satisfies(v, "1.4.2"), true);
    assert.equal(satisfies(v, "*"), true);
    const zero = parseSemver("0.27.7");
    assert.ok(zero);
    assert.equal(satisfies(zero, "^0.27.0"), true);
    assert.equal(satisfies(zero, "^0.26.0"), false);
  });
});

describe("browser machine harness history", () => {
  test("rebuilds assistant/tool messages from stored events", () => {
    const conversationId = "c1";
    let seq = 0;
    const event = (partial: Record<string, unknown>): AgentStoredEvent =>
      ({
        seq: ++seq,
        eventId: `e${seq}`,
        conversationId,
        createdAt: seq,
        ...partial,
      }) as AgentStoredEvent;
    const events: AgentStoredEvent[] = [
      event({ kind: "user_message", messageId: "m1", content: "list files" }),
      event({ kind: "system_reminder", reminderId: "r1", reason: "mode", text: "env facts" }),
      event({ kind: "assistant_message_chunk", messageId: "a1", text: "Listing now." }),
      event({
        kind: "tool_call",
        toolCallId: "t1",
        title: "Run: ls",
        toolKind: "execute",
        status: "in_progress",
        raw: { callId: "call_1", name: "terminal", argsJson: '{"command":"ls"}' },
      }),
      event({
        kind: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        raw: { callId: "call_1", result: "a.txt" },
      }),
      event({ kind: "assistant_message_chunk", messageId: "a2", text: "Done: a.txt" }),
      event({ kind: "assistant_message_end", messageId: "a2" }),
    ];
    const messages = buildHistoryFromEvents({
      events,
      systemPrompt: "SYSTEM",
      supportsImages: false,
    });
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
    assert.match(String(messages[2]?.content), /<system-reminder>/);
    const assistantWithTool = messages[3] as {
      role: string;
      tool_calls?: Array<{ function: { name: string } }>;
    };
    assert.equal(assistantWithTool.role, "assistant");
    assert.equal(assistantWithTool.tool_calls?.[0]?.function.name, "terminal");
    assert.equal(messages[4]?.role, "tool");
    const final = messages[5] as { role: string; content: string | null };
    assert.equal(final.role, "assistant");
    assert.match(String(final.content), /Done: a\.txt/);
  });
});

describe("browser machine reminder", () => {
  test("describes the environment honestly", () => {
    const workspace: WorkspaceRecord = {
      id: "w1",
      root: "/workspaces/demo",
      name: "demo",
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    };
    const reminder = buildBrowserMachineReminder({
      workspace,
      mode: "agent",
      modelName: "Kimi K3",
      gitSummary: formatGitSummary({ isGitRepo: true, branch: "main", dirty: false }),
      shellCommands: ["ls", "cat", "git", "node", "npm"],
      installedPacks: ["Python (Pyodide) (python, pip)"],
      dateLabel: "Monday, Aug 31, 2026",
    });
    assert.match(reminder, /<system-reminder>/);
    assert.match(reminder, /INSIDE the user's web browser tab/);
    assert.match(reminder, /on branch main/);
    assert.match(reminder, /Python \(Pyodide\)/);
    assert.match(reminder, /serve <dir>/);
  });
});
