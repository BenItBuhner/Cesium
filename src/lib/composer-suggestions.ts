import { fileTree } from "@/lib/mock-data";
import type { FileNode } from "@/lib/types";

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

export function getAllAtSuggestions(): AtSuggestion[] {
  return [...TOOL_AT, ...filesFromTree(fileTree)];
}

export const SLASH_COMMANDS: SlashSuggestion[] = [
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
];

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
