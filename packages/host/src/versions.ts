import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * The versions of the Claude Code CLI and the Agent SDK this host is running.
 *
 * The host reports both in its `hello` frame so a client can warn when the
 * host is too old for a feature it expects.
 *
 * The SDK bundles its own Claude Code binary, so the SDK's bundled version is
 * the one that actually runs — not whatever `claude` happens to be on PATH.
 */

export interface HostVersions {
  sdkVersion: string;
  claudeVersion: string;
}

export function readHostVersions(): HostVersions {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const manifest = JSON.parse(
      readFileSync(join(dirname(entry), 'package.json'), 'utf8'),
    ) as { version?: string; claudeCodeVersion?: string };
    return {
      sdkVersion: manifest.version ?? 'unknown',
      claudeVersion: manifest.claudeCodeVersion ?? 'unknown',
    };
  } catch {
    return { sdkVersion: 'unknown', claudeVersion: 'unknown' };
  }
}
