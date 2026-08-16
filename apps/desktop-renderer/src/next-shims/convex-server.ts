/**
 * Standalone-renderer shim for `convex/server`.
 *
 * `@convex/_generated/api` imports `anyApi` / `componentsGeneric` at module
 * load. The renderer never talks to Convex, so a nested proxy is enough for
 * `api.context.bootstrap`-style property access during bundling.
 */

function nestedProxy(): unknown {
  const proxy: unknown = new Proxy(
    function shim() {
      return nestedProxy();
    },
    {
      get: () => nestedProxy(),
      apply: () => nestedProxy(),
    }
  );
  return proxy;
}

export const anyApi = nestedProxy();

export function componentsGeneric(): unknown {
  return nestedProxy();
}
