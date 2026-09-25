import { truncationMarker } from "./cesium-coerce.js";

/**
 * Bounded capture of a child process's combined output. Once the cap is hit,
 * the opening of the stream is frozen as the head and the newest bytes roll
 * through the tail, so the final lines of a long command (test summaries,
 * exit errors) are always present and `waitUntil: "pattern"` can still match
 * text that arrives late. A head-only cap silently drops everything after the
 * first `cap` characters.
 */
export class BoundedTerminalOutput {
  private head = "";
  private tail = "";
  private omitted = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(cap: number) {
    const safeCap = Math.max(2, Math.floor(cap));
    this.headCap = Math.ceil(safeCap / 2);
    this.tailCap = safeCap - this.headCap;
  }

  append(chunk: string): void {
    if (!chunk) {
      return;
    }
    let rest = chunk;
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) {
      return;
    }
    this.tail += rest;
    if (this.tail.length > this.tailCap) {
      const overflow = this.tail.length - this.tailCap;
      this.omitted += overflow;
      this.tail = this.tail.slice(overflow);
    }
  }

  get omittedChars(): number {
    return this.omitted;
  }

  toString(): string {
    if (this.omitted === 0) {
      return `${this.head}${this.tail}`;
    }
    return `${this.head}${truncationMarker(this.omitted)}${this.tail}`;
  }
}
