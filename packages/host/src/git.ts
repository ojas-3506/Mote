import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatusKind } from '@mote/protocol';

const exec = promisify(execFile);

/**
 * The working tree, as the host sees it.
 *
 * The phone is a browser. It cannot read the repository, so the only view of
 * the working tree it will ever have is the one the host publishes. That is
 * why this lives here and not in the app.
 */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  changes: { path: string; status: GitStatusKind }[];
}

/**
 * Read the git status of a workspace.
 *
 * Returns `undefined` when the directory is not a repository, or git is not
 * installed, or the command fails. A workspace does not have to be a git
 * repository, and a missing git is not an error worth failing a session
 * over.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus | undefined> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return parsePorcelain(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Parse `git status --porcelain=v1 --branch`.
 *
 * The porcelain format is a documented, stable interface — unlike the
 * human-readable one, which has changed between versions.
 */
export function parsePorcelain(output: string): GitStatus | undefined {
  const changes: { path: string; status: GitStatusKind }[] = [];
  let branch = '';
  let ahead = 0;
  let behind = 0;

  for (const line of output.split('\n')) {
    if (!line) continue;

    if (line.startsWith('## ')) {
      const header = line.slice(3);
      // A repository with no commits says "## No commits yet on master".
      if (header.startsWith('No commits yet on ')) {
        branch = header.slice('No commits yet on '.length).trim();
        continue;
      }

      // "main...origin/main [ahead 1, behind 2]"
      const bracket = header.indexOf('[');
      const branchPart = (bracket === -1 ? header : header.slice(0, bracket)).trim();
      branch = branchPart.split('...')[0] ?? branchPart;

      if (bracket !== -1) {
        const counts = header.slice(bracket + 1).replace(']', '');
        const aheadMatch = /ahead (\d+)/.exec(counts);
        const behindMatch = /behind (\d+)/.exec(counts);
        if (aheadMatch?.[1]) ahead = Number(aheadMatch[1]);
        if (behindMatch?.[1]) behind = Number(behindMatch[1]);
      }
      continue;
    }

    // "XY path" — X is the index status, Y the working tree's.
    const status = kindOf(line.slice(0, 2));
    if (!status) continue;

    const rest = line.slice(3);
    // A rename is "old -> new"; the new name is the one that exists.
    const path = rest.includes(' -> ') ? (rest.split(' -> ')[1] ?? rest) : rest;
    changes.push({ path, status });
  }

  if (!branch) return undefined;
  return { branch, ahead, behind, changes };
}

/** Map git's two-letter status code onto the protocol's vocabulary. */
function kindOf(status: string): GitStatusKind | undefined {
  const index = status[0] ?? ' ';
  const tree = status[1] ?? ' ';

  // Either half can carry the interesting part: a file can be staged for
  // deletion and then restored in the working tree.
  const code = index !== ' ' && index !== '?' ? index : tree;

  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    case 'U':
      return 'conflicted';
    case '?':
      return 'untracked';
    default:
      return undefined;
  }
}
