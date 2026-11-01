import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionClient } from '../src/lib/client.js';

/**
 * The app's half of the link, against a fake host.
 *
 * These are the things that are easy to get quietly wrong and impossible to
 * notice until a phone is on a train: the token has to travel somewhere a
 * browser can put it, the cursor has to survive a reconnect, and a request
 * has to come back with the answer that belongs to it.
 */

/**
 * The browser globals the client touches.
 *
 * A stub rather than a real DOM — the client only reads `location` and uses
 * the timer functions.
 */
const location = {
  protocol: 'http:',
  host: '127.0.0.1:0',
  pathname: '/',
  search: '',
  hash: '',
};

(globalThis as unknown as { window: unknown }).window = {
  location,
  setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

interface FakeConnection {
  socket: WebSocket;
  /**
   * Everything the client has sent, in order.
   *
   * Buffered rather than listened for: the client sends its hello the
   * instant the socket opens, which can be before a test has had a chance to
   * attach a listener. A missed frame would hang the test rather than fail
   * it, which is the worst way to find out.
   */
  messages: string[];
}

interface FakeHost {
  port: number;
  /** The URL each connection asked for. */
  urls: string[];
  /** The subprotocol header each connection offered. */
  protocols: (string | string[] | undefined)[];
  connections: FakeConnection[];
  close: () => Promise<void>;
}

async function startFakeHost(): Promise<FakeHost> {
  const httpServer = createServer();
  const wss = new WebSocketServer({
    server: httpServer,
    // The same rule the host uses: select the protocol, never the token.
    handleProtocols: (protocols) => (protocols.has('mote-v1') ? 'mote-v1' : false),
  });

  const urls: string[] = [];
  const protocols: (string | string[] | undefined)[] = [];
  const connections: FakeConnection[] = [];

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connection: FakeConnection = { socket, messages: [] };
    socket.on('message', (raw) => connection.messages.push(raw.toString()));
    connections.push(connection);
    urls.push(request.url ?? '');
    protocols.push(request.headers['sec-websocket-protocol']);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    urls,
    protocols,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        // Every live connection, not just the ones this test remembers — a
        // client that reconnects would otherwise keep the server open.
        for (const client of wss.clients) client.terminate();
        wss.close();
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/** Wait for something to become true, rather than sleeping a fixed amount. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeClient(host: FakeHost, token = 'secret-token'): SessionClient {
  location.host = `127.0.0.1:${host.port}`;
  return new SessionClient({
    sessionId: 'sess_test',
    token,
    deviceId: 'device_test',
    deviceName: 'test',
    onEvent: () => {},
    onState: () => {},
  });
}

test('the token rides in the subprotocol, never in the URL', async () => {
  const host = await startFakeHost();
  const client = makeClient(host);
  try {
    client.connect();
    await waitFor(() => host.urls.length > 0);

    const url = host.urls[0] ?? '';
    assert.ok(!url.includes('secret-token'), 'the token must not appear in the URL');
    assert.match(url, /after=0/);

    const offered = host.protocols[0];
    const list = Array.isArray(offered) ? offered : (offered ?? '').split(',');
    assert.ok(
      list.some((entry) => entry.trim() === 'secret-token'),
      'the token must be offered as a subprotocol',
    );
  } finally {
    client.close();
    await host.close();
  }
});

test('the client announces itself when it connects', async () => {
  const host = await startFakeHost();
  const client = makeClient(host);
  try {
    client.connect();
    await waitFor(() => host.connections.length > 0);
    await waitFor(() => (host.connections[0]?.messages.length ?? 0) > 0);

    const frame = JSON.parse(host.connections[0]?.messages[0] ?? '{}') as Record<string, unknown>;
    assert.equal(frame.t, 'hello');
    assert.equal(frame.role, 'client');
    assert.equal(frame.deviceId, 'device_test');
  } finally {
    client.close();
    await host.close();
  }
});

test('a reconnect resumes from the cursor instead of starting over', async () => {
  const host = await startFakeHost();
  const client = makeClient(host);
  try {
    client.connect();
    await waitFor(() => host.connections.length > 0);

    const connection = host.connections[0];
    assert.ok(connection);
    connection.socket.send(
      JSON.stringify({
        v: 1,
        t: 'evt',
        seq: 7,
        sessionId: 'sess_test',
        ts: 1,
        type: 'assistant.delta',
        data: { messageId: 'm1', text: 'hello' },
      }),
    );
    await waitFor(() => client.cursor === 7);

    // Drop the connection the way a phone losing signal would.
    connection.socket.close();
    await waitFor(() => host.urls.length > 1, 8_000);

    const resumed = host.urls[1] ?? '';
    assert.match(resumed, /after=7/, 'the reconnect must ask for what it missed');
  } finally {
    client.close();
    await host.close();
  }
});

test('a request is answered by the response that carries its id', async () => {
  const host = await startFakeHost();
  const client = makeClient(host);
  try {
    client.connect();
    await waitFor(() => host.connections.length > 0);

    const connection = host.connections[0];
    assert.ok(connection);

    const answer = client.request('prompt.send', { text: 'hello' });

    // The hello comes first; the request is what we're after.
    await waitFor(() =>
      connection.messages.some((raw) => (JSON.parse(raw) as { t?: string }).t === 'req'),
    );
    const request = JSON.parse(
      connection.messages.find((raw) => (JSON.parse(raw) as { t?: string }).t === 'req') ?? '{}',
    ) as Record<string, unknown>;
    assert.equal(request.t, 'req');
    assert.equal(request.kind, 'prompt.send');

    connection.socket.send(
      JSON.stringify({
        v: 1,
        t: 'res',
        id: request.id,
        ok: true,
        data: { accepted: true },
      }),
    );

    assert.deepEqual(await answer, { accepted: true });
  } finally {
    client.close();
    await host.close();
  }
});

test('a frame the client cannot parse is ignored, not fatal', async () => {
  const host = await startFakeHost();
  const events: unknown[] = [];
  let tolerant: SessionClient | undefined;
  try {
    location.host = `127.0.0.1:${host.port}`;
    tolerant = new SessionClient({
      sessionId: 'sess_test',
      token: 'secret-token',
      deviceId: 'device_test',
      deviceName: 'test',
      onEvent: (event) => events.push(event),
      onState: () => {},
    });

    tolerant.connect();
    await waitFor(() => host.connections.length > 0);

    const connection = host.connections[0];
    assert.ok(connection);
    connection.socket.send('this is not json');
    connection.socket.send(JSON.stringify({ v: 1, t: 'evt', type: 'from.the.future' }));

    // A good frame still arrives afterwards.
    connection.socket.send(
      JSON.stringify({
        v: 1,
        t: 'evt',
        seq: 1,
        sessionId: 'sess_test',
        ts: 1,
        type: 'assistant.delta',
        data: { messageId: 'm1', text: 'still here' },
      }),
    );

    await waitFor(() => events.length > 0);
    assert.equal(events.length, 1);
  } finally {
    tolerant?.close();
    await host.close();
  }
});
