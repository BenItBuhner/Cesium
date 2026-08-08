import { THEME_CONFIG_STORAGE_KEY } from "@/lib/theme-config";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import {
  BUILTIN_THEME_CATALOG,
  DEFAULT_DARK_BUILTIN_THEME_ID,
} from "@/lib/theme-presets";

/**
 * Inline `<head>` script that applies the resolved color scheme before
 * hydration. It also pre-paints the OLED-black surface tokens when the
 * resolved dark theme is `oled` (the default), so first paint doesn't flash
 * the lighter stylesheet dark-gray before `ThemeProvider` takes over. The
 * inline properties are removed again when the OLED theme is not active;
 * `applyThemeConfigToDom` rewrites every token on hydration either way.
 */
export function buildThemeBootstrapScript(): string {
  const oledDarkTokens = BUILTIN_THEME_CATALOG.oled?.dark ?? {};
  return `(()=>{try{var C=${JSON.stringify(THEME_CONFIG_STORAGE_KEY)};var L=${JSON.stringify(THEME_STORAGE_KEY)};var D=${JSON.stringify(DEFAULT_DARK_BUILTIN_THEME_ID)};var O=${JSON.stringify(oledDarkTokens)};function pref(){try{var r=localStorage.getItem(C);if(r){var c=JSON.parse(r);var a=c&&c.appearance;if(a==="light"||a==="dark"||a==="system")return a}}catch(e){}var v=localStorage.getItem(L);return v==="light"||v==="dark"||v==="system"?v:"system"}function darkId(){try{var r=localStorage.getItem(C);if(r){var c=JSON.parse(r);var t=c&&typeof c.darkThemeId==="string"&&c.darkThemeId.trim()?c.darkThemeId.trim():"";if(t)return t}}catch(e){}return D}function systemDark(){return !!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)}function apply(){var p=pref();var d=p==="dark"||(p==="system"&&systemDark());var e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light";var o=d&&darkId()==="oled";for(var k in O){if(o)e.style.setProperty(k,O[k]);else e.style.removeProperty(k)}}apply();var m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");if(m&&m.addEventListener)m.addEventListener("change",function(){if(pref()==="system")apply()})}catch(e){}})();`;
}
