import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Logger, SessionStream } from '@ccr/core';
import type { AuditLog } from './audit.js';
import { Session } from './session.js';
import type { WorkspaceConfig } from './config.js';

/**
 * The set of sessions this host exposes.
 *
 * One session per configured workspace. The session id is derived from the
 * workspace path so it survives a restart — a phone that bookmarked a session
 * reconnects to the same one.
 */

export interface SessionSummary {
  sessionId: string;
  label: string;
  cwd: string;
  status: 'starting' | 'ready' | 'closed';
  pendingApprovals: number;
}

export interface SessionManagerOptions {
  workspaces: WorkspaceConfig[];
  stream: SessionStream;
  logger: Logger;
  audit: AuditLog;
  hostId: string;
  claudeVersion: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';
  permissionTimeoutMs?: number;
}

/**
 * Build a stable, filesystem-safe session id from a workspace path.
 *
 * The slug is human-readable in a URL; the hash suffix keeps two directories
 * with the same basename from colliding.
 */
export function sessionIdForPath(path: string): string {
  const slug = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 6);
  return `sess_${slug || 'workspace'}-${digest}`;
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  #options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    for (const workspace of options.workspaces) {
      const id = sessionIdForPath(workspace.path);
      const session = new Session({
        id,
        cwd: workspace.path,
        label: workspace.label ?? basename(workspace.path),
        hostId: options.hostId,
        claudeVersion: options.claudeVersion,
        stream: options.stream,
        logger: options.logger,
        audit: options.audit,
        model: options.model,
        permissionMode: options.permissionMode,
        permissionTimeoutMs: options.permissionTimeoutMs,
      });
      this.#sessions.set(id, session);
    }
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.id,
      label: session.label,
      cwd: session.cwd,
      status: session.closed ? 'closed' : session.started ? 'ready' : 'starting',
      pendingApprovals: session.pendingApprovals,
    }));
  }

  /** Start the Claude Code process for a session if it isn't already running. */
  async ensureStarted(id: string): Promise<Session | undefined> {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    await session.ensureStarted();
    return session;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
  }
}
