import { NativeModules, Platform } from "react-native";

export type AndroidRuntimeConfig = {
  projectsDir: string | null;
  serverDataDir: string | null;
  defaultWorkspaceRoot: string | null;
  allowedWorkspaceRoots: string[];
  backendEnvironment: Record<string, string>;
  localBackendReady: boolean;
};

export type PickedAndroidImage = {
  uri: string;
  mimeType: string;
  name: string;
  base64: string;
  byteLength: number;
};

export type SharedAndroidItem = {
  name: string;
  mimeType: string;
  base64: string;
  byteLength: number;
};

export type SharedAndroidPayload = {
  text: string | null;
  subject: string | null;
  items: SharedAndroidItem[];
  skippedCount: number;
};

type CesiumAndroidRuntimeModule = {
  getRuntimeConfig(): Promise<Partial<AndroidRuntimeConfig>>;
  pickImages(allowMultiple: boolean): Promise<PickedAndroidImage[]>;
  consumeSharedPayload(): Promise<Partial<SharedAndroidPayload> | null>;
};

const nativeModule = NativeModules.CesiumAndroidRuntime as CesiumAndroidRuntimeModule | undefined;

export const CesiumAndroidRuntime = {
  async getRuntimeConfig(): Promise<AndroidRuntimeConfig | null> {
    if (Platform.OS !== "android" || !nativeModule) {
      return null;
    }

    try {
      return normalizeRuntimeConfig(await nativeModule.getRuntimeConfig());
    } catch {
      return null;
    }
  },

  async pickImages(allowMultiple = true): Promise<PickedAndroidImage[]> {
    if (Platform.OS !== "android" || !nativeModule?.pickImages) {
      return [];
    }
    try {
      const picked = await nativeModule.pickImages(allowMultiple);
      return Array.isArray(picked) ? picked : [];
    } catch {
      return [];
    }
  },

  /** Drains the pending share-sheet intent, or null when nothing was shared. */
  async consumeSharedPayload(): Promise<SharedAndroidPayload | null> {
    // Older native builds predate share intake; treat as best effort.
    if (Platform.OS !== "android" || typeof nativeModule?.consumeSharedPayload !== "function") {
      return null;
    }
    try {
      const raw = await nativeModule.consumeSharedPayload();
      if (!raw) {
        return null;
      }
      return {
        text: typeof raw.text === "string" && raw.text.length > 0 ? raw.text : null,
        subject: typeof raw.subject === "string" && raw.subject.length > 0 ? raw.subject : null,
        items: Array.isArray(raw.items)
          ? raw.items.filter(
              (item): item is SharedAndroidItem =>
                typeof item?.name === "string" &&
                typeof item?.mimeType === "string" &&
                typeof item?.base64 === "string" &&
                typeof item?.byteLength === "number"
            )
          : [],
        skippedCount: typeof raw.skippedCount === "number" ? raw.skippedCount : 0,
      };
    } catch {
      return null;
    }
  },
};

function normalizeRuntimeConfig(raw: Partial<AndroidRuntimeConfig>): AndroidRuntimeConfig {
  const backendEnvironment =
    raw.backendEnvironment && typeof raw.backendEnvironment === "object"
      ? Object.fromEntries(
          Object.entries(raw.backendEnvironment).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length > 0
          )
        )
      : {};

  return {
    projectsDir: normalizePath(raw.projectsDir),
    serverDataDir: normalizePath(raw.serverDataDir),
    defaultWorkspaceRoot: normalizePath(raw.defaultWorkspaceRoot),
    allowedWorkspaceRoots: Array.isArray(raw.allowedWorkspaceRoots)
      ? raw.allowedWorkspaceRoots.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
    backendEnvironment,
    localBackendReady: raw.localBackendReady === true,
  };
}

function normalizePath(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
