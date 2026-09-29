/**
 * Map for process-lifetime caches: entries idle longer than `ttlMs` expire,
 * and past `maxEntries` the least recently used go first. Reads and writes
 * both count as use, so entries in active use are never evicted by the TTL.
 * Sweeps run on access; no timer keeps the process alive.
 */
export class BoundedTtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; touchedAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries: number; ttlMs: number; now?: () => number }) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, { value: entry.value, touchedAt: now });
    return entry.value;
  }

  has(key: K): boolean {
    this.sweep(this.now());
    return this.entries.has(key);
  }

  set(key: K, value: V): this {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, touchedAt: now });
    this.sweep(now);
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): IterableIterator<K> {
    this.sweep(this.now());
    return this.entries.keys();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt < this.ttlMs && this.entries.size <= this.maxEntries) {
        break;
      }
      this.entries.delete(key);
    }
  }
}
