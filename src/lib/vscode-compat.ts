type Disposable = { dispose: () => void };

type MonacoLanguage = { id: string };

type MonacoUri = {
  path?: string;
  toString: () => string;
};

type MonacoModel = {
  uri: MonacoUri;
  getValue: () => string;
};

type MonacoMarkerSeverity = {
  Error?: number;
  Warning?: number;
  Info?: number;
  Hint?: number;
};

type MonacoLike = {
  Uri: {
    parse: (value: string) => MonacoUri;
  };
  MarkerSeverity?: MonacoMarkerSeverity;
  languages: {
    getLanguages: () => MonacoLanguage[];
    register: (language: {
      id: string;
      aliases?: string[];
      extensions?: string[];
      filenames?: string[];
      firstLine?: string;
    }) => Disposable | void;
    setLanguageConfiguration?: (languageId: string, configuration: unknown) => Disposable | void;
  };
  editor: {
    defineTheme: (themeName: string, themeData: MonacoThemeData) => void;
    setTheme?: (themeName: string) => void;
    getModel?: (uri: MonacoUri) => MonacoModel | null;
    setModelMarkers?: (model: MonacoModel, owner: string, markers: MonacoMarker[]) => void;
  };
};

export type VSCodeThemeDocument = {
  name?: string;
  type?: "dark" | "light" | "hc" | "highContrast" | string;
  colors?: Record<string, string>;
  tokenColors?: VSCodeTokenColor[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
};

type VSCodeTokenColor = {
  name?: string;
  scope?: string | string[];
  settings?: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
};

type MonacoThemeRule = {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
};

export type MonacoThemeData = {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
  encodedTokensColors?: string[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
};

export type VSCodeLanguageContribution = {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  firstLine?: string;
  configuration?: string | Record<string, unknown>;
};

export type VSCodeThemeContribution = {
  id?: string;
  label?: string;
  path?: string;
  uiTheme?: "vs" | "vs-dark" | "hc-black" | "hc-light" | string;
};

export type VSCodeCommandContribution = {
  command: string;
  title: string;
  category?: string;
};

export type VSCodeExtensionManifest = {
  name: string;
  publisher?: string;
  displayName?: string;
  description?: string;
  version?: string;
  engines?: Record<string, string>;
  activationEvents?: string[];
  contributes?: {
    languages?: VSCodeLanguageContribution[];
    themes?: VSCodeThemeContribution[];
    commands?: VSCodeCommandContribution[];
    configuration?: unknown;
    grammars?: unknown[];
  };
};

export type VSCodeDiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type VSCodeDiagnostic = {
  message: string;
  severity?: VSCodeDiagnosticSeverity | number;
  source?: string;
  code?: string | number;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
};

type MonacoMarker = VSCodeDiagnostic["range"] & {
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
};

export type VSCodeCompatTextDocument = {
  uri: MonacoUri;
  fileName: string;
  languageId: string;
  getText: () => string;
};

export type VSCodeDiagnosticProvider = (
  document: VSCodeCompatTextDocument
) => VSCodeDiagnostic[] | Promise<VSCodeDiagnostic[]>;

export type VSCodeDocumentSelector =
  | string
  | { language?: string; scheme?: string; pattern?: string }
  | Array<string | { language?: string; scheme?: string; pattern?: string }>;

export type VSCodeCompatWebviewPanel = {
  id: string;
  viewType: string;
  title: string;
  extensionId: string;
  webview: {
    html: string;
    options: Record<string, unknown>;
  };
  reveal: () => void;
  dispose: () => void;
};

type VSCodeCompatAPI = {
  commands: {
    registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => Disposable;
    executeCommand: (command: string, ...args: unknown[]) => unknown;
  };
  languages: {
    createDiagnosticCollection: (name?: string) => VSCodeDiagnosticCollection;
    registerDocumentDiagnosticProvider: (
      selector: VSCodeDocumentSelector,
      provider: VSCodeDiagnosticProvider
    ) => Disposable;
  };
  window: {
    createWebviewPanel: (
      viewType: string,
      title: string,
      showOptions?: unknown,
      options?: Record<string, unknown>
    ) => VSCodeCompatWebviewPanel;
  };
  workspace: {
    getConfiguration: (section?: string) => {
      get: <T>(key: string, defaultValue?: T) => T | undefined;
    };
    textDocuments: VSCodeCompatTextDocument[];
  };
  cesium: {
    registerDocumentDiagnosticProvider: (
      selector: VSCodeDocumentSelector,
      provider: VSCodeDiagnosticProvider
    ) => Disposable;
  };
};

export type VSCodeCompatExtension = {
  manifest: VSCodeExtensionManifest;
  themes?: Record<string, VSCodeThemeDocument>;
  activate?: (
    vscode: VSCodeCompatAPI,
    context: {
      extensionId: string;
      subscriptions: Disposable[];
      extension: VSCodeCompatExtension;
    }
  ) => unknown | Promise<unknown>;
};

type InstalledExtension = {
  extension: VSCodeCompatExtension;
  extensionId: string;
  activated: boolean;
  subscriptions: Disposable[];
};

type DiagnosticProviderRegistration = {
  extensionId: string;
  selector: VSCodeDocumentSelector;
  provider: VSCodeDiagnosticProvider;
};

export type VSCodeCompatibilityRuntime = {
  installExtension: (extension: VSCodeCompatExtension) => InstalledExtension;
  installExtensions: (extensions: VSCodeCompatExtension[]) => InstalledExtension[];
  activateExtension: (extensionId: string, reason?: string) => Promise<void>;
  activateForDocument: (document: VSCodeCompatTextDocument) => Promise<void>;
  executeCommand: (command: string, ...args: unknown[]) => unknown;
  setTheme: (themeId: string) => boolean;
  getThemeIds: () => string[];
  getInstalledExtensions: () => InstalledExtension[];
  getWebviewPanels: () => VSCodeCompatWebviewPanel[];
  dispose: () => void;
};

export const VSCODE_WEBVIEW_OPEN_EVENT = "cesium:vscode-webview-open";
export const VSCODE_WEBVIEW_UPDATE_EVENT = "cesium:vscode-webview-update";
export const VSCODE_WEBVIEW_REVEAL_EVENT = "cesium:vscode-webview-reveal";
export const VSCODE_WEBVIEW_DISPOSE_EVENT = "cesium:vscode-webview-dispose";

declare global {
  interface Window {
    cesiumVSCodeExtensions?: VSCodeCompatExtension[];
    cesiumVSCodeCompatibility?: VSCodeCompatibilityRuntime;
  }
}

function extensionIdFromManifest(manifest: VSCodeExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name;
}

function stripHash(value: string | undefined): string | undefined {
  return value?.replace(/^#/, "");
}

function themeBaseFromVSCodeTheme(
  document: VSCodeThemeDocument,
  contribution?: VSCodeThemeContribution
): MonacoThemeData["base"] {
  if (contribution?.uiTheme === "vs") return "vs";
  if (contribution?.uiTheme === "vs-dark") return "vs-dark";
  if (contribution?.uiTheme === "hc-black") return "hc-black";
  if (contribution?.uiTheme === "hc-light") return "hc-light";
  if (document.type === "light") return "vs";
  if (document.type === "hc" || document.type === "highContrast") return "hc-black";
  return "vs-dark";
}

function tokenScopes(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) {
    return scope.flatMap((entry) => tokenScopes(entry));
  }
  if (!scope) {
    return [];
  }
  return scope
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function translateVSCodeThemeToMonacoTheme(
  document: VSCodeThemeDocument,
  contribution?: VSCodeThemeContribution
): MonacoThemeData {
  const rules: MonacoThemeRule[] = [];
  for (const tokenColor of document.tokenColors ?? []) {
    const settings = tokenColor.settings ?? {};
    const foreground = stripHash(settings.foreground);
    const background = stripHash(settings.background);
    const fontStyle = settings.fontStyle;
    for (const token of tokenScopes(tokenColor.scope)) {
      rules.push({
        token,
        ...(foreground ? { foreground } : {}),
        ...(background ? { background } : {}),
        ...(fontStyle != null ? { fontStyle } : {}),
      });
    }
  }

  return {
    base: themeBaseFromVSCodeTheme(document, contribution),
    inherit: true,
    rules,
    colors: { ...(document.colors ?? {}) },
    ...(document.semanticHighlighting != null
      ? { semanticHighlighting: document.semanticHighlighting }
      : {}),
    ...(document.semanticTokenColors
      ? { semanticTokenColors: document.semanticTokenColors }
      : {}),
  };
}

function hasLanguage(monaco: MonacoLike, languageId: string): boolean {
  return monaco.languages
    .getLanguages()
    .some((language) => language.id.toLowerCase() === languageId.toLowerCase());
}

function normalizeThemeId(extensionId: string, contribution: VSCodeThemeContribution): string {
  const rawThemeId =
    contribution.id ?? `${extensionId}.${contribution.label ?? contribution.path ?? "theme"}`;
  const monacoThemeId = rawThemeId.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  return monacoThemeId || `${extensionId.replace(/[^A-Za-z0-9_-]+/g, "-")}-theme`;
}

function resolveContributionTheme(
  extension: VSCodeCompatExtension,
  contribution: VSCodeThemeContribution
): VSCodeThemeDocument | null {
  if (!extension.themes) {
    return null;
  }
  const keys = [contribution.path, contribution.id, contribution.label].filter(
    (key): key is string => Boolean(key)
  );
  for (const key of keys) {
    if (extension.themes[key]) {
      return extension.themes[key];
    }
  }
  return null;
}

function uriToString(uri: MonacoUri): string {
  return uri.toString();
}

function selectorMatchesDocument(
  selector: VSCodeDocumentSelector,
  document: VSCodeCompatTextDocument
): boolean {
  const selectors = Array.isArray(selector) ? selector : [selector];
  return selectors.some((entry) => {
    if (typeof entry === "string") {
      return entry === "*" || entry === document.languageId;
    }
    if (entry.language && entry.language !== "*" && entry.language !== document.languageId) {
      return false;
    }
    if (entry.scheme) {
      return uriToString(document.uri).startsWith(`${entry.scheme}:`);
    }
    return true;
  });
}

function markerSeverity(monaco: MonacoLike, severity: VSCodeDiagnostic["severity"]): number {
  const severities = monaco.MarkerSeverity ?? {};
  if (typeof severity === "number") {
    return severity;
  }
  if (severity === "warning") {
    return severities.Warning ?? 4;
  }
  if (severity === "information") {
    return severities.Info ?? 2;
  }
  if (severity === "hint") {
    return severities.Hint ?? 1;
  }
  return severities.Error ?? 8;
}

function toMonacoMarker(monaco: MonacoLike, diagnostic: VSCodeDiagnostic): MonacoMarker {
  return {
    ...diagnostic.range,
    message: diagnostic.message,
    severity: markerSeverity(monaco, diagnostic.severity),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code != null ? { code: diagnostic.code } : {}),
  };
}

function applyMarkers(
  monaco: MonacoLike,
  owner: string,
  uri: MonacoUri,
  diagnostics: VSCodeDiagnostic[]
): void {
  const model = monaco.editor.getModel?.(uri);
  if (!model || !monaco.editor.setModelMarkers) {
    return;
  }
  monaco.editor.setModelMarkers(
    model,
    owner,
    diagnostics.map((diagnostic) => toMonacoMarker(monaco, diagnostic))
  );
}

type VSCodeDiagnosticCollection = Disposable & {
  name: string;
  set: (uri: MonacoUri, diagnostics: VSCodeDiagnostic[]) => void;
  delete: (uri: MonacoUri) => void;
  clear: () => void;
};

function dispatchWebviewEvent(name: string, detail: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }
  const event =
    typeof CustomEvent === "function"
      ? new CustomEvent(name, { detail })
      : ({ type: name, detail } as CustomEvent);
  window.dispatchEvent(event);
}

function createWebviewPanel(
  extensionId: string,
  viewType: string,
  title: string,
  options: Record<string, unknown> = {}
): VSCodeCompatWebviewPanel {
  const panelId = `vscode-webview:${extensionId}:${viewType}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let html = "";
  let disposed = false;
  const panel: VSCodeCompatWebviewPanel = {
    id: panelId,
    viewType,
    title,
    extensionId,
    webview: {
      options,
      get html() {
        return html;
      },
      set html(nextHtml: string) {
        html = nextHtml;
        dispatchWebviewEvent(VSCODE_WEBVIEW_UPDATE_EVENT, {
          panelId,
          extensionId,
          viewType,
          title,
          html,
          options,
        });
      },
    },
    reveal() {
      if (!disposed) {
        dispatchWebviewEvent(VSCODE_WEBVIEW_REVEAL_EVENT, { panelId });
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      dispatchWebviewEvent(VSCODE_WEBVIEW_DISPOSE_EVENT, { panelId });
    },
  };
  dispatchWebviewEvent(VSCODE_WEBVIEW_OPEN_EVENT, {
    panelId,
    extensionId,
    viewType,
    title,
    html,
    options,
  });
  return panel;
}

export function resolveVSCodeCompatibilityTheme(input: {
  availableThemeIds: string[];
  preferredThemeId?: string | null;
  fallbackThemeId: string;
}): string {
  if (input.preferredThemeId && input.availableThemeIds.includes(input.preferredThemeId)) {
    return input.preferredThemeId;
  }
  return input.fallbackThemeId;
}

export function createVSCodeCompatibilityRuntime(monaco: MonacoLike): VSCodeCompatibilityRuntime {
  const installed = new Map<string, InstalledExtension>();
  const themeIds = new Set<string>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const diagnosticProviders: DiagnosticProviderRegistration[] = [];
  const diagnosticCollections = new Set<VSCodeDiagnosticCollection>();
  const webviewPanels = new Map<string, VSCodeCompatWebviewPanel>();

  function createApi(extensionId: string): VSCodeCompatAPI {
    const registerDiagnosticProvider = (
      selector: VSCodeDocumentSelector,
      provider: VSCodeDiagnosticProvider
    ): Disposable => {
      const registration = { extensionId, selector, provider };
      diagnosticProviders.push(registration);
      return {
        dispose() {
          const index = diagnosticProviders.indexOf(registration);
          if (index >= 0) {
            diagnosticProviders.splice(index, 1);
          }
        },
      };
    };

    return {
      commands: {
        registerCommand(command, callback) {
          commands.set(command, callback);
          return {
            dispose() {
              commands.delete(command);
            },
          };
        },
        executeCommand(command, ...args) {
          return commands.get(command)?.(...args);
        },
      },
      languages: {
        createDiagnosticCollection(name = extensionId) {
          const touchedUris = new Set<string>();
          const collection: VSCodeDiagnosticCollection = {
            name,
            set(uri, diagnostics) {
              touchedUris.add(uriToString(uri));
              applyMarkers(monaco, name, uri, diagnostics);
            },
            delete(uri) {
              touchedUris.delete(uriToString(uri));
              applyMarkers(monaco, name, uri, []);
            },
            clear() {
              for (const uriText of touchedUris) {
                applyMarkers(monaco, name, monaco.Uri.parse(uriText), []);
              }
              touchedUris.clear();
            },
            dispose() {
              collection.clear();
              diagnosticCollections.delete(collection);
            },
          };
          diagnosticCollections.add(collection);
          return collection;
        },
        registerDocumentDiagnosticProvider: registerDiagnosticProvider,
      },
      window: {
        createWebviewPanel(viewType, title, _showOptions, options) {
          const panel = createWebviewPanel(extensionId, viewType, title, options ?? {});
          webviewPanels.set(panel.id, panel);
          return panel;
        },
      },
      workspace: {
        getConfiguration() {
          return {
            get(_key, defaultValue) {
              return defaultValue;
            },
          };
        },
        textDocuments: [],
      },
      cesium: {
        registerDocumentDiagnosticProvider: registerDiagnosticProvider,
      },
    };
  }

  const runtime: VSCodeCompatibilityRuntime = {
    installExtension(extension) {
      const extensionId = extensionIdFromManifest(extension.manifest);
      const existing = installed.get(extensionId);
      if (existing) {
        return existing;
      }
      for (const language of extension.manifest.contributes?.languages ?? []) {
        if (!hasLanguage(monaco, language.id)) {
          monaco.languages.register({
            id: language.id,
            aliases: language.aliases,
            extensions: language.extensions,
            filenames: language.filenames,
            firstLine: language.firstLine,
          });
        }
        if (
          typeof language.configuration === "object" &&
          language.configuration &&
          monaco.languages.setLanguageConfiguration
        ) {
          monaco.languages.setLanguageConfiguration(language.id, language.configuration);
        }
      }
      for (const themeContribution of extension.manifest.contributes?.themes ?? []) {
        const themeDocument = resolveContributionTheme(extension, themeContribution);
        if (!themeDocument) {
          continue;
        }
        const themeId = normalizeThemeId(extensionId, themeContribution);
        monaco.editor.defineTheme(
          themeId,
          translateVSCodeThemeToMonacoTheme(themeDocument, themeContribution)
        );
        themeIds.add(themeId);
      }
      for (const command of extension.manifest.contributes?.commands ?? []) {
        if (!commands.has(command.command)) {
          commands.set(command.command, () => undefined);
        }
      }
      const record: InstalledExtension = {
        extension,
        extensionId,
        activated: false,
        subscriptions: [],
      };
      installed.set(extensionId, record);
      return record;
    },
    installExtensions(extensions) {
      return extensions.map((extension) => runtime.installExtension(extension));
    },
    async activateExtension(extensionId) {
      const record = installed.get(extensionId);
      if (!record || record.activated) {
        return;
      }
      record.activated = true;
      const api = createApi(extensionId);
      const context = {
        extensionId,
        subscriptions: record.subscriptions,
        extension: record.extension,
      };
      await record.extension.activate?.(api, context);
    },
    async activateForDocument(document) {
      for (const record of installed.values()) {
        const activationEvents = record.extension.manifest.activationEvents ?? [];
        const shouldActivate =
          activationEvents.length === 0 ||
          activationEvents.includes("*") ||
          activationEvents.includes("onStartupFinished") ||
          activationEvents.includes(`onLanguage:${document.languageId}`);
        if (shouldActivate) {
          await runtime.activateExtension(record.extensionId, `onLanguage:${document.languageId}`);
        }
      }
      for (const registration of diagnosticProviders) {
        if (!selectorMatchesDocument(registration.selector, document)) {
          continue;
        }
        const diagnostics = await registration.provider(document);
        applyMarkers(monaco, registration.extensionId, document.uri, diagnostics);
      }
    },
    executeCommand(command, ...args) {
      return commands.get(command)?.(...args);
    },
    setTheme(themeId) {
      if (!themeIds.has(themeId)) {
        return false;
      }
      monaco.editor.setTheme?.(themeId);
      return true;
    },
    getThemeIds() {
      return [...themeIds];
    },
    getInstalledExtensions() {
      return [...installed.values()];
    },
    getWebviewPanels() {
      return [...webviewPanels.values()];
    },
    dispose() {
      for (const record of installed.values()) {
        for (const subscription of record.subscriptions) {
          subscription.dispose();
        }
        record.subscriptions = [];
      }
      for (const collection of diagnosticCollections) {
        collection.dispose();
      }
      for (const panel of webviewPanels.values()) {
        panel.dispose();
      }
      installed.clear();
      commands.clear();
      diagnosticProviders.splice(0);
      diagnosticCollections.clear();
      webviewPanels.clear();
      themeIds.clear();
    },
  };

  return runtime;
}

const defaultDarkTheme: VSCodeThemeDocument = {
  name: "Default Dark Modern",
  type: "dark",
  colors: {
    "editor.background": "#1f1f1f",
    "editor.foreground": "#cccccc",
    "editorCursor.foreground": "#aeafad",
    "editorLineNumber.foreground": "#6e7681",
    "editor.selectionBackground": "#264f78",
    "editor.inactiveSelectionBackground": "#3a3d41",
    "editor.lineHighlightBackground": "#2a2d2e",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6a9955" } },
    { scope: "string", settings: { foreground: "#ce9178" } },
    { scope: "constant.numeric", settings: { foreground: "#b5cea8" } },
    { scope: "keyword", settings: { foreground: "#569cd6" } },
    { scope: "entity.name.function", settings: { foreground: "#dcdcaa" } },
  ],
};

const defaultLightTheme: VSCodeThemeDocument = {
  name: "Default Light Modern",
  type: "light",
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
    "editorCursor.foreground": "#000000",
    "editorLineNumber.foreground": "#237893",
    "editor.selectionBackground": "#add6ff",
    "editor.inactiveSelectionBackground": "#e5ebf1",
    "editor.lineHighlightBackground": "#f5f5f5",
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#008000" } },
    { scope: "string", settings: { foreground: "#a31515" } },
    { scope: "constant.numeric", settings: { foreground: "#098658" } },
    { scope: "keyword", settings: { foreground: "#0000ff" } },
    { scope: "entity.name.function", settings: { foreground: "#795e26" } },
  ],
};

const highContrastTheme: VSCodeThemeDocument = {
  name: "Default High Contrast",
  type: "hc",
  colors: {
    "editor.background": "#000000",
    "editor.foreground": "#ffffff",
    "editorCursor.foreground": "#ffffff",
    "editorLineNumber.foreground": "#ffffff",
    "editor.selectionBackground": "#f38518",
    "editor.lineHighlightBackground": "#1f1f1f",
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#7ca668" } },
    { scope: "string", settings: { foreground: "#ffff00" } },
    { scope: "keyword", settings: { foreground: "#569cd6", fontStyle: "bold" } },
  ],
};

export const BUILT_IN_VSCODE_COMPAT_EXTENSIONS: VSCodeCompatExtension[] = [
  {
    manifest: {
      name: "default-themes",
      publisher: "vscode",
      displayName: "VS Code Default Themes",
      version: "1.0.0",
      contributes: {
        themes: [
          {
            id: "vscode.default-dark-modern",
            label: "Default Dark Modern",
            uiTheme: "vs-dark",
            path: "./themes/default-dark-modern.json",
          },
          {
            id: "vscode.default-light-modern",
            label: "Default Light Modern",
            uiTheme: "vs",
            path: "./themes/default-light-modern.json",
          },
          {
            id: "vscode.default-high-contrast",
            label: "Default High Contrast",
            uiTheme: "hc-black",
            path: "./themes/default-high-contrast.json",
          },
        ],
      },
    },
    themes: {
      "./themes/default-dark-modern.json": defaultDarkTheme,
      "./themes/default-light-modern.json": defaultLightTheme,
      "./themes/default-high-contrast.json": highContrastTheme,
    },
  },
  {
    manifest: {
      name: "compat-linter",
      publisher: "cesium",
      displayName: "Cesium VS Code Compatibility Linter",
      version: "1.0.0",
      activationEvents: [
        "onLanguage:javascript",
        "onLanguage:typescript",
        "onLanguage:json",
        "onLanguage:markdown",
      ],
    },
    activate(vscode, context) {
      const disposable = vscode.cesium.registerDocumentDiagnosticProvider(
        ["javascript", "typescript", "json", "markdown"],
        (document) => {
          const diagnostics: VSCodeDiagnostic[] = [];
          const lines = document.getText().split(/\r?\n/);
          lines.forEach((line, index) => {
            const match = line.match(/[ \t]+$/);
            if (match?.index == null) {
              return;
            }
            diagnostics.push({
              message: "Trailing whitespace",
              severity: "warning",
              source: "compat-linter",
              range: {
                startLineNumber: index + 1,
                startColumn: match.index + 1,
                endLineNumber: index + 1,
                endColumn: line.length + 1,
              },
            });
          });
          return diagnostics;
        }
      );
      context.subscriptions.push(disposable);
    },
  },
  {
    manifest: {
      name: "sample-webview",
      publisher: "cesium",
      displayName: "Cesium VS Code Webview Smoke Extension",
      version: "1.0.0",
      activationEvents: ["onStartupFinished"],
      contributes: {
        commands: [
          {
            command: "cesium.compat.openSampleWebview",
            title: "Open VS Code Compatibility Webview",
          },
        ],
      },
    },
    activate(vscode, context) {
      context.subscriptions.push(
        vscode.commands.registerCommand("cesium.compat.openSampleWebview", () => {
          const panel = vscode.window.createWebviewPanel(
            "cesiumCompatSample",
            "VS Code Extension Webview"
          );
          panel.webview.html =
            "<!doctype html><html><body style=\"font-family: system-ui; background: #111827; color: white;\"><h1>VS Code webview rendered in Cesium</h1><p>Extension HTML is sandboxed in an editor tab.</p></body></html>";
          return panel;
        })
      );
    },
  },
];
