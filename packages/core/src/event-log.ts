import { createReadStream } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { CcrEvent } from '@ccr/protocol';

/**
 * The append-only event log.
 *
 * Every event a client sees passes through here. The log is what makes
 * "resume from a cursor" work: a client that reconnects with `?after=N` is
 * replayed the gap rather than being told to start over.
 *
 * **The log assigns `seq`.** It is the ordering authority because every
 * client sees events through it — see EVENT-PROTOCOL.md §3.
 */

export interface StoredEvent {
  /** Per-session, monotonically increasing, gapless. */
  seq: number;
  sessionId: string;
  ts: number;
  event: CcrEvent;
}

export interface EventLog {
  /** Assign a sequence number, persist, and return the stored event. */
  append(sessionId: string, event: CcrEvent, ts?: number): Promise<StoredEvent>;
  /** Events with `seq > afterSeq`, oldest first, at most `limit` of them. */
  read(sessionId: string, afterSeq: number, limit: number): Promise<StoredEvent[]>;
  /** Highest sequence number for the session, or 0 when there are none. */
  lastSeq(sessionId: string): Promise<number>;
  /** Ids of every session with at least one event. */
  listSessions(): Promise<string[]>;
  /** Release any resources. */
  close(): Promise<void>;
}

/** An in-memory log. Used by tests and by hosts running without persistence. */
export class MemoryEventLog implements EventLog {
  #events = new Map<string, StoredEvent[]>();
  #nextSeq = new Map<string, number>();

  async append(sessionId: string, event: CcrEvent, ts = Date.now()): Promise<StoredEvent> {
    const seq = this.#nextSeq.get(sessionId) ?? 1;
    this.#nextSeq.set(sessionId, seq + 1);
    const stored: StoredEvent = { seq, sessionId, ts, event };
    const list = this.#events.get(sessionId);
    if (list) list.push(stored);
    else this.#events.set(sessionId, [stored]);
    return stored;
  }

  async read(sessionId: string, afterSeq: number, limit: number): Promise<StoredEvent[]> {
    const list = this.#events.get(sessionId);
    if (!list) return [];
    const out: StoredEvent[] = [];
    for (const stored of list) {
      if (stored.seq > afterSeq) {
        out.push(stored);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async lastSeq(sessionId: string): Promise<number> {
    return (this.#nextSeq.get(sessionId) ?? 1) - 1;
  }

  async listSessions(): Promise<string[]> {
    return [...this.#events.keys()];
  }

  async close(): Promise<void> {}
}

/**
 * A durable, append-only log: one JSONL file per session.
 *
 * The file is the durable record; an in-memory index serves reads. That index
 * is rebuilt on open, so a restart preserves both the history and the
 * sequence numbering — a client that reconnects after a host restart can still
 * resume from its cursor.
 */
export class JsonlEventLog implements EventLog {
  #dir: string;
  #events = new Map<string, StoredEvent[]>();
  #nextSeq = new Map<string, number>();
  #opened: Promise<void>;

  constructor(dir: string) {
    this.#dir = dir;
    this.#opened = this.#load();
  }

  async #load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.#dir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      const events = await this.#readFile(join(this.#dir, entry));
      this.#events.set(sessionId, events);
      const last = events.at(-1);
      this.#nextSeq.set(sessionId, (last?.seq ?? 0) + 1);
    }
  }

  async #readFile(path: string): Promise<StoredEvent[]> {
    const events: StoredEvent[] = [];
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return events;
    }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        // A torn final line is expected if the process died mid-append.
        // Skip it rather than refusing to start.
        continue;
      }
    }
    return events;
  }

  #file(sessionId: string): string {
    // Session ids are opaque strings; keep them filesystem-safe.
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.#dir, `${safe}.jsonl`);
  }

  async append(sessionId: string, event: CcrEvent, ts = Date.now()): Promise<StoredEvent> {
    await this.#opened;
    const seq = this.#nextSeq.get(sessionId) ?? 1;
    this.#nextSeq.set(sessionId, seq + 1);
    const stored: StoredEvent = { seq, sessionId, ts, event };
    await appendFile(this.#file(sessionId), `${JSON.stringify(stored)}\n`, 'utf8');
    const list = this.#events.get(sessionId);
    if (list) list.push(stored);
    else this.#events.set(sessionId, [stored]);
    return stored;
  }

  async read(sessionId: string, afterSeq: number, limit: number): Promise<StoredEvent[]> {
    await this.#opened;
    const list = this.#events.get(sessionId);
    if (!list) return [];
    const out: StoredEvent[] = [];
    for (const stored of list) {
      if (stored.seq > afterSeq) {
        out.push(stored);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async lastSeq(sessionId: string): Promise<number> {
    await this.#opened;
    return (this.#nextSeq.get(sessionId) ?? 1) - 1;
  }

  async listSessions(): Promise<string[]> {
    await this.#opened;
    return [...this.#events.keys()];
  }

  async close(): Promise<void> {
    await this.#opened;
  }
}

/**
 * Stream a JSONL file line by line — used by tooling that reads the log
 * without loading it all into memory.
 */
export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}
