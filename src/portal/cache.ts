/**
 * Small shared TTL cache for portal payloads.
 *
 * The call log is ~255 KB and the analytics tools read the same two payloads
 * within seconds of each other, so fetched results are kept in memory for a
 * short TTL instead of being re-downloaded per tool call.
 */

/** Default cache lifetime: 120 s. */
export const CACHE_TTL_MS = 120_000;

/** Clock source; inject a fake in tests instead of sleeping. */
export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** In-memory key/value cache with per-entry expiry. Not bounded by size. */
export class TtlCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Return the cached value, or `undefined` on miss/expiry. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Store a value for `ttlMs` from now. */
  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  /** Drop everything (used in tests). */
  clear(): void {
    this.entries.clear();
  }
}
