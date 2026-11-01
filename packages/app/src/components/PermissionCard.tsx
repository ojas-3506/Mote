import type { PendingPermission } from '../lib/session-model';
import { safeJson } from '../lib/format';

/**
 * A permission request, shown but **not answerable**.
 *
 * The approval sheet is the next piece of work, and it has rules that are
 * easy to get subtly wrong: `defaultToNo` is per request rather than a
 * setting, the approve action is never a single tap, a double tap, or a
 * swipe, and a notification must never be able to approve.
 *
 * Until those are implemented there is deliberately **no approve button
 * here at all**. An approval the phone can grant by accident is the exact
 * failure this project exists to prevent, and a half-built approve button is
 * worse than none — it looks like permission and grants it.
 *
 * So the request is shown in full, and it times out. A timeout is a denial,
 * which is the safe direction.
 */
export function PermissionCard({ pending }: { pending: PendingPermission }) {
  return (
    <div className="permission" role="alert">
      <div className="permission-head">
        <span className="permission-title">{pending.title}</span>
        {pending.agentID && <span className="badge warn">sub-agent</span>}
      </div>

      {pending.description && <p className="muted small">{pending.description}</p>}

      <dl className="permission-facts">
        {pending.blockedPath && (
          <>
            <dt>path</dt>
            <dd>{pending.blockedPath}</dd>
          </>
        )}
        {pending.decisionReason && (
          <>
            <dt>reason</dt>
            <dd>{pending.decisionReason}</dd>
          </>
        )}
        {pending.mcpServer && (
          <>
            <dt>server</dt>
            <dd>
              {pending.mcpServer.name} ({pending.mcpServer.source})
            </dd>
          </>
        )}
      </dl>

      <p className="muted small">Input</p>
      <pre className="input">{safeJson(pending.input)}</pre>

      <p className="notice">
        The approval sheet is not built yet, so this request cannot be
        answered from the phone. It will time out and be <strong>denied</strong>.
      </p>
    </div>
  );
}
