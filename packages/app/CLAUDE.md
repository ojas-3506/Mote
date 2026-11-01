# @mote/app

The PWA. The only thing that runs on the phone.

All state lives on the host. The app renders the session and asks for
approvals — it does not compute, and it does not decide.

| File | Holds |
| --- | --- |
| `main.tsx` | the entry point |
| `App.tsx` | the three screens: connect → sessions → session |
| `lib/auth.ts` | the token (from the URL fragment), the device id |
| `lib/client.ts` | the WebSocket: handshake, cursor, requests, reconnect |
| `components/Connect.tsx` | the token screen |
| `components/SessionPicker.tsx` | the host's sessions |
| `components/SessionView.tsx` | the live stream |
| `test/client.test.ts` | the client's behaviour, against a fake host |

## The app talks to its own origin

It never knows where the host is. In production the host serves this bundle,
so its origin *is* the host. In development Vite runs on its own port and
forwards `/mote/v1/*` to the daemon.

That means the app code is identical in both modes, and there is no "which
host am I talking to?" setting to get wrong on a phone.

## The token

The host prints a URL with the token in the **fragment** (`#t=...`).
Fragments are never sent to a server, so the token doesn't land in proxy
logs, relay logs, or the phone's request history — but the page can read it.

The app takes it out of the fragment and out of the address bar, then keeps
it in `sessionStorage` so a reload doesn't lose it. It dies with the tab.

**A browser cannot set headers on a WebSocket.** The host wants the token in
`Authorization`, and the platform gives a phone no way to do that. So the
client offers it as a WebSocket *subprotocol* — `mote-v1` and the token as two
entries — and the server selects `mote-v1` and reads the token from the second.
Both are headers; neither puts the token in a URL, where it would be written
to access logs by anything in the path.

The device id is a separate thing: an identifier, not a credential, so it
lives in `localStorage` and survives a reload. The host records it against
every approval, which is what makes the audit log able to say *which* phone
did something.

## The cursor

Every event carries a `seq`. The client tracks the highest one it has seen
and reconnects with `?after=<seq>`, and the host replays the gap.

This is the whole trick behind "real time across networks". A phone that was
asleep, or that moved from wifi to cellular, comes back to the same session
instead of losing it.

## Rules for the UI

These are not style preferences. They are the product.

- **The permission sheet opens on Deny**, and the approve action is never a
  single tap, a double tap, or a swipe. `defaultToNo` arrives per request,
  not as a setting.
- **Show the full tool input.** A summary is where a prompt injection hides.
- **Render tool input as text.** Never as HTML. No `dangerouslySetInnerHTML`,
  no shelling out, no auto-fetching a URL that appears in tool input.
- **MCP server names are untrusted.** Escape them; trust keys on `source`,
  never on the name or the `mcp__` prefix.
- **"Always allow" is relayed, never synthesised.** The host has already
  filtered the SDK's suggestions to session-scoped grants. Present them
  verbatim and return them unmodified. Never build a rule string here.

## What is not built yet

The screen in `SessionView.tsx` is a **transport proof**: every event, in
order, with the cursor, and a composer. The chat view, the tool rows, the
diff viewer, and the permission sheet are all still to come.

There is deliberately **no approve button** in the permission card. A
half-built approval control is worse than none — the sheet has rules that are
easy to get subtly wrong, and an approval the phone can grant by accident is
the exact failure this project exists to prevent. Until the sheet exists, a
request times out and is denied, which is the safe direction.

## Running it

```bash
npm run dev          # host + Vite, side by side
npm run dev:app      # just the app, on :5173
npm run build        # builds the bundle into packages/app/dist
```

In development the Vite server proxies to `127.0.0.1:8787`. Open the app with
the token in the fragment — the daemon prints a URL with one.
