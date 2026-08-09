import path from "node:path";
import type { AgentPromptAttachment } from "./types.js";

/** Workspace-relative directory where composer uploads are persisted. */
export const FILE_UPLOADS_DIR = ".cesium/file-uploads";

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const EXTENSION_LABELS: Record<string, string> = {
  pdf: "PDF document",
  doc: "Word document",
  docx: "Word document",
  odt: "OpenDocument text",
  rtf: "rich text document",
  pages: "Pages document",
  xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet",
  ods: "OpenDocument spreadsheet",
  numbers: "Numbers spreadsheet",
  csv: "CSV data",
  tsv: "TSV data",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  odp: "OpenDocument presentation",
  key: "Keynote presentation",
  md: "Markdown document",
  mdx: "Markdown document",
  markdown: "Markdown document",
  txt: "plain text file",
  log: "log file",
  json: "JSON data",
  yaml: "YAML data",
  yml: "YAML data",
  toml: "TOML data",
  xml: "XML data",
  zip: "ZIP archive",
  tar: "tar archive",
  gz: "gzip archive",
  tgz: "gzip archive",
  bz2: "bzip2 archive",
  xz: "xz archive",
  "7z": "7-Zip archive",
  rar: "RAR archive",
  apk: "Android package",
  ipa: "iOS app package",
  exe: "Windows executable",
  dmg: "macOS disk image",
  iso: "disk image",
  sqlite: "SQLite database",
  db: "database file",
};

function describeAttachment(attachment: AgentPromptAttachment): string {
  const ext = attachment.name?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase();
  if (ext && EXTENSION_LABELS[ext]) {
    return EXTENSION_LABELS[ext];
  }
  const mime = attachment.mimeType || "";
  if (mime.startsWith("image/")) return `${mime.split("/")[1]?.toUpperCase() ?? ""} image`.trim();
  if (mime.startsWith("audio/")) return "audio file";
  if (mime.startsWith("video/")) return "video file";
  if (mime.startsWith("text/")) return "text file";
  if (ext) return `.${ext} file`;
  return "file";
}

function isSafeUploadsPath(savedPath: string): boolean {
  const normalized = path.posix.normalize(savedPath.replace(/\\/g, "/"));
  return normalized.startsWith(`${FILE_UPLOADS_DIR}/`) && !normalized.includes("..");
}

/**
 * Build the `<system-reminder>` block that tells the agent where uploaded
 * attachments were persisted inside the workspace. Returns `null` when no
 * attachment carries a saved uploads path.
 *
 * Only paths inside `.cesium/file-uploads/` are surfaced — `savedPath` is
 * client-provided, so anything outside the uploads directory is ignored.
 */
export function buildAttachmentsReminderText(
  attachments: AgentPromptAttachment[] | undefined,
  workspaceRoot: string
): string | null {
  const saved = (attachments ?? []).filter(
    (attachment) => typeof attachment.savedPath === "string" && isSafeUploadsPath(attachment.savedPath)
  );
  if (saved.length === 0) {
    return null;
  }
  const lines = saved.map((attachment) => {
    const absolute = path.join(workspaceRoot, attachment.savedPath!);
    const details: string[] = [describeAttachment(attachment)];
    if (typeof attachment.size === "number" && attachment.size >= 0) {
      details.push(formatFileSize(attachment.size));
    }
    const isInlineImage =
      attachment.mimeType.startsWith("image/") && attachment.data.length > 0;
    if (isInlineImage) {
      details.push("also provided inline as an image");
    }
    return `- ${absolute} (${details.join(", ")})`;
  });
  const noun = saved.length === 1 ? "file" : "files";
  return [
    "<system-reminder>",
    `The user attached ${saved.length} ${noun} to this message. Each one was saved into the workspace uploads directory and is relevant to the request at hand:`,
    ...lines,
    "Read the saved files from disk with your file or shell tools whenever their contents matter to the task. Do not claim you cannot access uploaded files.",
    "</system-reminder>",
  ].join("\n");
}
