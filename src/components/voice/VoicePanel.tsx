"use client";

/**
 * Expanded voice panel: mode switcher (Active / Quiet / Paused / Off),
 * live pipeline status, the voice conversation log (displayText side of the
 * controller contract), a text fallback input, and the pipeline self-test.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FlaskConical, Loader2, Send, X } from "lucide-react";
import { useVoice, type VoiceMode } from "./VoiceProvider";

const MODES: Array<{ id: VoiceMode; label: string; hint: string }> = [
  { id: "active", label: "Active", hint: "Listen, act, speak" },
  { id: "quiet", label: "Quiet", hint: "Listen and act, never speak" },
  { id: "paused", label: "Paused", hint: "Mic off, nothing interpreted" },
  { id: "off", label: "Off", hint: "Voice plane disabled" },
];

function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
}

export function VoicePanel() {
  const {
    mode,
    setMode,
    activity,
    log,
    vadEngineId,
    captureSettings,
    serverStatus,
    lastLatency,
    latencyP50Ms,
    sendTextUtterance,
    runSelfTest,
    selfTestRunning,
    setPanelOpen,
    error,
    queuedDigestCount,
  } = useVoice();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    try {
      await sendTextUtterance(text);
    } finally {
      setSending(false);
    }
  };

  const ttsEngine =
    serverStatus?.tts.defaultEngine ??
    serverStatus?.tts.engines.find((engine) => engine.available)?.id ??
    null;

  return (
    <div
      className="fixed bottom-14 right-4 z-[70] flex max-h-[600px] w-[400px] flex-col overflow-hidden rounded-[10px] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-xl"
      data-testid="voice-panel"
    >
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
          Live Voice
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          title="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            title={entry.hint}
            onClick={() => setMode(entry.id)}
            className={`rounded-[6px] px-2.5 py-1 text-[12px] transition-colors ${
              mode === entry.id
                ? "bg-[var(--accent-bg)] font-medium text-[var(--text-primary)] ring-1 ring-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
            }`}
            data-testid={`voice-mode-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="border-b border-[var(--border-subtle)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
        <div className="flex flex-wrap gap-x-3">
          <span>
            stt{" "}
            <span className="text-[var(--text-primary)]">
              {serverStatus?.stt.configured ? serverStatus.stt.model : "not configured"}
            </span>
          </span>
          <span>
            controller{" "}
            <span className="text-[var(--text-primary)]">
              {serverStatus?.controller.configured
                ? serverStatus.controller.model
                : "not configured"}
            </span>
          </span>
          <span>
            tts <span className="text-[var(--text-primary)]">{ttsEngine ?? "none"}</span>
          </span>
          <span>
            vad <span className="text-[var(--text-primary)]">{vadEngineId ?? "—"}</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3">
          {captureSettings ? (
            <span>
              mic {captureSettings.sampleRate ?? "?"} Hz
              {captureSettings.echoCancellation === false ? " · no AEC" : ""}
            </span>
          ) : null}
          {lastLatency ? (
            <span>
              last{" "}
              {[
                lastLatency.sttMs !== null ? `stt ${lastLatency.sttMs}ms` : null,
                `llm ${lastLatency.controllerMs}ms`,
                lastLatency.respondMs !== null
                  ? `respond ${lastLatency.respondMs}ms`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
          {latencyP50Ms !== null ? <span>p50 respond {latencyP50Ms}ms</span> : null}
        </div>
      </div>

      {error ? (
        <div className="border-b border-[var(--border-subtle)] bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {error}
        </div>
      ) : null}
      {queuedDigestCount > 0 ? (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--accent-bg)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">
          {queuedDigestCount} event{queuedDigestCount === 1 ? "" : "s"} queued for
          the next digest
        </div>
      ) : null}

      <div
        ref={logRef}
        className="flex-1 space-y-2 overflow-y-auto px-3 py-2"
        data-testid="voice-log"
      >
        {log.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-disabled)]">
            Switch to Active and start talking, type below, or run the pipeline
            self-test.
          </div>
        ) : null}
        {log.map((entry) => (
          <div
            key={entry.id}
            className={`flex flex-col ${entry.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[92%] whitespace-pre-wrap rounded-[8px] px-2.5 py-1.5 text-[12.5px] leading-5 ${
                entry.role === "user"
                  ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                  : entry.role === "assistant"
                    ? "border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]"
                    : entry.role === "event"
                      ? "border border-dashed border-[var(--border-card)] bg-transparent text-[var(--text-secondary)]"
                      : "bg-transparent italic text-[var(--text-secondary)]"
              }`}
            >
              {stripMarkdown(entry.text)}
              {entry.actions && entry.actions.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {entry.actions.map((action, index) => (
                    <span
                      key={index}
                      title={action.summary}
                      className={`rounded-full border px-1.5 py-[1px] font-mono text-[10px] ${
                        action.ok
                          ? "border-emerald-600/40 text-emerald-600"
                          : "border-red-500/40 text-red-500"
                      }`}
                    >
                      {action.tool}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {entry.meta ? (
              <div className="mt-0.5 px-1 text-[10px] text-[var(--text-disabled)]">
                {entry.meta}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <form
        onSubmit={submit}
        className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] px-2.5 py-2"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            activity === "listening" || activity === "capturing"
              ? "Listening… or type an utterance"
              : "Type an utterance"
          }
          className="h-8 flex-1 rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-card)] px-2 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          data-testid="voice-text-input"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          title="Send as utterance"
          className="flex size-8 items-center justify-center rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-card)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-40"
          data-testid="voice-text-send"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          disabled={selfTestRunning}
          onClick={() => void runSelfTest(draft.trim() || undefined)}
          title="Pipeline self-test: synthesize this text (or a default) with the local TTS engine, then run it through VAD, endpointing, STT, and the controller as if spoken"
          className="flex size-8 items-center justify-center rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-card)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-40"
          data-testid="voice-self-test"
        >
          {selfTestRunning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FlaskConical className="size-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}
