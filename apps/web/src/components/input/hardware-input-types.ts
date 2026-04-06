export type HardwareSurfaceKind =
  | "text"
  | "palette"
  | "chat"
  | "monaco"
  | "terminal"
  | "other";

export type HardwareKeyRoutingResult = {
  handled?: boolean;
  allowWorkbenchShortcuts?: boolean;
};

export type HardwareKeyHandlerResult =
  | boolean
  | HardwareKeyRoutingResult
  | void;

export interface HardwareInputSurfaceAdapter {
  id: string;
  kind: HardwareSurfaceKind;
  allowWorkbenchShortcuts?: boolean;
  focusTarget?: HTMLElement | null;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onKeyDown?: (event: KeyboardEvent) => HardwareKeyHandlerResult;
  onPaste?: (text: string) => boolean;
  onCopy?: () => string | null;
  onCut?: () => string | null;
}
