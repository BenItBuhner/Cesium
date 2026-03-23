/** Ephemeral demo shell: paths are POSIX-style; HOME matches mock prompt. */

export const SHELL_HOME = "/home/ben";
export const SHELL_START_CWD = "/home/ben/Projects/DEMO-PROJECT";

export interface ShellState {
  cwd: string;
}

type DirEntry = { dirs: string[]; files: string[] };

const FS: Record<string, DirEntry> = {
  "/": { dirs: ["home"], files: [] },
  "/home": { dirs: ["ben"], files: [] },
  [SHELL_HOME]: { dirs: ["Projects"], files: [".bashrc"] },
  [`${SHELL_HOME}/Projects`]: { dirs: ["DEMO-PROJECT"], files: [] },
  [SHELL_START_CWD]: {
    dirs: ["src", "node_modules"],
    files: ["README.md", "package.json", ".gitignore"],
  },
  [`${SHELL_START_CWD}/src`]: {
    dirs: ["app", "components", "lib"],
    files: [],
  },
  [`${SHELL_START_CWD}/src/app`]: {
    dirs: [],
    files: ["globals.css", "layout.tsx", "page.tsx"],
  },
  [`${SHELL_START_CWD}/src/components`]: {
    dirs: ["ui", "layout", "editor", "chat"],
    files: [],
  },
  [`${SHELL_START_CWD}/src/lib`]: {
    dirs: [],
    files: ["types.ts", "mock-data.ts"],
  },
  [`${SHELL_START_CWD}/node_modules`]: {
    dirs: [],
    files: ["…"],
  },
};

const FILE_BODIES: Record<string, string> = {
  [`${SHELL_START_CWD}/README.md`]: "# DEMO-PROJECT\n\nDemo workspace for the IDE shell.",
  [`${SHELL_START_CWD}/package.json`]: `{
  "name": "demo-project",
  "version": "1.0.0",
  "scripts": { "dev": "next dev" }
}`,
};

function isDir(path: string): boolean {
  return FS[path] !== undefined;
}

function fileExists(path: string): boolean {
  const parent = path.replace(/\/[^/]+$/, "") || "/";
  const name = path.split("/").pop() ?? "";
  const d = FS[parent];
  return d !== undefined && d.files.includes(name);
}

export function resolvePath(cwd: string, raw: string): string {
  let path = raw.trim();
  if (path === "") path = ".";
  if (path.startsWith("~")) {
    path = path === "~" ? SHELL_HOME : SHELL_HOME + path.slice(1);
  } else if (!path.startsWith("/")) {
    path = `${cwd}/${path}`;
  }
  const segments = path.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const p of segments) {
    if (p === "..") {
      if (stack.length) stack.pop();
    } else if (p !== ".") {
      stack.push(p);
    }
  }
  return `/${stack.join("/")}`;
}

export function formatPrompt(cwd: string): string {
  if (cwd === SHELL_HOME) return "ben@studio:~$";
  const prefix = `${SHELL_HOME}/`;
  if (cwd.startsWith(prefix)) {
    return `ben@studio:~/${cwd.slice(prefix.length)}$`;
  }
  return `ben@studio:${cwd}$`;
}

function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as "'" | '"';
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export type ShellOutput =
  | { kind: "lines"; lines: string[] }
  | { kind: "clear" };

export function runCommand(
  line: string,
  state: ShellState
): { state: ShellState; output: ShellOutput } {
  const trimmed = line.trim();
  if (!trimmed) {
    return { state, output: { kind: "lines", lines: [] } };
  }

  const argv = splitArgs(trimmed);
  const cmd = argv[0] ?? "";
  const args = argv.slice(1);

  switch (cmd) {
    case "clear": {
      return { state, output: { kind: "clear" } };
    }
    case "pwd": {
      return { state, output: { kind: "lines", lines: [state.cwd] } };
    }
    case "whoami": {
      return { state, output: { kind: "lines", lines: ["ben"] } };
    }
    case "date": {
      return {
        state,
        output: { kind: "lines", lines: [new Date().toString()] },
      };
    }
    case "echo": {
      return { state, output: { kind: "lines", lines: [args.join(" ")] } };
    }
    case "help": {
      return {
        state,
        output: {
          kind: "lines",
          lines: [
            "Demo shell — try: clear, ls, cd, pwd, echo, cat, help, whoami, date",
            "  npm run dev  — fake Next.js dev banner",
          ],
        },
      };
    }
    case "cd": {
      const target = args[0] ?? SHELL_HOME;
      const next = resolvePath(state.cwd, target);
      if (!isDir(next)) {
        return {
          state,
          output: {
            kind: "lines",
            lines: [`cd: ${args[0] ?? target}: No such file or directory`],
          },
        };
      }
      return { state: { cwd: next }, output: { kind: "lines", lines: [] } };
    }
    case "ls": {
      const showAll = args.includes("-a") || args.includes("-la");
      const pathArgs = args.filter((a) => !a.startsWith("-"));
      const targetPath =
        pathArgs.length > 0 ? resolvePath(state.cwd, pathArgs[0]) : state.cwd;
      const dir = FS[targetPath];
      if (!dir) {
        if (fileExists(targetPath)) {
          return {
            state,
            output: { kind: "lines", lines: [pathArgs[0] ?? targetPath] },
          };
        }
        return {
          state,
          output: {
            kind: "lines",
            lines: [
              `ls: cannot access '${pathArgs[0] ?? targetPath}': No such file or directory`,
            ],
          },
        };
      }
      const names = [
        ...(showAll ? [".", ".."] : []),
        ...dir.dirs.map((d) => `${d}/`),
        ...dir.files,
      ].sort();
      return { state, output: { kind: "lines", lines: [names.join("  ")] } };
    }
    case "cat": {
      if (args.length === 0) {
        return {
          state,
          output: { kind: "lines", lines: ["cat: missing operand"] },
        };
      }
      const p = resolvePath(state.cwd, args[0]);
      const body = FILE_BODIES[p];
      if (body === undefined) {
        return {
          state,
          output: {
            kind: "lines",
            lines: [`cat: ${args[0]}: No such file`],
          },
        };
      }
      return { state, output: { kind: "lines", lines: body.split("\n") } };
    }
    case "npm": {
      if (args[0] === "run" && args[1] === "dev") {
        return {
          state,
          output: {
            kind: "lines",
            lines: [
              "",
              "> demo-project@1.0.0 dev",
              "> next dev",
              "",
              "  ▲ Next.js 16.1.7 (demo)",
              "  - Local:    http://localhost:3000",
              "",
              " ✓ Starting…",
              " ✓ Ready in 1.2s (fake)",
            ],
          },
        };
      }
      return {
        state,
        output: {
          kind: "lines",
          lines: [`npm: demo only supports: npm run dev`],
        },
      };
    }
    default: {
      return {
        state,
        output: {
          kind: "lines",
          lines: [`bash: ${cmd}: command not found`],
        },
      };
    }
  }
}

/** Drop trailing mock prompt line so the live prompt is not duplicated. */
export function initialScrollbackLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const last = lines[lines.length - 1];
  if (last !== undefined && /^ben@studio:.+\$\s*$/.test(last)) {
    lines.pop();
  }
  return lines;
}
