import {
  CURSOR_PARAM,
  SESSION_PATH,
  clientHello,
  req,
  safeParseFrame,
  wsProtocols,
  type ControlData,
  type ControlKind,
  type EvtFrame,
  type Frame,
} from '@mote/protocol';
import { SessionListSchema, type SessionList } from '@mote/protocol';

/**
 * The phone's half of the Mote link.
 *
 * One WebSocket per session. Events arrive on it, requests go back up it,
 * and a dropped connection is resumed from a cursor rather than restarted —
 * a phone that was asleep, or that moved from wifi to cellular, comes back to
 * the same session instead of losing it.
 *
 * The client talks to **its own origin**. In production the host serves this
 * bundle, so its origin is the host. In development Vite forwards to the
 * host. The app never needs to know which.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface SessionClientOptions {
  sessionId: string;
  token: string;
  deviceId: string;
  deviceName: string;
  /** Called for every event, in order. */
  onEvent: (event: EvtFrame) => void;
  /** Called whenever the connection state changes. */
  onState: (state: ConnectionState, detail?: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** How long to wait before the first reconnect attempt, and the cap. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class SessionClient {
  #options: SessionClientOptions;
  #ws: WebSocket | null = null;
  #cursor = 0;
  #closed = false;
  #attempt = 0;
  #requestCounter = 0;
  #pending = new Map<string, PendingRequest>();
  #retryTimer: number | undefined;

  constructor(options: SessionClientOptions) {
    this.#options = options;
  }

  /** The highest sequence number seen. The cursor a reconnect resumes from. */
  get cursor(): number {
    return this.#cursor;
  }

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== undefined) {
      window.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#ws?.close(1000, 'left');
    this.#ws = null;
    this.#options.onState('closed');
  }

  /**
   * Send a control message and wait for the host's answer.
   *
   * The `id` is generated here and matched against the `res` frame that
   * comes back, so two requests in flight at once can't be confused for each
   * other.
   */
  request<K extends ControlKind>(kind: K, data: ControlData<K>): Promise<unknown> {
    const socket = this.#ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected.'));
    }

    this.#requestCounter += 1;
    const id = `req_${this.#requestCounter}`;

    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(req(id, kind, data)));
    });
  }

  #open(): void {
    this.#options.onState(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.#url(), wsProtocols(this.#options.token));
    this.#ws = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      // Announce ourselves. The host records the device id against every
      // approval, so a phone that stays quiet is a phone the audit log
      // cannot name.
      socket.send(
        JSON.stringify(
          clientHello({
            deviceId: this.#options.deviceId,
            deviceName: this.#options.deviceName,
          }),
        ),
      );
      this.#options.onState('open');
    };

    socket.onmessage = (message: MessageEvent<unknown>) => {
      this.#receive(message.data);
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where the reconnect is
      // scheduled. An error on its own carries no useful information.
    };

    socket.onclose = (event: CloseEvent) => {
      this.#ws = null;
      this.#failPending(new Error('The connection closed.'));

      if (this.#closed) {
        this.#options.onState('closed');
        return;
      }

      this.#options.onState(
        'reconnecting',
        event.reason || `The host closed the connection (${event.code}).`,
      );
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;

    this.#retryTimer = window.setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#closed) this.#open();
    }, delay);
  }

  #url(): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = SESSION_PATH(this.#options.sessionId);
    // The cursor is the whole trick: the host replays everything after it.
    return `${scheme}//${window.location.host}${path}?${CURSOR_PARAM}=${this.#cursor}`;
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') return;

    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      // Not JSON. Nothing to do with it.
      return;
    }

    const parsed = safeParseFrame(raw);
    if (!parsed.success) {
      // A frame we cannot parse is not one to act on. The protocol says to
      // ignore what we don't understand rather than treat it as an error.
      return;
    }

    const frame: Frame = parsed.data;

    if (frame.t === 'evt') {
      this.#cursor = Math.max(this.#cursor, frame.seq);
      this.#options.onEvent(frame);
      return;
    }

    if (frame.t === 'res') {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.data);
      else pending.reject(new Error(frame.error.message));
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/**
 * Ask the host what sessions it offers.
 *
 * The response is validated against the protocol's schema rather than cast:
 * a phone that trusts a shape it hasn't checked will eventually render
 * `undefined` into a list.
 */
export async function fetchSessions(token: string): Promise<SessionList> {
  const response = await fetch('/mote/v1/sessions', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    throw new Error('The host rejected that token.');
  }
  if (!response.ok) {
    throw new Error(`The host answered ${response.status}.`);
  }

  const parsed = SessionListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('The host sent a session list this app does not understand.');
  }
  return parsed.data;
}
