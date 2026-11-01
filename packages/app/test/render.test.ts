import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Connect } from '../src/components/Connect.js';
import { SessionPicker } from '../src/components/SessionPicker.js';
import { SessionView } from '../src/components/SessionView.js';

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
