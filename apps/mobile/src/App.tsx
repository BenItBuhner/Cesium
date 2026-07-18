import "../global.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  PermissionsAndroid,
  Platform,
  StatusBar,
  type AppStateStatus,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  cancelAgentConversation,
  getStoredSessionToken,
  setActiveWorkspaceId,
} from "@cesium/client";
import { ServerConnectionsProvider, GlobalSettingsProvider } from "@cesium/client/react";
import { toWatchAgentProjection, toWatchSyncEnvelope } from "@cesium/core";
import {
  NativeAuthProvider,
  NativeWorkbench,
  NativeWorkspaceProvider,
  type NativeMobileControlSettings,
  useColorScheme,
  useThemeTokens,
} from "@cesium/ui-native";
import { readLaunchUrlConfig, resolveLaunchUrlConfig } from "./config";
import { installReactNativeClientPlatform, setRuntimeServerBaseUrl } from "./platform";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import { CesiumWearCompanion } from "./native/CesiumWearCompanion";
import {
  CesiumPhoneControl,
  type PhoneControlStatus,
} from "./native/CesiumPhoneControl";
import { AgentStatusService } from "./services/AgentStatusService";
import { BackgroundCoordinator } from "./services/BackgroundCoordinator";
import { LiveUpdateController } from "./services/LiveUpdateController";

installReactNativeClientPlatform();
const INITIAL_CONFIG = readLaunchUrlConfig();
setRuntimeServerBaseUrl(INITIAL_CONFIG.serverUrl);

type ConnectionState = "idle" | "connecting" | "open" | "closed" | "reconnecting";

const INITIAL_PHONE_CONTROL_STATUS: PhoneControlStatus = {
  enabled: false,
  connectionState: "disabled",
  serverUrl: "",
  workspaceId: "",
  deviceId: "",
  accessibilityEnabled: false,
  assistantSelected: false,
  assistantRoleAvailable: false,
  hotwordMode: "oem_dependent",
  privateDisplaySupported: false,
};

export default function App() {
  const colorScheme = useColorScheme();
  const themeTokens = useThemeTokens();
  const [serverUrl, setServerUrl] = useState(INITIAL_CONFIG.serverUrl);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [phoneControlStatus, setPhoneControlStatus] = useState<PhoneControlStatus>(
    INITIAL_PHONE_CONTROL_STATUS
  );
  const [notificationConversationId, setNotificationConversationId] = useState<string | null>(
    null
  );
  const serverUrlRef = useRef(serverUrl);
  const workspaceIdRef = useRef<string | null>(null);
  const phoneSyncKeyRef = useRef("");
  const liveUpdatesRef = useRef(new LiveUpdateController());
  const agentStatusRef = useRef(
    new AgentStatusService({
      onProjection: (projection) => {
        void liveUpdatesRef.current.update(projection);
        if (projection) {
          const serverBaseUrl = serverUrlRef.current;
          const watchProjection = toWatchAgentProjection(projection, {
            source: "phone_companion",
          });
          const envelope = toWatchSyncEnvelope({
            projection: watchProjection,
            source: "phone_companion",
            server: {
              label: "This phone",
              baseUrl: serverBaseUrl,
            },
            focused: {
              workspaceId: projection.workspaceId,
              conversationId: projection.conversationId,
              lastEventSeq: projection.lastEventSeq,
            },
          });
          void CesiumWearCompanion.publishEnvelope(JSON.stringify(envelope), {
            serverBaseUrl,
            serverLabel: "This phone",
            authToken: getStoredSessionToken(serverBaseUrl),
            workspaceId: projection.workspaceId,
            conversationId: projection.conversationId,
          }).catch(() => undefined);
        }
      },
      onConnectionState: setConnectionState,
    })
  );
  const backgroundCoordinatorRef = useRef(
    new BackgroundCoordinator(agentStatusRef.current, liveUpdatesRef.current)
  );

  const consumeNotificationAction = useCallback(async () => {
    const action = await CesiumLiveUpdates.consumeInitialNotificationAction();
    if (!action.conversationId) {
      return;
    }
    setNotificationConversationId(action.conversationId);
    if (action.actionId === "cancel") {
      if (action.workspaceId) {
        setActiveWorkspaceId(action.workspaceId);
      }
      await cancelAgentConversation(action.conversationId).catch(() => undefined);
    }
  }, []);

  const configureAgentSocket = useCallback(
    (workspaceId: string | null, conversationId: string | null) => {
      workspaceIdRef.current = workspaceId;
      agentStatusRef.current.updateConfig({
        serverBaseUrl: serverUrl,
        workspaceId,
        conversationId,
        authToken: null,
      });
      const syncKey = `${serverUrl}\0${workspaceId ?? ""}`;
      if (workspaceId && phoneSyncKeyRef.current !== syncKey) {
        phoneSyncKeyRef.current = syncKey;
        void CesiumPhoneControl.syncConnection(
          serverUrl,
          workspaceId,
          getStoredSessionToken(serverUrl)
        )
          .then(setPhoneControlStatus)
          .catch(() => undefined);
      }
    },
    [serverUrl]
  );

  const refreshPhoneControl = useCallback(async () => {
    setPhoneControlStatus(await CesiumPhoneControl.getStatus());
  }, []);

  const setPhoneControlEnabled = useCallback(async (enabled: boolean) => {
    const workspaceId = workspaceIdRef.current;
    if (enabled && !workspaceId) {
      throw new Error("Select a workspace before enabling mobile control.");
    }
    const next = await CesiumPhoneControl.setEnabled(
      enabled,
      serverUrlRef.current,
      workspaceId ?? "",
      getStoredSessionToken(serverUrlRef.current)
    );
    setPhoneControlStatus(next);
  }, []);

  const requestAssistantRole = useCallback(async () => {
    if (Platform.OS === "android") {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    }
    await CesiumPhoneControl.requestAssistantRole();
  }, []);

  const mobileControl = useMemo<NativeMobileControlSettings>(
    () => ({
      status: phoneControlStatus,
      refresh: refreshPhoneControl,
      setEnabled: setPhoneControlEnabled,
      async openAccessibilitySettings() {
        await CesiumPhoneControl.openAccessibilitySettings();
      },
      requestAssistantRole,
      async launchAssistant() {
        await CesiumPhoneControl.launchAssistant();
      },
    }),
    [
      phoneControlStatus,
      refreshPhoneControl,
      requestAssistantRole,
      setPhoneControlEnabled,
    ]
  );

  useEffect(() => {
    serverUrlRef.current = serverUrl;
    setRuntimeServerBaseUrl(serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    void resolveLaunchUrlConfig().then((nextConfig) => {
      if (cancelled) {
        return;
      }
      setServerUrl((current) =>
        current === INITIAL_CONFIG.serverUrl ? nextConfig.serverUrl : current
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const agentStatus = agentStatusRef.current;
    const liveUpdates = liveUpdatesRef.current;
    if (Platform.OS === "android") {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
        () => undefined
      );
    }
    const appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      backgroundCoordinatorRef.current.setAppState(nextState);
      if (nextState === "active") {
        void consumeNotificationAction().catch(() => undefined);
        void refreshPhoneControl().catch(() => undefined);
      }
    });
    const netInfoSubscription = NetInfo.addEventListener((state) => {
      backgroundCoordinatorRef.current.setNetworkReachable(
        state.isInternetReachable ?? state.isConnected
      );
    });
    return () => {
      appStateSubscription.remove();
      netInfoSubscription();
      agentStatus.close();
      void liveUpdates.stop();
    };
  }, [consumeNotificationAction, refreshPhoneControl]);

  useEffect(() => {
    void consumeNotificationAction().catch(() => undefined);
    void refreshPhoneControl().catch(() => undefined);
  }, [consumeNotificationAction, refreshPhoneControl]);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={themeTokens["--bg-main"]}
      />
      <SafeAreaView style={{ flex: 1 }} testID="cesium-mobile-root">
        <ServerConnectionsProvider>
          <GlobalSettingsProvider>
            <NativeAuthProvider>
              <NativeWorkspaceProvider>
                <NativeWorkbench
                  connectionState={connectionState}
                  mobileControl={mobileControl}
                  notificationConversationId={notificationConversationId}
                  onFocusedConversationChange={configureAgentSocket}
                  onServerBaseUrlChange={setServerUrl}
                />
              </NativeWorkspaceProvider>
            </NativeAuthProvider>
          </GlobalSettingsProvider>
        </ServerConnectionsProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
