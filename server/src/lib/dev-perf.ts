import { measureServerPerf, serverPerfEnabled } from "./perf.js";

function serverDevPerfEnabled(): boolean {
  return serverPerfEnabled();
}

export async function measureServerDevAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!serverDevPerfEnabled()) {
    return fn();
  }
  return measureServerPerf(label, fn);
}
