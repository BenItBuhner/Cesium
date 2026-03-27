import { Terminal as XTerm } from "@xterm/xterm";

function emitTerminalInput(terminal: XTerm, data: string) {
  terminal.input(data, true);
}

function encodeControlCharacter(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  if (key === "[") return "\u001b";
  if (key === "\\") return "\u001c";
  if (key === "]") return "\u001d";
  if (key === "^") return "\u001e";
  if (key === "_") return "\u001f";
  if (key === " ") return "\u0000";
  return null;
}

function buildTerminalSequence(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;

  if (event.ctrlKey) {
    return encodeControlCharacter(event.key);
  }

  let base: string | null = null;

  switch (event.key) {
    case "Enter":
      base = "\r";
      break;
    case "Backspace":
      base = "\u007f";
      break;
    case "Delete":
      base = "\u001b[3~";
      break;
    case "Tab":
      base = "\t";
      break;
    case "Escape":
      base = "\u001b";
      break;
    case "ArrowUp":
      base = "\u001b[A";
      break;
    case "ArrowDown":
      base = "\u001b[B";
      break;
    case "ArrowRight":
      base = "\u001b[C";
      break;
    case "ArrowLeft":
      base = "\u001b[D";
      break;
    case "Home":
      base = "\u001b[H";
      break;
    case "End":
      base = "\u001b[F";
      break;
    case "PageUp":
      base = "\u001b[5~";
      break;
    case "PageDown":
      base = "\u001b[6~";
      break;
    default:
      if (event.key.length === 1) {
        base = event.key;
      }
      break;
  }

  if (!base) return null;
  if (!event.altKey) return base;
  return `\u001b${base}`;
}

export function handleTerminalHardwareKey(
  terminal: XTerm,
  event: KeyboardEvent
): boolean {
  const sequence = buildTerminalSequence(event);
  if (!sequence) return false;
  event.preventDefault();
  emitTerminalInput(terminal, sequence);
  return true;
}

export function pasteIntoTerminal(terminal: XTerm, text: string): boolean {
  if (typeof terminal.paste === "function") {
    terminal.paste(text);
    return true;
  }

  emitTerminalInput(terminal, text);
  return true;
}

export function getTerminalSelectionText(terminal: XTerm): string | null {
  if (!terminal.hasSelection()) return null;
  return terminal.getSelection() || null;
}
