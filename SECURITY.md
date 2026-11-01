# Security policy

## Reporting a vulnerability

**Please report security issues privately.** Do not open a public issue.

Email **mexter.dolester@gmail.com** with:

- what the issue is and what an attacker gets,
- the version of `ccrd`, the Agent SDK, and the Claude Code CLI you were on,
- how to reproduce it.

You will get an acknowledgement within a few days. If a fix takes longer than
that, you will get a timeline.

Please give us a reasonable window to release a fix before disclosing
publicly. We will credit you unless you would rather we didn't.

## What this project is

ccr lets a phone approve tool calls in a Claude Code session running on
someone's machine. **Tapping "Allow" on your phone is remote code execution by
proxy.** That makes the permission surface the product, not a feature of it.

The full threat model — the assets, the adversaries, the trust boundaries, the
permission surface, and the release checklist — is in
**[docs/SECURITY.md](docs/SECURITY.md)**. Read it before contributing anything
that touches permissions.

## The rules that are not negotiable

Each of these has a test:

1. `defaultToNo` is honoured per request. There is no one-key, one-tap, or
   swipe path to approving a tool call.
2. Approvals fail closed. A timeout, a disconnect, or an interrupted turn
   resolves to *deny* — never *allow*, never "hang forever".
3. A verdict applies exactly once. Late, replayed, and unknown request ids are
   rejected.
4. "Always allow" is relayed, never synthesised. The client returns the SDK's
   own suggestions unmodified, and can only create a **session-scoped** grant.
5. `bypassPermissions` is not remotely settable. The protocol cannot express
   it.
6. The approved input is the input that runs. A remote client's `updatedInput`
   is ignored.
7. Untrusted text stays untrusted. MCP server names, tool names, file paths,
   diffs, and command output all originate in a repo the user may not control.
8. Tool input is displayed, never interpreted.
9. The relay executes nothing.
10. Credentials stay hashed and out of logs, and never in a URL.

## Scope

The host daemon, the relay, and the phone client are all in scope. If you
find a way to get code executed on a host without a deliberate approval, that
is a reportable issue, whatever part of the system it is in.
