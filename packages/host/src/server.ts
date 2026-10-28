import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  fail,
  hostHello,
  isRemotelySettableMode,
  ok,
  type Frame,
  type ReqFrame,
} from '@ccr/protocol';
import { attachWebSocketServer, type FrameConnection, type Logger, type SessionStream } from '@ccr/core';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { AuditLog } from './audit.js';
import type { SessionManager } from './session-manager.js';

/**
 * The host's HTTP and WebSocket server.
 *
 * One port serves everything: the PWA, a discovery endpoint, and the session
 * event stream. A phone on the same network opens the URL the daemon prints
 * and is talking to the agent.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export interface HostServerOptions {
  sessions: SessionManager;
  stream: SessionStream;
  logger: Logger;
  audit: AuditLog;
  hostId: string;
  hostName: string;
  claudeVersion: string;
  sdkVersion: string;
  token: string;
  /** Directory containing the built PWA. */
  appDir: string;
}

export class HostServer {
  #options: HostServerOptions;
  #http: Server;

  constructor(options: HostServerOptions) {
    this.#options = options;
    this.#http = createServer((request, response) => {
      void this.#handleHttp(request, response);
    });

    attachWebSocketServer(this.#http, {
      pathPrefix: '/ccr/v1/session',
      authorize: (request, url) => this.#authorize(request, url),
      onConnection: (connection, _request, url) => {
        void this.#handleSocket(connection, url);
      },
    });
  }

  get httpServer(): Server {
    return this.#http;
  }

  /**
   * Check the bearer token.
   *
   * The token is required even on a home LAN. Without it, anyone on the café
   * wifi can approve a tool call on the machine — and approving a tool call
   * is running code.
   */
  #authorize(request: IncomingMessage, url: URL): string | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return 'missing bearer token';
    }
    const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
    const expected = Buffer.from(this.#options.token, 'utf8');
    if (presented.length !== expected.length) return 'invalid token';
    if (!timingSafeEqual(presented, expected)) return 'invalid token';
    return undefined;
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const { logger } = this.#options;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }

    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    if (url.pathname === '/ccr/v1/sessions') {
      // Discovery: what a phone may connect to. Authenticated like everything
      // else — the list reveals the user's project paths.
      const refusal = this.#authorize(request, url);
      if (refusal) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: refusal }));
        return;
      }
      const body = JSON.stringify({
        hostId: this.#options.hostId,
        hostName: this.#options.hostName,
        claudeVersion: this.#options.claudeVersion,
        sdkVersion: this.#options.sdkVersion,
        sessions: this.#options.sessions.list(),
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    await this.#serveStatic(url.pathname, response, request.method === 'HEAD');
  }

  async #serveStatic(pathname: string, response: ServerResponse, headOnly: boolean): Promise<void> {
    const root = resolve(this.#options.appDir);

    let relative = decodeURIComponent(pathname);
    if (relative.endsWith('/')) relative += 'index.html';

    // Resolve inside the root and verify. `normalize` collapses `..` before
    // the check, so `/../../etc/passwd` cannot escape.
    const target = resolve(root, `.${normalize(relative)}`);
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden');
      return;
    }

    let filePath = target;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      // Unknown paths fall back to the app shell — it's a single-page app.
      filePath = join(root, 'index.html');
    }

    try {
      const info = await stat(filePath);
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-cache',
      });
      if (headOnly) {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        'The PWA is not built yet. Run `npm run build` in packages/app, or use `npm run dev`.',
      );
    }
  }

  async #handleSocket(connection: FrameConnection, url: URL): Promise<void> {
    const { logger, sessions, stream } = this.#options;

    // The path is /ccr/v1/session/<sessionId>
    const sessionId = decodeURIComponent(url.pathname.replace(/^\/ccr\/v1\/session\/?/, ''));
    const session = sessions.get(sessionId);
    if (!session) {
      connection.close(4004, 'no such session');
      return;
    }

    // Start the Claude process lazily — the first client to attach is what
    // causes the work to start.
    try {
      await sessions.ensureStarted(sessionId);
    } catch (error) {
      logger.error('failed to start session', { sessionId, error: String(error) });
      connection.close(4005, 'session failed to start');
      return;
    }

    connection.send(
      hostHello({
        hostId: this.#options.hostId,
        hostName: this.#options.hostName,
        claudeVersion: this.#options.claudeVersion,
        sdkVersion: this.#options.sdkVersion,
        workspaces: sessions.list().map((s) => ({ path: s.cwd, label: s.label })),
      }),
    );

    let deviceId = 'unknown';
    connection.onFrame = (frame: Frame) => {
      if (frame.t === 'hello' && frame.role === 'client') {
        deviceId = frame.deviceId;
        return;
      }
      if (frame.t === 'req') {
        void this.#handleRequest(frame, sessionId, connection, deviceId);
      }
    };

    const after = Number(url.searchParams.get('after') ?? '0');
    const cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;

    const attached = await stream.attach(sessionId, cursor, (stored) => {
      connection.send({
        v: PROTOCOL_VERSION,
        t: 'evt',
        seq: stored.seq,
        sessionId: stored.sessionId,
        ts: stored.ts,
        ...stored.event,
      } as Frame);
    });

    if (!attached.ok) {
      // The gap is too large to replay. The client re-fetches history and
      // starts a fresh cursor.
      connection.send(fail('cursor', 'cursor_expired', 'The gap is too large to replay.'));
      connection.close(4009, 'cursor expired');
      return;
    }

    connection.onClose = () => {
      attached.dispose();
    };
  }

  async #handleRequest(
    frame: ReqFrame,
    sessionId: string,
    connection: FrameConnection,
    deviceId: string,
  ): Promise<void> {
    const { sessions, logger, audit } = this.#options;
    const session = sessions.get(sessionId);
    if (!session) {
      connection.send(fail(frame.id, 'no_such_session', 'No such session.'));
      return;
    }

    try {
      switch (frame.kind) {
        case 'prompt.send': {
          await session.sendPrompt(frame.data.text, frame.data.priority);
          connection.send(ok(frame.id));
          void audit.append({
            ts: Date.now(),
            sessionId,
            actor: deviceId,
            kind: 'prompt.send',
          });
          break;
        }

        case 'session.interrupt': {
          await session.interrupt();
          connection.send(ok(frame.id));
          void audit.append({
            ts: Date.now(),
            sessionId,
            actor: deviceId,
            kind: 'session.interrupt',
          });
          break;
        }

        case 'permission.resolve': {
          const settled = await session.resolvePermission(
            frame.data.requestId,
            {
              behavior: frame.data.behavior,
              updatedPermissions: frame.data.updatedPermissions,
              message: frame.data.message,
            },
            deviceId,
          );
          if (!settled) {
            // Unknown, expired, or already-answered. A late verdict must
            // never apply to a different prompt.
            connection.send(
              fail(frame.id, 'no_such_request', 'That request is no longer pending.'),
            );
            break;
          }
          connection.send(ok(frame.id));
          break;
        }

        case 'session.model': {
          await session.setModel(frame.data.model);
          connection.send(ok(frame.id));
          void audit.append({
            ts: Date.now(),
            sessionId,
            actor: deviceId,
            kind: 'session.model',
          });
          break;
        }

        case 'session.permission_mode': {
          if (!isRemotelySettableMode(frame.data.mode)) {
            connection.send(
              fail(
                frame.id,
                'forbidden_mode',
                `"${frame.data.mode}" cannot be set from a remote client.`,
              ),
            );
            break;
          }
          await session.setPermissionMode(frame.data.mode);
          connection.send(ok(frame.id));
          void audit.append({
            ts: Date.now(),
            sessionId,
            actor: deviceId,
            kind: 'session.permission_mode',
          });
          break;
        }

        case 'session.rename': {
          const claudeSessionId = session.claudeSessionId;
          if (claudeSessionId) {
            await renameSession(claudeSessionId, frame.data.title, { dir: session.cwd });
          }
          connection.send(ok(frame.id));
          break;
        }

        case 'session.close': {
          await session.close();
          connection.send(ok(frame.id));
          break;
        }

        default: {
          // The union is exhaustive, so `frame` is `never` here.
          const exhaustive: never = frame;
          throw new Error(`unhandled control kind: ${String(exhaustive)}`);
        }
      }
    } catch (error) {
      logger.warn('control request failed', {
        kind: frame.kind,
        error: String(error),
      });
      connection.send(fail(frame.id, 'internal', 'The host could not complete that request.'));
    }
  }

  listen(port: number, bind: string): Promise<{ port: number; address: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.#http.once('error', rejectPromise);
      this.#http.listen(port, bind, () => {
        this.#http.removeListener('error', rejectPromise);
        const address = this.#http.address();
        if (!address || typeof address === 'string') {
          resolvePromise({ port, address: bind });
          return;
        }
        resolvePromise({ port: address.port, address: address.address });
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.#http.close(() => resolvePromise());
    });
  }
}

/** Where the built PWA lives, relative to this file. */
export function defaultAppDir(): string {
  return fileURLToPath(new URL('../../app/dist/', import.meta.url));
}
