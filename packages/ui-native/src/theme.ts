import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  type ColorScheme,
  type ThemeTokens,
} from "@cesium/design";

/**
 * Runtime theme access for native surfaces. NativeWind resolves the same
 * variables from the generated theme CSS for `className` styling; this hook is
 * for imperative colors (icons, ActivityIndicator, shadows) so the exact same
 * canonical token values are used everywhere.
 */

function subscribe(onChange: () => void): () => void {
  const subscription = Appearance.addChangeListener(onChange);
  return () => subscription.remove();
}

function getScheme(): ColorScheme {
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, getScheme, () => "dark" as const);
}

export function useThemeTokens(): ThemeTokens {
  const scheme = useColorScheme();
  return scheme === "dark" ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT;
}
