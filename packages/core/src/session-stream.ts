import type { CcrEvent } from '@ccr/protocol';
import type { EventLog, StoredEvent } from './event-log.js';

/**
 * A session's event stream: an append-only log plus live fan-out.
 *
 * Both the host (serving a phone directly on the LAN) and the relay (routing
 * between a host and a phone) use this. The difference is only who calls
 * `publish`.
 */

export type Subscriber = (event: StoredEvent) => void;

export type AttachResult =
  | { ok: true; dispose: () => void }
  | { ok: false; error: 'cursor_expired' };

export interface SessionStreamOptions {
  /**
   * Maximum events replayed for a single cursor. Beyond this the client is
   * told `cursor_expired` and re-fetches full history.
   */
  maxReplay?: number;
}

export class SessionStream {
  #log: EventLog;
  #maxReplay: number;
  #subscribers = new Map<string, Set<Subscriber>>();

  constructor(log: EventLog, options: SessionStreamOptions = {}) {
    this.#log = log;
    this.#maxReplay = options.maxReplay ?? 10_000;
  }

  get log(): EventLog {
    return this.#log;
  }

  get maxReplay(): number {
    return this.#maxReplay;
  }

  /** Persist an event and fan it out to live subscribers. */
  async publish(sessionId: string, event: CcrEvent, ts?: number): Promise<StoredEvent> {
    const stored = await this.#log.append(sessionId, event, ts);
    const subs = this.#subscribers.get(sessionId);
    if (subs) {
      for (const subscriber of subs) {
        try {
          subscriber(stored);
        } catch {
          // A broken subscriber must not stop the others from being notified.
        }
      }
    }
    return stored;
  }

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    let subs = this.#subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(sessionId, subs);
    }
    subs.add(subscriber);
    return () => {
      subs?.delete(subscriber);
      if (subs && subs.size === 0) this.#subscribers.delete(sessionId);
    };
  }

  subscriberCount(sessionId: string): number {
    return this.#subscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * Attach a client that wants to resume from `afterSeq`.
   *
   * The subscriber is attached *before* the log is read, and any event that
   * arrives during the read is buffered. Without that, an event published
   * between the read and the attach would be lost — a gap in the client's
   * stream that no cursor could repair, because the client would never learn
   * the sequence number it missed.
   */
  async attach(
    sessionId: string,
    afterSeq: number,
    onEvent: Subscriber,
  ): Promise<AttachResult> {
    const buffered: StoredEvent[] = [];
    let replaying = true;

    const unsubscribe = this.subscribe(sessionId, (event) => {
      if (replaying) buffered.push(event);
      else onEvent(event);
    });

    let replayed: StoredEvent[];
    try {
      // Read one more than we are willing to replay, so an over-large gap is
      // detectable without reading the whole log.
      replayed = await this.#log.read(sessionId, afterSeq, this.#maxReplay + 1);
    } catch (error) {
      unsubscribe();
      throw error;
    }

    if (replayed.length > this.#maxReplay) {
      unsubscribe();
      return { ok: false, error: 'cursor_expired' };
    }

    let lastSeq = afterSeq;
    for (const stored of replayed) {
      onEvent(stored);
      lastSeq = stored.seq;
    }

    replaying = false;
    // Drop buffered events the replay already covered, then deliver the rest
    // in order.
    for (const stored of buffered) {
      if (stored.seq > lastSeq) {
        onEvent(stored);
        lastSeq = stored.seq;
      }
    }

    return { ok: true, dispose: unsubscribe };
  }
}
