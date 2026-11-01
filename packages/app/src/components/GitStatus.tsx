import type { GitStatus } from '../lib/session-model';

/**
 * The branch and the working tree.
 *
 * The phone cannot read the repository — it is a browser, and the repo is on
 * the host. The host publishes this instead, and it is the only view of the
 * working tree the phone will ever have.
 */
export function GitStatusStrip({ git }: { git?: GitStatus }) {
  if (!git) return null;

  return (
    <div className="git">
      <span className="git-branch">{git.branch}</span>
      {git.ahead > 0 && <span className="git-count">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="git-count">↓{git.behind}</span>}
      {git.changes.length > 0 && (
        <span className="git-count">
          {git.changes.length} changed
        </span>
      )}
    </div>
  );
}
