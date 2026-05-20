import { askStepsFromMessage } from "@/lib/ask-question-utils";
import type {
  AgentConversationRecord,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { AskQuestionStep, ChatMessage } from "@/lib/types";

export type DockedAskQuestion = {
  questionId: string;
  steps: AskQuestionStep[];
};

export function findLatestPendingQuestionEvent(
  events: AgentStoredEvent[] | undefined
): Extract<AgentStoredEvent, { kind: "question" }> | null {
  if (!events?.length) {
    return null;
  }
  const byId = new Map<string, Extract<AgentStoredEvent, { kind: "question" }>>();
  for (const event of events) {
    if (event.kind !== "question") {
      continue;
    }
    byId.set(event.questionId, event);
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "question") {
      continue;
    }
    const latest = byId.get(event.questionId);
    if (latest?.status === "pending") {
      return latest;
    }
  }
  return null;
}

export function questionEventToChatMessage(
  event: Extract<AgentStoredEvent, { kind: "question" }>
): ChatMessage {
  return {
    id: `question-${event.questionId}`,
    type: "ask-question",
    questionTitle: event.prompt,
    options: event.options.map((option, index) => ({
      letter: option.id || String.fromCharCode(65 + index),
      text: option.label,
    })),
  };
}

export function findDockedAskQuestion(input: {
  events: AgentStoredEvent[] | undefined;
  conversation?: AgentConversationRecord | null;
}): DockedAskQuestion | null {
  const { events, conversation } = input;
  const pending = findLatestPendingQuestionEvent(events);
  if (!pending) {
    return null;
  }
  if (
    conversation &&
    conversation.status !== "awaiting_question" &&
    conversation.pendingQuestion?.questionId !== pending.questionId
  ) {
    return null;
  }
  const steps = askStepsFromMessage(questionEventToChatMessage(pending));
  if (!steps.length) {
    return null;
  }
  return { questionId: pending.questionId, steps };
}

export function partitionMessagesForAskDock(messages: ChatMessage[]): {
  scrollMessages: ChatMessage[];
  dockedAskMessage: ChatMessage | null;
} {
  const last = messages[messages.length - 1];
  if (last?.type === "ask-question") {
    return {
      scrollMessages: messages.slice(0, -1),
      dockedAskMessage: last,
    };
  }
  return { scrollMessages: messages, dockedAskMessage: null };
}

export function hideDockedAskFromScroll(
  scrollMessages: ChatMessage[],
  docked: DockedAskQuestion | null
): ChatMessage[] {
  if (!docked) {
    return scrollMessages;
  }
  return scrollMessages.filter(
    (message) =>
      message.type !== "ask-question" ||
      message.id !== `question-${docked.questionId}`
  );
}

export function formatAskQuestionSubmission(
  steps: AskQuestionStep[],
  stepUi: Record<string, { letter: string | null; otherDraft: string }>
): string {
  return steps
    .map((step, index) => {
      const ui = stepUi[step.id] ?? { letter: null, otherDraft: "" };
      const option = step.options.find((entry) => entry.letter === ui.letter);
      if (!option) {
        return `Question ${index + 1}: (no selection)`;
      }
      const answerText = option.isOther
        ? ui.otherDraft.trim() || option.text
        : option.text;
      const label = step.title.trim() || `Question ${index + 1}`;
      return `${label}: ${answerText}`;
    })
    .join("\n");
}
