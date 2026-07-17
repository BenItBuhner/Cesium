import { NativeModules, Platform } from "react-native";
import type { ImageAttachmentState } from "@cesium/core";

export type PickedNativeImage = {
  uri: string;
  mimeType: string;
  name: string;
  base64: string;
  byteLength: number;
};

type CesiumAndroidRuntimeModule = {
  getRuntimeConfig(): Promise<Record<string, unknown>>;
  pickImages(allowMultiple: boolean): Promise<PickedNativeImage[]>;
};

const nativeModule = NativeModules.CesiumAndroidRuntime as
  | CesiumAndroidRuntimeModule
  | undefined;

let localIdCounter = 0;

function nextLocalId(): string {
  localIdCounter += 1;
  return `native-image-${Date.now()}-${localIdCounter}`;
}

/** Open the platform image picker and return ImageAttachmentState drafts. */
export async function pickNativeImageAttachments(
  options: { allowMultiple?: boolean; existingCount?: number } = {}
): Promise<ImageAttachmentState[]> {
  const allowMultiple = options.allowMultiple !== false;
  const remaining = Math.max(0, 10 - (options.existingCount ?? 0));
  if (remaining === 0) {
    return [];
  }

  if (Platform.OS === "android" && nativeModule?.pickImages) {
    const picked = await nativeModule.pickImages(allowMultiple && remaining > 1);
    return picked
      .filter((image) => typeof image?.base64 === "string" && image.base64.length > 0)
      .slice(0, remaining)
      .map((image) => ({
        localId: nextLocalId(),
        mimeType: image.mimeType || "image/jpeg",
        data: image.base64,
        name: image.name || "image.jpg",
        uploadState: "uploaded" as const,
      }));
  }

  // Non-Android hosts (tests / future iOS) have no picker module yet.
  return [];
}
