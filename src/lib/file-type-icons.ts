import type { LucideIcon } from "lucide-react";
import {
  File,
  FileCode,
  FileJson,
  FileText,
  SwatchBook,
  Terminal,
} from "lucide-react";

export type FileTypeIconEntry = { Icon: LucideIcon; className: string };

export const fileTypeIcons = {
  shell: { Icon: Terminal, className: "text-[#4ec9b0]" },
  json: { Icon: FileJson, className: "text-[#d4c26d]" },
  markdown: { Icon: FileText, className: "text-[#6cb5f5]" },
  typescript: { Icon: FileCode, className: "text-[#519aba]" },
  javascript: { Icon: FileCode, className: "text-[#d4c26d]" },
  css: { Icon: SwatchBook, className: "text-[#c678dd]" },
  default: { Icon: File, className: "text-[var(--text-secondary)]" },
} as const satisfies Record<string, FileTypeIconEntry>;

export type FileTypeIconKind = keyof typeof fileTypeIcons;

const LANG_ALIASES: Record<string, FileTypeIconKind> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  shell: "shell",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
};

const EXT_TO_KIND: Record<string, FileTypeIconKind> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".sass": "css",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

function resolveKind(language: string | undefined, fileName: string): FileTypeIconKind {
  const norm = language?.toLowerCase().trim();
  if (norm) {
    const fromAlias = LANG_ALIASES[norm];
    if (fromAlias) return fromAlias;
  }
  const dot = fileName.lastIndexOf(".");
  if (dot >= 0) {
    const ext = fileName.slice(dot).toLowerCase();
    const fromExt = EXT_TO_KIND[ext];
    if (fromExt) return fromExt;
  }
  return "default";
}

/** Uses `language` when set, otherwise the file extension. */
export function getFileIconForNode(
  language: string | undefined,
  fileName: string
): FileTypeIconEntry {
  return fileTypeIcons[resolveKind(language, fileName)];
}
