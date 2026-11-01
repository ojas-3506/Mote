#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonlEventLog, SessionStream, createLogger } from '@ccr/core';
import { AuditLog } from './audit.js';
import { USAGE, defaultConfig, parseArgs, type HostConfig } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { HostServer, defaultAppDir } from './server.js';
import { SessionManager } from './session-manager.js';
import { readHostVersions } from './versions.js';

/**
 * `ccrd` — the host daemon.
 *
 * Owns one or more Claude Code sessions on the user's machine and serves them
 * to a phone over the local network.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.version) {
    const versions = readHostVersions();
    process.stdout.write(`ccrd (sdk ${versions.sdkVersion}, claude ${versions.claudeVersion})\n`);
    return;
  }

  const config: HostConfig = { ...defaultConfig(), ...parsed.config };

  // With no workspace given, expose the directory the daemon was started in.
  if (config.workspaces.length === 0) {
    config.workspaces = [{ path: resolve(process.cwd()) }];
  }

  // A transcript belongs to one workspace. Resuming it while exposing
  // several would attach the same conversation to the wrong directory.
  if (config.resume && config.workspaces.length > 1) {
    throw new Error('--resume applies to a single workspace; expose one with --cwd');
  }

  const logger = createLogger({ level: config.logLevel, name: 'ccrd' });
  const versions = readHostVersions();

  const identity = await loadOrCreateIdentity(config.dataDir);
  if (config.token) identity.token = config.token;

  const log = new JsonlEventLog(join(config.dataDir, 'sessions'));
  const stream = new SessionStream(log, { maxReplay: config.maxReplay });
  const audit = new AuditLog(join(config.dataDir, 'audit.log'));

  const sessions = new SessionManager({
    workspaces: config.workspaces,
    stream,
    logger,
    audit,
    hostId: identity.hostId,
    claudeVersion: versions.claudeVersion,
    model: config.model,
    permissionMode: config.permissionMode,
    permissionTimeoutMs: config.permissionTimeoutMs,
    resume: config.resume,
  });

  const server = new HostServer({
    sessions,
    stream,
    logger,
    audit,
    hostId: identity.hostId,
    hostName: identity.hostName,
    claudeVersion: versions.claudeVersion,
    sdkVersion: versions.sdkVersion,
    token: identity.token,
    appDir: defaultAppDir(),
    serveApp: config.serveApp,
  });

  const { port } = await server.listen(config.port, config.bind);

  const address = displayAddress(config.bind);
  const base = `http://${address}:${port}`;

  process.stdout.write(`\nccrd listening on ${base}\n`);
  process.stdout.write(`  host      ${identity.hostName} (${identity.hostId})\n`);
  process.stdout.write(`  claude    ${versions.claudeVersion}   sdk ${versions.sdkVersion}\n`);
  for (const summary of sessions.list()) {
    process.stdout.write(`  session   ${summary.sessionId}  ${summary.cwd}\n`);
  }
  process.stdout.write(`\n  open on your phone:  ${base}/#t=${identity.token}\n`);
  process.stdout.write('  (the token is in the URL fragment, so it never reaches the network)\n\n');

  logger.info('host listening', { port, sessions: sessions.list().length });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      // Closing the sessions fails every outstanding approval closed — a
      // request must never be silently satisfied by a disconnect.
      await sessions.closeAll();
      await server.close();
      await log.close();
    } catch (error) {
      logger.error('shutdown failed', { error: String(error) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * The address to print for the user to open on their phone.
 *
 * When the daemon is bound to the loopback interface, the LAN address would
 * be a lie — the phone couldn't reach it. Say what's actually true.
 */
function displayAddress(bind: string): string {
  if (bind === '127.0.0.1' || bind === 'localhost' || bind === '::1') return '127.0.0.1';
  return lanAddress() ?? bind;
}

/** The first non-internal IPv4 address, for the URL the user opens on a phone. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

main().catch((error) => {
  process.stderr.write(`ccrd failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
