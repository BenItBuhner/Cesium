"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  File as FileIcon,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  executeInstalledExtensionCommand,
  fetchExtensionTreeChildren,
  getServerBaseUrl,
  type ExtensionTreeItem,
} from "@/lib/server-api";
import type { ExtensionWorkspaceSocket } from "@/lib/extensions/extension-socket";

const CODICON_ICONS: Record<string, LucideIcon> = {
  file: FileIcon,
  folder: Folder,
  "folder-opened": FolderOpen,
  "git-branch": GitBranch,
  history: History,
  play: Play,
  refresh: RefreshCw,
  gear: Settings,
  settings: Settings,
  sparkle: Sparkles,
};

type TreeNode = ExtensionTreeItem & {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

function resourceIconUrl(workspaceId: string, extensionId: string, resourcePath: string): string {
  return `${getServerBaseUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/${encodeURIComponent(extensionId)}/resource?path=${encodeURIComponent(resourcePath)}`;
}

function TreeItemIcon({
  item,
  workspaceId,
  extensionId,
}: {
  item: ExtensionTreeItem;
  workspaceId: string;
  extensionId: string;
}) {
  if (item.resourcePath) {
    return (
      <img
        src={resourceIconUrl(workspaceId, extensionId, item.resourcePath)}
        alt=""
        className="size-[14px] shrink-0 object-contain"
        draggable={false}
      />
    );
  }
  if (item.iconId) {
    const Icon = CODICON_ICONS[item.iconId] ?? Circle;
    return <Icon aria-hidden className="size-[13px] shrink-0 opacity-70" strokeWidth={1.8} />;
  }
  return null;
}

export function ExtensionTreeView({
  workspaceId,
  extensionId,
  viewId,
  socket,
  initialItems,
}: {
  workspaceId: string;
  extensionId: string;
  viewId: string;
  socket: ExtensionWorkspaceSocket | null;
  initialItems?: ExtensionTreeItem[];
}) {
  const [roots, setRoots] = useState<TreeNode[]>(initialItems ?? []);
  const [loading, setLoading] = useState(!initialItems);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const loadRoots = useCallback(async () => {
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    setLoading(true);
    try {
      const result = await fetchExtensionTreeChildren({ workspaceId, extensionId, viewId });
      if (refreshGeneration.current !== generation) return;
      setRoots(result.items);
      setError(
        result.missingProvider ? "This view's data provider has not registered yet." : null
      );
    } catch (err) {
      if (refreshGeneration.current !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (refreshGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, [extensionId, viewId, workspaceId]);

  useEffect(() => {
    if (!initialItems) {
      void loadRoots();
    }
  }, [initialItems, loadRoots]);

  // Live refresh on onDidChangeTreeData pushes from the host.
  useEffect(() => {
    if (!socket) return;
    return socket.subscribeWorkspace((event) => {
      if (event.type !== "tree-changed") return;
      const payload = event.payload as { extensionId?: string; viewId?: string };
      if (payload.viewId === viewId && payload.extensionId?.toLowerCase() === extensionId.toLowerCase()) {
        void loadRoots();
      }
    });
  }, [extensionId, loadRoots, socket, viewId]);

  const toggleNode = useCallback(
    async (target: TreeNode) => {
      if (target.collapsibleState === 0) return;
      const updateNode = (nodes: TreeNode[], patch: Partial<TreeNode>): TreeNode[] =>
        nodes.map((node) =>
          node.handle === target.handle
            ? { ...node, ...patch }
            : node.children
              ? { ...node, children: updateNode(node.children, patch) }
              : node
        );
      if (target.expanded) {
        setRoots((current) => updateNode(current, { expanded: false }));
        return;
      }
      setRoots((current) => updateNode(current, { expanded: true, loading: !target.children }));
      if (!target.children) {
        try {
          const result = await fetchExtensionTreeChildren({
            workspaceId,
            extensionId,
            viewId,
            parentHandle: target.handle,
          });
          setRoots((current) => updateNode(current, { children: result.items, loading: false }));
        } catch {
          setRoots((current) => updateNode(current, { loading: false }));
        }
      }
    },
    [extensionId, viewId, workspaceId]
  );

  const runItemCommand = useCallback(
    (item: TreeNode) => {
      if (!item.hasCommand) return;
      void executeInstalledExtensionCommand({
        workspaceId,
        command: "",
        treeItem: { viewId, handle: item.handle },
      }).catch(() => undefined);
    },
    [viewId, workspaceId]
  );

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => (
      <div key={node.handle}>
        <button
          type="button"
          title={node.tooltip || node.label}
          className="flex w-full items-center gap-[6px] rounded-[4px] px-[6px] py-[3px] text-left font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          style={{ paddingLeft: `${6 + depth * 14}px` }}
          onClick={() => {
            if (node.collapsibleState !== 0) {
              void toggleNode(node);
            } else {
              runItemCommand(node);
            }
          }}
          onDoubleClick={() => runItemCommand(node)}
        >
          {node.collapsibleState !== 0 ? (
            node.expanded ? (
              <ChevronDown className="size-[12px] shrink-0 opacity-60" />
            ) : (
              <ChevronRight className="size-[12px] shrink-0 opacity-60" />
            )
          ) : (
            <span className="w-[12px] shrink-0" />
          )}
          <TreeItemIcon item={node} workspaceId={workspaceId} extensionId={extensionId} />
          <span className="truncate">{node.label}</span>
          {node.description ? (
            <span className="truncate text-[11px] text-[var(--text-secondary)]">
              {node.description}
            </span>
          ) : null}
          {node.loading ? (
            <RefreshCw className="ml-auto size-[11px] shrink-0 animate-spin opacity-50" />
          ) : null}
        </button>
        {node.expanded && node.children ? renderNodes(node.children, depth + 1) : null}
      </div>
    ));

  if (loading && roots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-[12px] text-[var(--text-secondary)]">
        Loading tree…
      </div>
    );
  }

  if (error && roots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-[16px] text-center font-sans text-[12px] text-[var(--text-secondary)]">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[var(--bg-main)] p-[6px]">
      {roots.length > 0 ? (
        renderNodes(roots, 0)
      ) : (
        <p className="px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
          No tree items.
        </p>
      )}
    </div>
  );
}
