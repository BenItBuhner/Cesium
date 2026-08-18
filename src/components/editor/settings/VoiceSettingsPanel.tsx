"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  PageIntro,
  SettingsCallout,
  SettingsFieldLabel,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
  settingsSelectTriggerClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  deleteVoiceSpeechSettings,
  fetchVoiceSpeechSettings,
  fetchVoiceStatus,
  saveVoiceSpeechSettings,
  type VoiceSpeechFieldSource,
  type VoiceSpeechSettingsPayload,
  type VoiceSpeechSettingsPatch,
  type VoiceStatus,
} from "@/lib/server-api";

const inputClass =
  "box-border min-h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const monoInputClass = `${inputClass} font-mono text-[11px]`;

function sourceLabel(source: VoiceSpeechFieldSource | undefined): string | null {
  switch (source) {
    case "stored":
      return "Saved in Settings";
    case "env":
      return "From environment variables";
    case "file":
      return "From transcription-provider.json";
    case "default":
      return "Built-in default";
    default:
      return null;
  }
}

function statusLine(input: {
  configured: boolean;
  source: VoiceSpeechFieldSource;
  lastFour?: string;
  extra?: string;
}): string {
  if (!input.configured) {
    return input.extra ?? "Not configured";
  }
  const origin = sourceLabel(input.source) ?? "Configured";
  return input.lastFour ? `${origin} · key ···${input.lastFour}` : origin;
}

function VoiceField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  searchId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "url";
  placeholder?: string;
  disabled?: boolean;
  searchId?: string;
}) {
  return (
    <label
      data-settings-search-id={searchId}
      className="flex flex-col gap-[6px] px-[16px] py-[12px] border-b border-[var(--border-subtle)] last:border-b-0"
    >
      <SettingsFieldLabel>{label}</SettingsFieldLabel>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={monoInputClass}
      />
    </label>
  );
}

export function VoiceSettingsPanel() {
  const { settings: globalSettings, updateSettings } = useGlobalSettings();
  const [settings, setSettings] = useState<VoiceSpeechSettingsPayload | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [sttBaseUrl, setSttBaseUrl] = useState("");
  const [sttApiKey, setSttApiKey] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [sttLanguage, setSttLanguage] = useState("");
  const [sttPrompt, setSttPrompt] = useState("");

  const [titleModel, setTitleModel] = useState("");

  const [ttsEngine, setTtsEngine] = useState("");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");

  const [controllerBaseUrl, setControllerBaseUrl] = useState("");
  const [controllerApiKey, setControllerApiKey] = useState("");
  const [controllerModel, setControllerModel] = useState("");

  const applySettings = useCallback((next: VoiceSpeechSettingsPayload) => {
    setSettings(next);
    setSttBaseUrl(next.transcription.baseUrl ?? "");
    setSttModel(next.transcription.model ?? "");
    setSttLanguage(next.transcription.language ?? "");
    setSttPrompt(next.transcription.prompt ?? "");
    setTitleModel(next.titleGeneration.model ?? "");
    setTtsEngine(next.tts.engine ?? "");
    setTtsBaseUrl(next.tts.openaiCompat.baseUrl ?? "");
    setTtsModel(next.tts.openaiCompat.model ?? "");
    setTtsVoice(next.tts.openaiCompat.voice ?? "");
    setControllerBaseUrl(next.controller.baseUrl ?? "");
    setControllerModel(next.controller.model ?? "");
  }, []);

  const refresh = useCallback(async () => {
    const [voice, status] = await Promise.all([
      fetchVoiceSpeechSettings(),
      fetchVoiceStatus().catch(() => null),
    ]);
    applySettings(voice.settings);
    setVoiceStatus(status);
  }, [applySettings]);

  useEffect(() => {
    void refresh().catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load voice settings.");
    });
  }, [refresh]);

  const savePatch = useCallback(
    async (patch: VoiceSpeechSettingsPatch, success: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await saveVoiceSpeechSettings(patch);
        applySettings(result.settings);
        setSttApiKey("");
        setTtsApiKey("");
        setControllerApiKey("");
        setMessage(success);
        const status = await fetchVoiceStatus().catch(() => null);
        setVoiceStatus(status);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to save voice settings.");
      } finally {
        setBusy(false);
      }
    },
    [applySettings]
  );

  const clearAllStored = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteVoiceSpeechSettings();
      applySettings(result.settings);
      setSttApiKey("");
      setTtsApiKey("");
      setControllerApiKey("");
      setMessage(
        result.settings.transcription.source === "env" ||
          result.settings.controller.source === "env" ||
          result.settings.tts.openaiCompat.source === "env"
          ? "Stored voice settings removed. Environment variables are still in effect."
          : "Stored voice settings removed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to clear voice settings.");
    } finally {
      setBusy(false);
    }
  }, [applySettings]);

  const engineOptions = useMemo(() => {
    const engines = voiceStatus?.tts.engines ?? [];
    return [
      { value: "", label: "Automatic (first available)" },
      ...engines.map((engine) => ({
        value: engine.id,
        label: `${engine.label}${engine.available ? "" : " — unavailable"}`,
      })),
    ];
  }, [voiceStatus]);

  return (
    <>
      <PageIntro title="Voice" />
      <p className="mb-[18px] max-w-[640px] font-sans text-[13px] leading-[1.5] text-[var(--text-secondary)]">
        Configure speech-to-text, spoken replies, and the ambient voice controller from the
        app. Environment variables still work as a fallback when a field is left empty.
      </p>
      {message ? (
        <div className="mb-[16px]">
          <SettingsCallout tone="info">{message}</SettingsCallout>
        </div>
      ) : null}

      <SettingsSection title="Speech to text">
        <div className="px-[16px] py-[12px] border-b border-[var(--border-subtle)]">
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {settings
              ? statusLine({
                  configured: settings.transcription.configured,
                  source: settings.transcription.source,
                  lastFour: settings.transcription.apiKeyLastFour,
                })
              : "Loading…"}
          </p>
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Used by the microphone button to turn recordings into composer text. Any
            OpenAI-compatible <span className="font-mono">/audio/transcriptions</span> host
            works — Groq, OpenAI, or a local proxy.
          </p>
        </div>
        <VoiceField
          label="Base URL"
          type="url"
          value={sttBaseUrl}
          onChange={setSttBaseUrl}
          placeholder="https://api.groq.com/openai/v1"
          disabled={busy}
          searchId="transcription-model"
        />
        <VoiceField
          label="API key"
          type="password"
          value={sttApiKey}
          onChange={setSttApiKey}
          placeholder={
            settings?.transcription.apiKeyLastFour
              ? `Stored key ends with ${settings.transcription.apiKeyLastFour}`
              : "Paste a transcription API key"
          }
          disabled={busy}
        />
        <VoiceField
          label="Model"
          value={sttModel}
          onChange={setSttModel}
          placeholder="whisper-large-v3"
          disabled={busy}
          searchId="transcription-model"
        />
        <VoiceField
          label="Language (optional)"
          value={sttLanguage}
          onChange={setSttLanguage}
          placeholder="en"
          disabled={busy}
          searchId="transcription-language"
        />
        <VoiceField
          label="Prompt (optional)"
          value={sttPrompt}
          onChange={setSttPrompt}
          placeholder="Prefer technical terms and code identifiers"
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  transcription: {
                    baseUrl: sttBaseUrl.trim() || null,
                    ...(sttApiKey.trim() ? { apiKey: sttApiKey.trim() } : {}),
                    model: sttModel.trim() || null,
                    language: sttLanguage.trim() || null,
                    prompt: sttPrompt.trim() || null,
                  },
                },
                "Speech-to-text settings saved."
              )
            }
          >
            Save transcription
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Conversation titles">
        <div className="px-[16px] py-[12px] border-b border-[var(--border-subtle)]">
          <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Fallback model for auto-titling new chats when Settings → Agents does not pick a
            catalog model. Uses the same credentials as speech-to-text.
            {settings?.titleGeneration.modelSource
              ? ` Currently ${sourceLabel(settings.titleGeneration.modelSource)?.toLowerCase()}.`
              : ""}
          </p>
        </div>
        <VoiceField
          label="Title generation model"
          value={titleModel}
          onChange={setTitleModel}
          placeholder="openai/gpt-oss-20b"
          disabled={busy}
          searchId="title-model"
        />
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                { titleGeneration: { model: titleModel.trim() || null } },
                "Title generation model saved."
              )
            }
          >
            Save title model
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Text to speech">
        <div className="px-[16px] py-[12px] border-b border-[var(--border-subtle)]">
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {settings
              ? statusLine({
                  configured: settings.tts.openaiCompat.configured,
                  source: settings.tts.openaiCompat.source,
                  lastFour: settings.tts.openaiCompat.apiKeyLastFour,
                  extra: "Local engines work without a remote host",
                })
              : "Loading…"}
          </p>
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Pin a local engine or configure a remote OpenAI-compatible{" "}
            <span className="font-mono">/audio/speech</span> host. Chat/transcription URLs
            are not reused — most proxies do not route speech synthesis.
          </p>
        </div>
        <label
          data-settings-search-id="tts-engine"
          className="flex flex-col gap-[6px] px-[16px] py-[12px] border-b border-[var(--border-subtle)]"
        >
          <SettingsFieldLabel>Preferred engine</SettingsFieldLabel>
          <select
            className={settingsSelectTriggerClass}
            value={ttsEngine}
            aria-label="Preferred TTS engine"
            disabled={busy}
            onChange={(event) => setTtsEngine(event.currentTarget.value)}
          >
            {engineOptions.map((option) => (
              <option key={option.value || "auto"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <VoiceField
          label="Remote TTS base URL"
          type="url"
          value={ttsBaseUrl}
          onChange={setTtsBaseUrl}
          placeholder="https://api.openai.com/v1"
          disabled={busy}
          searchId="tts-remote"
        />
        <VoiceField
          label="Remote TTS API key"
          type="password"
          value={ttsApiKey}
          onChange={setTtsApiKey}
          placeholder={
            settings?.tts.openaiCompat.apiKeyLastFour
              ? `Stored key ends with ${settings.tts.openaiCompat.apiKeyLastFour}`
              : "Paste a TTS API key"
          }
          disabled={busy}
        />
        <VoiceField
          label="Remote TTS model"
          value={ttsModel}
          onChange={setTtsModel}
          placeholder="tts-1"
          disabled={busy}
        />
        <VoiceField
          label="Remote TTS voice"
          value={ttsVoice}
          onChange={setTtsVoice}
          placeholder="alloy"
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  tts: {
                    engine: ttsEngine.trim() || null,
                    openaiCompat: {
                      baseUrl: ttsBaseUrl.trim() || null,
                      ...(ttsApiKey.trim() ? { apiKey: ttsApiKey.trim() } : {}),
                      model: ttsModel.trim() || null,
                      voice: ttsVoice.trim() || null,
                    },
                  },
                },
                "Text-to-speech settings saved."
              )
            }
          >
            Save TTS
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Voice controller">
        <div className="px-[16px] py-[12px] border-b border-[var(--border-subtle)]">
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {settings
              ? statusLine({
                  configured: settings.controller.configured,
                  source: settings.controller.source,
                  lastFour: settings.controller.apiKeyLastFour,
                })
              : "Loading…"}
          </p>
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Fast model used by the ambient voice orb to decide whether to answer, ask a
            clarifying question, or hand off to a full agent conversation.
          </p>
        </div>
        <VoiceField
          label="Base URL"
          type="url"
          value={controllerBaseUrl}
          onChange={setControllerBaseUrl}
          placeholder="https://infer.example.com/v1"
          disabled={busy}
        />
        <VoiceField
          label="API key"
          type="password"
          value={controllerApiKey}
          onChange={setControllerApiKey}
          placeholder={
            settings?.controller.apiKeyLastFour
              ? `Stored key ends with ${settings.controller.apiKeyLastFour}`
              : "Paste a controller API key"
          }
          disabled={busy}
        />
        <VoiceField
          label="Model"
          value={controllerModel}
          onChange={setControllerModel}
          placeholder="glm-5.2"
          disabled={busy}
          searchId="voice-controller"
        />
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  controller: {
                    baseUrl: controllerBaseUrl.trim() || null,
                    ...(controllerApiKey.trim() ? { apiKey: controllerApiKey.trim() } : {}),
                    model: controllerModel.trim() || null,
                  },
                },
                "Voice controller settings saved."
              )
            }
          >
            Save controller
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Voice orb">
        <SettingsRow
          searchId="show-voice-orb"
          title="Voice orb"
          description="Show the floating ambient voice orb. Hiding it also turns the voice plane off. You can also hide it from the orb's long-press menu."
          trailing={
            <ToggleSwitch
              checked={globalSettings.general.showVoiceOrb}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  general: {
                    ...current.general,
                    showVoiceOrb: value,
                  },
                }))
              }
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>

      <SettingsSection title="Stored overrides">
        <div className="flex flex-col gap-[10px] px-[16px] py-[14px]">
          <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Clearing stored settings falls back to{" "}
            <span className="font-mono">OPENCURSOR_TRANSCRIPTION_*</span>,{" "}
            <span className="font-mono">OPENCURSOR_VOICE_*</span>, and{" "}
            <span className="font-mono">OPENCURSOR_TITLE_MODEL</span> if those are set on
            the server.
          </p>
          <div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void clearAllStored()}
            >
              Remove stored voice settings
            </button>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
