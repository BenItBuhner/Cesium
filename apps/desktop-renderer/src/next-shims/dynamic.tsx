import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

type DynamicOptions = {
  loading?: ComponentType;
};

export default function dynamic<TProps extends object>(
  loader: () => Promise<{ default: ComponentType<TProps> }>,
  options: DynamicOptions = {}
): ComponentType<TProps> {
  const LazyComponent = lazy(loader);
  const Loading = options.loading;

  return function DynamicComponent(props: TProps) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

export type DynamicFallback = ReactNode;
