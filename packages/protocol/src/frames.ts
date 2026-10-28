import { z } from 'zod';
import {
  CONTROL_DATA,
  CONTROL_KINDS,
  type ControlData,
  type ControlKind,
} from './control.js';
import { ErrorSchema } from './errors.js';
import { EvtFrameSchema, type EventType } from './events.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The frame envelope.
 *
 * All messages are JSON text frames. `v` is the protocol version; a peer that
 * receives a version it doesn't implement must close the connection with a
 * `res` carrying `code: 'unsupported_version'`.
 */

const v = z.literal(PROTOCOL_VERSION);

/** Host → relay → client: who this peer is and what it can do. */
export const HostHelloFrameSchema = z.object({
  v,
  t: z.literal('hello'),
  role: z.literal('host'),
  hostId: z.string().min(1),
  hostName: z.string(),
  claudeVersion: z.string(),
  sdkVersion: z.string(),
  workspaces: z.array(
    z.object({
      path: z.string(),
      label: z.string(),
    }),
  ),
});
export type HostHelloFrame = z.infer<typeof HostHelloFrameSchema>;

export const ClientHelloFrameSchema = z.object({
  v,
  t: z.literal('hello'),
  role: z.literal('client'),
  deviceId: z.string().min(1),
  deviceName: z.string(),
});
export type ClientHelloFrame = z.infer<typeof ClientHelloFrameSchema>;

export const HelloFrameSchema = z.discriminatedUnion('role', [
  HostHelloFrameSchema,
  ClientHelloFrameSchema,
]);
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

/** Client → host: a request for the host to do something. */
export const ReqFrameSchema = z.discriminatedUnion('kind', [
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('prompt.send'), data: CONTROL_DATA['prompt.send'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('session.interrupt'), data: CONTROL_DATA['session.interrupt'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('permission.resolve'), data: CONTROL_DATA['permission.resolve'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('session.model'), data: CONTROL_DATA['session.model'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('session.permission_mode'), data: CONTROL_DATA['session.permission_mode'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('session.rename'), data: CONTROL_DATA['session.rename'] }),
  z.object({ v, t: z.literal('req'), id: z.string().min(1), kind: z.literal('session.close'), data: CONTROL_DATA['session.close'] }),
]);
export type ReqFrame = z.infer<typeof ReqFrameSchema>;

/** Host → client: the answer to a `req`. */
export const ResFrameSchema = z.discriminatedUnion('ok', [
  z.object({ v, t: z.literal('res'), id: z.string().min(1), ok: z.literal(true), data: z.unknown().optional() }),
  z.object({ v, t: z.literal('res'), id: z.string().min(1), ok: z.literal(false), error: ErrorSchema }),
]);
export type ResFrame = z.infer<typeof ResFrameSchema>;

export const PingFrameSchema = z.object({ v, t: z.literal('ping'), ts: z.number().int() });
export type PingFrame = z.infer<typeof PingFrameSchema>;

export const PongFrameSchema = z.object({ v, t: z.literal('pong'), ts: z.number().int() });
export type PongFrame = z.infer<typeof PongFrameSchema>;

export const FrameSchema = z.union([
  HelloFrameSchema,
  EvtFrameSchema,
  ReqFrameSchema,
  ResFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
]);

export type Frame = z.infer<typeof FrameSchema>;

/** The frame kinds, for exhaustive switching. */
export type FrameType = Frame['t'];

// ── Constructors ───────────────────────────────────────────────────────────

export function hostHello(input: Omit<HostHelloFrame, 'v' | 't' | 'role'>): HostHelloFrame {
  return { v: PROTOCOL_VERSION, t: 'hello', role: 'host', ...input };
}

export function clientHello(input: Omit<ClientHelloFrame, 'v' | 't' | 'role'>): ClientHelloFrame {
  return { v: PROTOCOL_VERSION, t: 'hello', role: 'client', ...input };
}

export function req<K extends ControlKind>(id: string, kind: K, data: ControlData<K>): ReqFrame {
  return { v: PROTOCOL_VERSION, t: 'req', id, kind, data } as ReqFrame;
}

export function ok(id: string, data?: unknown): ResFrame {
  return data === undefined
    ? { v: PROTOCOL_VERSION, t: 'res', id, ok: true }
    : { v: PROTOCOL_VERSION, t: 'res', id, ok: true, data };
}

export function fail(
  id: string,
  code: z.infer<typeof ErrorSchema>['code'],
  message: string,
): ResFrame {
  return { v: PROTOCOL_VERSION, t: 'res', id, ok: false, error: { code, message } };
}

// ── Guards ──────────────────────────────────────────────────────────────────

export function isEvtFrame(frame: Frame): frame is z.infer<typeof EvtFrameSchema> {
  return frame.t === 'evt';
}

export function isReqFrame(frame: Frame): frame is ReqFrame {
  return frame.t === 'req';
}

export function isResFrame(frame: Frame): frame is ResFrame {
  return frame.t === 'res';
}

/**
 * Parse a raw frame. Throws `z.ZodError` on a malformed frame — callers that
 * want to stay alive should use `safeParseFrame` and close the connection.
 */
export function parseFrame(raw: unknown): Frame {
  return FrameSchema.parse(raw);
}

export function safeParseFrame(raw: unknown): ReturnType<typeof FrameSchema.safeParse> {
  return FrameSchema.safeParse(raw);
}

/** The event types this peer understands, for the `hello` handshake. */
export const SUPPORTED_CONTROL_KINDS = CONTROL_KINDS;
export const SUPPORTED_EVENT_TYPES: EventType[] = EvtFrameSchema.options.map(
  (o) => o.shape.type.value,
) as EventType[];
