import type { AgentPlanEntry, AgentStoredEvent } from "../types.js";
import { asRecord, asString, truncate, truncateMiddle } from "./cesium-coerce.js";

const DIGEST_MAX_CHARS = 16_000;
const SECTION_ITEM_LIMIT = 20;

/** Tool arguments as the model sent them, whichever way the event stored them. */
function toolArguments(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): Record<string, unknown> {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  return asRecord(request?.arguments) ?? {};
}

function toolName(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): string {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  return asString(request?.name) ?? event.title.split(" ")[0] ?? "tool";
}

function newest<T>(items: T[], limit = SECTION_ITEM_LIMIT): T[] {
  return items.length > limit ? items.slice(-limit) : items;
}

function section(title: string, lines: string[]): string | null {
  return lines.length > 0 ? `## ${title}\n${lines.join("\n")}` : null;
}

const FILE_VERBS: Record<string, string> = {
  read_file: "read",
  edit_file: "edited",
  write_file: "written",
};

/**
 * Deterministic compaction digest: what was asked, which files were read or
 * changed, which commands ran, what failed, what the assistant concluded and
 * the latest plan. No model call, so it is the floor under the model-written
 * summary and the fallback when that call fails.
 */
export function buildStructuredDigest(events: AgentStoredEvent[], previousSummary?: string): string {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const users: string[] = [];
  const files = new Map<string, Set<string>>();
  const commands: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const titles = new Map<string, string>();
  let plan: AgentPlanEntry[] | null = null;
  let assistantText = "";
  const flushAssistant = () => {
    if (assistantText.trim()) {
      notes.push(`- ${truncate(assistantText.trim().replace(/\s+/g, " "), 400)}`);
    }
    assistantText = "";
  };
  for (const event of sorted) {
    if (event.kind === "assistant_message_chunk") {
      assistantText += event.text;
      continue;
    }
    if (event.kind !== "reasoning") {
      flushAssistant();
    }
    switch (event.kind) {
      case "user_message":
        if (!event.hidden && event.content.trim()) {
          users.push(event.content.trim());
        }
        break;
      case "tool_call": {
        const name = toolName(event);
        const args = toolArguments(event);
        titles.set(event.toolCallId, event.title);
        const verb = FILE_VERBS[name];
        const filePath = asString(args.path);
        if (verb && filePath) {
          const verbs = files.get(filePath) ?? new Set<string>();
          verbs.add(verb);
          files.set(filePath, verbs);
        }
        const command = asString(args.command);
        if (name === "terminal" && command) {
          commands.push(`- ${truncate(command.replace(/\s+/g, " "), 200)}`);
        }
        break;
      }
      case "tool_call_update":
        if (event.status === "failed") {
          const title = event.title ?? titles.get(event.toolCallId) ?? event.toolCallId;
          const reason = (event.detail ?? "").trim().split("\n")[0] ?? "";
          failures.push(`- ${title}${reason ? `: ${truncate(reason, 240)}` : ""}`);
        }
        break;
      case "plan":
        plan = event.entries;
        break;
      default:
        break;
    }
  }
  flushAssistant();
  const [firstUser, ...laterUsers] = users;
  const sections = [
    previousSummary?.trim()
      ? `## Earlier summary\n${truncateMiddle(previousSummary.trim(), 4_000)}`
      : firstUser
        ? `## Original request\n${truncate(firstUser, 1_500)}`
        : null,
    section(
      "User messages",
      newest(previousSummary?.trim() ? users : laterUsers).map((text) => `- ${truncate(text.replace(/\s+/g, " "), 400)}`)
    ),
    section(
      "Files touched",
      newest([...files.entries()], 60).map(([file, verbs]) => `- ${file} (${[...verbs].join(", ")})`)
    ),
    section("Commands run", newest(commands)),
    section("Tried and failed", newest(failures)),
    section("Assistant notes", newest(notes)),
    plan ? section("Latest plan", plan.map((entry) => `- [${entry.status}] ${entry.content}`)) : null,
  ].filter((part): part is string => Boolean(part));
  return truncateMiddle(sections.join("\n\n"), DIGEST_MAX_CHARS);
}

export const COMPACTION_SUMMARY_SYSTEM_PROMPT = [
  "You summarize the earlier part of a coding agent's conversation so the agent can continue without it.",
  "Write for the agent itself. Be specific: name files, functions, commands, error messages and decisions.",
  "Use exactly these sections, as markdown headings, and omit none (write 'None.' when empty):",
  "## Objective",
  "## Decisions and why",
  "## Files touched",
  "## Tried and failed",
  "## Open questions",
  "## Next steps",
  "Do not invent anything that is not in the transcript. Do not address the user.",
].join("\n");

/** The user message for the summary call: the deterministic digest plus the transcript it came from. */
export function buildCompactionSummaryPrompt(input: {
  digest: string;
  transcript: string;
  maxTranscriptChars: number;
}): string {
  return [
    "Structured digest of the conversation so far:",
    input.digest,
    "",
    "Transcript of the part being summarized (oldest first; the middle may be elided):",
    truncateMiddle(input.transcript, input.maxTranscriptChars),
  ].join("\n");
}

/** One line per model-visible message, for the summary call's transcript. */
export function transcriptForSummary(messages: Array<{ role: string; content: string; name?: string }>): string {
  return messages
    .filter((message) => message.role !== "system" && message.content.trim())
    .map((message) => {
      const label = message.role === "tool" ? `Tool result (${message.name ?? "tool"})` : message.role;
      return `${label}: ${truncateMiddle(message.content.trim(), 2_000)}`;
    })
    .join("\n\n");
}

/** A model summary must look like one; otherwise the digest is kept. */
export function isUsableModelSummary(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 200 && /##\s*Objective/i.test(trimmed) && /##\s*Next steps/i.test(trimmed);
}

/** The summary as stored, with the current todo list re-attached so compaction never drops it. */
export function withCurrentTodos(summary: string, todos: AgentPlanEntry[] | null): string {
  if (!todos || todos.length === 0) {
    return summary;
  }
  return `${summary}\n\n## Current todo list\n${todos.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n")}`;
}
