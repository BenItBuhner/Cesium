"use client";

/**
 * Full-screen voice agent session view: the audio-reactive orb front and
 * center, live status + transcript captions, and the exact same chat composer
 * as the landing page docked at the bottom (raw text, attachments, mode /
 * model / backend pickers all work verbatim). Top-right controls minimize the
 * session to the docked orb or end it entirely.
 *
 * View transitions are orb-anchored: the backdrop and chrome fade while the
 * orb FLIPs between here and the dock pill (voice-orb-transition.ts), so
 * minimizing reads as the orb shrinking down into the conversation and
 * expanding as it flying back up to center stage. Ending the session
 * collapses the orb with the backdrop. The overlay stays mounted for the
 * exit animation's duration before unmounting.
 */

import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MicOff, Minimize2, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAgentDraftComposer } from "@/hooks/useAgentDraftComposer";
import type { SessionOrbStatus } from "@/lib/voice/session-orb-renderer";
import {
  consumeVoiceOrbRect,
  flipOrbFromRect,
  prefersReducedMotion,
} from "./voice-orb-transition";
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
  error: "Mic unavailable",
};

const TRANSCRIPT_KIND_LABELS = {
  heard: "You",
  reply: "Agent",
  system: "System",
  error: "Error",
} as const;

/** How long the overlay stays mounted to play its exit fade. */
const EXIT_MS = 240;

function computeOrbSize(): number {
  if (typeof window === "undefined") return 280;
  return Math.round(
    Math.min(340, Math.max(200, Math.min(window.innerWidth, window.innerHeight) * 0.38))
  );
}

export function VoiceAgentView() {
  const session = useVoiceSession();
  const { workspaceSession } = useWorkspace();
  const draft = useAgentDraftComposer();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const open = session.view === "full";

  // Exit choreography: when the view leaves "full", keep rendering just long
  // enough to fade the surface out. Minimizing hides this orb instantly (the
  // dock orb FLIPs from its exact rect, taking over mid-flight); closing
  // collapses the orb along with the backdrop.
  const [exitMode, setExitMode] = useState<null | "minimize" | "close">(null);
  const prevViewRef = useRef(session.view);
  const exitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const previous = prevViewRef.current;
    prevViewRef.current = session.view;
    if (session.view === "full") {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setExitMode(null);
      return;
    }
    if (previous !== "full") return;
    if (prefersReducedMotion()) return;
    setExitMode(session.view === "minimized" ? "minimize" : "close");
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setExitMode(null);
    }, EXIT_MS);
  }, [session.view]);
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    };
  }, []);

  const visible = open || exitMode !== null;

  // Entrance: expanding from the dock FLIPs the orb up from the pill's rect;
  // a fresh session start blooms it in instead (CSS class, no source rect).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [orbIntro, setOrbIntro] = useState(false);
  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const root = rootRef.current;
    const orbEl = root?.querySelector<HTMLElement>('[data-voice-orb="full"]');
    const source = consumeVoiceOrbRect("dock");
    if (orbEl && source) {
      flipOrbFromRect(orbEl, source);
      setOrbIntro(false);
    } else {
      setOrbIntro(true);
    }
    // Re-run whenever the overlay (re)opens.
  }, [mounted, open]);

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

  // The orb tracks the viewport so rotations / window resizes keep it scaled.
  const [orbSize, setOrbSize] = useState(computeOrbSize);
  useEffect(() => {
    if (!open) return;
    const onResize = () => setOrbSize(computeOrbSize());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  if (!mounted || !visible) {
    return null;
  }

  const exiting = exitMode !== null;
  const surfaceClass = exiting ? "voice-surface-exit" : "voice-surface-enter";
  const chromeClass = exiting ? "voice-chrome-exit" : "voice-chrome-enter";
  const orbWrapClass = exiting
    ? exitMode === "minimize"
      ? "invisible"
      : "voice-orb-close"
    : orbIntro
      ? "voice-orb-intro"
      : "";
  const micFailed = session.micState === "error";

  return createPortal(
    <div
      ref={rootRef}
      data-voice-agent-view
      className={`fixed inset-0 z-[10000] flex flex-col ${
        exiting ? "pointer-events-none" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Voice agent session"
    >
      {/* Backdrop as its own fading layer: the orb above never fades with it,
          so FLIP handoffs to/from the dock stay visually continuous. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-[var(--bg-main)] ${surfaceClass}`}
      />

      {/* Top bar */}
      <div
        className={`relative flex shrink-0 items-center justify-between px-[16px] pt-[12px] ${chromeClass}`}
      >
        <div className="flex items-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">Voice agent</span>
          <span aria-live="polite">{STATUS_LABELS[session.status]}</span>
          {micFailed ? (
            <span className="flex items-center gap-[5px] rounded-[var(--radius-pill)] bg-[var(--bg-card)] px-[8px] py-[3px] text-[11px] text-[var(--status-error,#e5484d)]">
              <MicOff className="size-[11px]" strokeWidth={1.8} />
              Mic off - typing still works
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
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-[18px] overflow-hidden px-[16px]">
        <div className={orbWrapClass}>
          <VoiceSessionOrb
            size={orbSize}
            variant="full"
            onClick={
              session.status === "speaking" ? session.interruptSpeech : undefined
            }
            ariaLabel={
              session.status === "speaking"
                ? "Stop speaking"
                : "Voice agent orb"
            }
          />
        </div>
        <div
          className={`flex max-h-[26vh] w-full max-w-[560px] flex-col gap-[6px] overflow-y-auto ${chromeClass}`}
        >
          {micFailed ? (
            <div
              data-voice-agent-mic-error
              className="flex flex-col items-center gap-[8px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[14px] py-[10px] text-center font-sans"
            >
              <div className="flex items-center gap-[6px] text-[12.5px] font-medium text-[var(--status-error,#e5484d)]">
                <MicOff className="size-[13px]" strokeWidth={1.8} />
                Microphone unavailable
              </div>
              <p className="text-[12px] leading-snug text-[var(--text-secondary)]">
                {session.micError ??
                  "The microphone could not be started. You can keep typing below."}
              </p>
              <button
                type="button"
                data-voice-agent-retry-mic
                onClick={session.retryMic}
                className="flex items-center gap-[6px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[4px] text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-main)]"
              >
                <RefreshCw className="size-[12px]" strokeWidth={1.8} />
                Retry microphone
              </button>
            </div>
          ) : null}
          {session.micState === "starting" ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[8px] text-center font-sans text-[12px] text-[var(--text-secondary)]">
              Starting microphone…
            </div>
          ) : null}
          {session.transcript.map((entry) => (
            <div
              key={entry.id}
              className={`voice-caption-enter rounded-[var(--radius-card)] border px-[12px] py-[8px] font-sans text-[12.5px] leading-snug ${
                entry.kind === "error"
                  ? "border-[color-mix(in_srgb,var(--status-error,#e5484d)_35%,transparent)] bg-[var(--bg-panel)] text-[var(--status-error,#e5484d)]"
                  : "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)]"
              }`}
            >
              <span
                className={`mr-[6px] font-medium ${
                  entry.kind === "error"
                    ? "text-[var(--status-error,#e5484d)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {TRANSCRIPT_KIND_LABELS[entry.kind]}
              </span>
              {entry.text}
            </div>
          ))}
        </div>
      </div>

      {/* Same composer as the landing: raw text + attachments verbatim. */}
      <div
        className={`relative mx-auto w-full max-w-[720px] shrink-0 px-[12px] pb-[14px] ${chromeClass}`}
      >
        <ChatComposer
          key={`voice-${draft.composerDraftId}`}
          mode={draft.draftMode}
          onModeChange={draft.setDraftMode}
          model={draft.draftModel}
          onModelChange={draft.setDraftModel}
          backendId={draft.draftBackend?.id ?? workspaceSession.chat.backendId}
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
