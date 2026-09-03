"use client";

/**
 * Global voice control plane provider: owns the ambient microphone
 * pipeline (AudioWorklet -> ring buffer -> VAD -> layered endpointing),
 * speech-to-text, the voice controller turn (with harness-style context
 * compaction so sessions run indefinitely), clause-streamed TTS with
 * barge-in, the Active/Quiet/Paused mode machine, the agent event
 * notification policy with digesting, and workspace control (the
 * controller can open/present sessions in the user's UI).
 *
 * The interface is deliberately non-textual: an ambient orb plus
 * transient spoken captions (bubbles), not a chat log.
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
import {
  fetchVoiceStatus,
  runVoiceControllerTurn,
  synthesizeVoiceSpeech,
  transcribeAudio,
  type VoiceStatus,
} from "@/lib/server-api";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { VoiceCapture, type CaptureTrackSettings } from "@/lib/voice/capture";
import { decodeToPcm16k } from "@/lib/voice/audio-decode";
import {
  DEFAULT_ENDPOINTER_CONFIG,
  Endpointer,
  type EndpointerEvent,
} from "@/lib/voice/endpointing";
import { parseLocalVoiceCommand } from "@/lib/voice/local-commands";
import {
  buildDigestSpokenText,
  diffConversationsForNotifications,
  type VoiceNotification,
  type VoiceWatchedConversation,
} from "@/lib/voice/notification-policy";
import {
  BUBBLE_TTL_MS,
  pruneBubbles,
  type VoiceBubble,
  type VoiceBubbleKind,
} from "@/lib/voice/orb-utils";
import { encodeWavPcm16, VOICE_SAMPLE_RATE } from "@/lib/voice/pcm";
import { TtsPlayer, type TtsPlayerState } from "@/lib/voice/tts-player";
import { createBestVad, EnergyVad, type VadEngine } from "@/lib/voice/vad";

export type VoiceMode = "off" | "active" | "quiet" | "paused";

/** Idle = no capture should run. Takes the mode as a parameter so callers get an un-narrowed comparison (refs read after an await stay narrowed and trip TS2367). */
function isIdleVoiceMode(mode: VoiceMode): boolean {
  return mode === "off" || mode === "paused";
}

export type VoiceActivity =
  | "idle"
  | "listening"
  | "capturing"
  | "transcribing"
  | "thinking"
  | "speaking";

export type VoiceLatencySample = {
  sttMs: number | null;
  controllerMs: number;
  ttsFirstAudioMs: number | null;
  /** End of speech (or submit) to first audible TTS sample. */
  respondMs: number | null;
};

type VoiceContextValue = {
  mode: VoiceMode;
  activity: VoiceActivity;
  setMode: (mode: VoiceMode) => void;
  bubbles: VoiceBubble[];
  dismissBubble: (id: string) => void;
  /** Live animation levels for the orb (mic + TTS output), ref-safe. */
  getOrbLevels: () => { mic: number; tts: number };
  vadEngineId: string | null;
  captureSettings: CaptureTrackSettings | null;
  serverStatus: VoiceStatus | null;
  lastLatency: VoiceLatencySample | null;
  latencyP50Ms: number | null;
  memory: { turns: number; compactions: number };
  sendTextUtterance: (text: string) => Promise<void>;
  runSelfTest: (text?: string) => Promise<void>;
  selfTestRunning: boolean;
  interrupt: () => void;
  error: string | null;
  queuedDigestCount: number;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

let bubbleCounter = 0;
function nextBubbleId(): string {
  bubbleCounter += 1;
  return `vb-${Date.now()}-${bubbleCounter}`;
}

const BARGE_IN_CANCEL_MS = 350;
const SELF_TEST_DEFAULT = "What agent sessions are running right now?";

declare global {
  interface Window {
    __cesiumVoice?: {
      setMode: (mode: VoiceMode) => void;
      sendTextUtterance: (text: string) => Promise<void>;
      runSelfTest: (text?: string) => Promise<void>;
      interrupt: () => void;
    };
  }
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const {
    conversations,
    conversationsById,
    flushAgentSubscription,
    syncConversationSnapshot,
  } = useAgentConversations();
  const { updateWorkspaceSession } = useWorkspace();

  const [mode, setModeState] = useState<VoiceMode>("off");
  const [activity, setActivity] = useState<VoiceActivity>("idle");
  const [bubbles, setBubbles] = useState<VoiceBubble[]>([]);
  const [vadEngineId, setVadEngineId] = useState<string | null>(null);
  const [captureSettings, setCaptureSettings] =
    useState<CaptureTrackSettings | null>(null);
  const [serverStatus, setServerStatus] = useState<VoiceStatus | null>(null);
  const [lastLatency, setLastLatency] = useState<VoiceLatencySample | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [queuedDigestCount, setQueuedDigestCount] = useState(0);
  const [memory, setMemory] = useState({ turns: 0, compactions: 0 });

  const modeRef = useRef<VoiceMode>("off");
  /** Bumped when the voice plane turns off/paused; stale turns bail out. */
  const turnEpochRef = useRef(0);
  const captureRef = useRef<VoiceCapture | null>(null);
  /** Invalidates in-flight VAD load / getUserMedia when the plane turns off. */
  const captureEpochRef = useRef(0);
  const captureStartingRef = useRef(false);
  const vadRef = useRef<VadEngine | null>(null);
  const endpointerRef = useRef<Endpointer | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const summaryRef = useRef<string | null>(null);
  const turnChainRef = useRef<Promise<void>>(Promise.resolve());
  const speechActiveRef = useRef(false);
  const bargeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micLevelRef = useRef(0);
  const respondSamplesRef = useRef<number[]>([]);
  const digestRef = useRef<VoiceNotification[]>([]);
  const watchedConversationsRef = useRef<Map<string, VoiceWatchedConversation>>(
    new Map()
  );
  const watchedPrimedRef = useRef(false);
  const activityRef = useRef<VoiceActivity>("idle");
  const conversationsByIdRef = useRef(conversationsById);
  conversationsByIdRef.current = conversationsById;

  const setActivityBoth = useCallback((next: VoiceActivity) => {
    activityRef.current = next;
    setActivity(next);
  }, []);

  const pushBubble = useCallback(
    (bubble: { kind: VoiceBubbleKind; text: string; meta?: string }) => {
      const now = Date.now();
      setBubbles((previous) =>
        pruneBubbles(
          [
            ...previous,
            {
              id: nextBubbleId(),
              kind: bubble.kind,
              text: bubble.text,
              ...(bubble.meta ? { meta: bubble.meta } : {}),
              at: now,
              expiresAt: now + BUBBLE_TTL_MS[bubble.kind],
            },
          ],
          now
        )
      );
    },
    []
  );

  const dismissBubble = useCallback((id: string) => {
    setBubbles((previous) => previous.filter((bubble) => bubble.id !== id));
  }, []);

  // Expire bubbles on a coarse tick.
  useEffect(() => {
    if (bubbles.length === 0) return;
    const timer = setInterval(() => {
      setBubbles((previous) => pruneBubbles(previous, Date.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, [bubbles.length]);

  useEffect(() => {
    fetchVoiceStatus()
      .then(setServerStatus)
      .catch(() => {
        setError("Voice status unavailable.");
      });
  }, []);

  const getPlayer = useCallback((): TtsPlayer => {
    if (!playerRef.current) {
      playerRef.current = new TtsPlayer({
        synthesize: async (text, signal) => {
          const result = await synthesizeVoiceSpeech({ text }, { signal });
          return result.audio;
        },
        onStateChange: (state: TtsPlayerState) => {
          if (state === "speaking") {
            setActivityBoth("speaking");
          } else if (state === "idle" && activityRef.current === "speaking") {
            setActivityBoth(
              (modeRef.current === "active" || modeRef.current === "quiet") &&
                captureRef.current?.isRunning
                ? "listening"
                : "idle"
            );
          }
        },
        onError: (playerError) => {
          setError(`TTS: ${playerError.message}`);
        },
      });
    }
    return playerRef.current;
  }, [setActivityBoth]);

  const getOrbLevels = useCallback(() => {
    return {
      mic: micLevelRef.current,
      tts: playerRef.current?.getOutputLevel() ?? 0,
    };
  }, []);

  const speakIfAllowed = useCallback(
    async (text: string, onFirstAudio?: () => void) => {
      if (modeRef.current !== "active" || !text.trim()) return;
      await getPlayer().speak(
        text,
        onFirstAudio ? { onFirstAudio } : undefined
      );
    },
    [getPlayer]
  );

  /** Voice-plane control of the user's workspace: open/present a session. */
  const openConversationInWorkbench = useCallback(
    (conversationId: string): string | null => {
      const record = conversationsByIdRef.current[conversationId];
      updateWorkspaceSession((current) => {
        const existing = current.chat.tabs.find(
          (tab) => tab.id === conversationId
        );
        const nextTabs = current.chat.tabs.map((tab) => ({
          ...tab,
          active: tab.id === conversationId,
        }));
        if (!existing) {
          nextTabs.push({
            id: conversationId,
            title: record?.title ?? "Conversation",
            active: true,
          });
        }
        return {
          ...current,
          chat: { ...current.chat, tabs: nextTabs },
        };
      });
      flushAgentSubscription([conversationId]);
      void syncConversationSnapshot(conversationId, {
        hydrateRuntime: true,
      }).catch(() => undefined);
      return record?.title ?? null;
    },
    [flushAgentSubscription, syncConversationSnapshot, updateWorkspaceSession]
  );

  const drainDigest = useCallback(() => {
    if (digestRef.current.length === 0) return;
    const items = digestRef.current;
    digestRef.current = [];
    setQueuedDigestCount(0);
    const spoken = buildDigestSpokenText(items);
    pushBubble({
      kind: "event",
      text: spoken,
      meta: `digest · ${items.length} event${items.length === 1 ? "" : "s"}`,
    });
    void speakIfAllowed(spoken);
  }, [pushBubble, speakIfAllowed]);

  // Breaks the applyLocalCommand -> setMode -> startCapture ->
  // handleEndpointerEvents -> enqueueTurn -> applyLocalCommand cycle without
  // relying on late-bound closure resolution: local commands dispatch through
  // this ref, assigned once `setMode` exists.
  const setModeFnRef = useRef<(mode: VoiceMode) => void>(() => {});

  const applyLocalCommand = useCallback(
    (utterance: string): boolean => {
      const command = parseLocalVoiceCommand(utterance);
      if (!command) return false;
      switch (command.kind) {
        case "stop_speaking":
          getPlayer().cancel();
          pushBubble({ kind: "system", text: "Stopped.", meta: "local" });
          break;
        case "quiet_mode":
          setModeFnRef.current("quiet");
          pushBubble({ kind: "system", text: "Going quiet - still listening and acting.", meta: "local" });
          break;
        case "active_mode":
          setModeFnRef.current("active");
          pushBubble({ kind: "system", text: "Voice back on.", meta: "local" });
          break;
        case "pause_listening":
          setModeFnRef.current("paused");
          pushBubble({ kind: "system", text: "Paused - microphone off.", meta: "local" });
          break;
        case "resume_listening":
          setModeFnRef.current("active");
          pushBubble({ kind: "system", text: "Listening again.", meta: "local" });
          break;
      }
      return true;
    },
    [getPlayer, pushBubble]
  );

  /** Serialized controller turn for one committed/typed utterance. */
  const runUtteranceTurn = useCallback(
    async (input: {
      utteranceText?: string;
      clip?: Float32Array;
      endOfSpeechAt: number;
      source: "mic" | "text" | "self-test";
    }) => {
      let sttMs: number | null = null;
      let text = input.utteranceText ?? "";
      const epochAtStart = turnEpochRef.current;
      const stale = () => turnEpochRef.current !== epochAtStart;
      console.debug(
        "[voice] turn start",
        input.source,
        "clipSamples:",
        input.clip?.length ?? 0
      );

      if (!text && input.clip) {
        setActivityBoth("transcribing");
        const wav = encodeWavPcm16(input.clip, VOICE_SAMPLE_RATE);
        const file = new File([wav], "utterance.wav", { type: "audio/wav" });
        const sttStart = performance.now();
        try {
          const result = await transcribeAudio(file);
          text = result.text.trim();
          console.debug(
            "[voice] stt ok:",
            `${text.length} chars in ${Math.round(performance.now() - sttStart)}ms`
          );
        } catch (sttError) {
          console.debug("[voice] stt failed:", sttError);
          const message = `Transcription: ${sttError instanceof Error ? sttError.message : "failed"}`;
          setError(message);
          pushBubble({ kind: "error", text: message, meta: "stt" });
          setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
          return;
        }
        sttMs = Math.round(performance.now() - sttStart);
      }
      if (stale()) {
        console.debug("[voice] turn dropped: mode changed during STT");
        return;
      }
      if (!text) {
        setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
        return;
      }

      pushBubble({
        kind: "heard",
        text,
        meta: sttMs !== null ? `heard · ${sttMs}ms` : input.source,
      });

      if (applyLocalCommand(text)) {
        setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
        return;
      }

      setActivityBoth("thinking");
      const controllerStart = performance.now();
      try {
        const { result } = await runVoiceControllerTurn({
          utterance: text,
          history: historyRef.current,
          summary: summaryRef.current,
          mode: modeRef.current === "quiet" ? "quiet" : "active",
        });
        const controllerMs = Math.round(performance.now() - controllerStart);
        if (stale()) {
          console.debug("[voice] turn dropped: mode changed during controller");
          return;
        }
        console.debug(
          "[voice] controller ok:",
          `${controllerMs}ms`,
          "actions:",
          result.actions.map((action) => action.tool).join(",") || "none",
          "open:",
          result.openConversationId ?? "no",
          "compaction:",
          result.compaction
            ? `${result.compaction.compressedTurnCount} folded`
            : "no"
        );

        // Harness-style compaction: adopt the server's folded memory.
        if (result.compaction) {
          historyRef.current = result.compaction.history;
          summaryRef.current = result.compaction.summary;
          setMemory((previous) => ({
            turns: 0,
            compactions: previous.compactions + 1,
          }));
          pushBubble({
            kind: "system",
            text: `Memory compacted: ${result.compaction.compressedTurnCount} older turns folded into the running summary (${result.compaction.estimatedTokensBefore} → ${result.compaction.estimatedTokensAfter} est. tokens).`,
            meta: "compaction",
          });
        }
        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: result.displayText },
        ];
        setMemory((previous) => ({
          turns: historyRef.current.filter((entry) => entry.role === "user")
            .length,
          compactions: previous.compactions,
        }));

        const actionsMeta = result.actions
          .map((action) => `${action.tool}${action.ok ? "" : "✗"}`)
          .join(" · ");
        pushBubble({
          kind: "assistant",
          text: result.displayText,
          meta:
            [actionsMeta, `${result.model} ${result.llmMs}ms`]
              .filter(Boolean)
              .join(" · ") || undefined,
        });

        // Workspace control: the controller can present sessions in the UI.
        if (result.openConversationId) {
          const title = openConversationInWorkbench(result.openConversationId);
          pushBubble({
            kind: "system",
            text: `Opened ${title ?? "the session"} in your workspace.`,
            meta: "app control",
          });
        }

        if (modeRef.current === "active" && result.notify === "speak") {
          const speakStart = performance.now();
          await speakIfAllowed(result.spokenText, () => {
            const respondMs = Math.round(
              performance.now() - input.endOfSpeechAt
            );
            respondSamplesRef.current.push(respondMs);
            setLastLatency({
              sttMs,
              controllerMs,
              ttsFirstAudioMs: Math.round(performance.now() - speakStart),
              respondMs,
            });
          });
        } else {
          setLastLatency({
            sttMs,
            controllerMs,
            ttsFirstAudioMs: null,
            respondMs: null,
          });
        }
        drainDigest();
      } catch (controllerError) {
        if (stale()) {
          return;
        }
        const message =
          controllerError instanceof Error
            ? controllerError.message
            : "Voice controller failed.";
        setError(message);
        pushBubble({ kind: "error", text: message, meta: "controller" });
      } finally {
        if (activityRef.current !== "speaking") {
          setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
        }
      }
    },
    [
      applyLocalCommand,
      drainDigest,
      openConversationInWorkbench,
      pushBubble,
      setActivityBoth,
      speakIfAllowed,
    ]
  );

  const enqueueTurn = useCallback(
    (input: Parameters<typeof runUtteranceTurn>[0]) => {
      const epochAtEnqueue = turnEpochRef.current;
      turnChainRef.current = turnChainRef.current
        .then(() => {
          // Queued utterances from before a stop/pause never replay.
          if (turnEpochRef.current !== epochAtEnqueue) {
            console.debug("[voice] queued turn dropped: stale epoch");
            return;
          }
          return runUtteranceTurn(input);
        })
        .catch(() => {});
      return turnChainRef.current;
    },
    [runUtteranceTurn]
  );

  const handleEndpointerEvents = useCallback(
    (events: EndpointerEvent[]) => {
      for (const event of events) {
        if (event.type === "speech_start") {
          speechActiveRef.current = true;
          setActivityBoth("capturing");
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
          playerRef.current?.unduck();
          if (bargeTimerRef.current) {
            clearTimeout(bargeTimerRef.current);
            bargeTimerRef.current = null;
          }
          if (activityRef.current === "capturing") {
            setActivityBoth("listening");
          }
        } else if (event.type === "utterance_committed") {
          speechActiveRef.current = false;
          if (bargeTimerRef.current) {
            clearTimeout(bargeTimerRef.current);
            bargeTimerRef.current = null;
          }
          playerRef.current?.cancel();
          const capture = captureRef.current;
          if (!capture) continue;
          const clip = capture.clipByMs(event.startMs, event.endMs);
          if (clip.length === 0) continue;
          void enqueueTurn({
            clip,
            endOfSpeechAt: performance.now(),
            source: "mic",
          });
        }
      }
    },
    [enqueueTurn, setActivityBoth]
  );

  const discardCaptureIfStale = useCallback(
    async (capture: VoiceCapture, epoch: number) => {
      const stale =
        epoch !== captureEpochRef.current ||
        captureRef.current !== capture ||
        isIdleVoiceMode(modeRef.current);
      if (!stale) return false;
      await capture.stop().catch(() => {});
      if (captureRef.current === capture) {
        captureRef.current = null;
      }
      return true;
    },
    []
  );

  const stopCapture = useCallback(async () => {
    captureEpochRef.current += 1;
    captureStartingRef.current = false;
    const capture = captureRef.current;
    captureRef.current = null;
    endpointerRef.current = null;
    speechActiveRef.current = false;
    micLevelRef.current = 0;
    if (capture) {
      await capture.stop().catch(() => {});
    }
  }, []);

  const startCapture = useCallback(async () => {
    if (captureRef.current?.isRunning || captureStartingRef.current) return;
    const epoch = captureEpochRef.current;
    if (isIdleVoiceMode(modeRef.current)) return;
    captureStartingRef.current = true;
    try {
      if (!vadRef.current) {
        const vad = await createBestVad();
        if (epoch !== captureEpochRef.current) return;
        vadRef.current = vad;
        setVadEngineId(vad.id);
      }
      if (epoch !== captureEpochRef.current) return;
      // The ref can be mutated during the awaited VAD init, but TS keeps the
      // narrowing from the guard above and rejects direct comparisons as
      // impossible (TS2367); the helper's parameter is never narrowed.
      if (isIdleVoiceMode(modeRef.current)) return;
      const endpointer = new Endpointer(DEFAULT_ENDPOINTER_CONFIG);
      endpointerRef.current = endpointer;
      const capture = new VoiceCapture({
        onFrame: (frame) => {
          const vad = vadRef.current ?? new EnergyVad();
          const result = vad.process(frame);
          if (typeof result === "number") {
            handleEndpointerEvents(endpointer.processFrame(result));
          } else {
            void result.then((prob) => {
              handleEndpointerEvents(endpointer.processFrame(prob));
            });
          }
        },
        onLevel: (rms) => {
          micLevelRef.current = Math.min(1, rms * 8);
        },
        onSettings: setCaptureSettings,
        onError: (captureError) => setError(`Capture: ${captureError.message}`),
      });
      captureRef.current = capture;
      try {
        await capture.start();
        if (await discardCaptureIfStale(capture, epoch)) return;
        setActivityBoth("listening");
      } catch (captureError) {
        if (epoch !== captureEpochRef.current) return;
        captureRef.current = null;
        setError(
          captureError instanceof Error
            ? `Microphone: ${captureError.message}`
            : "Microphone unavailable."
        );
        setActivityBoth("idle");
        throw captureError;
      }
    } finally {
      if (epoch === captureEpochRef.current) {
        captureStartingRef.current = false;
      }
    }
  }, [discardCaptureIfStale, handleEndpointerEvents, setActivityBoth]);

  const setMode = useCallback(
    (nextMode: VoiceMode) => {
      const previous = modeRef.current;
      if (previous === nextMode) {
        // Hiding the orb calls off even when already off so an in-flight
        // start (VAD load / getUserMedia) cannot come up after the toggle.
        if (nextMode === "off" || nextMode === "paused") {
          turnEpochRef.current += 1;
          void stopCapture();
          playerRef.current?.cancel();
          setActivityBoth("idle");
        }
        return;
      }
      modeRef.current = nextMode;
      setModeState(nextMode);
      setError(null);

      if (nextMode === "off" || nextMode === "paused") {
        // Invalidate in-flight turns: STT/controller results from before this
        // point must not surface bubbles, history, or speech afterwards.
        turnEpochRef.current += 1;
        void stopCapture();
        playerRef.current?.cancel();
        setActivityBoth("idle");
        return;
      }
      if (nextMode === "quiet") {
        playerRef.current?.cancel();
      }
      void startCapture()
        .then(() => {
          if (previous === "off" && digestRef.current.length > 0) {
            drainDigest();
          }
        })
        .catch(() => {
          // Mic unavailable: mode stays selected; programmatic utterances
          // and the self-test still work.
        });
    },
    [drainDigest, setActivityBoth, startCapture, stopCapture]
  );
  setModeFnRef.current = setMode;

  const sendTextUtterance = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await enqueueTurn({
        utteranceText: trimmed,
        endOfSpeechAt: performance.now(),
        source: "text",
      });
    },
    [enqueueTurn]
  );

  /**
   * Pipeline self-test: synthesizes a spoken utterance with the active TTS
   * engine, then feeds the raw PCM through the same VAD -> endpointing ->
   * STT -> controller path a microphone would take.
   */
  const runSelfTest = useCallback(
    async (text?: string) => {
      const utterance = text?.trim() || SELF_TEST_DEFAULT;
      setSelfTestRunning(true);
      setError(null);
      try {
        pushBubble({
          kind: "system",
          text: `Self-test: speaking "${utterance}" through the ambient pipeline.`,
          meta: "self-test",
        });
        const synthesized = await synthesizeVoiceSpeech({ text: utterance });
        const pcm = await decodeToPcm16k(synthesized.audio);
        if (!vadRef.current) {
          const vad = await createBestVad();
          vadRef.current = vad;
          setVadEngineId(vad.id);
        }
        const vad = vadRef.current;
        vad.reset();
        const endpointer = new Endpointer(DEFAULT_ENDPOINTER_CONFIG);
        const padded = new Float32Array(pcm.length + VOICE_SAMPLE_RATE * 2);
        padded.set(pcm);
        let committed: { startMs: number; endMs: number; reason: string } | null =
          null;
        for (
          let offset = 0;
          offset + 512 <= padded.length && !committed;
          offset += 512
        ) {
          const prob = await vad.process(padded.subarray(offset, offset + 512));
          for (const event of endpointer.processFrame(prob)) {
            if (event.type === "utterance_committed") {
              committed = {
                startMs: event.startMs,
                endMs: event.endMs,
                reason: event.reason,
              };
            }
          }
        }
        vad.reset();
        if (!committed) {
          pushBubble({
            kind: "error",
            text: "Self-test: the endpointer never committed an utterance.",
            meta: "self-test",
          });
          return;
        }
        pushBubble({
          kind: "system",
          text: `Endpointer committed a ${((committed.endMs - committed.startMs) / 1000).toFixed(1)}s clip (${committed.reason}) via ${vad.id} VAD.`,
          meta: "self-test",
        });
        const from = Math.floor((committed.startMs / 1000) * VOICE_SAMPLE_RATE);
        const to = Math.min(
          padded.length,
          Math.ceil((committed.endMs / 1000) * VOICE_SAMPLE_RATE)
        );
        await enqueueTurn({
          clip: padded.slice(from, to),
          endOfSpeechAt: performance.now(),
          source: "self-test",
        });
      } catch (selfTestError) {
        setError(
          selfTestError instanceof Error
            ? `Self-test: ${selfTestError.message}`
            : "Self-test failed."
        );
      } finally {
        setSelfTestRunning(false);
      }
    },
    [enqueueTurn, pushBubble]
  );

  const interrupt = useCallback(() => {
    playerRef.current?.cancel();
  }, []);

  // ---- Agent event observation -> notification policy -> bubbles ----
  useEffect(() => {
    const watchable: VoiceWatchedConversation[] = conversations.map(
      (conversation) => ({
        id: conversation.id,
        title: conversation.title,
        status: conversation.status,
        pendingPermissionTitle:
          conversation.pendingPermission?.title ??
          (conversation.pendingPermission ? "a pending action" : null),
        pendingQuestion: Boolean(conversation.pendingQuestion),
        lastError: conversation.lastError,
      })
    );
    if (!watchedPrimedRef.current) {
      watchedPrimedRef.current = true;
      watchedConversationsRef.current = new Map(
        watchable.map((record) => [record.id, record])
      );
      return;
    }
    const notifications = diffConversationsForNotifications(
      watchedConversationsRef.current,
      watchable
    );
    watchedConversationsRef.current = new Map(
      watchable.map((record) => [record.id, record])
    );
    if (notifications.length === 0 || modeRef.current === "off") return;

    for (const notification of notifications) {
      const busy =
        activityRef.current !== "idle" && activityRef.current !== "listening";
      if (
        notification.policy === "speak" &&
        modeRef.current === "active" &&
        !busy &&
        !speechActiveRef.current
      ) {
        pushBubble({
          kind: "event",
          text: notification.spokenText,
          meta: notification.kind,
        });
        void speakIfAllowed(notification.spokenText);
      } else if (notification.policy === "show") {
        pushBubble({
          kind: "event",
          text: notification.spokenText,
          meta: notification.kind,
        });
      } else {
        digestRef.current = [...digestRef.current, notification];
        setQueuedDigestCount(digestRef.current.length);
      }
    }
  }, [conversations, pushBubble, speakIfAllowed]);

  // Dev/scripting hook: lets tooling drive the voice plane without a mic.
  useEffect(() => {
    window.__cesiumVoice = {
      setMode,
      sendTextUtterance,
      runSelfTest,
      interrupt,
    };
    return () => {
      delete window.__cesiumVoice;
    };
  }, [interrupt, runSelfTest, sendTextUtterance, setMode]);

  useEffect(() => {
    return () => {
      void stopCapture();
      playerRef.current?.cancel();
      if (bargeTimerRef.current) clearTimeout(bargeTimerRef.current);
    };
  }, [stopCapture]);

  const latencyP50Ms = useMemo(() => {
    const samples = [...respondSamplesRef.current].sort((a, b) => a - b);
    if (samples.length === 0) return null;
    return samples[Math.floor(samples.length / 2)] ?? null;
    // lastLatency changes whenever a new sample lands.
  }, [lastLatency]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<VoiceContextValue>(
    () => ({
      mode,
      activity,
      setMode,
      bubbles,
      dismissBubble,
      getOrbLevels,
      vadEngineId,
      captureSettings,
      serverStatus,
      lastLatency,
      latencyP50Ms,
      memory,
      sendTextUtterance,
      runSelfTest,
      selfTestRunning,
      interrupt,
      error,
      queuedDigestCount,
    }),
    [
      mode,
      activity,
      setMode,
      bubbles,
      dismissBubble,
      getOrbLevels,
      vadEngineId,
      captureSettings,
      serverStatus,
      lastLatency,
      latencyP50Ms,
      memory,
      sendTextUtterance,
      runSelfTest,
      selfTestRunning,
      interrupt,
      error,
      queuedDigestCount,
    ]
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceContextValue {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error("useVoice must be used within VoiceProvider");
  }
  return context;
}
