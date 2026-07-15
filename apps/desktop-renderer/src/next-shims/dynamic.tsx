import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

type DynamicOptions = {
  loading?: ComponentType;
  /** Accepted for next/dynamic parity; the renderer is always client-side. */
  ssr?: boolean;
};

/** next/dynamic accepts both module-shaped and direct-component loader results. */
type LoaderResult<P> = ComponentType<P> | { default: ComponentType<P> };

export default function dynamic<P extends object>(
  loader: () => Promise<LoaderResult<P>>,
  options: DynamicOptions = {}
): ComponentType<P> {
  const LazyComponent = lazy(async () => {
    const resolved = await loader();
    // memo/forwardRef components are objects too; only a `default` key marks a module shape.
    if (typeof resolved === "object" && resolved !== null && "default" in resolved) {
      return resolved;
    }
    return { default: resolved as ComponentType<P> };
  });
  const Loading = options.loading;

  return function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

export type DynamicFallback = ReactNode;
