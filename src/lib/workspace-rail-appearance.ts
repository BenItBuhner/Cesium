import {

  Archive,

  Bot,

  Briefcase,

  Bug,

  Cloud,

  Code2,

  Cpu,

  Database,

  FileText,

  Flame,

  Folder,

  FolderOpen,

  GitBranch,

  Globe,

  Hash,

  Home,

  Layers,

  MessageSquare,

  Paintbrush,

  Rocket,

  Shield,

  Sparkles,

  Star,

  Terminal,

  Wrench,

  Zap,

  type LucideIcon,

} from "lucide-react";

import { createElement } from "react";

import type { WorkspaceRailAppearance } from "@/lib/global-settings";



export const HOME_WORKSPACE_ICON = "Home";



export const FOLDER_ICON_OPTIONS: Array<{ name: string; Icon: LucideIcon }> = [

  { name: HOME_WORKSPACE_ICON, Icon: Home },

  { name: "Folder", Icon: Folder },

  { name: "FolderOpen", Icon: FolderOpen },

  { name: "Star", Icon: Star },

  { name: "Sparkles", Icon: Sparkles },

  { name: "MessageSquare", Icon: MessageSquare },

  { name: "Briefcase", Icon: Briefcase },

  { name: "Archive", Icon: Archive },

  { name: "Code2", Icon: Code2 },

  { name: "Wrench", Icon: Wrench },

  { name: "Hash", Icon: Hash },

  { name: "Bot", Icon: Bot },

  { name: "Bug", Icon: Bug },

  { name: "Cloud", Icon: Cloud },

  { name: "Cpu", Icon: Cpu },

  { name: "Database", Icon: Database },

  { name: "FileText", Icon: FileText },

  { name: "Flame", Icon: Flame },

  { name: "GitBranch", Icon: GitBranch },

  { name: "Globe", Icon: Globe },

  { name: "Layers", Icon: Layers },

  { name: "Paintbrush", Icon: Paintbrush },

  { name: "Rocket", Icon: Rocket },

  { name: "Shield", Icon: Shield },

  { name: "Terminal", Icon: Terminal },

  { name: "Zap", Icon: Zap },

];



export const FOLDER_COLOR_OPTIONS = [

  "#7c3aed",

  "#2563eb",

  "#0891b2",

  "#059669",

  "#ca8a04",

  "#ea580c",

  "#dc2626",

  "#db2777",

] as const;



export function getFolderIcon(iconName: string): LucideIcon {

  return FOLDER_ICON_OPTIONS.find((option) => option.name === iconName)?.Icon ?? Folder;

}



export function isValidFolderColor(value: string): boolean {

  return /^#[0-9a-f]{6}$/i.test(value);

}



/** Compound key used in `workspaceRailAppearances` (`serverId:workspaceId`). */

export function buildWorkspaceAppearanceKey(

  serverId: string,

  workspaceId: string

): string {

  return `${serverId}:${workspaceId}`;

}



export function resolveWorkspaceAppearanceKey(input: {

  workspaceKey?: string;

  serverId?: string;

  workspaceId: string;

  fallbackServerId?: string;

}): string {

  if (input.workspaceKey?.trim()) {

    return input.workspaceKey.trim();

  }

  const serverId = input.serverId ?? input.fallbackServerId;

  if (serverId) {

    return buildWorkspaceAppearanceKey(serverId, input.workspaceId);

  }

  return input.workspaceId;

}



export function hasSavedWorkspaceRailAppearance(

  appearances: Record<string, WorkspaceRailAppearance>,

  workspaceKey: string

): boolean {

  return Object.prototype.hasOwnProperty.call(appearances, workspaceKey);

}



/** Stable palette color from a workspace key (serverId:workspaceId or bare id). */

export function pickStableWorkspaceColor(workspaceKey: string): string {

  let hash = 0;

  for (let index = 0; index < workspaceKey.length; index += 1) {

    hash = (hash * 31 + workspaceKey.charCodeAt(index)) >>> 0;

  }

  return FOLDER_COLOR_OPTIONS[hash % FOLDER_COLOR_OPTIONS.length];

}



export function getDefaultHomeWorkspaceAppearance(

  workspaceKey: string

): WorkspaceRailAppearance {

  return {

    icon: HOME_WORKSPACE_ICON,

    color: pickStableWorkspaceColor(workspaceKey),

  };

}



export type WorkspaceRailAppearanceOptions = {

  /** When true and no saved entry, use the Home icon + stable random color. */

  isHome?: boolean;

};



export function getWorkspaceRailAppearance(

  appearances: Record<string, WorkspaceRailAppearance>,

  workspaceKey: string,

  index: number,

  options?: WorkspaceRailAppearanceOptions

): WorkspaceRailAppearance {

  const saved = appearances[workspaceKey];

  if (saved) {

    return {

      icon: saved.icon || "Folder",

      color:

        saved.color ?? FOLDER_COLOR_OPTIONS[index % FOLDER_COLOR_OPTIONS.length],

    };

  }

  if (options?.isHome) {

    return getDefaultHomeWorkspaceAppearance(workspaceKey);

  }

  return {

    icon: "Folder",

    color: FOLDER_COLOR_OPTIONS[index % FOLDER_COLOR_OPTIONS.length],

  };

}



export function collectHomeWorkspaceAppearancesToPersist(

  appearances: Record<string, WorkspaceRailAppearance>,

  entries: ReadonlyArray<{ workspaceKey: string; isHome: boolean }>

): Record<string, WorkspaceRailAppearance> {

  const patches: Record<string, WorkspaceRailAppearance> = {};

  for (const { workspaceKey, isHome } of entries) {

    if (!isHome || !workspaceKey.trim()) {

      continue;

    }

    if (hasSavedWorkspaceRailAppearance(appearances, workspaceKey)) {

      continue;

    }

    patches[workspaceKey] = getDefaultHomeWorkspaceAppearance(workspaceKey);

  }

  return patches;

}



export function WorkspaceFolderIcon({

  iconName,

  className,

  strokeWidth,

  color,

}: {

  iconName: string;

  className?: string;

  strokeWidth?: number;

  color?: string;

}) {

  const Icon = getFolderIcon(iconName);

  return createElement(Icon, {

    className,

    strokeWidth,

    ...(color ? { color } : {}),

  });

}


