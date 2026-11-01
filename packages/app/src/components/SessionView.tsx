import { useEffect, useRef, useState } from 'react';
import type { EvtFrame, SessionSummary } from '@mote/protocol';
import { SessionClient, type ConnectionState } from '../lib/client';
import { deviceId } from '../lib/auth';

/**
 * A live session.
 *
 * For now this is a **transport proof**: every event the host publishes,
 * in order, with the cursor that a reconnect would resume from, and a
 * composer that sends a prompt and stops a turn. The chat view, the tool
 * rows, and the permission sheet come next — the shape of this screen is
 * deliberately temporary.
 *
 * One thing is *not* temporary: the permission request below. It is shown,
 * but it cannot be answered from here. A half-built approve button is worse
 * than no approve button — see the note on the card.
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
  }, [events]);

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
        <span className={`badge ${state === 'open' ? 'ok' : ''}`}>{state}</span>
      </header>

      {detail && <p className="notice">{detail}</p>}
      {error && <p className="notice error">{error}</p>}

      <div className="events">
        {events.map((event) => (
          <EventRow key={`${event.seq}`} event={event} />
        ))}
        <div ref={bottomRef} />
      </div>

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
    </main>
  );
}

function EventRow({ event }: { event: EvtFrame }) {
  if (event.type === 'permission.request') {
    return <PermissionCard event={event} />;
  }

  return (
    <div className="event">
      <span className="event-type">{event.type}</span>
      <span className="event-body">{preview(event) || '—'}</span>
    </div>
  );
}

/**
 * A permission request, shown but not answerable.
 *
 * The sheet is the next piece of work, and it has rules that are easy to get
 * subtly wrong (`defaultToNo` is per request; there is no one-key approve
 * path). Until those are implemented there is deliberately **no approve
 * button here at all** — an approval the phone can grant by accident is the
 * exact failure this project exists to prevent. The request will time out
 * and be denied, which is the safe direction.
 */
function PermissionCard({ event }: { event: Extract<EvtFrame, { type: 'permission.request' }> }) {
  const { data } = event;
  return (
    <div className="event permission">
      <span className="event-type">permission.request</span>
      <strong>{data.title}</strong>
      {data.description && <p className="muted small">{data.description}</p>}
      {data.blockedPath && (
        <p className="muted small">path: {data.blockedPath}</p>
      )}
      {data.decisionReason && (
        <p className="muted small">reason: {data.decisionReason}</p>
      )}
      {data.agentID && <p className="muted small">agent: {data.agentID}</p>}
      <pre className="input">{JSON.stringify(data.input, null, 2)}</pre>
      <p className="notice">
        The approval sheet is not built yet. This request will time out and be
        denied.
      </p>
    </div>
  );
}

/**
 * A one-line summary of an event, for the transport-proof list.
 *
 * `event.data` is read inside each case rather than hoisted into a variable:
 * the payload type is only known per event type, and the narrowing comes
 * from switching on `event.type`.
 */
function preview(event: EvtFrame): string {
  switch (event.type) {
    case 'user.message':
      return event.data.text;
    case 'assistant.delta':
    case 'assistant.message':
    case 'assistant.thinking':
      return event.data.text;
    case 'tool.call':
      return `${event.data.displayName} — ${summariseInput(event.data.input)}`;
    case 'tool.result':
      return event.data.output;
    case 'session.started':
      return `${event.data.cwd} · ${event.data.model}${event.data.resumed ? ' · resumed' : ''}`;
    case 'session.idle':
      return event.data.reason;
    case 'session.error':
      return event.data.message;
    case 'permission.resolved':
      return `${event.data.behavior} (${event.data.by})`;
    case 'permission.request':
      return event.data.title;
    case 'file.diff':
      return event.data.path;
    case 'git.status':
      return `${event.data.branch} ↑${event.data.ahead} ↓${event.data.behind}`;
    case 'session.resumed':
      return event.data.claudeSessionId;
  }
}

/** The most telling field of a tool input, if there is one. */
function summariseInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }

  const text = JSON.stringify(input);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
