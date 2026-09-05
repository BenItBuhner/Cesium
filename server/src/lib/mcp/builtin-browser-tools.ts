import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  closeBrowserControlTab,
  dispatchBrowserControlInput,
  evaluateBrowserControlTab,
  focusBrowserControlTab,
  getBrowserControlRecordingStatus,
  listBrowserControlTabs,
  moveBrowserControlTab,
  navigateBrowserControlTab,
  openBrowserControlTab,
  readBrowserControlEvents,
  screenshotBrowserControlTab,
  setBrowserControlLock,
  setBrowserControlViewport,
  snapshotBrowserControlTab,
  startBrowserControlRecording,
  stopBrowserControlRecording,
} from "../browser-control/service.js";
import {
  parseImageDataUrl,
  saveBrowserScreenshotArtifact,
} from "../browser-control/artifacts.js";
import type { BrowserControlViewport } from "../browser-control/types.js";
import { asString } from "../coerce.js";

export const BROWSER_MCP_SERVER_ID = "browser";

const tabIdSchema = { type: "string", description: "Browser tab id returned by browser_tabs." };

export const BROWSER_MCP_TOOLS: Tool[] = [
  {
    name: "browser_tabs",
    description: "List, open, close, focus, or move browser tabs in the IDE editor area. Opening a new active tab clears focus from older tabs, even locked tabs. Prefer direct reputable URLs over creating local HTML test pages unless the user explicitly asks for a local fixture.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "open", "close", "focus", "move"] },
        tabId: tabIdSchema,
        url: { type: "string", description: "URL for action=open." },
        title: { type: "string" },
        group: { type: "string", enum: ["left", "right"], default: "right" },
        engine: {
          type: "string",
          enum: ["proxy", "electron-native", "server-chromium"],
          default: "server-chromium",
          description:
            "server-chromium is the stable automation engine rendered into the editor. electron-native opens a native Electron browser view and should be used only when real native embedding is required. proxy opens the legacy visible editor tab.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate, reload, go back, or go forward in a browser tab. For visible editor tabs, use direct URLs for searches and page changes.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        op: { type: "string", enum: ["goto", "reload", "back", "forward"], default: "goto" },
        url: { type: "string", description: "Required for op=goto. If url is provided and op is omitted, goto is assumed." },
      },
      required: ["tabId"],
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
    description:
      "Read URL, title, visible text, and interactive element references from a browser tab. Snapshot timeouts usually mean the visible editor bridge is still mounting, not that the web page failed to load. Use returned elementRefs selectors/rects for browser_click/browser_type.",
    inputSchema: {
      type: "object",
      properties: { tabId: tabIdSchema },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Run JavaScript in the controlled browser tab. Works with visible electron-native editor tabs through the desktop bridge and with legacy server-chromium tabs. Use for inspection or deterministic DOM interaction; keep scripts small and return serializable values.",
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
    description:
      "Click or hover an element. Prefer selector, ref from browser_snapshot, or visible text over raw coordinates. Coordinates are fallback only and use the tab viewport coordinate space.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        x: { type: "number" },
        y: { type: "number" },
        selector: { type: "string", description: "CSS selector to click. Preferred when available from browser_snapshot elementRefs." },
        ref: { type: "string", description: "Element ref such as e0 from the latest browser_snapshot." },
        text: { type: "string", description: "Visible text/label to find among interactive elements." },
        button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
        action: { type: "string", enum: ["move", "click", "down", "up"], default: "click" },
        visualLabel: { type: "string" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type text or press a key. Prefer selector, ref from browser_snapshot, or visible text to focus a target input/editor first; otherwise it types into the currently focused element.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        text: { type: "string" },
        key: { type: "string" },
        selector: { type: "string", description: "CSS selector to focus before typing." },
        ref: { type: "string", description: "Element ref such as e0 from the latest browser_snapshot." },
        targetText: { type: "string", description: "Visible label/text of an interactive element to focus before typing." },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the current browser viewport. The image is saved as a workspace artifact under artifacts/browser/ and the file path is returned (plus the image itself for vision-capable clients). Works with visible electron-native editor tabs and server-chromium tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        fileName: {
          type: "string",
          description: "Optional artifact base name (extension added automatically).",
        },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_record",
    description:
      "Record a demo video of a server-chromium browser tab. action=start begins capturing, action=stop encodes the frames with ffmpeg and saves the video under artifacts/browser/ (returning the file path), action=status reports the live frame count. Keep recordings focused: start right before the demo interaction and stop right after.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabIdSchema,
        action: { type: "string", enum: ["start", "stop", "status"] },
        fileName: {
          type: "string",
          description: "Optional artifact base name for action=stop (extension added automatically).",
        },
        maxWidth: { type: "number", description: "Optional max frame width for action=start." },
        maxHeight: { type: "number", description: "Optional max frame height for action=start." },
      },
      required: ["tabId", "action"],
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

/** Map legacy/alternate browser tool names to the canonical built-in MCP surface. */
export function normalizeBrowserMcpToolInvocation(input: {
  toolName: string;
  arguments: Record<string, unknown>;
}): { toolName: string; arguments: Record<string, unknown> } {
  const toolName = input.toolName.trim();
  const args = { ...input.arguments };
  if (toolName === "browser_unlock") {
    return {
      toolName: "browser_lock",
      arguments: { ...args, action: asString(args.action) ?? "unlock" },
    };
  }
  if (toolName === "browser_lock" && !asString(args.action)) {
    args.action = "lock";
  }
  return { toolName, arguments: args };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tabForResult(workspaceId: string, tabId: string) {
  return listBrowserControlTabs(workspaceId).find((tab) => tab.tabId === tabId) ?? null;
}

function browserResult(action: string, tab: unknown, extra?: Record<string, unknown>): string {
  return json({
    ok: true,
    action,
    tab,
    verification:
      "Do not claim a click, typed text, search submission, or DOM change succeeded unless a follow-up browser_snapshot, browser_evaluate, URL/title change, screenshot, or user-visible observation confirms it.",
    ...extra,
  });
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

async function resolveElementTarget(input: {
  workspaceId: string;
  tabId: string;
  selector?: string;
  ref?: string;
  text?: string;
}): Promise<{ selector?: string; ref?: string; text?: string; rect?: { x: number; y: number; width: number; height: number } } | null> {
  if (input.selector) {
    return { selector: input.selector };
  }
  if (!input.ref && !input.text) {
    return null;
  }
  const snapshot = await snapshotBrowserControlTab(input.workspaceId, input.tabId).catch(() => null);
  const match = snapshot?.elementRefs.find((element) => {
    if (input.ref && element.ref === input.ref) return true;
    if (input.text) {
      const haystack = `${element.text ?? ""} ${element.selector ?? ""}`.toLowerCase();
      return haystack.includes(input.text.toLowerCase());
    }
    return false;
  });
  if (!match) {
    return input.text ? { text: input.text } : null;
  }
  return {
    selector: match.selector,
    ref: match.ref,
    text: match.text,
    rect: match.rect,
  };
}

async function clickResolvedElement(
  workspaceId: string,
  tabId: string,
  target: { selector?: string; text?: string } | null
): Promise<{ ok: boolean; result: unknown; exception?: string }> {
  if (!target?.selector && !target?.text) {
    return { ok: false, result: null, exception: "No selector or text target supplied." };
  }
  const selectorExpr = target.selector ? jsString(target.selector) : "null";
  const textExpr = target.text ? jsString(target.text) : "null";
  const evaluated = await evaluateBrowserControlTab(
    workspaceId,
    tabId,
    `(() => {
      const selector = ${selectorExpr};
      const text = ${textExpr};
      const interactive = 'input, textarea, select, button, a, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"], [tabindex]';
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
      const el = selector
        ? document.querySelector(selector)
        : Array.from(document.querySelectorAll(interactive)).find((node) => visible(node) && textOf(node).toLowerCase().includes(String(text || '').toLowerCase()));
      if (!el) return { ok: false, reason: 'target_not_found', selector, text };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      if (typeof el.click === 'function') el.click();
      const rect = el.getBoundingClientRect();
      return { ok: true, tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 200), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    })()`
  );
  const value = evaluated.result as { ok?: boolean } | null;
  return { ok: Boolean(value?.ok), result: evaluated.result, exception: evaluated.exception };
}

async function focusResolvedElement(
  workspaceId: string,
  tabId: string,
  target: { selector?: string; text?: string } | null
): Promise<{ ok: boolean; result: unknown; exception?: string }> {
  if (!target?.selector && !target?.text) {
    return { ok: true, result: null };
  }
  const selectorExpr = target.selector ? jsString(target.selector) : "null";
  const textExpr = target.text ? jsString(target.text) : "null";
  const evaluated = await evaluateBrowserControlTab(
    workspaceId,
    tabId,
    `(() => {
      const selector = ${selectorExpr};
      const text = ${textExpr};
      const interactive = 'input, textarea, select, [role="textbox"], [contenteditable="true"], button, a, [role="button"], [tabindex]';
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
      const el = selector
        ? document.querySelector(selector)
        : Array.from(document.querySelectorAll(interactive)).find((node) => visible(node) && textOf(node).toLowerCase().includes(String(text || '').toLowerCase()));
      if (!el) return { ok: false, reason: 'target_not_found', selector, text };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      const rect = el.getBoundingClientRect();
      return { ok: true, tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 200), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    })()`
  );
  const value = evaluated.result as { ok?: boolean } | null;
  return { ok: Boolean(value?.ok), result: evaluated.result, exception: evaluated.exception };
}

export type BuiltInBrowserToolImage = {
  mimeType: string;
  /** Base64 image bytes (no data: prefix). */
  data: string;
};

export type BuiltInBrowserToolResult = {
  text: string;
  images?: BuiltInBrowserToolImage[];
};

export async function callBuiltInBrowserTool(input: {
  workspaceId: string;
  workspaceRoot?: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  return (await callBuiltInBrowserToolRich(input)).text;
}

/**
 * Rich variant that additionally returns captured screenshots as image payloads
 * so vision-capable callers (Cesium Agent, MCP HTTP bridge clients) can see the
 * pixels instead of a truncated base64 text blob.
 */
export async function callBuiltInBrowserToolRich(input: {
  workspaceId: string;
  workspaceRoot?: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<BuiltInBrowserToolResult> {
  const normalized = normalizeBrowserMcpToolInvocation(input);
  if (normalized.toolName === "browser_screenshot") {
    return await handleBrowserScreenshot({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      arguments: normalized.arguments,
    });
  }
  if (normalized.toolName === "browser_record") {
    return {
      text: await handleBrowserRecord({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        arguments: normalized.arguments,
      }),
    };
  }
  return {
    text: await callBuiltInBrowserToolText({
      workspaceId: input.workspaceId,
      toolName: normalized.toolName,
      arguments: normalized.arguments,
    }),
  };
}

async function handleBrowserScreenshot(input: {
  workspaceId: string;
  workspaceRoot?: string;
  arguments: Record<string, unknown>;
}): Promise<BuiltInBrowserToolResult> {
  const tabId = asString(input.arguments.tabId);
  if (!tabId) throw new Error("browser_screenshot requires tabId.");
  const { imageDataUrl, tab } = await screenshotBrowserControlTab(input.workspaceId, tabId);
  if (!imageDataUrl) {
    return {
      text: json({
        ok: false,
        action: "browser_screenshot",
        tab,
        error:
          "No screenshot data was captured. For visible editor tabs the observation bridge may still be mounting; retry shortly or use a server-chromium tab.",
      }),
    };
  }
  const parsed = parseImageDataUrl(imageDataUrl);
  const artifact = input.workspaceRoot
    ? await saveBrowserScreenshotArtifact({
        workspaceRoot: input.workspaceRoot,
        imageDataUrl,
        fileName: asString(input.arguments.fileName),
      }).catch(() => null)
    : null;
  return {
    text: json({
      ok: true,
      action: "browser_screenshot",
      artifact: artifact
        ? {
            filePath: artifact.relativePath,
            absolutePath: artifact.absolutePath,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          }
        : null,
      tab,
      note: artifact
        ? `Screenshot saved to ${artifact.relativePath} (workspace-relative). The image is also attached for vision-capable models.`
        : "Screenshot captured. No workspace root was available, so the image was not saved as an artifact file; it is attached for vision-capable models.",
    }),
    images: parsed
      ? [{ mimeType: parsed.mimeType, data: parsed.data.toString("base64") }]
      : undefined,
  };
}

async function handleBrowserRecord(input: {
  workspaceId: string;
  workspaceRoot?: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  const tabId = asString(input.arguments.tabId);
  if (!tabId) throw new Error("browser_record requires tabId.");
  const action = asString(input.arguments.action) ?? "status";
  if (action === "start") {
    const maxWidth = Number(input.arguments.maxWidth);
    const maxHeight = Number(input.arguments.maxHeight);
    const { status, tab } = await startBrowserControlRecording(input.workspaceId, tabId, {
      maxWidth: Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : undefined,
      maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : undefined,
    });
    return json({
      ok: true,
      action: "browser_record_started",
      recording: status,
      tab,
      note:
        "Recording frames now. Perform the demo interactions (navigate, click, type), then call browser_record with action=stop to encode and save the video artifact.",
    });
  }
  if (action === "stop") {
    if (!input.workspaceRoot) {
      throw new Error("browser_record action=stop requires a workspace root to save the video artifact.");
    }
    const { result, tab } = await stopBrowserControlRecording(input.workspaceId, tabId, {
      workspaceRoot: input.workspaceRoot,
      fileName: asString(input.arguments.fileName),
    });
    return json({
      ok: true,
      action: "browser_record_saved",
      artifact: {
        filePath: result.artifact.relativePath,
        absolutePath: result.artifact.absolutePath,
        bytes: result.artifact.bytes,
        mimeType: result.artifact.mimeType,
      },
      frameCount: result.frameCount,
      durationMs: result.durationMs,
      tab,
      note: `Demo video saved to ${result.artifact.relativePath} (workspace-relative). Report this path in your summary so the user and parent agent can open it.`,
    });
  }
  if (action === "status") {
    const { status, tab } = getBrowserControlRecordingStatus(input.workspaceId, tabId);
    return json({ ok: true, action: "browser_record_status", recording: status, tab });
  }
  throw new Error(`browser_record action must be start, stop, or status (got ${action}).`);
}

async function callBuiltInBrowserToolText(input: {
  workspaceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  const toolName = input.toolName;
  const args = input.arguments;
  if (toolName === "browser_tabs") {
    const action = asString(args.action) ?? "list";
    if (action === "list") return json({ tabs: listBrowserControlTabs(input.workspaceId) });
    if (action === "open") {
      const url = asString(args.url);
      if (!url) throw new Error("browser_tabs action=open requires url.");
      const tab = await openBrowserControlTab({
        workspaceId: input.workspaceId,
        url,
        title: asString(args.title),
        group: args.group === "right" ? "right" : "left",
        engine:
          args.engine === "server-chromium"
            ? "server-chromium"
            : args.engine === "proxy"
              ? "proxy"
              : args.engine === "electron-native"
                ? "electron-native"
                : "server-chromium",
      });
      return browserResult("opened_browser_tab", tab, {
        visibleInEditor: tab.engine !== "server-chromium",
        note:
          tab.engine === "server-chromium"
            ? "Opened legacy server Chromium tab."
            : "Opened a visible editor browser tab. Wait for the editor tab to load before assuming page content is ready.",
      });
    }
    const tabId = asString(args.tabId);
    if (!tabId) throw new Error(`browser_tabs action=${action} requires tabId.`);
    if (action === "close") {
      await closeBrowserControlTab(input.workspaceId, tabId);
      return json({ ok: true });
    }
    if (action === "focus") {
      return browserResult("focused_browser_tab", focusBrowserControlTab(input.workspaceId, tabId));
    }
    if (action === "move") {
      return browserResult(
        "moved_browser_tab",
        moveBrowserControlTab(input.workspaceId, tabId, args.group === "left" ? "left" : "right")
      );
    }
  }
  const tabId = asString(args.tabId);
  if (!tabId) throw new Error(`${toolName} requires tabId.`);
  if (toolName === "browser_navigate") {
    const op = asString(args.op) ?? (asString(args.url) ? "goto" : undefined);
    if (op === "goto") {
      const url = asString(args.url);
      if (!url) throw new Error("browser_navigate op=goto requires url.");
      const tab = await navigateBrowserControlTab(input.workspaceId, tabId, { op, url });
      return browserResult("navigated_browser_tab", tab, {
        requestedUrl: url,
        note:
          tab.engine === "server-chromium"
            ? "Navigation was sent to server Chromium."
            : "Navigation metadata was updated for the visible editor tab; the editor tab will perform the visible navigation.",
      });
    }
    if (op === "reload" || op === "back" || op === "forward") {
      const tab = await navigateBrowserControlTab(input.workspaceId, tabId, { op });
      return browserResult(`browser_${op}`, tab);
    }
    throw new Error("browser_navigate requires op.");
  }
  if (toolName === "browser_lock") {
    const action = asString(args.action) ?? "status";
    if (action === "status") {
      return json({ tab: listBrowserControlTabs(input.workspaceId).find((tab) => tab.tabId === tabId) ?? null });
    }
    return browserResult(
      action === "lock" ? "locked_browser_tab" : "unlocked_browser_tab",
      setBrowserControlLock({
        workspaceId: input.workspaceId,
        tabId,
        locked: action === "lock",
        conversationId: asString(args.conversationId) ?? null,
        reason: asString(args.reason) ?? null,
      })
    );
  }
  if (toolName === "browser_snapshot") return json({ snapshot: await snapshotBrowserControlTab(input.workspaceId, tabId) });
  if (toolName === "browser_evaluate") return json(await evaluateBrowserControlTab(input.workspaceId, tabId, asString(args.script) ?? ""));
  if (toolName === "browser_click") {
    const tabBefore = tabForResult(input.workspaceId, tabId);
    const target = await resolveElementTarget({
      workspaceId: input.workspaceId,
      tabId,
      selector: asString(args.selector),
      ref: asString(args.ref),
      text: asString(args.text),
    });
    const action = args.action === "move" || args.action === "down" || args.action === "up" ? args.action : "click";
    const domClick =
      action === "click" && (target?.selector || target?.text)
        ? await clickResolvedElement(input.workspaceId, tabId, target)
        : null;
    const x = target?.rect ? target.rect.x + target.rect.width / 2 : Number(args.x);
    const y = target?.rect ? target.rect.y + target.rect.height / 2 : Number(args.y);
    const ok = domClick
      ? domClick.ok
      : await dispatchBrowserControlInput(input.workspaceId, tabId, {
          type: "mouse",
          action,
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          button: args.button === "middle" || args.button === "right" ? args.button : "left",
          visualLabel: asString(args.visualLabel),
        });
    const tabAfter = tabForResult(input.workspaceId, tabId);
    return json({
      ok,
      action: "browser_pointer_input",
      requestedInput: {
        action,
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null,
        button: args.button === "middle" || args.button === "right" ? args.button : "left",
        selector: target?.selector ?? asString(args.selector) ?? null,
        ref: target?.ref ?? asString(args.ref) ?? null,
        text: target?.text ?? asString(args.text) ?? null,
      },
      domResult: domClick?.result,
      exception: domClick?.exception,
      tab: tabAfter ?? tabBefore,
      delivery:
        !ok
          ? "not_delivered"
          : tabAfter?.engine === "server-chromium"
          ? "sent_to_server_chromium"
          : "delivered_to_visible_editor_tab",
      coordinateHandling:
        tabAfter?.engine === "server-chromium"
          ? "Coordinates were sent directly to the server Chromium viewport."
          : "Coordinates are interpreted in the tab.viewport coordinate space and scaled to the actual visible editor browser view before dispatch.",
      verifiedPageEffect: false,
      instruction:
        "Do not state that a button was clicked or page content changed unless a follow-up observation verifies it. Use browser_snapshot for URL/title metadata, navigate directly when possible, or ask the user to confirm visible page state.",
    });
  }
  if (toolName === "browser_type") {
    const key = asString(args.key);
    const text = asString(args.text);
    const target = await resolveElementTarget({
      workspaceId: input.workspaceId,
      tabId,
      selector: asString(args.selector),
      ref: asString(args.ref),
      text: asString(args.targetText),
    });
    const focusResult = await focusResolvedElement(input.workspaceId, tabId, target);
    const tabBefore = tabForResult(input.workspaceId, tabId);
    const ok = focusResult.ok
      ? await dispatchBrowserControlInput(input.workspaceId, tabId, {
          type: "key",
          action: text ? "type" : "press",
          key: text ?? key ?? "Enter",
        })
      : false;
    const tabAfter = tabForResult(input.workspaceId, tabId);
    return json({
      ok,
      action: "browser_keyboard_input",
      requestedInput: text
        ? { action: "type", text, selector: target?.selector ?? asString(args.selector) ?? null, ref: target?.ref ?? asString(args.ref) ?? null, targetText: target?.text ?? asString(args.targetText) ?? null }
        : { action: "press", key: key ?? "Enter", selector: target?.selector ?? asString(args.selector) ?? null, ref: target?.ref ?? asString(args.ref) ?? null, targetText: target?.text ?? asString(args.targetText) ?? null },
      focusResult: focusResult.result,
      exception: focusResult.exception,
      tab: tabAfter ?? tabBefore,
      delivery:
        !ok
          ? "not_delivered"
          : tabAfter?.engine === "server-chromium"
          ? "sent_to_server_chromium"
          : "delivered_to_visible_editor_tab",
      verifiedPageEffect: false,
      instruction:
        "Do not claim text was entered or submitted unless a follow-up observation verifies it. If precision matters, navigate directly to a deterministic URL or ask the user to confirm visible page state.",
    });
  }
  if (toolName === "browser_viewport") {
    return json({
      tab: await setBrowserControlViewport(
        input.workspaceId,
        tabId,
        args as Partial<BrowserControlViewport>
      ),
    });
  }
  if (toolName === "browser_events") {
    return json(readBrowserControlEvents(input.workspaceId, tabId, Number(args.after) || 0));
  }
  throw new Error(`Unknown browser MCP tool: ${toolName}`);
}
