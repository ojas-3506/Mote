import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { PermissionMode } from '@ccr/protocol';
import type { LogLevel } from '@ccr/core';

/**
 * Daemon configuration.
 *
 * Precedence, lowest to highest: built-in defaults, the config file in the
 * data directory, environment variables, command-line flags.
 */

/**
 * The permission modes a host may start a session in.
 *
 * `bypassPermissions` is not among them. The host has no legitimate reason to
 * start a session in a mode where the agent can do anything the user can,
 * and it is the mode a remote client must never be able to request either.
 */
export type HostPermissionMode = Exclude<PermissionMode, 'bypassPermissions'>;

export interface WorkspaceConfig {
  /** Absolute path to the directory the agent works in. */
  path: string;
  /** Short name shown in the phone's session list. Defaults to the basename. */
  label?: string;
}

export interface HostConfig {
  /** Port the daemon listens on. */
  port: number;
  /** Bind address. */
  bind: string;
  /** Where the token, event log, and audit log live. */
  dataDir: string;
  /** The workspaces this host exposes, one session each. */
  workspaces: WorkspaceConfig[];
  /** Bearer token required on every connection. */
  token: string;
  /** Model to start sessions with. */
  model?: string;
  /** Permission mode to start sessions in. */
  permissionMode: HostPermissionMode;
  /** How long an unanswered approval waits before it fails closed. */
  permissionTimeoutMs: number;
  /** Maximum events replayed for a cursor. */
  maxReplay: number;
  /** Whether to serve the built PWA from the same port. */
  serveApp: boolean;
  logLevel: LogLevel;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_BIND = '0.0.0.0';
export const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60 * 1000;

export function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'ccr');
  return join(homedir(), '.local', 'share', 'ccr');
}

export function defaultConfig(): HostConfig {
  return {
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    dataDir: defaultDataDir(),
    workspaces: [],
    token: '',
    permissionMode: 'default',
    permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    maxReplay: 10_000,
    serveApp: true,
    logLevel: 'info',
  };
}

/**
 * The name this host presents to the phone.
 *
 * Deliberately the machine's hostname, not something more descriptive: the
 * phone shows it during pairing so the user can confirm they are talking to
 * the machine they think they are.
 */
export function defaultHostName(): string {
  return hostname();
}

export interface ParsedArgs {
  config: Partial<HostConfig>;
  help: boolean;
  version: boolean;
}

const USAGE = `ccrd — the ccr host daemon

Usage:
  ccrd [options]

Options:
  --port <n>              Port to listen on (default ${DEFAULT_PORT})
  --bind <addr>           Bind address (default ${DEFAULT_BIND})
  --cwd <path>            Workspace to expose; repeat for more (default: cwd)
  --data-dir <path>       Where tokens and logs live (default: ${defaultDataDir()})
  --token <token>         Use a fixed bearer token instead of the stored one
  --model <id>            Model to start sessions with
  --permission-mode <m>   default | acceptEdits | plan | dontAsk | auto
  --permission-timeout <minutes>
                           Fail an unanswered approval closed after N minutes
  --log-level <level>     debug | info | warn | error | silent
  --no-serve-app          Don't serve the PWA from this port
  -h, --help              Show this help
  -v, --version           Show the version
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const config: Partial<HostConfig> = {};
  let help = false;
  let version = false;

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '--port': {
        const port = Number(next(i, '--port'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`--port must be a valid port, got "${port}"`);
        }
        config.port = port;
        i++;
        break;
      }
      case '--bind':
        config.bind = next(i, '--bind');
        i++;
        break;
      case '--cwd': {
        const path = resolve(next(i, '--cwd'));
        config.workspaces = [...(config.workspaces ?? []), { path }];
        i++;
        break;
      }
      case '--data-dir':
        config.dataDir = resolve(next(i, '--data-dir'));
        i++;
        break;
      case '--token':
        config.token = next(i, '--token');
        i++;
        break;
      case '--model':
        config.model = next(i, '--model');
        i++;
        break;
      case '--permission-mode': {
        const mode = next(i, '--permission-mode');
        if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'].includes(mode)) {
          throw new Error(
            `--permission-mode must be default, acceptEdits, plan, dontAsk, or auto (got "${mode}")`,
          );
        }
        config.permissionMode = mode as HostPermissionMode;
        i++;
        break;
      }
      case '--permission-timeout': {
        const minutes = Number(next(i, '--permission-timeout'));
        if (!Number.isFinite(minutes) || minutes <= 0) {
          throw new Error('--permission-timeout must be a positive number of minutes');
        }
        config.permissionTimeoutMs = Math.round(minutes * 60_000);
        i++;
        break;
      }
      case '--log-level': {
        const level = next(i, '--log-level');
        if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
          throw new Error(`--log-level must be debug, info, warn, error, or silent (got "${level}")`);
        }
        config.logLevel = level as LogLevel;
        i++;
        break;
      }
      case '--no-serve-app':
        config.serveApp = false;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        // A bare path is treated as a workspace.
        config.workspaces = [...(config.workspaces ?? []), { path: resolve(arg) }];
    }
  }

  return { config, help, version };
}

export { USAGE };
