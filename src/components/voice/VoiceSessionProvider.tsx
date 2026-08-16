"use client";

/**
 * Control plane for the conversation-bound voice agent session.
 *
 * Unlike the ambient orb (`VoiceProvider`), this session binds to a real
 * agent conversation: committed utterances are transcribed and submitted
 * verbatim as user messages (create-and-prompt on the first turn, then
 * prompt), assistant replies stream into the normal chat thread, and the
 * session speaks each finished reply through clause-streamed TTS with
 * barge-in.
 *
 * Lifecycle hardening lives in `VoiceTurnEngine` (epoch + abort threading +
 * bounded queue); this provider wires it to the mic pipeline (AudioWorklet
 * capture -> VAD -> endpointer), the conversation store, and the TTS player,
 * and owns the view state: closed -> full-screen -> minimized dock.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { transcribeAudio, synthesizeVoiceSpeech } from "@/lib/server-api";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import {
  BACK_INTENT_PRIORITY,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { useAgentDraftComposer } from "@/hooks/useAgentDraftComposer";
import { VoiceCapture } from "@/lib/voice/capture";
import { decodeToPcm16k } from "@/lib/voice/audio-decode";
import {
  DEFAULT_ENDPOINTER_CONFIG,
  Endpointer,
  type EndpointerEvent,
} from "@/lib/voice/endpointing";
import { encodeWavPcm16, VOICE_SAMPLE_RATE } from "@/lib/voice/pcm";
import { VoiceTurnEngine, type VoiceTurnStatus } from "@/lib/voice/session";
import type { SessionOrbStatus } from "@/lib/voice/session-orb-renderer";
import { TtsPlayer } from "@/lib/voice/tts-player";
import { createBestVad, type VadEngine } from "@/lib/voice/vad";
import { isVoiceSessionEvent, VOICE_SESSION_EVENT } from "@/lib/voice-session-events";
import type { ImageAttachment } from "@/lib/types";

export type VoiceSessionView = "closed" | "full" | "minimized";

export type VoiceSessionMicState = "off" | "starting" | "on" | "error";

export type VoiceTranscriptEntry = {
  id: string;
  kind: "heard" | "reply" | "system" | "error";
  text: string;
  at: number;
};

type VoiceSessionContextValue = {
  view: VoiceSessionView;
  status: SessionOrbStatus;
  conversationId: string | null;
  micState: VoiceSessionMicState;
  micError: string | null;
  transcript: VoiceTranscriptEntry[];
  speakReplies: boolean;
  setSpeakReplies: (next: boolean) => void;
  start: () => void;
  stop: () => void;
  minimize: () => void;
  expand: () => void;
  /** Send a text utterance through the exact mic turn path (no attachments). */
  sendTextUtterance: (text: string) => void;
  /** Composer submissions: bind-or-prompt with full attachment support. */
  submitComposer: (
    text: string,
    attachments?: ImageAttachment[]
  ) => Promise<boolean>;
  /** Cancel in-progress TTS (barge-in via UI). */
  interruptSpeech: () => void;
  getOrbLevels: () => { mic: number; tts: number };
};

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

const BARGE_IN_CANCEL_MS = 350;
const TRANSCRIPT_LIMIT = 6;
const REPLY_RECONCILE_RETRY_MS = 4000;
const REPLY_RECONCILE_MAX_MS = 5 * 60_000;

let transcriptCounter = 0;
function nextTranscriptId(): string {
  transcriptCounter += 1;
  return `vt-${Date.now()}-${transcriptCounter}`;
}

declare global {
  interface Window {
    __cesiumVoiceSession?: {
      start: () => void;
      stop: () => void;
      minimize: () => void;
      expand: () => void;
      sendTextUtterance: (text: string) => void;
      /** Feeds 16 kHz PCM through the real VAD -> endpointer -> STT path. */
      injectPcm16k: (samples: Float32Array) => void;
      /** Decodes any audio container (e.g. WAV) and injects it as PCM. */
      injectAudio: (data: ArrayBuffer) => Promise<void>;
      getState: () => {
        view: VoiceSessionView;
        status: SessionOrbStatus;
        conversationId: string | null;
        micState: VoiceSessionMicState;
        transcript: VoiceTranscriptEntry[];
      };
    };
  }
}

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const {
    promptConversation,
    eventsByConversationId,
    conversationsById,
    syncConversationSnapshot,
  } = useAgentConversations();
  const { startNewConversation, setSelectedConversationId } = useAgentShellState();

  const [view, setView] = useState<VoiceSessionView>("closed");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [micState, setMicState] = useState<VoiceSessionMicState>("off");
  const [micError, setMicError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [engineStatus, setEngineStatus] = useState<VoiceTurnStatus>("idle");
  const [capturingSpeech, setCapturingSpeech] = useState(false);
  const [ttsActive, setTtsActive] = useState(false);
  const [composerSending, setComposerSending] = useState(false);

  const viewRef = useRef<VoiceSessionView>("closed");
  viewRef.current = view;
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const micStateRef = useRef<VoiceSessionMicState>("off");
  micStateRef.current = micState;
  const speakRepliesRef = useRef(true);
  speakRepliesRef.current = speakReplies;

  const statusRef = useRef<SessionOrbStatus>("idle");
  const transcriptRef = useRef<VoiceTranscriptEntry[]>([]);
  transcriptRef.current = transcript;

  const captureRef = useRef<VoiceCapture | null>(null);
  const vadRef = useRef<VadEngine | null>(null);
  const endpointerRef = useRef<Endpointer | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const speechActiveRef = useRef(false);
  const bargeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micLevelRef = useRef(0);
  const lastSpokenSeqRef = useRef(0);

  // Pending-turn marker: set when a submit is accepted, cleared when the
  // speak effect processes the turn's assistant_message_end. Mirrored in a
  // ref so sibling effects in the same commit see the cleared value.
  const [awaitingReplySince, setAwaitingReplySince] = useState<number | null>(
    null
  );
  const awaitingReplySinceRef = useRef<number | null>(null);
  const markAwaitingReply = useCallback((value: number | null) => {
    awaitingReplySinceRef.current = value;
    setAwaitingReplySince(value);
  }, []);

  const pushTranscript = useCallback(
    (entry: { kind: VoiceTranscriptEntry["kind"]; text: string }) => {
      setTranscript((previous) => {
        const next = [
          ...previous,
          { id: nextTranscriptId(), ...entry, at: Date.now() },
        ];
        return next.slice(-TRANSCRIPT_LIMIT);
      });
    },
    []
  );

  const getPlayer = useCallback((): TtsPlayer => {
    if (!playerRef.current) {
      playerRef.current = new TtsPlayer({
        synthesize: async (text, signal) => {
          const result = await synthesizeVoiceSpeech({ text }, { signal });
          return result.audio;
        },
        onStateChange: (state) => {
          setTtsActive(state === "speaking" || state === "synthesizing");
        },
        onError: (playerError) => {
          pushTranscript({ kind: "error", text: `TTS: ${playerError.message}` });
        },
      });
    }
    return playerRef.current;
  }, [pushTranscript]);

  // ---- Conversation binding + submission --------------------------------

  const bindConversation = useCallback((newConversationId: string) => {
    conversationIdRef.current = newConversationId;
    setConversationId(newConversationId);
  }, []);

  const draft = useAgentDraftComposer({ onConversationCreated: bindConversation });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const promptConversationRef = useRef(promptConversation);
  promptConversationRef.current = promptConversation;

  /**
   * Shared conversation delivery — no captions. Engine turns already caption
   * via `onHeard`; the composer path captions in `submitComposer`.
   */
  const submitToConversation = useCallback(
    async (text: string, attachments?: ImageAttachment[]): Promise<boolean> => {
      const boundId = conversationIdRef.current;
      const accepted = boundId
        ? await promptConversationRef.current(boundId, text, attachments)
        : await draftRef.current.handleSubmit(text, attachments);
      if (accepted) {
        markAwaitingReply(Date.now());
      } else {
        pushTranscript({ kind: "error", text: "Send: message was not accepted." });
      }
      return accepted;
    },
    [markAwaitingReply, pushTranscript]
  );
  const submitToConversationRef = useRef(submitToConversation);
  submitToConversationRef.current = submitToConversation;

  const submitComposer = useCallback(
    async (text: string, attachments?: ImageAttachment[]): Promise<boolean> => {
      const trimmed = text.trim();
      const caption =
        trimmed ||
        (attachments && attachments.length > 0
          ? `(${attachments.length} attachment${attachments.length === 1 ? "" : "s"})`
          : "");
      if (caption) {
        pushTranscript({ kind: "heard", text: caption });
      }
      setComposerSending(true);
      try {
        return await submitToConversationRef.current(text, attachments);
      } catch (submitError) {
        pushTranscript({
          kind: "error",
          text: `Send: ${
            submitError instanceof Error ? submitError.message : "failed."
          }`,
        });
        return false;
      } finally {
        setComposerSending(false);
      }
    },
    [pushTranscript]
  );

  // ---- Turn engine (epoch + abort + bounded queue) -----------------------

  const engine = useMemo(
    () =>
      new VoiceTurnEngine({
        transcribe: async (clip, signal) => {
          const wav = encodeWavPcm16(clip, VOICE_SAMPLE_RATE);
          const file = new File([wav], "utterance.wav", { type: "audio/wav" });
          const result = await transcribeAudio(file, { signal });
          return result.text;
        },
        submit: async (text) => {
          return submitToConversationRef.current(text);
        },
        onStatus: setEngineStatus,
        onHeard: (text) => {
          pushTranscript({ kind: "heard", text });
        },
        onError: (message, stage) => {
          pushTranscript({
            kind: "error",
            text: `${stage === "transcribe" ? "Transcription" : "Send"}: ${message}`,
          });
        },
      }),
    [pushTranscript]
  );

  // ---- Mic pipeline: capture -> VAD -> endpointer -> engine ---------------

  const handleEndpointerEvents = useCallback(
    (events: EndpointerEvent[]) => {
      for (const event of events) {
        if (event.type === "speech_start") {
          speechActiveRef.current = true;
          setCapturingSpeech(true);
          const player = playerRef.current;
          if (player?.isActive) {
            player.duck();
            if (bargeTimerRef.current) clearTimeout(bargeTimerRef.current);
            bargeTimerRef.current = setTimeout(() => {
              if (speechActiveRef.current && playerRef.current?.isActive) {
                playerRef.current.cancel();
              }
            }, BARGE_IN_CANCEL_MS);
          }
        } else if (event.type === "speech_cancelled") {
          speechActiveRef.current = false;
          setCapturingSpeech(false);
          playerRef.current?.unduck();
          if (bargeTimerRef.current) {
            clearTimeout(bargeTimerRef.current);
            bargeTimerRef.current = null;
          }
        } else if (event.type === "utterance_committed") {
          speechActiveRef.current = false;
          setCapturingSpeech(false);
          if (bargeTimerRef.current) {
            clearTimeout(bargeTimerRef.current);
            bargeTimerRef.current = null;
          }
          playerRef.current?.cancel();
          const capture = captureRef.current;
          if (!capture) continue;
          const clip = capture.clipByMs(event.startMs, event.endMs);
          if (clip.length === 0) continue;
          engine.enqueue({ kind: "clip", clip });
        }
      }
    },
    [engine]
  );

  const teardownCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    endpointerRef.current = null;
    speechActiveRef.current = false;
    setCapturingSpeech(false);
    micLevelRef.current = 0;
    setMicState("off");
    if (bargeTimerRef.current) {
      clearTimeout(bargeTimerRef.current);
      bargeTimerRef.current = null;
    }
    if (capture) {
      void capture.stop().catch(() => {});
    }
  }, []);

  /**
   * Builds the capture pipeline. The capture object is kept even when the
   * microphone is unavailable: `injectPcm16k` still drives the exact same
   * frame path, so text-only and synthetic-audio sessions work without a mic.
   */
  const setupCapture = useCallback(async () => {
    if (captureRef.current) return;
    if (!vadRef.current) {
      vadRef.current = await createBestVad();
    }
    const endpointer = new Endpointer(DEFAULT_ENDPOINTER_CONFIG);
    endpointerRef.current = endpointer;
    const capture = new VoiceCapture({
      onFrame: (frame) => {
        const vad = vadRef.current;
        if (!vad || endpointerRef.current !== endpointer) return;
        const result = vad.process(frame);
        if (typeof result === "number") {
          handleEndpointerEvents(endpointer.processFrame(result));
        } else {
          void result.then((prob) => {
            if (endpointerRef.current !== endpointer) return;
            handleEndpointerEvents(endpointer.processFrame(prob));
          });
        }
      },
      onLevel: (rms) => {
        micLevelRef.current = Math.min(1, rms * 8);
      },
      onError: (captureError) => {
        setMicError(`Capture: ${captureError.message}`);
      },
    });
    captureRef.current = capture;
    setMicState("starting");
    setMicError(null);
    try {
      await capture.start();
      if (captureRef.current !== capture) return;
      setMicState("on");
    } catch (captureError) {
      if (captureRef.current !== capture) return;
      setMicState("error");
      setMicError(
        captureError instanceof Error
          ? `Microphone: ${captureError.message}`
          : "Microphone unavailable."
      );
    }
  }, [handleEndpointerEvents]);

  // ---- Session lifecycle --------------------------------------------------

  const start = useCallback(() => {
    if (viewRef.current !== "closed") {
      setView("full");
      return;
    }
    conversationIdRef.current = null;
    setConversationId(null);
    lastSpokenSeqRef.current = 0;
    markAwaitingReply(null);
    setTranscript([]);
    setMicError(null);
    // Present the fresh draft chat behind the overlay so minimizing shows
    // the voice conversation (or the new-chat landing until the first turn).
    startNewConversation();
    engine.start();
    setView("full");
    void setupCapture();
  }, [engine, markAwaitingReply, setupCapture, startNewConversation]);

  const stop = useCallback(() => {
    engine.stop();
    teardownCapture();
    playerRef.current?.cancel();
    setView("closed");
    conversationIdRef.current = null;
    setConversationId(null);
    markAwaitingReply(null);
  }, [engine, markAwaitingReply, teardownCapture]);

  const minimize = useCallback(() => {
    if (viewRef.current === "full") {
      setView("minimized");
      const boundId = conversationIdRef.current;
      if (boundId) {
        // Ensure the thread behind the dock is the voice conversation.
        setSelectedConversationId(boundId);
      }
    }
  }, [setSelectedConversationId]);

  const expand = useCallback(() => {
    if (viewRef.current === "minimized") {
      setView("full");
    }
  }, []);

  const sendTextUtterance = useCallback(
    (text: string) => {
      engine.enqueue({ kind: "text", text });
    },
    [engine]
  );

  const interruptSpeech = useCallback(() => {
    playerRef.current?.cancel();
  }, []);

  const getOrbLevels = useCallback(() => {
    return {
      mic: micLevelRef.current,
      tts: playerRef.current?.getOutputLevel() ?? 0,
    };
  }, []);

  // Android back: a full-screen session minimizes rather than exiting.
  useBackHandler(view === "full", BACK_INTENT_PRIORITY.overlay, () => {
    minimize();
  });

  // Launch surfaces dispatch window events (keybind, palette, quick action,
  // landing button) so they never need this provider in scope.
  useEffect(() => {
    const onCommand = (event: Event) => {
      if (!isVoiceSessionEvent(event)) return;
      switch (event.detail.command) {
        case "start":
          if (viewRef.current === "minimized") {
            expand();
          } else {
            start();
          }
          break;
        case "stop":
          stop();
          break;
        case "minimize":
          minimize();
          break;
        case "expand":
          expand();
          break;
        case "toggle":
          if (viewRef.current === "closed") {
            start();
          } else if (viewRef.current === "full") {
            minimize();
          } else {
            expand();
          }
          break;
      }
    };
    window.addEventListener(VOICE_SESSION_EVENT, onCommand);
    return () => window.removeEventListener(VOICE_SESSION_EVENT, onCommand);
  }, [expand, minimize, start, stop]);

  // ---- Speak-on-reply: watch the bound conversation's events -------------
  const boundEvents = conversationId
    ? eventsByConversationId[conversationId]
    : undefined;
  useEffect(() => {
    if (!conversationId || !boundEvents || boundEvents.length === 0) return;
    if (viewRef.current === "closed") return;
    for (const event of boundEvents) {
      if (event.seq <= lastSpokenSeqRef.current) continue;
      if (event.kind !== "assistant_message_end") continue;
      lastSpokenSeqRef.current = event.seq;
      markAwaitingReply(null);
      const text = boundEvents
        .filter(
          (candidate) =>
            candidate.kind === "assistant_message_chunk" &&
            candidate.messageId === event.messageId
        )
        .map((candidate) =>
          candidate.kind === "assistant_message_chunk" ? candidate.text : ""
        )
        .join("")
        .trim();
      if (!text) continue;
      pushTranscript({
        kind: "reply",
        text: text.length > 240 ? `${text.slice(0, 237)}...` : text,
      });
      if (speakRepliesRef.current) {
        void getPlayer()
          .speak(text)
          .catch(() => {});
      }
    }
  }, [boundEvents, conversationId, getPlayer, markAwaitingReply, pushTranscript]);

  // ---- Reply reconciliation: close the event-delivery hole ---------------
  // `eventsByConversationId` is fed by socket event batches and by catch-up
  // snapshot polls that stop 5s after submit. Both can fail silently — a dead
  // socket even freezes the conversation's client-side status at "running",
  // so nothing status-driven can be trusted as a trigger. While a reply is
  // pending, poll the snapshot directly (deduped inside
  // syncConversationSnapshot): the merge repopulates events (letting the
  // speak effect fire) and refreshes the conversation status (unsticking the
  // orb). The first poll waits a few seconds so a healthy socket wins.
  useEffect(() => {
    if (awaitingReplySince === null || !conversationId) return;
    const pendingSince = awaitingReplySince;
    const reconcile = () => {
      // A processed reply or a newer submit ends this poller.
      if (awaitingReplySinceRef.current !== pendingSince) return;
      if (Date.now() - pendingSince > REPLY_RECONCILE_MAX_MS) {
        // The turn never produced an assistant_message_end (failed/cancelled
        // or genuinely reply-less); stop polling until the next submit.
        markAwaitingReply(null);
        return;
      }
      void syncConversationSnapshot(conversationId).catch(() => undefined);
    };
    const timer = window.setInterval(reconcile, REPLY_RECONCILE_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [
    awaitingReplySince,
    conversationId,
    markAwaitingReply,
    syncConversationSnapshot,
  ]);

  // Dev/testing hook: drives the session without a microphone.
  useEffect(() => {
    window.__cesiumVoiceSession = {
      start,
      stop,
      minimize,
      expand,
      sendTextUtterance,
      injectPcm16k: (samples: Float32Array) => {
        captureRef.current?.injectPcm16k(samples);
      },
      injectAudio: async (data: ArrayBuffer) => {
        const pcm = await decodeToPcm16k(data);
        captureRef.current?.injectPcm16k(pcm);
      },
      getState: () => ({
        view: viewRef.current,
        status: statusRef.current,
        conversationId: conversationIdRef.current,
        micState: micStateRef.current,
        transcript: transcriptRef.current,
      }),
    };
    return () => {
      delete window.__cesiumVoiceSession;
    };
  }, [expand, minimize, sendTextUtterance, start, stop]);

  useEffect(() => {
    return () => {
      engine.stop();
      teardownCapture();
      playerRef.current?.cancel();
    };
  }, [engine, teardownCapture]);

  const agentWorking = Boolean(
    conversationId && conversationsById[conversationId]?.status === "running"
  );

  const status: SessionOrbStatus = useMemo(() => {
    if (view === "closed") return "idle";
    if (ttsActive) return "speaking";
    if (engineStatus === "transcribing") return "transcribing";
    if (engineStatus === "sending" || composerSending) return "sending";
    if (agentWorking) return "working";
    if (capturingSpeech) return "capturing";
    if (micState === "on") return "listening";
    return "idle";
  }, [
    agentWorking,
    capturingSpeech,
    composerSending,
    engineStatus,
    micState,
    ttsActive,
    view,
  ]);
  statusRef.current = status;

  const value = useMemo<VoiceSessionContextValue>(
    () => ({
      view,
      status,
      conversationId,
      micState,
      micError,
      transcript,
      speakReplies,
      setSpeakReplies,
      start,
      stop,
      minimize,
      expand,
      sendTextUtterance,
      submitComposer,
      interruptSpeech,
      getOrbLevels,
    }),
    [
      view,
      status,
      conversationId,
      micState,
      micError,
      transcript,
      speakReplies,
      start,
      stop,
      minimize,
      expand,
      sendTextUtterance,
      submitComposer,
      interruptSpeech,
      getOrbLevels,
    ]
  );

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}

export function useVoiceSession(): VoiceSessionContextValue {
  const context = useContext(VoiceSessionContext);
  if (!context) {
    throw new Error("useVoiceSession must be used within VoiceSessionProvider");
  }
  return context;
}
