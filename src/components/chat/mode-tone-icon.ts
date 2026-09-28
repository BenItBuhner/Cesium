import { Bug, Infinity, ListChecks, MessageSquare, type LucideIcon } from "lucide-react";
import type { KnownEditorMode } from "@/lib/types";

/** Icon that represents a chat mode wherever modes are listed (slash menu, mode dropdown). */
export function iconForModeTone(tone: KnownEditorMode): LucideIcon {
  switch (tone) {
    case "plan":
      return ListChecks;
    case "debug":
      return Bug;
    case "ask":
      return MessageSquare;
    default:
      return Infinity;
  }
}
