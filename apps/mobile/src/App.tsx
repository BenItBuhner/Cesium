import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Dimensions,
  PermissionsAndroid,
  Platform,
  StatusBar,
  StyleSheet,
  View,
  useColorScheme,
  type AppStateStatus,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { WebView as WebViewType } from "react-native-webview";
import {
  buildMobileBootstrapScript,
  encodeMobileBridgeMessage,
  parseMobileBridgeMessage,
  type MobileNativeToWebMessage,
  type MobileWebToNativeMessage,
} from "../../../src/lib/mobile-bridge";
import type { MobileAgentProjection } from "../../../src/lib/mobile-agent-projection";
import { readLaunchUrlConfig } from "./config";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import { CesiumWindowInsets } from "./native/CesiumWindowInsets";
import { AgentStatusService } from "./services/AgentStatusService";
import { BackgroundCoordinator } from "./services/BackgroundCoordinator";
import { LiveUpdateController } from "./services/LiveUpdateController";

export default function App() {
  const initialConfig = useMemo(() => readLaunchUrlConfig(), []);
  const systemColorScheme = useColorScheme();
  const [safeAreaTop, setSafeAreaTop] = useState(0);
  const [webUrl, setWebUrl] = useState(initialConfig.webUrl ?? "");
  const [serverUrl, setServerUrl] = useState(initialConfig.serverUrl);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [focused, setFocused] = useState<{
    workspaceId: string | null;
    conversationId: string | null;
  }>({ workspaceId: null, conversationId: null });
  const webViewRef = useRef<WebViewType>(null);
  const liveUpdatesRef = useRef(new LiveUpdateController());
  const agentStatusRef = useRef(
    new AgentStatusService({
      onProjection: (projection) => {
        void liveUpdatesRef.current.update(projection);
        sendToWebRef.current?.({
          type: "resumeCatchUp",
          workspaceId: projection?.workspaceId,
          conversationId: projection?.conversationId,
          lastEventSeq: projection?.lastEventSeq,
        });
      },
    })
  );
  const backgroundCoordinatorRef = useRef(
    new BackgroundCoordinator(agentStatusRef.current, liveUpdatesRef.current)
  );
  const sendToWebRef = useRef<((message: MobileNativeToWebMessage) => void) | null>(null);

  const sendToWeb = useCallback((message: MobileNativeToWebMessage) => {
    webViewRef.current?.postMessage(encodeMobileBridgeMessage(message));
  }, []);
  sendToWebRef.current = sendToWeb;

  const refreshSafeAreaTop = useCallback(() => {
    if (Platform.OS !== "android") {
      setSafeAreaTop(0);
      return;
    }
    void CesiumWindowInsets.getInsets()
      .then((insets) => {
        const nextSafeAreaTop = insets.safeAreaTop;
        setSafeAreaTop((current) => (current === nextSafeAreaTop ? current : nextSafeAreaTop));
      })
      .catch(() => {
        setSafeAreaTop((current) => (current === 0 ? current : 0));
      });
  }, []);

  const bootstrapScript = useMemo(
    () =>
      buildMobileBootstrapScript({
        baseUrl: serverUrl,
        label: "This device",
        authToken,
        safeAreaTop,
        systemColorScheme,
      }),
    [authToken, safeAreaTop, serverUrl, systemColorScheme]
  );

  const configureAgentSocket = useCallback(
    (nextFocused = focused, nextAuthToken = authToken) => {
      agentStatusRef.current.updateConfig({
        serverBaseUrl: serverUrl,
        workspaceId: nextFocused.workspaceId,
        conversationId: nextFocused.conversationId,
        authToken: nextAuthToken,
      });
    },
    [authToken, focused, serverUrl]
  );

  useEffect(() => {
    configureAgentSocket();
  }, [configureAgentSocket]);

  useEffect(() => {
    refreshSafeAreaTop();
    const dimensionsSubscription = Dimensions.addEventListener("change", refreshSafeAreaTop);
    const timers = [
      setTimeout(refreshSafeAreaTop, 0),
      setTimeout(refreshSafeAreaTop, 250),
      setTimeout(refreshSafeAreaTop, 1000),
    ];
    return () => {
      dimensionsSubscription.remove();
      timers.forEach(clearTimeout);
    };
  }, [refreshSafeAreaTop]);

  useEffect(() => {
    webViewRef.current?.injectJavaScript(bootstrapScript);
  }, [bootstrapScript]);

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
        refreshSafeAreaTop();
      }
      sendToWeb({ type: "lifecycle", state: toMobileLifecycleState(nextState) });
    });
    const netInfoSubscription = NetInfo.addEventListener((state) => {
      backgroundCoordinatorRef.current.setNetworkReachable(state.isInternetReachable ?? state.isConnected);
    });
    return () => {
      appStateSubscription.remove();
      netInfoSubscription();
      agentStatus.close();
      void liveUpdates.stop();
    };
  }, [refreshSafeAreaTop, sendToWeb]);

  useEffect(() => {
    void CesiumLiveUpdates.consumeInitialNotificationAction().then((action) => {
      if (!action.actionId) return;
      sendToWeb({
        type: "notificationAction",
        actionId: action.actionId,
        workspaceId: action.workspaceId,
        conversationId: action.conversationId,
      });
    });
  }, [sendToWeb]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseMobileBridgeMessage<MobileWebToNativeMessage>(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "webReady") {
        const nextFocused = {
          workspaceId: message.workspaceId,
          conversationId: message.focusedConversationId,
        };
        setAuthToken(message.authToken ?? null);
        setFocused(nextFocused);
        configureAgentSocket(nextFocused, message.authToken ?? null);
        return;
      }
      if (message.type === "serverConfigured") {
        setServerUrl(message.server.baseUrl);
        return;
      }
      if (message.type === "focusedConversationChanged") {
        const nextFocused = {
          workspaceId: message.workspaceId,
          conversationId: message.conversationId,
        };
        setFocused(nextFocused);
        configureAgentSocket(nextFocused);
        return;
      }
      if (message.type === "agentProjection") {
        const projection = message.projection as MobileAgentProjection;
        void liveUpdatesRef.current.update(projection);
      }
    },
    [configureAgentSocket]
  );

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <WebView
        ref={webViewRef}
        testID="cesium-mobile-webview"
        source={{ uri: webUrl }}
        originWhitelist={["*"]}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        injectedJavaScriptBeforeContentLoaded={bootstrapScript}
        injectedJavaScript={bootstrapScript}
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(bootstrapScript);
        }}
        onMessage={handleMessage}
        onError={() => setWebUrl(initialConfig.webUrl ?? webUrl)}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#191919",
  },
  webview: {
    flex: 1,
    backgroundColor: "#191919",
  },
});

function toMobileLifecycleState(state: AppStateStatus) {
  return state === "active" || state === "background" || state === "inactive"
    ? state
    : "background";
}
