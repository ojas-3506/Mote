import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultHostName } from './config.js';

/**
 * The host's identity and its bearer token.
 *
 * The token is what stands between "someone on the café wifi" and "someone
 * can run code on this machine". It is generated once, stored on disk with
 * owner-only permissions, and never written to a log.
 */

export interface HostIdentity {
  /** Stable id for this host, used in event payloads and the relay registry. */
  hostId: string;
  /** Name shown to the user during pairing. */
  hostName: string;
  /** Bearer token required on every connection. */
  token: string;
  createdAt: string;
}

const IDENTITY_FILE = 'host.json';

export function generateToken(): string {
  // 32 bytes of entropy, URL-safe so it survives a copy-paste and a URL
  // fragment without escaping.
  return randomBytes(32).toString('base64url');
}

/**
 * Load the host identity, creating it on first run.
 *
 * The token is written once and never rotated automatically: rotating it
 * would silently disconnect a paired phone, and the user has no reason to
 * expect that. Rotation is an explicit operation.
 */
export async function loadOrCreateIdentity(
  dataDir: string,
  hostName?: string,
): Promise<HostIdentity> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, IDENTITY_FILE);

  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HostIdentity>;
    if (parsed.hostId && parsed.token) {
      return {
        hostId: parsed.hostId,
        hostName: parsed.hostName ?? hostName ?? defaultHostName(),
        token: parsed.token,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    // A corrupt identity file is a hard stop. Silently regenerating would
    // invalidate every paired device without telling anyone.
    if (code === 'ENOENT') {
      // fall through to creation
    }
  }

  const identity: HostIdentity = {
    hostId: randomUUID(),
    hostName: hostName ?? defaultHostName(),
    token: generateToken(),
    createdAt: new Date().toISOString(),
  };

  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(path, 0o600);

  return identity;
}

/**
 * Write the token to a file the user can read, for pairing.
 *
 * The daemon prints a URL containing the token in its *fragment*, which
 * browsers never send to the server — so the token doesn't end up in relay
 * logs, proxies, or the phone's request history.
 */
export async function writePairingFile(dataDir: string, url: string): Promise<string> {
  const path = join(dataDir, 'pairing.txt');
  await writeFile(path, `${url}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}
