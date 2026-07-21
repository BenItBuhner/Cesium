import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Dimensions,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  type AppStateStatus,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";
import type { WebView as WebViewType } from "react-native-webview";
import type { MobileAgentProjection } from "@cesium/core";
import {
  buildMobileBootstrapScript,
  encodeMobileBridgeMessage,
  parseMobileBridgeMessage,
  type MobileNativeToWebMessage,
  type MobileWebToNativeMessage,
} from "../../../src/lib/mobile-bridge";
import { readLaunchUrlConfig, resolveLaunchUrlConfig } from "./config";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import { CesiumPhoneControl } from "./native/CesiumPhoneControl";
import { CesiumWearCompanion } from "./native/CesiumWearCompanion";
import { CesiumWindowInsets } from "./native/CesiumWindowInsets";
import { AgentStatusService } from "./services/AgentStatusService";
import { BackgroundCoordinator } from "./services/BackgroundCoordinator";
import { LiveUpdateController } from "./services/LiveUpdateController";

const INITIAL_CONFIG = readLaunchUrlConfig();
// react-native-webview 14.0.1 accidentally defaults its public class generic to
// `undefined`, which makes JSX props resolve to `never` under TypeScript 5.9.
// Runtime exports are correct; keep the workaround local until upstream fixes
// the declaration.
const AndroidWebView = WebView as unknown as React.ComponentType<any>;

export default function App() {
  const systemColorScheme = useColorScheme();
  const [safeAreaTop, setSafeAreaTop] = useState(0);
  const [webUrl, setWebUrl] = useState(INITIAL_CONFIG.webUrl);
  const [serverUrl, setServerUrl] = useState(INITIAL_CONFIG.serverUrl);
  const [runtime, setRuntime] = useState(INITIAL_CONFIG.runtime);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [focused, setFocused] = useState<{
    workspaceId: string | null;
    conversationId: string | null;
  }>({ workspaceId: null, conversationId: null });
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const webViewRef = useRef<WebViewType>(null);
  const serverUrlRef = useRef(serverUrl);
  const authTokenRef = useRef(authToken);
  const liveUpdatesRef = useRef(new LiveUpdateController());
  const sendToWebRef = useRef<((message: MobileNativeToWebMessage) => void) | null>(null);
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

  const sendToWeb = useCallback((message: MobileNativeToWebMessage) => {
    webViewRef.current?.postMessage(encodeMobileBridgeMessage(message));
  }, []);
  sendToWebRef.current = sendToWeb;

  const bootstrapScript = useMemo(
    () =>
      `${buildWebErrorBridgeScript()}\n${buildMobileBootstrapScript({
        baseUrl: serverUrl,
        label: "This phone",
        authToken,
        safeAreaTop,
        systemColorScheme:
          systemColorScheme === "light" || systemColorScheme === "dark"
            ? systemColorScheme
            : null,
        runtime,
      })}`,
    [authToken, runtime, safeAreaTop, serverUrl, systemColorScheme]
  );

  const configureNativeServices = useCallback(
    (
      nextFocused = focused,
      nextAuthToken = authTokenRef.current,
      nextServerUrl = serverUrlRef.current
    ) => {
      agentStatusRef.current.updateConfig({
        serverBaseUrl: nextServerUrl,
        workspaceId: nextFocused.workspaceId,
        conversationId: nextFocused.conversationId,
        authToken: nextAuthToken,
      });
      void CesiumPhoneControl.configure({
        serverUrl: nextServerUrl,
        workspaceId: nextFocused.workspaceId,
        authToken: nextAuthToken,
        backendId: "cesium-agent",
        mode: "agent",
      }).catch(() => undefined);
    },
    [focused]
  );

  const refreshSafeArea = useCallback(() => {
    void CesiumWindowInsets.getInsets()
      .then((insets) => setSafeAreaTop(insets.safeAreaTop))
      .catch(() => setSafeAreaTop(0));
  }, []);

  const consumeNotificationAction = useCallback(async () => {
    const action = await CesiumLiveUpdates.consumeInitialNotificationAction();
    if (!action.actionId) return;
    sendToWeb({
      type: "notificationAction",
      actionId: action.actionId,
      workspaceId: action.workspaceId,
      conversationId: action.conversationId,
    });
  }, [sendToWeb]);

  useEffect(() => {
    serverUrlRef.current = serverUrl;
  }, [serverUrl]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;
    void resolveLaunchUrlConfig().then((next) => {
      if (cancelled) return;
      setRuntime(next.runtime);
      setServerUrl((current) =>
        current === INITIAL_CONFIG.serverUrl ? next.serverUrl : current
      );
      setWebUrl((current) => current || next.webUrl);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    refreshSafeArea();
    const dimensions = Dimensions.addEventListener("change", refreshSafeArea);
    const timers = [0, 250, 1000].map((delay) => setTimeout(refreshSafeArea, delay));
    return () => {
      dimensions.remove();
      timers.forEach(clearTimeout);
    };
  }, [refreshSafeArea]);

  useEffect(() => {
    webViewRef.current?.injectJavaScript(bootstrapScript);
  }, [bootstrapScript]);

  useEffect(() => {
    if (Platform.OS === "android") {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
        () => undefined
      );
    }
    const appState = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      backgroundCoordinatorRef.current.setAppState(nextState);
      sendToWeb({ type: "lifecycle", state: toMobileLifecycleState(nextState) });
      if (nextState === "active") {
        refreshSafeArea();
        void consumeNotificationAction();
      }
    });
    const network = NetInfo.addEventListener((state) => {
      backgroundCoordinatorRef.current.setNetworkReachable(
        state.isInternetReachable ?? state.isConnected
      );
    });
    return () => {
      appState.remove();
      network();
      agentStatusRef.current.close();
      void liveUpdatesRef.current.stop();
    };
  }, [consumeNotificationAction, refreshSafeArea, sendToWeb]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack) return false;
      webViewRef.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [canGoBack]);

  useEffect(() => {
    void consumeNotificationAction();
  }, [consumeNotificationAction]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseMobileBridgeMessage<MobileWebToNativeMessage>(
        event.nativeEvent.data
      );
      if (!message) return;
      if (message.type === "webRuntimeError") {
        setLoadError(message.message);
        return;
      }
      if (message.type === "webReady") {
        const nextFocused = {
          workspaceId: message.workspaceId,
          conversationId: message.focusedConversationId,
        };
        const nextToken = message.authToken ?? null;
        setAuthToken(nextToken);
        setFocused(nextFocused);
        configureNativeServices(nextFocused, nextToken);
        return;
      }
      if (message.type === "serverConfigured") {
        const nextServerUrl = message.server.baseUrl;
        const nextToken = message.server.authToken ?? authTokenRef.current;
        setServerUrl(nextServerUrl);
        setAuthToken(nextToken);
        configureNativeServices(focused, nextToken, nextServerUrl);
        return;
      }
      if (message.type === "focusedConversationChanged") {
        const nextFocused = {
          workspaceId: message.workspaceId,
          conversationId: message.conversationId,
        };
        setFocused(nextFocused);
        configureNativeServices(nextFocused);
        return;
      }
      if (message.type === "agentProjection") {
        void liveUpdatesRef.current.update(message.projection as MobileAgentProjection);
        return;
      }
      if (message.type === "wearSyncEnvelope") {
        void CesiumWearCompanion.publishEnvelope(
          message.envelopeJson,
          message.config
        ).catch(() => undefined);
      }
    },
    [configureNativeServices, focused]
  );

  const handleNavigation = useCallback((navigation: WebViewNavigation) => {
    setCanGoBack(navigation.canGoBack);
  }, []);

  return (
    <View style={styles.root} testID="cesium-mobile-root">
      <StatusBar
        barStyle={systemColorScheme === "light" ? "dark-content" : "light-content"}
        backgroundColor="transparent"
        translucent
      />
      <AndroidWebView
        key={reloadKey}
        ref={webViewRef}
        testID="cesium-mobile-webview"
        source={{ uri: webUrl }}
        originWhitelist={["*"]}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        injectedJavaScriptBeforeContentLoaded={bootstrapScript}
        injectedJavaScript={bootstrapScript}
        onLoadEnd={() => {
          setLoadError(null);
          webViewRef.current?.injectJavaScript(bootstrapScript);
        }}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigation}
        onError={(event: { nativeEvent: { description: string } }) =>
          setLoadError(event.nativeEvent.description)
        }
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={false}
        webviewDebuggingEnabled
        style={styles.webview}
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color="#ffffff" />
          </View>
        )}
        startInLoadingState
      />
      {loadError ? (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Cesium could not load</Text>
          <Text style={styles.errorBody}>{loadError}</Text>
          <Pressable
            onPress={() => {
              setLoadError(null);
              setReloadKey((current) => current + 1);
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function toMobileLifecycleState(state: AppStateStatus) {
  return state === "active" || state === "background" || state === "inactive"
    ? state
    : "background";
}

function buildWebErrorBridgeScript() {
  return `
(() => {
  if (window.__CESIUM_MOBILE_ERROR_BRIDGE__) return true;
  window.__CESIUM_MOBILE_ERROR_BRIDGE__ = true;
  const send = (message, source, line) => {
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({
        type: "webRuntimeError",
        message: String(message || "Unknown web runtime error"),
        source: source || undefined,
        line: Number.isFinite(line) ? line : undefined
      }));
    } catch {}
  };
  window.addEventListener("error", (event) => {
    send(event.message || event.error?.message, event.filename, event.lineno);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send(event.reason?.message || event.reason);
  });
  true;
})();`;
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
  loading: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    alignItems: "center",
    backgroundColor: "#191919",
    justifyContent: "center",
  },
  error: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    alignItems: "center",
    backgroundColor: "#191919",
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "600",
  },
  errorBody: {
    color: "#a3a3a3",
    fontSize: 13,
    textAlign: "center",
  },
  retry: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: {
    color: "#191919",
    fontSize: 14,
    fontWeight: "600",
  },
});
