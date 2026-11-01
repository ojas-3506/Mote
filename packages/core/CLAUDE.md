# @mote/core

Server-side machinery shared by the host daemon and the relay: the event log,
live fan-out with cursor replay, pending permission requests, and JSON frame
connections.

Nothing here knows about Claude Code, the Anthropic API, or the relay's tenancy
model. That separation is deliberate — it is why the host and the relay can
behave identically from a client's point of view.

| File | Holds |
| --- | --- |
| `event-log.ts` | `EventLog` interface, `MemoryEventLog`, `JsonlEventLog` — owner-only, because the log holds the whole transcript |
| `session-stream.ts` | `SessionStream` — publish, subscribe, cursor replay |
| `pending.ts` | `PendingRequests` — the approval lifecycle |
| `connection.ts` | `FrameConnection`, `attachWebSocketServer` |
| `logger.ts` | structured logging that never sees payload content |

## The event log assigns sequence numbers

`seq` is per-session, monotonic, and gapless. It is assigned by the log,
because the log is what every client sees events through — the host in LAN
mode, the relay in hosted mode. Whoever calls `publish` doesn't get to choose
the number.

`JsonlEventLog` writes one file per session and rebuilds its index on open,
so a host restart preserves both the history and the numbering. A client that
was disconnected across the restart can still resume from its cursor.

The index is in memory. Fine for v1 session sizes; if that stops being true,
swap in a real database behind the `EventLog` interface rather than growing
the JSONL implementation.

## Attaching without a gap

`SessionStream.attach` subscribes **before** it reads the log, and buffers
anything that arrives during the read.

This ordering is the whole point. If you read first and subscribe second, an
event published in between is lost — and the client never learns its sequence
number, so no cursor can ever repair the hole. The buffered events are
deduplicated against the replay by `seq` so nothing is delivered twice.

`cursor_expired` is returned when the gap exceeds `maxReplay` (10k events by
default). The client then re-fetches full history and starts a fresh cursor.

## Pending approvals fail closed

`PendingRequests` is where the security properties of the approval flow live:

- `settle()` returns `false` for an unknown, already-answered, or timed-out
  request. The host answers the client with `no_such_request`. A late "Allow"
  can never apply to a later prompt.
- The timeout resolves with `onTimeout()`, which **must** be the deny verdict.
- `failAll()` resolves everything pending as denied. The host calls it when it
  shuts down or loses its peer — a request must never be silently satisfied by
  a disconnect.
- A duplicate request id throws rather than orphaning the first promise.

The timeout timer is deliberately **not** `unref()`'d. The deny-on-timeout is a
guarantee, not a convenience: it has to fire even when nothing else is keeping
the process alive. Shutdown paths call `failAll()`, which clears the timers.

### `settle()` is async, and that is the point

`settle(id, value, beforeRelease?)` takes an optional hook that runs *after*
the request has been claimed and *before* the verdict is delivered. The host
writes its audit record in that hook: an approval that outruns its own record
defeats the purpose of the record.

Two things depend on the ordering, so don't "simplify" it back to a
synchronous settle:

- **The claim happens before the hook runs.** The entry is removed from the map
  first, so a second verdict for the same id cannot release the request while
  the first is still recording it. The timeout timer is cleared at the same
  moment — once a request is claimed it is being decided, and a timeout firing
  underneath a half-written record would leave the two disagreeing.
- **A hook that throws denies the request.** The verdict resolves as denied
  and the error is rethrown. A record that cannot be written must not let an
  unrecorded approval through, and must not leave the agent blocked forever.

`onEnded(id)` fires when a request ends *without* being answered — a timeout
or a `failAll` — so the caller can drop the per-request state it kept.

## Connections

`attachWebSocketServer` handles the `upgrade` event on an existing HTTP
server, so the same port can serve the PWA, the REST endpoints, and the
WebSocket. It uses `noServer` rather than binding its own port for exactly
that reason.

`FrameConnection` enforces the framing rules: JSON text frames only, a size
limit, and a keepalive that reaps half-open sockets. A malformed frame closes
the connection rather than being guessed at.

## Logging

`createLogger` writes JSON lines. Log *shape* freely — ids, counts, sizes,
durations, error codes. Log *content* never: no prompt text, no tool input,
no file contents. The relay's own logs must never contain prompt content.
