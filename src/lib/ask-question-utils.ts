import type { AskQuestionStep, ChatMessage } from "@/lib/types";

export function askStepsFromMessage(
  msg: Pick<ChatMessage, "questionSteps" | "questionTitle" | "options">
): AskQuestionStep[] {
  if (msg.questionSteps?.length) return msg.questionSteps;
  if (msg.questionTitle && msg.options?.length) {
    return [{ id: "single", title: msg.questionTitle, options: msg.options }];
  }
  return [];
}
