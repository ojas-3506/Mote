/**
 * Structured logging.
 *
 * The relay and the host both handle prompt text, file contents, and tool
 * inputs. None of that may reach a log file — see SECURITY.md §7 ("The relay's
 * own logs must never contain prompt content or tool input").
 *
 * Log *shape* freely: ids, counts, sizes, durations, error codes. Log
 * *content* never.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(name: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Prefix identifying the component, e.g. `ccrd` or `relay`. */
  name?: string;
  /** Where lines go. Defaults to stderr. */
  sink?: (line: string) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const name = options.name ?? 'ccr';
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? Date.now;

  const write = (lineLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return;
    sink(
      JSON.stringify({
        ts: now(),
        level: lineLevel,
        name,
        message,
        ...(fields ? { fields } : {}),
      }),
    );
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childName) =>
      createLogger({ ...options, level, name: `${name}:${childName}`, sink, now }),
  };
}

/** A logger that discards everything. Useful in tests. */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => {} });
