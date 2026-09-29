import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractToolEditPreview } from "../../tool-edit-preview.js";
import { asNumber } from "../../json-coerce.js";
import { asString } from "../cesium-coerce.js";
import {
  applyCesiumFileEdit,
  describeWriteFileOutcome,
  parseCesiumEditFileArgs,
  parseCesiumWriteFileArgs,
} from "../cesium-file-tools.js";
import { formatGlobResult, globWorkspaceEntries } from "../cesium-glob.js";
import { formatGrepResult, searchWorkspace } from "../cesium-grep.js";
import {
  DEFAULT_GREP_RESULTS,
  LARGE_FILE_LINE_LIMIT,
  MAX_GREP_RESULTS,
  MAX_READ_LINES,
} from "../cesium-prompt.js";
import type { CesiumToolContext } from "./types.js";
import {
  MAX_READ_IMAGE_BYTES,
  imageMimeTypeForPath,
  readWorkspaceFileIfExists,
  resolveWorkspacePath,
} from "./workspace-paths.js";

export async function readFileTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const inputPath = asString(args.path);
  if (!inputPath) throw new Error("read_file.path is required.");
  const resolved = resolveWorkspacePath(ctx.workspace.root, inputPath, [
    ...ctx.extraRoots,
    ctx.readOnlyRoot,
  ]);
  const imageMime = imageMimeTypeForPath(resolved);
  if (imageMime) {
    const buffer = await fs.readFile(resolved);
    if (buffer.length > MAX_READ_IMAGE_BYTES) {
      return `${inputPath} is a ${imageMime} image of ${buffer.length} bytes, which exceeds the ${MAX_READ_IMAGE_BYTES}-byte attachment limit.`;
    }
    if (!ctx.turnSupportsImages) {
      return `${inputPath} is a ${imageMime} image (${buffer.length} bytes). The current model does not advertise image support, so the pixels cannot be attached; switch to a vision model such as kimi-k3 to view it.`;
    }
    ctx.attachImage({
      mimeType: imageMime,
      data: buffer.toString("base64"),
      source: `read_file(${inputPath})`,
    });
    return `${inputPath} is a ${imageMime} image (${buffer.length} bytes). The image is attached to this turn for your review.`;
  }
  const raw = await fs.readFile(resolved, "utf8");
  const lines = raw.split(/\r?\n/);
  const offset = Math.max(1, Math.floor(asNumber(args.offset) ?? 1));
  const requestedLimit = Math.floor(asNumber(args.limit) ?? Math.min(lines.length, MAX_READ_LINES));
  const limit = Math.min(Math.max(1, requestedLimit), MAX_READ_LINES);
  if (lines.length > LARGE_FILE_LINE_LIMIT && !args.offset && !args.limit) {
    return [
      `${inputPath} has ${lines.length} lines, which exceeds ${LARGE_FILE_LINE_LIMIT}.`,
      `Start:\n${lines.slice(0, 80).map((line, index) => `${index + 1}|${line}`).join("\n")}`,
      `End:\n${lines.slice(-80).map((line, index) => `${lines.length - 79 + index}|${line}`).join("\n")}`,
      `Use offset and limit to read up to ${MAX_READ_LINES} lines.`,
    ].join("\n\n");
  }
  return lines
    .slice(offset - 1, offset - 1 + limit)
    .map((line, index) => `${offset + index}|${line}`)
    .join("\n");
}

export async function grepTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const pattern = asString(args.pattern);
  if (!pattern) throw new Error("grep.pattern is required.");
  const workspaceRoot = ctx.workspace.root;
  const searchPath = resolveWorkspacePath(workspaceRoot, asString(args.path) ?? ".", ctx.extraRoots);
  const context = Math.max(0, Math.min(20, Math.floor(asNumber(args.context) ?? 0)));
  const maxResults = Math.max(1, Math.min(MAX_GREP_RESULTS, Math.floor(asNumber(args.maxResults) ?? DEFAULT_GREP_RESULTS)));
  const result = await searchWorkspace({
    workspaceRoot,
    searchPath,
    pattern,
    ignoreCase: args.ignoreCase === true,
    glob: asString(args.glob)?.trim() || undefined,
    context,
    maxResults,
  });
  return formatGrepResult(result, workspaceRoot, MAX_GREP_RESULTS);
}

export async function globTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const pattern = asString(args.pattern);
  if (!pattern) throw new Error("glob.pattern is required.");
  const searchPath = asString(args.path) ?? ".";
  const searchRoot = resolveWorkspacePath(ctx.workspace.root, searchPath, ctx.extraRoots);
  const stat = await fs.stat(searchRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`glob.path must be an existing directory inside the workspace: ${searchPath}`);
  }
  const result = await globWorkspaceEntries({
    workspaceRoot: ctx.workspace.root,
    searchRoot,
    pattern,
    maxResults: asNumber(args.maxResults),
  });
  return formatGlobResult(result, { pattern, searchPath });
}

export async function editFileTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>,
  toolCallId: string,
  title: string
): Promise<string> {
  const parsed = parseCesiumEditFileArgs(args);
  const resolved = resolveWorkspacePath(ctx.workspace.root, parsed.path, ctx.extraRoots);
  const before = await readWorkspaceFileIfExists(resolved);
  const outcome = applyCesiumFileEdit({
    path: parsed.path,
    before,
    oldString: parsed.oldString,
    newString: parsed.newString,
    replaceAll: parsed.replaceAll,
  });
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, outcome.after, "utf8");
  const editPreview = extractToolEditPreview(
    { path: parsed.path, oldString: parsed.oldString, newString: parsed.newString },
    { beforeFullFileContent: before ?? "", afterFullFileContent: outcome.after },
    parsed.path
  );
  const refinedTitle = outcome.created ? `Create ${parsed.path}` : title;
  if (outcome.created) {
    ctx.refineTitle(toolCallId, refinedTitle);
  }
  await ctx.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "tool_call_update",
      toolCallId,
      title: refinedTitle,
      toolKind: "edit",
      status: "in_progress",
      detail: outcome.created ? "Created file." : "Applied edit preview.",
      locations: [{ path: parsed.path }],
      editPreview,
    },
  ]);
  return outcome.resultMessage;
}

export async function writeFileTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>, toolCallId: string): Promise<string> {
  const parsed = parseCesiumWriteFileArgs(args);
  const resolved = resolveWorkspacePath(ctx.workspace.root, parsed.path, ctx.extraRoots);
  const before = await readWorkspaceFileIfExists(resolved);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, parsed.content, "utf8");
  const { created, resultMessage } = describeWriteFileOutcome({
    path: parsed.path,
    before,
    content: parsed.content,
  });
  const editPreview = extractToolEditPreview(
    { path: parsed.path },
    { beforeFullFileContent: before ?? "", afterFullFileContent: parsed.content },
    parsed.path
  );
  const refinedTitle = `${created ? "Create" : "Update"} ${parsed.path}`;
  ctx.refineTitle(toolCallId, refinedTitle);
  await ctx.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "tool_call_update",
      toolCallId,
      title: refinedTitle,
      toolKind: "edit",
      status: "in_progress",
      detail: created ? "Created file." : "Overwrote file.",
      locations: [{ path: parsed.path }],
      editPreview,
    },
  ]);
  return resultMessage;
}
