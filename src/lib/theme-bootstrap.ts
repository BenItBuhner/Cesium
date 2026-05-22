import { THEME_CONFIG_STORAGE_KEY } from "@/lib/theme-config";
import { THEME_STORAGE_KEY } from "@/lib/theme";

export function buildThemeBootstrapScript(): string {
  return `(()=>{try{var C=${JSON.stringify(THEME_CONFIG_STORAGE_KEY)};var L=${JSON.stringify(THEME_STORAGE_KEY)};function pref(){try{var r=localStorage.getItem(C);if(r){var c=JSON.parse(r);var a=c&&c.appearance;if(a==="light"||a==="dark"||a==="system")return a}}catch(e){}var v=localStorage.getItem(L);return v==="light"||v==="dark"||v==="system"?v:"system"}function systemDark(){return !!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)}function apply(){var p=pref();var d=p==="dark"||(p==="system"&&systemDark());document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}apply();var m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");if(m&&m.addEventListener)m.addEventListener("change",function(){if(pref()==="system")apply()})}catch(e){}})();`;
}
