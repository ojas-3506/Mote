# Mote — Claude Code Remote

**An open, self-hostable mobile client for your Claude Code session.** Keep the agent and
your code on your own machine; drive it from your phone over any network.

> **Status: the host daemon works, and the phone can connect.** `moted` owns a real
> Claude Code session, relays tool approvals, and serves the PWA on the local
> network. The app's transport is done end to end. The chat view and the
> permission sheet are next — see [docs/DESIGN.md](docs/DESIGN.md) for the plan.
>
> **This is an early project.** There is no release, no installer, and no
> relay. The permission sheet is not built, and the app deliberately has no
> way to approve a tool call yet.

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

| Setup | Remote Control | Channels | **Mote** |
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

**Mote is for everyone Remote Control leaves out**, and for anyone who wants their own
infrastructure instead of someone else's. If you have a subscription and don't mind
Anthropic's transport, use Remote Control — it's the better default and we say so in
our docs. Mote runs the CLI **locally** and only relays events, so it works with
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

## Try it

```bash
npm install
npm run build

# Start the daemon on your machine. It prints a URL to open on your phone.
npx moted --cwd ~/projects/my-repo
```

```
moted listening on http://192.168.1.24:8787
  host      my-laptop (0213e0ae-c996-4bf3-a63a-7fd6e2bd566c)
  claude    2.1.312   sdk 0.3.312
  session   sess_my-repo-e14b24  /home/you/projects/my-repo

  open on your phone:  http://192.168.1.24:8787/#t=<token>
```

The token travels in the URL *fragment*, which browsers never send to a server.
The daemon requires it on every connection — on a home LAN as much as over the
internet, because approving a tool call is running code.

`node scripts/smoke.mjs` drives the whole thing end to end against a real
Claude Code session.

### Working on it

```bash
npm run dev      # the daemon on :8787 and the Vite dev server on :5173
```

The app always talks to its own origin, so the dev server proxies `/mote/v1/*`
to the daemon and the app code is the same in both modes. Open
`http://<your-lan-ip>:5173/#t=<token>` — the token is the same one the daemon
printed.

---

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — architecture, the Claude Code integration, session
  lifecycle, milestones, and open questions.
- **[docs/EVENT-PROTOCOL.md](docs/EVENT-PROTOCOL.md)** — the wire format: frames, event
  types, cursor semantics, control messages.
- **[docs/SECURITY.md](docs/SECURITY.md)** — threat model, pairing, token handling, the
  permission surface, and sandboxing.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to build, test, and propose a change.

Each package carries its own `CLAUDE.md` describing what it holds and the rules
that apply inside it.

## Layout

```
packages/
  protocol/   shared event schema + zod validation (the source of truth)
  core/       the event log, fan-out, pending approvals
  host/       moted — the daemon that owns the Claude Code session
  app/        the PWA (React + Vite)
  relay/      the WebSocket relay, event log, and push dispatch   ← next
  cli/        mote — install, pair, inspect
```

The dependency graph is a straight line: `protocol` ← `core` ← {`host`,
`relay`, `cli`} and `protocol` ← `app`. Nothing imports backwards.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). If you touch anything to do with
permissions, read [docs/SECURITY.md](docs/SECURITY.md) first — it is the
product, not a footnote.

## License

Apache-2.0. See [LICENSE](LICENSE).

