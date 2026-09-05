/**
 * Minimal VS Code `when`-clause evaluator.
 *
 * Supports the subset that covers the vast majority of real extension
 * manifests: `&&`, `||`, `!`, parentheses, `==`, `!=`, `=~` (regex),
 * comparison operators, quoted/bare literals, and bare context keys.
 */

export type WhenClauseContext = Record<string, unknown>;

type Token =
  | { kind: "op"; value: "&&" | "||" | "!" | "(" | ")" | "==" | "!=" | "=~" | ">" | ">=" | "<" | "<=" }
  | { kind: "value"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (value: Token["value"], kind: Token["kind"] = "op") =>
    tokens.push({ kind, value } as Token);
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const two = input.slice(index, index + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === "=~" || two === ">=" || two === "<=") {
      push(two);
      index += 2;
      continue;
    }
    if (char === "!" || char === "(" || char === ")" || char === ">" || char === "<") {
      push(char as Token["value"]);
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = input.indexOf(char, index + 1);
      const literal = end < 0 ? input.slice(index + 1) : input.slice(index + 1, end);
      tokens.push({ kind: "value", value: `'${literal}` });
      index = end < 0 ? input.length : end + 1;
      continue;
    }
    if (char === "/") {
      // Regex literal used with =~ (e.g. /\.tsx?$/)
      let end = index + 1;
      while (end < input.length && (input[end] !== "/" || input[end - 1] === "\\")) {
        end += 1;
      }
      let flagsEnd = end + 1;
      while (flagsEnd < input.length && /[a-z]/i.test(input[flagsEnd]!)) {
        flagsEnd += 1;
      }
      tokens.push({ kind: "value", value: `/${input.slice(index + 1, end)}/${input.slice(end + 1, flagsEnd)}` });
      index = flagsEnd;
      continue;
    }
    let end = index;
    while (end < input.length && !/[\s!()=<>&|]/.test(input[end]!)) {
      end += 1;
    }
    if (end === index) {
      index += 1;
      continue;
    }
    tokens.push({ kind: "value", value: input.slice(index, end) });
    index = end;
  }
  return tokens;
}

function resolveValue(raw: string, context: WhenClauseContext): unknown {
  if (raw.startsWith("'")) return raw.slice(1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return context[raw];
}

/** RHS of ==/!= comparisons: bare words are literals (VS Code semantics). */
function resolveLiteral(raw: string): unknown {
  if (raw.startsWith("'")) return raw.slice(1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function truthy(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

class Parser {
  private position = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: WhenClauseContext
  ) {}

  parse(): boolean {
    const result = this.parseOr();
    if (this.position < this.tokens.length) {
      // Unconsumed tokens mean we hit syntax we don't model; treating the
      // clause as visible beats silently hiding features.
      throw new Error("Unparsed when-clause tokens");
    }
    return truthy(result);
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek()?.kind === "op" && this.peek()?.value === "||") {
      this.next();
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseComparison();
    while (this.peek()?.kind === "op" && this.peek()?.value === "&&") {
      this.next();
      const right = this.parseComparison();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseComparison(): unknown {
    const left = this.parseUnary();
    const peeked = this.peek();
    if (peeked?.kind === "value" && (peeked.value === "in" || peeked.value === "not")) {
      // `key in collection` / `key not in collection`
      this.next();
      let negate = false;
      if (peeked.value === "not") {
        const inToken = this.next();
        if (!(inToken?.kind === "value" && inToken.value === "in")) {
          throw new Error("Expected 'in' after 'not'");
        }
        negate = true;
      }
      const rightToken = this.next();
      const rightRaw = rightToken?.kind === "value" ? rightToken.value : "";
      const collection = resolveValue(rightRaw, this.context);
      let contained = false;
      if (Array.isArray(collection)) {
        contained = collection.some((entry) => String(entry) === String(left ?? ""));
      } else if (collection && typeof collection === "object") {
        contained = String(left ?? "") in (collection as Record<string, unknown>);
      }
      return negate ? !contained : contained;
    }
    const operator = this.peek();
    if (
      operator?.kind === "op" &&
      (operator.value === "==" ||
        operator.value === "!=" ||
        operator.value === "=~" ||
        operator.value === ">" ||
        operator.value === ">=" ||
        operator.value === "<" ||
        operator.value === "<=")
    ) {
      this.next();
      const rightToken = this.next();
      const rightRaw = rightToken?.kind === "value" ? rightToken.value : "";
      if (operator.value === "=~") {
        const match = /^\/(.*)\/([a-z]*)$/.exec(rightRaw);
        try {
          const regex = match
            ? new RegExp(match[1] ?? "", match[2])
            : new RegExp(rightRaw.startsWith("'") ? rightRaw.slice(1) : rightRaw);
          return regex.test(String(left ?? ""));
        } catch {
          return false;
        }
      }
      const right = resolveLiteral(rightRaw);
      if (operator.value === "==") return String(left ?? "") === String(right ?? "") || left === right;
      if (operator.value === "!=") return !(String(left ?? "") === String(right ?? "") || left === right);
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) return false;
      if (operator.value === ">") return leftNum > rightNum;
      if (operator.value === ">=") return leftNum >= rightNum;
      if (operator.value === "<") return leftNum < rightNum;
      return leftNum <= rightNum;
    }
    return left;
  }

  private parseUnary(): unknown {
    const token = this.peek();
    if (token?.kind === "op" && token.value === "!") {
      this.next();
      return !truthy(this.parseUnary());
    }
    if (token?.kind === "op" && token.value === "(") {
      this.next();
      const inner = this.parseOr();
      if (this.peek()?.kind === "op" && this.peek()?.value === ")") {
        this.next();
      }
      return inner;
    }
    const value = this.next();
    if (!value || value.kind !== "value") {
      return false;
    }
    return resolveValue(value.value, this.context);
  }
}

/**
 * Evaluates a `when` clause against context keys. Empty/undefined clauses are
 * always true (matching VS Code semantics).
 */
export function evaluateWhenClause(
  clause: string | undefined | null,
  context: WhenClauseContext
): boolean {
  if (!clause || !clause.trim()) return true;
  try {
    return new Parser(tokenize(clause), context).parse();
  } catch {
    // Unparseable clauses are treated as visible; hiding features on parser
    // gaps is worse than occasionally showing an inert item.
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Shared context-key store (fed by setContext events per workspace)   */
/* ------------------------------------------------------------------ */

const contextStores = new Map<string, Map<string, unknown>>();

export function setExtensionContextKey(workspaceId: string, key: string, value: unknown): void {
  let store = contextStores.get(workspaceId);
  if (!store) {
    store = new Map();
    contextStores.set(workspaceId, store);
  }
  store.set(key, value);
}

export function replaceExtensionContextKeys(
  workspaceId: string,
  keys: Record<string, unknown>
): void {
  contextStores.set(workspaceId, new Map(Object.entries(keys)));
}

export function getExtensionContextKeys(workspaceId: string): WhenClauseContext {
  return Object.fromEntries(contextStores.get(workspaceId) ?? []);
}
