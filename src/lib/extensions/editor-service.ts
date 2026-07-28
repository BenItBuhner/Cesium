import type { Monaco } from "@monaco-editor/react";
import type { ExtensionDiagnosticEntry } from "@/lib/server-api";

type RegisteredDocument = {
  path: string;
  language: string;
  version: number;
  contentBytes: number;
  openedAt: number;
  updatedAt: number;
};

const documents = new Map<string, RegisteredDocument>();
let activeMonaco: Monaco | null = null;
/** owner (`${extensionId}:${collection}`) -> uri -> markers */
const pendingDiagnostics = new Map<string, Map<string, ExtensionDiagnosticEntry[]>>();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function findModelForPath(filePath: string): unknown | null {
  if (!activeMonaco) return null;
  const target = normalizePath(filePath);
  for (const model of activeMonaco.editor.getModels()) {
    const modelPath = normalizePath(model.uri.path ?? "");
    if (modelPath === target || modelPath.endsWith(`/${target}`) || target.endsWith(`/${modelPath}`)) {
      return model;
    }
  }
  return null;
}

const MARKER_SEVERITY: Record<number, number> = {
  0: 8, // Error
  1: 4, // Warning
  2: 2, // Info
  3: 1, // Hint
};

function applyMarkersToModel(owner: string, filePath: string, entries: ExtensionDiagnosticEntry[]): void {
  if (!activeMonaco) return;
  const model = findModelForPath(filePath) as {
    uri: unknown;
  } | null;
  if (!model) return;
  activeMonaco.editor.setModelMarkers(
    model as never,
    `ext:${owner}`,
    entries.map((entry) => ({
      severity: MARKER_SEVERITY[entry.severity] ?? 8,
      message: entry.message,
      source: entry.source,
      code: entry.code,
      startLineNumber: entry.startLine + 1,
      startColumn: entry.startColumn + 1,
      endLineNumber: entry.endLine + 1,
      endColumn: Math.max(entry.endColumn + 1, entry.startColumn + 2),
    }))
  );
}

/** Called by the workspace bridge on `diagnostics` events from the host. */
export function applyExtensionDiagnostics(input: {
  owner: string;
  uri: string;
  entries: ExtensionDiagnosticEntry[];
}): void {
  let byUri = pendingDiagnostics.get(input.owner);
  if (!byUri) {
    byUri = new Map();
    pendingDiagnostics.set(input.owner, byUri);
  }
  if (input.entries.length === 0) {
    byUri.delete(input.uri);
  } else {
    byUri.set(input.uri, input.entries);
  }
  applyMarkersToModel(input.owner, input.uri, input.entries);
}

export function clearExtensionDiagnostics(owner: string): void {
  const byUri = pendingDiagnostics.get(owner);
  if (!byUri) return;
  for (const uri of byUri.keys()) {
    applyMarkersToModel(owner, uri, []);
  }
  pendingDiagnostics.delete(owner);
}

/** Applies text edits pushed by an extension (editor.edit / workspace.applyEdit). */
export function applyExtensionTextEdits(input: {
  path: string;
  edits: Array<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    newText: string;
  }>;
}): boolean {
  if (!activeMonaco || input.edits.length === 0) return false;
  const model = findModelForPath(input.path) as {
    pushEditOperations: (a: null, edits: unknown[], b: () => null) => void;
  } | null;
  if (!model) return false;
  model.pushEditOperations(
    null,
    input.edits.map((edit) => ({
      range: {
        startLineNumber: edit.startLine + 1,
        startColumn: edit.startColumn + 1,
        endLineNumber: edit.endLine + 1,
        endColumn: edit.endColumn + 1,
      },
      text: edit.newText,
    })),
    () => null
  );
  return true;
}

export function registerExtensionEditorDocument(input: {
  monaco: Monaco;
  filePath: string;
  language: string;
  content: string;
}): () => void {
  const now = Date.now();
  activeMonaco = input.monaco;
  const existing = documents.get(input.filePath);
  documents.set(input.filePath, {
    path: input.filePath,
    language: input.language,
    version: (existing?.version ?? 0) + 1,
    contentBytes: new TextEncoder().encode(input.content).byteLength,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
  });
  // Re-apply any diagnostics that arrived before this document's model existed.
  for (const [owner, byUri] of pendingDiagnostics) {
    for (const [uri, entries] of byUri) {
      if (normalizePath(uri).endsWith(normalizePath(input.filePath))) {
        applyMarkersToModel(owner, uri, entries);
      }
    }
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
