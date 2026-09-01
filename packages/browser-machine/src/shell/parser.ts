/**
 * Minimal POSIX-ish shell parser: quoting, variable expansion, pipelines,
 * logical operators, sequences, redirects, env-prefix assignments, and
 * single-level command substitution. Loops/conditionals/subshells are out
 * of scope for the browser machine's built-in shell.
 */

export type Redirect = {
  kind: ">" | ">>" | "<" | "2>" | "2>>" | "2>&1";
  target?: string;
};

export type SimpleCommand = {
  assignments: Array<{ name: string; value: string }>;
  argv: string[];
  redirects: Redirect[];
};

export type Pipeline = {
  commands: SimpleCommand[];
};

export type ListEntry = {
  pipeline: Pipeline;
  /** Operator joining this entry to the NEXT one. */
  next: "&&" | "||" | ";" | null;
};

export type ParsedScript = ListEntry[];

type Token =
  | { kind: "word"; parts: WordPart[] }
  | { kind: "op"; op: "&&" | "||" | "|" | ";" | ">" | ">>" | "<" | "2>" | "2>>" | "2>&1" };

export type WordPart =
  | { kind: "literal"; text: string }
  | { kind: "var"; name: string }
  | { kind: "command"; script: string };

export class ShellParseError extends Error {}

const OP_PATTERNS: Array<{ text: string; op: Token & { kind: "op" } extends never ? never : Extract<Token, { kind: "op" }>["op"] }> = [
  { text: "2>&1", op: "2>&1" },
  { text: "2>>", op: "2>>" },
  { text: "2>", op: "2>" },
  { text: ">>", op: ">>" },
  { text: "&&", op: "&&" },
  { text: "||", op: "||" },
  { text: ">", op: ">" },
  { text: "<", op: "<" },
  { text: "|", op: "|" },
  { text: ";", op: ";" },
];

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

  while (i < n) {
    const ch = input[i] as string;
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "#") {
      // Comment to end of line.
      while (i < n && input[i] !== "\n") i += 1;
      continue;
    }
    let matchedOp = false;
    for (const pattern of OP_PATTERNS) {
      if (input.startsWith(pattern.text, i)) {
        tokens.push({ kind: "op", op: pattern.op });
        i += pattern.text.length;
        matchedOp = true;
        break;
      }
    }
    if (matchedOp) continue;

    // Word: sequence of quoted/unquoted parts.
    const parts: WordPart[] = [];
    let literal = "";
    const flushLiteral = (): void => {
      if (literal) {
        parts.push({ kind: "literal", text: literal });
        literal = "";
      }
    };
    while (i < n) {
      const c = input[i] as string;
      if (isSpace(c)) break;
      let isOpStart = false;
      for (const pattern of OP_PATTERNS) {
        if (input.startsWith(pattern.text, i)) {
          isOpStart = true;
          break;
        }
      }
      if (isOpStart) break;

      if (c === "'") {
        const end = input.indexOf("'", i + 1);
        if (end === -1) throw new ShellParseError("Unterminated single quote");
        literal += input.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        i += 1;
        while (i < n && input[i] !== '"') {
          const dc = input[i] as string;
          if (dc === "\\" && i + 1 < n && ['"', "\\", "$", "`"].includes(input[i + 1] as string)) {
            literal += input[i + 1];
            i += 2;
            continue;
          }
          if (dc === "$") {
            const consumed = consumeDollar(input, i, parts, () => {
              flushLiteral();
            });
            if (consumed > 0) {
              i += consumed;
              continue;
            }
          }
          literal += dc;
          i += 1;
        }
        if (i >= n) throw new ShellParseError("Unterminated double quote");
        i += 1;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        literal += input[i + 1];
        i += 2;
        continue;
      }
      if (c === "$") {
        const consumed = consumeDollar(input, i, parts, () => {
          flushLiteral();
        });
        if (consumed > 0) {
          i += consumed;
          continue;
        }
        literal += c;
        i += 1;
        continue;
      }
      literal += c;
      i += 1;
    }
    flushLiteral();
    if (parts.length === 0) {
      parts.push({ kind: "literal", text: "" });
    }
    tokens.push({ kind: "word", parts });
  }
  return tokens;

  function consumeDollar(
    source: string,
    start: number,
    outParts: WordPart[],
    flush: () => void
  ): number {
    const next = source[start + 1];
    if (next === "(") {
      // $( ... ) command substitution with nesting-aware scan.
      let depth = 1;
      let j = start + 2;
      while (j < source.length && depth > 0) {
        if (source[j] === "(") depth += 1;
        if (source[j] === ")") depth -= 1;
        j += 1;
      }
      if (depth !== 0) throw new ShellParseError("Unterminated command substitution");
      flush();
      outParts.push({ kind: "command", script: source.slice(start + 2, j - 1) });
      return j - start;
    }
    if (next === "{") {
      const end = source.indexOf("}", start + 2);
      if (end === -1) throw new ShellParseError("Unterminated ${...}");
      flush();
      outParts.push({ kind: "var", name: source.slice(start + 2, end) });
      return end + 1 - start;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^[?$#@!]/.exec(source.slice(start + 1));
    if (match) {
      flush();
      outParts.push({ kind: "var", name: match[0] });
      return match[0].length + 1;
    }
    return 0;
  }
}

export type ParsedWord = { parts: WordPart[] };

export type ParsedSimpleCommand = {
  assignments: Array<{ name: string; word: ParsedWord }>;
  words: ParsedWord[];
  redirects: Array<{ kind: Redirect["kind"]; word: ParsedWord | null }>;
};

export type ParsedPipeline = { commands: ParsedSimpleCommand[] };
export type ParsedListEntry = { pipeline: ParsedPipeline; next: "&&" | "||" | ";" | null };

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseScript(input: string): ParsedListEntry[] {
  const tokens = tokenize(input);
  const entries: ParsedListEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const pipeline: ParsedPipeline = { commands: [] };
    let command: ParsedSimpleCommand = { assignments: [], words: [], redirects: [] };
    let sawWord = false;

    const pushCommand = (): void => {
      if (command.words.length > 0 || command.assignments.length > 0) {
        pipeline.commands.push(command);
      }
      command = { assignments: [], words: [], redirects: [] };
    };

    while (index < tokens.length) {
      const token = tokens[index] as Token;
      if (token.kind === "op") {
        if (token.op === "|") {
          index += 1;
          pushCommand();
          sawWord = false;
          continue;
        }
        if (token.op === "&&" || token.op === "||" || token.op === ";") {
          break;
        }
        // Redirect operator; next word (if any) is the target.
        index += 1;
        if (token.op === "2>&1") {
          command.redirects.push({ kind: token.op, word: null });
          continue;
        }
        const target = tokens[index];
        if (!target || target.kind !== "word") {
          throw new ShellParseError(`Missing redirect target after ${token.op}`);
        }
        index += 1;
        command.redirects.push({ kind: token.op, word: { parts: target.parts } });
        continue;
      }
      // Word token.
      const isAssignment =
        !sawWord &&
        token.parts[0]?.kind === "literal" &&
        ASSIGNMENT_RE.test((token.parts[0] as { text: string }).text);
      if (isAssignment) {
        const firstLiteral = (token.parts[0] as { kind: "literal"; text: string }).text;
        const eq = firstLiteral.indexOf("=");
        const name = firstLiteral.slice(0, eq);
        const remainder = firstLiteral.slice(eq + 1);
        const valueParts: WordPart[] = [];
        if (remainder) valueParts.push({ kind: "literal", text: remainder });
        valueParts.push(...token.parts.slice(1));
        command.assignments.push({
          name,
          word: { parts: valueParts.length ? valueParts : [{ kind: "literal", text: "" }] },
        });
        index += 1;
        continue;
      }
      sawWord = true;
      command.words.push({ parts: token.parts });
      index += 1;
    }

    pushCommand();
    let next: "&&" | "||" | ";" | null = null;
    const opToken = tokens[index];
    if (opToken && opToken.kind === "op") {
      if (opToken.op === "&&" || opToken.op === "||" || opToken.op === ";") {
        next = opToken.op;
        index += 1;
      }
    }
    if (pipeline.commands.length > 0) {
      entries.push({ pipeline, next });
    } else if (next === null) {
      break;
    }
  }
  return entries;
}
