import type { AskQuestionOption, AskQuestionStep, ChatMessage } from "./types";

const DEFAULT_OTHER: Omit<AskQuestionOption, "letter"> = {
  text: "Other",
  isOther: true,
  placeholder: "Describe what to do next…",
};

function nextLetter(options: AskQuestionOption[]): string {
  const used = new Set(options.map((o) => o.letter));
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    if (!used.has(L)) return L;
  }
  return "?";
}

/** Non–`isOther` options first, then `Other` row(s). Appends Other if missing. */
export function normalizeQuestionOptions(
  options: AskQuestionOption[]
): AskQuestionOption[] {
  const primary = options.filter((o) => !o.isOther);
  const others = options.filter((o) => o.isOther);
  const merged: AskQuestionOption[] = [...primary];
  if (others.length > 0) {
    merged.push(others[0]);
  } else {
    merged.push({
      letter: nextLetter(primary),
      ...DEFAULT_OTHER,
    });
  }
  return merged;
}

function normalizeStep(step: AskQuestionStep): AskQuestionStep {
  return {
    ...step,
    options: normalizeQuestionOptions(step.options),
  };
}

export function askStepsFromMessage(
  msg: Pick<ChatMessage, "questionSteps" | "questionTitle" | "options">
): AskQuestionStep[] {
  if (msg.questionSteps?.length) {
    return msg.questionSteps.map(normalizeStep);
  }
  if (msg.questionTitle && msg.options?.length) {
    return [
      normalizeStep({
        id: "single",
        title: msg.questionTitle,
        allowMultiple: false,
        options: msg.options,
      }),
    ];
  }
  return [];
}
