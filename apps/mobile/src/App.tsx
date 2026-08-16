import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Dimensions,
  Linking,
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
  type WebViewProps,
} from "react-native-webview";
import type { WebView as WebViewType } from "react-native-webview";
import {
  buildMobileBootstrapScript,
  encodeMobileBridgeMessage,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  parseMobileBridgeMessage,
  type MobileAgentProjection,
  type MobileNativeToWebMessage,
  type MobileNativeStatus,
  type MobileServerConfig,
  type MobileWebToNativeMessage,
} from "@cesium/core";
import { readLaunchUrlConfig, resolveLaunchUrlConfig } from "./config";
import { CesiumLiveUpdates } from "./native/CesiumLiveUpdates";
import {
  CesiumPredictiveBack,
  type PredictiveBackGestureEvent,
} from "./native/CesiumPredictiveBack";
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
const AndroidWebView = WebView as unknown as React.ComponentType<
  WebViewProps & React.RefAttributes<WebViewType>
>;

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
    activeConversationIds: string[];
  }>({ workspaceId: null, conversationId: null, activeConversationIds: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [webViewAvailable, setWebViewAvailable] = useState(true);
  const webViewRef = useRef<WebViewType>(null);
  // Refs so the single hardware-back subscription can read the freshest
  // navigation state without re-subscribing on every WebView update.
  const canGoBackRef = useRef(false);
  const webCanHandleBackRef = useRef(false);
  const serverUrlRef = useRef(serverUrl);
  const authTokenRef = useRef(authToken);
  const liveUpdatesRef = useRef(new LiveUpdateController(CesiumLiveUpdates));
  const webSendsProjectionSetsRef = useRef(false);
  const sendToWebRef = useRef<((message: MobileNativeToWebMessage) => void) | null>(null);
  const agentStatusRef = useRef(
    new AgentStatusService({
      onProjection: (projection) => {
        void liveUpdatesRef.current.update(projection);
        sendToWebRef.current?.({
          type: "resumeCatchUp",
          workspaceId: projection.workspaceId,
          conversationId: projection.conversationId,
          lastEventSeq: projection.lastEventSeq,
        });
      },
      onConversationRemoved: (conversationId) => {
        void liveUpdatesRef.current.removeConversation(conversationId);
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

  // Keep the native predictive-back intercept armed exactly while the app has
  // something to pop in-app (an in-WebView layer or WebView history). The
  // Android dispatcher decides at gesture START who owns the gesture, so this
  // must be pushed proactively on every capability/history change — it cannot
  // be resolved lazily at commit time.
  const syncBackIntercept = useCallback(() => {
    CesiumPredictiveBack.setBackInterceptEnabled(
      webViewRef.current != null &&
        (webCanHandleBackRef.current || canGoBackRef.current)
    );
  }, []);

  // The current host config: embedded once into the pre-load bootstrap
  // (Electron preload analog) and streamed to the live page as
  // `nativeConfigChanged` messages whenever it changes afterwards. The crash
  // reporter that used to be a separate injected script lives inside the
  // bootstrap now.
  const hostServerConfig = useMemo<MobileServerConfig>(
    () => ({
      baseUrl: serverUrl,
      label: "This phone",
      authToken,
      safeAreaTop,
      systemColorScheme:
        systemColorScheme === "light" || systemColorScheme === "dark"
          ? systemColorScheme
          : null,
      runtime,
    }),
    [authToken, runtime, safeAreaTop, serverUrl, systemColorScheme]
  );
  const bootstrapScript = useMemo(
    () => buildMobileBootstrapScript(hostServerConfig),
    [hostServerConfig]
  );

  const lastPhoneControlConfigRef = useRef<string | null>(null);
  const configureNativeServices = useCallback(
    (
      nextFocused = focused,
      nextAuthToken = authTokenRef.current,
      nextServerUrl = serverUrlRef.current
    ) => {
      const conversationIds = [
        ...new Set(
          [nextFocused.conversationId, ...nextFocused.activeConversationIds].filter(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        ),
      ];
      agentStatusRef.current.updateConfig({
        serverBaseUrl: nextServerUrl,
        workspaceId: nextFocused.workspaceId,
        conversationIds,
        authToken: nextAuthToken,
      });
      // Phone control does not care about the focused conversation, and a null
      // workspace (web still booting) must not clobber the stored one — each
      // configure() restarts the native service, aborting in-flight
      // registrations and flapping the "Reconnecting…" notification.
      if (!nextFocused.workspaceId) {
        return;
      }
      const phoneControlConfig = {
        serverUrl: nextServerUrl,
        workspaceId: nextFocused.workspaceId,
        authToken: nextAuthToken,
        backendId: "cesium-agent",
        mode: "agent",
      };
      const phoneControlKey = JSON.stringify(phoneControlConfig);
      if (phoneControlKey === lastPhoneControlConfigRef.current) {
        return;
      }
      lastPhoneControlConfigRef.current = phoneControlKey;
      void CesiumPhoneControl.configure(phoneControlConfig).catch(() => {
        // Allow a retry with the same config after a native failure.
        lastPhoneControlConfigRef.current = null;
      });
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

  const sendNativeStatus = useCallback(async () => {
    const [liveUpdates, phoneControl] = await Promise.all([
      CesiumLiveUpdates.getPromotionStatus(),
      CesiumPhoneControl.getStatus().catch(() => null),
    ]);
    const status: MobileNativeStatus = {
      liveUpdates: {
        preference: liveUpdates.deliveryPreference,
        sdkInt: liveUpdates.sdkInt,
        progressStyleSupported: liveUpdates.progressStyleSupported,
        canPostPromotedNotifications: liveUpdates.canPostPromotedNotifications,
        notificationPermissionGranted: liveUpdates.notificationPermissionGranted,
        isSamsung: liveUpdates.isSamsung,
        promotionRenderSupported: liveUpdates.promotionRenderSupported,
        hasPromotableCharacteristics: liveUpdates.hasPromotableCharacteristics,
        promotedNotificationPosted: liveUpdates.promotedNotificationPosted,
      },
      phoneControl,
    };
    sendToWeb({ type: "mobileNativeStatus", status });
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

  // Dynamic host state reaches the live page as a typed message instead of
  // re-injecting the whole bootstrap script. The very first render is covered
  // by the pre-load bootstrap itself; a message posted before the page's
  // relay listener exists is simply dropped, which is fine because that page
  // boots with the same config embedded.
  useEffect(() => {
    sendToWeb({ type: "nativeConfigChanged", server: hostServerConfig });
  }, [hostServerConfig, sendToWeb]);

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
    // A single, stable subscription. The Android back intent is resolved in
    // priority order:
    //   1. If the web layer reports an open in-WebView layer (overlay, drawer,
    //      settings view), route the intent there. The web replies with
    //      `backFallback` if it turns out there is nothing to pop.
    //   2. Otherwise walk the WebView's own navigation history.
    //   3. Otherwise let Android run its default back behavior (exit the app),
    //      which is where the predictive-back exit animation applies.
    const routeBackIntent = () => {
      if (webViewRef.current && webCanHandleBackRef.current) {
        sendToWeb({ type: "backRequest" });
        return true;
      }
      if (webViewRef.current && canGoBackRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };

    // Legacy/discrete path: 3-button navigation, pre-Android-14 devices, and
    // any gesture that lands while the progressive intercept is disarmed.
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      routeBackIntent
    );

    // Progressive path: while the native intercept is armed, MainActivity's
    // OnBackPressedCallback streams the gesture here (per-frame progress on
    // Android 14+). Started/progressed/cancelled are forwarded to the web
    // layer so the top-most in-WebView layer can track the finger; `invoked`
    // is the commit and routes exactly like a discrete back press.
    const toBridgeGesture = (payload: PredictiveBackGestureEvent) => ({
      progress: Math.min(1, Math.max(0, payload.progress ?? 0)),
      swipeEdge: (payload.swipeEdge === 1 ? "right" : "left") as "left" | "right",
      touchX: payload.touchX,
      touchY: payload.touchY,
    });
    const predictiveSubscriptions = [
      CesiumPredictiveBack.addListener("started", (payload) => {
        sendToWeb({ type: "backStarted", ...toBridgeGesture(payload) });
      }),
      CesiumPredictiveBack.addListener("progressed", (payload) => {
        sendToWeb({ type: "backProgressed", ...toBridgeGesture(payload) });
      }),
      CesiumPredictiveBack.addListener("cancelled", () => {
        sendToWeb({ type: "backCancelled" });
      }),
      CesiumPredictiveBack.addListener("invoked", () => {
        // Native auto-disarmed itself before emitting; the web republishes
        // its capability after popping, which re-arms via syncBackIntercept.
        if (!routeBackIntent()) {
          BackHandler.exitApp();
        }
      }),
    ];

    return () => {
      subscription.remove();
      for (const predictiveSubscription of predictiveSubscriptions) {
        predictiveSubscription?.remove();
      }
    };
  }, [sendToWeb]);

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
        // The canonical workbench owns its own error boundaries and reconnect
        // behavior. Unhandled API timeouts are reported here by the diagnostic
        // bridge too, but they must not replace the entire app with a native
        // fatal screen. Native loading errors and renderer termination are
        // handled by onError/onRenderProcessGone below.
        console.warn(
          "[Cesium WebView]",
          message.message,
          message.source ?? "",
          message.line ?? ""
        );
        return;
      }
      if (message.type === "webReady") {
        if (
          message.protocolVersion != null &&
          message.protocolVersion !== MOBILE_BRIDGE_PROTOCOL_VERSION
        ) {
          console.warn(
            `[Cesium bridge] Protocol mismatch: web ${message.protocolVersion}, native ${MOBILE_BRIDGE_PROTOCOL_VERSION}. Rebuild the workbench assets and the APK together.`
          );
        }
        const nextFocused = {
          workspaceId: message.workspaceId,
          conversationId: message.focusedConversationId,
          activeConversationIds: focused.activeConversationIds,
        };
        const nextToken = message.authToken ?? null;
        setAuthToken(nextToken);
        setFocused(nextFocused);
        configureNativeServices(nextFocused, nextToken);
        void sendNativeStatus();
        return;
      }
      if (message.type === "getMobileNativeStatus") {
        void sendNativeStatus();
        return;
      }
      if (message.type === "setLiveUpdatePreference") {
        void CesiumLiveUpdates.setDeliveryPreference(message.preference).then(() =>
          sendNativeStatus()
        );
        return;
      }
      if (message.type === "openLiveUpdatePromotionSettings") {
        void CesiumLiveUpdates.openPromotionSettings().then(() => sendNativeStatus());
        return;
      }
      if (message.type === "openNowBarSettings") {
        void CesiumLiveUpdates.openNowBarSettings().then(() => sendNativeStatus());
        return;
      }
      if (message.type === "setPhoneControlEnabled") {
        void CesiumPhoneControl.setEnabled(message.enabled).then(() => sendNativeStatus());
        return;
      }
      if (message.type === "openPhoneAccessibilitySettings") {
        void CesiumPhoneControl.openAccessibilitySettings();
        return;
      }
      if (message.type === "requestPhoneAssistantRole") {
        void CesiumPhoneControl.requestAssistantRole().then(() => sendNativeStatus());
        return;
      }
      if (message.type === "invokePhoneAssistant") {
        void CesiumPhoneControl.invokeAssistant();
        return;
      }
      if (message.type === "backCapability") {
        webCanHandleBackRef.current = message.canHandleBack;
        syncBackIntercept();
        return;
      }
      if (message.type === "backFallback") {
        // The web layer had nothing to pop after all; run the native default.
        if (canGoBackRef.current) {
          webViewRef.current?.goBack();
        } else {
          // Disarm before exiting so the dispatcher walk triggered by exitApp
          // can never re-enter the predictive intercept.
          CesiumPredictiveBack.setBackInterceptEnabled(false);
          BackHandler.exitApp();
        }
        return;
      }
      if (message.type === "openExternalUrl") {
        // Open outside the WebView so the workbench (a file:// bundle) is not
        // navigated away, e.g. the F-Droid page for the Termux server setup.
        if (/^https?:\/\//i.test(message.url)) {
          void Linking.openURL(message.url).catch(() => undefined);
        }
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
          activeConversationIds:
            message.activeConversationIds ?? focused.activeConversationIds,
        };
        setFocused(nextFocused);
        configureNativeServices(nextFocused);
        return;
      }
      if (message.type === "agentProjections") {
        webSendsProjectionSetsRef.current = true;
        void liveUpdatesRef.current.updateAll(
          message.projections as MobileAgentProjection[]
        );
        return;
      }
      // Legacy single-projection message from older web bundles. Ignored once
      // the web sends full sets — mixing both would track the same run twice.
      if (message.type === "agentProjection") {
        if (!webSendsProjectionSetsRef.current) {
          void liveUpdatesRef.current.update(message.projection as MobileAgentProjection);
        }
        return;
      }
      if (message.type === "wearSyncEnvelope") {
        void CesiumWearCompanion.publishEnvelope(
          message.envelopeJson,
          message.config
        ).catch(() => undefined);
      }
    },
    [configureNativeServices, focused, sendNativeStatus, syncBackIntercept]
  );

  const handleNavigation = useCallback(
    (navigation: WebViewNavigation) => {
      canGoBackRef.current = navigation.canGoBack;
      syncBackIntercept();
    },
    [syncBackIntercept]
  );

  return (
    <View style={styles.root} testID="cesium-mobile-root">
      <StatusBar
        barStyle={systemColorScheme === "light" ? "dark-content" : "light-content"}
        backgroundColor="transparent"
        translucent
      />
      {webViewAvailable ? (
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
          onLoadEnd={() => {
            setLoadError(null);
          }}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigation}
          onError={(event: {
            nativeEvent: { description: string; code?: number; url?: string };
          }) => {
            setLoadError(event.nativeEvent.description);
          }}
          onRenderProcessGone={(event: {
            nativeEvent: { didCrash: boolean; url?: string };
          }) => {
            const description = event.nativeEvent.didCrash
              ? "Android System WebView crashed. The failed renderer was discarded. Update Android System WebView and, on an emulator, enable hardware acceleration before retrying."
              : "Android stopped the WebView renderer to reclaim resources. The failed renderer was discarded; retry to create a fresh one.";
            webViewRef.current = null;
            canGoBackRef.current = false;
            webCanHandleBackRef.current = false;
            syncBackIntercept();
            setWebViewAvailable(false);
            setLoadError(description);
          }}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          setSupportMultipleWindows={false}
          mediaPlaybackRequiresUserAction={false}
          style={styles.webview}
        />
      ) : null}
      {loadError ? (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Cesium could not load</Text>
          <Text style={styles.errorBody}>{loadError}</Text>
          <Pressable
            onPress={() => {
              canGoBackRef.current = false;
              webCanHandleBackRef.current = false;
              syncBackIntercept();
              setLoadError(null);
              setReloadKey((current) => current + 1);
              setWebViewAvailable(true);
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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#191919",
  },
  webview: {
    flex: 1,
    backgroundColor: "#191919",
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
