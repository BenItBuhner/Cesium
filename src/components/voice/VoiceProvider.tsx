"use client";

/**
 * Global voice control plane provider: owns the ambient microphone
 * pipeline (AudioWorklet -> ring buffer -> VAD -> layered endpointing),
 * speech-to-text, the voice controller turn, clause-streamed TTS with
 * barge-in, the Active/Quiet/Paused mode machine, and the agent event
 * notification policy with digesting. Mounted once, outside ChatComposer.
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
  type VoiceControllerAction,
  type VoiceStatus,
} from "@/lib/server-api";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
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
import { encodeWavPcm16, VOICE_SAMPLE_RATE } from "@/lib/voice/pcm";
import { TtsPlayer, type TtsPlayerState } from "@/lib/voice/tts-player";
import { createBestVad, EnergyVad, type VadEngine } from "@/lib/voice/vad";

export type VoiceMode = "off" | "active" | "quiet" | "paused";

export type VoiceActivity =
  | "idle"
  | "listening"
  | "capturing"
  | "transcribing"
  | "thinking"
  | "speaking";

export type VoiceLogEntry = {
  id: string;
  role: "user" | "assistant" | "event" | "system";
  text: string;
  at: number;
  meta?: string;
  actions?: VoiceControllerAction[];
};

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
  log: VoiceLogEntry[];
  micLevel: number;
  vadEngineId: string | null;
  captureSettings: CaptureTrackSettings | null;
  serverStatus: VoiceStatus | null;
  refreshServerStatus: () => void;
  lastLatency: VoiceLatencySample | null;
  latencyP50Ms: number | null;
  sendTextUtterance: (text: string) => Promise<void>;
  runSelfTest: (text?: string) => Promise<void>;
  selfTestRunning: boolean;
  interrupt: () => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  error: string | null;
  queuedDigestCount: number;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

let entryCounter = 0;
function entryId(): string {
  entryCounter += 1;
  return `voice-${Date.now()}-${entryCounter}`;
}

const MAX_LOG_ENTRIES = 200;
const MAX_HISTORY = 16;
const BARGE_IN_CANCEL_MS = 350;
const SELF_TEST_DEFAULT = "What agent sessions are running right now?";

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { conversations } = useAgentConversations();

  const [mode, setModeState] = useState<VoiceMode>("off");
  const [activity, setActivity] = useState<VoiceActivity>("idle");
  const [log, setLog] = useState<VoiceLogEntry[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [vadEngineId, setVadEngineId] = useState<string | null>(null);
  const [captureSettings, setCaptureSettings] =
    useState<CaptureTrackSettings | null>(null);
  const [serverStatus, setServerStatus] = useState<VoiceStatus | null>(null);
  const [lastLatency, setLastLatency] = useState<VoiceLatencySample | null>(
    null
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [queuedDigestCount, setQueuedDigestCount] = useState(0);

  const modeRef = useRef<VoiceMode>("off");
  const captureRef = useRef<VoiceCapture | null>(null);
  const vadRef = useRef<VadEngine | null>(null);
  const endpointerRef = useRef<Endpointer | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const turnChainRef = useRef<Promise<void>>(Promise.resolve());
  const speechActiveRef = useRef(false);
  const bargeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelUpdatedAtRef = useRef(0);
  const respondSamplesRef = useRef<number[]>([]);
  const digestRef = useRef<VoiceNotification[]>([]);
  const watchedConversationsRef = useRef<Map<string, VoiceWatchedConversation>>(
    new Map()
  );
  const watchedPrimedRef = useRef(false);
  const activityRef = useRef<VoiceActivity>("idle");

  const setActivityBoth = useCallback((next: VoiceActivity) => {
    activityRef.current = next;
    setActivity(next);
  }, []);

  const pushLog = useCallback((entry: Omit<VoiceLogEntry, "id" | "at">) => {
    setLog((previous) => {
      const next = [...previous, { ...entry, id: entryId(), at: Date.now() }];
      return next.length > MAX_LOG_ENTRIES
        ? next.slice(next.length - MAX_LOG_ENTRIES)
        : next;
    });
  }, []);

  const refreshServerStatus = useCallback(() => {
    fetchVoiceStatus()
      .then(setServerStatus)
      .catch((statusError: unknown) => {
        setError(
          statusError instanceof Error
            ? statusError.message
            : "Voice status unavailable."
        );
      });
  }, []);

  useEffect(() => {
    refreshServerStatus();
  }, [refreshServerStatus]);

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
              modeRef.current === "active" || modeRef.current === "quiet"
                ? captureRef.current?.isRunning
                  ? "listening"
                  : "idle"
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

  const drainDigest = useCallback(() => {
    if (digestRef.current.length === 0) return;
    const items = digestRef.current;
    digestRef.current = [];
    setQueuedDigestCount(0);
    const spoken = buildDigestSpokenText(items);
    pushLog({
      role: "event",
      text: items.map((item) => item.displayText).join("\n"),
      meta: `digest of ${items.length} event${items.length === 1 ? "" : "s"}`,
    });
    void speakIfAllowed(spoken);
  }, [pushLog, speakIfAllowed]);

  const applyLocalCommand = useCallback(
    (utterance: string): boolean => {
      const command = parseLocalVoiceCommand(utterance);
      if (!command) return false;
      switch (command.kind) {
        case "stop_speaking":
          getPlayer().cancel();
          pushLog({ role: "system", text: "Playback stopped.", meta: "local command" });
          break;
        case "quiet_mode":
          setMode("quiet");
          pushLog({ role: "system", text: "Quiet mode: still listening and acting, not speaking.", meta: "local command" });
          break;
        case "active_mode":
          setMode("active");
          pushLog({ role: "system", text: "Active mode.", meta: "local command" });
          break;
        case "pause_listening":
          setMode("paused");
          pushLog({ role: "system", text: "Paused: microphone off, no interpretation until resumed.", meta: "local command" });
          break;
        case "resume_listening":
          setMode("active");
          pushLog({ role: "system", text: "Listening resumed.", meta: "local command" });
          break;
      }
      return true;
    },
    // setMode is defined below; ref-stable via useCallback ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getPlayer, pushLog]
  );

  /** Serialized controller turn for one committed/typed utterance. */
  const runUtteranceTurn = useCallback(
    async (input: {
      utteranceText?: string;
      clip?: Float32Array;
      endOfSpeechAt: number;
      source: "mic" | "text" | "self-test";
    }) => {
      const startedAt = performance.now();
      let sttMs: number | null = null;
      let text = input.utteranceText ?? "";

      if (!text && input.clip) {
        setActivityBoth("transcribing");
        const wav = encodeWavPcm16(input.clip, VOICE_SAMPLE_RATE);
        const file = new File([wav], "utterance.wav", { type: "audio/wav" });
        const sttStart = performance.now();
        try {
          const result = await transcribeAudio(file);
          text = result.text.trim();
        } catch (sttError) {
          setError(
            `Transcription: ${sttError instanceof Error ? sttError.message : "failed"}`
          );
          setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
          return;
        }
        sttMs = Math.round(performance.now() - sttStart);
      }
      if (!text) {
        setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
        return;
      }

      pushLog({
        role: "user",
        text,
        meta: [
          input.source === "mic" ? "spoken" : input.source,
          sttMs !== null ? `stt ${sttMs}ms` : null,
        ]
          .filter(Boolean)
          .join(" · "),
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
          mode: modeRef.current === "quiet" ? "quiet" : "active",
        });
        const controllerMs = Math.round(performance.now() - controllerStart);
        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: result.displayText },
        ].slice(-MAX_HISTORY);

        pushLog({
          role: "assistant",
          text: result.displayText,
          actions: result.actions,
          meta: [
            `${result.model}`,
            `llm ${result.llmMs}ms`,
            result.toolRounds > 0
              ? `${result.toolRounds} tool round${result.toolRounds === 1 ? "" : "s"} ${result.toolMs}ms`
              : null,
            result.needsConfirmation ? "awaiting confirmation" : null,
          ]
            .filter(Boolean)
            .join(" · "),
        });

        let ttsFirstAudioMs: number | null = null;
        let respondMs: number | null = null;
        if (modeRef.current === "active" && result.notify === "speak") {
          const speakStart = performance.now();
          await speakIfAllowed(result.spokenText, () => {
            ttsFirstAudioMs = Math.round(performance.now() - speakStart);
            respondMs = Math.round(performance.now() - input.endOfSpeechAt);
            respondSamplesRef.current.push(respondMs);
            setLastLatency({
              sttMs,
              controllerMs,
              ttsFirstAudioMs,
              respondMs,
            });
          });
        }
        setLastLatency({
          sttMs,
          controllerMs,
          ttsFirstAudioMs,
          respondMs,
        });
        // Anything that queued up while the user was mid-interaction now
        // becomes one digest instead of several interruptions.
        drainDigest();
      } catch (controllerError) {
        setError(
          controllerError instanceof Error
            ? controllerError.message
            : "Voice controller failed."
        );
        pushLog({
          role: "system",
          text:
            controllerError instanceof Error
              ? controllerError.message
              : "Voice controller failed.",
          meta: "error",
        });
      } finally {
        if (activityRef.current !== "speaking") {
          setActivityBoth(captureRef.current?.isRunning ? "listening" : "idle");
        }
        void startedAt;
      }
    },
    [applyLocalCommand, drainDigest, pushLog, setActivityBoth, speakIfAllowed]
  );

  const enqueueTurn = useCallback(
    (input: Parameters<typeof runUtteranceTurn>[0]) => {
      turnChainRef.current = turnChainRef.current
        .then(() => runUtteranceTurn(input))
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
            // Barge-in: duck now, cancel if the speech sustains.
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

  const stopCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    endpointerRef.current = null;
    speechActiveRef.current = false;
    if (capture) {
      await capture.stop().catch(() => {});
    }
    setMicLevel(0);
  }, []);

  const startCapture = useCallback(async () => {
    if (captureRef.current?.isRunning) return;
    if (!vadRef.current) {
      const vad = await createBestVad();
      vadRef.current = vad;
      setVadEngineId(vad.id);
    }
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
        const now = performance.now();
        if (now - levelUpdatedAtRef.current > 120) {
          levelUpdatedAtRef.current = now;
          setMicLevel(Math.min(1, rms * 8));
        }
      },
      onSettings: setCaptureSettings,
      onError: (captureError) => setError(`Capture: ${captureError.message}`),
    });
    captureRef.current = capture;
    try {
      await capture.start();
      setActivityBoth("listening");
    } catch (captureError) {
      captureRef.current = null;
      setError(
        captureError instanceof Error
          ? `Microphone: ${captureError.message}`
          : "Microphone unavailable."
      );
      setActivityBoth("idle");
      throw captureError;
    }
  }, [handleEndpointerEvents, setActivityBoth]);

  const setMode = useCallback(
    (nextMode: VoiceMode) => {
      const previous = modeRef.current;
      if (previous === nextMode) return;
      modeRef.current = nextMode;
      setModeState(nextMode);
      setError(null);

      if (nextMode === "off" || nextMode === "paused") {
        // Paused: no audio leaves the machine, no STT, no controller calls.
        void stopCapture();
        playerRef.current?.cancel();
        setActivityBoth("idle");
        return;
      }
      // active | quiet both listen and infer; quiet only suppresses speech.
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
          // Mic failed: stay in the selected mode but idle; the panel's
          // text path still works.
        });
    },
    [drainDigest, setActivityBoth, startCapture, stopCapture]
  );

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
   * STT -> controller -> TTS path a microphone would take.
   */
  const runSelfTest = useCallback(
    async (text?: string) => {
      const utterance = text?.trim() || SELF_TEST_DEFAULT;
      setSelfTestRunning(true);
      setError(null);
      try {
        pushLog({
          role: "system",
          text: `Self-test: synthesizing "${utterance}" and running it through the ambient pipeline.`,
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
        // Pad with 2s of silence so the endpointer is guaranteed to commit.
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
          pushLog({
            role: "system",
            text: "Self-test failed: the endpointer never committed an utterance.",
            meta: "self-test",
          });
          return;
        }
        pushLog({
          role: "system",
          text: `Endpointer committed ${(committed.endMs - committed.startMs) / 1000}s clip (${committed.reason}) via ${vad.id} VAD; sending to STT.`,
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
    [enqueueTurn, pushLog]
  );

  const interrupt = useCallback(() => {
    playerRef.current?.cancel();
  }, []);

  // ---- Agent event observation -> notification policy -> digest ----
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
        activityRef.current === "capturing" ||
        activityRef.current === "transcribing" ||
        activityRef.current === "thinking" ||
        activityRef.current === "speaking" ||
        speechActiveRef.current;
      if (
        notification.policy === "speak" &&
        modeRef.current === "active" &&
        !busy
      ) {
        pushLog({
          role: "event",
          text: notification.displayText,
          meta: notification.kind,
        });
        void speakIfAllowed(notification.spokenText);
      } else if (notification.policy === "show") {
        pushLog({
          role: "event",
          text: notification.displayText,
          meta: notification.kind,
        });
      } else {
        // Queue for the next digest (also used when busy or in quiet mode).
        digestRef.current = [...digestRef.current, notification];
        setQueuedDigestCount(digestRef.current.length);
      }
    }
  }, [conversations, pushLog, speakIfAllowed]);

  // Teardown on unmount.
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
      log,
      micLevel,
      vadEngineId,
      captureSettings,
      serverStatus,
      refreshServerStatus,
      lastLatency,
      latencyP50Ms,
      sendTextUtterance,
      runSelfTest,
      selfTestRunning,
      interrupt,
      panelOpen,
      setPanelOpen,
      error,
      queuedDigestCount,
    }),
    [
      mode,
      activity,
      setMode,
      log,
      micLevel,
      vadEngineId,
      captureSettings,
      serverStatus,
      refreshServerStatus,
      lastLatency,
      latencyP50Ms,
      sendTextUtterance,
      runSelfTest,
      selfTestRunning,
      interrupt,
      panelOpen,
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
