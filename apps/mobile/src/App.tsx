import "../global.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  PermissionsAndroid,
  Platform,
  StatusBar,
  Text,
  View,
  type AppStateStatus,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { readLaunchUrlConfig, resolveLaunchUrlConfig } from "./config";
import { installReactNativeClientPlatform, setRuntimeServerBaseUrl } from "./platform";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import { AgentStatusService } from "./services/AgentStatusService";
import { BackgroundCoordinator } from "./services/BackgroundCoordinator";
import { LiveUpdateController } from "./services/LiveUpdateController";

installReactNativeClientPlatform();

type ConnectionState = "idle" | "connecting" | "open" | "closed" | "reconnecting";

export default function App() {
  const initialConfig = useMemo(() => readLaunchUrlConfig(), []);
  const [serverUrl, setServerUrl] = useState(initialConfig.serverUrl);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
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

  useEffect(() => {
    setRuntimeServerBaseUrl(serverUrl);
  }, [serverUrl]);

  // Focused workspace/conversation wiring arrives with the native workbench
  // UI; until then the status socket stays idle unless a conversation focuses.
  const configureAgentSocket = useCallback(
    (workspaceId: string | null = null, conversationId: string | null = null) => {
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
    configureAgentSocket();
  }, [configureAgentSocket]);

  useEffect(() => {
    let cancelled = false;
    void resolveLaunchUrlConfig().then((nextConfig) => {
      if (cancelled) {
        return;
      }
      setServerUrl((current) =>
        current === initialConfig.serverUrl ? nextConfig.serverUrl : current
      );
    });
    return () => {
      cancelled = true;
    };
  }, [initialConfig.serverUrl]);

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
    // Consume any cold-start notification action so it is not replayed; the
    // native workbench UI will route these to the right conversation.
    void CesiumLiveUpdates.consumeInitialNotificationAction().catch(() => undefined);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <SafeAreaView className="flex-1 bg-bg-main" testID="cesium-mobile-root">
        <View className="flex-1 items-center justify-center gap-2 px-6">
          <Text className="text-text-primary text-2xl font-semibold">Cesium</Text>
          <Text className="text-text-secondary text-sm text-center">
            Native workbench shell — server {serverUrl}
          </Text>
          <Text className="text-text-disabled text-xs">
            agent socket: {connectionState}
          </Text>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
