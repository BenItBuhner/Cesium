export type ArtifactKind = "chart" | "html" | "project";

/** Matches `ArtifactSummary` in server/src/lib/artifacts/store.ts. */
export type ArtifactSummary = {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: ArtifactKind;
  description?: string;
  entry: string;
  createdAt: number;
  updatedAt: number;
  /** Server-relative view path, e.g. `/artifacts/<workspaceId>/<artifactId>/`. */
  serverPath: string;
  files: string[];
};
