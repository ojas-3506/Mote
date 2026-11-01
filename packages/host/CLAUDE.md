# @mote/host

`moted` — the daemon that owns the Claude Code session on the user's machine
and serves it to a phone.

This is the only package that talks to the Agent SDK. Everything the phone
sees comes from here.

| File | Holds |
| --- | --- |
| `daemon.ts` | the entry point: config, wiring, the URL the user opens |
| `config.ts` | configuration and CLI parsing |
| `identity.ts` | the host id and its bearer token |
| `session.ts` | one Claude Code session — **the permission flow lives here** |
| `session-manager.ts` | the set of sessions, one per workspace |
| `sdk-events.ts` | SDK messages → Mote events |
| `server.ts` | HTTP + WebSocket, session discovery, control routing |
| `audit.ts` | the append-only approval log |
| `versions.ts` | the CLI and SDK versions the host reports |

## The SDK is the source of truth, not the design doc

`docs/DESIGN.md` was written against SDK 0.3.311 and describes an API that
has since moved. **Check `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
before writing anything that touches the SDK.** The differences that have
already bitten:

- `PermissionUpdate` is a six-variant union carrying `behavior` and
  `destination`, not `{ type: 'addRules', rules: [...] }`.
- `CanUseTool`'s options include **required** `toolUseID` and `requestId`
  fields, plus `suppressAlwaysAllowRule` and `matchedAskRule`.
- `CanUseTool` may return `null`. We never do — we always return an explicit
  verdict, because failing closed is the point.
- `Options.permissionPrompts` must be `'host'`. With `'none'`, `canUseTool` is
  never called and anything that would prompt is denied immediately.

The SDK spawns its **own bundled** Claude Code binary (2.1.312 as of
0.3.312), not whatever `claude` is on the user's PATH. `versions.ts` reports
the bundled version, which is the one that actually runs.

## The permission flow

This is the part of Mote that can run code on someone's machine. The rules
below are enforced in `session.ts` and covered by `test/host.test.ts`.

**`defaultToNo` defaults to `true`.** When the SDK doesn't say, assume the ask
must not be approvable by a stray keystroke. The flag travels to the phone
per request — it is not a global setting.

**Suggestions are filtered twice.** The SDK's `suggestions` is a
privilege-escalation surface: it can contain a `setMode` naming
`bypassPermissions`, or an `addRules` that writes a permanent rule to the
user's settings. `filterRemotelyGrantable` (in `@mote/protocol`) keeps only
session-scoped, additive grants. It runs when the request is published **and
again** when the phone's answer comes back, because the protocol allows a
client to send any `PermissionUpdate` shape.

**`updatedInput` from a remote client is ignored.** The SDK supports it, and
the phone could rewrite `Bash(command: "ls")` into something else *after* the
user read the prompt. The input that is shown must be the input that runs.

**Approvals fail closed.** An unanswered request times out to *deny*. A host
disconnect resolves pending requests as *deny*. An interrupted turn resolves
the outstanding request as *deny* rather than leaving the agent blocked.

**A verdict applies exactly once.** Unknown, expired, and already-answered
request ids are refused, and the client is told `no_such_request`.

**The audit entry is written before the verdict is delivered.** An approval
that outruns its own record defeats the point of the record.

**A verdict that was refused is not recorded.** A resolve for an unknown,
expired, or already-answered `requestId` changes nothing, and writing it would
put an "allow" in the log for a tool call that was actually denied. The log
records what happened, not what was attempted.

**A denial nobody chose is recorded.** A timeout, a disconnect, an interrupted
turn — each denies the tool and each leaves a line saying so, with `by` naming
where the verdict came from. The log has to show what was *not* approved as
well as what was.

**The SDK's context about *why* it is asking travels with the request.**
`blockedPath` (the path that triggered the ask), `decisionReason` (the trigger
in words), and `agentID` (a sub-agent raised it) are relayed to the phone. A
permission sheet that shows only a tool name and an input blob is a sheet the
user cannot actually decide on.

## The event loop must not hang shutdown

`Session.close()` races the SDK's iterator against a close signal rather than
waiting for the iterator to end on its own. The SDK does not guarantee that
`query()`'s iterator terminates when the session closes, and a consume loop
that never returns would hang the daemon's shutdown — and with it every
outstanding approval.

The abort controller is passed to the SDK as well, so the CLI process is
stopped by the mechanism it actually honours.

## Sessions start lazily

`query()` spawns the Claude Code process. A host with three workspaces should
not spawn three Claude processes the moment it boots, so a session starts when
the first client attaches.

Session ids are derived from the workspace path (`sessionIdForPath`), so a
phone that bookmarked a session reconnects to the same one after a restart.

## An async handler must never reject

The daemon is the only thing holding the Claude session open. If an HTTP or
WebSocket handler throws, the rejection is unhandled and Node ends the
process — taking the session and every approval waiting on it with it.

Both handlers are wrapped, and the one place that used to throw is
`decodeURIComponent`: `decodeURIComponent('%ZZ')` raises a `URIError`, so a
malformed path used to be a remote, unauthenticated way to kill the daemon. It
is a 400 now.

The rule generalises: **anything that can throw from a request path returns an
error response instead of throwing.** The same applies to the SDK callbacks
`session.ts` drives.

## Authentication is not optional

The daemon requires a bearer token on every connection, including on a home
LAN. Without it, anyone on the café wifi can approve a tool call on the
machine — and approving a tool call *is* running code.

The token is generated once, stored in `<dataDir>/host.json` with mode 0600,
and handed to the phone in the **URL fragment** (`#t=...`), which browsers
never send to the server. It must not appear in a query string, a log line, or
an `Authorization` URL.

`MOTE_TOKEN` is the better way to supply one than `--token`: a token on the
command line is visible to every local user with `ps`.

The comparison hashes both sides first. `timingSafeEqual` needs two buffers of
the same length, and returning early on a length mismatch would leak the
token's length through the response time.

**A browser cannot set headers on a WebSocket**, so a phone cannot use the
`Authorization` header on the session socket — and putting the token in the
URL is exactly what the rule above forbids. `bearerToken()` (in
`@mote/protocol`) therefore also accepts the token in the `Sec-WebSocket-
Protocol` header, as a second entry after `mote-v1`. `attachWebSocketServer`
selects `mote-v1` and never echoes the token back — a browser that offered
subprotocols fails the connection if the server selects none.

## Nothing in a request path may reject

An HTTP or WebSocket handler that throws produces an unhandled rejection,
and an unhandled rejection ends the process. The process is the only thing
holding the Claude session — and every approval waiting on it — open.

Both handlers in `server.ts` are wrapped. The audit appends in the control
handler go through `#audit()`, which catches its own failures. If you add a
call that is fire-and-forget, give it the same treatment.

The discovery endpoint (`GET /mote/v1/sessions`) is authenticated too: it
reveals the user's project paths.

## Testing

`test/host.test.ts` drives the whole permission flow against a fake SDK —
`SessionOptions.queryFactory` exists so the code that can run code on someone's
machine can be tested without spawning a real Claude Code process.

`scripts/smoke.mjs` at the repo root runs the real thing end to end against
`127.0.0.1`. It costs a token or two.
