import type { AgentConfigOption } from "./types.js";

export function configOptionMatchesCategory(
  option: AgentConfigOption,
  category: AgentConfigOption["category"] | "mode" | "model"
): boolean {
  if (option.category === category) {
    return true;
  }
  const lowerId = option.id.trim().toLowerCase();
  const lowerName = option.name.trim().toLowerCase();
  if (category === "mode") {
    return (
      lowerId === "mode" ||
      lowerId.endsWith("mode") ||
      lowerName.includes("mode") ||
      lowerName.includes("agent")
    );
  }
  if (category === "model") {
    return (
      lowerId === "model" ||
      lowerId.endsWith("model") ||
      lowerName.includes("model")
    );
  }
  return false;
}

function scoreModeOption(option: AgentConfigOption, index: number): number {
  let score = 0;
  if (option.category === "mode") {
    score += 10_000;
  }
  if (option.id.trim().toLowerCase() === "mode") {
    score += 5_000;
  }
  if (option.name.trim().toLowerCase() === "mode") {
    score += 2_000;
  }
  score += Math.min(option.options.length, 100);
  score -= index;
  return score;
}

function scoreModelOption(option: AgentConfigOption, index: number): number {
  let score = 0;
  if (option.category === "model") {
    score += 1_000_000;
  }
  if (option.id.trim().toLowerCase() === "model") {
    score += 500_000;
  }
  if (option.name.trim().toLowerCase() === "model") {
    score += 250_000;
  }
  score += Math.min(option.options.length, 100_000);
  score -= index;
  return score;
}

export function findPrimaryModeConfigOption(
  options: AgentConfigOption[]
): AgentConfigOption | undefined {
  const strict = options.filter((option) => {
    if (option.category === "mode") {
      return true;
    }
    const lid = option.id.trim().toLowerCase();
    const lname = option.name.trim().toLowerCase();
    return lid === "mode" || lname === "mode";
  });
  const pool = strict.length > 0 ? strict : options.filter((o) => configOptionMatchesCategory(o, "mode"));
  if (pool.length === 0) {
    return undefined;
  }
  return pool
    .map((option, index) => ({ option, index }))
    .sort((a, b) => scoreModeOption(b.option, b.index) - scoreModeOption(a.option, a.index))[0]!.option;
}

export function findPrimaryModelConfigOption(
  options: AgentConfigOption[]
): AgentConfigOption | undefined {
  const strict = options.filter((option) => {
    if (option.category === "model") {
      return true;
    }
    const lid = option.id.trim().toLowerCase();
    const lname = option.name.trim().toLowerCase();
    return lid === "model" || lname === "model";
  });
  const pool =
    strict.length > 0 ? strict : options.filter((o) => configOptionMatchesCategory(o, "model"));
  if (pool.length === 0) {
    return undefined;
  }
  return pool
    .map((option, index) => ({ option, index }))
    .sort((a, b) => scoreModelOption(b.option, b.index) - scoreModelOption(a.option, a.index))[0]!.option;
}
