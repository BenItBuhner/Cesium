import { NativeModules, Platform } from "react-native";

type WearRelayConfig = {
  serverBaseUrl: string;
  serverLabel: string;
  authToken?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
};

type CesiumWearCompanionModule = {
  publishEnvelope(envelopeJson: string, config: WearRelayConfig): Promise<boolean>;
};

const nativeModule = NativeModules.CesiumWearCompanion as CesiumWearCompanionModule | undefined;

export const CesiumWearCompanion = {
  async publishEnvelope(envelopeJson: string, config: WearRelayConfig) {
    if (Platform.OS !== "android" || !nativeModule) {
      return false;
    }
    try {
      return await nativeModule.publishEnvelope(envelopeJson, config);
    } catch {
      return false;
    }
  },
};
