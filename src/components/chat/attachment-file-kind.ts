import {
  File,
  FileArchive,
  FileAudio,
  FileBox,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";

export type AttachmentFileKind = {
  /** Short badge label, e.g. "XLSX", "PDF", "MD". */
  badge: string;
  Icon: LucideIcon;
  /** Accent color used for the icon tile. */
  color: string;
};

const SPREADSHEET = new Set(["xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv"]);
const DOCUMENT = new Set(["doc", "docx", "odt", "rtf", "pages"]);
const PRESENTATION = new Set(["ppt", "pptx", "odp", "key"]);
const TEXTLIKE = new Set(["txt", "log", "md", "mdx", "markdown", "rst", "tex"]);
const DATA = new Set(["json", "jsonl", "yaml", "yml", "toml", "xml", "ini", "env", "plist"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war"]);
const BINARY = new Set(["apk", "ipa", "exe", "dmg", "iso", "bin", "so", "dylib", "dll", "deb", "rpm", "aab", "msi"]);
const CODE = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cc", "cs", "php", "sh", "bash", "zsh", "sql", "html", "css",
  "scss", "less", "vue", "svelte", "lua", "r", "pl", "scala", "dart", "zig", "proto",
]);

export function attachmentExtension(name: string | undefined): string {
  return name?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() ?? "";
}

/** Icon + badge + accent color for a non-image attachment card. */
export function attachmentFileKind(name: string | undefined, mimeType: string): AttachmentFileKind {
  const ext = attachmentExtension(name);
  const badge = (ext || mimeType.split("/")[1] || "file").toUpperCase().slice(0, 8);
  if (ext === "pdf" || mimeType === "application/pdf") {
    return { badge: "PDF", Icon: FileText, color: "#ef4444" };
  }
  if (SPREADSHEET.has(ext) || mimeType.includes("spreadsheet") || mimeType === "text/csv") {
    return { badge, Icon: FileSpreadsheet, color: "#22c55e" };
  }
  if (DOCUMENT.has(ext) || mimeType.includes("wordprocessing") || mimeType === "application/msword") {
    return { badge, Icon: FileText, color: "#3b82f6" };
  }
  if (PRESENTATION.has(ext) || mimeType.includes("presentation")) {
    return { badge, Icon: Presentation, color: "#f97316" };
  }
  if (DATA.has(ext) || mimeType === "application/json" || mimeType.endsWith("+json") || mimeType.endsWith("+xml")) {
    return { badge, Icon: FileJson, color: "#eab308" };
  }
  if (CODE.has(ext)) {
    return { badge, Icon: FileCode, color: "#06b6d4" };
  }
  if (ARCHIVE.has(ext) || mimeType.includes("zip") || mimeType.includes("compressed") || mimeType.includes("tar")) {
    return { badge, Icon: FileArchive, color: "#a16207" };
  }
  if (BINARY.has(ext) || mimeType === "application/vnd.android.package-archive") {
    return { badge, Icon: FileBox, color: "#94a3b8" };
  }
  if (mimeType.startsWith("audio/")) {
    return { badge, Icon: FileAudio, color: "#ec4899" };
  }
  if (mimeType.startsWith("video/")) {
    return { badge, Icon: FileVideo, color: "#a855f7" };
  }
  if (TEXTLIKE.has(ext) || mimeType.startsWith("text/")) {
    return { badge, Icon: FileText, color: "#8b5cf6" };
  }
  return { badge, Icon: File, color: "#94a3b8" };
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
