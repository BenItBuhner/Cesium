"use client";

import { Check, Copy, ExternalLink, Smartphone } from "lucide-react";
import { useCallback, useState } from "react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { getStoredSessionToken } from "@/lib/auth-client";
import { openExternalUrl, postMobileBridgeMessage } from "@/lib/mobile-bridge";

const TERMUX_SERVER_URL = "http://127.0.0.1:9100";
const TERMUX_FDROID_URL = "https://f-droid.org/packages/com.termux/";
// apt (not pkg) first: Termux pkg depends on curl, and a partial openssl/curl
// upgrade leaves curl unlinkable (SSL_set_quic_tls_transport_params). Only
// apt full-upgrade can repair that state before curl can fetch the installer.
const TERMUX_INSTALL_COMMAND =
  "apt update && apt full-upgrade -y && apt install -y curl && curl -fsSL https://raw.githubusercontent.com/BenItBuhner/Cesium/main/apps/mobile/termux/install-cesium-server.sh | bash";

/**
 * True when the workbench runs inside the Cesium Android app's WebView, where
 * the Termux on-device server flow applies (Termux and the WebView share the
 * phone, so the server is reachable at plain-HTTP loopback).
 */
export function isMobileNativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.ReactNativeWebView ||
      window.cesiumMobile?.isReactNative ||
      window.__CESIUM_MOBILE_SERVER__
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Android System WebViews do not expose navigator.clipboard.
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

type SetupStatus = { kind: "info" | "ok" | "error"; text: string };

export function TermuxServerSetup({ compact = false }: { compact?: boolean }) {
  const [mobileRuntime] = useState(isMobileNativeRuntime);
  const { probeServer, saveServer, setActiveServer } = useServerConnections();
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<SetupStatus | null>(null);

  const openFDroid = useCallback(() => {
    openExternalUrl(TERMUX_FDROID_URL, { features: "noopener" });
  }, []);

  const copyCommand = useCallback(async () => {
    const copied = await copyText(TERMUX_INSTALL_COMMAND);
    setCopied(copied);
    if (copied) {
      window.setTimeout(() => setCopied(false), 1800);
    }
  }, []);

  const connect = useCallback(async () => {
    setChecking(true);
    setStatus({ kind: "info", text: "Checking the on-device server..." });
    try {
      const probe = await probeServer(TERMUX_SERVER_URL);
      if (!probe.ok) {
        setStatus({
          kind: "error",
          text:
            probe.error ||
            "The Termux server is not reachable yet. Finish the installer, then try again.",
        });
        return;
      }
      const saved = saveServer({ label: "This phone", baseUrl: TERMUX_SERVER_URL });
      setActiveServer(saved.id);
      postMobileBridgeMessage({
        type: "serverConfigured",
        server: {
          baseUrl: TERMUX_SERVER_URL,
          label: "This phone",
          authToken: getStoredSessionToken(TERMUX_SERVER_URL),
        },
      });
      setStatus({ kind: "ok", text: "Connected to the server running on this phone." });
    } catch (error) {
      setStatus({
        kind: "error",
        text: error instanceof Error ? error.message : "Server check failed.",
      });
    } finally {
      setChecking(false);
    }
  }, [probeServer, saveServer, setActiveServer]);

  if (!mobileRuntime) {
    return null;
  }

  return (
    <section
      data-testid="termux-server-setup"
      className={`rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] ${
        compact ? "p-[10px]" : "p-[12px]"
      }`}
    >
      <div className="flex items-start gap-[9px]">
        <Smartphone
          className="mt-[1px] size-[15px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.6}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            Run the server on this phone
          </h3>
          <p className="mt-[4px] font-sans text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            Termux runs the full Cesium backend locally at{" "}
            <span className="font-mono">127.0.0.1:9100</span> — no computer required.
          </p>
        </div>
      </div>

      <p className="mt-[9px] font-sans text-[11.5px] font-medium text-[var(--text-secondary)]">
        1 · Install Termux from F-Droid.
      </p>
      <button
        type="button"
        onClick={openFDroid}
        className="mt-[6px] inline-flex h-[32px] items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[11.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
      >
        <ExternalLink className="size-[13px]" strokeWidth={1.6} aria-hidden />
        Open Termux on F-Droid
      </button>

      <p className="mt-[10px] font-sans text-[11.5px] font-medium text-[var(--text-secondary)]">
        2 · Paste this in Termux. It upgrades packages first (fixes broken curl), then
        installs and starts the server.
      </p>
      <div className="mt-[6px] flex min-w-0 items-stretch gap-[7px]">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[9px] py-[8px] font-mono text-[10.5px] leading-relaxed text-[var(--text-primary)]">
          {TERMUX_INSTALL_COMMAND}
        </code>
        <button
          type="button"
          onClick={() => void copyCommand()}
          className="inline-flex w-[72px] shrink-0 items-center justify-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] font-sans text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          aria-label="Copy Termux install command"
        >
          {copied ? (
            <Check className="size-[13px]" strokeWidth={1.8} aria-hidden />
          ) : (
            <Copy className="size-[13px]" strokeWidth={1.6} aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="mt-[10px] font-sans text-[11.5px] font-medium text-[var(--text-secondary)]">
        3 · Connect Cesium when installation finishes.
      </p>
      <button
        type="button"
        disabled={checking}
        onClick={() => void connect()}
        data-testid="connect-on-device-server"
        className="mt-[6px] inline-flex h-[36px] w-full items-center justify-center rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[12px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--bg-panel)]"
      >
        {checking ? "Checking..." : "Check and use this phone"}
      </button>
      {status ? (
        <p
          className={`mt-[7px] font-sans text-[11px] leading-relaxed ${
            status.kind === "error"
              ? "text-[var(--debug-accent)]"
              : "text-[var(--text-secondary)]"
          }`}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.text}
        </p>
      ) : null}
      <p className="mt-[7px] font-sans text-[10.5px] leading-relaxed text-[var(--text-disabled)]">
        If apt complains about mirrors, run{" "}
        <span className="font-mono">termux-change-repo</span>, then retry. The installer
        skips native addons Termux cannot build (node-pty), stores data on-device, and
        binds to loopback only. Manage it later with{" "}
        <span className="font-mono">cesium-server</span>.
      </p>
    </section>
  );
}
