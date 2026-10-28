# ccr — Claude Code Remote

**An open, self-hostable mobile client for your Claude Code session.** Keep the agent and
your code on your own machine; drive it from your phone over any network.

> **Status: design phase.** Nothing here runs yet. This repo currently contains the
> design docs, not an implementation.

---

## The problem

Claude Code is a terminal application that lives on one machine. When you leave that
machine — a flight, a café, a hotel wifi — you lose the session: you can't see what
Claude is doing, can't answer its permission prompts, and can't tell it to try
something else. Work stops until you're back at your desk.

You want to keep working. Not "start a task and check on it later" — keep the same
session, mid-flight, with the agent running against your real checkout.

## Why this isn't Remote Control

Claude Code ships **Remote Control** (`claude remote-control`), which connects
claude.ai/code and the Claude mobile app to a local session. It's excellent — and it
excludes a large group of users:

| Setup | Remote Control | Channels | **ccr** |
| --- | --- | --- | --- |
| claude.ai subscription (Pro/Max) | ✅ | ✅ | ✅ |
| Anthropic Console API key | ❌ | ✅ | ✅ |
| Amazon Bedrock / Google Cloud Agent Platform / Microsoft Foundry | ❌ | ❌ | ✅ |
| Custom `ANTHROPIC_BASE_URL` (LLM gateway or proxy) | ❌ | ❌ | ✅ |
| `DISABLE_TELEMETRY` / `DO_NOT_TRACK` set | ❌ (below v2.1.283) | — | ✅ |
| Team/Enterprise with Remote Control disabled by admin | ❌ | ❌ | ✅ |
| Your own relay, your own data | ❌ | ❌ | ✅ |
| Your own UI, multi-tenant, many hosts | ❌ | ❌ | ✅ |

Remote Control also requires a claude.ai subscription, stores the transcript on
Anthropic servers while connected, and offers no public API to build on.

**ccr is for everyone Remote Control leaves out**, and for anyone who wants their own
infrastructure instead of someone else's. If you have a subscription and don't mind
Anthropic's transport, use Remote Control — it's the better default and we say so in
our docs. ccr runs the CLI **locally** and only relays events, so it works with
whatever authentication and provider you already use.

## Design principles

1. **Your code never leaves your machine.** The relay routes encrypted-ish event
   frames. It never executes anything, and it has no access to your filesystem.
2. **Your credentials never leave your machine.** Claude Code runs on your box with
   your auth — subscription, API key, Bedrock, Vertex, or an LLM gateway.
3. **The relay is dumb and replaceable.** Run your own with one `docker compose up`.
   The public one is a convenience, not a dependency.
4. **The phone is a viewer, not a worker.** All state lives on the host. Losing the
   phone never loses the session.
5. **Approval must be deliberate.** Approving a tool call *is* remote code execution.
   The UI is designed around that fact — see [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — architecture, the Claude Code integration, session
  lifecycle, milestones, and open questions.
- **[docs/EVENT-PROTOCOL.md](docs/EVENT-PROTOCOL.md)** — the wire format: frames, event
  types, cursor semantics, control messages.
- **[docs/SECURITY.md](docs/SECURITY.md)** — threat model, pairing, token handling, the
  permission surface, and sandboxing.

## Planned layout

```
packages/
  protocol/   shared event schema + zod validation (the source of truth)
  host/       ccrd — the daemon that owns the Claude Code session
  relay/      the WebSocket relay, event log, and push dispatch
  app/        the PWA (React + Vite)
  cli/        ccr — install, pair, inspect
```

## License

TBD — will be Apache-2.0 or MIT.
