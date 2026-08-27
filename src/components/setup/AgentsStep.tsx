"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Download, KeyRound, Loader2 } from "lucide-react";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  installEngineBackendCli,
  listEngineBackends,
  saveCesiumAgentProviderKey,
  type EngineBackendInfo,
} from "@/lib/onboarding/engine-api";

/**
 * Step 2 - set up your agents. Lists the engine's backends with live
 * availability, offers one-click CLI installs for missing harnesses (streamed
 * install logs) and API-key auth for the built-in Cesium Agent. Configured
 * backends are remembered in the user's cloud context.
 */
export function AgentsStep({
  baseUrl,
  onReady,
}: {
  baseUrl: string;
  onReady: (ready: boolean) => void;
}) {
  const cloud = useCloudContext();
  const [backends, setBackends] = useState<EngineBackendInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [keyFormBackend, setKeyFormBackend] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listEngineBackends(baseUrl);
      setBackends(result.backends);
      onReady(result.backends.some((backend) => backend.available));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [baseUrl, onReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  const runInstall = async (backend: EngineBackendInfo) => {
    setInstalling(backend.id);
    setInstallLog([]);
    setInstallNote(null);
    try {
      const result = await installEngineBackendCli(baseUrl, backend.id, (line) =>
        setInstallLog((prev) => [...prev.slice(-199), line])
      );
      if (result.ok) {
        setInstallNote(
          result.available
            ? `${backend.label} installed and ready.`
            : `${backend.label} installed. ${result.authHint ?? "Authenticate on the engine host to activate it."}`
        );
        if (cloud.actions) {
          void cloud.actions
            .saveAgentPref({
              backendId: backend.id,
              enabled: true,
              defaultModelId: backend.defaultModelId,
              defaultModelName: backend.defaultModelName,
            })
            .catch(() => undefined);
        }
      } else {
        setInstallNote(result.error ?? "Install failed.");
      }
      await refresh();
    } catch (err) {
      setInstallNote(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(null);
    }
  };

  const saveKey = async () => {
    if (!keyFormBackend || !apiKey.trim()) {
      return;
    }
    setSavingKey(true);
    setError(null);
    try {
      const custom = providerBaseUrl.trim();
      await saveCesiumAgentProviderKey(baseUrl, {
        providerId: custom ? "custom" : "openai",
        apiKind: custom ? "openai-compatible" : "openai-chat-completions",
        apiKey: apiKey.trim(),
        ...(custom ? { providerBaseUrl: custom, label: "Custom provider" } : {}),
      });
      if (cloud.actions) {
        void cloud.actions
          .saveAgentPref({ backendId: keyFormBackend, enabled: true })
          .catch(() => undefined);
      }
      setKeyFormBackend(null);
      setApiKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  if (!backends) {
    return (
      <div className="flex items-center gap-[10px] p-[16px] text-[13px] text-[var(--text-secondary)]">
        <Loader2 className="size-[15px] animate-spin" strokeWidth={2} aria-hidden />
        Asking the engine which agents it can run…
        {error ? <span className="text-[var(--goal-accent)]">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="space-y-[12px]">
      <div className="space-y-[8px]">
        {backends.map((backend) => (
          <div
            key={backend.id}
            className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[12px]"
          >
            <div className="flex items-center gap-[10px]">
              {backend.available ? (
                <CheckCircle2
                  className="size-[16px] shrink-0 text-[var(--ask-accent)]"
                  strokeWidth={1.75}
                  aria-hidden
                />
              ) : (
                <Circle
                  className="size-[16px] shrink-0 text-[var(--text-disabled)]"
                  strokeWidth={1.75}
                  aria-hidden
                />
              )}
              <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                {backend.label}
              </span>
              <span className="ml-auto flex items-center gap-[8px]">
                {!backend.available && backend.id === "cesium-agent" ? (
                  <button
                    type="button"
                    onClick={() =>
                      setKeyFormBackend((current) =>
                        current === backend.id ? null : backend.id
                      )
                    }
                    className="inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[5px] text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
                  >
                    <KeyRound className="size-[12px]" strokeWidth={1.75} aria-hidden />
                    Add API key
                  </button>
                ) : null}
                {!backend.available && backend.installer ? (
                  <button
                    type="button"
                    disabled={installing !== null}
                    onClick={() => void runInstall(backend)}
                    className="inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[5px] text-[12px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
                  >
                    {installing === backend.id ? (
                      <Loader2 className="size-[12px] animate-spin" strokeWidth={2} aria-hidden />
                    ) : (
                      <Download className="size-[12px]" strokeWidth={1.75} aria-hidden />
                    )}
                    Install
                  </button>
                ) : null}
              </span>
            </div>
            <p className="mt-[6px] text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {backend.description}
            </p>
            {backend.installer && !backend.available ? (
              <p className="mt-[4px] font-mono text-[10.5px] text-[var(--text-disabled)]">
                {backend.installer.summary}
              </p>
            ) : null}

            {keyFormBackend === backend.id ? (
              <div className="mt-[10px] space-y-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px]">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Provider API key (OpenAI-compatible)"
                  className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[8px] font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <input
                  type="url"
                  value={providerBaseUrl}
                  onChange={(event) => setProviderBaseUrl(event.target.value)}
                  placeholder="Custom base URL (optional, e.g. https://my-proxy/v1)"
                  className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[8px] font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  disabled={savingKey || !apiKey.trim()}
                  onClick={() => void saveKey()}
                  className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[7px] text-[12.5px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
                >
                  {savingKey ? "Saving…" : "Save key"}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {installLog.length > 0 ? (
        <pre
          ref={logRef}
          className="max-h-[180px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px] font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]"
        >
          {installLog.join("\n")}
        </pre>
      ) : null}
      {installNote ? (
        <p className="text-[12.5px] text-[var(--text-secondary)]">{installNote}</p>
      ) : null}
      {error ? <p className="text-[12.5px] text-[var(--goal-accent)]">{error}</p> : null}
    </div>
  );
}
