/**
 * @ccr/core — server-side machinery shared by the host daemon and the relay.
 *
 * Nothing in here knows about Claude Code, the Anthropic API, or the relay's
 * tenancy model. It is the transport-and-bookkeeping layer: an append-only
 * event log, live fan-out with cursor replay, pending permission requests, and
 * JSON frame connections.
 */

export * from './logger.js';
export * from './event-log.js';
export * from './session-stream.js';
export * from './pending.js';
export * from './connection.js';
