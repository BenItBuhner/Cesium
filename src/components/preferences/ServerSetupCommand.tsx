"use client";

import { SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyableCommandLine } from "@/components/ui/CopyableCommandLine";
import { buildCesiumServerInstallCommand } from "@/lib/server-install-command";

/**
 * The installer command embeds the hosted web app origin, so it only makes
 * sense on http(s) deployments. Packaged clients (Android WebView, Electron)
 * load from file:// and have no hosted origin to point the installer at.
 */
function hostedWebAppOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.protocol === "http:" || window.location.protocol === "https:"
    ? window.location.origin
    : "";
}

export function ServerSetupCommand({
  compact = false,
  accountLinked = false,
}: {
  compact?: boolean;
  /** Signed-in production/device sync: engines attach to the account automatically. */
  accountLinked?: boolean;
}) {
  const [origin] = useState(hostedWebAppOrigin);
  const [command, setCommand] = useState("");
  const [rendezvousStatus, setRendezvousStatus] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");

  useEffect(() => {
    if (!origin) return;
    setCommand(buildCesiumServerInstallCommand(origin));
    const controller = new AbortController();
    void fetch("/api/rendezvous", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        setRendezvousStatus(response.ok ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRendezvousStatus("unavailable");
        }
      });
    return () => controller.abort();
  }, [origin]);

  if (!origin) {
    return null;
  }

  return (
    <section
      className={`rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] ${
        compact ? "p-[10px]" : "p-[12px]"
      }`}
    >
      <div className="flex items-start gap-[9px]">
        <SquareTerminal
          className="mt-[1px] size-[15px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.6}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            Install a server
          </h3>
          <p className="mt-[4px] font-sans text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            {accountLinked ? (
              <>
                Run this on the machine Cesium should access. It installs into{" "}
                <span className="font-mono">~/.cesium</span>, starts immediately, and prints a
                link - open it on any device to attach the engine to your account.
              </>
            ) : (
              <>
                Run this on the machine Cesium should access. It installs into{" "}
                <span className="font-mono">~/.cesium</span>, starts immediately, and prints a
                secure permanent Connect URL plus sign-in credentials. Use this instead of SSH.
              </>
            )}
          </p>
        </div>
      </div>
      {/*
        Copying is deliberately not gated on the rendezvous check below. That
        check only says whether the installed server will be able to publish a
        stable connect link; the command itself is valid either way, and a
        disabled Copy button just looked broken on phones.
      */}
      <CopyableCommandLine
        className="mt-[9px]"
        command={command}
        placeholder="Preparing install command..."
        copyAriaLabel="Copy Cesium server install command"
        testId="server-install"
      />
      <p className="mt-[7px] font-sans text-[10.5px] leading-relaxed text-[var(--text-disabled)]">
        {rendezvousStatus === "unavailable" ? (
          "Stable connection storage is not configured on this deployment. The site owner must attach Upstash Redis before sharing this installer."
        ) : rendezvousStatus === "checking" ? (
          "Checking stable connection service..."
        ) : (
          <>
            The same link follows tunnel changes automatically. Use{" "}
            <span className="font-mono">cesium-server status</span> to check the supervised
            service.
          </>
        )}
      </p>
    </section>
  );
}
