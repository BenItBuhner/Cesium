import "../global.css";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Appearance,
  PermissionsAndroid,
  Platform,
  StatusBar,
  type AppStateStatus,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ServerConnectionsProvider } from "@cesium/client/react";
import {
  NativeAuthProvider,
  NativeWorkbench,
  NativeWorkspaceProvider,
} from "@cesium/ui-native";
import { readLaunchUrlConfig, resolveLaunchUrlConfig } from "./config";
import { installReactNativeClientPlatform, setRuntimeServerBaseUrl } from "./platform";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import { AgentStatusService } from "./services/AgentStatusService";
import { BackgroundCoordinator } from "./services/BackgroundCoordinator";
import { LiveUpdateController } from "./services/LiveUpdateController";

installReactNativeClientPlatform();
const INITIAL_CONFIG = readLaunchUrlConfig();
setRuntimeServerBaseUrl(INITIAL_CONFIG.serverUrl);

type ConnectionState = "idle" | "connecting" | "open" | "closed" | "reconnecting";

export default function App() {
  const [serverUrl, setServerUrl] = useState(INITIAL_CONFIG.serverUrl);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [notificationConversationId, setNotificationConversationId] = useState<string | null>(
    null
  );
  const liveUpdatesRef = useRef(new LiveUpdateController());
  const agentStatusRef = useRef(
    new AgentStatusService({
      onProjection: (projection) => {
        void liveUpdatesRef.current.update(projection);
      },
      onConnectionState: setConnectionState,
    })
  );
  const backgroundCoordinatorRef = useRef(
    new BackgroundCoordinator(agentStatusRef.current, liveUpdatesRef.current)
  );

  const configureAgentSocket = useCallback(
    (workspaceId: string | null, conversationId: string | null) => {
      agentStatusRef.current.updateConfig({
        serverBaseUrl: serverUrl,
        workspaceId,
        conversationId,
        authToken: null,
      });
    },
    [serverUrl]
  );

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    void CesiumLiveUpdates.consumeInitialNotificationAction()
      .then((action) => {
        if (action?.conversationId) {
          setNotificationConversationId(action.conversationId);
        }
      })
      .catch(() => undefined);
  }, []);

  const dark = Appearance.getColorScheme() === "dark";

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={dark ? "light-content" : "dark-content"}
        backgroundColor={dark ? "#191919" : "#fafafa"}
      />
      <SafeAreaView style={{ flex: 1 }} testID="cesium-mobile-root">
        <ServerConnectionsProvider>
          <NativeAuthProvider>
            <NativeWorkspaceProvider>
              <NativeWorkbench
                connectionState={connectionState}
                notificationConversationId={notificationConversationId}
                onFocusedConversationChange={configureAgentSocket}
              />
            </NativeWorkspaceProvider>
          </NativeAuthProvider>
        </ServerConnectionsProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
