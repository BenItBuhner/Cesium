import type { FileNode } from "@/lib/types";
import type { AgentBackendInfo, AgentConfigOption } from "@/lib/agent-types";
import type { AgentModeOption, ModelInfo } from "@/lib/types";

export type AtSuggestion = {
  id: string;
  label: string;
  subtitle: string;
  insert: string;
  category: "file" | "tool";
};

export type SlashSuggestion = {
  id: string;
  label: string;
  subtitle: string;
  insert: string;
};

function walkFiles(node: FileNode, base: string): AtSuggestion[] {
  if (node.type === "file") {
    const path = base ? `${base}/${node.name}` : node.name;
    return [
      {
        id: path,
        label: node.name,
        subtitle: path,
        insert: `@${path}`,
        category: "file",
      },
    ];
  }
  const prefix = base ? `${base}/${node.name}` : node.name;
  return (node.children ?? []).flatMap((c) => walkFiles(c, prefix));
}

function filesFromTree(root: FileNode): AtSuggestion[] {
  if (!root.children?.length) return [];
  return root.children.flatMap((c) => walkFiles(c, ""));
}

const TOOL_AT: AtSuggestion[] = [
  {
    id: "codebase",
    label: "Codebase",
    subtitle: "Search the full codebase",
    insert: "@Codebase",
    category: "tool",
  },
  {
    id: "docs",
    label: "Docs",
    subtitle: "Reference documentation",
    insert: "@Docs",
    category: "tool",
  },
  {
    id: "web",
    label: "Web",
    subtitle: "Search the web",
    insert: "@Web",
    category: "tool",
  },
  {
    id: "terminal",
    label: "Terminal",
    subtitle: "Recent terminal output",
    insert: "@Terminal",
    category: "tool",
  },
];

export function getAllAtSuggestions(root?: FileNode | null): AtSuggestion[] {
  return [...TOOL_AT, ...filesFromTree(root ?? { name: "", type: "folder", children: [] })];
}

const PROMPT_SLASH_COMMANDS: SlashSuggestion[] = [
  {
    id: "plan",
    label: "Plan",
    subtitle: "Draft a structured implementation plan",
    insert: "/plan",
  },
  {
    id: "edit",
    label: "Edit",
    subtitle: "Edit the selected code",
    insert: "/edit",
  },
  {
    id: "fix",
    label: "Fix",
    subtitle: "Fix problems in the selection",
    insert: "/fix",
  },
  {
    id: "explain",
    label: "Explain",
    subtitle: "Explain how the code works",
    insert: "/explain",
  },
  {
    id: "tests",
    label: "Tests",
    subtitle: "Generate or update tests",
    insert: "/tests",
  },
  {
    id: "search",
    label: "Search",
    subtitle: "Search the codebase for a symbol",
    insert: "/search",
  },
  {
    id: "summarize",
    label: "Summarize",
    subtitle: "Summarize recent changes or context",
    insert: "/summarize",
  },
  {
    id: "models",
    label: "Models",
    subtitle: "Open the model picker",
    insert: "/models",
  },
];

function slugifySlashValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function summarizeBackendLabel(backend: AgentBackendInfo): string {
  return backend.experimental ? `${backend.label} (experimental)` : backend.label;
}

export function getSlashSuggestions(input: {
  modeOptions?: AgentModeOption[];
  models?: ModelInfo[];
  backends?: AgentBackendInfo[];
  sessionConfigOptions?: AgentConfigOption[];
}): SlashSuggestion[] {
  const suggestions: SlashSuggestion[] = [...PROMPT_SLASH_COMMANDS];

  for (const mode of input.modeOptions ?? []) {
    suggestions.push({
      id: `mode:${mode.id}`,
      label: `Mode: ${mode.label}`,
      subtitle: mode.description ?? "Switch the active chat mode",
      insert: `/mode ${mode.id}`,
    });
  }

  for (const model of input.models ?? []) {
    const modelValue = model.modelValue ?? model.id;
    suggestions.push({
      id: `model:${modelValue}`,
      label: `Model: ${model.name}`,
      subtitle: model.description ?? "Switch the active model",
      insert: `/model ${modelValue}`,
    });
  }

  for (const backend of input.backends ?? []) {
    suggestions.push({
      id: `backend:${backend.id}`,
      label: `Backend: ${backend.label}`,
      subtitle: summarizeBackendLabel(backend),
      insert: `/backend ${backend.id}`,
    });
  }

  for (const option of input.sessionConfigOptions ?? []) {
    for (const choice of option.options) {
      const normalizedConfigId = slugifySlashValue(option.id || option.name);
      const choiceValue = choice.value || choice.name;
      suggestions.push({
        id: `config:${option.id}:${choice.value}`,
        label: `${option.name}: ${choice.name}`,
        subtitle: option.description ?? `Set ${option.name}`,
        insert: `/set ${normalizedConfigId} ${choiceValue}`,
      });
    }
  }

  return suggestions;
}

export function filterAtSuggestions(list: AtSuggestion[], query: string): AtSuggestion[] {
  const q = query.toLowerCase().trim();
  if (!q) return list.slice(0, 40);
  return list
    .filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.subtitle.toLowerCase().includes(q) ||
        s.insert.toLowerCase().includes(q)
    )
    .slice(0, 40);
}

export function filterSlashSuggestions(list: SlashSuggestion[], query: string): SlashSuggestion[] {
  const q = query.toLowerCase().trim();
  if (!q) return list;
  return list.filter(
    (s) =>
      s.label.toLowerCase().includes(q) ||
      s.subtitle.toLowerCase().includes(q) ||
      s.insert.toLowerCase().includes(q)
  );
}
