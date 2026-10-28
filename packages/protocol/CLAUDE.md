# @ccr/protocol

The wire format between the phone, the relay, and the host daemon. **Every
other package imports from here; this package imports from nowhere else.**

If a shape is defined in two places, it will drift. Keep the schemas here and
derive the types from them.

## What's here

| File | Holds |
| --- | --- |
| `version.ts` | `PROTOCOL_VERSION`, URL paths, the cursor parameter |
| `errors.ts` | the error codes a `res { ok: false }` may carry |
| `events.ts` | every event the host publishes, and the `evt` frame envelope |
| `control.ts` | every control message a client may send |
| `frames.ts` | the frame envelope, constructors, guards |

## Rules for changing this package

**Add the schema to the discriminated union, not beside it.** `EvtFrameSchema`
is a `z.discriminatedUnion('type', …)`, and the union is what gives the client
exhaustive `switch` narrowing. A new event that isn't in the union doesn't
exist.

**Unknown fields are ignored.** `z.object` strips them, which is exactly the
forward-compatibility rule in `EVENT-PROTOCOL.md` §9. Don't switch anything to
`.strict()` — a peer sending an extra field must not kill the connection.

**Unknown *event types* are ignored by clients, but unknown `req.kind`s are
rejected** with `unknown_kind`. Requests have effects; events don't.

**Additive changes don't bump `v`.** New event types, new optional fields, new
error codes — all fine at `v: 1`. Breaking changes bump `v`, and the relay has
to serve the previous major version for at least one release.

**The envelope is shared.** Every event frame carries `v`, `t`, `seq`,
`sessionId`, and `ts`. `seq` is assigned by the log, not by the host — see
`packages/core/src/event-log.ts`.

## Security-relevant shapes

Two things in here exist specifically to make a mistake hard:

- **`defaultToNo` is a required boolean on `permission.request`.** The host
  defaults it to `true` whenever the SDK doesn't say otherwise — fail closed.
  The client reads it per request; it is not a global setting.

- **`bypassPermissions` is not in `REMOTELY_SETTABLE_MODES`.** `PermissionModeSchema`
  still lists it, because the host itself may set it locally, but
  `isRemotelySettableMode('bypassPermissions')` is `false` and the host
  rejects it from any client with `forbidden_mode`. The protocol cannot
  express "grant everything from a phone".

`PermissionUpdateSchema` mirrors the SDK's `PermissionUpdate[]` exactly. The
client must send the SDK's own suggestions back unmodified — it never builds
rule strings itself.

## Zod 4

The package is on zod 4 (`z.record` takes two arguments, `z.strictObject`
replaces `.strict()`). zod 3 has a high-severity advisory about memory
exhaustion on oversized constrained collections — that matters here, because
the relay parses frames from the internet.

`safeParseFrame` returns zod 4's inferred result type; `parseFrame` throws.
Callers on a socket should prefer `safeParseFrame` and close the connection on
failure — a peer that can't produce a valid frame is not one to keep talking
to.
