import { asRecord, asString } from "./cesium-coerce.js";

export type CesiumQuestionOption = { id: string; label: string };

export type CesiumParsedQuestionStep = {
  id: string;
  prompt: string;
  options: CesiumQuestionOption[];
  allowMultiple: boolean;
};

export type ParsedAskQuestionArgs = {
  prompt: string;
  options: CesiumQuestionOption[];
  questions: CesiumParsedQuestionStep[];
  allowMultiple: boolean;
};

const PROMPT_KEYS = [
  "prompt",
  "question",
  "title",
  "text",
  "message",
  "content",
  "header",
  "query",
] as const;

const OPTIONS_KEYS = [
  "options",
  "choices",
  "answers",
  "buttons",
  "selections",
  "suggestions",
] as const;

const QUESTIONS_KEYS = ["questions", "steps", "items"] as const;

const OPTION_LABEL_KEYS = [
  "label",
  "text",
  "title",
  "value",
  "name",
  "option",
  "content",
  "description",
] as const;

function firstString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asString(record[key]);
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstArray(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): unknown[] | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function asTruthyFlag(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

function parseAllowMultiple(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) {
    return false;
  }
  return (
    asTruthyFlag(record.allowMultiple) ||
    asTruthyFlag(record.allow_multiple) ||
    asTruthyFlag(record.multiple) ||
    asTruthyFlag(record.multiSelect) ||
    asTruthyFlag(record.multi_select)
  );
}

/** Accepts strings, numbers, or records keyed by any common label field. */
export function parseQuestionOptions(value: unknown): CesiumQuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option, index) => {
    if (typeof option === "string" || typeof option === "number") {
      const label = String(option).trim();
      return label ? [{ id: `option-${index + 1}`, label }] : [];
    }
    const record = asRecord(option);
    const label = firstString(record, OPTION_LABEL_KEYS);
    if (!label) {
      return [];
    }
    return [{ id: asString(record?.id)?.trim() || `option-${index + 1}`, label }];
  });
}

function parseQuestionStep(value: unknown, index: number): CesiumParsedQuestionStep | null {
  if (typeof value === "string") {
    const prompt = value.trim();
    // Open-ended: the client always appends a free-text "Other" answer.
    return prompt
      ? { id: `question-${index + 1}`, prompt, options: [], allowMultiple: false }
      : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const prompt = firstString(record, PROMPT_KEYS);
  if (!prompt) {
    return null;
  }
  return {
    id: asString(record.id)?.trim() || `question-${index + 1}`,
    prompt,
    options: parseQuestionOptions(firstArray(record, OPTIONS_KEYS)),
    allowMultiple: parseAllowMultiple(record),
  };
}

/**
 * Liberal ask_question argument parsing. Models phrase this call in many shapes -
 * `question` instead of `prompt`, `choices` instead of `options`, plain-string option
 * and question arrays, nested single-question objects, or no options at all (open-ended;
 * the client renders a free-text "Other" answer). All of them should just work.
 */
export function parseAskQuestionArgs(args: Record<string, unknown>): ParsedAskQuestionArgs {
  const questionsRaw = firstArray(args, QUESTIONS_KEYS);
  const questionsFromArgs = (questionsRaw ?? []).flatMap((entry, index) => {
    const step = parseQuestionStep(entry, index);
    return step ? [step] : [];
  });

  // `question` may itself be a nested object: { question: { prompt, options } }.
  const nestedQuestion =
    questionsFromArgs.length === 0 && asRecord(args.question)
      ? parseQuestionStep(args.question, 0)
      : null;

  const topLevelPrompt = firstString(args, PROMPT_KEYS);
  const topLevelOptions = parseQuestionOptions(firstArray(args, OPTIONS_KEYS));
  const topLevelAllowMultiple = parseAllowMultiple(args);

  let questions: CesiumParsedQuestionStep[];
  if (questionsFromArgs.length > 0) {
    questions = questionsFromArgs;
  } else if (nestedQuestion) {
    questions = [
      {
        ...nestedQuestion,
        id: "single",
        options: nestedQuestion.options.length > 0 ? nestedQuestion.options : topLevelOptions,
        allowMultiple: nestedQuestion.allowMultiple || topLevelAllowMultiple,
      },
    ];
  } else if (topLevelPrompt) {
    questions = [
      {
        id: "single",
        prompt: topLevelPrompt,
        options: topLevelOptions,
        allowMultiple: topLevelAllowMultiple,
      },
    ];
  } else {
    questions = [];
  }

  if (questions.length === 0) {
    throw new Error(
      'ask_question needs a question to show the user. Provide `prompt` (string) plus optional `options` (array of strings), e.g. {"prompt":"Which approach should I take?","options":["Refactor now","Ship as-is"]}, or multiple steps via {"questions":[{"prompt":"…","options":["…"]}]}. Options may be omitted for open-ended questions - the user always gets a free-text answer field.'
    );
  }

  const prompt =
    topLevelPrompt ?? (questions.length > 1 ? "Questions" : questions[0]!.prompt);
  return {
    prompt,
    options: topLevelOptions.length > 0 ? topLevelOptions : questions[0]!.options,
    questions,
    allowMultiple: topLevelAllowMultiple || Boolean(questions[0]?.allowMultiple),
  };
}
