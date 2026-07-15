import type { FileNode } from "@/lib/types";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
} from "@/lib/agent-types";
import type { AgentModeOption, EditorMode, ModelInfo } from "@/lib/types";

export type AtSuggestion = {
  id: string;
  label: string;
  subtitle: string;
  insert: string;
  category: "file" | "tool";
};

export type SlashMenuAction =
  | { kind: "mode"; modeId: EditorMode }
  | { kind: "model"; model: ModelInfo }
  | { kind: "backend"; backendId: AgentBackendId }
  | { kind: "config"; configId: string; value: string }
  | { kind: "insert"; insert: string };

export type SlashMenuItem = {
  id: string;
  label: string;
  searchText: string;
  searchKey?: string;
  disabled?: boolean;
  action: SlashMenuAction;
};

export type SlashMenuSection = {
  id: string;
  label?: string;
  items: SlashMenuItem[];
};

export const SLASH_MENU_MAX_VISIBLE_ITEMS = 80;

export type SlashMenuFilterResult = {
  sections: SlashMenuSection[];
  totalCount: number;
  visibleCount: number;
  truncated: boolean;
};

function slashSearchKey(label: string, searchText: string): string {
  return `${label} ${searchText}`.toLowerCase();
}

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

export function getSlashMenuSections(input: {
  activeBackend?: AgentBackendInfo | null;
  modeOptions?: AgentModeOption[];
  models?: ModelInfo[];
  backends?: AgentBackendInfo[];
  sessionConfigOptions?: AgentConfigOption[];
  gitSlashCommands?: boolean;
  configLocked?: boolean;
  modeLocked?: boolean;
}): SlashMenuSection[] {
  const sections: SlashMenuSection[] = [];
  const backend = input.activeBackend;
  const caps = backend?.capabilities;
  const locked = input.configLocked ?? false;
  const modeLocked = input.modeLocked ?? false;

  if (
    !locked &&
    !modeLocked &&
    caps?.supportsModeSelection !== false &&
    (input.modeOptions?.length ?? 0) > 0
  ) {
    sections.push({
      id: "modes",
      label: "Modes",
      items: (input.modeOptions ?? []).map((mode) => ({
          id: `mode:${mode.id}`,
          label: mode.label,
          searchText: `${mode.label} ${mode.id} /${mode.id} mode`,
          searchKey: slashSearchKey(mode.label, `${mode.label} ${mode.id} /${mode.id} mode`),
          action: { kind: "mode", modeId: mode.id },
        })),
    });
  }

  if (!locked && caps?.supportsModelSelection !== false && (input.models?.length ?? 0) > 0) {
    sections.push({
      id: "models",
      label: "Models",
      items: (input.models ?? []).map((model) => {
        const modelValue = model.modelValue ?? model.id;
        return {
          id: `model:${modelValue}`,
          label: model.name,
          searchText: `${model.name} ${modelValue} model`,
          searchKey: slashSearchKey(model.name, `${model.name} ${modelValue} model`),
          action: { kind: "model", model },
        };
      }),
    });
  }

  const backends = input.backends ?? [];
  if (!locked && backends.length > 1) {
    sections.push({
      id: "harnesses",
      label: "Harnesses",
      items: backends.map((entry) => ({
        id: `backend:${entry.id}`,
        label: entry.experimental ? `${entry.label} (experimental)` : entry.label,
        searchText: `${entry.label} ${entry.id} harness backend`,
        searchKey: slashSearchKey(
          entry.experimental ? `${entry.label} (experimental)` : entry.label,
          `${entry.label} ${entry.id} harness backend`
        ),
        disabled: !entry.available,
        action: { kind: "backend", backendId: entry.id },
      })),
    });
  }

  const commandItems: SlashMenuItem[] = [];

  if (!locked) {
    for (const option of input.sessionConfigOptions ?? []) {
      for (const choice of option.options) {
        const choiceValue = choice.value || choice.name;
        const label = `${option.name}: ${choice.name}`;
        const searchText = `${option.name} ${choice.name} ${option.id} ${choiceValue}`;
        commandItems.push({
          id: `config:${option.id}:${choice.value}`,
          label,
          searchText,
          searchKey: slashSearchKey(label, searchText),
          action: { kind: "config", configId: option.id, value: choiceValue },
        });
      }
    }
  }

  if (input.gitSlashCommands) {
    commandItems.push({
      id: "worktree",
      label: "Worktree",
      searchText: "worktree git branch checkout",
      searchKey: slashSearchKey("Worktree", "worktree git branch checkout"),
      action: { kind: "insert", insert: "/worktree " },
    });
    commandItems.push({
      id: "delete-worktree",
      label: "Delete Worktree",
      searchText: "delete worktree git checkout",
      searchKey: slashSearchKey("Delete Worktree", "delete worktree git checkout"),
      action: { kind: "insert", insert: "/delete-worktree " },
    });
  }

  if (commandItems.length > 0) {
    sections.push({
      id: "commands",
      label: "Commands",
      items: commandItems,
    });
  }

  return sections;
}

export function flattenSlashMenuSections(sections: SlashMenuSection[]): SlashMenuItem[] {
  return sections.flatMap((section) => section.items);
}

export function filterSlashMenuSectionsForDisplay(
  sections: SlashMenuSection[],
  query: string,
  maxVisibleItems = SLASH_MENU_MAX_VISIBLE_ITEMS
): SlashMenuFilterResult {
  const q = query.toLowerCase().trim();
  const visibleLimit = Math.max(0, maxVisibleItems);
  const nextSections: SlashMenuSection[] = [];
  let totalCount = 0;
  let visibleCount = 0;

  if (!q) {
    for (const section of sections) {
      totalCount += section.items.length;
      if (visibleCount >= visibleLimit) {
        continue;
      }
      const remaining = visibleLimit - visibleCount;
      const visibleItems = section.items.slice(0, remaining);
      visibleCount += visibleItems.length;
      if (visibleItems.length > 0) {
        nextSections.push({ ...section, items: visibleItems });
      }
    }
    return {
      sections: nextSections,
      totalCount,
      visibleCount,
      truncated: totalCount > visibleCount,
    };
  }

  for (const section of sections) {
    const visibleItems: SlashMenuItem[] = [];
    for (const item of section.items) {
      if (!(item.searchKey ?? slashSearchKey(item.label, item.searchText)).includes(q)) {
        continue;
      }
      totalCount += 1;
      if (visibleCount < visibleLimit) {
        visibleItems.push(item);
        visibleCount += 1;
      }
    }
    if (visibleItems.length > 0) {
      nextSections.push({ ...section, items: visibleItems });
    }
  }

  return {
    sections: nextSections,
    totalCount,
    visibleCount,
    truncated: totalCount > visibleCount,
  };
}

export function filterSlashMenuSections(
  sections: SlashMenuSection[],
  query: string
): SlashMenuSection[] {
  return filterSlashMenuSectionsForDisplay(sections, query).sections;
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
