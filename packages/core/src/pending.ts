/**
 * Pending permission requests.
 *
 * A permission request blocks the agent until a human answers it. Three
 * properties are non-negotiable, and this module is where they live:
 *
 * 1. **A request can be answered exactly once.** A late or replayed verdict
 *    is rejected, so an "Allow" that arrives after the timeout can never apply
 *    to a different, later prompt.
 * 2. **A timeout fails closed.** An unanswered request resolves as *deny*.
 *    Never as allow, never as "keep waiting forever" with the agent blocked.
 * 3. **A disconnect fails closed.** If the host goes away while a request is
 *    pending, the request resolves as deny. A request must never be silently
 *    satisfied by a disconnect.
 */

export type VerdictSource = 'phone' | 'timeout' | 'host';

export interface Verdict<T> {
  value: T;
  /** Who produced this verdict. Recorded in the audit log. */
  by: VerdictSource;
}

export interface PendingRequestsOptions<T> {
  /**
   * How long a request may stay unanswered. The default matches the design
   * doc: 15 minutes, then deny.
   */
  timeoutMs?: number;
  /**
   * The value a timed-out request resolves with. Must be the deny verdict.
   */
  onTimeout: () => T;
}

interface Entry<T> {
  resolve: (verdict: Verdict<T>) => void;
  timer: NodeJS.Timeout;
}

export class PendingRequests<T> {
  #entries = new Map<string, Entry<T>>();
  #timeoutMs: number;
  #onTimeout: () => T;

  constructor(options: PendingRequestsOptions<T>) {
    this.#timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    this.#onTimeout = options.onTimeout;
  }

  get size(): number {
    return this.#entries.size;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Register a request and wait for its answer.
   *
   * The returned promise resolves exactly once — with the phone's verdict, with
   * the timeout verdict, or with the fail-closed verdict from `failAll`.
   */
  request(id: string): Promise<Verdict<T>> {
    // Re-using an id would orphan the first promise; refuse it outright.
    if (this.#entries.has(id)) {
      throw new Error(`duplicate pending request id: ${id}`);
    }

    return new Promise<Verdict<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.#entries.delete(id);
        resolve({ value: this.#onTimeout(), by: 'timeout' });
      }, this.#timeoutMs);
      // The timer is deliberately *not* unref'd. The deny-on-timeout is a
      // security guarantee, not a convenience: it has to fire even if nothing
      // else is keeping the process alive. Shutdown paths call `failAll()`,
      // which clears these timers and resolves them closed.

      this.#entries.set(id, {
        resolve,
        timer,
      });
    });
  }

  /**
   * Answer a pending request.
   *
   * Returns `false` when the id is unknown, already answered, or timed out.
   * The caller answers the client with `no_such_request` in that case.
   */
  settle(id: string, value: T): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    entry.resolve({ value, by: 'phone' });
    return true;
  }

  /**
   * Fail every pending request closed.
   *
   * Called when the host disconnects mid-request. The agent is blocked on
   * these promises, so they have to resolve — with the deny verdict.
   */
  failAll(value: T): number {
    const entries = [...this.#entries.entries()];
    this.#entries.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.resolve({ value, by: 'host' });
    }
    return entries.length;
  }

  /** The ids currently awaiting an answer. */
  ids(): string[] {
    return [...this.#entries.keys()];
  }
}
