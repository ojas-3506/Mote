# Contributing

## Before you start

If your change touches **permissions, approvals, or the relay**, read
[docs/SECURITY.md](docs/SECURITY.md) first. That document is the product, not
a footnote — it says what the non-negotiable rules are and why each one
exists. A change that breaks one of them isn't a bug fix waiting to happen,
it's the thing this project exists to prevent.

Each package has a `CLAUDE.md` describing what it holds and the rules that
apply inside it. Read the one for the package you're about to touch.

## Getting set up

```bash
npm install
npm run build      # tsc -b across the packages, then the PWA bundle
npm test           # node:test, one run per package
npm run dev        # the daemon on :8787 and the Vite dev server on :5173
```

Node 22.12+. TypeScript is pinned to 5.x; zod is 4.x.

## The shape of the project

```
packages/
  protocol/   the wire format — zod schemas, frames, events. Source of truth.
  core/       server-side machinery: event log, fan-out, pending approvals.
  host/       ccrd — owns the Claude Code session via the Agent SDK.
  app/        the PWA (React + Vite).
  relay/      the WebSocket relay: pairing, tokens, host↔client routing.
  cli/        ccr — install, pair, inspect.
```

The dependency graph is a straight line: `protocol` ← `core` ← {`host`,
`relay`, `cli`} and `protocol` ← `app`. **Nothing imports backwards.** If you
find yourself wanting a back-edge, the design is wrong — not the import.

## Conventions

- **The protocol package is the only place wire shapes are defined.** A new
  event or control kind goes into `packages/protocol` first, then the host
  learns to emit it and the client learns to render it.
- **Additive changes don't bump `v`.** New event types and new optional
  fields are fine. A breaking change bumps `v`, and the relay has to serve the
  previous major version for at least one release.
- **Unknown event types are ignored by clients**, never treated as errors.
- **TypeScript everywhere.** `protocol` and `core` are Node ESM with explicit
  `.js` import specifiers; the app is bundled by Vite and doesn't need them.
- **No `any` in the protocol or the host.** Use `z.infer` and let the schema
  drive the types.
- **Comments explain *why*.** The code says what it does; the comment says why
  it does it that way, or what breaks if you change it.

## The Agent SDK moves

`docs/DESIGN.md` was written against SDK 0.3.311 and the API has since
changed. **Check
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before writing
anything that touches the SDK**, and believe `packages/host/CLAUDE.md` over
the design doc when the two disagree.

## Tests

Every non-negotiable rule in `CLAUDE.md` has a test. If you change one of
them, the test changes with it — and if you find a rule with no test, that
is a gap worth filling in the same change.

The permission flow is tested against a fake SDK (`SessionOptions.queryFactory`),
so the code that can run code on someone's machine is testable without
spawning a real Claude Code process.

`node scripts/smoke.mjs` drives the whole thing end to end against a real
Claude Code session. It costs a token or two.

## Pull requests

- Keep them focused. One concern per pull request.
- Say what you changed and why. If you changed a security-relevant behaviour,
  say what you think could break.
- If you fixed a bug, a test that fails without the fix is worth more than a
  description of the bug.

## Reporting a vulnerability

Not a pull request — see [SECURITY.md](SECURITY.md).
