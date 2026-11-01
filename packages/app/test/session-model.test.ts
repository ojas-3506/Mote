import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvtFrame } from '@mote/protocol';
import { emptyModel, reduce, transcript, turnText } from '../src/lib/session-model.js';

/**
 * The fold.
 *
 * This is where the phone decides what a session *looks like*, and the
 * details matter more than they look:
 *
 * - The host sends the same text twice — once as deltas, once as a finished
 *   message. Getting that wrong prints every reply twice.
 * - A reconnect replays a gap of events. The fold has to produce the same
 *   screen from the replayed events as it would have produced live, or the
 *   session visibly changes shape under the user's thumb.
 */

let seq = 0;

function evt(event: Omit<EvtFrame, 'seq'> & { seq?: number }): EvtFrame {
  seq += 1;
  return { ...event, seq: event.seq ?? seq } as EvtFrame;
}

function fold(events: EvtFrame[]) {
  return events.reduce(reduce, emptyModel());
}

const userMessage = (text: string) =>
  evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'user.message',
    data: { id: `u_${text}`, text, priority: 'now' },
  });

const delta = (messageId: string, text: string) =>
  evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'assistant.delta',
    data: { messageId, text },
  });

const assistantMessage = (messageId: string, text: string) =>
  evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'assistant.message',
    data: { messageId, text },
  });

const idle = () =>
  evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'session.idle',
    data: { reason: 'turn_complete' },
  });

test('a user message becomes a turn', () => {
  const model = fold([userMessage('hello')]);
  const turn = model.turns.get('u_hello');

  assert.ok(turn);
  assert.equal(turn.kind, 'user');
  assert.equal(turn.text, 'hello');
  assert.equal(model.working, true, 'a turn is in flight');
});

test('streamed text is a preview until the turn ends', () => {
  const model = fold([delta('m1', 'Hel'), delta('m1', 'lo')]);

  const turn = model.turns.get('m1');
  assert.ok(turn);
  assert.equal(turn.streaming, true);
  assert.equal(turnText(turn), 'Hello', 'the preview is what you see while it streams');
});

test('the finished message replaces the preview rather than adding to it', () => {
  // The host sends the text twice — deltas, then the whole thing. A fold
  // that appended would print "HelloHello".
  const model = fold([delta('m1', 'Hello'), assistantMessage('m1', 'Hello'), idle()]);

  const turn = model.turns.get('m1');
  assert.ok(turn);
  assert.equal(turn.text, 'Hello');
  assert.equal(turnText(turn), 'Hello');
});

test('a second text block of the same message appends', () => {
  // One assistant message can carry several text blocks, and each arrives
  // as its own event. The first is the text; the rest are more of it.
  const model = fold([
    delta('m1', 'Let me look.'),
    assistantMessage('m1', 'Let me look.'),
    assistantMessage('m1', 'Found it.'),
    idle(),
  ]);

  const turn = model.turns.get('m1');
  assert.ok(turn);
  assert.equal(turn.text, 'Let me look.\n\nFound it.');
});

test('a turn stops streaming when the turn ends', () => {
  const model = fold([delta('m1', 'Hello'), assistantMessage('m1', 'Hello'), idle()]);

  const turn = model.turns.get('m1');
  assert.ok(turn);
  assert.equal(turn.streaming, false);
  assert.equal(model.working, false);
});

test('a tool call and its result pair up', () => {
  const model = fold([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.call',
      data: { toolUseId: 'tu_1', name: 'Bash', displayName: 'Bash', input: { command: 'ls' } },
    }),
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.result',
      data: { toolUseId: 'tu_1', ok: true, output: 'a.txt' },
    }),
  ]);

  const tool = model.tools.get('tu_1');
  assert.ok(tool);
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.output, 'a.txt');
  assert.equal(tool.ok, true);
});

test('a tool call sits directly under the message that asked for it', () => {
  const model = fold([
    assistantMessage('m1', 'Let me look.'),
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.call',
      data: { toolUseId: 'tu_1', name: 'Read', displayName: 'Read', input: { file_path: '/a' } },
    }),
    assistantMessage('m2', 'Found it.'),
  ]);

  const order = transcript(model).map((item) => ('toolUseId' in item ? item.toolUseId : item.id));
  assert.deepEqual(order, ['m1', 'tu_1', 'm2']);
});

test('a result for a call we never saw is ignored, not invented', () => {
  const model = fold([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.result',
      data: { toolUseId: 'tu_unseen', ok: true, output: 'x' },
    }),
  ]);

  assert.equal(model.tools.size, 0);
});

test('a permission request is pending until it is resolved', () => {
  const request = evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'permission.request',
    data: {
      requestId: 'req_1',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      displayName: 'Bash',
      title: 'Claude wants to run `ls`',
      description: '',
      input: { command: 'ls' },
      defaultToNo: true,
      suggestions: [],
    },
  });

  const pending = fold([request]);
  assert.equal(pending.pending?.requestId, 'req_1');
  assert.equal(pending.pending?.defaultToNo, true);

  const resolved = fold([
    request,
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'permission.resolved',
      data: { requestId: 'req_1', behavior: 'deny', by: 'phone' },
    }),
  ]);
  assert.equal(resolved.pending, undefined);
});

test('a resolution for a different request leaves the pending one alone', () => {
  const model = fold([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'permission.request',
      data: {
        requestId: 'req_1',
        toolUseId: 'tu_1',
        toolName: 'Bash',
        displayName: 'Bash',
        title: 'x',
        description: '',
        input: {},
        defaultToNo: true,
        suggestions: [],
      },
    }),
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'permission.resolved',
      data: { requestId: 'req_other', behavior: 'deny', by: 'phone' },
    }),
  ]);

  assert.equal(model.pending?.requestId, 'req_1');
});

test('the fold is deterministic, so a replayed gap reproduces the screen', () => {
  const events = [
    userMessage('hello'),
    delta('m1', 'Hi'),
    assistantMessage('m1', 'Hi'),
    idle(),
  ];

  const live = fold(events);
  const replayed = fold(events);

  assert.deepEqual(
    transcript(replayed).map((item) => ('toolUseId' in item ? item.toolUseId : item.id)),
    transcript(live).map((item) => ('toolUseId' in item ? item.toolUseId : item.id)),
  );
  assert.equal(replayed.lastSeq, live.lastSeq);
});

test('git status is carried through', () => {
  const model = fold([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'git.status',
      data: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        changes: [{ path: 'src/a.ts', status: 'modified' }],
      },
    }),
  ]);

  assert.equal(model.git?.branch, 'main');
  assert.equal(model.git?.changes.length, 1);
});

test('an unknown event type does not break the fold', () => {
  // The protocol says clients ignore what they don't understand.
  const model = fold([
    {
      v: 1,
      t: 'evt',
      seq: 99,
      sessionId: 'sess_1',
      ts: 0,
      type: 'from.the.future',
      data: {},
    } as unknown as EvtFrame,
  ]);

  assert.equal(model.turns.size, 0);
});
