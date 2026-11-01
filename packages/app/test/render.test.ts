import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Connect } from '../src/components/Connect.js';
import { SessionPicker } from '../src/components/SessionPicker.js';
import { SessionView } from '../src/components/SessionView.js';
import { Chat } from '../src/components/Chat.js';
import { Message } from '../src/components/Message.js';
import { ToolCallRow } from '../src/components/ToolCall.js';
import { GitStatusStrip } from '../src/components/GitStatus.js';
import { PermissionCard } from '../src/components/PermissionCard.js';
import { emptyModel, reduce, type SessionModel } from '../src/lib/session-model.js';
import type { EvtFrame } from '@mote/protocol';

/**
 * The components render.
 *
 * A smoke test, and that is all it is meant to be — but a UI that throws on
 * mount is a UI nobody notices until they open the app, and this catches it
 * in the test run instead.
 *
 * `renderToStaticMarkup` never runs effects, so nothing here touches the
 * network or the WebSocket. The client's behaviour is covered in
 * `client.test.ts`.
 */

const windowStub = {
  location: { protocol: 'http:', host: '127.0.0.1:8787', pathname: '/', search: '', hash: '' },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  history: { replaceState: () => {} },
  setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};
(globalThis as unknown as { window: unknown }).window = windowStub;

test('the connect screen asks for a token', () => {
  const html = renderToStaticMarkup(createElement(Connect, { onConnect: () => {} }));

  assert.match(html, /Token/);
  assert.match(html, /Connect/);
  // A password field: the token should not be readable over someone's shoulder.
  assert.match(html, /type="password"/);
});

test('the session picker names the sessions it was offered', () => {
  const html = renderToStaticMarkup(
    createElement(SessionPicker, {
      sessions: {
        hostId: 'host_1',
        hostName: 'my-laptop',
        claudeVersion: '2.1.312',
        sdkVersion: '0.3.312',
        sessions: [
          {
            sessionId: 'sess_repo-abc123',
            label: 'my-repo',
            cwd: '/home/you/projects/my-repo',
            status: 'ready',
            pendingApprovals: 0,
          },
        ],
      },
      onSelect: () => {},
      onRefresh: () => {},
    }),
  );

  assert.match(html, /my-laptop/);
  assert.match(html, /my-repo/);
  assert.match(html, /\/home\/you\/projects\/my-repo/);
  assert.match(html, /ready/);
});

test('the session view shows the session and a composer', () => {
  const html = renderToStaticMarkup(
    createElement(SessionView, {
      session: {
        sessionId: 'sess_repo-abc123',
        label: 'my-repo',
        cwd: '/home/you/projects/my-repo',
        status: 'ready',
        pendingApprovals: 0,
      },
      token: 'test-token',
      onBack: () => {},
    }),
  );

  assert.match(html, /my-repo/);
  assert.match(html, /Send/);
  assert.match(html, /Stop/);
});

test('the session view offers no way to approve a tool call yet', () => {
  // The permission sheet is not built. Until it is, there must be no button
  // anywhere in the app that could grant code execution — an approval the
  // phone can grant by accident is the failure this project exists to
  // prevent.
  const html = renderToStaticMarkup(
    createElement(SessionView, {
      session: {
        sessionId: 'sess_repo-abc123',
        label: 'my-repo',
        cwd: '/home/you/projects/my-repo',
        status: 'ready',
        pendingApprovals: 0,
      },
      token: 'test-token',
      onBack: () => {},
    }),
  );

  assert.doesNotMatch(html, /allow|approve/i);
});

// ── The chat view ──────────────────────────────────────────────────────────

let seq = 0;

function evt(event: Omit<EvtFrame, 'seq'>): EvtFrame {
  seq += 1;
  return { ...event, seq } as EvtFrame;
}

function modelOf(events: EvtFrame[]): SessionModel {
  return events.reduce(reduce, emptyModel());
}

const assistantText = (text: string) =>
  evt({
    v: 1,
    t: 'evt',
    sessionId: 'sess_1',
    ts: 0,
    type: 'assistant.message',
    data: { messageId: 'm1', text },
  });

test('the chat renders the transcript', () => {
  const model = modelOf([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'user.message',
      data: { id: 'u1', text: 'hello there', priority: 'now' },
    }),
    assistantText('hi back'),
  ]);

  const html = renderToStaticMarkup(createElement(Chat, { model }));

  assert.match(html, /hello there/);
  assert.match(html, /hi back/);
  assert.match(html, /class="message user"/);
  assert.match(html, /class="message assistant"/);
});

test('a tool call renders as a collapsed row', () => {
  const model = modelOf([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.call',
      data: { toolUseId: 'tu_1', name: 'Bash', displayName: 'Bash', input: { command: 'ls -la' } },
    }),
  ]);

  const html = renderToStaticMarkup(createElement(Chat, { model }));

  assert.match(html, /Bash/);
  assert.match(html, /ls -la/);
  // Collapsed: the body is not in the markup until it is opened.
  assert.doesNotMatch(html, /class="tool-body"/);
});

test('the tool input is rendered as text, never as markup', () => {
  const model = modelOf([
    evt({
      v: 1,
      t: 'evt',
      sessionId: 'sess_1',
      ts: 0,
      type: 'tool.call',
      data: {
        toolUseId: 'tu_1',
        name: 'Bash',
        displayName: 'Bash',
        input: { command: '<img src=x onerror="alert(1)">' },
      },
    }),
  ]);

  const tool = model.tools.get('tu_1');
  assert.ok(tool);
  const html = renderToStaticMarkup(createElement(ToolCallRow, { tool }));

  assert.doesNotMatch(html, /<img/, 'the input must not become markup');
  assert.match(html, /&lt;img/, 'it must appear as text');
});

test('the git strip names the branch', () => {
  const html = renderToStaticMarkup(
    createElement(GitStatusStrip, {
      git: { branch: 'main', ahead: 1, behind: 0, changes: [{ path: 'a.ts', status: 'modified' }] },
    }),
  );

  assert.match(html, /main/);
  assert.match(html, /↑1/);
});

test('the git strip renders nothing without a status', () => {
  const html = renderToStaticMarkup(createElement(GitStatusStrip, { git: undefined }));
  assert.equal(html, '');
});

test('a thinking block is collapsed', () => {
  const html = renderToStaticMarkup(
    createElement(Message, {
      turn: {
        id: 'm1',
        kind: 'thinking',
        text: 'considering the options',
        preview: 'considering the options',
        streaming: false,
        seq: 1,
      },
    }),
  );

  assert.match(html, /<details>/);
  assert.match(html, /Thinking/);
});

test('the permission card shows the request and offers no way to approve it', () => {
  const model = modelOf([
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
        title: 'Claude wants to run `rm -rf build`',
        description: 'Claude wants to run a command',
        input: { command: 'rm -rf build' },
        defaultToNo: true,
        suggestions: [],
      },
    }),
  ]);

  const pending = model.pending;
  assert.ok(pending);
  const html = renderToStaticMarkup(createElement(PermissionCard, { pending }));

  assert.match(html, /rm -rf build/);
  assert.match(html, /defaultToNo|denied/i);
  // The point of the card: no approve button anywhere.
  assert.doesNotMatch(html, /<button/i);
});
