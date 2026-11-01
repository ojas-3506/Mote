import { z } from 'zod';

/**
 * Error codes carried by `res { ok: false }` frames.
 *
 * These are the only strings a peer may use to branch on failure. They are
 * part of the wire contract: adding one is an additive change, renaming one is
 * a breaking change.
 */
export const ERROR_CODES = [
  /** Bad or revoked token. */
  'unauthorized',
  /** Protocol version mismatch. */
  'unsupported_version',
  /** Session doesn't exist or isn't visible to this client. */
  'no_such_session',
  /** Permission request unknown, expired, or already resolved. */
  'no_such_request',
  /** Gap too large to replay; re-fetch full history. */
  'cursor_expired',
  /** Host isn't connected to the relay. */
  'host_offline',
  /** The Claude session ended. */
  'session_closed',
  /** Too many requests. */
  'rate_limited',
  /** Unknown `req.kind`. */
  'unknown_kind',
  /** The request was malformed or semantically invalid. */
  'bad_request',
  /**
   * The requested permission mode is not permitted from a remote control
   * surface. `bypassPermissions` can never be set from a phone.
   */
  'forbidden_mode',
  /** Unexpected failure inside the host. */
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});

export type MoteError = z.infer<typeof ErrorSchema>;
