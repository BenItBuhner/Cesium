import { useCallback, useEffect, useMemo, useState } from "react";

function notifyNavigationChange() {
  window.dispatchEvent(new Event("cesium:desktop-navigation"));
}

function normalizeTarget(target: string) {
  return target.startsWith("/") ? target : `/${target}`;
}

export function useRouter() {
  return useMemo(
    () => ({
      replace(target: string) {
        window.history.replaceState(null, "", normalizeTarget(target));
        notifyNavigationChange();
      },
      push(target: string) {
        window.history.pushState(null, "", normalizeTarget(target));
        notifyNavigationChange();
      },
      back() {
        window.history.back();
      },
      refresh() {
        notifyNavigationChange();
      },
    }),
    []
  );
}

export function useSearchParams(): URLSearchParams {
  const read = useCallback(() => new URLSearchParams(window.location.search), []);
  const [params, setParams] = useState(read);

  useEffect(() => {
    const sync = () => setParams(read());
    window.addEventListener("popstate", sync);
    window.addEventListener("cesium:desktop-navigation", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("cesium:desktop-navigation", sync);
    };
  }, [read]);

  return params;
}

export function redirect(target: string): never {
  window.location.replace(target);
  throw new Error(`Redirected to ${target}`);
}
