import type { SessionList, SessionSummary } from '@mote/protocol';

/**
 * The sessions this host offers.
 *
 * One per workspace. The list is the only thing the phone needs to know
 * about the host before it can attach to one.
 */
export function SessionPicker({
  sessions,
  onSelect,
  onRefresh,
}: {
  sessions: SessionList;
  onSelect: (session: SessionSummary) => void;
  onRefresh: () => void;
}) {
  return (
    <main className="screen">
      <header className="header">
        <div>
          <h1>{sessions.hostName}</h1>
          <p className="muted small">
            claude {sessions.claudeVersion} · sdk {sessions.sdkVersion}
          </p>
        </div>
        <button type="button" className="ghost" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {sessions.sessions.length === 0 ? (
        <p className="card muted">This host has no workspaces configured.</p>
      ) : (
        <ul className="list">
          {sessions.sessions.map((session) => (
            <li key={session.sessionId}>
              <button type="button" className="row" onClick={() => onSelect(session)}>
                <span className="row-main">
                  <span className="row-title">{session.label}</span>
                  <span className="row-sub">{session.cwd}</span>
                </span>
                <span className="badge">{session.status}</span>
                {session.pendingApprovals > 0 && (
                  <span className="badge warn">
                    {session.pendingApprovals} waiting
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
