import { z } from 'zod';
import {
  AttachmentSchema,
  PermissionModeSchema,
  PermissionUpdateSchema,
  PrioritySchema,
  ToolInputSchema,
} from './events.js';

/**
 * Control messages: client → relay → host.
 *
 * The relay forwards these; it never interprets them. Every request carries a
 * client-generated `id`, and the host answers with a `res` bearing the same
 * `id`.
 */

export const PromptSendDataSchema = z.object({
  text: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  priority: PrioritySchema.optional(),
});
export type PromptSendData = z.infer<typeof PromptSendDataSchema>;

export const InterruptDataSchema = z.strictObject({});
export type InterruptData = z.infer<typeof InterruptDataSchema>;

export const PermissionResolveDataSchema = z.object({
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  /** Only meaningful when `behavior` is `allow`. */
  updatedInput: ToolInputSchema.optional(),
  /**
   * The SDK's own suggestions, relayed verbatim. The client must not build
   * these itself — see SECURITY.md §4.4.
   */
  updatedPermissions: z.array(PermissionUpdateSchema).optional(),
  /** Only meaningful when `behavior` is `deny`. */
  message: z.string().optional(),
});
export type PermissionResolveData = z.infer<typeof PermissionResolveDataSchema>;

export const SetModelDataSchema = z.object({
  model: z.string().min(1),
});
export type SetModelData = z.infer<typeof SetModelDataSchema>;

export const SetPermissionModeDataSchema = z.object({
  mode: PermissionModeSchema,
});
export type SetPermissionModeData = z.infer<typeof SetPermissionModeDataSchema>;

export const RenameSessionDataSchema = z.object({
  title: z.string().min(1).max(200),
});
export type RenameSessionData = z.infer<typeof RenameSessionDataSchema>;

export const CloseSessionDataSchema = z.strictObject({});
export type CloseSessionData = z.infer<typeof CloseSessionDataSchema>;

export const CONTROL_KINDS = [
  'prompt.send',
  'session.interrupt',
  'permission.resolve',
  'session.model',
  'session.permission_mode',
  'session.rename',
  'session.close',
] as const;

export type ControlKind = (typeof CONTROL_KINDS)[number];

export const ControlKindSchema = z.enum(CONTROL_KINDS);

/**
 * The `data` payload for each control kind.
 *
 * This is the single place the mapping lives; the frame union below is built
 * from it so the two can't drift.
 */
export const CONTROL_DATA = {
  'prompt.send': PromptSendDataSchema,
  'session.interrupt': InterruptDataSchema,
  'permission.resolve': PermissionResolveDataSchema,
  'session.model': SetModelDataSchema,
  'session.permission_mode': SetPermissionModeDataSchema,
  'session.rename': RenameSessionDataSchema,
  'session.close': CloseSessionDataSchema,
} as const satisfies Record<ControlKind, z.ZodTypeAny>;

export type ControlData<K extends ControlKind> = z.infer<(typeof CONTROL_DATA)[K]>;
