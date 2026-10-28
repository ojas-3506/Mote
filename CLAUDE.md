# ccr — Claude Code Remote

An open, self-hostable mobile client for your Claude Code session. The agent,
your code, and your credentials stay on your machine; the phone is a viewer
and an approval surface.

**Read `docs/SECURITY.md` before touching anything involving permissions.**
That document is the product, not a footnote.

## Layout

```
packages/
  protocol/   the wire format — zod schemas, frames, events. Source of truth.
  core/       server-side machinery: event log, fan-out, pending approvals.
  host/       ccrd — owns the Claude Code session via the Agent SDK.
  relay/      the WebSocket relay: pairing, tokens, host↔client routing.
  app/        the PWA (React + Vite).
  cli/        ccr — install, pair, inspect.
docs/
  DESIGN.md          architecture, SDK integration, milestones.
  EVENT-PROTOCOL.md  the wire format, in prose.
  SECURITY.md        threat model, permission surface, release checklist.
```

The dependency graph is a straight line: `protocol` ← `core` ← {`host`, `relay`,
`cli`} and `protocol` ← `app`. `protocol` and `core` import nothing from the
packages above them. If you find yourself wanting a back-edge, the design is
wrong — not the import.

## Commands

```bash
npm install          # install (npm workspaces; pnpm also works)
npm run build        # tsc -b across every package
npm run typecheck    # type-check without emitting
npm test             # node:test via tsx
npm run dev          # host daemon + PWA dev server, side by side
```

Node 22.12+. TypeScript is pinned to 5.x (7.x is the native port — not yet
supported here). Zod is 4.x.

## Build phases

The work is split so that each phase ends in something demonstrable.

| Phase | Delivers | Status |
| --- | --- | --- |
| 1 | `protocol` + `core` — the wire contract and the transport plumbing | **done** |
| 2 | `host` — `ccrd` owns a Claude Code session, relays approvals, serves a phone directly | **done** |
| 3 | `relay` — pairing, device/host tokens, host↔client routing | next |
| 4 | `app` — the PWA: chat, tool rows, diffs, the permission sheet | |
| 5 | `cli` + packaging — `ccr` command, install script, Docker | |
| 6 | Hardening — threat-model pass, release checklist, docs | |

Phase 2 deliberately skips the relay: the host serves a phone directly on the
LAN, which is enough to validate the permission sheet against a real human
tapping on a real screen. `scripts/smoke.mjs` drives the whole thing
end to end against a real Claude Code session.

## Architecture

```
┌──────────────────┐        WSS          ┌──────────────┐        WSS          ┌────────────────────┐
│  Phone (PWA)    │◄────────────────────►│    Relay     │◄────────────────────►│  Host (ccrd)       │
│  chat + approvals│     events + cursor  │  session reg │     events + control │  Agent SDK         │
└──────────────────┘                       │  event log   │                     │  your repo         │
                                           │  push        │                     │  your credentials  │
                                           └──────────────┘                     └────────────────────┘
```

Three properties carry the design:

1. **The host dials out.** `ccrd` opens an outbound WebSocket. Nothing connects
   *in* to the user's machine, so there is no port forwarding and no NAT
   traversal.
2. **The relay is a pipe.** It sequences events, logs them, fans them out, and
   dispatches push. It never executes anything and has no filesystem access.
3. **Clients resume from a cursor.** Every event carries a per-session `seq`.
   A client reconnects with `?after=<seq>` and the relay replays the gap. A
   WiFi→cellular handoff becomes a rendering problem, not a lost session.

## Non-negotiable invariants

These are the rules the code exists to enforce. Breaking one breaks the
project's whole reason to exist. Each one has a test.

1. **`defaultToNo` is honoured per request.** When the SDK asks for a decision
   that must not be approvable by a stray keystroke, the phone opens the sheet
   on *Deny*, and there is no single-tap, single-keypress, or swipe approve
   path. Not a notification action, not a double-tap-to-confirm.
2. **Approvals fail closed.** An unanswered request times out to *deny*. A host
   disconnect while a request is pending resolves it to *deny*. Never allow,
   never "hang forever".
3. **A verdict applies exactly once.** Late, replayed, and unknown request ids
   are rejected. An "Allow" that arrives after the timeout must never apply to
   a later prompt.
4. **"Always allow" is relayed, never synthesised.** The SDK's
   `PermissionUpdate[]` suggestions go to the client and come back unmodified.
   The client never builds permission rule strings — rule syntax is the CLI's
   business, and a client-written rule can be broader than the user believes.
   A phone approval may only create a **session-scoped** grant: rules written
   to disk, rule removal, and directory grants are filtered out.
5. **`bypassPermissions` is not remotely settable.** The protocol has no way to
   express it; the host rejects it from any client.
6. **The approved input is the input that runs.** The host ignores
   `updatedInput` from a remote client — otherwise the prompt no longer
   describes what was approved.
7. **Untrusted text stays untrusted.** MCP server names, tool names, file
   paths, diffs, and command output all originate in a repo the user may not
   control. Escape them. Trust keys on `mcpServer.source`, never on the name
   or the `mcp__` prefix.
8. **Tool input is displayed, never interpreted.** No HTML rendering, no
   shelling out, no auto-fetching a URL that appears in tool input.
9. **The relay executes nothing.** It parses JSON with a size limit and routes
   frames. No eval, no plugin loading, no deserialization of anything else.
10. **Credentials stay hashed and out of logs.** Tokens are stored hashed at the
   relay, sent in `Authorization` (never a query string), and prompt content
   never reaches a log file. A token is required even with no relay in the
   picture — "it's only my home network" is not a control.

## Conventions

- **The protocol package is the only place wire shapes are defined.** If you
  need a new event or control kind, add it to `packages/protocol` first, then
  teach the host to emit it and the client to render it.
- **Additive changes don't bump `v`.** New event types and new optional fields
  are fine. Breaking changes bump `v`, and the relay must serve the previous
  major version for at least one release.
- **Unknown event types are ignored by clients**, never treated as errors.
- **TypeScript everywhere.** `protocol` and `core` are Node ESM with explicit
  `.js` import specifiers. The app is bundled by Vite and doesn't need them.
- **No `any` in the protocol or host.** Use `z.infer` and let the schema drive
  the types.
- **Comments explain *why*.** The code says what it does; the comment says why
  it does it that way, or what breaks if you change it.

## Reading order

New to the project? Read `docs/DESIGN.md` for the shape of the thing,
`docs/EVENT-PROTOCOL.md` for the bytes on the wire, and `docs/SECURITY.md`
for the rules above in their full context. Then `packages/protocol/CLAUDE.md`
and `packages/core/CLAUDE.md` for the code you're about to touch.
