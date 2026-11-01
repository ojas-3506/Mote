/**
 * Where the bearer token comes from, and where it lives.
 *
 * The host prints a URL with the token in the **fragment** (`#t=...`).
 * Fragments are never sent to a server, so the token doesn't land in proxy
 * logs, relay logs, or the phone's request history — but the page can read
 * it, which is the whole point of handing it over that way.
 */

/** sessionStorage, not localStorage: the token dies with the tab. */
const TOKEN_KEY = 'ccr.token';

/**
 * Read the token out of the URL fragment, and take the fragment out of the
 * address bar.
 *
 * Clearing it matters: the fragment is visible in a screenshot, in a shared
 * link, and in the browser's history. Once the token is in hand there is no
 * reason to keep displaying it.
 */
export function takeTokenFromFragment(): string | undefined {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return undefined;

  const token = new URLSearchParams(hash).get('t');
  if (!token) return undefined;

  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}

export function loadToken(): string | undefined {
  return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function saveToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * A stable id for this device, so the host can say *which* phone approved
 * something in its audit log.
 *
 * This is an identifier, not a credential, so `localStorage` is right — it
 * should survive a reload, or the audit trail fills with `unknown` devices.
 */
export function deviceId(): string {
  const key = 'ccr.deviceId';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const id = randomId();
  window.localStorage.setItem(key, id);
  return id;
}

/**
 * A random id.
 *
 * `crypto.randomUUID` only exists in a secure context, and the app is served
 * over plain http on a LAN — so it is not an option. `getRandomValues` is
 * available everywhere.
 */
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
