import type { Monaco } from "@monaco-editor/react";

type RegisteredDocument = {
  path: string;
  language: string;
  version: number;
  contentBytes: number;
  openedAt: number;
  updatedAt: number;
};

type MonacoModelWithUriPath = {
  uri: {
    path: string;
  };
};

const documents = new Map<string, RegisteredDocument>();
let providerSetupComplete = false;

export function registerExtensionEditorDocument(input: {
  monaco: Monaco;
  filePath: string;
  language: string;
  content: string;
}): () => void {
  const now = Date.now();
  const existing = documents.get(input.filePath);
  documents.set(input.filePath, {
    path: input.filePath,
    language: input.language,
    version: (existing?.version ?? 0) + 1,
    contentBytes: new TextEncoder().encode(input.content).byteLength,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
  });
  if (!providerSetupComplete) {
    setupPrototypeProviders(input.monaco);
    providerSetupComplete = true;
  }
  return () => {
    documents.delete(input.filePath);
  };
}

export function updateExtensionEditorDocument(input: {
  filePath: string;
  language: string;
  content: string;
}): void {
  const now = Date.now();
  const existing = documents.get(input.filePath);
  if (!existing) {
    documents.set(input.filePath, {
      path: input.filePath,
      language: input.language,
      version: 1,
      contentBytes: new TextEncoder().encode(input.content).byteLength,
      openedAt: now,
      updatedAt: now,
    });
    return;
  }
  documents.set(input.filePath, {
    ...existing,
    language: input.language,
    version: existing.version + 1,
    contentBytes: new TextEncoder().encode(input.content).byteLength,
    updatedAt: now,
  });
}

export function listExtensionEditorDocuments(): RegisteredDocument[] {
  return [...documents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function setupPrototypeProviders(monaco: Monaco): void {
  monaco.languages.registerHoverProvider("*", {
    provideHover(model: MonacoModelWithUriPath) {
      const path = model.uri.path.replace(/^\/+/, "");
      const doc = documents.get(path);
      if (!doc) {
        return null;
      }
      return {
        contents: [
          { value: "**OpenCursor Extensions Beta**" },
          {
            value: `Document is visible to the extension editor service. Version: ${doc.version}.`,
          },
        ],
      };
    },
  });
}
