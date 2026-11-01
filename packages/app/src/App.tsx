import { useCallback, useEffect, useState } from 'react';
import type { SessionList, SessionSummary } from '@mote/protocol';
import { clearToken, loadToken, saveToken, takeTokenFromFragment } from './lib/auth';
import { fetchSessions } from './lib/client';
import { Connect } from './components/Connect';
import { SessionPicker } from './components/SessionPicker';
import { SessionView } from './components/SessionView';

/**
 * The app's three screens.
 *
 *   no token  →  ask for one
 *   token     →  the host's sessions
 *   session   →  the live stream
 */
export function App() {
  const [token, setToken] = useState<string | undefined>(loadToken);
  const [sessions, setSessions] = useState<SessionList | undefined>();
  const [active, setActive] = useState<SessionSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // Take the token out of the URL fragment once, on mount. Doing it in an
  // effect rather than in a state initialiser keeps it idempotent — React
  // runs initialisers twice in development, and the second run would find
  // the fragment already gone.
  useEffect(() => {
    const fromFragment = takeTokenFromFragment();
    if (fromFragment) {
      saveToken(fromFragment);
      setToken(fromFragment);
    }
  }, []);

  const refresh = useCallback(async (current: string) => {
    setLoading(true);
    setError(undefined);
    try {
      setSessions(await fetchSessions(current));
    } catch (cause) {
      setSessions(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && !active) void refresh(token);
  }, [token, active, refresh]);

  if (!token) {
    return (
      <Connect
        onConnect={(next) => {
          saveToken(next);
          setToken(next);
        }}
      />
    );
  }

  if (active) {
    return <SessionView session={active} token={token} onBack={() => setActive(undefined)} />;
  }

  if (error) {
    return (
      <main className="screen">
        <div className="card">
          <h1>Not connected</h1>
          <p className="notice error">{error}</p>
          <button type="button" onClick={() => void refresh(token)}>
            Try again
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              clearToken();
              setToken(undefined);
              setSessions(undefined);
              setError(undefined);
            }}
          >
            Forget the token
          </button>
        </div>
      </main>
    );
  }

  if (loading || !sessions) {
    return (
      <main className="screen">
        <p className="card muted">Asking the host for its sessions…</p>
      </main>
    );
  }

  return (
    <SessionPicker
      sessions={sessions}
      onSelect={setActive}
      onRefresh={() => void refresh(token)}
    />
  );
}
