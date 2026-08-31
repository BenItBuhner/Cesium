/**
 * The browser machine's shell: a TypeScript interpreter over the VFS with a
 * command router. Built-in coreutils ship in-bundle (zero download weight);
 * heavier commands (node/npm/toolchain packs) register through
 * `registerCommand`, and a WASM shell engine can be swapped in behind the
 * same `exec` interface later without touching callers.
 */
import { basename, joinPath } from "../paths";
import type { Vfs } from "../vfs";
import type { BrowserGit } from "../git/browser-git";
import {
  createBuiltins,
  resolvePath,
  type BuiltinHandler,
  type ShellContext,
  type ShellIo,
} from "./builtins";
import {
  parseScript,
  ShellParseError,
  type ParsedListEntry,
  type ParsedSimpleCommand,
  type ParsedWord,
} from "./parser";

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ShellExecOptions = {
  cwd: string;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

export type ShellCommandHandler = (argv: string[], ctx: ShellContext) => Promise<number> | number;

const MAX_OUTPUT_CHARS = 400_000;

export class ShellRuntime {
  private readonly builtins: Map<string, BuiltinHandler>;
  private readonly commands = new Map<string, ShellCommandHandler>();

  constructor(
    private readonly vfs: Vfs,
    private readonly git: BrowserGit
  ) {
    this.builtins = createBuiltins();
    this.registerCommand("git", (argv, ctx) => this.runGit(argv, ctx));
    this.registerCommand("curl", (argv, ctx) => this.runCurl(argv, ctx));
    this.registerCommand("sh", (argv, ctx) => this.runSh(argv, ctx));
    this.registerCommand("bash", (argv, ctx) => this.runSh(argv, ctx));
  }

  registerCommand(name: string, handler: ShellCommandHandler): void {
    this.commands.set(name, handler);
  }

  listCommands(): string[] {
    return [...new Set([...this.builtins.keys(), ...this.commands.keys()])].sort();
  }

  async exec(script: string, options: ShellExecOptions): Promise<ShellResult> {
    let stdout = "";
    let stderr = "";
    const io: ShellIo = {
      stdin: "",
      write: (text) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += text;
        options.onOutput?.(text, "stdout");
      },
      writeErr: (text) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += text;
        options.onOutput?.(text, "stderr");
      },
    };
    const env = new Map<string, string>(Object.entries(options.env ?? {}));
    if (!env.has("HOME")) env.set("HOME", "/workspaces");
    if (!env.has("PATH")) env.set("PATH", "/bin");
    const cwd = { value: options.cwd };
    const exitCode = await this.runScriptInternal(script, {
      vfs: this.vfs,
      cwd,
      env,
      io,
      runScript: (nested, nestedIo) =>
        this.runScriptInternal(nested, {
          vfs: this.vfs,
          cwd,
          env,
          io: nestedIo,
          runScript: () => Promise.reject(new Error("Nested script depth exceeded")),
          signal: options.signal,
        }),
      signal: options.signal,
    });
    return {
      exitCode,
      stdout: stdout.length >= MAX_OUTPUT_CHARS ? `${stdout}\n… (output truncated)` : stdout,
      stderr: stderr.length >= MAX_OUTPUT_CHARS ? `${stderr}\n… (output truncated)` : stderr,
    };
  }

  private async runScriptInternal(script: string, ctx: ShellContext): Promise<number> {
    let entries: ParsedListEntry[];
    try {
      entries = parseScript(script);
    } catch (error) {
      if (error instanceof ShellParseError) {
        ctx.io.writeErr(`sh: parse error: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    let lastExit = 0;
    let skipUntil: "&&" | "||" | null = null;
    for (const entry of entries) {
      if (ctx.signal?.aborted) {
        ctx.io.writeErr("sh: aborted\n");
        return 130;
      }
      if (skipUntil === "&&" && lastExit !== 0) {
        skipUntil = entry.next === ";" ? null : skipUntil;
        continue;
      }
      if (skipUntil === "||" && lastExit === 0) {
        skipUntil = entry.next === ";" ? null : skipUntil;
        continue;
      }
      skipUntil = null;
      lastExit = await this.runPipeline(entry.pipeline.commands, ctx);
      ctx.env.set("?", String(lastExit));
      if (entry.next === "&&" && lastExit !== 0) skipUntil = "&&";
      if (entry.next === "||" && lastExit === 0) skipUntil = "||";
    }
    return lastExit;
  }

  private async runPipeline(commands: ParsedSimpleCommand[], ctx: ShellContext): Promise<number> {
    let stdin = "";
    let exitCode = 0;
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i] as ParsedSimpleCommand;
      const isLast = i === commands.length - 1;
      let pipedOut = "";
      const io: ShellIo = isLast
        ? { ...ctx.io, stdin }
        : {
            stdin,
            write: (text) => {
              pipedOut += text;
            },
            writeErr: ctx.io.writeErr,
          };
      exitCode = await this.runSimpleCommand(command, { ...ctx, io });
      stdin = pipedOut;
    }
    return exitCode;
  }

  private async expandWord(word: ParsedWord, ctx: ShellContext): Promise<string> {
    let result = "";
    for (const part of word.parts) {
      if (part.kind === "literal") {
        result += part.text;
        continue;
      }
      if (part.kind === "var") {
        if (part.name === "?") {
          result += ctx.env.get("?") ?? "0";
        } else if (part.name === "PWD") {
          result += ctx.cwd.value;
        } else {
          result += ctx.env.get(part.name) ?? "";
        }
        continue;
      }
      // Command substitution.
      let captured = "";
      const io: ShellIo = {
        stdin: "",
        write: (text) => {
          captured += text;
        },
        writeErr: ctx.io.writeErr,
      };
      await ctx.runScript(part.script, io);
      result += captured.replace(/\n+$/, "");
    }
    return result;
  }

  private expandGlob(value: string, ctx: ShellContext): string[] {
    if (!/[*?]/.test(value) || value.startsWith("-")) return [value];
    const slash = value.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : value.slice(0, slash);
    const filePart = slash === -1 ? value : value.slice(slash + 1);
    if (/[*?]/.test(dirPart)) return [value];
    const dir = resolvePath(ctx, dirPart || ".");
    const record = ctx.vfs.getRecord(dir);
    if (!record || record.type !== "dir") return [value];
    const escaped = filePart
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${escaped}$`);
    const matches = ctx.vfs
      .listChildren(dir)
      .map((child) => basename(child.path))
      .filter((name) => regex.test(name) && (filePart.startsWith(".") || !name.startsWith(".")))
      .sort()
      .map((name) => (dirPart ? `${dirPart}/${name}` : name));
    return matches.length > 0 ? matches : [value];
  }

  private async runSimpleCommand(
    command: ParsedSimpleCommand,
    ctx: ShellContext
  ): Promise<number> {
    // Expand words.
    const argv: string[] = [];
    for (const word of command.words) {
      const value = await this.expandWord(word, ctx);
      argv.push(...this.expandGlob(value, ctx));
    }

    // Pure assignments update the shell environment.
    if (argv.length === 0) {
      for (const assignment of command.assignments) {
        ctx.env.set(assignment.name, await this.expandWord(assignment.word, ctx));
      }
      return 0;
    }

    // Redirects.
    let stdoutTarget: { path: string; append: boolean } | null = null;
    let stderrTarget: { path: string; append: boolean } | null = null;
    let mergeStderr = false;
    let stdin = ctx.io.stdin;
    for (const redirect of command.redirects) {
      if (redirect.kind === "2>&1") {
        mergeStderr = true;
        continue;
      }
      const target = redirect.word ? await this.expandWord(redirect.word, ctx) : "";
      const path = resolvePath(ctx, target);
      if (redirect.kind === "<") {
        try {
          stdin = new TextDecoder().decode(ctx.vfs.readFile(path));
        } catch {
          ctx.io.writeErr(`sh: ${target}: No such file or directory\n`);
          return 1;
        }
      } else if (redirect.kind === ">" || redirect.kind === ">>") {
        stdoutTarget = { path, append: redirect.kind === ">>" };
      } else {
        stderrTarget = { path, append: redirect.kind === "2>>" };
      }
    }

    let redirectedOut = "";
    let redirectedErr = "";
    const io: ShellIo = {
      stdin,
      write: stdoutTarget
        ? (text) => {
            redirectedOut += text;
          }
        : ctx.io.write,
      writeErr: mergeStderr
        ? stdoutTarget
          ? (text) => {
              redirectedOut += text;
            }
          : ctx.io.write
        : stderrTarget
          ? (text) => {
              redirectedErr += text;
            }
          : ctx.io.writeErr,
    };

    // Env-prefixed command: scoped copies.
    let env = ctx.env;
    if (command.assignments.length > 0) {
      env = new Map(ctx.env);
      for (const assignment of command.assignments) {
        env.set(assignment.name, await this.expandWord(assignment.word, ctx));
      }
    }

    const name = argv[0] as string;
    const rest = argv.slice(1);
    const commandCtx: ShellContext = { ...ctx, env, io };

    let exitCode: number;
    if (name === "which") {
      const target = rest[0] ?? "";
      if (this.builtins.has(target) || this.commands.has(target)) {
        io.write(`/bin/${target}\n`);
        exitCode = 0;
      } else {
        io.writeErr(`which: no ${target} in browser machine\n`);
        exitCode = 1;
      }
    } else {
      const builtin = this.builtins.get(name);
      const registered = this.commands.get(name);
      try {
        if (registered) {
          exitCode = await registered(rest, commandCtx);
        } else if (builtin) {
          exitCode = await builtin(rest, commandCtx);
        } else {
          io.writeErr(
            `sh: ${name}: command not found on the browser machine. Available: ${this.listCommands().join(", ")}\n`
          );
          exitCode = 127;
        }
      } catch (error) {
        io.writeErr(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
        exitCode = 1;
      }
    }

    const writeTarget = (target: { path: string; append: boolean }, text: string): void => {
      const parent = target.path.slice(0, target.path.lastIndexOf("/")) || "/";
      if (!ctx.vfs.exists(parent)) ctx.vfs.mkdir(parent, { recursive: true });
      if (target.append && ctx.vfs.exists(target.path)) {
        const existing = new TextDecoder().decode(ctx.vfs.readFile(target.path));
        ctx.vfs.writeFile(target.path, existing + text);
      } else {
        ctx.vfs.writeFile(target.path, text);
      }
    };
    if (stdoutTarget) writeTarget(stdoutTarget, redirectedOut);
    if (stderrTarget) writeTarget(stderrTarget, redirectedErr);
    return exitCode;
  }

  private async runSh(argv: string[], ctx: ShellContext): Promise<number> {
    if (argv[0] === "-c" && typeof argv[1] === "string") {
      return ctx.runScript(argv[1], ctx.io);
    }
    ctx.io.writeErr("sh: only `sh -c \"...\"` is supported\n");
    return 2;
  }

  private async runCurl(argv: string[], ctx: ShellContext): Promise<number> {
    let method = "GET";
    let url = "";
    let body: string | null = null;
    let output: string | null = null;
    let silent = false;
    let includeHeaders = false;
    const headers: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "-X" || arg === "--request") {
        method = argv[++i] ?? "GET";
      } else if (arg === "-H" || arg === "--header") {
        const header = argv[++i] ?? "";
        const colon = header.indexOf(":");
        if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
      } else if (arg === "-d" || arg === "--data" || arg === "--data-raw") {
        body = argv[++i] ?? "";
        if (method === "GET") method = "POST";
      } else if (arg === "-o" || arg === "--output") {
        output = argv[++i] ?? null;
      } else if (arg === "-s" || arg === "--silent") {
        silent = true;
      } else if (arg === "-i" || arg === "--include") {
        includeHeaders = true;
      } else if (arg === "-L" || arg === "--location" || arg === "-f" || arg === "--fail") {
        // fetch follows redirects by default.
      } else if (!arg.startsWith("-")) {
        url = arg;
      }
    }
    if (!url) {
      ctx.io.writeErr("curl: no URL specified\n");
      return 2;
    }
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body !== null ? { body } : {}),
        signal: ctx.signal ?? null,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (includeHeaders) {
        ctx.io.write(`HTTP/1.1 ${response.status} ${response.statusText}\n`);
        response.headers.forEach((value, key) => ctx.io.write(`${key}: ${value}\n`));
        ctx.io.write("\n");
      }
      if (output) {
        const path = resolvePath(ctx, output);
        ctx.vfs.writeFile(path, bytes);
        if (!silent) ctx.io.writeErr(`Saved ${bytes.byteLength} bytes to ${output}\n`);
      } else {
        ctx.io.write(new TextDecoder().decode(bytes));
      }
      return response.ok ? 0 : 22;
    } catch (error) {
      ctx.io.writeErr(
        `curl: ${error instanceof Error ? error.message : String(error)} (browser fetch is subject to CORS)\n`
      );
      return 7;
    }
  }

  private async runGit(argv: string[], ctx: ShellContext): Promise<number> {
    const sub = argv[0] ?? "status";
    const dir = ctx.cwd.value;
    const write = ctx.io.write;
    try {
      switch (sub) {
        case "status": {
          const branch = await this.git.currentBranch(dir).catch(() => null);
          write(`On branch ${branch ?? "(detached)"}\n`);
          const matrix = await this.git.statusMatrix(dir);
          const changed = matrix.filter(
            ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
          );
          if (changed.length === 0) {
            write("nothing to commit, working tree clean\n");
          } else {
            write("Changes:\n");
            for (const [filepath, head, workdir] of changed.slice(0, 200)) {
              const label = head === 0 ? "new file" : workdir === 0 ? "deleted" : "modified";
              write(`  ${label}: ${filepath}\n`);
            }
          }
          return 0;
        }
        case "add": {
          const target = argv[1] ?? ".";
          await this.git.add(dir, target === "-A" || target === "--all" ? "." : target);
          return 0;
        }
        case "commit": {
          const messageIndex = argv.findIndex((arg) => arg === "-m");
          const message = messageIndex >= 0 ? (argv[messageIndex + 1] ?? "") : "";
          if (!message) {
            ctx.io.writeErr("git commit: use -m \"message\"\n");
            return 1;
          }
          if (argv.includes("-a") || argv.includes("-am")) {
            await this.git.add(dir, ".");
          }
          const oid = await this.git.commit(dir, message);
          write(`[${(await this.git.currentBranch(dir)) ?? "HEAD"} ${oid.slice(0, 7)}] ${message}\n`);
          return 0;
        }
        case "checkout":
        case "switch": {
          let ref = argv[1] ?? "";
          let create = false;
          if (ref === "-b" || ref === "-c") {
            create = true;
            ref = argv[2] ?? "";
          }
          if (!ref) {
            ctx.io.writeErr(`git ${sub}: missing branch\n`);
            return 1;
          }
          if (create) {
            await this.git.createBranch(dir, ref, true);
          } else {
            await this.git.checkout(dir, ref);
          }
          write(`Switched to branch '${ref}'\n`);
          return 0;
        }
        case "branch": {
          if (argv[1] && !argv[1].startsWith("-")) {
            await this.git.createBranch(dir, argv[1], false);
            return 0;
          }
          const current = await this.git.currentBranch(dir);
          for (const branch of await this.git.listBranches(dir)) {
            write(`${branch === current ? "* " : "  "}${branch}\n`);
          }
          return 0;
        }
        case "log": {
          const depth = argv.includes("-n")
            ? Number.parseInt(argv[argv.indexOf("-n") + 1] ?? "20", 10) || 20
            : 20;
          const entries = await this.git.log(dir, depth);
          for (const entry of entries) {
            if (argv.includes("--oneline")) {
              write(`${entry.oid.slice(0, 7)} ${entry.message.split("\n")[0]}\n`);
            } else {
              write(
                `commit ${entry.oid}\nAuthor: ${entry.author}\nDate: ${new Date(entry.when).toISOString()}\n\n    ${entry.message.split("\n")[0]}\n\n`
              );
            }
          }
          return 0;
        }
        case "push": {
          const force = argv.includes("--force") || argv.includes("-f");
          await this.git.push(dir, { force });
          write("Pushed to origin.\n");
          return 0;
        }
        case "pull": {
          await this.git.pull(dir);
          write("Already up to date or fast-forwarded.\n");
          return 0;
        }
        case "fetch": {
          await this.git.fetch(dir);
          write("Fetched origin.\n");
          return 0;
        }
        case "init": {
          await this.git.init({
            id: "shell",
            root: dir,
            name: basename(dir),
            createdAt: 0,
            updatedAt: 0,
            lastOpenedAt: 0,
          });
          write(`Initialized empty Git repository in ${dir}/.git/\n`);
          return 0;
        }
        case "clone": {
          const url = argv[1];
          if (!url) {
            ctx.io.writeErr("git clone: missing repository URL\n");
            return 1;
          }
          const target = await this.git.clone({
            repoUrl: url,
            parentPath: dir,
            directoryName: argv[2] ?? "",
          });
          write(`Cloned into ${target}\n`);
          return 0;
        }
        case "rev-parse": {
          if (argv.includes("--abbrev-ref")) {
            write(`${(await this.git.currentBranch(dir)) ?? "HEAD"}\n`);
            return 0;
          }
          const log = await this.git.log(dir, 1);
          write(`${log[0]?.oid ?? ""}\n`);
          return 0;
        }
        case "diff": {
          const matrix = await this.git.statusMatrix(dir);
          const changed = matrix.filter(
            ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
          );
          for (const [filepath] of changed) {
            write(`M ${filepath}\n`);
          }
          return 0;
        }
        case "remote": {
          write("origin\n");
          return 0;
        }
        default: {
          ctx.io.writeErr(
            `git: '${sub}' is not supported by the browser machine git (supported: status, add, commit, checkout, switch, branch, log, push, pull, fetch, init, clone, rev-parse, diff, remote)\n`
          );
          return 1;
        }
      }
    } catch (error) {
      ctx.io.writeErr(`git ${sub}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
}

/** Interactive line-disciplined session for the terminal UI. */
export class ShellSession {
  readonly id: string;
  private buffer = "";
  private history: string[] = [];
  private running = false;
  private disposed = false;
  private output: (chunk: string) => void;

  constructor(
    private readonly runtime: ShellRuntime,
    options: { cwd: string; onOutput: (chunk: string) => void }
  ) {
    this.id = crypto.randomUUID();
    this.cwd = options.cwd;
    this.output = options.onOutput;
    void this.history;
  }

  cwd: string;

  /** Reattach the session's output to a new socket. */
  setOutput(onOutput: (chunk: string) => void): void {
    this.output = onOutput;
  }

  get prompt(): string {
    return `cesium:${this.cwd}$ `;
  }

  start(): void {
    this.output(
      `Cesium browser machine shell. Type commands; 'help' lists available tools.\r\n${this.prompt}`
    );
  }

  write(input: string): void {
    if (this.disposed || this.running) return;
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        this.output("\r\n");
        const line = this.buffer;
        this.buffer = "";
        void this.runLine(line);
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.output("\b \b");
        }
        continue;
      }
      if (ch === "\x03") {
        this.buffer = "";
        this.output(`^C\r\n${this.prompt}`);
        continue;
      }
      if (ch >= " " || ch === "\t") {
        this.buffer += ch;
        this.output(ch);
      }
    }
  }

  private async runLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      this.output(this.prompt);
      return;
    }
    this.history.push(trimmed);
    if (trimmed === "help") {
      this.output(
        `Available commands: ${this.runtime.listCommands().join(", ")}\r\n${this.prompt}`
      );
      return;
    }
    if (trimmed === "clear") {
      this.output(`\x1b[2J\x1b[H${this.prompt}`);
      return;
    }
    this.running = true;
    try {
      const result = await this.runtime.exec(trimmed, {
        cwd: this.cwd,
        onOutput: (chunk) => this.output(chunk.replace(/\n/g, "\r\n")),
      });
      // `cd` inside the line: re-resolve by running pwd in the same context is
      // overkill; track simple standalone cd commands here instead.
      const cdMatch = trimmed.match(/^cd\s+([^;&|]+)$/);
      if (cdMatch && result.exitCode === 0) {
        const target = cdMatch[1]?.trim() ?? "";
        this.cwd = target.startsWith("/")
          ? target
          : joinPath(this.cwd, target);
      }
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.output(this.prompt);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
