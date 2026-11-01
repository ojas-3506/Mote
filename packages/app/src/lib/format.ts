/**
 * Formatting for display.
 *
 * Everything here is about *displaying* text that came from somewhere else —
 * a tool's input, a command's output, a file's contents. That text is
 * untrusted by definition: it came out of a repository the user may not
 * control.
 */

/**
 * The most telling field of a tool input, if there is one.
 *
 * `Bash` wants its command, `Read` wants its path. Falling back to the whole
 * input is fine — it is shown as text either way.
 */
export function summariseInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }

  const text = safeJson(input);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/**
 * `JSON.stringify` on untrusted input.
 *
 * A tool input can contain a BigInt, a circular reference, or a `toJSON`
 * that throws. None of those should take the app down.
 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * How much of a long output to show.
 *
 * A tool result can be megabytes — a build log, a file dump. Rendering all
 * of it on a phone is its own kind of denial of service, so it is capped.
 * The cap is *announced*, never silent: the user is told how much is not on
 * screen.
 */
export const MAX_OUTPUT_CHARS = 20_000;

export interface Truncated {
  text: string;
  elided: number;
}

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): Truncated {
  if (text.length <= limit) return { text, elided: 0 };
  return { text: text.slice(0, limit), elided: text.length - limit };
}
