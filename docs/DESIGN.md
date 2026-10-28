# Design

## 1. Goal

Let someone continue an in-progress Claude Code session from their phone, over any
network, against a working copy on a machine they control — without the agent, the
repository, or the credentials ever leaving that machine.

## 2. Scope

**In scope**

- A host daemon that owns one or more Claude Code sessions on a user's machine.
- A relay that routes session events between host and client over WebSocket.
- A mobile web client (PWA) that renders the session and sends prompts.
- Remote approval of tool calls, with a deliberately conservative UI.
- Push notifications for "Claude needs you" and "Claude is done".

**Out of scope**

- A Claude client. We don't talk to the Anthropic API directly; the CLI does.
- A hosted agent runner. The host is always the user's own machine.
- A general-purpose terminal emulator (see "Rejected: terminal emulation" below).
- Replacing Claude Code's permissions, sandbox, or subagent system.

## 3. Architecture

```
┌──────────────────────┐                ┌──────────────────┐                ┌───────────────────────────────┐
│  Phone (PWA)         │                │  Relay           │                │  Host daemon (ccrd)           │
│  React + Vite        │                │  Go or TS        │                │  runs on the user's machine   │
│                      │   WSS         │                  │   WSS         │                               │
│  chat view           │◄──────────────►│  session registry │◄──────────────►│  Agent SDK → claude process   │
│  tool rows           │  events        │  event log        │  events       │  your repo, your credentials  │
│  diff viewer         │  + cursor      │  web push         │  + control    │  your git, your tools         │
│  permission prompt   │                │  (no execution)   │               │                               │
└──────────────────────┘                └──────────────────┘                └───────────────────────────────┘
             │                                      │                                      │
        Web Push (VAPID)                    SQLite / Postgres                     nothing sensitive
        wake-up only                         append-only log                      leaves this box
```

**Three properties do most of the work:**

1. **The host dials out.** `ccrd` opens an outbound WebSocket to the relay and keeps it
   open. Nothing ever connects *in* to the user's machine, so no port forwarding, no
   NAT traversal, no inbound firewall rules. Works from any network, including
   cellular and CGNAT.
2. **The relay is a pipe.** It assigns sequence numbers, appends events to a log,
   fans them out to connected clients, and dispatches push. It never executes code and
   never has filesystem access. Its blast radius is "it saw your prompts and code" —
   which is why v2 encrypts payloads (see §8).
3. **Clients resume from a cursor.** Every event carries a per-session monotonically
   increasing `seq`. A client reconnects with `?after=<seq>` and the relay replays the
   gap. WiFi→cellular handoff, an iOS-frozen PWA, or a phone that was asleep all
   resolve to "replay from cursor" instead of "lost state". This is what makes
   "real time across networks" a rendering problem instead of a transport problem.

## 4. Claude Code integration

### 4.1 Why the Agent SDK

The integration point is `@anthropic-ai/claude-agent-sdk` (TypeScript) or
`claude-agent-sdk` (Python). The SDK runs the Claude Code binary as a subprocess and
exposes a typed event stream plus programmatic control.

This choice matters because **the SDK inherits whatever authentication the user's CLI
already has**. It spawns the local `claude` binary; it doesn't talk to the Anthropic
API itself. A user on Bedrock, Vertex, Foundry, or a custom `ANTHROPIC_BASE_URL` works
unchanged — the exact population that first-party Remote Control excludes.

The alternative, shelling out to `claude -p --input-format stream-json`, would mean
hand-rolling the wire protocol. The SDK is the documented, versioned interface; use it.

> **Pin a minimum Claude Code version.** Several behaviors are version-gated, including
> `--permission-prompts` (v2.1.259+), `--forward-subagent-text` (v2.1.211+), and the
> `interrupt_cancel_queued_v1` capability (v2.1.219+). Verify against `claude --help`
> and the SDK CHANGELOG for the version we target.

### 4.2 Session lifecycle

A session is a long-lived `query()` with a streaming input generator:

```ts
const q = query({
  prompt: (async function* () {
    // yields SDKUserMessage objects as the phone sends them
  })(),
  options: {
    cwd: "/home/user/projects/my-repo",
    includePartialMessages: true,   // token-level streaming to the phone
    resume: previousClaudeSessionId, // continuity across host restarts
    canUseTool,                     // see §5
  },
});
```

Key SDK surfaces (verified against `@anthropic-ai/claude-agent-sdk` 0.3.311 type
definitions — see §11):

| Need | API |
| --- | --- |
| Start / stream a session | `query({ prompt, options })` → async-iterable `Query` |
| Send a follow-up prompt | yield an `SDKUserMessage` from the input generator |
| Queue a prompt behind a running turn | `SDKUserMessage.priority: 'now' \| 'next' \| 'later'` |
| Stop the current turn | `await q.interrupt()` |
| Switch model mid-session | `await q.setModel(model)` |
| Change permission mode mid-session | `await q.setPermissionMode(mode)` |
| List past sessions | `await listSessions({ dir?, limit?, includeWorktrees? })` |
| Read a session's history | `await getSessionMessages(sessionId, { dir?, limit? })` |
| Rename a session | `await renameSession(sessionId, title, { dir? })` |
| Terminate | `q.close()` |

Message types produced by the iterator: `SDKUserMessage`, `SDKAssistantMessage`,
`SDKResultMessage`, `SDKSystemMessage`, `SDKPartialAssistantMessage` (when
`includePartialMessages` is on), plus hook and task-notification messages.

### 4.3 Session continuity

The Claude session's identity is its transcript UUID under
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. The host records that UUID
alongside its own session ID and passes it back as `options.resume` when the host
restarts. Transcript files are local and their internal format is explicitly
unstable across versions, so **we never parse them** — we use the SDK's
`listSessions` / `getSessionMessages` APIs, or our own event log.

## 5. The permission surface

This is the highest-risk part of the product: **tapping "Allow" on your phone is
authorizing code execution on your machine.** It's the feature that makes the tool
useful and the feature that could destroy a user's server.

The SDK's `canUseTool` callback is the mechanism. It fires only when permission
evaluation falls through to a prompt — calls already covered by `allowedTools`, allow
rules, or the active permission mode don't reach it.

```ts
const canUseTool: CanUseTool = async (toolName, input, ctx) => {
  // ctx.title       — the full prompt sentence rendered by the bridge
  // ctx.displayName — short label, e.g. "Read file"
  // ctx.description  — human-readable subtitle
  // ctx.suggestions  — PermissionUpdate[] for "always allow"
  // ctx.defaultToNo  — see below
  const verdict = await askThePhone({ toolName, input, ctx });
  if (verdict.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: verdict.updatedInput,
      updatedPermissions: verdict.updatedPermissions, // "always allow for this session"
    };
  }
  return { behavior: 'deny', message: verdict.message, interrupt: verdict.interrupt };
};
```

### 5.1 `defaultToNo` is a requirement, not a nicety

The SDK's context carries `defaultToNo`, documented as:

> The ask must not be approvable by a single stray keystroke: open the prompt on its
> decline option and offer no one-key approve shortcut.

**The mobile prompt must honor this per request.** When `defaultToNo` is set, the
permission sheet opens focused on *Deny*, the approve button must not be the default
focused element, and there must be no single-tap or single-keypress approve path. A
phone in a pocket, a muscle-memory tap, or a notification action that approves
without intent must never be able to grant code execution.

This is the single most important UI rule in the project.

### 5.2 "Always allow"

`ctx.suggestions` carries `PermissionUpdate[]` (`{ type: 'addRules', rules: [{ toolName,
ruleContent? }] }`) describing what the SDK suggests for a persistent grant. Return
them as `updatedPermissions` when the user picks "allow for this session". We never
synthesize our own rule strings — we relay the SDK's suggestions verbatim, so the rule
shape always matches what the CLI expects.

### 5.3 Untrusted MCP server names

`ctx.mcpServer` identifies the MCP server behind an `mcp__*` tool. The SDK's own
documentation warns that for servers from configuration, the `name` is **untrusted
text** and must be escaped before display, and that trust decisions must key on
`source` (not the name, and not the `mcp__` prefix).

The mobile UI must therefore escape server names and must not derive trust from the
name or prefix. A prompt reading "Run `mcp__my_bank__transfer`" must not be styled as
trusted because of its prefix.

## 6. Transport

| Hop | Protocol | Direction |
| --- | --- | --- |
| Phone ↔ relay | WebSocket over TLS | phone initiates |
| Host ↔ relay | WebSocket over TLS | host initiates, outbound only |
| Relay → phone | Web Push (VAPID) | out-of-band wake-up only |

**Push is a wake-up, not a transport.** The notification carries enough for the user
to decide whether to open the app (and, in v2, an encrypted payload the service worker
can decrypt). It never carries session content in v1.

**Web Push on iOS** requires the PWA to be added to the home screen and requires
iOS 16.4+. The client must detect that it isn't installed and say so plainly rather
than silently never notifying. If push reliability proves inadequate, the PWA can
later be wrapped with Capacitor without touching the backend.

## 7. Client

**PWA, not native.** The phone runs no meaningful compute — all work happens on the
host — so the app needs no background execution and no offline sync. The deciding
factors are distribution: an open-source tool should install with "Add to Home
Screen" rather than an app store, an Apple developer account, and a review queue.

The UI is chat-like and tool-aware, not a terminal:

- Assistant messages stream token by token.
- Tool calls render as collapsed, tappable rows — title, duration, status.
- File edits render as diffs with a dedicated viewer.
- Permission requests render as a bottom sheet (see §5.1).
- Git status and branch name are always visible.

**Rejected: terminal emulation.** An xterm.js view of a tmux session is trivial to
build and unusable on a phone: no structured tool calls, no native diffs, no typed
permission requests, columns too narrow to read. A terminal is a fallback for
debugging, not the primary interface.

## 8. Encryption

v1 relays event payloads **in plaintext** over TLS, and says so plainly in the README
and in the relay's own logs. This is a real weakness for users with sensitive code and
a real adoption blocker.

The protocol reserves an encrypted-payload envelope from v1 so that v2 is a wire-format
change, not a redesign:

```
{ v: 2, t: "evt", seq: 41, sessionId: "...", enc: "xchacha20poly1305", iv: "...", ct: "..." }
```

The key is derived from the pairing secret via HKDF. The relay stores and forwards
ciphertext it cannot read, which also means it cannot index, search, or moderate
content — an acceptable trade for a relay whose only job is routing. Push payloads
must be encrypted too (Web Push has its own payload encryption, RFC 8291); the service
worker decrypts on device.

## 9. Deployment tiers

| Tier | Who it's for | Setup |
| --- | --- | --- |
| **Public relay** | anyone who wants to try it in 5 minutes | install `ccrd`, pair the phone |
| **Self-hosted relay** | privacy-conscious users, orgs | `docker compose up relay` |
| **LAN / direct** | solo use, air-gapped, no relay process at all | host serves the PWA directly |

The protocol is identical in all three; only the relay's location changes. The relay
never executes code, so running the public one is a much smaller risk than it looks.

## 10. Repository layout

```
packages/
  protocol/   shared event schema + zod validation — the source of truth for the wire
  host/       ccrd: Agent SDK session ownership, event emission, control handling
  relay/      WebSocket relay, event log, pairing, web push
  app/        PWA (React + Vite)
  cli/        ccr: install, pair, list hosts/sessions
docs/
  DESIGN.md          this file
  EVENT-PROTOCOL.md  wire format
  SECURITY.md        threat model
```

TypeScript across the board for v1: the protocol package is shared by all four, the
SDK is TS, and the PWA is TS. If the relay's concurrency profile later demands it, the
relay can be rewritten in Go — the protocol is language-neutral by design.

## 11. Verified API reference

Extracted from `@anthropic-ai/claude-agent-sdk@0.3.311` type definitions and the
Claude Code CLI reference (v2.1.280).

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    mcpServer?: { name: string; source: string };
    decisionReason?: string;
    title?: string;        // full prompt sentence — use as primary text
    displayName?: string;  // short label for buttons
    description?: string;
    defaultToNo?: boolean; // MUST open the prompt on decline
  },
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[]; toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification };

type PermissionUpdate = {
  type: 'addRules';
  rules: { toolName: string; ruleContent?: string }[];
};

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;      // fail closed when the sandbox can't start
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    strictAllowlist?: boolean;
    allowManagedDomainsOnly?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
  };
};

type SDKUserMessage = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: 'now' | 'next' | 'later';
  origin?: SDKMessageOrigin;
};
```

CLI flags verified present in v2.1.280: `--remote-control`, `--channels`,
`--permission-prompt-tool`, `--permission-prompts`, `--permission-mode`,
`--input-format`, `--output-format`, `--include-partial-messages`, `--forward-subagent-text`,
`--bare`, `--worktree`.

## 12. Milestones

**M0 — LAN-only, no relay, no auth.**
`ccrd` serves the PWA over the LAN. No pairing, no event log, no push. Purpose: get a
real UI on a real phone and learn what actually gets used. This is where the
permission sheet design gets validated — watching yourself tap "Allow" on a phone
tells you things a design doc can't.

**M1 — Relay, pairing, push.**
Outbound WSS from host, relay with a SQLite event log, QR/short-code pairing,
per-device tokens, Web Push. Cursor replay. This is the "anyone can start using"
version.

**M2 — Multi-host, resume, sessions.**
Session list across hosts, `resume` across host restarts, `interrupt()` from the
phone, model and permission-mode switching, git status, diff viewer.

**M3 — Encrypted payloads.**
The v2 envelope from §8, key derivation from the pairing secret, encrypted push.

**M4 — Multi-tenant relay.**
Per-user namespaces, rate limiting, quotas, abuse controls.

## 13. Open questions

- **Relay language.** TS for v1 (shared types, fast to iterate) or Go for a single
  static binary and better concurrency. Deferred until M1 shows real load.
- **Installer.** `curl | sh` is friendlier; a Docker image is easier to audit and to
  self-host. Probably both, with the script as the default.
- **Should hostd run the CLI, or attach to one the user started?** Owning the process
  (via the SDK) is simpler and gives full control. But users already running Claude
  Code in a terminal want to *keep* that session and add a phone to it. Claude Code's
  Channels preview is the only sanctioned way to attach to a running session; until
  it's stable, hostd owns its own sessions and users run `ccr` instead of `claude`.
  This is the biggest open product question.
- **Unattended operation.** Long-running turns need permission handling without a
  human. Options: `dontAsk` mode (deny anything that would prompt), a sandbox with
  `autoAllowBashIfSandboxed`, or an explicit "allowlist" policy. The security trade-off
  here deserves its own design note before it's implemented.
- **Multi-device concurrency.** Two phones attached to one session: does the second
  one see the first one's prompts? Presumably yes — the event log is shared — but
  concurrent approvals need a rule.
