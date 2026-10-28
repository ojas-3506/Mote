import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The audit log.
 *
 * Every approval, denial, prompt, and model switch is recorded here, on the
 * user's own machine. The log proves *what was approved* without becoming a
 * second copy of the sensitive data: it stores a hash of the tool input, not
 * the input.
 *
 * It is append-only and exportable in a form a human can read. "Trust but
 * verify" is the point.
 */

export type AuditDecision = 'allow' | 'deny';

export interface AuditEntry {
  /** Epoch milliseconds. */
  ts: number;
  sessionId: string;
  /** Who acted — the device id, or `host` for a local decision. */
  actor: string;
  /** What kind of action this was. */
  kind:
    | 'permission.resolve'
    | 'prompt.send'
    | 'session.interrupt'
    | 'session.model'
    | 'session.permission_mode'
    | 'session.close';
  toolName?: string;
  toolUseId?: string;
  decision?: AuditDecision;
  /** Whether the grant persisted for the session rather than applying once. */
  always?: boolean;
  /** SHA-256 of the tool input. Proves what was approved without storing it. */
  inputHash?: string;
}

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
}

export class AuditLog {
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async append(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async read(): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip a torn line rather than refusing to read the log.
        continue;
      }
    }
    return entries;
  }

  /** A human-readable export. Safe to share: it holds hashes, not inputs. */
  async export(): Promise<string> {
    const entries = await this.read();
    const header = [
      '# ccr audit log',
      `# exported ${new Date().toISOString()}`,
      '# tool inputs are recorded as SHA-256 hashes; the full input is in the session transcript',
      '',
    ].join('\n');
    const rows = entries.map((entry) => {
      const parts = [
        new Date(entry.ts).toISOString(),
        entry.sessionId,
        entry.actor,
        entry.kind,
        entry.toolName ?? '',
        entry.decision ?? '',
        entry.always === undefined ? '' : String(entry.always),
        entry.inputHash ?? '',
      ];
      return parts.join('\t');
    });
    return `${header}${rows.join('\n')}\n`;
  }
}
