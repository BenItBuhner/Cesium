import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createArtifact,
  deleteArtifact,
  listArtifacts,
  readArtifact,
  readArtifactFile,
  updateArtifact,
  type ArtifactKind,
  type ArtifactSummary,
} from "../artifacts/store.js";
import { openBrowserControlTab } from "../browser-control/service.js";

export const ARTIFACTS_MCP_SERVER_ID = "artifacts";

export const ARTIFACTS_MCP_SUMMARY =
  "Built-in artifact tools for creating persistent visual artifacts - charts, HTML pages with JS/CSS, and multi-file mini web projects - stored under .cesium/artifacts/. Artifacts render inline in chat when you place their [[artifact:<id>]] tag on its own line, and can open as dedicated editor tabs.";

export const ARTIFACTS_MCP_INSTRUCTIONS = `Use artifact tools to create rich, persistent visuals for the user: charts, dashboards, simulations, interactive HTML pages, and small self-contained web projects. Artifacts are stored under .cesium/artifacts/ in the workspace (gitignored, persisted across sessions).

Embedding: after artifact_create or artifact_update, place the returned embed tag (for example [[artifact:sales-chart-a1b2c3]]) on its own line in your reply. The tag renders as a live interactive preview inline in the conversation, and the user can expand it or open it as a dedicated editor tab.

Kinds:
- chart: pass a Chart.js v4 config (type, data, options). It renders responsively and fills whatever viewport it is shown in - do not hardcode pixel sizes.
- html: pass a complete HTML document (or a fragment; fragments are wrapped). Inline <script> and <style> are allowed. Always include responsive styles - the artifact renders inside an inline card (~360px tall), an editor tab, or a full window.
- project: pass a files map (path → content) with an entry file (default index.html). Use relative URLs between project files.

Prefer one focused artifact per idea. Use artifact_update to iterate on an existing artifact instead of creating duplicates.`;

const artifactIdSchema = {
  type: "string",
  description: "Artifact id returned by artifact_create or artifact_list.",
};

const filesSchema = {
  type: "object",
  description: "File map: relative path → full UTF-8 file content.",
  additionalProperties: { type: "string" },
};

export const ARTIFACTS_MCP_TOOLS: Tool[] = [
  {
    name: "artifact_create",
    description:
      "Create a persistent visual artifact (chart | html | project) under .cesium/artifacts/. Returns the artifact id plus an embed tag like [[artifact:<id>]]; place that tag on its own line in your reply to render the artifact inline in the conversation. Content must be responsive - it renders in an inline chat card, an editor tab, or a full window.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["chart", "html", "project"] },
        title: { type: "string", description: "Short human-readable title." },
        description: { type: "string" },
        chart: {
          description:
            "Chart.js v4 config (object or JSON string) for kind=chart, e.g. {type:'line', data:{...}, options:{...}}. Rendered responsively with a locally served Chart.js runtime.",
        },
        html: {
          type: "string",
          description:
            "Complete HTML document or fragment for kind=html. Inline JS/CSS allowed; include responsive styling.",
        },
        files: {
          ...filesSchema,
          description:
            "kind=project only. File map (path → content) for a mini web project with its own file tree. Must include the entry file.",
        },
        entry: {
          type: "string",
          description: "Entry file for kind=project (default index.html).",
        },
        open: {
          type: "boolean",
          default: false,
          description: "Also open the artifact in a dedicated editor tab immediately.",
        },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_update",
    description:
      "Update an existing artifact in place (preferred over creating duplicates when iterating). Replaces the chart config or html, upserts project files, and can rename or delete files. The inline [[artifact:<id>]] embed keeps working and shows the latest content.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: artifactIdSchema,
        title: { type: "string" },
        description: { type: "string" },
        chart: { description: "Replacement Chart.js config (object or JSON string)." },
        html: { type: "string", description: "Replacement HTML document or fragment." },
        files: { ...filesSchema, description: "Files to add or overwrite (path → content)." },
        deletePaths: {
          type: "array",
          items: { type: "string" },
          description: "Relative file paths to delete from the artifact.",
        },
        entry: { type: "string", description: "New entry file path." },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_list",
    description:
      "List artifacts stored in this workspace (.cesium/artifacts/), newest first, with ids, kinds, titles, and file lists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "artifact_read",
    description:
      "Read an artifact's metadata and file list, or the full content of one file when path is provided.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: artifactIdSchema,
        path: { type: "string", description: "Optional relative file path to read." },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_open",
    description:
      "Open an artifact in a dedicated visible editor tab (like a browser tab) so the user can view it full size.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: artifactIdSchema,
        group: { type: "string", enum: ["left", "right"], default: "right" },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_delete",
    description: "Delete an artifact and its files from .cesium/artifacts/.",
    inputSchema: {
      type: "object",
      properties: { artifactId: artifactIdSchema },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },
];

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFileMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function artifactEmbedTag(artifactId: string): string {
  return `[[artifact:${artifactId}]]`;
}

/** Server-local base URL - browser proxy / editor tabs fetch it from the server host. */
function artifactAbsoluteUrl(serverPath: string): string {
  const port = Number.parseInt(process.env.PORT ?? "9100", 10);
  const host = process.env.PUBLIC_HOST?.trim() || "localhost";
  return `http://${host}:${port}${serverPath}`;
}

function artifactResult(summary: ArtifactSummary, extra?: Record<string, unknown>): string {
  return json({
    ok: true,
    artifact: summary,
    url: artifactAbsoluteUrl(summary.serverPath),
    embedTag: artifactEmbedTag(summary.id),
    instructions:
      `To show this artifact inline in the conversation, place ${artifactEmbedTag(summary.id)} on its own line in your reply text. ` +
      "The user can expand it inline or open it as an editor tab. Use artifact_update to iterate instead of creating a new artifact.",
    ...extra,
  });
}

async function openArtifactTab(input: {
  workspaceId: string;
  summary: ArtifactSummary;
  group?: "left" | "right";
}) {
  return await openBrowserControlTab({
    workspaceId: input.workspaceId,
    url: artifactAbsoluteUrl(input.summary.serverPath),
    title: input.summary.title,
    group: input.group === "right" ? "right" : "left",
    engine: "proxy",
  });
}

export async function callBuiltInArtifactTool(input: {
  workspaceId: string;
  workspaceRoot: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  const args = input.arguments;
  const toolName = input.toolName.trim();

  if (toolName === "artifact_create") {
    const kind = asString(args.kind) as ArtifactKind | undefined;
    if (kind !== "chart" && kind !== "html" && kind !== "project") {
      throw new Error("artifact_create requires kind to be one of: chart, html, project.");
    }
    const title = asString(args.title);
    if (!title) {
      throw new Error("artifact_create requires a title.");
    }
    const summary = await createArtifact({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      kind,
      title,
      description: asString(args.description),
      chart: args.chart,
      html: asString(args.html),
      files: asFileMap(args.files),
      entry: asString(args.entry),
    });
    let openedTab: unknown = null;
    if (args.open === true) {
      openedTab = await openArtifactTab({ workspaceId: input.workspaceId, summary }).catch(
        () => null
      );
    }
    return artifactResult(summary, openedTab ? { openedTab } : undefined);
  }

  if (toolName === "artifact_update") {
    const artifactId = asString(args.artifactId);
    if (!artifactId) {
      throw new Error("artifact_update requires artifactId.");
    }
    const summary = await updateArtifact({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      artifactId,
      title: asString(args.title),
      description: typeof args.description === "string" ? args.description : undefined,
      chart: args.chart,
      html: asString(args.html),
      files: asFileMap(args.files),
      deletePaths: Array.isArray(args.deletePaths)
        ? args.deletePaths.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      entry: asString(args.entry),
    });
    return artifactResult(summary);
  }

  if (toolName === "artifact_list") {
    const artifacts = await listArtifacts({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
    });
    return json({
      ok: true,
      artifacts: artifacts.map((summary) => ({
        ...summary,
        embedTag: artifactEmbedTag(summary.id),
      })),
      instructions:
        "Embed any artifact inline by placing its [[artifact:<id>]] tag on its own line in your reply.",
    });
  }

  if (toolName === "artifact_read") {
    const artifactId = asString(args.artifactId);
    if (!artifactId) {
      throw new Error("artifact_read requires artifactId.");
    }
    const summary = await readArtifact({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      artifactId,
    });
    if (!summary) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    const filePath = asString(args.path);
    if (filePath) {
      const content = await readArtifactFile({
        workspaceRoot: input.workspaceRoot,
        artifactId,
        path: filePath,
      });
      return json({ ok: true, artifact: summary, path: filePath, content });
    }
    return artifactResult(summary);
  }

  if (toolName === "artifact_open") {
    const artifactId = asString(args.artifactId);
    if (!artifactId) {
      throw new Error("artifact_open requires artifactId.");
    }
    const summary = await readArtifact({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      artifactId,
    });
    if (!summary) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    const tab = await openArtifactTab({
      workspaceId: input.workspaceId,
      summary,
      group: args.group === "right" ? "right" : "left",
    });
    return json({
      ok: true,
      action: "opened_artifact_tab",
      artifact: summary,
      tab,
      embedTag: artifactEmbedTag(summary.id),
      note: "Opened a visible editor tab showing the artifact. You can still embed it inline with the embed tag.",
    });
  }

  if (toolName === "artifact_delete") {
    const artifactId = asString(args.artifactId);
    if (!artifactId) {
      throw new Error("artifact_delete requires artifactId.");
    }
    const removed = await deleteArtifact({
      workspaceRoot: input.workspaceRoot,
      artifactId,
    });
    return json({ ok: removed, artifactId, ...(removed ? {} : { error: "Unknown artifact." }) });
  }

  throw new Error(`Unknown artifacts MCP tool: ${toolName}`);
}
