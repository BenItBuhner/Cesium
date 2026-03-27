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
} from "@/lib/preferences";
import { applyDomUserPreferences } from "@/lib/preferences-dom";

type UserPreferencesContextValue = {
  preferences: UserPreferences;
  experimentalIpadMode: boolean;
  experimentalIpadCustomButtons: boolean;
  setExperimentalIpadMode: (enabled: boolean) => void;
  setExperimentalIpadCustomButtons: (enabled: boolean) => void;
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

  useEffect(() => {
    const stored = parseUserPreferences(
      window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY)
    );
    setPreferencesState(stored);
    applyDomUserPreferences(stored);
  }, []);

  const persistPreferences = useCallback((next: UserPreferences) => {
    window.localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEY,
      serializeUserPreferences(next)
    );
    applyDomUserPreferences(next);
  }, []);

  const setExperimentalIpadMode = useCallback((enabled: boolean) => {
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadMode: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [persistPreferences]);

  const setExperimentalIpadCustomButtons = useCallback((enabled: boolean) => {
    setPreferencesState((prev) => {
      const next: UserPreferences = {
        ...prev,
        experimentalIpadCustomButtons: enabled,
      };
      persistPreferences(next);
      return next;
    });
  }, [persistPreferences]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== USER_PREFERENCES_STORAGE_KEY) return;
      const next = parseUserPreferences(event.newValue);
      setPreferencesState(next);
      applyDomUserPreferences(next);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({
      preferences,
      experimentalIpadMode: preferences.experimentalIpadMode,
      experimentalIpadCustomButtons: preferences.experimentalIpadCustomButtons,
      setExperimentalIpadMode,
      setExperimentalIpadCustomButtons,
    }),
    [preferences, setExperimentalIpadMode, setExperimentalIpadCustomButtons]
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
