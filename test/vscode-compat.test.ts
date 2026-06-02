import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  VSCODE_WEBVIEW_OPEN_EVENT,
  VSCODE_WEBVIEW_UPDATE_EVENT,
  createVSCodeCompatibilityRuntime,
  translateVSCodeThemeToMonacoTheme,
  type VSCodeCompatExtension,
} from "../src/lib/vscode-compat.ts";

function createFakeMonaco() {
  const languages = [{ id: "typescript" }, { id: "javascript" }];
  const themes = new Map<string, unknown>();
  const markers = new Map<string, unknown[]>();
  const model = {
    uri: { path: "/src/index.ts", toString: () => "file:///src/index.ts" },
    getValue: () => "const answer = 42;  ",
  };

  return {
    languages,
    themes,
    markers,
    model,
    monaco: {
      Uri: {
        parse: (value: string) => ({ path: value.replace(/^file:\/\//, ""), toString: () => value }),
      },
      MarkerSeverity: {
        Error: 8,
        Warning: 4,
        Info: 2,
        Hint: 1,
      },
      languages: {
        getLanguages: () => languages,
        register: (language: { id: string }) => {
          languages.push(language);
          return { dispose() {} };
        },
        setLanguageConfiguration: () => ({ dispose() {} }),
      },
      editor: {
        defineTheme: (themeId: string, theme: unknown) => {
          themes.set(themeId, theme);
        },
        setTheme: (themeId: string) => {
          themes.set("active", themeId);
        },
        getModel: (uri: { toString: () => string }) =>
          uri.toString() === model.uri.toString() ? model : null,
        setModelMarkers: (
          _model: unknown,
          owner: string,
          nextMarkers: unknown[]
        ) => {
          markers.set(owner, nextMarkers);
        },
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("VS Code compatibility layer", () => {
  test("translates multiple VS Code theme formats to Monaco themes", () => {
    const dark = translateVSCodeThemeToMonacoTheme(
      {
        type: "dark",
        colors: { "editor.background": "#101010" },
        tokenColors: [
          {
            scope: ["comment", "string.quoted"],
            settings: { foreground: "#6a9955", fontStyle: "italic" },
          },
        ],
      },
      { uiTheme: "vs-dark" }
    );
    assert.equal(dark.base, "vs-dark");
    assert.equal(dark.colors["editor.background"], "#101010");
    assert.deepEqual(dark.rules, [
      { token: "comment", foreground: "6a9955", fontStyle: "italic" },
      { token: "string.quoted", foreground: "6a9955", fontStyle: "italic" },
    ]);

    const light = translateVSCodeThemeToMonacoTheme({
      type: "light",
      tokenColors: [{ scope: "keyword, storage", settings: { foreground: "#0000ff" } }],
    });
    assert.equal(light.base, "vs");
    assert.deepEqual(light.rules.map((rule) => rule.token), ["keyword", "storage"]);

    const contrast = translateVSCodeThemeToMonacoTheme({
      type: "hc",
      semanticHighlighting: true,
      semanticTokenColors: { variable: "#ffffff" },
    });
    assert.equal(contrast.base, "hc-black");
    assert.equal(contrast.semanticHighlighting, true);
    assert.deepEqual(contrast.semanticTokenColors, { variable: "#ffffff" });
  });

  test("installs language and theme contributions from extension manifests", () => {
    const fake = createFakeMonaco();
    const runtime = createVSCodeCompatibilityRuntime(fake.monaco);
    const extension: VSCodeCompatExtension = {
      manifest: {
        name: "multi-contribution",
        publisher: "demo",
        contributes: {
          languages: [
            {
              id: "demo-lang",
              aliases: ["Demo"],
              extensions: [".demo"],
              configuration: { comments: { lineComment: "//" } },
            },
          ],
          themes: [
            { id: "demo.dark", label: "Demo Dark", uiTheme: "vs-dark", path: "./dark.json" },
            { id: "demo.light", label: "Demo Light", uiTheme: "vs", path: "./light.json" },
          ],
        },
      },
      themes: {
        "./dark.json": { type: "dark", colors: { "editor.background": "#111111" } },
        "./light.json": { type: "light", colors: { "editor.background": "#ffffff" } },
      },
    };

    runtime.installExtension(extension);

    assert.ok(fake.languages.some((language) => language.id === "demo-lang"));
    assert.deepEqual(runtime.getThemeIds().sort(), ["demo.dark", "demo.light"]);
    assert.equal(fake.themes.has("demo.dark"), true);
    assert.equal(fake.themes.has("demo.light"), true);
    assert.equal(runtime.setTheme("demo.light"), true);
    assert.equal(fake.themes.get("active"), "demo.light");
  });

  test("activates extension diagnostics for Monaco documents", async () => {
    const fake = createFakeMonaco();
    const runtime = createVSCodeCompatibilityRuntime(fake.monaco);
    runtime.installExtension({
      manifest: {
        name: "diagnostics",
        publisher: "demo",
        activationEvents: ["onLanguage:typescript"],
      },
      activate(vscode, context) {
        context.subscriptions.push(
          vscode.languages.registerDocumentDiagnosticProvider("typescript", (document) => [
            {
              message: `Linted ${document.languageId}`,
              severity: "warning",
              source: "demo-linter",
              range: {
                startLineNumber: 1,
                startColumn: 18,
                endLineNumber: 1,
                endColumn: 20,
              },
            },
          ])
        );
      },
    });

    await runtime.activateForDocument({
      uri: fake.model.uri,
      fileName: "/src/index.ts",
      languageId: "typescript",
      getText: fake.model.getValue,
    });

    assert.equal(runtime.getInstalledExtensions()[0]?.activated, true);
    assert.deepEqual(fake.markers.get("demo.diagnostics"), [
      {
        startLineNumber: 1,
        startColumn: 18,
        endLineNumber: 1,
        endColumn: 20,
        message: "Linted typescript",
        severity: 4,
        source: "demo-linter",
      },
    ]);
  });

  test("creates and updates extension webview panels through editor events", async () => {
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    (globalThis as { window?: unknown }).window = {
      dispatchEvent(event: { type: string; detail: Record<string, unknown> }) {
        events.push({ type: event.type, detail: event.detail });
        return true;
      },
    };
    const fake = createFakeMonaco();
    const runtime = createVSCodeCompatibilityRuntime(fake.monaco);
    runtime.installExtension({
      manifest: {
        name: "webviews",
        publisher: "demo",
        activationEvents: ["onStartupFinished"],
      },
      activate(vscode) {
        const panel = vscode.window.createWebviewPanel("demoView", "Demo Webview");
        panel.webview.html = "<h1>Rendered extension</h1>";
      },
    });

    await runtime.activateExtension("demo.webviews");

    assert.equal(events[0]?.type, VSCODE_WEBVIEW_OPEN_EVENT);
    assert.equal(events[1]?.type, VSCODE_WEBVIEW_UPDATE_EVENT);
    assert.equal(events[1]?.detail.html, "<h1>Rendered extension</h1>");
    assert.equal(runtime.getWebviewPanels()[0]?.webview.html, "<h1>Rendered extension</h1>");
  });
});
