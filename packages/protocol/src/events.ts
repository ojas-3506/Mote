import { z } from 'zod';
import { PROTOCOL_VERSION } from './version.js';

/**
 * Event schemas.
 *
 * Every event the host publishes to a client is one of these. The `evt` frame
 * envelope is defined here rather than in `frames.ts` because the discriminated
 * union has to be built over the whole frame — that is what gives the client
 * exhaustive `switch (frame.type)` narrowing.
 */

export const SeqSchema = z.number().int().nonnegative();
export const SessionIdSchema = z.string().min(1).max(256);
export const TimestampSchema = z.number().int().nonnegative();

/** A tool input is arbitrary JSON. It is displayed, never interpreted. */
export const ToolInputSchema = z.record(z.string(), z.unknown());

/**
 * The SDK's `PermissionUpdate[]`, relayed verbatim.
 *
 * The client must never construct these itself — the rule syntax is the CLI's
 * business, and a client-generated rule could be broader than the user
 * believes. See SECURITY.md §4.4.
 */
export const PermissionUpdateSchema = z.object({
  type: z.literal('addRules'),
  rules: z.array(
    z.object({
      toolName: z.string(),
      ruleContent: z.string().optional(),
    }),
  ),
});

export type PermissionUpdate = z.infer<typeof PermissionUpdateSchema>;

export const PrioritySchema = z.enum(['now', 'next', 'later']);
export type Priority = z.infer<typeof PrioritySchema>;

export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Permission modes a remote control surface may request.
 *
 * `bypassPermissions` is deliberately absent. Granting it from a phone is
 * remote code execution with no gate at all, so the protocol has no way to
 * express it — see SECURITY.md §6.
 */
export const REMOTELY_SETTABLE_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] as const;
export type RemotelySettableMode = (typeof REMOTELY_SETTABLE_MODES)[number];

export function isRemotelySettableMode(mode: string): mode is RemotelySettableMode {
  return (REMOTELY_SETTABLE_MODES as readonly string[]).includes(mode);
}

export const IdleReasonSchema = z.enum(['turn_complete', 'awaiting_permission', 'interrupted']);
export type IdleReason = z.infer<typeof IdleReasonSchema>;

export const AttachmentSchema = z.object({
  mimeType: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const GitStatusKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
]);
export type GitStatusKind = z.infer<typeof GitStatusKindSchema>;

/**
 * Fields shared by every `evt` frame.
 *
 * The relay — not the host — assigns `seq`. It is the ordering authority,
 * because every client sees events through it.
 */
const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  t: z.literal('evt'),
  seq: SeqSchema,
  sessionId: SessionIdSchema,
  ts: TimestampSchema,
} as const;

export const EvtFrameSchema = z.discriminatedUnion('type', [
  // ── Session lifecycle ────────────────────────────────────────────────────
  z.object({
    ...envelope,
    type: z.literal('session.started'),
    data: z.object({
      sessionId: SessionIdSchema,
      hostId: z.string().min(1),
      cwd: z.string(),
      claudeSessionId: z.string().min(1),
      model: z.string(),
      resumed: z.boolean(),
      claudeVersion: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session.resumed'),
    data: z.object({
      sessionId: SessionIdSchema,
      claudeSessionId: z.string().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session.idle'),
    data: z.object({
      reason: IdleReasonSchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('session.error'),
    data: z.object({
      code: z.string(),
      message: z.string(),
      fatal: z.boolean(),
    }),
  }),

  // ── Conversation ─────────────────────────────────────────────────────────
  z.object({
    ...envelope,
    type: z.literal('user.message'),
    data: z.object({
      id: z.string().min(1),
      text: z.string(),
      attachments: z.array(AttachmentSchema).optional(),
      priority: PrioritySchema,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('assistant.delta'),
    data: z.object({
      messageId: z.string().min(1),
      text: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('assistant.message'),
    data: z.object({
      messageId: z.string().min(1),
      text: z.string(),
      stopReason: z.string().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('assistant.thinking'),
    data: z.object({
      messageId: z.string().min(1),
      text: z.string(),
    }),
  }),

  // ── Tool activity ────────────────────────────────────────────────────────
  z.object({
    ...envelope,
    type: z.literal('tool.call'),
    data: z.object({
      toolUseId: z.string().min(1),
      name: z.string(),
      displayName: z.string(),
      input: ToolInputSchema,
      parentToolUseId: z.string().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('tool.result'),
    data: z.object({
      toolUseId: z.string().min(1),
      ok: z.boolean(),
      output: z.string(),
      durationMs: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('file.diff'),
    data: z.object({
      path: z.string(),
      hunks: z.array(
        z.object({
          oldStart: z.number().int(),
          oldLines: z.array(z.string()),
          newStart: z.number().int(),
          newLines: z.array(z.string()),
        }),
      ),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('git.status'),
    data: z.object({
      branch: z.string(),
      ahead: z.number().int(),
      behind: z.number().int(),
      changes: z.array(
        z.object({
          path: z.string(),
          status: GitStatusKindSchema,
        }),
      ),
    }),
  }),

  // ── Permissions ──────────────────────────────────────────────────────────
  z.object({
    ...envelope,
    type: z.literal('permission.request'),
    data: z.object({
      requestId: z.string().min(1),
      toolUseId: z.string().min(1),
      toolName: z.string(),
      displayName: z.string(),
      /** The full prompt sentence. Primary text in the UI — not a summary. */
      title: z.string(),
      description: z.string(),
      input: ToolInputSchema,
      /**
       * When true the prompt must open on its decline option and offer no
       * one-key approve path. The host defaults this to `true` whenever the
       * SDK does not say otherwise — fail closed.
       */
      defaultToNo: z.boolean(),
      suggestions: z.array(PermissionUpdateSchema),
      /**
       * The MCP server behind an `mcp__*` tool, if any.
       *
       * `name` is untrusted text for servers loaded from configuration.
       * Trust must key on `source`, never on the name or the `mcp__` prefix.
       */
      mcpServer: z
        .object({
          name: z.string(),
          source: z.string(),
        })
        .optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('permission.resolved'),
    data: z.object({
      requestId: z.string().min(1),
      behavior: z.enum(['allow', 'deny']),
      by: z.enum(['phone', 'timeout', 'host']),
    }),
  }),
]);

export type EvtFrame = z.infer<typeof EvtFrameSchema>;

export type EventType = EvtFrame['type'];

/** An event without its transport envelope — what the host produces. */
export type CcrEvent = {
  [K in EventType]: Pick<Extract<EvtFrame, { type: K }>, 'type' | 'data'>;
}[EventType];

/** The `data` payload for one event type. */
export type EventData<T extends EventType> = Extract<EvtFrame, { type: T }>['data'];

export const EVENT_TYPES = EvtFrameSchema.options.map((o) => o.shape.type.value) as EventType[];

/**
 * Events a client must be able to render. Unknown event types are ignored,
 * never treated as errors — see EVENT-PROTOCOL.md §9.
 */
export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as string[]).includes(value);
}
