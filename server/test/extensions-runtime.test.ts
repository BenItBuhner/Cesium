import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  bootstrapFixtureEnv,
  createFixture,
} from "./helpers/storage-fixture.js";
import type {
  ExtensionInstallRecord,
} from "../src/lib/extensions/types.js";
import { classifyExtensionManifest } from "../src/lib/extensions/manifest-classifier.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 8_000,
  intervalMs = 50
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out with last value: ${JSON.stringify(value)?.slice(0, 400)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type FixtureExtension = {
  extensionRoot: string;
  workspaceRoot: string;
  record: ExtensionInstallRecord;
  workspace: {
    id: string;
    name: string;
    root: string;
    createdAt: number;
    updatedAt: number;
    lastOpenedAt: number;
  };
};

async function writeFixtureExtension(input: {
  workspaceId: string;
  extensionId: string;
  packageJson: Record<string, unknown>;
  code: string;
  settings?: Record<string, unknown>;
}): Promise<FixtureExtension> {
  const [publisher, name] = input.extensionId.split(".");
  const extensionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-ext-fixture-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-ext-ws-"));
  const extensionPath = path.join(extensionRoot, "extension");
  await fs.mkdir(path.join(extensionPath, "out"), { recursive: true });
  const packageJson = {
    name,
    publisher,
    version: "1.0.0",
    main: "./out/extension.cjs",
    ...input.packageJson,
  };
  await fs.writeFile(path.join(extensionPath, "package.json"), JSON.stringify(packageJson));
  await fs.writeFile(path.join(extensionPath, "out", "extension.cjs"), input.code);
  const now = Date.now();
  const record: ExtensionInstallRecord = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    extensionId: input.extensionId,
    publisher: publisher ?? "fixture",
    name: name ?? "fixture",
    displayName: name ?? "Fixture",
    description: "Fixture extension",
    version: "1.0.0",
    enabled: true,
    compatibility: "partial",
    compatibilityWarnings: [],
    source: {
      kind: "open-vsx",
      namespace: publisher ?? "fixture",
      name: name ?? "fixture",
      version: "1.0.0",
      registryUrl: "https://open-vsx.org",
    },
    vsixSha256: "0".repeat(64),
    vsixSizeBytes: 128,
    installPath: extensionRoot,
    manifest: {
      name: name ?? "fixture",
      publisher: publisher ?? "fixture",
      displayName: name ?? "Fixture",
      description: "Fixture extension",
      version: "1.0.0",
      engines: { vscode: "^1.90.0" },
      main: "./out/extension.cjs",
      activationEvents: Array.isArray(packageJson.activationEvents)
        ? (packageJson.activationEvents as string[])
        : [],
      categories: ["Other"],
      contributes: {
        commands: 0,
        configuration: 0,
        languages: 0,
        grammars: 0,
        snippets: 0,
        themes: 0,
        iconThemes: 0,
        views: 0,
        viewsContainers: 0,
        webviews: 0,
        customEditors: 0,
        keybindings: 0,
        menus: 0,
      },
      capabilities: classifyExtensionManifest(packageJson),
      raw: packageJson,
    },
    settings: input.settings ?? {},
    permissions: [
      {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        extensionId: input.extensionId,
        permission: "workspace.trust",
        granted: true,
        reason: "test",
        createdAt: now,
        updatedAt: now,
      },
    ],
    runtime: {
      hostRunning: false,
      activated: false,
      activationEvents: [],
      crashCount: 0,
      disabledForCrashLoop: false,
    },
    installedAt: now,
    updatedAt: now,
  };
  const workspace = {
    id: input.workspaceId,
    name: `Fixture ${input.workspaceId}`,
    root: workspaceRoot,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  return { extensionRoot, workspaceRoot, record, workspace };
}

/* ------------------------------------------------------------------ */
/* Persistent state                                                    */
/* ------------------------------------------------------------------ */

test("extension host: globalState and secrets survive host restarts", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { executeExtensionCommand, stopExtensionHost } = await import(
    "../src/lib/extensions/host-runtime.js"
  );
  const workspaceId = "ws-persist-state";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.persist-state",
    packageJson: {
      contributes: { commands: [{ command: "persist.read", title: "Read" }, { command: "persist.write", title: "Write" }] },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("persist.write", async (value) => {
    await context.globalState.update("stored", value);
    await context.workspaceState.update("wsStored", value + "-ws");
    await context.secrets.store("token", "secret-" + value);
    return true;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("persist.read", async () => ({
    stored: context.globalState.get("stored"),
    wsStored: context.workspaceState.get("wsStored"),
    token: await context.secrets.get("token"),
  })));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const writeResult = await executeExtensionCommand({
    workspace: built.workspace,
    command: "persist.write",
    args: ["v1"],
  });
  assert.equal(writeResult.result, true);

  // Give the debounced memento flush time to hit disk, then bounce the host.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await stopExtensionHost(workspaceId);

  const readResult = await executeExtensionCommand({
    workspace: built.workspace,
    command: "persist.read",
    args: [],
  });
  assert.deepEqual(readResult.result, {
    stored: "v1",
    wsStored: "v1-ws",
    token: "secret-v1",
  });
});

/* ------------------------------------------------------------------ */
/* Push events                                                         */
/* ------------------------------------------------------------------ */

test("extension host: webview messages push without polling and dedup client msgIds", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { stopExtensionHost } = await import("../src/lib/extensions/host-runtime.js");
  const {
    ensureExtensionSurfaceSession,
    deliverExtensionSurfaceSessionMessage,
    subscribeExtensionSurfaceEvents,
    readExtensionSurfaceEvents,
  } = await import("../src/lib/extensions/surface-sessions.js");
  const workspaceId = "ws-push-events";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.push-events",
    packageJson: {
      activationEvents: ["onView:pushView"],
      contributes: {
        viewsContainers: { activitybar: [{ id: "pushContainer", title: "Push" }] },
        views: { pushContainer: [{ id: "pushView", type: "webview", name: "Push" }] },
      },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("pushView", {
    resolveWebviewView(view) {
      view.webview.html = "<html><body>push fixture</body></html>";
      let received = 0;
      view.webview.onDidReceiveMessage((message) => {
        received += 1;
        void view.webview.postMessage({ kind: "echo", received, message });
      });
      setTimeout(() => { void view.webview.postMessage({ kind: "spontaneous" }); }, 60);
    }
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const pushed: unknown[] = [];
  const unsubscribe = subscribeExtensionSurfaceEvents((eventWorkspaceId, event) => {
    if (eventWorkspaceId === workspaceId && event.type === "message") {
      pushed.push((event.payload as { message?: unknown }).message);
    }
  });
  after(() => unsubscribe());

  const snapshot = await ensureExtensionSurfaceSession({
    workspace: built.workspace,
    extensionId: "fixture.push-events",
    surfaceId: "pushView",
    kind: "webview",
  });
  assert.match(snapshot.html, /push fixture/);

  // The spontaneous message (60ms after resolve) must arrive via push with no
  // deliver/poll round trip.
  await waitFor(
    () => pushed,
    (messages) => messages.some((message) => (message as { kind?: string })?.kind === "spontaneous")
  );

  // Same msgId delivered twice must only reach the extension once.
  const first = await deliverExtensionSurfaceSessionMessage({
    workspace: built.workspace,
    sessionId: snapshot.session.sessionId,
    message: { hello: 1 },
    msgId: "msg-1",
  });
  assert.equal(first.duplicate, false);
  const second = await deliverExtensionSurfaceSessionMessage({
    workspace: built.workspace,
    sessionId: snapshot.session.sessionId,
    message: { hello: 1 },
    msgId: "msg-1",
  });
  assert.equal(second.duplicate, true);

  await waitFor(
    () => pushed,
    (messages) =>
      messages.some((message) => {
        const echo = message as { kind?: string; received?: number };
        return echo?.kind === "echo" && echo.received === 1;
      })
  );
  const echoes = pushed.filter((message) => (message as { kind?: string })?.kind === "echo");
  assert.equal(echoes.length, 1, "duplicate msgId must not double-fire the extension handler");

  const events = readExtensionSurfaceEvents({
    workspaceId,
    sessionId: snapshot.session.sessionId,
    cursor: 0,
  });
  assert.ok(events.events.some((event) => event.type === "message"));
});

/* ------------------------------------------------------------------ */
/* UI bridge                                                           */
/* ------------------------------------------------------------------ */

test("extension host: quick pick round trip through the UI bridge", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { executeExtensionCommand, stopExtensionHost } = await import(
    "../src/lib/extensions/host-runtime.js"
  );
  const {
    subscribeWorkspaceExtensionEvents,
    resolveWorkspaceUiRequest,
    getWorkspaceExtensionUiSnapshot,
  } = await import("../src/lib/extensions/host-events.js");
  const workspaceId = "ws-ui-bridge";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.ui-bridge",
    packageJson: {
      contributes: { commands: [{ command: "ui.pick", title: "Pick" }] },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("ui.pick", async () => {
    const picked = await vscode.window.showQuickPick(["alpha", "beta", "gamma"], { placeHolder: "Pick one" });
    return { picked };
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const uiRequests: Array<{ requestId: string }> = [];
  const unsubscribe = subscribeWorkspaceExtensionEvents(workspaceId, (event) => {
    if (event.type === "ui-request") {
      uiRequests.push(event.payload as { requestId: string });
    }
  });
  after(() => unsubscribe());

  const pending = executeExtensionCommand({
    workspace: built.workspace,
    command: "ui.pick",
    args: [],
  });

  const request = await waitFor(
    () => uiRequests,
    (requests) => requests.length > 0
  ).then((requests) => requests[0]!);

  const snapshotBefore = getWorkspaceExtensionUiSnapshot(workspaceId);
  assert.ok(snapshotBefore.uiRequests.some((entry) => entry.requestId === request.requestId));

  await resolveWorkspaceUiRequest({
    workspaceId,
    response: { requestId: request.requestId, selectedIndices: [1] },
  });

  const result = await pending;
  assert.deepEqual(result.result, { picked: "beta" });

  const snapshotAfter = getWorkspaceExtensionUiSnapshot(workspaceId);
  assert.ok(!snapshotAfter.uiRequests.some((entry) => entry.requestId === request.requestId));
});

/* ------------------------------------------------------------------ */
/* Tree views                                                          */
/* ------------------------------------------------------------------ */

test("extension host: tree views expand, refresh, and run item commands", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const {
    executeExtensionCommand,
    getExtensionTreeChildren,
    stopExtensionHost,
  } = await import("../src/lib/extensions/host-runtime.js");
  const { subscribeWorkspaceExtensionEvents } = await import(
    "../src/lib/extensions/host-events.js"
  );
  const workspaceId = "ws-tree-views";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.tree-views",
    packageJson: {
      activationEvents: ["onView:fixtureTree"],
      contributes: {
        views: { explorer: [{ id: "fixtureTree", name: "Fixture Tree" }] },
        commands: [
          { command: "tree.refresh", title: "Refresh" },
          { command: "tree.leafAction", title: "Leaf Action" },
        ],
      },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  const emitter = new vscode.EventEmitter();
  let version = 1;
  let lastAction = null;
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren(element) {
      if (!element) return [{ key: "root-" + version, children: true }];
      if (element.children) return [{ key: element.key + "/leaf", children: false }];
      return [];
    },
    getTreeItem(element) {
      const item = new vscode.TreeItem(element.key, element.children ? 1 : 0);
      item.description = element.children ? "branch" : "leaf";
      if (!element.children) {
        item.command = { command: "tree.leafAction", title: "Act", arguments: [element.key] };
        item.iconPath = new vscode.ThemeIcon("file");
      }
      return item;
    },
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider("fixtureTree", provider));
  context.subscriptions.push(vscode.commands.registerCommand("tree.refresh", () => {
    version += 1;
    emitter.fire();
    return version;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("tree.leafAction", (key) => {
    lastAction = key;
    return { acted: key };
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const treeChanges: string[] = [];
  const unsubscribe = subscribeWorkspaceExtensionEvents(workspaceId, (event) => {
    if (event.type === "tree-changed") {
      treeChanges.push((event.payload as { viewId: string }).viewId);
    }
  });
  after(() => unsubscribe());

  const roots = await getExtensionTreeChildren({
    workspace: built.workspace,
    extensionId: "fixture.tree-views",
    viewId: "fixtureTree",
  });
  assert.equal(roots.missingProvider, false);
  assert.equal(roots.items.length, 1);
  const root = roots.items[0] as { handle: string; label: string; collapsibleState: number };
  assert.equal(root.label, "root-1");
  assert.equal(root.collapsibleState, 1);

  const leaves = await getExtensionTreeChildren({
    workspace: built.workspace,
    extensionId: "fixture.tree-views",
    viewId: "fixtureTree",
    parentHandle: root.handle,
  });
  const leaf = leaves.items[0] as {
    handle: string;
    label: string;
    hasCommand: boolean;
    iconId?: string;
    description?: string;
  };
  assert.equal(leaf.label, "root-1/leaf");
  assert.equal(leaf.hasCommand, true);
  assert.equal(leaf.iconId, "file");
  assert.equal(leaf.description, "leaf");

  // Tree item command execution through the handle registry.
  const action = await executeExtensionCommand({
    workspace: built.workspace,
    command: "",
    treeItem: { viewId: "fixtureTree", handle: leaf.handle },
  });
  assert.deepEqual(action.result, { acted: "root-1/leaf" });

  // Refresh must emit a tree-changed workspace event (throttled).
  await executeExtensionCommand({
    workspace: built.workspace,
    command: "tree.refresh",
    args: [],
  });
  await waitFor(
    () => treeChanges,
    (changes) => changes.includes("fixtureTree")
  );

  const rootsAfter = await getExtensionTreeChildren({
    workspace: built.workspace,
    extensionId: "fixture.tree-views",
    viewId: "fixtureTree",
  });
  assert.equal((rootsAfter.items[0] as { label: string }).label, "root-2");
});

/* ------------------------------------------------------------------ */
/* Status bar, output channels, diagnostics, context keys              */
/* ------------------------------------------------------------------ */

test("extension host: status bar, output, diagnostics, and context materialize", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { executeExtensionCommand, stopExtensionHost } = await import(
    "../src/lib/extensions/host-runtime.js"
  );
  const {
    getWorkspaceExtensionUiSnapshot,
    getWorkspaceOutputChannelContent,
  } = await import("../src/lib/extensions/host-events.js");
  const workspaceId = "ws-ui-materialize";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.materialize",
    packageJson: {
      contributes: { commands: [{ command: "mat.go", title: "Go" }] },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("mat.go", async () => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    item.text = "$(rocket) Fixture Ready";
    item.tooltip = "Fixture tooltip";
    item.command = "mat.go";
    item.show();
    const channel = vscode.window.createOutputChannel("Fixture Log");
    channel.appendLine("hello from fixture");
    const diagnostics = vscode.languages.createDiagnosticCollection("fixture");
    diagnostics.set(vscode.Uri.file("/tmp/fixture-file.ts"), [
      new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "Fixture problem", vscode.DiagnosticSeverity.Warning),
    ]);
    await vscode.commands.executeCommand("setContext", "fixture.ready", true);
    return true;
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const result = await executeExtensionCommand({
    workspace: built.workspace,
    command: "mat.go",
    args: [],
  });
  assert.equal(result.result, true);

  const snapshot = await waitFor(
    () => getWorkspaceExtensionUiSnapshot(workspaceId),
    (value) =>
      value.statusBarItems.length > 0 &&
      value.diagnostics.length > 0 &&
      Object.keys(value.contextKeys).length > 0 &&
      value.outputChannels.length > 0
  );
  const statusItem = snapshot.statusBarItems[0]!;
  assert.equal(statusItem.text, "$(rocket) Fixture Ready");
  assert.equal(statusItem.command, "mat.go");
  assert.equal(statusItem.visible, true);
  assert.equal(snapshot.contextKeys["fixture.ready"], true);
  const diagnostic = snapshot.diagnostics[0]!;
  assert.equal(diagnostic.uri, "/tmp/fixture-file.ts");
  assert.equal(diagnostic.entries[0]?.message, "Fixture problem");
  assert.equal(diagnostic.entries[0]?.severity, 1);
  const output = getWorkspaceOutputChannelContent(workspaceId, "fixture.materialize", "Fixture Log");
  assert.match(output ?? "", /hello from fixture/);
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test("extension host: configuration reads stored settings and persists updates", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { executeExtensionCommand, stopExtensionHost } = await import(
    "../src/lib/extensions/host-runtime.js"
  );
  const workspaceId = "ws-config";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.config",
    packageJson: {
      contributes: {
        commands: [
          { command: "config.read", title: "Read" },
          { command: "config.write", title: "Write" },
        ],
        configuration: {
          properties: {
            "fixtureconf.greeting": { type: "string", default: "default-greeting" },
            "fixtureconf.retries": { type: "number", default: 3 },
          },
        },
      },
    },
    settings: { "fixtureconf.greeting": "stored-greeting" },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("config.read", () => {
    const config = vscode.workspace.getConfiguration("fixtureconf");
    return {
      greeting: config.get("greeting"),
      retries: config.get("retries"),
      missing: config.get("missing", "fallback"),
    };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("config.write", async (value) => {
    await vscode.workspace.getConfiguration("fixtureconf").update("greeting", value, true);
    return true;
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const read = await executeExtensionCommand({
    workspace: built.workspace,
    command: "config.read",
    args: [],
  });
  assert.deepEqual(read.result, {
    greeting: "stored-greeting",
    retries: 3,
    missing: "fallback",
  });

  await executeExtensionCommand({
    workspace: built.workspace,
    command: "config.write",
    args: ["updated-greeting"],
  });

  // The config-update event persists asynchronously through storage.
  await waitFor(
    async () =>
      (await fixture.driver.getInstalledExtension(workspaceId, "fixture.config"))?.settings[
        "fixtureconf.greeting"
      ],
    (value) => value === "updated-greeting"
  );

  const reread = await executeExtensionCommand({
    workspace: built.workspace,
    command: "config.read",
    args: [],
  });
  assert.equal((reread.result as { greeting?: unknown }).greeting, "updated-greeting");
});

/* ------------------------------------------------------------------ */
/* Theme loader                                                        */
/* ------------------------------------------------------------------ */

test("theme loader: parses JSONC theme files with include chains", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  after(async () => fixture.cleanup());
  const { listExtensionThemes, loadExtensionTheme, parseJsonc } = await import(
    "../src/lib/extensions/theme-loader.js"
  );

  assert.deepEqual(parseJsonc('{"a": 1, /* block */ "b": [1, 2,], // line\n "c": "//x"}'), {
    a: 1,
    b: [1, 2],
    c: "//x",
  });

  const workspaceId = "ws-theme-loader";
  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.theme",
    packageJson: {
      main: undefined,
      contributes: {
        themes: [
          { id: "fixture-dark", label: "Fixture Dark", uiTheme: "vs-dark", path: "./themes/main.json" },
        ],
      },
    },
    code: "",
  });
  const themesDir = path.join(built.extensionRoot, "extension", "themes");
  await fs.mkdir(themesDir, { recursive: true });
  await fs.writeFile(
    path.join(themesDir, "base.json"),
    `{
      // base colors
      "colors": {
        "editor.background": "#101014",
        "editor.foreground": "#e0e0e8",
      },
      "tokenColors": [
        { "scope": "comment", "settings": { "foreground": "#6a737d", "fontStyle": "italic" } },
      ]
    }`
  );
  await fs.writeFile(
    path.join(themesDir, "main.json"),
    `{
      "include": "./base.json",
      "colors": {
        "sideBar.background": "#18181f",
        "focusBorder": "#ff00aa",
      },
      "tokenColors": [
        { "scope": ["keyword", "storage"], "settings": { "foreground": "#c678dd" } }
      ]
    }`
  );

  const descriptors = listExtensionThemes([built.record]);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.label, "Fixture Dark");

  const theme = await loadExtensionTheme({ record: built.record, label: "Fixture Dark" });
  assert.ok(theme);
  assert.equal(theme.type, "dark");
  assert.equal(theme.colors["editor.background"], "#101014");
  assert.equal(theme.colors["sideBar.background"], "#18181f");
  assert.equal(theme.webviewVariables["--vscode-editor-background"], "#101014");
  assert.equal(theme.webviewVariables["--vscode-sideBar-background"], "#18181f");
  assert.equal(theme.cesiumTokens["--bg-main"], "#101014");
  assert.equal(theme.cesiumTokens["--bg-panel"], "#18181f");
  assert.equal(theme.cesiumTokens["--accent"], "#ff00aa");
  assert.ok(theme.tokenRules.some((rule) => rule.token === "comment" && rule.fontStyle === "italic"));
  assert.ok(theme.tokenRules.some((rule) => rule.token === "keyword" && rule.foreground === "c678dd"));
  assert.equal(theme.monacoBase, "vs-dark");
});

/* ------------------------------------------------------------------ */
/* Crash recovery                                                      */
/* ------------------------------------------------------------------ */

test("extension host: retained hosts auto-restart and surfaces re-resolve after a crash", async () => {
  bootstrapFixtureEnv("legacy-json");
  const fixture = await createFixture("legacy-json");
  const { getExtensionHostStatus, stopExtensionHost } = await import(
    "../src/lib/extensions/host-runtime.js"
  );
  const { ensureExtensionSurfaceSession, listExtensionSurfaceSessions } = await import(
    "../src/lib/extensions/surface-sessions.js"
  );
  const workspaceId = "ws-crash-restart";
  after(async () => {
    await stopExtensionHost(workspaceId).catch(() => undefined);
    await fixture.cleanup();
  });

  const built = await writeFixtureExtension({
    workspaceId,
    extensionId: "fixture.crash-restart",
    packageJson: {
      activationEvents: ["onView:crashView"],
      contributes: {
        views: { explorer: [{ id: "crashView", type: "webview", name: "Crash View" }] },
      },
    },
    code: `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("crashView", {
    resolveWebviewView(view) {
      view.webview.html = "<html><body>alive at " + Date.now() + "</body></html>";
    }
  }));
};
`,
  });
  await fixture.driver.upsertWorkspace(built.workspace);
  await fixture.driver.upsertInstalledExtension(built.record);

  const snapshot = await ensureExtensionSurfaceSession({
    workspace: built.workspace,
    extensionId: "fixture.crash-restart",
    surfaceId: "crashView",
    kind: "webview",
  });
  assert.match(snapshot.html, /alive at/);
  const firstPid = getExtensionHostStatus(workspaceId).pid;
  assert.ok(firstPid);

  process.kill(firstPid!, "SIGKILL");

  // Auto-restart fires after ~1s backoff; the surface must re-resolve without
  // any client interaction.
  await waitFor(
    () => getExtensionHostStatus(workspaceId),
    (status) => status.running && status.pid !== firstPid,
    15_000,
    200
  );
  await waitFor(
    () => listExtensionSurfaceSessions(workspaceId)[0],
    (session) => Boolean(session && session.html.includes("alive at") && session.htmlVersion >= 2),
    15_000,
    200
  );
});
