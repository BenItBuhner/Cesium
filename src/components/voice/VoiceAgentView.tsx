"use client";

/**
 * Full-screen voice agent session view: the revamped orb front and center,
 * live status + transcript captions, and the exact same chat composer as the
 * landing page docked at the bottom (raw text, attachments, mode / model /
 * backend pickers all work verbatim). Top-right controls minimize the session
 * to the docked orb or end it entirely.
 */

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { Minimize2, Volume2, VolumeX, X } from "lucide-react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useIsShellUnderlay } from "@/components/layout/ShellUnderlayContext";
import { useAgentDraftComposer } from "@/hooks/useAgentDraftComposer";
import type { SessionOrbStatus } from "@/lib/voice/session-orb-renderer";
import { useVoiceSession } from "./VoiceSessionProvider";
import { VoiceSessionOrb } from "./VoiceSessionOrb";

const STATUS_LABELS: Record<SessionOrbStatus, string> = {
  idle: "Ready",
  listening: "Listening…",
  capturing: "Hearing you…",
  transcribing: "Transcribing…",
  sending: "Sending to agent…",
  working: "Agent working…",
  speaking: "Speaking…",
};

const TRANSCRIPT_KIND_LABELS = {
  heard: "You",
  reply: "Agent",
  system: "System",
  error: "Error",
} as const;

export function VoiceAgentView() {
  const session = useVoiceSession();
  const draft = useAgentDraftComposer();
  // The full-screen voice view portals above everything (z-10000), so it must
  // not render while its tree is the hidden preview layer beneath settings.
  const isShellUnderlay = useIsShellUnderlay();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const open = session.view === "full" && !isShellUnderlay;

  // Escape minimizes (matching the Android back gesture); the composer's own
  // Escape handling (closing pickers) stops propagation before reaching this.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      session.minimize();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, session]);

  const orbSize = useMemo(() => {
    if (typeof window === "undefined") return 280;
    return Math.round(
      Math.min(340, Math.max(200, Math.min(window.innerWidth, window.innerHeight) * 0.38))
    );
  }, []);

  if (!mounted || !open) {
    return null;
  }

  return createPortal(
    <div
      data-voice-agent-view
      className="fixed inset-0 z-[10000] flex flex-col bg-[var(--bg-main)]"
      role="dialog"
      aria-modal="true"
      aria-label="Voice agent session"
    >
      {/* Top bar */}
      <div className="flex shrink-0 items-center justify-between px-[16px] pt-[12px]">
        <div className="flex items-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">Voice agent</span>
          <span aria-live="polite">{STATUS_LABELS[session.status]}</span>
          {session.micState === "error" ? (
            <span className="rounded-[var(--radius-pill)] bg-[var(--bg-card)] px-[8px] py-[3px] text-[11px] text-[var(--status-error,#e5484d)]">
              Mic unavailable - type below
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-[6px]">
          <button
            type="button"
            onClick={() => session.setSpeakReplies(!session.speakReplies)}
            aria-label={
              session.speakReplies ? "Mute spoken replies" : "Unmute spoken replies"
            }
            title={session.speakReplies ? "Mute spoken replies" : "Speak replies aloud"}
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
          >
            {session.speakReplies ? (
              <Volume2 className="size-[15px]" strokeWidth={1.6} />
            ) : (
              <VolumeX className="size-[15px]" strokeWidth={1.6} />
            )}
          </button>
          <button
            type="button"
            data-voice-agent-minimize
            onClick={session.minimize}
            aria-label="Minimize voice agent"
            title="Minimize - the orb docks above the composer"
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
          >
            <Minimize2 className="size-[15px]" strokeWidth={1.6} />
          </button>
          <button
            type="button"
            data-voice-agent-end
            onClick={session.stop}
            aria-label="End voice session"
            title="End voice session"
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--status-error,#e5484d)]"
          >
            <X className="size-[16px]" strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {/* Orb + captions */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[18px] overflow-hidden px-[16px]">
        <VoiceSessionOrb
          size={orbSize}
          onClick={
            session.status === "speaking" ? session.interruptSpeech : undefined
          }
          ariaLabel={
            session.status === "speaking"
              ? "Stop speaking"
              : "Voice agent orb"
          }
        />
        <div className="flex max-h-[26vh] w-full max-w-[560px] flex-col gap-[6px] overflow-y-auto">
          {session.micError && session.micState === "error" ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[8px] text-center font-sans text-[12px] text-[var(--text-secondary)]">
              {session.micError}
            </div>
          ) : null}
          {session.transcript.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[8px] font-sans text-[12.5px] leading-snug ${
                entry.kind === "error"
                  ? "text-[var(--status-error,#e5484d)]"
                  : "text-[var(--text-primary)]"
              }`}
            >
              <span className="mr-[6px] font-medium text-[var(--text-secondary)]">
                {TRANSCRIPT_KIND_LABELS[entry.kind]}
              </span>
              {entry.text}
            </div>
          ))}
        </div>
      </div>

      {/* Same composer as the landing: raw text + attachments verbatim. */}
      <div className="mx-auto w-full max-w-[720px] shrink-0 px-[12px] pb-[14px]">
        <ChatComposer
          key={`voice-${draft.composerDraftId}`}
          mode={draft.draftMode}
          onModeChange={draft.setDraftMode}
          model={draft.draftModel}
          onModelChange={draft.setDraftModel}
          backendId={draft.draftBackend?.id ?? draft.composer.backendId}
          backends={draft.backends}
          onBackendChange={draft.setDraftBackend}
          models={draft.draftModels}
          modeOptions={draft.draftModeOptions}
          sessionConfigOptions={[]}
          onSessionConfigOptionChange={() => undefined}
          value={draft.composerDraftText}
          onValueChange={(next) => {
            draft.upsertComposerDraft(draft.composerDraftId, {
              title: draft.composerDraftTitle,
              content: next,
            });
          }}
          selection={draft.composerSelection}
          onSelectionChange={(next) =>
            draft.setComposerSelection(draft.composerDraftId, next)
          }
          busy={false}
          configLocked={false}
          onSubmit={session.submitComposer}
          onCancel={() => undefined}
          gitSlashCommands={Boolean(draft.gitStatus)}
          layout="docked-bottom"
          shellMxClass=""
          draftAttachments={draft.composerDraftAttachments}
          onDraftAttachmentsChange={(next) =>
            draft.upsertComposerDraft(draft.composerDraftId, {
              title: draft.composerDraftTitle,
              attachments: next,
            })
          }
          draftCaptures={draft.composerDraftCaptures}
          onDraftCapturesChange={(next) =>
            draft.upsertComposerDraft(draft.composerDraftId, {
              title: draft.composerDraftTitle,
              captures: next,
            })
          }
          draftTextReferences={draft.composerDraftTextReferences}
          onDraftTextReferencesChange={(next) =>
            draft.upsertComposerDraft(draft.composerDraftId, {
              title: draft.composerDraftTitle,
              textReferences: next,
            })
          }
          draftLinkReferences={draft.composerDraftLinkReferences}
          onDraftLinkReferencesChange={(next) =>
            draft.upsertComposerDraft(draft.composerDraftId, {
              title: draft.composerDraftTitle,
              linkReferences: next,
            })
          }
        />
      </div>
    </div>,
    document.body
  );
}
