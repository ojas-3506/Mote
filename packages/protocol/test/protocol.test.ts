import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvtFrameSchema,
  FrameSchema,
  PermissionUpdateSchema,
  PROTOCOL_VERSION,
  filterRemotelyGrantable,
  isRemotelySettableMode,
  ok,
  fail,
  parseFrame,
  req,
} from '../src/index.js';

test('a well-formed event frame round-trips', () => {
  const frame = {
    v: PROTOCOL_VERSION,
    t: 'evt',
    seq: 41,
    sessionId: 'sess_1',
    ts: 1_700_000_000_000,
    type: 'assistant.delta',
    data: { messageId: 'msg_1', text: 'hello' },
  };
  const parsed = parseFrame(frame);
  assert.equal(parsed.t, 'evt');
  assert.equal(parsed.type, 'assistant.delta');
  assert.equal(parsed.data.text, 'hello');
});

test('an event frame with the wrong payload shape is rejected', () => {
  const result = EvtFrameSchema.safeParse({
    v: PROTOCOL_VERSION,
    t: 'evt',
    seq: 1,
    sessionId: 'sess_1',
    ts: 0,
    type: 'assistant.delta',
    data: { messageId: 'msg_1' }, // missing `text`
  });
  assert.equal(result.success, false);
});

test('unknown fields are ignored, not fatal', () => {
  const parsed = parseFrame({
    v: PROTOCOL_VERSION,
    t: 'ping',
    ts: 5,
    somethingFromTheFuture: { nested: true },
  });
  assert.equal(parsed.t, 'ping');
});

test('a negative sequence number is rejected', () => {
  const result = EvtFrameSchema.safeParse({
    v: PROTOCOL_VERSION,
    t: 'evt',
    seq: -1,
    sessionId: 'sess_1',
    ts: 0,
    type: 'assistant.delta',
    data: { messageId: 'm', text: 'x' },
  });
  assert.equal(result.success, false);
});

test('tool input accepts arbitrarily nested JSON', () => {
  const parsed = parseFrame({
    v: PROTOCOL_VERSION,
    t: 'evt',
    seq: 1,
    sessionId: 'sess_1',
    ts: 0,
    type: 'tool.call',
    data: {
      toolUseId: 'tu_1',
      name: 'Bash',
      displayName: 'Bash',
      input: { command: 'rm -rf /', nested: { a: [1, 2, { b: null }] } },
    },
  });
  assert.equal(parsed.t, 'evt');
  assert.deepEqual(parsed.data.input.nested, { a: [1, 2, { b: null }] });
});

test('a permission request carries defaultToNo and the SDK suggestions verbatim', () => {
  const parsed = parseFrame({
    v: PROTOCOL_VERSION,
    t: 'evt',
    seq: 7,
    sessionId: 'sess_1',
    ts: 0,
    type: 'permission.request',
    data: {
      requestId: 'req_1',
      toolUseId: 'tu_9',
      toolName: 'Bash',
      displayName: 'Bash',
      title: 'Run `rm -rf build`',
      description: 'Claude wants to run a command',
      input: { command: 'rm -rf build' },
      defaultToNo: true,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    },
  });
  assert.equal(parsed.t, 'evt');
  assert.equal(parsed.data.defaultToNo, true);
  assert.deepEqual(parsed.data.suggestions, [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash' }],
      behavior: 'allow',
      destination: 'session',
    },
  ]);
});

test('control requests are discriminated by kind', () => {
  const parsed = parseFrame(req('id_1', 'prompt.send', { text: 'hi', priority: 'now' }));
  assert.equal(parsed.t, 'req');
  assert.equal(parsed.kind, 'prompt.send');
  assert.equal(parsed.data.text, 'hi');
});

test('a resolve carries the request id it is answering', () => {
  const parsed = parseFrame(
    req('id_2', 'permission.resolve', { requestId: 'req_1', behavior: 'allow' }),
  );
  assert.equal(parsed.t, 'req');
  assert.equal(parsed.data.requestId, 'req_1');
});

test('responses distinguish success from failure', () => {
  assert.equal(ok('id_3').ok, true);
  const failed = fail('id_4', 'no_such_request', 'unknown request');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'no_such_request');
});

test('bypassPermissions is not remotely settable', () => {
  assert.equal(isRemotelySettableMode('bypassPermissions'), false);
  assert.equal(isRemotelySettableMode('default'), true);
  assert.equal(isRemotelySettableMode('plan'), true);
});

test('a frame from an unknown protocol version is rejected', () => {
  const result = FrameSchema.safeParse({ v: 99, t: 'ping', ts: 1 });
  assert.equal(result.success, false);
});

test('every shape of the SDK permission update parses', () => {
  // The SDK's PermissionUpdate is a six-variant union; the wire format has to
  // carry all of them or a real suggestion gets dropped on the floor.
  const variants = [
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'ask', destination: 'userSettings' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'setMode', mode: 'plan', destination: 'session' },
    { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
    { type: 'removeDirectories', directories: ['/tmp'], destination: 'session' },
  ];
  for (const variant of variants) {
    const result = PermissionUpdateSchema.safeParse(variant);
    assert.equal(result.success, true, `failed on ${variant.type}`);
  }
});

test('a suggestion missing its destination is rejected', () => {
  const result = PermissionUpdateSchema.safeParse({
    type: 'addRules',
    rules: [{ toolName: 'Bash' }],
    behavior: 'allow',
  });
  assert.equal(result.success, false);
});

test('only session-scoped, additive suggestions survive remote filtering', () => {
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
    { type: 'setMode', mode: 'plan', destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
  ] as const;

  const kept = filterRemotelyGrantable(suggestions);

  assert.deepEqual(
    kept.map((u) => u.type),
    ['addRules', 'setMode'],
  );
  assert.equal(kept[0]?.destination, 'session');
  assert.equal((kept[1] as { mode: string }).mode, 'plan');
});

test('a suggestion that would grant everything is never offered remotely', () => {
  const kept = filterRemotelyGrantable([
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
  ] as const);
  assert.deepEqual(kept, []);
});
