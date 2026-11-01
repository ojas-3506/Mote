# Security model

**Read this before implementing anything that touches permissions.**

Mote lets a phone approve tool calls in a Claude Code session running on someone's
machine. That is remote code execution by proxy. A single mistaken tap on a phone can
run `rm -rf`, push to a production branch, or exfiltrate an SSH key. The rest of this
project is a convenience; this section is the product.

## 1. Threat model

### Assets

1. **The user's filesystem and credentials.** SSH keys, `.env` files, cloud tokens,
   browser cookies, `~/.aws`, `~/.config/gh`.
2. **The user's repository state.** Uncommitted work, unpublished branches, local
   commits, secrets committed by accident.
3. **The user's Anthropic/provider credentials and billing.**
4. **The conversation itself.** Prompts and file contents often contain proprietary
   code, customer data, or credentials pasted in good faith.

### Adversaries

| Adversary | Capability | Goal |
| --- | --- | --- |
| Network attacker | sees TLS metadata | read traffic — blocked by TLS (v1) / E2E (v3) |
| Malicious relay operator | sees all plaintext traffic | read prompts and code; v1 exposure, v3 fixes |
| Stolen or borrowed phone | unlocked device | approve permissions, read the session |
| Hostile app on the phone | JS in the same origin | exfiltrate device token |
| Malicious MCP server | a tool the session uses | social-engineer the approval prompt |
| Compromised repo | attacker-controlled code/CLAUDE.md | trick Claude into running something |
| Opportunistic user of the public relay | legitimate account | abuse the relay for free compute, spam hosts |

### Trust boundaries

```
┌──────────────┐  TLS   ┌──────────┐  TLS   ┌────────────────────────────┐
│ Phone (PWA)  │◄──────►│  Relay   │◄──────►│ Host — your machine        │
│  holds the   │        │  sees    │        │  holds your code, creds,   │
│  device      │        │  traffic │        │  and runs Claude Code      │
│  token       │        │  (v1)    │        │                            │
└──────────────┘        └──────────┘        └────────────────────────────┘
```

The relay is outside the trust boundary in v1. The host is the only component that
touches anything sensitive. **The relay must never be able to execute anything on
the host** — it routes frames and nothing else.

## 2. Credentials

| Credential | Lifetime | Storage | Revocable |
| --- | --- | --- | --- |
| Host token | long-lived, rotatable | relay: hashed; host: `0600` file | yes, per host |
| Device token | long-lived, rotatable | relay: hashed; phone: IndexedDB (WebCrypto) | yes, per device |
| Pairing code | 5 minutes, single use | relay, in memory | auto-expires |

- Tokens are **stored hashed at the relay**. The plaintext host token is shown to the
  user once at enrollment and never again; a lost token means re-pairing.
- Every token is scoped: a host token can only publish events for its own sessions; a
  device token can only read and control sessions on hosts that host has paired with.
- **Revocation is immediate and server-side.** A revoked token is rejected on the next
  request; there is no client-side "logged out" that can be skipped.
- Device tokens are sent in the `Authorization` header, never in a query string, so
  they don't land in logs.

**A browser cannot set headers on a WebSocket.** The platform gives a phone no
way to put an `Authorization` header on a WebSocket handshake, and the
alternative — the token in the URL — is exactly what the rule above forbids.
So the token travels in the `Sec-WebSocket-Protocol` header instead, as a
second entry after `mote-v1`. The server selects only `mote-v1`, so the token is
never echoed back.

Both mechanisms are headers. Neither puts a token in a URL, where it would be
written to access logs and proxy logs by anything in the path.

**A token is required even with no relay in the picture.** The host daemon serves
a phone directly on the LAN in its simplest deployment, and it still demands a
bearer token on every connection. Without one, anyone on the café wifi can
approve a tool call on the machine — and approving a tool call *is* running
code. "It's only my home network" is not a control.

The daemon hands the token to the phone in the **URL fragment** (`#t=...`).
Fragments are never sent to the server, so the token doesn't appear in proxy
logs, relay logs, or the phone's request history.

## 3. Pairing

Pairing is the moment a phone is granted the ability to run code on someone's machine.
It must be deliberate on both sides.

**Host side:** the host prints a short code and a QR code. The code is single-use and
expires in 5 minutes.

**Phone side:** scanning the QR or typing the code enrolls the device. The phone then
shows a confirmation naming the host and the host's machine name.

**Host side again:** when a new device pairs, the host prints a prominent line —
`device paired: <name> (<first-seen ip>)` — so a pairing that the user didn't initiate
is visible. Pairing from a new IP or a new device should be able to trigger a
notification to already-paired devices.

**A public relay must not be able to enumerate pairing codes.** Codes are high
entropy (at least 8 characters from an unambiguous alphabet) and are stored hashed,
like passwords.

## 4. The permission surface

### 4.1 `defaultToNo` is mandatory

The SDK's `canUseTool` context includes `defaultToNo`, documented as: *"The ask must
not be approvable by a single stray keystroke: open the prompt on its decline option
and offer no one-key approve shortcut."*

**The client must implement this per request.** Concretely, when `defaultToNo` is set:

- The permission sheet opens with **Deny** focused and highlighted.
- The approve action requires a deliberate tap on a specific target — never a
  double-tap-to-confirm pattern that a stray tap could satisfy, and never a
  swipe.
- There is **no** single-keypress, single-tap, or swipe-to-approve path.
- The action must not be reachable from a push notification action button. A
  notification may offer "Open" — never "Allow".

Ignoring `defaultToNo` means the client can approve code execution with a pocket
accident. That is the failure mode this project exists to avoid.

### 4.2 Timeouts fail closed

A permission request that isn't answered within a configurable window (default 15
minutes) resolves as **deny**, and the denial is recorded. Never as "allow", never as
"keep waiting forever" while the agent is blocked.

If the host goes offline while a permission request is pending, the request resolves
as denied. A request must never be silently satisfied by a disconnect.

### 4.3 Late and duplicated verdicts

A resolve for an unknown, expired, or already-resolved `requestId` is rejected. A
late "Allow" must never apply to a *different* subsequent prompt. Each request carries
an opaque `requestId` that is bound to a specific tool call.

### 4.4 "Always allow" is relayed, never synthesized

The SDK provides `suggestions: PermissionUpdate[]` describing what a persistent grant
should look like. The client presents these and returns them **verbatim** as
`updatedPermissions`. The client never constructs permission rule strings itself —
rule syntax is the CLI's business, and a client-generated rule could be broader than
the user believes.

**A phone approval can only create a session-scoped grant.** The host filters the
suggestions before publishing them, and filters the phone's answer again before
handing it to the SDK. Only these survive:

- `addRules` with `destination: 'session'`.
- `setMode` naming a mode a remote client may request — which excludes
  `bypassPermissions`.

Everything else is dropped, because the alternative is a phone tap writing a
permanent rule into the user's `settings.json` or `projectSettings`, or granting
the agent access to a directory tree:

| Dropped | Why |
| --- | --- |
| `destination: 'userSettings' \| 'projectSettings' \| 'localSettings'` | a permanent edit to config, made by tapping a phone |
| `removeRules`, `replaceRules` | can delete a *deny* rule — loosens, not tightens |
| `addDirectories` | widens the set of paths the agent may touch |
| `setMode: 'bypassPermissions'` | the agent can do anything the user can |

When nothing survives the filter, the client offers "allow once" and "deny"
only. That is a correct outcome, not a degraded one.

### 4.5 Untrusted names

`ctx.mcpServer.name` for servers loaded from configuration is **untrusted text**.
It must be escaped before display, and trust must key on `ctx.mcpServer.source` — not
on the name, and not on the `mcp__` tool-name prefix. A prompt titled
"Run `mcp__stripe__delete_customer`" must not be visually indistinguishable from a
first-party built-in tool.

The same applies to every user-visible string derived from the session: tool names,
file paths, diff content, error messages, and command output. All of it is attacker-
influenced (a repo can contain a `CLAUDE.md` that says anything).

### 4.6 Tool input is never executed client-side

`tool.call.input` is displayed, never interpreted. The client must not shell out, not
render HTML from it, not turn a URL in it into a link that auto-fetches.

### 4.7 The approved input is the input that runs

The SDK lets a host rewrite a tool's input in its permission verdict
(`updatedInput`). The host **ignores** `updatedInput` arriving from a remote
client.

Without this rule, a client could approve `Bash(command: "ls")` — read that
prompt, tap Allow — and then rewrite the input to something else. The prompt
would no longer describe what was approved, which makes the whole permission
surface decorative. The input shown in the prompt must be the input that runs.

A host may still rewrite input for its own local policy reasons; that is a
different surface, and it isn't reachable from a phone.

## 5. Prompt injection is in scope

Claude Code executes instructions from files in the repository. A hostile repo — or a
hostile `CLAUDE.md`, issue comment, or web page Claude fetched — can try to get the
agent to take actions. This is inherent to the agent harness, not something Mote
introduces.

What Mote can and must do:

- Never make approval *easier* than the terminal client would.
- Show the full tool input in the permission prompt, not a friendly summary — a
  summary is where an injection hides.
- Never auto-approve anything because of context (a prior approval, a similar tool
  name, a session-level rule the client invented).
- Make the audit log complete enough that a reviewer can reconstruct what was
  approved.

## 6. Sandboxing and unattended runs

The containment boundary for unattended work is Claude Code's sandbox, configured
through the SDK's `SandboxSettings`:

```ts
sandbox: {
  enabled: true,
  failIfUnavailable: true,          // fail closed if the sandbox can't start
  autoAllowBashIfSandboxed: true,
  network: { allowedDomains: [...], strictAllowlist: true },
}
```

`failIfUnavailable: true` is the important one: if the sandbox can't be created, the
session must not proceed unsandboxed.

**Unattended operation** (a turn that runs while nobody is watching) needs an explicit
policy, and the choices are not equivalent:

| Policy | Behavior | Risk |
| --- | --- | --- |
| `dontAsk` | anything that would prompt is denied | safe; agent may stall on denyable work |
| sandbox + `autoAllowBashIfSandboxed` | prompts only for things outside the sandbox | moderate; sandbox escapes are the risk |
| `bypassPermissions` | everything allowed | the agent can do anything the user can |

`bypassPermissions` must never be reachable from a phone, and must never be the
default. If the project offers it at all, it should require an explicit,
clearly-worded, per-session opt-in on the host with a printed warning — and it should
still run inside a sandbox.

## 7. Transport and relay

- TLS everywhere. The relay may terminate TLS for clients and re-encrypt to the host,
  but must not offer a plaintext listener.
- **The relay executes nothing.** It routes frames. No eval, no plugin loading, no
  deserialization of untrusted structures beyond JSON parsing with a size limit.
- The relay stores event payloads at rest. In v1 those are plaintext; in v3 they are
  ciphertext the relay cannot read. The relay's own logs must never contain prompt
  content or tool input.
- Frame size limits and per-connection rate limits are mandatory on a public relay.
- A public relay should not log IP addresses longer than necessary, and should support
  a deployment mode that retains no history at all.

## 8. Audit log

Every approval, denial, prompt, and model switch is recorded on the host:

```
ts, sessionId, actor(deviceId), kind, toolName, toolUseId, decision, inputHash, by
```

The log is append-only and lives on the user's machine. `inputHash` is a hash of the
tool input rather than the input itself, so the log proves *what was approved* without
becoming a second copy of the sensitive data. The full input is recoverable from the
session transcript.

`by` says where a permission verdict came from: `phone` (a person tapped Allow or
Deny), `timeout` (nobody answered), or `host` (the daemon gave up — a disconnect, an
interrupted turn, a record it could not write). Without it, a denial nobody chose looks
the same as one they did.

The audit log must be exportable in a form a user can read. "Trust but verify" is the
point.

**The record is written before the verdict is delivered.** An approval that
outruns its own audit entry defeats the purpose of the entry — if the machine
dies in between, code ran that no record accounts for. The host writes the
audit entry, then releases the verdict.

**A verdict that was refused is not recorded at all.** A resolve for an unknown,
expired, or already-answered `requestId` changes nothing, so recording it would put
an "allow" in the log for a tool call that was actually denied. The log records what
happened, not what was attempted.

**A denial nobody chose is recorded.** A request that times out, a session that
disconnects mid-approval, an interrupted turn — each one denies the tool, and each one
leaves a line saying so. The log has to show what was *not* approved as well as what
was.

## 9. Abuse on a public relay

A public relay is free compute and a free path to people's machines. Mitigations:

- **Rate limiting** per host token, per device token, and per IP.
- **Pairing code entropy and expiry** — the pairing code is the only way to attach a
  new device, so it gets the strictest limits.
- **No execution.** The relay's value to an attacker is bounded by what it stores,
  which v3 reduces to ciphertext.
- **Abuse reporting** — a host token can be revoked, and a user must be able to revoke
  from the host terminal without contacting the relay operator.
- **Self-hosting is a first-class path.** If someone doesn't trust the public relay,
  running their own is one `docker compose up`.

## 10. Reporting a vulnerability

Security issues go to a private security contact, not a public issue. The
address and the process are in [`SECURITY.md`](../SECURITY.md) at the repo
root. Consider a bug bounty once the permission flow has had external review.

## 11. Checklist before any release

Nothing is checked yet — there is no release, and several of these cannot be
satisfied until the client and the relay exist. Where things stand:

**Done in the host** — timeouts resolve to deny, offline resolves to deny,
late and replayed verdicts are rejected, a remote "always allow" can only
create a session-scoped grant, `updatedInput` from a remote client is
ignored, `bypassPermissions` is not settable from any remote client, a token
is required even in LAN-only deployments, and the audit log is append-only,
exportable, and written before the verdict.

**Waiting on the client** — `defaultToNo` honoured per request, one-key
approve paths, escaped MCP server names and session-derived strings, no HTML
rendering of tool input, push notifications that cannot approve.

**Waiting on the relay** — tokens hashed at rest and revocable, frame size
and rate limits, pairing that produces a visible line on the host terminal.

**Not started** — the sandbox.

- [ ] `defaultToNo` is honored per request; no one-key approve path exists
- [ ] Permission requests time out to deny; offline resolves to deny
- [ ] Late/replayed verdicts are rejected
- [ ] "Always allow" returns the SDK's suggestions unmodified
- [ ] Remote "always allow" can only create a session-scoped grant
- [ ] `updatedInput` from a remote client is ignored
- [ ] `bypassPermissions` is not settable from any remote client
- [ ] MCP server names are escaped and trust keys on `source`
- [ ] All session-derived strings are escaped; no HTML rendering of tool input
- [ ] Push notifications cannot approve anything
- [ ] Tokens are hashed at rest, revocable, and never in query strings or logs
- [ ] A token is required even in LAN-only deployments
- [ ] The relay has frame size limits, rate limits, and executes nothing
- [ ] Sandbox uses `failIfUnavailable: true`
- [ ] Audit log is append-only and exportable, and written before the verdict
- [ ] Pairing produces a visible line on the host terminal
