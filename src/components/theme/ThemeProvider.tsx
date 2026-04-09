"use client";

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
  createDefaultThemeConfig,
  loadThemeConfigFromStorage,
  normalizeThemeConfig,
  persistThemeConfigToStorage,
  THEME_CONFIG_STORAGE_KEY,
  type CustomThemeEntry,
  type ThemeConfig,
} from "@/lib/theme-config";
import type { ThemePreference } from "@/lib/theme";
import { applyThemeConfigToDom } from "@/lib/theme-dom";
import { normalizeThemeIdForConfig } from "@/lib/theme-resolve";
import {
  BUILTIN_THEME_CATALOG,
  DEFAULT_BUILTIN_THEME_ID,
} from "@/lib/theme-presets";

function newCustomThemeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type ThemeContextValue = {
  themeConfig: ThemeConfig;
  /** Alias for `themeConfig.appearance`. */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  setAppearance: (p: ThemePreference) => void;
  setLightThemeId: (id: string) => void;
  setDarkThemeId: (id: string) => void;
  /** Replace entire config (e.g. import). */
  setThemeConfig: (config: ThemeConfig) => void;
  upsertCustomTheme: (entry: CustomThemeEntry) => void;
  removeCustomTheme: (id: string) => void;
  /** Copy builtin or custom preset into a new custom theme; returns new id or null. */
  duplicateCustomTheme: (sourceId: string, newLabel: string) => string | null;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function normalizeConfigIds(config: ThemeConfig): ThemeConfig {
  const customIds = new Set(config.customThemes.map((t) => t.id));
  return {
    ...config,
    lightThemeId: normalizeThemeIdForConfig(config.lightThemeId, customIds),
    darkThemeId: normalizeThemeIdForConfig(config.darkThemeId, customIds),
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeConfig, setThemeConfigState] = useState<ThemeConfig>(() =>
    normalizeConfigIds(
      typeof window === "undefined"
        ? createDefaultThemeConfig()
        : loadThemeConfigFromStorage()
    )
  );

  const configRef = useRef(themeConfig);
  configRef.current = themeConfig;

  useEffect(() => {
    applyThemeConfigToDom(themeConfig);
  }, [themeConfig]);

  const commit = useCallback((next: ThemeConfig) => {
    const normalized = normalizeConfigIds(next);
    persistThemeConfigToStorage(normalized);
    setThemeConfigState(normalized);
    applyThemeConfigToDom(normalized);
  }, []);

  const setPreference = useCallback(
    (p: ThemePreference) => {
      commit({ ...configRef.current, appearance: p });
    },
    [commit]
  );

  const setAppearance = setPreference;

  const setLightThemeId = useCallback(
    (id: string) => {
      commit({ ...configRef.current, lightThemeId: id });
    },
    [commit]
  );

  const setDarkThemeId = useCallback(
    (id: string) => {
      commit({ ...configRef.current, darkThemeId: id });
    },
    [commit]
  );

  const setThemeConfig = useCallback(
    (c: ThemeConfig) => {
      commit(normalizeConfigIds(normalizeThemeConfig(c)));
    },
    [commit]
  );

  const upsertCustomTheme = useCallback(
    (entry: CustomThemeEntry) => {
      const cur = configRef.current;
      const rest = cur.customThemes.filter((t) => t.id !== entry.id);
      commit({ ...cur, customThemes: [...rest, entry] });
    },
    [commit]
  );

  const removeCustomTheme = useCallback(
    (id: string) => {
      if (id in BUILTIN_THEME_CATALOG) {
        return;
      }
      const cur = configRef.current;
      let { lightThemeId, darkThemeId } = cur;
      if (lightThemeId === id) {
        lightThemeId = DEFAULT_BUILTIN_THEME_ID;
      }
      if (darkThemeId === id) {
        darkThemeId = DEFAULT_BUILTIN_THEME_ID;
      }
      commit({
        ...cur,
        lightThemeId,
        darkThemeId,
        customThemes: cur.customThemes.filter((t) => t.id !== id),
      });
    },
    [commit]
  );

  const duplicateCustomTheme = useCallback(
    (sourceId: string, newLabel: string): string | null => {
      const cur = configRef.current;
      const custom = cur.customThemes.find((t) => t.id === sourceId);
      const builtin = BUILTIN_THEME_CATALOG[sourceId];
      let light: CustomThemeEntry["light"];
      let dark: CustomThemeEntry["dark"];
      if (custom) {
        light = { ...custom.light };
        dark = { ...custom.dark };
      } else if (builtin) {
        light = { ...builtin.light };
        dark = { ...builtin.dark };
      } else if (sourceId === DEFAULT_BUILTIN_THEME_ID) {
        light = {};
        dark = {};
      } else {
        return null;
      }
      const id = newCustomThemeId();
      const entry: CustomThemeEntry = {
        id,
        label: newLabel.trim() || "Custom theme",
        light,
        dark,
      };
      commit({ ...cur, customThemes: [...cur.customThemes, entry] });
      return id;
    },
    [commit]
  );

  useEffect(() => {
    if (themeConfig.appearance !== "system") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeConfigToDom(configRef.current);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeConfig.appearance]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_CONFIG_STORAGE_KEY) {
        return;
      }
      if (e.newValue == null) {
        return;
      }
      try {
        const normalized = normalizeConfigIds(
          normalizeThemeConfig(JSON.parse(e.newValue) as unknown)
        );
        setThemeConfigState(normalized);
        applyThemeConfigToDom(normalized);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({
      themeConfig,
      preference: themeConfig.appearance,
      setPreference,
      setAppearance,
      setLightThemeId,
      setDarkThemeId,
      setThemeConfig,
      upsertCustomTheme,
      removeCustomTheme,
      duplicateCustomTheme,
    }),
    [
      themeConfig,
      duplicateCustomTheme,
      removeCustomTheme,
      setAppearance,
      setDarkThemeId,
      setLightThemeId,
      setPreference,
      setThemeConfig,
      upsertCustomTheme,
    ]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
