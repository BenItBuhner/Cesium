type AutofocusWindow = {
  innerWidth?: number;
  visualViewport?: { width?: number | null } | null;
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { maxTouchPoints?: number; userAgent?: string };
  document?: {
    documentElement?: {
      classList?: { contains: (className: string) => boolean };
    } | null;
  };
  cesiumMobile?: { isReactNative?: boolean };
  ReactNativeWebView?: unknown;
};

const PHONE_BREAKPOINT_PX = 768;
const MOBILE_NATIVE_ROOT_CLASS = "opencursor-mobile-native";

function getAutofocusWindow(win?: AutofocusWindow): AutofocusWindow | null {
  if (win) return win;
  return typeof window === "undefined" ? null : (window as AutofocusWindow);
}

function getViewportWidth(win: AutofocusWindow): number {
  const visualWidth = win.visualViewport?.width;
  if (typeof visualWidth === "number" && Number.isFinite(visualWidth)) {
    return visualWidth;
  }
  return typeof win.innerWidth === "number" && Number.isFinite(win.innerWidth)
    ? win.innerWidth
    : Number.POSITIVE_INFINITY;
}

function mediaMatches(win: AutofocusWindow, query: string): boolean {
  try {
    return win.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

function hasTouchInput(win: AutofocusWindow): boolean {
  return (win.navigator?.maxTouchPoints ?? 0) > 0;
}

function hasMobileUserAgent(win: AutofocusWindow): boolean {
  const userAgent = win.navigator?.userAgent ?? "";
  return /\b(Android|iPhone|iPod|Mobile)\b/i.test(userAgent);
}

export function isMobileNativeRuntime(win?: AutofocusWindow): boolean {
  const target = getAutofocusWindow(win);
  if (!target) return false;

  const root = target.document?.documentElement;
  return (
    target.cesiumMobile?.isReactNative === true ||
    Boolean(target.ReactNativeWebView) ||
    root?.classList?.contains(MOBILE_NATIVE_ROOT_CLASS) === true
  );
}

export function isPhoneLikeTextInputRuntime(win?: AutofocusWindow): boolean {
  const target = getAutofocusWindow(win);
  if (!target) return false;
  if (isMobileNativeRuntime(target)) return true;

  if (getViewportWidth(target) >= PHONE_BREAKPOINT_PX) {
    return false;
  }

  return (
    mediaMatches(target, "(pointer: coarse)") ||
    hasTouchInput(target) ||
    hasMobileUserAgent(target)
  );
}

export function shouldAutoFocusTextInput(win?: AutofocusWindow): boolean {
  return !isPhoneLikeTextInputRuntime(win);
}
