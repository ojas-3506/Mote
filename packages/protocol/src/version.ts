/**
 * Protocol version and wire paths.
 *
 * The protocol version is independent of the Claude Code CLI version and the
 * Agent SDK version. The host reports both in its `hello` frame so a client can
 * warn when the host is too old for a feature it expects.
 */

/** Current protocol version. Bump on breaking changes only. */
export const PROTOCOL_VERSION = 1;

/**
 * URL prefix for every endpoint. The version lives in the path so a relay can
 * serve the previous major version for at least one release.
 */
export const PROTOCOL_PREFIX = '/mote/v1';

/** Path a client connects to for one session's event stream. */
export const SESSION_PATH = (sessionId: string): string =>
  `${PROTOCOL_PREFIX}/session/${encodeURIComponent(sessionId)}`;

/** Path the host connects to for its outbound relay link. */
export const HOST_PATH = `${PROTOCOL_PREFIX}/host`;

/** Path a phone posts a pairing code to. */
export const PAIR_PATH = `${PROTOCOL_PREFIX}/pair`;

/** Path a phone posts its push subscription to. */
export const PUSH_SUBSCRIBE_PATH = `${PROTOCOL_PREFIX}/push/subscribe`;

/** Query parameter carrying the cursor a client wants to resume from. */
export const CURSOR_PARAM = 'after';

/**
 * Maximum events a relay will replay for a single cursor. Beyond this the
 * client is told `cursor_expired` and re-fetches full history.
 */
export const DEFAULT_MAX_REPLAY = 10_000;
