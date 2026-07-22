"use client";

import { Check, Copy, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { buildCesiumServerInstallCommand } from "@/lib/server-install-command";

export function ServerSetupCommand({ compact = false }: { compact?: boolean }) {
  const [command, setCommand] = useState("");
  const [copied, setCopied] = useState(false);
  const [rendezvousStatus, setRendezvousStatus] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");

  useEffect(() => {
    setCommand(buildCesiumServerInstallCommand(window.location.origin));
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
  }, []);

  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

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
            Run this in the folder Cesium should access. It installs into{" "}
            <span className="font-mono">~/.cesium</span>, starts immediately, and prints a secure
            permanent Connect URL plus sign-in credentials.
          </p>
        </div>
      </div>
      <div className="mt-[9px] flex min-w-0 items-stretch gap-[7px]">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[9px] py-[8px] font-mono text-[10.5px] leading-relaxed text-[var(--text-primary)]">
          {command || "Preparing install command..."}
        </code>
        <button
          type="button"
          disabled={!command || rendezvousStatus !== "ready"}
          onClick={() => void copyCommand()}
          className="inline-flex w-[72px] shrink-0 items-center justify-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] font-sans text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
          aria-label="Copy Cesium server install command"
        >
          {copied ? (
            <Check className="size-[13px]" strokeWidth={1.8} aria-hidden />
          ) : (
            <Copy className="size-[13px]" strokeWidth={1.6} aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
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
