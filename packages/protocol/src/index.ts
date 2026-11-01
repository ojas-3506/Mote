/**
 * @ccr/protocol — the ccr wire format.
 *
 * This package is the single source of truth for what travels between the
 * phone, the relay, and the host daemon. Everything else imports from here;
 * nothing here imports from anywhere else.
 */

export * from './version.js';
export * from './errors.js';
export * from './events.js';
export * from './suggestions.js';
export * from './control.js';
export * from './sessions.js';
export * from './auth.js';
export * from './frames.js';
