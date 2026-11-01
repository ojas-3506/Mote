import { z } from 'zod';
import { SessionIdSchema } from './events.js';

/**
 * The session list a host offers a phone.
 *
 * This is a REST response rather than an event, but it is still a wire
 * shape, and it lives here for the same reason the events do: if it is
 * defined in two places it will drift. The host fills it in, the phone
 * parses it, and both get the change from one edit.
 *
 * It is authenticated like everything else — the list reveals the user's
 * project paths.
 */

/** What the host knows about one session right now. */
export const SessionSummarySchema = z.object({
  sessionId: SessionIdSchema,
  /** Short name for the session list. Usually the workspace's basename. */
  label: z.string(),
  /** Absolute path of the workspace this session works in. */
  cwd: z.string(),
  status: z.enum(['starting', 'ready', 'closed']),
  /** How many permission requests are waiting for an answer. */
  pendingApprovals: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** The body of `GET /mote/v1/sessions`. */
export const SessionListSchema = z.object({
  hostId: z.string().min(1),
  hostName: z.string(),
  claudeVersion: z.string(),
  sdkVersion: z.string(),
  sessions: z.array(SessionSummarySchema),
});
export type SessionList = z.infer<typeof SessionListSchema>;
