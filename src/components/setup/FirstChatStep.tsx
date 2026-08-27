"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, CloudUpload, Loader2, Send } from "lucide-react";
import { useCloudContext } from "@/contexts/CloudContext";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";
import {
  bootstrapEngineWorkspaces,
  createEngineConversationWithPrompt,
  createEngineStandaloneConversationWithPrompt,
  exportEngineConversationSnapshot,
  listEngineBackends,
  openEngineWorkspace,
  type EngineBackendInfo,
  type EngineWorkspace,
} from "@/lib/onboarding/engine-api";

/**
 * Sentinel select value for chatting without any workspace. A fresh install
 * has zero registered workspaces on purpose; the conversation then runs in an
 * ephemeral standalone-chat sandbox instead of requiring folder setup.
 */
const NO_WORKSPACE_VALUE = "__none__";

/**
 * Step 4 - start your first conversation: pick a workspace folder, choose an
 * available backend, send the first prompt. Afterwards the conversation can
 * be synced to the cloud in one click so any other device can pick it up.
 */
export function FirstChatStep({
  baseUrl,
  serverName,
  onStarted,
}: {
  baseUrl: string;
  serverName: string | null;
  onStarted: () => void;
}) {
  const cloud = useCloudContext();
  const [workspaces, setWorkspaces] = useState<EngineWorkspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [customRoot, setCustomRoot] = useState("");
  const [backends, setBackends] = useState<EngineBackendInfo[]>([]);
  const [backendId, setBackendId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<"compose" | "sending" | "started">("compose");
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{
    id: string;
    title: string;
    workspaceId: string;
  } | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "synced">("idle");

  const load = useCallback(async () => {
    try {
      const [workspaceResult, backendResult] = await Promise.all([
        bootstrapEngineWorkspaces(baseUrl),
        listEngineBackends(baseUrl),
      ]);
      setWorkspaces(workspaceResult.workspaces);
      setWorkspaceId(
        workspaceResult.defaultWorkspaceId ??
          workspaceResult.workspaces[0]?.id ??
          NO_WORKSPACE_VALUE
      );
      const available = backendResult.backends.filter((backend) => backend.available);
      setBackends(available);
      setBackendId((current) => current || available[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    setError(null);
    if (!prompt.trim() || !backendId) {
      return;
    }
    setPhase("sending");
    try {
      let targetWorkspaceId =
        workspaceId === NO_WORKSPACE_VALUE ? "" : workspaceId;
      if (customRoot.trim()) {
        const workspace = await openEngineWorkspace(baseUrl, customRoot.trim());
        targetWorkspaceId = workspace.id;
      }
      const backend = backends.find((entry) => entry.id === backendId);
      const promptInput = {
        backendId,
        ...(backend ? { modelId: backend.defaultModelId } : {}),
        ...(backend ? { modelName: backend.defaultModelName } : {}),
        text: prompt.trim(),
      };
      let result: { conversationId: string; title: string };
      let conversationWorkspaceId = targetWorkspaceId;
      if (targetWorkspaceId) {
        result = await createEngineConversationWithPrompt(
          baseUrl,
          targetWorkspaceId,
          promptInput
        );
      } else {
        const standalone = await createEngineStandaloneConversationWithPrompt(
          baseUrl,
          promptInput
        );
        result = standalone;
        conversationWorkspaceId = standalone.workspaceId;
      }
      setConversation({
        id: result.conversationId,
        title: result.title,
        workspaceId: conversationWorkspaceId,
      });
      setPhase("started");
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("compose");
    }
  };

  const syncToCloud = async () => {
    if (!conversation || !cloud.actions) {
      return;
    }
    setSyncState("syncing");
    setError(null);
    try {
      const snapshot = await exportEngineConversationSnapshot(
        baseUrl,
        conversation.workspaceId,
        conversation.id
      );
      const workspace = workspaces?.find(
        (entry) => entry.id === conversation.workspaceId
      );
      await cloud.actions.pushSnapshot({
        snapshotKey: snapshot.snapshotKey,
        title: snapshot.title,
        backendId: snapshot.backendId,
        ...(snapshot.modelId ? { modelId: snapshot.modelId } : {}),
        ...(snapshot.modelName ? { modelName: snapshot.modelName } : {}),
        ...(workspace ? { workspaceName: workspace.name } : {}),
        ...(serverName ? { serverName } : {}),
        messageCount: snapshot.messageCount,
        recordJson: snapshot.recordJson,
        eventsJson: snapshot.eventsJson,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
      });
      setSyncState("synced");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSyncState("idle");
    }
  };

  if (phase === "started" && conversation) {
    return (
      <div className="space-y-[14px]">
        <div className="flex items-center gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[18px]">
          <CheckCircle2
            className="size-[20px] shrink-0 text-[var(--ask-accent)]"
            strokeWidth={1.75}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium text-[var(--text-primary)]">
              “{conversation.title}” is running
            </p>
            <p className="text-[12.5px] text-[var(--text-secondary)]">
              Your agent is working on the first reply.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-[10px]">
          <Link
            href={WORKSPACE_ROUTE}
            className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[16px] py-[9px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
          >
            Open the workbench
            <ArrowRight className="size-[14px]" strokeWidth={2} aria-hidden />
          </Link>
          {cloud.actions ? (
            <button
              type="button"
              disabled={syncState !== "idle"}
              onClick={() => void syncToCloud()}
              className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[16px] py-[9px] text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-70"
            >
              {syncState === "syncing" ? (
                <Loader2 className="size-[14px] animate-spin" strokeWidth={2} aria-hidden />
              ) : (
                <CloudUpload className="size-[14px]" strokeWidth={1.75} aria-hidden />
              )}
              {syncState === "synced" ? "Synced to cloud" : "Sync to cloud"}
            </button>
          ) : null}
        </div>
        {error ? <p className="text-[12.5px] text-[var(--goal-accent)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-[12px]">
      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
        <label className="block">
          <span className="mb-[6px] block text-[12.5px] font-medium text-[var(--text-secondary)]">
            Workspace
          </span>
          <select
            value={customRoot ? "__custom__" : workspaceId}
            onChange={(event) => {
              if (event.target.value === "__custom__") {
                setCustomRoot(customRoot || "/");
              } else {
                setCustomRoot("");
                setWorkspaceId(event.target.value);
              }
            }}
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[9px] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value={NO_WORKSPACE_VALUE}>No workspace - just chat</option>
            {(workspaces ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} - {workspace.root}
              </option>
            ))}
            <option value="__custom__">Other folder…</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-[6px] block text-[12.5px] font-medium text-[var(--text-secondary)]">
            Agent
          </span>
          <select
            value={backendId}
            onChange={(event) => setBackendId(event.target.value)}
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[9px] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            {backends.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.label} · {backend.defaultModelName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {customRoot ? (
        <input
          type="text"
          value={customRoot}
          onChange={(event) => setCustomRoot(event.target.value)}
          placeholder="/absolute/path/to/project"
          className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[9px] font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      ) : null}

      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Ask your agent anything about this workspace…"
        rows={3}
        className="w-full resize-y rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[10px] text-[13.5px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />

      <button
        type="button"
        disabled={phase === "sending" || !prompt.trim() || !backendId}
        onClick={() => void send()}
        className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[18px] py-[9px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
      >
        {phase === "sending" ? (
          <Loader2 className="size-[14px] animate-spin" strokeWidth={2} aria-hidden />
        ) : (
          <Send className="size-[14px]" strokeWidth={1.75} aria-hidden />
        )}
        Start conversation
      </button>

      {backends.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          No agent backend is ready yet - finish the previous step first.
        </p>
      ) : null}
      {error ? <p className="text-[12.5px] text-[var(--goal-accent)]">{error}</p> : null}
    </div>
  );
}
