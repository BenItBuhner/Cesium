"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_USER_PREFERENCES,
  parseUserPreferences,
  serializeUserPreferences,
  USER_PREFERENCES_STORAGE_KEY,
  type UserPreferences,
} from "../preferences";
import { applyDomUserPreferences } from "../preferences-dom";
import { useCesiumRendererFeatureFlags } from "../desktop-environment";
import { resolveEffectiveUserPreferences } from "../platform-feature-flags";
import { useGlobalSettings } from "./GlobalSettingsProvider";
import { clientKeyValueStore, getClientPlatform } from "../platform";

const USER_PREFERENCES_CHANGED_EVENT = "opencursor:user-preferences-changed";

type UserPreferencesContextValue = {
  preferences: UserPreferences;
  experimentalIpadMode: boolean;
  experimentalIpadCustomButtons: boolean;
  experimentalIpadWindowedTabInset: boolean;
  experimentalIpadResumeCache: boolean;
  vscodeExtensionsBeta: boolean;
  setExperimentalIpadMode: (enabled: boolean) => void;
  setExperimentalIpadCustomButtons: (enabled: boolean) => void;
  setExperimentalIpadWindowedTabInset: (enabled: boolean) => void;
  setExperimentalIpadResumeCache: (enabled: boolean) => void;
  setVscodeExtensionsBeta: (enabled: boolean) => void;
  /** Replace persisted preferences (e.g. settings import). */
  importUserPreferences: (next: UserPreferences) => void;
};

const UserPreferencesContext =
  createContext<UserPreferencesContextValue | null>(null);

export function UserPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [preferences, setPreferencesState] = useState<UserPreferences>(
    DEFAULT_USER_PREFERENCES
  );
  const featureFlags = useCesiumRendererFeatureFlags();
  const {
    settings: globalSettings,
    ready: globalSettingsReady,
    updateSettings,
  } = useGlobalSettings();

  useEffect(() => {
    const stored = parseUserPreferences(
      clientKeyValueStore().getItem(USER_PREFERENCES_STORAGE_KEY)
    );
    setPreferencesState(stored);
    applyDomUserPreferences(stored);
  }, []);

  const persistPreferences = useCallback((next: UserPreferences) => {
    clientKeyValueStore().setItem(
      USER_PREFERENCES_STORAGE_KEY,
      serializeUserPreferences(next)
    );
    applyDomUserPreferences(next);
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(USER_PREFERENCES_CHANGED_EVENT, { detail: next })
      );
    } else {
      getClientPlatform().emitEvent(USER_PREFERENCES_CHANGED_EVENT);
    }
  }, []);

  const setExperimentalIpadMode = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadMode: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [featureFlags.ipadExperimentalUi, persistPreferences]);

  const setExperimentalIpadCustomButtons = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadCustomButtons: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [featureFlags.ipadExperimentalUi, persistPreferences]);

  const setExperimentalIpadWindowedTabInset = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadWindowedTabInset: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [featureFlags.ipadExperimentalUi, persistPreferences]);

  const setExperimentalIpadResumeCache = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadResumeCache) return;
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadResumeCache: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [featureFlags.ipadResumeCache, persistPreferences]);

  const setVscodeExtensionsBeta = useCallback((enabled: boolean) => {
    if (!featureFlags.vscodeExtensionsBetaSettings) return;
    updateSettings((current) => ({
      ...current,
      features: {
        ...current.features,
        vscodeExtensionsBeta: enabled,
      },
    }));
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        vscodeExtensionsBeta: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [featureFlags.vscodeExtensionsBetaSettings, persistPreferences, updateSettings]);

  const importUserPreferences = useCallback(
    (next: UserPreferences) => {
      setPreferencesState(next);
      persistPreferences(next);
    },
    [persistPreferences]
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== USER_PREFERENCES_STORAGE_KEY) return;
      const next = parseUserPreferences(event.newValue);
      setPreferencesState(next);
      applyDomUserPreferences(next);
      window.dispatchEvent(
        new CustomEvent(USER_PREFERENCES_CHANGED_EVENT, { detail: next })
      );
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(() => {
    const effective = resolveEffectiveUserPreferences({
      ...preferences,
      vscodeExtensionsBeta: globalSettingsReady
        ? globalSettings.features.vscodeExtensionsBeta
        : preferences.vscodeExtensionsBeta,
    });
    return {
      preferences: effective,
      experimentalIpadMode: effective.experimentalIpadMode,
      experimentalIpadCustomButtons: effective.experimentalIpadCustomButtons,
      experimentalIpadWindowedTabInset: effective.experimentalIpadWindowedTabInset,
      experimentalIpadResumeCache: effective.experimentalIpadResumeCache,
      vscodeExtensionsBeta: effective.vscodeExtensionsBeta,
      setExperimentalIpadMode,
      setExperimentalIpadCustomButtons,
      setExperimentalIpadWindowedTabInset,
      setExperimentalIpadResumeCache,
      setVscodeExtensionsBeta,
      importUserPreferences,
    };
  }, [
    globalSettings.features.vscodeExtensionsBeta,
    globalSettingsReady,
    preferences,
    setExperimentalIpadMode,
    setExperimentalIpadCustomButtons,
    setExperimentalIpadWindowedTabInset,
    setExperimentalIpadResumeCache,
    setVscodeExtensionsBeta,
    importUserPreferences,
  ]);

  return (
    <UserPreferencesContext.Provider value={value}>
      {children}
    </UserPreferencesContext.Provider>
  );
}

export function useUserPreferences(): UserPreferencesContextValue {
  const context = useContext(UserPreferencesContext);
  if (!context) {
    throw new Error(
      "useUserPreferences must be used within UserPreferencesProvider"
    );
  }
  return context;
}
