import { getTokens } from "@cesium/design";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { getCesiumServerUrl, getCesiumWebUrl } from "./web-url";

type ShellStatus = "loading" | "ready" | "offline";

export function CesiumMobileShell() {
  const webViewRef = useRef<WebView>(null);
  const [status, setStatus] = useState<ShellStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const tokens = getTokens(scheme);
  const styles = useMemo(() => createStyles(tokens), [tokens]);
  const webUrl = useMemo(() => getCesiumWebUrl(), []);
  const serverUrl = useMemo(() => getCesiumServerUrl(), []);
  const webOrigin = useMemo(() => safeOrigin(webUrl), [webUrl]);
  const bridgeScript = useMemo(
    () => createBridgeScript({ platform: Platform.OS, serverUrl, webUrl }),
    [serverUrl, webUrl]
  );

  useEffect(() => {
    if (status !== "loading") {
      return;
    }
    const timer = setTimeout(() => {
      setStatus("offline");
    }, 12_000);
    return () => clearTimeout(timer);
  }, [reloadKey, status]);

  function retry() {
    setStatus("loading");
    setReloadKey((key) => key + 1);
  }

  function handleNavigation(request: WebViewNavigation) {
    if (request.url.startsWith("about:blank")) {
      return true;
    }

    if (request.url.startsWith("blob:") || request.url.startsWith("data:")) {
      return true;
    }

    const nextOrigin = safeOrigin(request.url);
    if (!webOrigin || nextOrigin === webOrigin) {
      return true;
    }

    void Linking.openURL(request.url);
    return false;
  }

  return (
    <View style={styles.root}>
      <WebView
        key={reloadKey}
        ref={webViewRef}
        source={{ uri: webUrl }}
        style={styles.webview}
        containerStyle={styles.webviewContainer}
        originWhitelist={["*"]}
        applicationNameForUserAgent="CesiumMobile/0.1"
        injectedJavaScriptBeforeContentLoaded={bridgeScript}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        setSupportMultipleWindows={false}
        onLoadStart={() => setStatus("loading")}
        onLoadEnd={() => setStatus("ready")}
        onError={() => setStatus("offline")}
        onHttpError={(event) => {
          if (
            event.nativeEvent.url === webUrl &&
            event.nativeEvent.statusCode >= 400
          ) {
            setStatus("offline");
          }
        }}
        onShouldStartLoadWithRequest={handleNavigation}
      />

      {status === "loading" ? (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <ActivityIndicator color={tokens.color.textSecondary} />
        </View>
      ) : null}

      {status === "offline" ? (
        <View style={styles.fallback}>
          <Text style={styles.title}>Cesium is not reachable</Text>
          <Text style={styles.body}>Web: {webUrl}</Text>
          <Text style={styles.body}>Server: {serverUrl}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={retry}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void Linking.openURL(webUrl)}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Open URL</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function createBridgeScript(input: {
  platform: string;
  serverUrl: string;
  webUrl: string;
}) {
  const bridge = JSON.stringify({
    platform: input.platform,
    serverBaseUrl: input.serverUrl,
    source: "react-native-webview",
    webBaseUrl: input.webUrl,
  });
  const platform = JSON.stringify(input.platform);

  return `
(() => {
  window.__CESIUM_NATIVE_SHELL__ = ${bridge};
  const applyAttributes = () => {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-cesium-native-shell", "true");
    root.setAttribute("data-cesium-platform", ${platform});
  };
  applyAttributes();
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded", applyAttributes, { once: true });
  }
  true;
})();
`;
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function createStyles(tokens: ReturnType<typeof getTokens>) {
  const radius = Number.parseFloat(tokens.radius.card);

  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: tokens.color.bgMain,
    },
    webview: {
      flex: 1,
      backgroundColor: tokens.color.bgMain,
    },
    webviewContainer: {
      flex: 1,
      backgroundColor: tokens.color.bgMain,
    },
    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      backgroundColor: tokens.color.bgMain,
      justifyContent: "center",
    },
    fallback: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "stretch",
      backgroundColor: tokens.color.bgMain,
      gap: 14,
      justifyContent: "center",
      paddingHorizontal: 28,
    },
    title: {
      color: tokens.color.textPrimary,
      fontSize: 18,
      fontWeight: "600",
      lineHeight: 24,
      textAlign: "center",
    },
    body: {
      color: tokens.color.textSecondary,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    actions: {
      flexDirection: "row",
      gap: 10,
      justifyContent: "center",
      marginTop: 6,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: tokens.color.textPrimary,
      borderRadius: radius,
      minWidth: 96,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    primaryButtonText: {
      color: tokens.color.bgMain,
      fontSize: 13,
      fontWeight: "600",
    },
    secondaryButton: {
      alignItems: "center",
      backgroundColor: tokens.color.bgCard,
      borderColor: tokens.color.borderCard,
      borderRadius: radius,
      borderWidth: StyleSheet.hairlineWidth,
      minWidth: 96,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    secondaryButtonText: {
      color: tokens.color.textPrimary,
      fontSize: 13,
      fontWeight: "600",
    },
    buttonPressed: {
      opacity: 0.78,
    },
  });
}
