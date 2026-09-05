"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  clearLegacyUserPreferences,
  mergeLegacyUserPreferences,
  readLegacyUserPreferences,
  USER_PREFERENCES_CHANGED_EVENT,
  userPreferencesEqual,
  writeFeaturesBootCache,
  type UserPreferences,
} from "../preferences";
import { applyDomUserPreferences } from "../preferences-dom";
import { useCesiumRendererFeatureFlags } from "../desktop-environment";
import { resolveEffectiveUserPreferences } from "../platform-feature-flags";
import { useGlobalSettings } from "./GlobalSettingsProvider";
import { getClientPlatform } from "../platform";

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

/**
 * View over `GlobalSettingsState.features`: the feature / experiment flags
 * are account settings like everything else, so they follow the user to every
 * device. This provider only adds renderer gating (a desktop build ignores
 * iPad experiments), DOM application, the pre-hydration boot cache, and a
 * one-time fold of the pre-account per-device document.
 */
export function UserPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const featureFlags = useCesiumRendererFeatureFlags();
  const { settings, hydrated, updateSettings, migrateSettings } = useGlobalSettings();
  const features = settings.features;

  const setFeatures = useCallback(
    (updater: (current: UserPreferences) => UserPreferences) => {
      updateSettings((current) => {
        const next = updater(current.features);
        return userPreferencesEqual(next, current.features)
          ? current
          : { ...current, features: next };
      });
    },
    [updateSettings]
  );

  // Fold the legacy per-device document into the account exactly once, after
  // the account's real flags are known. Folding before hydration would OR the
  // device's flags into factory defaults that never get saved, and clearing
  // the legacy key at that point would lose them.
  const migratedLegacyRef = useRef(false);
  useEffect(() => {
    if (!hydrated || migratedLegacyRef.current) {
      return;
    }
    migratedLegacyRef.current = true;
    const legacy = readLegacyUserPreferences();
    if (legacy) {
      migrateSettings((current) => {
        const next = mergeLegacyUserPreferences(current.features, legacy);
        return next === current.features ? current : { ...current, features: next };
      });
    }
    clearLegacyUserPreferences();
  }, [hydrated, migrateSettings]);

  const effective = useMemo(() => resolveEffectiveUserPreferences(features), [features]);

  const lastAppliedRef = useRef<UserPreferences | null>(null);
  useEffect(() => {
    if (lastAppliedRef.current && userPreferencesEqual(lastAppliedRef.current, effective)) {
      return;
    }
    lastAppliedRef.current = effective;
    applyDomUserPreferences(effective);
    writeFeaturesBootCache(effective);
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(USER_PREFERENCES_CHANGED_EVENT, { detail: effective })
      );
    } else {
      getClientPlatform().emitEvent(USER_PREFERENCES_CHANGED_EVENT);
    }
  }, [effective]);

  const setExperimentalIpadMode = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setFeatures((prev) => ({ ...prev, experimentalIpadMode: enabled }));
  }, [featureFlags.ipadExperimentalUi, setFeatures]);

  const setExperimentalIpadCustomButtons = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setFeatures((prev) => ({ ...prev, experimentalIpadCustomButtons: enabled }));
  }, [featureFlags.ipadExperimentalUi, setFeatures]);

  const setExperimentalIpadWindowedTabInset = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadExperimentalUi) return;
    setFeatures((prev) => ({ ...prev, experimentalIpadWindowedTabInset: enabled }));
  }, [featureFlags.ipadExperimentalUi, setFeatures]);

  const setExperimentalIpadResumeCache = useCallback((enabled: boolean) => {
    if (!featureFlags.ipadResumeCache) return;
    setFeatures((prev) => ({ ...prev, experimentalIpadResumeCache: enabled }));
  }, [featureFlags.ipadResumeCache, setFeatures]);

  const setVscodeExtensionsBeta = useCallback((enabled: boolean) => {
    if (!featureFlags.vscodeExtensionsBetaSettings) return;
    setFeatures((prev) => ({ ...prev, vscodeExtensionsBeta: enabled }));
  }, [featureFlags.vscodeExtensionsBetaSettings, setFeatures]);

  const importUserPreferences = useCallback(
    (next: UserPreferences) => {
      setFeatures(() => next);
    },
    [setFeatures]
  );

  const value = useMemo(
    () => ({
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
    }),
    [
      effective,
      setExperimentalIpadMode,
      setExperimentalIpadCustomButtons,
      setExperimentalIpadWindowedTabInset,
      setExperimentalIpadResumeCache,
      setVscodeExtensionsBeta,
      importUserPreferences,
    ]
  );

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
