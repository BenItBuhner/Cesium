/**
 * Core utilities for the built-in TypeScript shell, implemented directly
 * against the VFS. Flag coverage focuses on what agents actually use.
 */
import { basename, dirname, joinPath, normalizePath } from "../paths";
import type { Vfs } from "../vfs";

export type ShellIo = {
  stdin: string;
  write(text: string): void;
  writeErr(text: string): void;
};

export type ShellContext = {
  vfs: Vfs;
  cwd: { value: string };
  env: Map<string, string>;
  io: ShellIo;
  /** Recursive execution for sh -c / xargs / command substitution. */
  runScript(script: string, io: ShellIo): Promise<number>;
  signal?: AbortSignal;
};

export type BuiltinHandler = (argv: string[], ctx: ShellContext) => Promise<number> | number;

export function resolvePath(ctx: ShellContext, path: string): string {
  if (!path) return ctx.cwd.value;
  if (path === "~" || path.startsWith("~/")) {
    return normalizePath(`/workspaces${path.slice(1)}`);
  }
  return path.startsWith("/") ? normalizePath(path) : joinPath(ctx.cwd.value, path);
}

function splitFlags(argv: string[]): { flags: Set<string>; positional: string[] } {
  const flags = new Set<string>();
  const positional: string[] = [];
  let noMoreFlags = false;
  for (const arg of argv) {
    if (!noMoreFlags && arg === "--") {
      noMoreFlags = true;
      continue;
    }
    if (!noMoreFlags && arg.startsWith("-") && arg.length > 1 && !/^-\d+$/.test(arg)) {
      if (arg.startsWith("--")) {
        flags.add(arg.slice(2));
      } else {
        for (const ch of arg.slice(1)) flags.add(ch);
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function listRecursive(vfs: Vfs, dir: string, out: string[]): void {
  for (const record of vfs.listChildren(dir)) {
    out.push(record.path);
    if (record.type === "dir") {
      listRecursive(vfs, record.path, out);
    }
  }
}

function readText(vfs: Vfs, path: string): string {
  return new TextDecoder().decode(vfs.readFile(path));
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 1024);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function createBuiltins(): Map<string, BuiltinHandler> {
  const builtins = new Map<string, BuiltinHandler>();

  builtins.set("true", () => 0);
  builtins.set("false", () => 1);
  builtins.set(":", () => 0);

  builtins.set("pwd", (_argv, ctx) => {
    ctx.io.write(`${ctx.cwd.value}\n`);
    return 0;
  });

  builtins.set("cd", (argv, ctx) => {
    const target = resolvePath(ctx, argv[0] ?? "/");
    const record = ctx.vfs.getRecord(target);
    if (!record || record.type !== "dir") {
      ctx.io.writeErr(`cd: ${argv[0] ?? target}: No such directory\n`);
      return 1;
    }
    ctx.cwd.value = target;
    return 0;
  });

  builtins.set("echo", (argv, ctx) => {
    let args = argv;
    let newline = true;
    if (args[0] === "-n") {
      newline = false;
      args = args.slice(1);
    }
    if (args[0] === "-e") {
      args = args.slice(1);
    }
    ctx.io.write(args.join(" ") + (newline ? "\n" : ""));
    return 0;
  });

  builtins.set("printf", (argv, ctx) => {
    const format = argv[0] ?? "";
    const rest = argv.slice(1);
    let index = 0;
    const rendered = format
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/%[sd]/g, () => rest[index++] ?? "");
    ctx.io.write(rendered);
    return 0;
  });

  builtins.set("cat", (argv, ctx) => {
    const { positional } = splitFlags(argv);
    if (positional.length === 0) {
      ctx.io.write(ctx.io.stdin);
      return 0;
    }
    for (const arg of positional) {
      try {
        const bytes = ctx.vfs.readFile(resolvePath(ctx, arg));
        if (isBinary(bytes)) {
          ctx.io.writeErr(`cat: ${arg}: binary file\n`);
          return 1;
        }
        ctx.io.write(new TextDecoder().decode(bytes));
      } catch {
        ctx.io.writeErr(`cat: ${arg}: No such file or directory\n`);
        return 1;
      }
    }
    return 0;
  });

  builtins.set("ls", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    const targets = positional.length > 0 ? positional : ["."];
    let exitCode = 0;
    const lines: string[] = [];
    for (const target of targets) {
      const path = resolvePath(ctx, target);
      const record = ctx.vfs.getRecord(path);
      if (!record) {
        ctx.io.writeErr(`ls: ${target}: No such file or directory\n`);
        exitCode = 1;
        continue;
      }
      if (record.type !== "dir") {
        lines.push(basename(path));
        continue;
      }
      const children = ctx.vfs
        .listChildren(path)
        .filter((child) => flags.has("a") || !basename(child.path).startsWith("."))
        .sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
      for (const child of children) {
        const name = basename(child.path);
        if (flags.has("l")) {
          const size = child.type === "file" ? (child.data?.byteLength ?? 0) : 0;
          const kind = child.type === "dir" ? "d" : child.type === "symlink" ? "l" : "-";
          const date = new Date(child.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
          lines.push(
            `${kind}rw-r--r-- 1 browser browser ${String(size).padStart(8)} ${date} ${name}${child.type === "dir" ? "/" : ""}`
          );
        } else {
          lines.push(child.type === "dir" ? `${name}/` : name);
        }
      }
    }
    if (lines.length > 0) ctx.io.write(`${lines.join("\n")}\n`);
    return exitCode;
  });

  builtins.set("mkdir", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    for (const arg of positional) {
      try {
        ctx.vfs.mkdir(resolvePath(ctx, arg), { recursive: flags.has("p") });
      } catch (error) {
        ctx.io.writeErr(`mkdir: ${arg}: ${error instanceof Error ? error.message : error}\n`);
        return 1;
      }
    }
    return 0;
  });

  builtins.set("rm", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    for (const arg of positional) {
      const path = resolvePath(ctx, arg);
      const record = ctx.vfs.getRecord(path);
      if (!record) {
        if (flags.has("f")) continue;
        ctx.io.writeErr(`rm: ${arg}: No such file or directory\n`);
        return 1;
      }
      if (record.type === "dir" && !flags.has("r") && !flags.has("R")) {
        ctx.io.writeErr(`rm: ${arg}: is a directory\n`);
        return 1;
      }
      ctx.vfs.rm(path);
    }
    return 0;
  });

  builtins.set("rmdir", (argv, ctx) => {
    for (const arg of argv) {
      try {
        ctx.vfs.rmdir(resolvePath(ctx, arg));
      } catch (error) {
        ctx.io.writeErr(`rmdir: ${arg}: ${error instanceof Error ? error.message : error}\n`);
        return 1;
      }
    }
    return 0;
  });

  builtins.set("touch", (argv, ctx) => {
    const { positional } = splitFlags(argv);
    for (const arg of positional) {
      const path = resolvePath(ctx, arg);
      if (!ctx.vfs.exists(path)) {
        const parent = dirname(path);
        if (!ctx.vfs.exists(parent)) {
          ctx.io.writeErr(`touch: ${arg}: No such file or directory\n`);
          return 1;
        }
        ctx.vfs.writeFile(path, "");
      }
    }
    return 0;
  });

  const copyTree = (vfs: Vfs, from: string, to: string): void => {
    const record = vfs.getRecord(from);
    if (!record) throw new Error(`No such file: ${from}`);
    if (record.type === "dir") {
      if (!vfs.exists(to)) vfs.mkdir(to, { recursive: true });
      for (const child of vfs.listChildren(from)) {
        copyTree(vfs, child.path, `${to}/${basename(child.path)}`);
      }
      return;
    }
    const parent = dirname(to);
    if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
    vfs.writeFile(to, vfs.readFile(from).slice());
  };

  builtins.set("cp", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    if (positional.length < 2) {
      ctx.io.writeErr("cp: missing operand\n");
      return 1;
    }
    const destination = resolvePath(ctx, positional[positional.length - 1] as string);
    const sources = positional.slice(0, -1).map((arg) => resolvePath(ctx, arg));
    const destinationIsDir = ctx.vfs.getRecord(destination)?.type === "dir";
    for (const source of sources) {
      const record = ctx.vfs.getRecord(source);
      if (!record) {
        ctx.io.writeErr(`cp: ${source}: No such file or directory\n`);
        return 1;
      }
      if (record.type === "dir" && !flags.has("r") && !flags.has("R") && !flags.has("a")) {
        ctx.io.writeErr(`cp: ${source}: is a directory (use -r)\n`);
        return 1;
      }
      const target = destinationIsDir ? `${destination}/${basename(source)}` : destination;
      try {
        copyTree(ctx.vfs, source, target);
      } catch (error) {
        ctx.io.writeErr(`cp: ${error instanceof Error ? error.message : error}\n`);
        return 1;
      }
    }
    return 0;
  });

  builtins.set("mv", (argv, ctx) => {
    const { positional } = splitFlags(argv);
    if (positional.length < 2) {
      ctx.io.writeErr("mv: missing operand\n");
      return 1;
    }
    const destination = resolvePath(ctx, positional[positional.length - 1] as string);
    const sources = positional.slice(0, -1).map((arg) => resolvePath(ctx, arg));
    const destinationIsDir = ctx.vfs.getRecord(destination)?.type === "dir";
    for (const source of sources) {
      const target = destinationIsDir ? `${destination}/${basename(source)}` : destination;
      try {
        ctx.vfs.rename(source, target);
      } catch (error) {
        ctx.io.writeErr(`mv: ${error instanceof Error ? error.message : error}\n`);
        return 1;
      }
    }
    return 0;
  });

  const headTail = (mode: "head" | "tail"): BuiltinHandler => (argv, ctx) => {
    let count = 10;
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "-n") {
        count = Number.parseInt(argv[i + 1] ?? "10", 10) || 10;
        i += 1;
      } else if (/^-n\d+$/.test(arg)) {
        count = Number.parseInt(arg.slice(2), 10) || 10;
      } else if (/^-\d+$/.test(arg)) {
        count = Number.parseInt(arg.slice(1), 10) || 10;
      } else {
        positional.push(arg);
      }
    }
    const source =
      positional.length > 0
        ? positional
            .map((arg) => {
              try {
                return readText(ctx.vfs, resolvePath(ctx, arg));
              } catch {
                ctx.io.writeErr(`${mode}: ${arg}: No such file or directory\n`);
                return null;
              }
            })
            .filter((value): value is string => value !== null)
            .join("")
        : ctx.io.stdin;
    const lines = source.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const selected = mode === "head" ? lines.slice(0, count) : lines.slice(-count);
    if (selected.length > 0) ctx.io.write(`${selected.join("\n")}\n`);
    return 0;
  };
  builtins.set("head", headTail("head"));
  builtins.set("tail", headTail("tail"));

  builtins.set("wc", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    const text =
      positional.length > 0
        ? positional.map((arg) => readText(ctx.vfs, resolvePath(ctx, arg))).join("")
        : ctx.io.stdin;
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const words = text.split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(text).byteLength;
    const parts: string[] = [];
    if (flags.has("l")) parts.push(String(lines));
    if (flags.has("w")) parts.push(String(words));
    if (flags.has("c")) parts.push(String(bytes));
    if (parts.length === 0) parts.push(String(lines), String(words), String(bytes));
    ctx.io.write(`${parts.join(" ")}\n`);
    return 0;
  });

  builtins.set("grep", (argv, ctx) => {
    const flags = new Set<string>();
    const positional: string[] = [];
    for (const arg of argv) {
      if (arg.startsWith("-") && arg.length > 1 && positional.length === 0) {
        for (const ch of arg.slice(1)) flags.add(ch);
      } else {
        positional.push(arg);
      }
    }
    const pattern = positional[0];
    if (pattern === undefined) {
      ctx.io.writeErr("grep: missing pattern\n");
      return 2;
    }
    let regex: RegExp;
    try {
      regex = flags.has("F")
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags.has("i") ? "i" : "")
        : new RegExp(pattern, flags.has("i") ? "i" : "");
    } catch (error) {
      ctx.io.writeErr(`grep: invalid pattern: ${error instanceof Error ? error.message : error}\n`);
      return 2;
    }
    const files: string[] = [];
    const targets = positional.slice(1);
    if (targets.length === 0) {
      const invert = flags.has("v");
      let matched = false;
      const lines = ctx.io.stdin.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) {
        const hit = regex.test(line);
        if (hit !== invert) {
          matched = true;
          ctx.io.write(`${line}\n`);
        }
      }
      return matched ? 0 : 1;
    }
    for (const target of targets) {
      const path = resolvePath(ctx, target);
      const record = ctx.vfs.getRecord(path);
      if (!record) {
        ctx.io.writeErr(`grep: ${target}: No such file or directory\n`);
        continue;
      }
      if (record.type === "dir") {
        if (flags.has("r") || flags.has("R")) {
          const all: string[] = [];
          listRecursive(ctx.vfs, path, all);
          files.push(...all.filter((entry) => ctx.vfs.getRecord(entry)?.type === "file"));
        } else {
          ctx.io.writeErr(`grep: ${target}: Is a directory\n`);
        }
        continue;
      }
      files.push(path);
    }
    let matched = false;
    const multiple = files.length > 1;
    const invert = flags.has("v");
    for (const file of files) {
      const bytes = ctx.vfs.readFile(file);
      if (isBinary(bytes)) continue;
      const lines = new TextDecoder().decode(bytes).split("\n");
      for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
        const line = lines[lineNo] as string;
        const hit = regex.test(line);
        if (hit !== invert) {
          matched = true;
          const prefix = multiple ? `${file}:` : "";
          const lineNumber = flags.has("n") ? `${lineNo + 1}:` : "";
          ctx.io.write(`${prefix}${lineNumber}${line}\n`);
        }
      }
    }
    return matched ? 0 : 1;
  });

  builtins.set("find", (argv, ctx) => {
    const roots: string[] = [];
    let namePattern: RegExp | null = null;
    let typeFilter: "f" | "d" | null = null;
    let maxDepth = Number.POSITIVE_INFINITY;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "-name" || arg === "-iname") {
        const glob = argv[i + 1] ?? "*";
        const escaped = glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        namePattern = new RegExp(`^${escaped}$`, arg === "-iname" ? "i" : "");
        i += 1;
      } else if (arg === "-type") {
        const value = argv[i + 1];
        typeFilter = value === "f" ? "f" : value === "d" ? "d" : null;
        i += 1;
      } else if (arg === "-maxdepth") {
        maxDepth = Number.parseInt(argv[i + 1] ?? "0", 10) || 0;
        i += 1;
      } else if (!arg.startsWith("-")) {
        roots.push(arg);
      }
    }
    const startRoots = roots.length > 0 ? roots : ["."];
    for (const root of startRoots) {
      const base = resolvePath(ctx, root);
      const walk = (path: string, depth: number): void => {
        const record = ctx.vfs.getRecord(path);
        if (!record) return;
        const name = basename(path) || path;
        const typeOk =
          !typeFilter ||
          (typeFilter === "f" && record.type === "file") ||
          (typeFilter === "d" && record.type === "dir");
        const nameOk = !namePattern || namePattern.test(name);
        if (typeOk && nameOk && depth > 0) {
          const display = root === "." ? `.${path.slice(base.length)}` : path;
          ctx.io.write(`${display || root}\n`);
        }
        if (depth === 0 && typeOk && nameOk) {
          ctx.io.write(`${root}\n`);
        }
        if (record.type === "dir" && depth < maxDepth) {
          for (const child of ctx.vfs.listChildren(path)) {
            walk(child.path, depth + 1);
          }
        }
      };
      walk(base, 0);
    }
    return 0;
  });

  builtins.set("sed", (argv, ctx) => {
    const { positional } = splitFlags(argv);
    const script = positional[0] ?? "";
    const match = script.match(/^s([/#|,])((?:\\.|[^\\])*?)\1((?:\\.|[^\\])*?)\1([gi]*)$/);
    if (!match) {
      ctx.io.writeErr("sed: only s/pattern/replacement/[gi] scripts are supported\n");
      return 1;
    }
    const [, , pattern, replacement, flagsRaw] = match;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern as string, flagsRaw?.includes("g") ? `g${flagsRaw.includes("i") ? "i" : ""}` : flagsRaw ?? "");
    } catch (error) {
      ctx.io.writeErr(`sed: invalid pattern: ${error instanceof Error ? error.message : error}\n`);
      return 1;
    }
    const files = positional.slice(1);
    const inPlace = argv.includes("-i");
    if (files.length === 0) {
      ctx.io.write(
        ctx.io.stdin
          .split("\n")
          .map((line) => line.replace(regex, (replacement as string).replace(/\\(\d)/g, "$$$1")))
          .join("\n")
      );
      return 0;
    }
    for (const file of files) {
      const path = resolvePath(ctx, file);
      const text = readText(ctx.vfs, path);
      const next = text
        .split("\n")
        .map((line) => line.replace(regex, (replacement as string).replace(/\\(\d)/g, "$$$1")))
        .join("\n");
      if (inPlace) {
        ctx.vfs.writeFile(path, next);
      } else {
        ctx.io.write(next);
      }
    }
    return 0;
  });

  builtins.set("sort", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    const text =
      positional.length > 0
        ? positional.map((arg) => readText(ctx.vfs, resolvePath(ctx, arg))).join("")
        : ctx.io.stdin;
    let lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    lines.sort(flags.has("n") ? (a, b) => Number(a) - Number(b) : undefined);
    if (flags.has("r")) lines.reverse();
    if (flags.has("u")) lines = [...new Set(lines)];
    if (lines.length > 0) ctx.io.write(`${lines.join("\n")}\n`);
    return 0;
  });

  builtins.set("uniq", (argv, ctx) => {
    const { flags, positional } = splitFlags(argv);
    const text =
      positional.length > 0 ? readText(ctx.vfs, resolvePath(ctx, positional[0] as string)) : ctx.io.stdin;
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const out: string[] = [];
    let previous: string | null = null;
    let count = 0;
    const flush = (): void => {
      if (previous !== null) {
        out.push(flags.has("c") ? `${String(count).padStart(7)} ${previous}` : previous);
      }
    };
    for (const line of lines) {
      if (line === previous) {
        count += 1;
        continue;
      }
      flush();
      previous = line;
      count = 1;
    }
    flush();
    if (out.length > 0) ctx.io.write(`${out.join("\n")}\n`);
    return 0;
  });

  builtins.set("cut", (argv, ctx) => {
    let delimiter = "\t";
    let fieldsSpec = "";
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "-d") {
        delimiter = argv[i + 1] ?? "\t";
        i += 1;
      } else if (arg.startsWith("-d")) {
        delimiter = arg.slice(2);
      } else if (arg === "-f") {
        fieldsSpec = argv[i + 1] ?? "";
        i += 1;
      } else if (arg.startsWith("-f")) {
        fieldsSpec = arg.slice(2);
      } else {
        positional.push(arg);
      }
    }
    const wanted = new Set<number>();
    for (const part of fieldsSpec.split(",")) {
      if (part.includes("-")) {
        const [from, to] = part.split("-").map((value) => Number.parseInt(value, 10));
        for (let f = from ?? 1; f <= (to ?? from ?? 1); f += 1) wanted.add(f);
      } else if (part) {
        wanted.add(Number.parseInt(part, 10));
      }
    }
    const text =
      positional.length > 0 ? readText(ctx.vfs, resolvePath(ctx, positional[0] as string)) : ctx.io.stdin;
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const fields = line.split(delimiter);
      const selected = fields.filter((_field, index) => wanted.has(index + 1));
      ctx.io.write(`${selected.join(delimiter)}\n`);
    }
    return 0;
  });

  /** Expand tr-style sets: character ranges (a-z, 0-9) and class shorthands. */
  const expandCharSet = (spec: string): string[] => {
    const withClasses = spec
      .replace(/\[:upper:\]/g, "A-Z")
      .replace(/\[:lower:\]/g, "a-z")
      .replace(/\[:digit:\]/g, "0-9");
    const out: string[] = [];
    for (let i = 0; i < withClasses.length; i += 1) {
      const ch = withClasses[i] as string;
      const next = withClasses[i + 1];
      const end = withClasses[i + 2];
      if (next === "-" && end !== undefined) {
        const from = ch.charCodeAt(0);
        const to = end.charCodeAt(0);
        if (to >= from) {
          for (let code = from; code <= to; code += 1) {
            out.push(String.fromCharCode(code));
          }
          i += 2;
          continue;
        }
      }
      out.push(ch);
    }
    return out;
  };

  builtins.set("tr", (argv, ctx) => {
    const deleteMode = argv[0] === "-d";
    const from = deleteMode ? argv[1] : argv[0];
    const to = deleteMode ? "" : argv[1];
    if (from === undefined) {
      ctx.io.writeErr("tr: missing operand\n");
      return 1;
    }
    let text = ctx.io.stdin;
    if (deleteMode) {
      for (const ch of expandCharSet(from)) {
        text = text.split(ch).join("");
      }
    } else if (to !== undefined) {
      const fromChars = expandCharSet(from);
      const toChars = expandCharSet(to);
      text = [...text]
        .map((ch) => {
          const index = fromChars.indexOf(ch);
          return index === -1 ? ch : (toChars[Math.min(index, toChars.length - 1)] ?? ch);
        })
        .join("");
    }
    ctx.io.write(text);
    return 0;
  });

  builtins.set("basename", (argv, ctx) => {
    ctx.io.write(`${basename(argv[0] ?? "")}\n`);
    return 0;
  });

  builtins.set("dirname", (argv, ctx) => {
    ctx.io.write(`${dirname(argv[0] ?? "")}\n`);
    return 0;
  });

  builtins.set("date", (_argv, ctx) => {
    ctx.io.write(`${new Date().toString()}\n`);
    return 0;
  });

  builtins.set("sleep", async (argv, ctx) => {
    const seconds = Number.parseFloat(argv[0] ?? "0") || 0;
    const capped = Math.min(seconds, 300);
    await new Promise((resolve) => setTimeout(resolve, capped * 1000));
    void ctx;
    return 0;
  });

  builtins.set("env", (_argv, ctx) => {
    for (const [key, value] of ctx.env) {
      ctx.io.write(`${key}=${value}\n`);
    }
    return 0;
  });

  builtins.set("export", (argv, ctx) => {
    for (const arg of argv) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        ctx.env.set(arg.slice(0, eq), arg.slice(eq + 1));
      }
    }
    return 0;
  });

  builtins.set("unset", (argv, ctx) => {
    for (const arg of argv) ctx.env.delete(arg);
    return 0;
  });

  const testHandler: BuiltinHandler = (argv, ctx) => {
    let args = argv;
    if (args[args.length - 1] === "]") args = args.slice(0, -1);
    if (args.length === 0) return 1;
    let negate = false;
    if (args[0] === "!") {
      negate = true;
      args = args.slice(1);
    }
    let result = false;
    if (args.length === 1) {
      result = (args[0] ?? "").length > 0;
    } else if (args.length === 2) {
      const [op, operand] = args as [string, string];
      const path = resolvePath(ctx, operand);
      const record = ctx.vfs.getRecord(path);
      if (op === "-f") result = record?.type === "file";
      else if (op === "-d") result = record?.type === "dir";
      else if (op === "-e") result = Boolean(record);
      else if (op === "-s") result = record?.type === "file" && (record.data?.byteLength ?? 0) > 0;
      else if (op === "-z") result = operand.length === 0;
      else if (op === "-n") result = operand.length > 0;
    } else if (args.length === 3) {
      const [left, op, right] = args as [string, string, string];
      if (op === "=" || op === "==") result = left === right;
      else if (op === "!=") result = left !== right;
      else if (op === "-eq") result = Number(left) === Number(right);
      else if (op === "-ne") result = Number(left) !== Number(right);
      else if (op === "-gt") result = Number(left) > Number(right);
      else if (op === "-lt") result = Number(left) < Number(right);
      else if (op === "-ge") result = Number(left) >= Number(right);
      else if (op === "-le") result = Number(left) <= Number(right);
    }
    if (negate) result = !result;
    return result ? 0 : 1;
  };
  builtins.set("test", testHandler);
  builtins.set("[", testHandler);

  builtins.set("xargs", async (argv, ctx) => {
    const command = argv.length > 0 ? argv : ["echo"];
    const items = ctx.io.stdin.split(/\s+/).filter(Boolean);
    const script = [...command, ...items]
      .map((part) => `'${part.replace(/'/g, "'\\''")}'`)
      .join(" ");
    return ctx.runScript(script, ctx.io);
  });

  builtins.set("which", (argv, ctx) => {
    // The runtime overrides this with knowledge of registered commands.
    ctx.io.write(`${argv[0] ?? ""}: shell builtin\n`);
    return 0;
  });

  return builtins;
}
