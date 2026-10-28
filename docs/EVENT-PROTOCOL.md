# Event protocol

The wire format between the phone, the relay, and the host daemon. All three are
versioned together; `packages/protocol` is the single source of truth (TypeScript +
zod, with the schema generating the other languages' types).

## 1. Transport summary

| Connection | Endpoint | Initiated by | Auth |
| --- | --- | --- | --- |
| Host | `wss://<relay>/ccr/v1/host` | host (outbound only) | host token in `Authorization` header |
| Client | `wss://<relay>/ccr/v1/session/<sessionId>?after=<seq>` | phone | device token in `Authorization` header |
| Discover | `GET <relay>/ccr/v1/sessions` | phone | device token in `Authorization` header |
| Enroll | `POST <relay>/ccr/v1/pair` | phone | pairing code (one-time) |
| Push sub | `POST <relay>/ccr/v1/push/subscribe` | phone | device token |

Every connection is TLS. There is no plaintext fallback.

**Discovery** returns the sessions the caller may connect to, so a phone
doesn't have to be told a session id out of band. It is authenticated like
everything else: the response contains the user's project paths.

## 2. Frame envelope

All messages are JSON text frames.

```ts
type Frame =
  | { v: 1; t: 'hello'; role: 'host' | 'client'; ... }
  | { v: 1; t: 'evt'; seq: number; sessionId: string; ts: number; type: EventType; data: unknown }
  | { v: 1; t: 'req'; id: string; kind: ControlKind; data: unknown }
  | { v: 1; t: 'res'; id: string; ok: true; data?: unknown }
  | { v: 1; t: 'res'; id: string; ok: false; error: { code: string; message: string } }
  | { v: 1; t: 'ping'; ts: number }
  | { v: 1; t: 'pong'; ts: number }
```

`v` is the protocol version. A peer that receives a version it doesn't implement must
close the connection with a `res` carrying `code: 'unsupported_version'`.

## 3. Sequence numbers and cursor replay

**The relay assigns `seq`.** It is the ordering authority, because every client sees
events through it. `seq` is:

- **per session** (not global),
- **monotonically increasing**,
- **gapless** within a session.

A client that has processed up to `seq = N` reconnects with `?after=N`. The relay
replays events `N+1, N+2, …` from its log, then switches to live delivery.

Three consequences worth stating explicitly:

1. **No client ever silently misses an event.** If the gap is too large to replay
   (configurable, default 10k events), the relay sends
   `{ t: 'res', ok: false, error: { code: 'cursor_expired' } }` and the client
   re-fetches the full session history and starts a fresh cursor.
2. **Event order is the relay's order**, not the host's wall-clock order. The host
   serializes events per session before sending; the relay assigns final order.
3. **A reconnect is indistinguishable from a live stream** to the client. There is no
   separate "replay" mode in the client code path — it just appends events to the
   session view.

## 4. Event types

Canonical event payloads. Fields marked optional may be absent.

### Session lifecycle

| `type` | `data` |
| --- | --- |
| `session.started` | `{ sessionId, hostId, cwd, claudeSessionId, model, resumed, claudeVersion }` |
| `session.resumed` | `{ sessionId, claudeSessionId }` |
| `session.idle` | `{ reason: 'turn_complete' \| 'awaiting_permission' \| 'interrupted' }` |
| `session.error` | `{ code, message, fatal }` |

### Conversation

| `type` | `data` |
| --- | --- |
| `user.message` | `{ id, text, attachments?: [{ mimeType, name, size }], priority }` |
| `assistant.delta` | `{ messageId, text }` — token-level, from `SDKPartialAssistantMessage` |
| `assistant.message` | `{ messageId, text, stopReason }` |
| `assistant.thinking` | `{ messageId, text }` |

### Tool activity

| `type` | `data` |
| --- | --- |
| `tool.call` | `{ toolUseId, name, displayName, input, parentToolUseId? }` |
| `tool.result` | `{ toolUseId, ok, output, durationMs? }` |
| `file.diff` | `{ path, hunks: [{ oldStart, oldLines, newStart, newLines }] }` |
| `git.status` | `{ branch, ahead, behind, changes: [{ path, status }] }` |

`tool.call.input` is the raw tool input. It may contain arbitrary text (a Bash
command, a file body). **Clients must escape it and must never render it as
trusted instruction.** See SECURITY.md §5.

### Permissions

| `type` | `data` |
| --- | --- |
| `permission.request` | `{ requestId, toolUseId, toolName, displayName, title, description, input, defaultToNo, suggestions }` |
| `permission.resolved` | `{ requestId, behavior: 'allow' \| 'deny', by: 'phone' \| 'timeout' \| 'host' }` |

`suggestions` is the SDK's `PermissionUpdate[]`, relayed (after filtering — see
below). The client offers them as "always allow" choices and returns them
unmodified — it never constructs permission rules itself.

The SDK's `PermissionUpdate` is a six-variant union, not a single shape:

```ts
type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules';
      rules: { toolName: string; ruleContent?: string }[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg' }
  | { type: 'setMode'; mode: PermissionMode; destination: ... }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: ... };
```

Both `behavior` and `destination` matter. A rule written to `session` lasts for
the session; one written to `projectSettings` outlives it on disk.

**The host filters the suggestions before publishing them**, and filters the
phone's answer again before handing it to the SDK. Only *session-scoped,
additive* grants survive:

- `addRules` with `destination: 'session'`.
- `setMode` naming a mode a remote client may request — which excludes
  `bypassPermissions`.

`removeRules` and `replaceRules` are dropped: they can delete a *deny* rule,
which loosens the user's configuration rather than tightening it.
`addDirectories` is dropped: it widens the set of paths the agent may touch.
When nothing survives, the client offers "allow once" and "deny" only, which
is a correct outcome rather than a degraded one.

`defaultToNo` **must** be honored by the client: open the prompt on the decline
option, no one-key approve path. The host defaults it to `true` whenever the
SDK does not say.

## 5. Control messages

Client → relay → host. The relay forwards; it does not interpret. Every request gets
a `req` with a client-generated `id`, and the host's answer comes back as a `res` with
the same `id`.

| `kind` | `data` | Notes |
| --- | --- | --- |
| `prompt.send` | `{ text, attachments?, priority? }` | `priority` maps to `SDKUserMessage.priority` |
| `session.interrupt` | `{}` | maps to `Query.interrupt()` |
| `permission.resolve` | `{ requestId, behavior, updatedInput?, updatedPermissions?, message? }` | the only way to approve |

A `permission.resolve` may carry `updatedInput`, but the host **ignores it**
for remote clients. The SDK supports rewriting a tool's input, and a phone
could rewrite `Bash(command: "ls")` into something else *after* the user read
the prompt. The input that was shown must be the input that runs.
| `session.model` | `{ model }` | maps to `Query.setModel()` |
| `session.permission_mode` | `{ mode }` | maps to `Query.setPermissionMode()` |
| `session.rename` | `{ title }` | maps to `renameSession()` |
| `session.close` | `{}` | ends the Claude session |

A `permission.resolve` for an unknown or already-resolved `requestId` returns
`{ ok: false, error: { code: 'no_such_request' } }`. The host must also reject a
resolve for a request that has already timed out — a late "Allow" must never apply to
a subsequent prompt.

## 6. Host → relay

The host connects once and announces itself:

```ts
{ v: 1, t: 'hello', role: 'host', hostId, hostName, claudeVersion, sdkVersion, workspaces: [{ path, label }] }
```

The host then sends events for its sessions. It never receives control messages for
sessions it doesn't own.

## 7. Pairing

```
phone                          relay                         host
  │  POST /pair { code }        │                             │
  │ ───────────────────────────► │                             │
  │                             │  resolve code (one-time)    │
  │  { deviceToken, hostId }    │ ◄────── host claims code ───│
  │ ◄─────────────────────────── │                             │
  │                             │                             │
  │  WSS connect (deviceToken)  │                             │
```

The code is short-lived (default 5 minutes), single-use, and bound to one host. The
host shows it in its terminal and/or as a QR code containing a URL of the form
`https://<relay>/ccr/p/<code>`.

Pairing creates two credentials:

- **host token** — long-lived, revocable, scoped to the host. Grants the ability to
  publish events for that host's sessions.
- **device token** — long-lived, revocable, scoped to one phone. Grants the ability to
  read and control sessions on that host.

Both are stored hashed at the relay (the host token is shown to the user once, at
install time, and never again). See SECURITY.md §2.

## 8. Error codes

| Code | Meaning |
| --- | --- |
| `unauthorized` | bad or revoked token |
| `unsupported_version` | protocol version mismatch |
| `no_such_session` | session doesn't exist or isn't visible to this client |
| `no_such_request` | permission request unknown or already resolved |
| `cursor_expired` | gap too large to replay; re-fetch full history |
| `host_offline` | host isn't connected to the relay |
| `session_closed` | the Claude session ended |
| `rate_limited` | too many requests |
| `unknown_kind` | unknown `req.kind` |
| `bad_request` | the request was malformed or semantically invalid |
| `forbidden_mode` | the requested permission mode is not permitted from a remote client |
| `internal` | an unexpected failure inside the host |

## 9. Forward compatibility

- Unknown event `type` values must be ignored by clients, not treated as errors.
- Unknown fields must be ignored.
- Unknown `req.kind` values must be rejected with `res { ok: false, error: { code:
  'unknown_kind' } }`.
- Additive protocol changes (new event types, new optional fields) do not bump `v`.
  Breaking changes bump `v` and the relay must support the previous version for at
  least one release.

## 10. Versioning

The protocol version is independent of the Claude Code CLI version and the SDK
version. The host reports both in its `hello` frame so the client can warn when the
host is too old for a feature it expects.

`packages/protocol` publishes the schema and a semver'd package. The relay accepts
clients on the current and previous major protocol version.
