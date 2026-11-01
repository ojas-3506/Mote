import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { MemoryEventLog, SessionStream, silentLogger } from '@ccr/core';
import type { StoredEvent } from '@ccr/core';
import { AuditLog, hashInput } from '../src/audit.js';
import { parseArgs } from '../src/config.js';
import { HostServer } from '../src/server.js';
import { SessionManager, sessionIdForPath } from '../src/session-manager.js';
import { Session, type QueryFactory } from '../src/session.js';

/**
 * The permission flow is the part of ccr that can run code on someone's
 * machine. These tests drive it end to end with a fake SDK, so the rules are
 * checked without spawning a real Claude Code process.
 */

/** A stand-in for the SDK's `query()` that lets a test push messages at it. */
class FakeQuery {
  #queue: SDKMessage[] = [];
  #wake: (() => void) | null = null;
  options: Options | undefined;

  constructor(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) {
    this.options = params.options;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    while (true) {
      while (this.#queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
      const message = this.#queue.shift();
      if (message) yield message;
    }
  }

  push(message: SDKMessage): void {
    this.#queue.push(message);
    this.#wake?.();
    this.#wake = null;
  }

  async interrupt() {
    return undefined;
  }
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async close(): Promise<void> {}
}

interface Harness {
  session: Session;
  fake: FakeQuery;
  events: () => StoredEvent[];
  audit: AuditLog;
  cleanup: () => Promise<void>;
}

async function harness(overrides: Partial<Parameters<typeof makeSession>[0]> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ccr-host-test-'));
  const log = new MemoryEventLog();
  const stream = new SessionStream(log);
  const audit = new AuditLog(join(dir, 'audit.log'));
  const fake = new FakeQuery({ prompt: '' });
  const factory: QueryFactory = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    fake.options = params.options;
    return fake as unknown as Query;
  }) as QueryFactory;

  const session = makeSession({ stream, audit, queryFactory: factory, ...overrides });
  await session.start();

  return {
    session,
    fake,
    events: () => log.read(session.id, 0, 1000),
    audit,
    cleanup: async () => {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function makeSession(options: {
  stream: SessionStream;
  audit: AuditLog;
  queryFactory: QueryFactory;
  permissionTimeoutMs?: number;
}) {
  return new Session({
    id: 'sess_test',
    cwd: '/tmp/example',
    label: 'example',
    hostId: 'host_1',
    claudeVersion: '2.1.312',
    stream: options.stream,
    logger: silentLogger,
    audit: options.audit,
    queryFactory: options.queryFactory,
    permissionTimeoutMs: options.permissionTimeoutMs ?? 5_000,
  });
}

/** The options object the SDK would pass to `canUseTool`. */
function toolOptions(overrides: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu_1',
    requestId: 'req_sdk_1',
    title: 'Claude wants to run `rm -rf build`',
    displayName: 'Bash',
    description: 'Claude wants to run a command',
    defaultToNo: true,
    ...overrides,
  } as Parameters<NonNullable<Options['canUseTool']>>[2];
}

test('a permission request is published with the SDK prompt text and the defaultToNo flag', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);

    const pending = canUseTool('Bash', { command: 'rm -rf build' }, toolOptions());

    // The request reaches the phone before any verdict is possible.
    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    assert.ok(request, 'expected a permission.request event');
    assert.equal(request.event.type, 'permission.request');
    assert.equal(request.event.data.defaultToNo, true);
    assert.equal(request.event.data.title, 'Claude wants to run `rm -rf build`');
    assert.equal(request.event.data.toolUseId, 'tu_1');
    assert.deepEqual(request.event.data.input, { command: 'rm -rf build' });

    await h.session.resolvePermission(
      request.event.data.requestId,
      { behavior: 'deny', message: 'no' },
      'device_1',
    );
    await pending;
  } finally {
    await h.cleanup();
  }
});

test('defaultToNo defaults to true when the SDK does not say', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions({ defaultToNo: undefined }));

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    assert.equal(request?.event.type === 'permission.request' && request.event.data.defaultToNo, true);

    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';
    await h.session.resolvePermission(id, { behavior: 'deny' }, 'device_1');
    await pending;
  } finally {
    await h.cleanup();
  }
});

test('an allowed request resolves the SDK callback with an allow verdict', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';
    assert.ok(await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1'));

    const result = await pending;
    assert.ok(result);
    assert.equal(result.behavior, 'allow');
    assert.equal(result.decisionClassification, 'user_temporary');
  } finally {
    await h.cleanup();
  }
});

test('a denied request resolves the SDK callback with a deny verdict', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';
    await h.session.resolvePermission(id, { behavior: 'deny', message: 'not this time' }, 'device_1');

    const result = await pending;
    assert.ok(result);
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'not this time');
    assert.equal(result.decisionClassification, 'user_reject');
  } finally {
    await h.cleanup();
  }
});

test('a verdict for an unknown request is refused', async () => {
  const h = await harness();
  try {
    assert.equal(await h.session.resolvePermission('nope', { behavior: 'allow' }, 'device_1'), false);
  } finally {
    await h.cleanup();
  }
});

test('a verdict is applied exactly once', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';

    assert.equal(await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1'), true);
    assert.equal(
      await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1'),
      false,
      'a replayed verdict must be refused',
    );
    await pending;
  } finally {
    await h.cleanup();
  }
});

test('an unanswered request times out as a denial', async () => {
  const h = await harness({ permissionTimeoutMs: 30 });
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const result = await canUseTool('Bash', { command: 'ls' }, toolOptions());

    assert.ok(result);
    assert.equal(result.behavior, 'deny');
    assert.match(result.message, /timed out/i);
  } finally {
    await h.cleanup();
  }
});

test('a late verdict after a timeout is refused', async () => {
  const h = await harness({ permissionTimeoutMs: 30 });
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    await canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setTimeout(resolve, 60));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';

    assert.equal(
      await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1'),
      false,
      'a late allow must not be applied',
    );
  } finally {
    await h.cleanup();
  }
});

test('only session-scoped suggestions are offered to the phone', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool(
      'Bash',
      { command: 'ls' },
      toolOptions({
        suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    assert.ok(request?.event.type === 'permission.request');
    assert.equal(request.event.data.suggestions.length, 1);
    assert.equal(request.event.data.suggestions[0]?.destination, 'session');

    const id = request.event.data.requestId;
    await h.session.resolvePermission(id, { behavior: 'deny' }, 'device_1');
    await pending;
  } finally {
    await h.cleanup();
  }
});

test('a suggestion that would grant everything is never offered', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool(
      'Bash',
      { command: 'ls' },
      toolOptions({
        suggestions: [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    assert.ok(request?.event.type === 'permission.request');
    assert.deepEqual(request.event.data.suggestions, []);

    const id = request.event.data.requestId;
    await h.session.resolvePermission(id, { behavior: 'deny' }, 'device_1');
    await pending;
  } finally {
    await h.cleanup();
  }
});

test('a permission update the client sends back is filtered again', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';

    // A client that sends back a grant-everything update must not get it.
    await h.session.resolvePermission(
      id,
      {
        behavior: 'allow',
        updatedPermissions: [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      },
      'device_1',
    );

    const result = await pending;
    assert.ok(result);
    assert.equal(result.behavior, 'allow');
    assert.equal(result.updatedPermissions, undefined);
    assert.equal(result.decisionClassification, 'user_temporary');
  } finally {
    await h.cleanup();
  }
});

test('the SDK is told to answer permission prompts at the host', async () => {
  const h = await harness();
  try {
    assert.equal(h.fake.options?.permissionPrompts, 'host');
    assert.ok(h.fake.options?.canUseTool);
  } finally {
    await h.cleanup();
  }
});

test('closing the session fails an outstanding request closed', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    await h.session.close();

    const result = await pending;
    assert.ok(result);
    assert.equal(result.behavior, 'deny');
  } finally {
    await h.cleanup();
  }
});

test('an approval is written to the audit log with a hash, not the input', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    const pending = canUseTool('Bash', { command: 'cat /etc/shadow' }, toolOptions());

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';
    await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1');
    await pending;

    const entries = await h.audit.read();
    const entry = entries.find((e) => e.kind === 'permission.resolve');
    assert.ok(entry);
    assert.equal(entry.decision, 'allow');
    assert.equal(entry.toolName, 'Bash');
    assert.equal(entry.actor, 'device_1');
    assert.ok(entry.inputHash);
    assert.equal(entry.inputHash, hashInput({ command: 'cat /etc/shadow' }));

    const exported = await h.audit.export();
    assert.ok(!exported.includes('/etc/shadow'), 'the log must not contain the tool input');
  } finally {
    await h.cleanup();
  }
});

test('session ids are stable and distinct for directories with the same name', () => {
  const a = sessionIdForPath('/home/user/projects/myrepo');
  const b = sessionIdForPath('/home/user/projects/myrepo');
  const c = sessionIdForPath('/srv/other/myrepo');

  assert.equal(a, b, 'the same path must produce the same id');
  assert.notEqual(a, c, 'different paths must not collide');
  assert.match(a, /^sess_[a-z0-9-]+$/);
});

test('the CLI parses the flags it documents', () => {
  const { config } = parseArgs([
    '--port', '9000',
    '--cwd', '/tmp/a',
    '--cwd', '/tmp/b',
    '--model', 'claude-sonnet-5',
    '--log-level', 'debug',
    '--no-serve-app',
  ]);

  assert.equal(config.port, 9000);
  assert.equal(config.workspaces?.length, 2);
  assert.equal(config.model, 'claude-sonnet-5');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.serveApp, false);
});

test('the CLI refuses a permission mode that is not remotely settable', () => {
  assert.throws(() => parseArgs(['--permission-mode', 'bypassPermissions']), /permission-mode/);
});

test('the CLI refuses an unknown flag', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('the CLI reads a resume id', () => {
  const { config } = parseArgs(['--resume', 'sess_abc']);
  assert.equal(config.resume, 'sess_abc');
});

// ── The server ─────────────────────────────────────────────────────────────

/**
 * A server with one workspace and no Claude process behind it.
 *
 * Sessions start lazily, so nothing spawns unless a client attaches — which
 * is what keeps these tests from starting a real Claude Code session.
 */
async function serverHarness(serveApp = true): Promise<{
  server: HostServer;
  port: number;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ccr-host-test-'));
  const stream = new SessionStream(new MemoryEventLog());
  const audit = new AuditLog(join(dir, 'audit.log'));
  const sessions = new SessionManager({
    workspaces: [{ path: dir }],
    stream,
    logger: silentLogger,
    audit,
    hostId: 'host_1',
    claudeVersion: '2.1.312',
  });
  const server = new HostServer({
    sessions,
    stream,
    logger: silentLogger,
    audit,
    hostId: 'host_1',
    hostName: 'test-host',
    claudeVersion: '2.1.312',
    sdkVersion: '0.3.312',
    token: 'test-token',
    appDir: join(dir, 'app'),
    serveApp,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  return {
    server,
    port,
    cleanup: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('a malformed URL is a 400, not a dead daemon', async () => {
  const h = await serverHarness();
  try {
    // `decodeURIComponent('%ZZ')` throws. Unhandled, that ends the process —
    // and the process is what holds the Claude session open.
    const response = await fetch(`http://127.0.0.1:${h.port}/%ZZ`);
    assert.equal(response.status, 400);

    // Still serving.
    const health = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
  } finally {
    await h.cleanup();
  }
});

test('a malformed session id in the WebSocket path does not kill the daemon', async () => {
  const h = await serverHarness();
  try {
    await new Promise<void>((resolve) => {
      const socket = connect(h.port, '127.0.0.1', () => {
        socket.write(
          'GET /ccr/v1/session/%ZZ?after=0 HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Authorization: Bearer test-token\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => resolve());
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 2_000);
    });

    const health = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    assert.equal(health.status, 200, 'the daemon must survive a malformed session id');
  } finally {
    await h.cleanup();
  }
});

test('the server does not serve the PWA when it is turned off', async () => {
  const h = await serverHarness(false);
  try {
    const response = await fetch(`http://127.0.0.1:${h.port}/`);
    assert.equal(response.status, 404);
  } finally {
    await h.cleanup();
  }
});

// ── The audit log ──────────────────────────────────────────────────────────

test('a verdict for an unknown request is not recorded', async () => {
  const h = await harness();
  try {
    assert.equal(
      await h.session.resolvePermission('nope', { behavior: 'allow' }, 'device_1'),
      false,
    );
    const entries = await h.audit.read();
    assert.equal(
      entries.length,
      0,
      'a refused verdict must not be recorded as an approval',
    );
  } finally {
    await h.cleanup();
  }
});

test('a late allow after a timeout is not recorded as an approval', async () => {
  const h = await harness({ permissionTimeoutMs: 30 });
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    await canUseTool('Bash', { command: 'ls' }, toolOptions());

    await new Promise((resolve) => setTimeout(resolve, 60));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    const id = request?.event.type === 'permission.request' ? request.event.data.requestId : '';

    assert.equal(await h.session.resolvePermission(id, { behavior: 'allow' }, 'device_1'), false);

    const entries = await h.audit.read();
    assert.equal(
      entries.filter((e) => e.decision === 'allow').length,
      0,
      'the log must not claim an approval that never applied',
    );
  } finally {
    await h.cleanup();
  }
});

test('a request that timed out is recorded as a denial', async () => {
  const h = await harness({ permissionTimeoutMs: 30 });
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);
    await canUseTool('Bash', { command: 'ls' }, toolOptions());

    const entries = await h.audit.read();
    const denial = entries.find((e) => e.decision === 'deny');
    assert.ok(denial, 'a timed-out request must leave a denial in the log');
    assert.equal(denial.by, 'timeout');
    assert.equal(denial.toolName, 'Bash');
  } finally {
    await h.cleanup();
  }
});

// ── What the phone gets to see ─────────────────────────────────────────────

test('the permission request carries the SDK context about why it is asking', async () => {
  const h = await harness();
  try {
    const canUseTool = h.fake.options?.canUseTool;
    assert.ok(canUseTool);

    const pending = canUseTool(
      'Bash',
      { command: 'cat /etc/shadow' },
      toolOptions({
        blockedPath: '/etc/shadow',
        decisionReason: 'outside the allowed directories',
        agentID: 'agent_7',
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    const request = (await h.events()).find((e) => e.event.type === 'permission.request');
    assert.ok(request?.event.type === 'permission.request');
    assert.equal(request.event.data.blockedPath, '/etc/shadow');
    assert.equal(request.event.data.decisionReason, 'outside the allowed directories');
    assert.equal(request.event.data.agentID, 'agent_7');

    await h.session.resolvePermission(
      request.event.data.requestId,
      { behavior: 'deny' },
      'device_1',
    );
    await pending;
  } finally {
    await h.cleanup();
  }
});
