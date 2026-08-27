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
  clearVoiceClientSettings,
  loadVoiceClientSettings,
  saveVoiceClientSettings,
  setVoicePreferredSource,
  toPublicVoiceClientSettings,
  type VoiceSettingsSourcePreference,
} from "@cesium/client";
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

type VoiceScope = "client" | "server";

type VoiceDraft = {
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
  sttLanguage: string;
  sttPrompt: string;
  titleModel: string;
  ttsEngine: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  controllerBaseUrl: string;
  controllerApiKey: string;
  controllerModel: string;
};

const EMPTY_DRAFT: VoiceDraft = {
  sttBaseUrl: "",
  sttApiKey: "",
  sttModel: "",
  sttLanguage: "",
  sttPrompt: "",
  titleModel: "",
  ttsEngine: "",
  ttsBaseUrl: "",
  ttsApiKey: "",
  ttsModel: "",
  ttsVoice: "",
  controllerBaseUrl: "",
  controllerApiKey: "",
  controllerModel: "",
};

function sourceLabel(source: VoiceSpeechFieldSource | undefined): string | null {
  switch (source) {
    case "stored":
      return "Saved";
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

function draftFromSettings(next: VoiceSpeechSettingsPayload): VoiceDraft {
  return {
    ...EMPTY_DRAFT,
    sttBaseUrl: next.transcription.baseUrl ?? "",
    sttModel: next.transcription.model ?? "",
    sttLanguage: next.transcription.language ?? "",
    sttPrompt: next.transcription.prompt ?? "",
    titleModel: next.titleGeneration.model ?? "",
    ttsEngine: next.tts.engine ?? "",
    ttsBaseUrl: next.tts.openaiCompat.baseUrl ?? "",
    ttsModel: next.tts.openaiCompat.model ?? "",
    ttsVoice: next.tts.openaiCompat.voice ?? "",
    controllerBaseUrl: next.controller.baseUrl ?? "",
    controllerModel: next.controller.model ?? "",
  };
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

function ScopeToggle({
  value,
  onChange,
  serverAvailable,
}: {
  value: VoiceScope;
  onChange: (scope: VoiceScope) => void;
  serverAvailable: boolean;
}) {
  return (
    <div
      className="mb-[16px] inline-flex rounded-[var(--radius-tab)] bg-[var(--bg-card)] p-[3px]"
      role="tablist"
      aria-label="Voice settings scope"
    >
      {(
        [
          { id: "client", label: "Client / account" },
          { id: "server", label: serverAvailable ? "Server" : "Server (offline)" },
        ] as const
      ).map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-settings-search-id={
              option.id === "client" ? "voice-scope-client" : "voice-scope-server"
            }
            onClick={() => onChange(option.id)}
            className={`rounded-[calc(var(--radius-tab)-2px)] px-[12px] py-[5px] font-sans text-[12px] transition-colors ${
              active
                ? "bg-[var(--bg-main)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const { settings: globalSettings, updateSettings } = useGlobalSettings();
  const [scope, setScope] = useState<VoiceScope>("client");
  const [preferredSource, setPreferredSource] =
    useState<VoiceSettingsSourcePreference>("auto");
  const [clientSettings, setClientSettings] = useState<VoiceSpeechSettingsPayload | null>(null);
  const [serverSettings, setServerSettings] = useState<VoiceSpeechSettingsPayload | null>(null);
  const [clientDraft, setClientDraft] = useState<VoiceDraft>(EMPTY_DRAFT);
  const [serverDraft, setServerDraft] = useState<VoiceDraft>(EMPTY_DRAFT);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showSttHints, setShowSttHints] = useState(false);
  const [showRemoteTts, setShowRemoteTts] = useState(false);
  const [showControllerOverride, setShowControllerOverride] = useState(false);

  const settings = scope === "client" ? clientSettings : serverSettings;
  const draft = scope === "client" ? clientDraft : serverDraft;
  const setDraft = scope === "client" ? setClientDraft : setServerDraft;

  const applyClient = useCallback((next: VoiceSpeechSettingsPayload) => {
    setClientSettings(next);
    setClientDraft((current) => ({ ...draftFromSettings(next), sttApiKey: current.sttApiKey }));
    if (next.transcription.language || next.transcription.prompt) {
      setShowSttHints(true);
    }
  }, []);

  const applyServer = useCallback((next: VoiceSpeechSettingsPayload) => {
    setServerSettings(next);
    setServerDraft((current) => ({ ...draftFromSettings(next), sttApiKey: current.sttApiKey }));
    if (
      next.tts.openaiCompat.baseUrl ||
      next.tts.openaiCompat.model ||
      next.tts.openaiCompat.voice ||
      next.tts.openaiCompat.configured
    ) {
      setShowRemoteTts(true);
    }
    if (next.controller.baseUrl || next.controller.model || next.controller.configured) {
      setShowControllerOverride(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    const client = await loadVoiceClientSettings();
    setPreferredSource(client.preferredSource);
    applyClient(toPublicVoiceClientSettings(client));

    try {
      const [voice, status] = await Promise.all([
        fetchVoiceSpeechSettings(),
        fetchVoiceStatus().catch(() => null),
      ]);
      applyServer(voice.settings);
      setVoiceStatus(status);
      setServerAvailable(true);
      if (!client.transcription && voice.settings.transcription.configured) {
        setScope("server");
      } else if (
        client.preferredSource === "server" &&
        voice.settings.transcription.configured
      ) {
        setScope("server");
      } else if (!voice.settings.transcription.configured && client.transcription) {
        setScope("client");
      }
    } catch (error) {
      setServerAvailable(false);
      setServerSettings(null);
      setVoiceStatus(null);
      setScope("client");
      setMessage(
        error instanceof Error
          ? `Server voice settings unavailable. Editing the client / account copy. ${error.message}`
          : "Server voice settings unavailable. Editing the client / account copy."
      );
    }
  }, [applyClient, applyServer]);

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
        if (scope === "client") {
          const saved = await saveVoiceClientSettings(patch);
          applyClient(toPublicVoiceClientSettings(saved));
          setClientDraft((current) => ({
            ...current,
            sttApiKey: "",
            ttsApiKey: "",
            controllerApiKey: "",
          }));
          setMessage(`${success} Saved to this client and your account when signed in.`);
          return;
        }
        if (!serverAvailable) {
          throw new Error(
            "No server is attached. Switch to Client / account to save speech settings without an engine."
          );
        }
        const result = await saveVoiceSpeechSettings(patch);
        applyServer(result.settings);
        setServerDraft((current) => ({
          ...current,
          sttApiKey: "",
          ttsApiKey: "",
          controllerApiKey: "",
        }));
        setMessage(success);
        const status = await fetchVoiceStatus().catch(() => null);
        setVoiceStatus(status);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to save voice settings.");
      } finally {
        setBusy(false);
      }
    },
    [applyClient, applyServer, scope, serverAvailable]
  );

  const clearActiveStored = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (scope === "client") {
        const cleared = await clearVoiceClientSettings();
        applyClient(toPublicVoiceClientSettings(cleared));
        setClientDraft(EMPTY_DRAFT);
        setMessage("Client / account voice settings removed.");
        return;
      }
      const result = await deleteVoiceSpeechSettings();
      applyServer(result.settings);
      setServerDraft(EMPTY_DRAFT);
      setMessage(
        result.settings.transcription.source === "env" ||
          result.settings.controller.source === "env" ||
          result.settings.tts.openaiCompat.source === "env"
          ? "Stored server voice settings removed. Environment variables are still in effect."
          : "Stored server voice settings removed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to clear voice settings.");
    } finally {
      setBusy(false);
    }
  }, [applyClient, applyServer, scope]);

  const changePreferredSource = useCallback(
    async (next: VoiceSettingsSourcePreference) => {
      setPreferredSource(next);
      setBusy(true);
      try {
        const saved = await setVoicePreferredSource(next);
        setPreferredSource(saved.preferredSource);
        setMessage(
          next === "auto"
            ? "Default set to automatic: use the server when it is configured, otherwise the account copy."
            : next === "client"
              ? "Default set to the client / account provider."
              : "Default set to the attached server."
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to update the default provider.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const engineOptions = useMemo(() => {
    const engines = voiceStatus?.tts.engines ?? [];
    return [
      { value: "", label: "Automatic (first available)" },
      ...engines.map((engine) => ({
        value: engine.id,
        label: `${engine.label}${engine.available ? "" : " - unavailable"}`,
      })),
    ];
  }, [voiceStatus]);

  const updateDraft = (patch: Partial<VoiceDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <>
      <PageIntro title="Voice" />
      <p className="mb-[12px] max-w-[640px] font-sans text-[13px] leading-[1.5] text-[var(--text-secondary)]">
        Client / account settings stay on this device and sync with your signed-in
        account. Server settings live on the attached engine. Leave host and key
        blank to reuse your Cesium Agent provider. API keys are sealed with
        AES-256-GCM before they are stored.
      </p>
      {message ? (
        <div className="mb-[16px]">
          <SettingsCallout tone="info">{message}</SettingsCallout>
        </div>
      ) : null}

      <SettingsSection title="Default provider">
        <SettingsRow
          searchId="voice-source-default"
          title="Which settings to use"
          description="Automatic uses the server when it has speech configured, otherwise your account copy."
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={preferredSource}
              aria-label="Default voice settings source"
              disabled={busy}
              onChange={(event) =>
                void changePreferredSource(
                  event.currentTarget.value as VoiceSettingsSourcePreference
                )
              }
            >
              <option value="auto">Automatic</option>
              <option value="client">Client / account</option>
              <option value="server">Server</option>
            </select>
          }
          border={false}
        />
      </SettingsSection>

      <ScopeToggle value={scope} onChange={setScope} serverAvailable={serverAvailable} />
      <p className="mb-[14px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
        {scope === "client"
          ? "Editing the copy bound to this client and your account. This works even when no server is attached."
          : serverAvailable
            ? "Editing the attached server. These values apply to every client that uses this engine."
            : "The engine is offline. You can inspect this tab, but saves go on Client / account until a server is attached."}
      </p>

      <SettingsSection title="Speech to text">
        <div className="px-[16px] py-[12px] border-b border-[var(--border-subtle)]">
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {settings
              ? statusLine({
                  configured: settings.transcription.configured,
                  source: settings.transcription.source,
                  lastFour: settings.transcription.apiKeyLastFour,
                })
              : scope === "server" && !serverAvailable
                ? "Server unavailable"
                : "Loading…"}
          </p>
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Microphone dictation. Uses your agent provider when these fields are empty.
          </p>
        </div>
        <VoiceField
          label="Base URL"
          type="url"
          value={draft.sttBaseUrl}
          onChange={(value) => updateDraft({ sttBaseUrl: value })}
          placeholder="https://api.groq.com/openai/v1"
          disabled={busy}
          searchId="transcription-model"
        />
        <VoiceField
          label="API key"
          type="password"
          value={draft.sttApiKey}
          onChange={(value) => updateDraft({ sttApiKey: value })}
          placeholder={
            settings?.transcription.apiKeyLastFour
              ? `Stored key ends with ${settings.transcription.apiKeyLastFour}`
              : "Paste a transcription API key"
          }
          disabled={busy}
        />
        <VoiceField
          label="Model"
          value={draft.sttModel}
          onChange={(value) => updateDraft({ sttModel: value })}
          placeholder="whisper-large-v3"
          disabled={busy}
          searchId="transcription-model"
        />
        <div className="px-[16px] py-[10px] border-b border-[var(--border-subtle)]">
          <button
            type="button"
            className="font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setShowSttHints((open) => !open)}
            aria-expanded={showSttHints}
          >
            {showSttHints ? "Hide language and prompt" : "Language and prompt (optional)"}
          </button>
        </div>
        {showSttHints ? (
          <>
            <VoiceField
              label="Language (optional)"
              value={draft.sttLanguage}
              onChange={(value) => updateDraft({ sttLanguage: value })}
              placeholder="en"
              disabled={busy}
              searchId="transcription-language"
            />
            <VoiceField
              label="Prompt (optional)"
              value={draft.sttPrompt}
              onChange={(value) => updateDraft({ sttPrompt: value })}
              placeholder="Prefer technical terms and code identifiers"
              disabled={busy}
            />
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  transcription: {
                    baseUrl: draft.sttBaseUrl.trim() || null,
                    ...(draft.sttApiKey.trim() ? { apiKey: draft.sttApiKey.trim() } : {}),
                    model: draft.sttModel.trim() || null,
                    language: draft.sttLanguage.trim() || null,
                    prompt: draft.sttPrompt.trim() || null,
                  },
                },
                scope === "client"
                  ? "Client speech-to-text settings saved."
                  : "Server speech-to-text settings saved."
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
            Optional fallback when Agents does not pick a catalog title model. Uses the same
            credentials as speech-to-text.
            {settings?.titleGeneration.modelSource
              ? ` Currently ${sourceLabel(settings.titleGeneration.modelSource)?.toLowerCase()}.`
              : ""}
          </p>
        </div>
        <VoiceField
          label="Title generation model"
          value={draft.titleModel}
          onChange={(value) => updateDraft({ titleModel: value })}
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
                { titleGeneration: { model: draft.titleModel.trim() || null } },
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
            Automatic picks the first available local engine. Add a remote host only if you
            want cloud speech.
          </p>
        </div>
        <label
          data-settings-search-id="tts-engine"
          className="flex flex-col gap-[6px] px-[16px] py-[12px] border-b border-[var(--border-subtle)]"
        >
          <SettingsFieldLabel>Preferred engine</SettingsFieldLabel>
          <select
            className={settingsSelectTriggerClass}
            value={draft.ttsEngine}
            aria-label="Preferred TTS engine"
            disabled={busy}
            onChange={(event) => updateDraft({ ttsEngine: event.currentTarget.value })}
          >
            {engineOptions.map((option) => (
              <option key={option.value || "auto"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="px-[16px] py-[10px] border-b border-[var(--border-subtle)]">
          <button
            type="button"
            className="font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setShowRemoteTts((open) => !open)}
            aria-expanded={showRemoteTts}
            data-settings-search-id="tts-remote"
          >
            {showRemoteTts ? "Hide remote TTS host" : "Remote TTS host (optional)"}
          </button>
        </div>
        {showRemoteTts ? (
          <>
            <VoiceField
              label="Remote TTS base URL"
              type="url"
              value={draft.ttsBaseUrl}
              onChange={(value) => updateDraft({ ttsBaseUrl: value })}
              placeholder="https://api.openai.com/v1"
              disabled={busy}
            />
            <VoiceField
              label="Remote TTS API key"
              type="password"
              value={draft.ttsApiKey}
              onChange={(value) => updateDraft({ ttsApiKey: value })}
              placeholder={
                settings?.tts.openaiCompat.apiKeyLastFour
                  ? `Stored key ends with ${settings.tts.openaiCompat.apiKeyLastFour}`
                  : "Paste a TTS API key"
              }
              disabled={busy}
            />
            <VoiceField
              label="Remote TTS model"
              value={draft.ttsModel}
              onChange={(value) => updateDraft({ ttsModel: value })}
              placeholder="tts-1"
              disabled={busy}
            />
            <VoiceField
              label="Remote TTS voice"
              value={draft.ttsVoice}
              onChange={(value) => updateDraft({ ttsVoice: value })}
              placeholder="alloy"
              disabled={busy}
            />
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  tts: {
                    engine: draft.ttsEngine.trim() || null,
                    openaiCompat: {
                      baseUrl: draft.ttsBaseUrl.trim() || null,
                      ...(draft.ttsApiKey.trim() ? { apiKey: draft.ttsApiKey.trim() } : {}),
                      model: draft.ttsModel.trim() || null,
                      voice: draft.ttsVoice.trim() || null,
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
            Fast model the voice orb uses to answer or hand off to an agent. Inherits the
            Cesium Agent provider unless you override it.
          </p>
        </div>
        <div className="px-[16px] py-[10px] border-b border-[var(--border-subtle)]">
          <button
            type="button"
            className="font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setShowControllerOverride((open) => !open)}
            aria-expanded={showControllerOverride}
            data-settings-search-id="voice-controller"
          >
            {showControllerOverride ? "Hide provider override" : "Override provider (optional)"}
          </button>
        </div>
        {showControllerOverride ? (
          <>
            <VoiceField
              label="Base URL"
              type="url"
              value={draft.controllerBaseUrl}
              onChange={(value) => updateDraft({ controllerBaseUrl: value })}
              placeholder="https://infer.example.com/v1"
              disabled={busy}
            />
            <VoiceField
              label="API key"
              type="password"
              value={draft.controllerApiKey}
              onChange={(value) => updateDraft({ controllerApiKey: value })}
              placeholder={
                settings?.controller.apiKeyLastFour
                  ? `Stored key ends with ${settings.controller.apiKeyLastFour}`
                  : "Paste a controller API key"
              }
              disabled={busy}
            />
            <VoiceField
              label="Model"
              value={draft.controllerModel}
              onChange={(value) => updateDraft({ controllerModel: value })}
              placeholder="kimi-k3"
              disabled={busy}
            />
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() =>
              void savePatch(
                {
                  controller: {
                    baseUrl: draft.controllerBaseUrl.trim() || null,
                    ...(draft.controllerApiKey.trim()
                      ? { apiKey: draft.controllerApiKey.trim() }
                      : {}),
                    model: draft.controllerModel.trim() || null,
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
            {scope === "client"
              ? "Clearing the client copy removes account-bound speech overrides on this device."
              : "Clearing stored server settings falls back to the Cesium Agent provider and any voice environment variables still set on the engine."}
          </p>
          <div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void clearActiveStored()}
            >
              {scope === "client"
                ? "Remove client voice settings"
                : "Remove stored server voice settings"}
            </button>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
