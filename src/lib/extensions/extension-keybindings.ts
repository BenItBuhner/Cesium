/**
 * Extension keybinding parsing + matching (contributes.keybindings).
 *
 * Single-chord bindings only; multi-chord ("ctrl+k ctrl+s") are skipped.
 * Bindings must include at least one of ctrl/meta/alt so extensions can never
 * hijack plain typing keys.
 */

import type { ExtensionInstallRecord } from "@/lib/server-api";

export type ParsedExtensionKeybinding = {
  extensionId: string;
  command: string;
  when?: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  plus: "+",
  minus: "-",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pageup: "pageup",
  pagedown: "pagedown",
};

export function parseExtensionKeybinding(input: {
  extensionId: string;
  command: string;
  key: string;
  when?: string;
  platform: "apple" | "other";
}): ParsedExtensionKeybinding | null {
  const chord = input.key.trim().toLowerCase();
  if (!chord || chord.includes(" ")) {
    return null;
  }
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const binding: ParsedExtensionKeybinding = {
    extensionId: input.extensionId,
    command: input.command,
    when: input.when,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: "",
  };
  for (const part of parts) {
    if (part === "ctrl" || part === "control") binding.ctrl = true;
    else if (part === "shift") binding.shift = true;
    else if (part === "alt" || part === "option" || part === "opt") binding.alt = true;
    else if (part === "cmd" || part === "meta" || part === "win" || part === "super") {
      binding.meta = true;
    } else if (part === "cmdorctrl" || part === "ctrlcmd") {
      if (input.platform === "apple") binding.meta = true;
      else binding.ctrl = true;
    } else {
      binding.key = KEY_ALIASES[part] ?? part;
    }
  }
  if (!binding.key) return null;
  if (!binding.ctrl && !binding.meta && !binding.alt) {
    // Function keys are allowed without modifiers (VS Code convention).
    if (!/^f\d{1,2}$/.test(binding.key)) {
      return null;
    }
  }
  return binding;
}

export function collectExtensionKeybindings(
  extensions: ExtensionInstallRecord[],
  platform: "apple" | "other"
): ParsedExtensionKeybinding[] {
  const bindings: ParsedExtensionKeybinding[] = [];
  for (const extension of extensions) {
    if (!extension.enabled) continue;
    const contributes = extension.manifest.raw.contributes;
    const raw =
      contributes && typeof contributes === "object" && "keybindings" in contributes
        ? (contributes as { keybindings?: unknown }).keybindings
        : undefined;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const command = (entry as { command?: unknown }).command;
      const key = (entry as { key?: unknown }).key;
      const mac = (entry as { mac?: unknown }).mac;
      const win = (entry as { win?: unknown }).win;
      const linux = (entry as { linux?: unknown }).linux;
      const when = (entry as { when?: unknown }).when;
      if (typeof command !== "string" || !command.trim()) continue;
      const platformKey =
        platform === "apple"
          ? (typeof mac === "string" ? mac : undefined)
          : typeof win === "string"
            ? win
            : typeof linux === "string"
              ? linux
              : undefined;
      const chord = platformKey ?? (typeof key === "string" ? key : undefined);
      if (!chord) continue;
      const parsed = parseExtensionKeybinding({
        extensionId: extension.extensionId,
        command,
        key: chord,
        when: typeof when === "string" ? when : undefined,
        platform,
      });
      if (parsed) bindings.push(parsed);
    }
  }
  return bindings;
}

export function eventMatchesExtensionKeybinding(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  binding: ParsedExtensionKeybinding
): boolean {
  if (event.ctrlKey !== binding.ctrl) return false;
  if (event.shiftKey !== binding.shift) return false;
  if (event.altKey !== binding.alt) return false;
  if (event.metaKey !== binding.meta) return false;
  return event.key.toLowerCase() === binding.key;
}
