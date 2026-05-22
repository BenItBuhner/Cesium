import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  closeBrowserControlTab,
  dispatchBrowserControlInput,
  evaluateBrowserControlTab,
  focusBrowserControlTab,
  listBrowserControlTabs,
  moveBrowserControlTab,
  navigateBrowserControlTab,
  openBrowserControlTab,
  readBrowserControlEvents,
  screenshotBrowserControlTab,
  setBrowserControlLock,
  setBrowserControlViewport,
  snapshotBrowserControlTab,
} from "../browser-control/service.js";
import type { BrowserControlViewport } from "../browser-control/types.js";

export const BROWSER_MCP_SERVER_ID = "browser";

const tabIdSchema = { type: "string", description: "Browser tab id returned by browser_tabs." };

export const BROWSER_MCP_TOOLS: Tool[] = [
  {
    name: "browser_tabs",
    description: "List, open, close, focus, or move browser tabs in the IDE editor area.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "open", "close", "focus", "move"] },
        tabId: tabIdSchema,
        url: { type: "string", description: "URL for action=open." },
        title: { type: "string" },
        group: { type: "string", enum: ["left", "right"], default: "right" },
        engine: { type: "string", enum: ["proxy", "server-chromium"], default: "server-chromium" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate, reload, go back, or go forward in a browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        op: { type: "string", enum: ["goto", "reload", "back", "forward"] },
        url: { type: "string", description: "Required for op=goto." },
      },
      required: ["tabId", "op"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_lock",
    description: "Lock, unlock, or inspect browser tab lock state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        action: { type: "string", enum: ["lock", "unlock", "status"] },
        conversationId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["tabId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "Read URL, title, visible text, HTML excerpt, accessibility summary, and element refs.",
    inputSchema: {
      type: "object",
      properties: { tabId: tabIdSchema },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description: "Run JavaScript in the controlled browser tab. Requires explicit agent permission.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        script: { type: "string" },
      },
      required: ["tabId", "script"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "Click or hover at viewport coordinates in a browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
        action: { type: "string", enum: ["move", "click", "down", "up"], default: "click" },
        visualLabel: { type: "string" },
      },
      required: ["tabId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Type text or press a key in a browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        text: { type: "string" },
        key: { type: "string" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot of the current browser viewport.",
    inputSchema: {
      type: "object",
      properties: { tabId: tabIdSchema },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_viewport",
    description: "Set a viewport preset or custom width/height for responsive testing.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        preset: { type: "string", enum: ["watch", "mobile", "tablet", "laptop", "desktop", "custom"] },
        width: { type: "number" },
        height: { type: "number" },
        deviceScaleFactor: { type: "number" },
        mobile: { type: "boolean" },
        touch: { type: "boolean" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_events",
    description: "Read browser console/network/lock/user-intervention events after a cursor.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        after: { type: "number", default: 0 },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function callBuiltInBrowserTool(input: {
  workspaceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  const args = input.arguments;
  if (input.toolName === "browser_tabs") {
    const action = asString(args.action) ?? "list";
    if (action === "list") return json({ tabs: listBrowserControlTabs(input.workspaceId) });
    if (action === "open") {
      const url = asString(args.url);
      if (!url) throw new Error("browser_tabs action=open requires url.");
      return json({
        tab: await openBrowserControlTab({
          workspaceId: input.workspaceId,
          url,
          title: asString(args.title),
          group: args.group === "left" ? "left" : "right",
          engine: args.engine === "proxy" ? "proxy" : "server-chromium",
        }),
      });
    }
    const tabId = asString(args.tabId);
    if (!tabId) throw new Error(`browser_tabs action=${action} requires tabId.`);
    if (action === "close") {
      await closeBrowserControlTab(input.workspaceId, tabId);
      return json({ ok: true });
    }
    if (action === "focus") return json({ tab: focusBrowserControlTab(input.workspaceId, tabId) });
    if (action === "move") {
      return json({ tab: moveBrowserControlTab(input.workspaceId, tabId, args.group === "left" ? "left" : "right") });
    }
  }
  const tabId = asString(args.tabId);
  if (!tabId) throw new Error(`${input.toolName} requires tabId.`);
  if (input.toolName === "browser_navigate") {
    const op = asString(args.op);
    if (op === "goto") {
      const url = asString(args.url);
      if (!url) throw new Error("browser_navigate op=goto requires url.");
      return json({ tab: await navigateBrowserControlTab(input.workspaceId, tabId, { op, url }) });
    }
    if (op === "reload" || op === "back" || op === "forward") {
      return json({ tab: await navigateBrowserControlTab(input.workspaceId, tabId, { op }) });
    }
    throw new Error("browser_navigate requires op.");
  }
  if (input.toolName === "browser_lock") {
    const action = asString(args.action) ?? "status";
    if (action === "status") {
      return json({ tab: listBrowserControlTabs(input.workspaceId).find((tab) => tab.tabId === tabId) ?? null });
    }
    return json({
      tab: setBrowserControlLock({
        workspaceId: input.workspaceId,
        tabId,
        locked: action === "lock",
        conversationId: asString(args.conversationId) ?? null,
        reason: asString(args.reason) ?? null,
      }),
    });
  }
  if (input.toolName === "browser_snapshot") return json({ snapshot: await snapshotBrowserControlTab(input.workspaceId, tabId) });
  if (input.toolName === "browser_evaluate") return json(await evaluateBrowserControlTab(input.workspaceId, tabId, asString(args.script) ?? ""));
  if (input.toolName === "browser_click") {
    const ok = await dispatchBrowserControlInput(input.workspaceId, tabId, {
      type: "mouse",
      action: args.action === "move" || args.action === "down" || args.action === "up" ? args.action : "click",
      x: Number(args.x) || 0,
      y: Number(args.y) || 0,
      button: args.button === "middle" || args.button === "right" ? args.button : "left",
      visualLabel: asString(args.visualLabel),
    });
    return json({ ok });
  }
  if (input.toolName === "browser_type") {
    const key = asString(args.key);
    const text = asString(args.text);
    const ok = await dispatchBrowserControlInput(input.workspaceId, tabId, {
      type: "key",
      action: text ? "type" : "press",
      key: text ?? key ?? "Enter",
    });
    return json({ ok });
  }
  if (input.toolName === "browser_screenshot") return json(await screenshotBrowserControlTab(input.workspaceId, tabId));
  if (input.toolName === "browser_viewport") {
    return json({
      tab: await setBrowserControlViewport(
        input.workspaceId,
        tabId,
        args as Partial<BrowserControlViewport>
      ),
    });
  }
  if (input.toolName === "browser_events") {
    return json(readBrowserControlEvents(input.workspaceId, tabId, Number(args.after) || 0));
  }
  throw new Error(`Unknown browser MCP tool: ${input.toolName}`);
}
