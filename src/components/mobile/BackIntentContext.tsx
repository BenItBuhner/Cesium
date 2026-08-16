"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  BACK_INTENT_PRIORITY,
  BackGestureCoordinator,
  selectTopBackHandler,
  type BackGestureEvent,
  type BackGestureHooks,
  type BackHandlerEntry,
} from "@/lib/back-intent";

export { BACK_INTENT_PRIORITY };
export type { BackGestureEvent, BackGestureHooks };

type BackIntentContextValue = {
  /**
   * Register a back handler. Returns an unregister function. The handler
   * returns `true` if it consumed the back intent (e.g. it closed an overlay).
   * Layers that can preview their pop pass progressive `gesture` hooks.
   */
  register: (
    priority: number,
    handler: () => boolean,
    gesture?: BackGestureHooks
  ) => () => void;
  /** Invoke the top-most handler. Returns whether the intent was consumed. */
  handleBack: () => boolean;
  /** Whether any handler is currently registered. */
  canHandleBack: () => boolean;
  /** Subscribe to registry changes (registration/unregistration). */
  subscribe: (listener: () => void) => () => void;
  /**
   * Progressive gesture session (Android predictive back). `startBackGesture`
   * stashes the top-most handler so the whole gesture reaches one layer;
   * `commitBackGesture` pops it (falling back to the discrete `handleBack`
   * resolution when no gesture was started) and `cancelBackGesture` reverts.
   */
  startBackGesture: (event: BackGestureEvent) => boolean;
  progressBackGesture: (event: BackGestureEvent) => void;
  cancelBackGesture: () => void;
  commitBackGesture: () => boolean;
};

const BackIntentContext = createContext<BackIntentContextValue | null>(null);

export function BackIntentProvider({ children }: { children: ReactNode }) {
  const entriesRef = useRef<BackHandlerEntry[]>([]);
  const listenersRef = useRef<Set<() => void>>(new Set());
  const nextIdRef = useRef(0);
  const coordinatorRef = useRef<BackGestureCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new BackGestureCoordinator(() => entriesRef.current);
  }

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  }, []);

  const register = useCallback(
    (priority: number, handler: () => boolean, gesture?: BackGestureHooks) => {
      const id = ++nextIdRef.current;
      entriesRef.current = [...entriesRef.current, { id, priority, handler, gesture }];
      notify();
      return () => {
        const next = entriesRef.current.filter((entry) => entry.id !== id);
        if (next.length === entriesRef.current.length) {
          return;
        }
        entriesRef.current = next;
        notify();
      };
    },
    [notify]
  );

  const handleBack = useCallback(() => {
    const top = selectTopBackHandler(entriesRef.current);
    return top ? top.handler() : false;
  }, []);

  const canHandleBack = useCallback(() => entriesRef.current.length > 0, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const startBackGesture = useCallback(
    (event: BackGestureEvent) => coordinatorRef.current?.start(event) ?? false,
    []
  );
  const progressBackGesture = useCallback((event: BackGestureEvent) => {
    coordinatorRef.current?.progress(event);
  }, []);
  const cancelBackGesture = useCallback(() => {
    coordinatorRef.current?.cancel();
  }, []);
  const commitBackGesture = useCallback(
    () => coordinatorRef.current?.commit() ?? false,
    []
  );

  const value = useMemo<BackIntentContextValue>(
    () => ({
      register,
      handleBack,
      canHandleBack,
      subscribe,
      startBackGesture,
      progressBackGesture,
      cancelBackGesture,
      commitBackGesture,
    }),
    [
      register,
      handleBack,
      canHandleBack,
      subscribe,
      startBackGesture,
      progressBackGesture,
      cancelBackGesture,
      commitBackGesture,
    ]
  );

  return (
    <BackIntentContext.Provider value={value}>
      {children}
    </BackIntentContext.Provider>
  );
}

export function useBackIntent(): BackIntentContextValue {
  const ctx = useContext(BackIntentContext);
  if (!ctx) {
    throw new Error("useBackIntent must be used within a BackIntentProvider");
  }
  return ctx;
}

export function useBackIntentMaybe(): BackIntentContextValue | null {
  return useContext(BackIntentContext);
}

/**
 * Register a back handler that stays active while `active` is true. The handler
 * should return `true` when it consumes the back intent (the common case for a
 * closable layer). The latest `handler`/`onBack` closure is always used, so
 * callers do not need to memoize it.
 *
 * Layers that can preview their pop pass progressive `gesture` hooks (also
 * latest-closure semantics): `onStart`/`onProgress` receive Android's
 * predictive back-gesture stream, `onCancel` reverts an abandoned gesture,
 * and the regular `onBack` commits it. The hooks' presence must be stable for
 * the lifetime of the registration.
 */
export function useBackHandler(
  active: boolean,
  priority: number,
  onBack: () => boolean | void,
  gesture?: BackGestureHooks
): void {
  const ctx = useBackIntentMaybe();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const gestureRef = useRef(gesture);
  gestureRef.current = gesture;
  const hasGesture = gesture != null;

  useEffect(() => {
    if (!ctx || !active) {
      return;
    }
    return ctx.register(
      priority,
      () => onBackRef.current() !== false,
      hasGesture
        ? {
            onStart: (event) => gestureRef.current?.onStart?.(event),
            onProgress: (event) => gestureRef.current?.onProgress?.(event),
            onCancel: () => gestureRef.current?.onCancel?.(),
          }
        : undefined
    );
  }, [ctx, active, priority, hasGesture]);
}
