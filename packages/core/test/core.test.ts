import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryEventLog, PendingRequests, SessionStream } from '../src/index.js';

const event = (text: string) =>
  ({
    type: 'assistant.delta',
    data: { messageId: 'm1', text },
  }) as const;

test('sequence numbers are per-session, gapless, and monotonic', async () => {
  const log = new MemoryEventLog();
  const a = await log.append('s1', event('a'));
  const b = await log.append('s1', event('b'));
  const c = await log.append('s2', event('c'));

  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(c.seq, 1, 'a different session has its own sequence');
  assert.equal(await log.lastSeq('s1'), 2);
});

test('a reader resumes from a cursor and misses nothing', async () => {
  const log = new MemoryEventLog();
  await log.append('s1', event('a'));
  await log.append('s1', event('b'));
  await log.append('s1', event('c'));

  const gap = await log.read('s1', 1, 100);
  assert.deepEqual(
    gap.map((e) => e.seq),
    [2, 3],
  );
});

test('a cursor beyond the end reads nothing rather than failing', async () => {
  const log = new MemoryEventLog();
  await log.append('s1', event('a'));
  assert.deepEqual(await log.read('s1', 99, 100), []);
});

test('an oversized gap is refused with cursor_expired', async () => {
  const log = new MemoryEventLog();
  const stream = new SessionStream(log, { maxReplay: 3 });
  for (let i = 0; i < 10; i++) await log.append('s1', event(`e${i}`));

  const result = await stream.attach('s1', 0, () => {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'cursor_expired');
});

test('attaching replays the gap and then delivers live events in order', async () => {
  const log = new MemoryEventLog();
  const stream = new SessionStream(log);
  await stream.publish('s1', event('one'));
  await stream.publish('s1', event('two'));

  const seen: string[] = [];
  const attached = await stream.attach('s1', 0, (stored) => {
    seen.push(stored.event.data.text);
  });
  assert.equal(attached.ok, true);

  await stream.publish('s1', event('three'));

  assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('an event published during the replay is delivered exactly once', async () => {
  const log = new MemoryEventLog();
  const stream = new SessionStream(log);
  await stream.publish('s1', event('one'));

  const seen: string[] = [];
  // Publish from inside the first replayed event, so it lands while the
  // subscriber is still buffering.
  await stream.attach('s1', 0, (stored) => {
    seen.push(stored.event.data.text);
    if (stored.event.data.text === 'one') {
      void stream.publish('s1', event('racing'));
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ['one', 'racing']);
  assert.equal(seen.filter((t) => t === 'racing').length, 1);
});

test('a pending request resolves exactly once', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  const answer = pending.request('req_1');

  assert.equal(await pending.settle('req_1', 'allow'), true);
  assert.equal(await pending.settle('req_1', 'allow'), false, 'a replayed verdict is rejected');

  const verdict = await answer;
  assert.equal(verdict.value, 'allow');
  assert.equal(verdict.by, 'phone');
});

test('a verdict for an unknown request is rejected', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  assert.equal(await pending.settle('never-existed', 'allow'), false);
});

test('the request is claimed before the bookkeeping runs, so a second verdict cannot release it', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  const answer = pending.request('req_1');

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = pending.settle('req_1', 'allow', () => gate);
  // The second verdict arrives while the first is still writing its record.
  assert.equal(await pending.settle('req_1', 'deny'), false, 'the request is already claimed');

  release?.();
  assert.equal(await first, true);

  const verdict = await answer;
  assert.equal(verdict.value, 'allow', 'the first verdict is the one that applies');
});

test('the bookkeeping runs before the verdict is delivered', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  const answer = pending.request('req_1');

  const order: string[] = [];
  const settled = pending.settle('req_1', 'allow', async () => {
    order.push('recorded');
  });
  const verdict = await answer;
  order.push('delivered');

  assert.equal(await settled, true);
  assert.deepEqual(order, ['recorded', 'delivered']);
});

test('a failed bookkeeping hook denies the request rather than releasing it', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  const answer = pending.request('req_1');

  await assert.rejects(
    pending.settle('req_1', 'allow', async () => {
      throw new Error('the audit log could not be written');
    }),
  );

  const verdict = await answer;
  assert.equal(verdict.value, 'deny', 'an unrecordable approval must not be delivered');
  assert.equal(verdict.by, 'host');
});

test('a request that ends without an answer tells the caller to drop its state', async () => {
  const ended: string[] = [];
  const pending = new PendingRequests<string>({
    timeoutMs: 10,
    onTimeout: () => 'deny',
    onEnded: (id) => ended.push(id),
  });

  const answer = pending.request('req_1');
  await answer;
  assert.deepEqual(ended, ['req_1']);
});

test('an unanswered request times out as a denial', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10, onTimeout: () => 'deny' });
  const verdict = await pending.request('req_1');
  assert.equal(verdict.value, 'deny');
  assert.equal(verdict.by, 'timeout');
});

test('a verdict arriving after the timeout is rejected, not applied late', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10, onTimeout: () => 'deny' });
  const answer = pending.request('req_1');

  await answer;
  assert.equal(await pending.settle('req_1', 'allow'), false, 'a late allow must not apply');
});

test('a disconnect fails every pending request closed', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 60_000, onTimeout: () => 'deny' });
  const first = pending.request('req_1');
  const second = pending.request('req_2');

  const failed = pending.failAll('deny');
  assert.equal(failed, 2);

  assert.deepEqual(await first, { value: 'deny', by: 'host' });
  assert.deepEqual(await second, { value: 'deny', by: 'host' });
  assert.equal(pending.size, 0);
});

test('a duplicate request id is refused rather than orphaning a promise', async () => {
  const pending = new PendingRequests<string>({ timeoutMs: 10_000, onTimeout: () => 'deny' });
  void pending.request('req_1');
  assert.throws(() => pending.request('req_1'), /duplicate/);
});
