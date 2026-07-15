export type ExtensionApiCapabilityLevel = "real" | "bridged" | "stubbed" | "unsupported";

export type ExtensionApiCapability = {
  namespace: string;
  api: string;
  level: ExtensionApiCapabilityLevel;
  notes: string;
};

export const EXTENSION_API_CAPABILITIES: ExtensionApiCapability[] = [
  {
    namespace: "commands",
    api: "registerCommand/executeCommand/getCommands",
    level: "bridged",
    notes: "Commands execute inside the extension host and can be invoked from the client/server bridge.",
  },
  {
    namespace: "window",
    api: "activeTextEditor/visibleTextEditors",
    level: "bridged",
    notes: "Backed by Monaco/editor context when commands originate from an editor surface.",
  },
  {
    namespace: "workspace",
    api: "fs",
    level: "real",
    notes: "Backed by Node filesystem APIs with workspace/resource route validation.",
  },
  {
    namespace: "workspace",
    api: "workspaceState/globalState/secrets",
    level: "stubbed",
    notes: "Storage paths exist, but full VS Code memento/secrets persistence is not complete.",
  },
  {
    namespace: "window",
    api: "registerWebviewViewProvider/createWebviewPanel",
    level: "bridged",
    notes: "Webview views resolve to retained surface sessions and client iframes.",
  },
  {
    namespace: "window",
    api: "registerTreeDataProvider/createTreeView",
    level: "stubbed",
    notes: "Root-level tree items can render, but refresh, expansion, commands, and icons are incomplete.",
  },
  {
    namespace: "languages",
    api: "diagnostics/decorations/providers",
    level: "stubbed",
    notes: "Registration APIs exist; generic frontend diagnostic/decorator projection is still incomplete.",
  },
  {
    namespace: "debug",
    api: "*",
    level: "unsupported",
    notes: "Debugger APIs are intentionally outside the current beta runtime.",
  },
  {
    namespace: "scm",
    api: "*",
    level: "unsupported",
    notes: "SCM provider APIs are not implemented.",
  },
  {
    namespace: "notebook",
    api: "*",
    level: "unsupported",
    notes: "Notebook controllers/renderers are not implemented.",
  },
];
