/**
 * Event notification policy for the voice control plane.
 *
 * Speak promptly: permission requests, agent questions, failures.
 * Queue/show: routine completions and everything verbose. Queued items
 * become one spoken digest instead of several interruptions.
 *
 * Pure module: consumes conversation record transitions (the same records
 * the agent WebSocket keeps fresh), no DOM, fully unit-tested.
 */

export type VoiceWatchedConversation = {
  id: string;
  title: string;
  status: string;
  pendingPermissionTitle: string | null;
  pendingQuestion: boolean;
  lastError: string | null;
};

export type VoiceNotificationKind =
  | "permission"
  | "question"
  | "failure"
  | "completion";

export type VoiceNotificationPolicy = "speak" | "show" | "queue";

export type VoiceNotification = {
  id: string;
  kind: VoiceNotificationKind;
  conversationId: string;
  title: string;
  spokenText: string;
  displayText: string;
  policy: VoiceNotificationPolicy;
};

const TERMINAL_RUNNING = new Set(["running", "pause_requested", "pausing"]);

/**
 * Diffs consecutive conversation-record snapshots into notifications.
 * Conversations unseen in `previous` are primed silently (no notification
 * flood on initial load).
 */
export function diffConversationsForNotifications(
  previous: Map<string, VoiceWatchedConversation>,
  next: VoiceWatchedConversation[],
  options?: {
    /** Conversations the user explicitly asked to be told about. */
    speakCompletionsFor?: Set<string>;
  }
): VoiceNotification[] {
  const notifications: VoiceNotification[] = [];
  for (const record of next) {
    const before = previous.get(record.id);
    if (!before) continue;

    if (record.pendingPermissionTitle && !before.pendingPermissionTitle) {
      const what = record.pendingPermissionTitle;
      notifications.push({
        id: `${record.id}:permission:${what}`,
        kind: "permission",
        conversationId: record.id,
        title: record.title,
        spokenText: `${record.title} needs permission: ${what}.`,
        displayText: `**${record.title}** requests permission: ${what}`,
        policy: "speak",
      });
    }

    if (record.pendingQuestion && !before.pendingQuestion) {
      notifications.push({
        id: `${record.id}:question:${record.status}`,
        kind: "question",
        conversationId: record.id,
        title: record.title,
        spokenText: `${record.title} is asking you a question.`,
        displayText: `**${record.title}** is waiting on a question`,
        policy: "speak",
      });
    }

    if (record.status === "failed" && before.status !== "failed") {
      notifications.push({
        id: `${record.id}:failure:${record.lastError ?? ""}`,
        kind: "failure",
        conversationId: record.id,
        title: record.title,
        spokenText: `${record.title} hit a failure.`,
        displayText: `**${record.title}** failed${record.lastError ? `: ${record.lastError}` : ""}`,
        policy: "speak",
      });
    }

    if (record.status === "idle" && TERMINAL_RUNNING.has(before.status)) {
      const watched = options?.speakCompletionsFor?.has(record.id) ?? false;
      notifications.push({
        id: `${record.id}:completion:${Date.now()}`,
        kind: "completion",
        conversationId: record.id,
        title: record.title,
        spokenText: `${record.title} finished.`,
        displayText: `**${record.title}** finished its turn`,
        // Routine completion never interrupts; explicit "tell me when it's
        // done" sessions speak promptly.
        policy: watched ? "speak" : "queue",
      });
    }
  }
  return notifications;
}

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * Folds queued notifications into one digest sentence, e.g.
 * "Three things happened while you were busy. The auth fix finished. The
 * mobile build failed."
 */
export function buildDigestSpokenText(items: VoiceNotification[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!.spokenText;
  const lead = `${countWord(items.length)} things happened while you were busy.`;
  const details = items
    .slice(0, 5)
    .map((item) => item.spokenText.replace(/\s+$/, ""))
    .join(" ");
  const overflow =
    items.length > 5 ? ` And ${countWord(items.length - 5)} more.` : "";
  const capitalized = lead.charAt(0).toUpperCase() + lead.slice(1);
  return `${capitalized} ${details}${overflow}`;
}
