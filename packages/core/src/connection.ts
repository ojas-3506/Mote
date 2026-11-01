import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { WS_PROTOCOL, safeParseFrame, type Frame } from '@mote/protocol';

/**
 * A JSON text-frame connection.
 *
 * Both ends of a Mote link — phone and host — speak the same envelope, so the
 * framing rules live here once: a size limit, a parse-failure policy, and a
 * keepalive that reaps half-open sockets.
 */

export interface FrameConnectionOptions {
  /** Maximum size of a single inbound message. */
  maxFrameBytes?: number;
  /** How often to ping an idle peer. 0 disables the keepalive. */
  pingIntervalMs?: number;
}

export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
export const DEFAULT_PING_INTERVAL_MS = 30_000;

export class FrameConnection {
  #ws: WebSocket;
  #maxFrameBytes: number;
  #alive = true;
  #pingTimer?: NodeJS.Timeout;

  onFrame: (frame: Frame) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor(ws: WebSocket, options: FrameConnectionOptions = {}) {
    this.#ws = ws;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // The protocol is JSON text frames only.
        this.close(1003, 'binary frames are not supported');
        return;
      }

      const text = data.toString();
      if (Buffer.byteLength(text, 'utf8') > this.#maxFrameBytes) {
        this.close(1009, 'frame too large');
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        this.close(1007, 'invalid JSON');
        return;
      }

      const parsed = safeParseFrame(raw);
      if (!parsed.success) {
        // A malformed frame means the peer is speaking a protocol we don't
        // understand. Refusing it is safer than guessing.
        this.close(1002, 'invalid frame');
        return;
      }

      this.onFrame(parsed.data);
    });

    ws.on('pong', () => {
      this.#alive = true;
    });

    ws.on('error', (error: Error) => {
      this.onError(error);
    });

    ws.on('close', (code, reason) => {
      this.#stopPing();
      this.onClose(code, reason.toString());
    });

    const pingInterval = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    if (pingInterval > 0) {
      this.#pingTimer = setInterval(() => {
        if (!this.#alive) {
          this.close(1001, 'no pong');
          return;
        }
        this.#alive = false;
        try {
          this.#ws.ping();
        } catch {
          this.close(1001, 'ping failed');
        }
      }, pingInterval);
      this.#pingTimer.unref?.();
    }
  }

  #stopPing(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
    }
  }

  get readyState(): WebSocket['readyState'] {
    return this.#ws.readyState;
  }

  send(frame: Frame): boolean {
    if (this.#ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.#ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = ''): void {
    this.#stopPing();
    try {
      this.#ws.close(code, reason);
    } catch {
      this.#ws.terminate();
    }
  }

  terminate(): void {
    this.#stopPing();
    this.#ws.terminate();
  }
}

export interface WebSocketServerOptions {
  /** Exact path to accept upgrades on. */
  path?: string;
  /**
   * Path prefix to accept upgrades on. Use this when the connection carries
   * an identifier in the path, e.g. `/mote/v1/session/<sessionId>`.
   */
  pathPrefix?: string;
  /** Maximum inbound message size. */
  maxFrameBytes?: number;
  pingIntervalMs?: number;
  /** Decide whether to accept a connection. Return an error string to refuse. */
  authorize?: (request: IncomingMessage, url: URL) => string | undefined;
  onConnection: (connection: FrameConnection, request: IncomingMessage, url: URL) => void;
}

/**
 * Attach a WebSocket endpoint to an existing HTTP server.
 *
 * Using `noServer` and handling `upgrade` ourselves means the HTTP server can
 * also serve the PWA and the REST endpoints on the same port.
 */
export function attachWebSocketServer(
  httpServer: HttpServer,
  options: WebSocketServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    // A browser that offered subprotocols fails the connection if the
    // server selects none, so one has to be selected — but only the one
    // that names the protocol. The token travels in the same header and is
    // never echoed back.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    const matches =
      options.path !== undefined
        ? url.pathname === options.path
        : options.pathPrefix !== undefined
          ? url.pathname === options.pathPrefix ||
            url.pathname.startsWith(`${options.pathPrefix}/`)
          : false;

    if (!matches) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const refusal = options.authorize?.(request, url);
    if (refusal) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n${refusal}`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new FrameConnection(ws, {
        maxFrameBytes: options.maxFrameBytes,
        pingIntervalMs: options.pingIntervalMs,
      });
      options.onConnection(connection, request, url);
    });
  });

  return wss;
}
