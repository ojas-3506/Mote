import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvtFrame, SessionSummary } from '@mote/protocol';
import { SessionClient, type ConnectionState } from '../lib/client';
import { deviceId } from '../lib/auth';
import { emptyModel, reduce } from '../lib/session-model';
import { Chat } from './Chat';
import { GitStatusStrip } from './GitStatus';
import { PermissionCard } from './PermissionCard';

/**
 * A live session.
 *
 * The events arrive as an append-only, ordered stream; the session model
 * folds them into the transcript; this screen draws the model. The split
 * matters: the fold is testable without a browser, and a reconnect that
 * replays a gap produces the same screen rather than a different one.
 */
export function SessionView({
  session,
  token,
  onBack,
}: {
  session: SessionSummary;
  token: string;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<EvtFrame[]>([]);
  const [state, setState] = useState<ConnectionState>('idle');
  const [detail, setDetail] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const clientRef = useRef<SessionClient | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const model = useMemo(() => events.reduce(reduce, emptyModel()), [events]);

  useEffect(() => {
    const client = new SessionClient({
      sessionId: session.sessionId,
      token,
      deviceId: deviceId(),
      deviceName: 'Mote web',
      onEvent: (event) => setEvents((previous) => [...previous, event]),
      onState: (next, info) => {
        setState(next);
        setDetail(info);
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [session.sessionId, token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [model]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;

    setDraft('');
    setError(undefined);
    try {
      await clientRef.current?.request('prompt.send', { text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const stop = async () => {
    setError(undefined);
    try {
      await clientRef.current?.request('session.interrupt', {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="screen session">
      <header className="header">
        <button type="button" className="ghost" onClick={onBack}>
          ‹
        </button>
        <div className="grow">
          <h1>{session.label}</h1>
          <p className="muted small">{session.cwd}</p>
        </div>
        <GitStatusStrip git={model.git} />
        <span className={`badge ${state === 'open' ? 'ok' : ''}`}>{state}</span>
      </header>

      {detail && <p className="notice">{detail}</p>}
      {error && <p className="notice error">{error}</p>}
      {model.error && <p className="notice error">{model.error}</p>}

      {model.pending && <PermissionCard pending={model.pending} />}

      <Chat model={model} />

      {model.working && (
        <p className="working">
          <span className="dot" aria-hidden="true" />
          Working…
        </p>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a message"
          aria-label="Message"
          autoCapitalize="sentences"
        />
        <button type="button" className="ghost" onClick={() => void stop()}>
          Stop
        </button>
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
      <div ref={bottomRef} />
    </main>
  );
}
