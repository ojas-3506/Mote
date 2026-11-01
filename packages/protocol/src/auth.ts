/**
 * How a peer proves who it is.
 *
 * Two mechanisms, because the platform only offers one of them.
 *
 * **The `Authorization` header** works everywhere except in a browser. A
 * phone cannot put a bearer token on a WebSocket handshake — the browser
 * API has no way to set headers — so the token would have to travel in the
 * URL, where it lands in access logs and proxy logs. The project's rule is
 * that a token never goes in a query string, and that rule is worth more
 * than the convenience of one header.
 *
 * **The WebSocket subprotocol** works in a browser. `new WebSocket(url,
 * protocols)` sends the list in the `Sec-WebSocket-Protocol` header, and
 * the server echoes back the one it selected. The token rides along as a
 * second entry; the server selects only `WS_PROTOCOL`, so the token is
 * never reflected back.
 *
 * Both are headers. Neither puts the token in a URL.
 */

/** The subprotocol every Mote WebSocket offers, and the one the server echoes. */
export const WS_PROTOCOL = 'mote-v1';

/**
 * The subprotocol list a client offers.
 *
 * The token is the second entry. The server must select `WS_PROTOCOL` — a
 * browser fails the connection if the server selects nothing.
 */
export function wsProtocols(token: string): string[] {
  return [WS_PROTOCOL, token];
}

/**
 * Pull a token out of a request, wherever the peer put it.
 *
 * The `Authorization` header is checked first: it is what the host daemon
 * and the CLI use, and it is the only option outside a browser.
 */
export function bearerToken(headers: {
  authorization?: string | undefined;
  'sec-websocket-protocol'?: string | string[] | undefined;
}): string | undefined {
  const authorization = headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  const offered = headers['sec-websocket-protocol'];
  const protocols = (Array.isArray(offered) ? offered.join(',') : offered ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  // The token is the second entry; the first names the protocol we speak.
  if (protocols[0] === WS_PROTOCOL && protocols.length > 1) {
    return protocols[1];
  }
  return undefined;
}
