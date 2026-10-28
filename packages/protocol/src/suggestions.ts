import {
  REMOTELY_SETTABLE_MODES,
  type PermissionUpdate,
} from './events.js';

/**
 * Which of the SDK's "always allow" suggestions a remote approval may grant.
 *
 * The SDK hands the host a set of `PermissionUpdate` objects describing what
 * a persistent grant *could* look like. The host relays them to the phone,
 * and the phone returns one verbatim if the user picks "always allow".
 *
 * That makes the suggestion list a privilege-escalation surface, so it is
 * filtered here rather than trusted. Three rules:
 *
 * 1. **Session scope only.** A rule written to `userSettings`,
 *    `projectSettings`, or `localSettings` outlives the session — it is a
 *    permanent edit to the user's configuration, made by tapping a phone.
 *    A phone approval is scoped to the session it was given in.
 *
 * 2. **No rule removal.** `removeRules` and `replaceRules` can delete a
 *    *deny* rule, which loosens the user's configuration rather than
 *    tightening it. Neither is offered remotely.
 *
 * 3. **No directory grants.** `addDirectories` widens the set of paths the
 *    agent may touch. Not offered remotely.
 *
 * `setMode` survives only for a mode that a remote control surface is
 * permitted to request at all — which excludes `bypassPermissions`. A
 * suggestion that would grant everything is not a suggestion.
 *
 * When nothing survives, the client offers "allow once" and "deny" only. That
 * is a correct outcome, not a degraded one.
 */

const REMOTELY_GRANTABLE_TYPES = new Set(['addRules', 'setMode']);

export function isRemotelyGrantable(update: PermissionUpdate): boolean {
  // 1. Session scope only.
  if (update.destination !== 'session') return false;

  // 2 & 3. Only additive rule grants and session mode changes.
  if (!REMOTELY_GRANTABLE_TYPES.has(update.type)) return false;

  // `setMode` must name a mode a remote surface may request.
  if (update.type === 'setMode') {
    return (REMOTELY_SETTABLE_MODES as readonly string[]).includes(update.mode);
  }

  return true;
}

/**
 * Filter a set of SDK suggestions down to the ones a phone may grant.
 *
 * Order is preserved so the client presents them in the order the SDK ranked
 * them.
 */
export function filterRemotelyGrantable(
  suggestions: readonly PermissionUpdate[],
): PermissionUpdate[] {
  return suggestions.filter(isRemotelyGrantable);
}
