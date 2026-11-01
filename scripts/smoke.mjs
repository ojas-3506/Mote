/**
 * End-to-end smoke test.
 *
 * Starts `ccrd` on the loopback interface, connects a client, sends a prompt,
 * and prints every event that comes back. It runs a real Claude Code session,
 * so it needs working credentials and it costs a token or two.
 *
 *   node scripts/smoke.mjs
 *
 * It binds to 127.0.0.1 deliberately. Exposing a Claude Code control surface
 * on the LAN is the daemon's job, not a test script's.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.CCR_SMOKE_PORT ?? 8899);
const TOKEN = process.env.CCR_SMOKE_TOKEN ?? 'smoke-token';
const PROMPT = process.env.CCR_SMOKE_PROMPT ?? 'Reply with exactly: ccr-smoke-ok';
const TIMEOUT_MS = Number(process.env.CCR_SMOKE_TIMEOUT ?? 60_000);

const repoRoot = new URL('..', import.meta.url).pathname;
const workspace = join(mkdtempSync(join(tmpdir(), 'ccr-smoke-ws-')), 'repo');
mkdirSync(workspace, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'ccr-smoke-data-'));

const daemon = spawn(
  'npx',
  [
    'tsx',
    'packages/host/src/daemon.ts',
    '--port', String(PORT),
    '--bind', '127.0.0.1',
    '--data-dir', dataDir,
    '--cwd', workspace,
  ],
  // The token goes through the environment, not `--token`: a token on the
  // command line is visible to every local user with `ps`.
  { cwd: repoRoot, env: { ...process.env, CCR_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] },
);

let sessionId = null;
let finished = false;

const stop = (code) => {
  if (finished) return;
  finished = true;
  daemon.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
};

daemon.stdout.on('data', (buf) => {
  const text = buf.toString();
  for (const line of text.split('\n')) if (line.trim()) console.log(`[daemon] ${line}`);
  const match = text.match(/session\s+(sess_\S+)/);
  if (match && !sessionId) {
    sessionId = match[1];
    connect();
  }
});

daemon.stderr.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) if (line.trim()) console.log(`[daemon] ${line}`);
});

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ccr/v1/session/${sessionId}?after=0`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  ws.on('open', () => {
    console.log('[smoke] connected');
    ws.send(
      JSON.stringify({ v: 1, t: 'hello', role: 'client', deviceId: 'smoke-device', deviceName: 'smoke' }),
    );
    setTimeout(() => {
      console.log(`[smoke] prompt: ${PROMPT}`);
      ws.send(
        JSON.stringify({
          v: 1,
          t: 'req',
          id: 'req_1',
          kind: 'prompt.send',
          data: { text: PROMPT },
        }),
      );
    }, 1_500);
  });

  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.t === 'evt') {
      const data = frame.data ?? {};
      const preview = data.text ?? data.title ?? data.reason ?? JSON.stringify(data);
      console.log(`[evt ${String(frame.seq).padStart(3)}] ${frame.type} ${String(preview).slice(0, 160)}`);
      if (frame.type === 'session.idle') stop(0);
    } else if (frame.t === 'res') {
      console.log(`[res] id=${frame.id} ok=${frame.ok}${frame.ok ? '' : ` ${JSON.stringify(frame.error)}`}`);
    } else if (frame.t === 'hello') {
      console.log(`[hello] ${frame.role} ${frame.hostName} claude=${frame.claudeVersion}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[smoke] ws error', err.message);
    stop(1);
  });
}

setTimeout(() => {
  console.error('[smoke] timed out');
  stop(1);
}, TIMEOUT_MS);
