import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  availableDriverKinds,
  bootstrapFixtureEnv,
  createFixture,
} from "./helpers/storage-fixture.js";
import type { StorageDriverKind } from "../src/storage/driver.js";
import type {
  ExtensionInstallRecord,
  ExtensionPermissionGrant,
} from "../src/lib/extensions/types.js";
import { classifyExtensionManifest } from "../src/lib/extensions/manifest-classifier.js";

function makeExtensionRecord(
  workspaceId: string,
  overrides: Partial<ExtensionInstallRecord> = {}
): ExtensionInstallRecord {
  const now = Date.now();
  const extensionId = overrides.extensionId ?? `publisher.sample-${randomUUID().slice(0, 6)}`;
  const record: ExtensionInstallRecord = {
    schemaVersion: 1,
    workspaceId,
    extensionId,
    publisher: "publisher",
    name: "sample",
    displayName: "Sample Extension",
    description: "Fixture extension",
    version: "1.0.0",
    enabled: true,
    compatibility: "partial",
    compatibilityWarnings: ["Fixture warning"],
    source: {
      kind: "open-vsx",
      namespace: "publisher",
      name: "sample",
      version: "1.0.0",
      registryUrl: "https://open-vsx.org",
    },
    vsixSha256: "0".repeat(64),
    vsixSizeBytes: 128,
    installPath: "/tmp/sample-extension",
    manifest: {
      name: "sample",
      publisher: "publisher",
      displayName: "Sample Extension",
      description: "Fixture extension",
      version: "1.0.0",
      engines: { vscode: "^1.90.0" },
      main: "./out/extension.js",
      activationEvents: ["onCommand:sample.hello"],
      categories: ["Other"],
      contributes: {
        commands: 1,
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
      capabilities: classifyExtensionManifest({}),
      raw: {},
    },
    settings: {},
    permissions: [],
    runtime: {
      hostRunning: false,
      activated: false,
      activationEvents: [],
      crashCount: 0,
      disabledForCrashLoop: false,
    },
    installedAt: now,
    updatedAt: now,
    ...overrides,
  };
  if (!record.manifest.capabilities) {
    record.manifest = {
      ...record.manifest,
      capabilities: classifyExtensionManifest(record.manifest.raw),
    };
  }
  return record;
}

const DRIVERS = availableDriverKinds();

test("extensions compatibility matrix covers representative surface classes", async () => {
  const { EXTENSION_COMPATIBILITY_MATRIX } = await import(
    "../src/lib/extensions/compatibility-matrix.js"
  );
  assert.ok(EXTENSION_COMPATIBILITY_MATRIX.length >= 5);
  assert.ok(
    EXTENSION_COMPATIBILITY_MATRIX.some(
      (entry) => entry.primarySurface === "theme" && entry.expectedCompatibility === "high"
    )
  );
  assert.ok(
    EXTENSION_COMPATIBILITY_MATRIX.some(
      (entry) =>
        entry.primarySurface === "debugger" && entry.expectedCompatibility === "unsupported"
    )
  );
  assert.ok(
    EXTENSION_COMPATIBILITY_MATRIX.some((entry) =>
      entry.requiredApis.includes("languages")
    )
  );
});

test("extension manifest classifier separates static, activity, and hidden surfaces", () => {
  const themeOnly = classifyExtensionManifest({
    name: "theme-only",
    contributes: {
      themes: [{ id: "night", label: "Night", path: "./themes/night.json" }],
    },
  });
  assert.equal(themeOnly.status, "staticOnly");
  assert.equal(themeOnly.staticContributions[0]?.kind, "static.theme");
  assert.equal(themeOnly.activitySurfaces.length, 0);

  const clineLike = classifyExtensionManifest({
    name: "cline-like",
    main: "./out/extension.js",
    contributes: {
      viewsContainers: {
        activitybar: [{ id: "agent", title: "Agent", icon: "assets/agent.svg" }],
      },
      views: {
        agent: [{ id: "agent.sidebar", type: "webview", name: "Agent" }],
      },
    },
  });
  assert.equal(clineLike.status, "supported");
  assert.equal(clineLike.activitySurfaces[0]?.kind, "activity.webviewView");
  assert.equal(clineLike.activitySurfaces[0]?.icon.kind, "resource");

  const conditional = classifyExtensionManifest({
    name: "conditional",
    main: "./out/extension.js",
    contributes: {
      viewsContainers: {
        activitybar: [{ id: "conditional", title: "Conditional", icon: "$(lightbulb)" }],
      },
      views: {
        conditional: [
          { id: "conditional.view", type: "webview", name: "Conditional", when: "foo" },
        ],
      },
    },
  });
  assert.equal(conditional.activitySurfaces[0]?.visibility, "conditional");
  assert.equal(conditional.activitySurfaces[0]?.icon.kind, "codicon");
});

for (const kind of DRIVERS) {
  test(`extensions storage[${kind}]: installed extension lifecycle`, async () => {
    bootstrapFixtureEnv(kind as StorageDriverKind);
    const fixture = await createFixture(kind as StorageDriverKind);
    after(async () => fixture.cleanup());

    const workspaceId = "ws-extensions";
    await fixture.driver.upsertWorkspace({
      id: workspaceId,
      name: "Extensions Workspace",
      root: "/tmp/extensions-workspace",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    });
    const record = makeExtensionRecord(workspaceId);
    await fixture.driver.upsertInstalledExtension(record);

    assert.equal(
      (await fixture.driver.listInstalledExtensions(workspaceId)).length,
      1
    );
    assert.equal(
      (await fixture.driver.getInstalledExtension(workspaceId, record.extensionId))?.displayName,
      "Sample Extension"
    );

    const patched = await fixture.driver.patchExtensionSettings(
      workspaceId,
      record.extensionId,
      { "sample.enabled": true }
    );
    assert.equal(patched?.settings["sample.enabled"], true);

    const grant: ExtensionPermissionGrant = {
      id: randomUUID(),
      workspaceId,
      extensionId: record.extensionId,
      permission: "workspace.trust",
      granted: true,
      reason: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await fixture.driver.upsertExtensionPermissionGrant(grant);
    assert.equal(
      (await fixture.driver.getInstalledExtension(workspaceId, record.extensionId))?.permissions[0]
        ?.granted,
      true
    );

    assert.equal(
      await fixture.driver.deleteInstalledExtension(workspaceId, record.extensionId),
      true
    );
    assert.equal(await fixture.driver.getInstalledExtension(workspaceId, record.extensionId), null);
  });
}

for (const kind of DRIVERS) {
  test(`extensions host[${kind}]: editor context commands see active editor selection`, async () => {
    bootstrapFixtureEnv(kind as StorageDriverKind);
    const fixture = await createFixture(kind as StorageDriverKind);
    const [{ executeExtensionCommand, stopExtensionHost }] = await Promise.all([
      import("../src/lib/extensions/host-runtime.js"),
    ]);
    after(async () => {
      await stopExtensionHost("ws-editor-context").catch(() => undefined);
      await fixture.cleanup();
    });

    const workspaceId = "ws-editor-context";
    const extensionId = "fixture.editor-context";
    const extensionRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencursor-editor-context-extension-")
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencursor-editor-context-workspace-")
    );
    const editorFile = path.join(workspaceRoot, "src", "example.ts");
    const extensionPath = path.join(extensionRoot, "extension");
    await fs.mkdir(path.join(extensionPath, "out"), { recursive: true });
    await fs.writeFile(
      path.join(extensionPath, "package.json"),
      JSON.stringify({
        name: "editor-context",
        publisher: "fixture",
        version: "1.0.0",
        main: "./out/extension.cjs",
        activationEvents: ["onCommand:cline.addToChat"],
        contributes: {
          commands: [{ command: "cline.addToChat", title: "Cline: Add to Cline" }],
          menus: {
            "editor/context": [{ command: "cline.addToChat", group: "navigation" }],
          },
        },
      })
    );
    await fs.writeFile(
      path.join(extensionPath, "out", "extension.cjs"),
      `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("cline.addToChat", () => {
    const editor = vscode.window.activeTextEditor;
    return {
      fileName: editor && editor.document.fileName,
      languageId: editor && editor.document.languageId,
      selectedText: editor ? editor.document.getText(editor.selection) : "",
      fullText: editor ? editor.document.getText() : "",
      visibleTextEditors: vscode.window.visibleTextEditors.length,
      textDocuments: vscode.workspace.textDocuments.length
    };
  }));
};
`
    );

    const workspace = {
      id: workspaceId,
      name: "Editor Context Workspace",
      root: workspaceRoot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    await fixture.driver.upsertWorkspace(workspace);
    await fixture.driver.upsertInstalledExtension(
      makeExtensionRecord(workspaceId, {
        extensionId,
        publisher: "fixture",
        name: "editor-context",
        displayName: "Editor Context Fixture",
        installPath: extensionRoot,
        manifest: {
          name: "editor-context",
          publisher: "fixture",
          displayName: "Editor Context Fixture",
          version: "1.0.0",
          engines: { vscode: "^1.90.0" },
          main: "./out/extension.cjs",
          activationEvents: ["onCommand:cline.addToChat"],
          categories: ["Other"],
          contributes: {
            commands: 1,
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
            menus: 1,
          },
          raw: {
            contributes: {
              commands: [{ command: "cline.addToChat", title: "Cline: Add to Cline" }],
              menus: {
                "editor/context": [{ command: "cline.addToChat", group: "navigation" }],
              },
            },
          },
        },
        permissions: [
          {
            id: randomUUID(),
            workspaceId,
            extensionId,
            permission: "workspace.trust",
            granted: true,
            reason: "test",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      })
    );

    const result = await executeExtensionCommand({
      workspace,
      command: "cline.addToChat",
      args: [],
      editorContext: {
        uri: `file:///${editorFile.replace(/\\/g, "/")}`,
        path: editorFile,
        language: "typescript",
        content: "const greeting = 'hello cline';\nconsole.log(greeting);\n",
        selection: {
          startLineNumber: 1,
          startColumn: 19,
          endLineNumber: 1,
          endColumn: 24,
        },
      },
    });

    assert.deepEqual(result.result, {
      fileName: editorFile,
      languageId: "typescript",
      selectedText: "hello",
      fullText: "const greeting = 'hello cline';\nconsole.log(greeting);\n",
      visibleTextEditors: 1,
      textDocuments: 1,
    });
  });
}

for (const kind of DRIVERS) {
  test(`extensions surface sessions[${kind}]: prewarm keeps webviews server-owned without clients`, async () => {
    bootstrapFixtureEnv(kind as StorageDriverKind);
    const fixture = await createFixture(kind as StorageDriverKind);
    const [
      { getExtensionHostStatus, stopExtensionHost },
      {
        detachExtensionSurfaceSession,
        listExtensionSurfaceSessions,
        prewarmExtensionSurfaceSessions,
      },
    ] = await Promise.all([
      import("../src/lib/extensions/host-runtime.js"),
      import("../src/lib/extensions/surface-sessions.js"),
    ]);
    after(async () => {
      await stopExtensionHost("ws-surface-prewarm").catch(() => undefined);
      await fixture.cleanup();
    });

    const workspaceId = "ws-surface-prewarm";
    const extensionId = "fixture.surface-prewarm";
    const extensionRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencursor-surface-prewarm-extension-")
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencursor-surface-prewarm-workspace-")
    );
    const extensionPath = path.join(extensionRoot, "extension");
    await fs.mkdir(path.join(extensionPath, "out"), { recursive: true });
    await fs.writeFile(
      path.join(extensionPath, "package.json"),
      JSON.stringify({
        name: "surface-prewarm",
        publisher: "fixture",
        version: "1.0.0",
        main: "./out/extension.cjs",
        activationEvents: ["onView:fixtureSurfaceView"],
        contributes: {
          viewsContainers: {
            activitybar: [{ id: "fixtureSurfaceContainer", title: "Fixture Surfaces" }],
          },
          views: {
            fixtureSurfaceContainer: [
              { id: "fixtureSurfaceView", name: "Fixture Surface", type: "webview" },
            ],
          },
        },
      })
    );
    await fs.writeFile(
      path.join(extensionPath, "out", "extension.cjs"),
      `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("fixtureSurfaceView", {
    resolveWebviewView(view) {
      view.webview.html = "<html><body><main id='server-owned'>server owned webview</main></body></html>";
      void view.webview.postMessage({ kind: "ready-from-host" });
    }
  }));
};
`
    );

    const workspace = {
      id: workspaceId,
      name: "Surface Prewarm Workspace",
      root: workspaceRoot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    await fixture.driver.upsertWorkspace(workspace);
    const record = makeExtensionRecord(workspaceId, {
      extensionId,
      publisher: "fixture",
      name: "surface-prewarm",
      displayName: "Surface Prewarm Fixture",
      installPath: extensionRoot,
      manifest: {
        name: "surface-prewarm",
        publisher: "fixture",
        displayName: "Surface Prewarm Fixture",
        version: "1.0.0",
        engines: { vscode: "^1.90.0" },
        main: "./out/extension.cjs",
        activationEvents: ["onView:fixtureSurfaceView"],
        categories: ["Other"],
        contributes: {
          commands: 0,
          configuration: 0,
          languages: 0,
          grammars: 0,
          snippets: 0,
          themes: 0,
          iconThemes: 0,
          views: 1,
          viewsContainers: 1,
          webviews: 1,
          customEditors: 0,
          keybindings: 0,
          menus: 0,
        },
        raw: {
          contributes: {
            viewsContainers: {
              activitybar: [{ id: "fixtureSurfaceContainer", title: "Fixture Surfaces" }],
            },
            views: {
              fixtureSurfaceContainer: [
                { id: "fixtureSurfaceView", name: "Fixture Surface", type: "webview" },
              ],
            },
          },
        },
      },
      permissions: [
        {
          id: randomUUID(),
          workspaceId,
          extensionId,
          permission: "workspace.trust",
          granted: true,
          reason: "test",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    await fixture.driver.upsertInstalledExtension(record);

    const snapshots = await prewarmExtensionSurfaceSessions({
      workspace,
      extensions: [record],
    });
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0]?.html ?? "", /server owned webview/);
    assert.equal(snapshots[0]?.session.attachedClientCount, 0);
    assert.equal(snapshots[0]?.messages.length, 1);

    const sessions = listExtensionSurfaceSessions(workspaceId);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.attachedClientCount, 0);
    assert.ok(
      getExtensionHostStatus(workspaceId).retainedBy.includes(`surface:${sessions[0]?.sessionId}`)
    );

    await detachExtensionSurfaceSession({
      workspaceId,
      sessionId: sessions[0]!.sessionId,
      clientId: "client-that-never-owned-runtime",
    });
    assert.ok(
      getExtensionHostStatus(workspaceId).retainedBy.includes(`surface:${sessions[0]?.sessionId}`)
    );
  });
}
