export type ComposerEnterKeyState = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type ComposerEnterSubmitOptions = {
  hasHardwareKeyboard: boolean;
  submitCtrlEnter: boolean;
};

export function shouldSubmitComposerOnEnter(
  event: ComposerEnterKeyState,
  options: ComposerEnterSubmitOptions
): boolean {
  if (event.key !== "Enter" || !options.hasHardwareKeyboard) {
    return false;
  }

  const mod = event.ctrlKey || event.metaKey;
  if (options.submitCtrlEnter) {
    return mod;
  }

  return !event.shiftKey;
}
