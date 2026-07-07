# The Lantean protocol

The Lantean protocol is the WebSocket wire contract spoken by
`svelte-adapter-uws` and its client (`svelte-adapter-uws/client`). It is the
contract a third-party client - in any language - implements against.
`svelte-adapter-uws` is the reference implementation; `svelte-realtime` is
built on top of it and speaks the same wire. The name is implementation-neutral
on purpose: five surfaces speak this protocol (the uWS production runtime, the
Vite dev server, the in-process test handler, the deterministic simulator, and
a native runtime), so the contract is named for itself, not for one package.

The reference implementation is `src/client.js` (client) and
`src/runtime/wire.js` + `src/runtime/handler.js` (server); `src/vite.js` (dev)
and `src/testing.js` (test) speak the identical wire.

## Meta

- **Canonical location:** `PROTOCOL.md` in the `svelte-adapter-uws` repository.
- **Revision:** 1.
- **Date:** 2026-07-05.
- **Applies to:** `svelte-adapter-uws` 0.6.0 and later, its bundled client, and
  `svelte-realtime` built on it.
- **Status: frozen.** Revision 1 is a backward-compatibility commitment: within
  the 0.6.x line the control-frame shapes, the data-event envelope, the binary
  `0x03` layout, and the capability-token mechanics in this document will not
  change incompatibly. The wire evolves only additively - new optional fields,
  new capability tokens, new schema versions within a token - per section 5 and
  section 10. A change that is not additive ships as revision 2 behind a new
  token and is never a silent reinterpretation of anything frozen here.
- **Errata:** corrections that document shipped behavior more accurately (never a
  wire change) land as editorial updates to this revision; report them on the
  repository issue tracker. A wire change lands as a new revision.
- **License:** this document may be reproduced, in whole or in part (including
  its frame tables), to implement or describe the protocol.

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY, and
OPTIONAL in this document are to be interpreted as described in BCP 14
(RFC 2119, RFC 8174) when, and only when, they appear in all capitals. Prose
that describes the reference implementation without these keywords is
descriptive, not a conformance requirement.

---

## 1. Framing and demux

A connection carries three kinds of WebSocket frame, demuxed by the framework
before any application code runs:

- **Text frame, JSON object with a `type` field** - a *control frame* (section 3).
- **Text frame, JSON object with `topic` + `event`** - a *data-event* frame
  (section 4). It has no `type` field.
- **Binary frame, leading byte `0x03`** - a *binary payload frame* (section 6).
  Server to client it is a *binary topic payload* (sections 6.1-6.4); client to
  server it is a *binary ingress payload* (section 6.5), and ONLY when the
  `wire.ingress:1` capability was negotiated. Leading bytes `0x00`-`0x02` are
  reserved for the `svelte-realtime` layer (binary RPC and uploads); see the
  binary leading-byte registry (appendix C.3).

JSON is the default for everything. The binary `0x03` frame is the only non-JSON
shape, and it is opt-in per connection (section 5). A client that speaks only
JSON is a complete, correct client.

All multi-byte text frames are UTF-8.

### 1.1 Control-frame recognition is by byte prefix (normative for c->s)

The server recognizes a client-to-server control frame by a hot-path byte check,
not by parsing: a text frame is treated as a control frame only when it is under
the control-frame size ceiling (section 1.2) AND its 4th byte (index 3) is `y`
(`0x79`) - i.e. the frame begins exactly `{"type`. Only then is it JSON-parsed.

A consequence a third-party client MUST honour: **client-to-server control
frames MUST be serialized as compact JSON with `"type"` as the first key, with
no leading whitespace and nothing before `type`.** A frame such as
`{ "type": "subscribe" }` (leading space), `{"ref":1,"type":"subscribe"}` (a key
before `type`), or a pretty-printed frame does not begin `{"type`, so the server
does not recognize it as a control frame: it is delivered to the application
message handler as opaque data, with no ack and no error. The reference client
always emits compact, `type`-first control frames. Server-to-client frames carry
no such constraint - the reference client full-parses every inbound text frame,
so key order in a server frame is free.

Data-event frames (`{"topic`, byte[3] = `o`) are not control frames and are
never subject to this check; they are identified after parsing by the presence
of `topic` + `event` (section 4) and MAY appear in either direction.

### 1.2 Control-frame size ceiling (normative)

A client-to-server control frame is recognized as a control frame only while its
total size is **under 8192 bytes**. A client MUST keep every control frame under
this limit. In particular a client MUST chunk `subscribe-batch` (its `topics`
array plus any `recover` map, section 3.2) so each frame stays below 8192 bytes,
rather than relying on the 256-topic cap alone; the reference client chunks at
8000 bytes and 200 topics for headroom.

A control-SHAPED text frame (it begins `{"type`) that reaches or exceeds 8192
bytes is rejected: the server replies with an `error` control frame
(`{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":8192}`, section 3.7)
and does not act on the oversized frame. This turns what would otherwise be a
silent loss into a signal. A `reply` frame (section 3.3) is a control frame and
so is subject to this ceiling: a large reply payload MUST NOT be sent as a
`reply` control frame - use the application-layer binary RPC that `svelte-realtime`
provides for large request/reply payloads. A large text frame that is NOT
control-shaped (a data-event `{"topic`, or any other application text) is not
rejected by this ceiling; it is bounded only by the transport limit (section 1.3).

### 1.3 Transport limits and liveness

- **Inbound frame size.** The server enforces `maxPayloadLength` (default 1 MiB,
  deployment-configurable). A WebSocket frame larger than this causes a
  protocol-level connection close. A server MUST NOT assume application frames
  larger than its configured limit ever arrive intact.
- **Outbound frame size (the client's own inbound cap).** The reference client
  SILENTLY DROPS any server-to-client text or binary WebSocket message larger
  than 1 MiB, in either encoding, with no wire signal. A server therefore
  SHOULD NOT publish a single envelope larger than 1 MiB to a browser client;
  oversized state SHOULD be chunked or moved to a binary codec.
- **Liveness.** The server relies on the WebSocket transport's own keepalive: it
  sends protocol-level pings automatically (default idle timeout 120 seconds) and
  closes an idle connection. A client only needs standard WebSocket pong behavior
  (automatic in browsers). There is no application-level JSON heartbeat frame; a
  third-party client MUST NOT invent one.

### 1.4 Unknown frames

- **Unknown control `type` (section 3, appendix C.1).** A peer that receives a
  control frame whose `type` it does not recognize MUST NOT error. The server
  forwards an unrecognized (but parsed) control frame to the application message
  handler; the reference client ignores an unrecognized server `type`. This is
  the frame-level half of the forward-compatibility rule (section 10): a future
  control type is safe to introduce because existing peers pass it through or
  ignore it.
- **Unknown binary leading byte, by direction.** Client to server: a binary
  frame whose leading byte is not a recognized tag reaches the application
  message handler untouched (it is application payload). Server to client: the
  reference client DROPS any binary frame that is not a well-formed `0x03` frame
  for a known topic id - server-originated binary never falls through to the app
  surface.

---

## 2. Connection lifecycle

1. The client opens the WebSocket. The server immediately sends `welcome` with a
   session id.
2. The client MAY send `hello` to advertise capabilities (section 5). A client
   that never sends `hello` gets the zero-feature JSON path - the
   backward-compatible default, always correct.
3. The client subscribes to topics (`subscribe` / `subscribe-batch`), each
   acknowledged by `subscribed` or `subscribe-denied` (unless the request is in
   the silent mode, section 3.2).
4. Data flows as data-event frames (and, for capability-negotiated topics, as
   `0x03` binary frames).
5. On reconnect the client recovers missed events per topic instead of
   cold-starting (section 7).

Capabilities and the per-connection binary id space are connection-scoped: a
reconnect is a fresh connection that re-advertises `hello` and re-learns any
`wire-id`.

---

## 3. Control frames

Direction key: `[c->s]` client to server, `[s->c]` server to client, `[both]`
either direction.

### 3.1 Connection and capability

| Frame | Dir | Shape |
|---|---|---|
| `welcome` | s->c | `{"type":"welcome","sessionId":"<uuid>"}` |
| `hello` | c->s | `{"type":"hello","caps":["batch","lease", ...]}` |
| `lease-ok` | s->c | `{"type":"lease-ok"}` |

`welcome` is sent once, unprompted, as the first server frame. It carries only
the session id (used by `resume`). `hello` advertises the client's decodable
capabilities (section 5); it is OPTIONAL. `lease-ok` confirms the server will
honour credit-based flow control for a client that advertised `lease`.

A re-sent `hello` REPLACES the connection's capability set (it is not merged);
this supports a lazily-loaded plugin re-advertising an extended set. Two effects
are decided once and are NOT re-evaluated by a later `hello`: credit-based flow
control is armed only by the first `hello` that carries `lease`, and a stateful
binary codec's attach decision (which schema version this connection negotiated)
is fixed for the life of the connection. Both reset only on reconnect.

Parsing is lenient by construction: a `hello` whose `caps` is not an array is
ignored entirely (the capability set is unchanged), and non-string entries
inside the array are skipped. Unknown tokens are recorded but gate nothing, so
advertising a token the server does not know is harmless.

### 3.2 Subscription

| Frame | Dir | Shape |
|---|---|---|
| `subscribe` | c->s | `{"type":"subscribe","topic":"<string>","ref":<int\|string>,"recover"?:{"offset":<int>,"epoch"?:<int>}}` |
| `subscribe-batch` | c->s | `{"type":"subscribe-batch","topics":["<string>", ...],"ref":<int\|string>,"recover"?:{"<topic>":{"offset":<int>,"epoch"?:<int>}}}` |
| `unsubscribe` | c->s | `{"type":"unsubscribe","topic":"<string>"}` |
| `subscribed` | s->c | `{"type":"subscribed","topic":"<string>","ref":<int\|string>,"epoch":<int>}` |
| `subscribe-denied` | s->c | `{"type":"subscribe-denied","topic":"<string>","ref":<int\|string>,"reason":"<string>"}` |

- `ref` is a client-allocated correlation id (a per-connection incrementing
  integer in the reference client; a string is also accepted). The server echoes
  it on the matching ack and never mints its own. **Silent mode:** a request
  whose `ref` is absent, or is not a number or string (null, boolean, object),
  is performed but NOT acked - the server sends no `subscribed` and no
  `subscribe-denied`. An emitted ack therefore always carries a number or string
  `ref`, never `null`.
- `subscribe-batch` caps at **256 topics per frame** and emits one
  `subscribed` / `subscribe-denied` ack per topic, all sharing the one `ref`.
  Topics past the cap are NOT subscribed and are each answered
  `subscribe-denied` with reason `BATCH_OVERFLOW` (under the silent-mode rule
  above: a ref-less batch stays silent) - never dropped without a signal. A
  client MUST NOT exceed the cap; it SHOULD chunk instead. (The reference
  client chunks well below this, at 8000 bytes and 200 topics, to respect the
  control-frame ceiling of section 1.2.)
- `unsubscribe` carries no `ref` and is not acked; the server drops the
  subscription silently.
- A duplicate `subscribe` to a topic already subscribed is acked idempotently
  with the same `subscribed` shape (no double-count). Any authorization gate
  (below) re-runs on the duplicate, so a topic whose authorization has since been
  revoked MAY answer `subscribe-denied` instead.
- `epoch` on `subscribed` is the topic's sequence-space generation (section 7).
- `reason` on `subscribe-denied` is a string. See section 3.2.2 for the
  framework-minted reasons and the application namespace.
- `recover` is resume-on-subscribe (section 7). On `subscribe` it is a single
  `{offset, epoch?}`; on `subscribe-batch` it is a map keyed by topic, so
  recovery for many topics rides the same already-chunked batch instead of a
  separate whole-session `resume` frame that would overflow the control-frame
  ceiling. For each recover-tagged topic the server gap-fills the missed tail
  ahead of the first live frame, exactly as the `resume` frame does, and omits it
  for a topic the auth gate denied. A client that omits `recover` (or a server
  that does not implement it) is byte-identical to a plain subscribe.

#### 3.2.1 Topic names (normative)

A topic is a string. The server accepts a `subscribe` topic only when all of the
following hold; otherwise it answers `subscribe-denied` with reason
`INVALID_TOPIC`:

- non-empty, and at most **256 characters**;
- no character below `0x20` (control characters);
- no `"` (`0x22`) and no `\` (`0x5C`);
- no character above `0x7E` UNLESS the server enabled the `allowNonAsciiTopics`
  option (default off) - so by default topics are printable ASCII.

Independently, a wire `subscribe` to a topic beginning with `__` (two
underscores) is denied `INVALID_TOPIC` UNLESS the server enabled the
`allowSystemTopicSubscribe` option (default off). The `__` prefix is reserved for
framework channels (appendix C.2, e.g. `__replay:`, `__presence:`, `__signal:`)
that MUST NOT be client-subscribable by default. Both options are
deployment-dependent: a third-party client MUST NOT assume either is enabled and
SHOULD treat an `INVALID_TOPIC` on a `__`-prefixed or non-ASCII topic as expected.

#### 3.2.2 Denial reasons

`reason` on `subscribe-denied` is an open-ended string, but the FRAMEWORK itself
mints exactly these:

| Reason | When |
|---|---|
| `INVALID_TOPIC` | The topic failed section 3.2.1, or a default-reserved `__` topic. |
| `RATE_LIMITED` | The connection's subscription cap was reached. |
| `BATCH_OVERFLOW` | The topic sat past the 256-topic `subscribe-batch` cap (section 3.2) and was never subscribed. |
| `FORBIDDEN` | An application authorization gate returned `false`. |
| `INTERNAL_ERROR` | An application authorization gate threw or rejected (fail-closed). |

`UNAUTHENTICATED` is a recognized convention for an application gate to return,
but the framework does not mint or enforce it. An application authorization gate
MAY return any other string, which the server passes through verbatim as
`reason`. A client SHOULD treat an unrecognized `reason` as a denial it cannot
retry blindly.

### 3.3 Data and correlation

| Frame | Dir | Shape |
|---|---|---|
| `batch` | s->c | `{"type":"batch","events":[<data-event>, ...]}` |
| `request` | s->c | `{"type":"request","ref":<int\|string>,"event":"<string>","data":<any\|null>}` |
| `reply` | c->s | `{"type":"reply","ref":<int\|string>,"data":<any\|null>}` or `{"type":"reply","ref":<int\|string>,"error":"<string>"}` |

- `batch` carries N data-event envelopes (section 4) in one frame; it is sent
  only to a client that advertised the `batch` capability. A client decodes it by
  dispatching each element as if it had arrived on its own. Batched events never
  carry `j` (section 4): they are envelopes produced without a jitter window.
- `request` is a server-initiated round-trip: the client answers with `reply`
  carrying the same `ref`. A `reply` with a string `error` field is a rejection;
  otherwise `data` is the result. The server times the pending request out
  (default 5000 ms). `reply` is a control frame and is bounded by the
  control-frame ceiling (section 1.2); for a large reply payload use the
  application-layer binary RPC rather than a `reply` control frame.

### 3.4 Binary topic-id announce

| Frame | Dir | Shape |
|---|---|---|
| `wire-id` | s->c | `{"type":"wire-id","topic":"<string>","id":<int>}` |

Binds a numeric `id` to a topic name so the client can resolve an inbound `0x03`
frame (which carries only the numeric id). See section 6.

### 3.5 Resume

| Frame | Dir | Shape |
|---|---|---|
| `resume` | c->s | `{"type":"resume","sessionId":"<uuid>","lastSeenSeqs":{"<topic>":<int>},"lastSeenEpochs"?:{"<topic>":<int>}}` |
| `resumed` | s->c | `{"type":"resumed"}` |

See section 7. Resume-on-subscribe (`recover`, section 3.2) is the reference
client's mechanism; the whole-session `resume` frame is retained for compatibility.

### 3.6 Flow control (optional)

| Frame | Dir | Shape |
|---|---|---|
| `lease` | s->c | `{"type":"lease","count":<int>,"ttlMs":<int>}` |
| `request-n` | c->s | `{"type":"request-n","n":<int>}` |

Credit-based backpressure, active only when the client advertised the `lease`
capability. The server grants a window (`lease`); the client replenishes
(`request-n`); the server re-grants. **The server sizes each grant from its own
pressure posture and MAY ignore `request-n`'s `n`**: `n` is advisory, and a
client MUST NOT build credit math that assumes the next grant equals the `n` it
sent. A client that does not advertise `lease` never sees these frames and is
never flow-controlled at the protocol layer.

### 3.7 Errors

| Frame | Dir | Shape |
|---|---|---|
| `error` | s->c | `{"type":"error","code":"<string>","limit"?:<int>,"size"?:<int>}` |

A protocol-level error the server surfaces to the client (never to the
application). Revision 1 defines one `code`:

- `CONTROL_FRAME_TOO_LARGE` - a control-shaped frame the client sent reached or
  exceeded the control-frame ceiling (section 1.2) and was rejected, not acted
  on. `limit` is the ceiling in bytes (8192); `size` is the offending frame's
  byte length. The frame was rejected WITHOUT being parsed, so no `ref` or
  `type` can be echoed - the size is the handle a developer has on which frame
  overflowed. The client SHOULD reduce the frame (chunk a batch, move a large
  payload off the control path) and MAY surface the error to a developer.

The `code` set is a registry (appendix C.3): a client MUST ignore an `error`
frame whose `code` it does not recognize (per section 1.4).

### 3.8 Binary ingress (optional)

| Frame | Dir | Shape |
|---|---|---|
| `ingress-ok` | s->c | `{"type":"ingress-ok"}` |
| `ingress-bind` | c->s | `{"type":"ingress-bind","id":<int>,"kind":"<string>","target":<any>}` |
| `ingress-bound` | s->c | `{"type":"ingress-bound","id":<int>}` |

Negotiation for client-to-server binary payload frames (section 6.5), active only
when the client advertised the `wire.ingress:1` capability. `ingress-ok` confirms
the server understands ingress (mirror of `lease-ok`). The client then binds a
client-allocated numeric `id` to a decode-and-route destination: `kind` selects a
server-registered ingress handler, `target` is opaque data that handler
interprets. The server acks a successful bind with `ingress-bound`; the client
MUST NOT send `0x03` ingress frames for an `id` before its `ingress-bound` ack.

A server that does not know the `kind` sends no ack (and no rejection), and the
client keeps that destination on its JSON path - a message is never silently
lost. The silence is deliberate, not an oversight: ingress handlers register
lazily on the server (a destination's handler may not exist yet when the bind
arrives), so "unknown kind" is routinely a TRANSIENT state, and a rejection
frame would force clients to distinguish transient from permanent. Instead the
client MAY re-send the same `ingress-bind` when it has reason to believe the
server is ready (the reference client re-announces after an application-level
round-trip on the same destination); a bind that arrives after the handler
registered acks normally. An unanswered bind therefore costs nothing but the
JSON fallback it would have used anyway. Ingress ids are connection-scoped and
re-announced on reconnect (like `wire-id`, reversed).

### 3.9 Drain / reconnect advisory

A server that is draining or restarting MAY send

```json
{"type":"reconnect","windowMs":<int>,"afterMs"?:<int>}
```

to a connection immediately before it closes it (a graceful `1001`). The client
rolls its OWN reconnect delay, uniform in `[afterMs, afterMs + windowMs)`, and
reconnects on that schedule instead of its normal backoff - so the clients of a
draining node scatter across the window rather than all reconnecting in one
backoff-interval burst and stampeding the replacement. `windowMs` (> 0) is the
dispersal width; `afterMs` (>= 0, default 0) is a floor that holds clients off
entirely while the replacement warms.

This reuses the de-herd design of the data-event `j` field (section 4, Appendix
D): the server advertises the WINDOW, never a pre-rolled offset, so every client
rolls independently. The frame is additive and unknown-type-safe (sections 1.4
and 10) - a client that predates it ignores the unknown `type` and falls back to
normal backoff, so it carries no capability token and the protocol revision is
unchanged. It is advisory only: the client arms the dispersed reconnect when the
close actually arrives, and discards the advisory if the close never comes or a
terminal `4401` / `1008` arrives first.

---

## 4. The data-event envelope

The carrier for every published event. It has no `type` field - it is identified
by the presence of `topic` + `event`:

```
{"topic":"<string>","event":"<string>","data":<any>,"seq"?:<int>,"j"?:<number>}
```

- `data` is any JSON value (or `null`).
- `seq` is the per-topic monotonic sequence number. It is **omitted entirely**
  when the publisher disabled sequencing, so a frame without `seq` is the legacy
  shape and is valid. When present it is load-bearing for resume (section 7) and
  for gap detection.
- `j` is an OPTIONAL de-herd window in milliseconds: a hint that the client
  SHOULD stagger its reaction to this event by a random delay in `[0, j)` to
  avoid a thundering herd. It is a number (floats are legal), not necessarily an
  integer. A client that ignores `j` is correct, just un-jittered.
- A client MAY additionally observe a reconstructed `t` field (a server
  timestamp) on events delivered through a binary codec; it is informational.

A data-event frame is the one shape that flows in both directions: a
client-originated frame of this shape is delivered to the server's application
message handler.

---

## 5. Capability negotiation

The client advertises a flat array of capability tokens in `hello.caps`. The
server records them for the connection and gates every optional feature on token
presence: a connection that did not advertise a token never receives a frame the
token guards. There is no per-topic negotiation and no server-driven downgrade
handshake - capability is connection-level and one-directional (the client
declares what it can decode; the server honours it or falls back to JSON).

The reference client assembles `caps` as `["batch", "lease"]` plus every token
each registered wire codec can decode.

### 5.1 Capability registry

Tokens are allocated as `<plugin>.protocol:<n>` (or a bare feature name for the
two core tokens). This table is the registry; a new binary plugin claims a new
token here.

| Token | Binary | schema version | Gates |
|---|---|---|---|
| `batch` | no | n/a | Server may coalesce multiple events into one `batch` frame. |
| `lease` | no | n/a | Credit-based flow control (`lease` / `request-n`, section 3.6). |
| `cursor.protocol:2` | yes | 1 | Binary cursor wire, full-string keys (stateless). The GATING token for the whole cursor family: without it no cursor binary is sent at all. |
| `cursor.protocol:3` | yes | 2 | Binary cursor wire, per-connection short-id dictionary. Effective only alongside `cursor.protocol:2`; advertised alone it has no effect (no cursor binary is sent). |
| `cursor.protocol:4` | yes | 3 | Binary cursor wire, time-stamped short-id dictionary. Effective only alongside `cursor.protocol:2` AND `cursor.protocol:3`; without `:3` it has no effect (the connection falls back to the schema-version-1 full-string encode). |
| `presence.protocol:1` | yes | 1 | Binary presence roster wire. |
| `crdt.protocol:1` | yes | 1 | Binary CRDT update wire (opaque bytes; JSON fallback when absent). |
| `smooth.protocol:1` | yes | 1 | Binary smoothed-entity state wire (server to client). |
| `wire.ingress:1` | yes | n/a | Client-to-server binary payload frames (sections 3.8, 6.5). |

Rules:

1. **Per-feature, versioned tokens.** Each binary plugin owns its token and
   versions it independently. A future incompatible schema ships as a new token
   version (for example a hypothetical `presence.protocol:2`); a client that does
   not know it simply never advertises it and keeps the version it knows, or JSON.
2. **The schema version is the fine gate within a token.** It is the second byte
   of every `0x03` frame (section 6). The cursor family shares one gating token
   family but selects its schema version (1, 2, or 3) from the negotiated set, so
   a single connection always sees one cursor schema version on the wire.
3. **A token is never reinterpreted.** Adding a field to a frame an existing token
   already gates is fine (unknown JSON fields are ignored). Changing the meaning
   of an existing field requires a new token version.
4. **Absence is JSON.** Old client, old server, or a missing token all converge on
   the same JSON path.

### 5.2 Not capability tokens

Three mechanisms look like they might be tokens but are not, and a client MUST
NOT advertise them:

- **Resume** (both the `resume` frame and resume-on-subscribe) is not a
  capability. It is always available; a server that predates resume-on-subscribe
  simply ignores the `recover` field and the client degrades to a plain
  resubscribe (section 7).
- **Resume epochs** are not negotiated. They travel as the optional
  `lastSeenEpochs` field of the `resume` frame and the `epoch` field of the
  `subscribed` ack (section 7). There is no `resume.epoch` token.
- **Cursor viewport** culling is not negotiated. The `cursor-viewport` ingress
  frame (section 8) is plain JSON, gated only by topic membership; there is no
  `cursor.viewport` token. Viewport culling is a server-side option, transparent
  to the wire.

---

## 6. The binary topic frame (`0x03`)

A single optional binary frame type carries codec-encoded payloads. It is the
only non-JSON wire shape. In the egress (server-to-client) direction it carries a
capability-negotiated topic payload (sections 6.1-6.4). In the ingress
(client-to-server) direction it carries a bound input payload (section 6.5), and
ONLY when `wire.ingress:1` was negotiated; a client MUST NOT emit a `0x03` frame
otherwise (client-originated binary without an ingress binding is application
payload).

### 6.1 Layout

```
[0x03][schemaVersion:u8][topicId:varint][seq:varint][payload ...]
```

- `0x03` - the demux byte (one octet).
- `schemaVersion` - one unsigned byte; the fine gate within a capability token
  (section 5). A client rejects a version its codec does not implement.
- `topicId` - the numeric topic id (egress) or ingress id (section 6.5),
  announced by a `wire-id` frame (section 3.4, 6.2) at or before the first `0x03`
  frame that uses it. See section 6.2 for the id value range.
- `seq` - the per-topic monotonic sequence number (the same value the JSON
  envelope carries in `seq`). It is `0` in two cases: the publisher disabled
  sequencing for the topic, OR the frame is a single-target send that lies
  outside the topic's sequence space. A client MUST NOT treat a `0` seq as a
  meaningful position.
- `payload` - opaque codec bytes; the framework does not inspect them. Their
  layout is the plugin codec's own contract.

### 6.2 Topic-id binding and id range

A `0x03` frame carries a numeric `topicId`, never a topic name. `topicId` is an
unsigned integer up to 2^53-1. A client MUST decode and store it as such (the
varint decode of section 6.3 uses division, not 32-bit shifts, for this reason):

- **Per-connection ids start at 1.** The server allocates one lazily, on the
  first binary frame it sends for a topic to a given connection, and announces it
  in a `wire-id` frame on the same ordered socket immediately before that first
  binary frame. The binding resets on reconnect.
- **Shared (cohort) fan-out ids are large.** A topic promoted to shared fan-out
  (a cohort of connections receiving one server-encoded frame) announces a
  SERVER-WIDE id allocated from 2^32 upward - so ids at or above 4294967296 occur
  in normal operation. A client that stores topic ids in a 32-bit integer, or
  decodes the varint with 32-bit shifts, WILL break the moment a deployment uses
  a shared codec.

A shared-fan-out `wire-id` is announced at COHORT-JOIN time - at subscribe for
a topic already promoted to shared fan-out, or at the topic's FIRST shared
publish for connections that were already subscribed when the promotion
happened. Either way the announce MAY arrive long before any `0x03` frame for
that topic and MAY never be followed by one. A per-connection `wire-id` is
announced immediately before its first `0x03`. In all cases the announce
arrives at or before the first `0x03` frame that uses the id; a client MUST
record every `wire-id` mapping on arrival.

### 6.3 Primitive encodings (for codec authors)

The framework helpers a plugin codec builds on:

- **varint** - unsigned LEB128: 7 data bits per byte, least-significant byte
  first, continuation bit `0x80` set on every byte but the last. A decoder MUST
  advance the accumulated value by multiplication/division (or 64-bit-safe math),
  NOT a 32-bit shift, so values above 2^32 (section 6.2) round-trip exactly and a
  sequence number is never truncated.
- **f32** - 4-byte big-endian IEEE-754 single precision.
- **f64** - 8-byte big-endian IEEE-754 double precision.
- **str** - a varint byte-length prefix followed by that many UTF-8 bytes (not
  null-terminated).

### 6.4 Backward compatibility and degradation

A topic is sent in `0x03` form only to a connection that advertised the matching
binary token. Any other connection (no `hello`, missing token, or unknown schema
version) receives the JSON data-event envelope for the same topic. The two forms
are interchangeable at the topic level; a deployment can serve binary and JSON
subscribers of the same topic simultaneously.

Binary delivery for a capability MAY cease permanently mid-connection. If a
`wire-id` announce or a stateful binary frame is dropped under backpressure, the
server can no longer trust that connection's decoder state for that capability, so
it degrades that capability to JSON for the rest of the connection (it recovers on
reconnect). Therefore **a client MUST accept the JSON data-event form of any
topic at any time, even after it has received `0x03` frames for that topic.** A
client that treats the first binary frame for a topic as a commitment to binary
will break.

### 6.5 Ingress direction (client -> server)

A connection that advertised `wire.ingress:1` (section 3.8) MAY send the same
`0x03` frame in the client-to-server direction, to move a hot client input path
off the JSON control envelope (and off the per-frame `JSON.parse` it costs). The
layout is identical:

```
[0x03][schemaVersion:u8][ingressId:varint][seq:varint][payload ...]
```

The only reinterpretation is the id slot: it carries a client-allocated *ingress
id*, bound to a destination by an `ingress-bind` frame (section 3.8) and confirmed
by `ingress-bound` before the first `0x03` ingress frame. `schemaVersion` selects
the destination codec's payload revision; `seq` is a per-binding monotonic counter
(`0` allowed); `payload` is the consumer's encoded value, opaque to the framework.

The ingress id space is client-allocated and per-connection (starting at 1), fully
separate from the server-allocated topic-id space of the egress direction, so the
two never collide. On reconnect the client re-announces its bindings from a fresh
`ingress-ok` (the server reset its binding map with the new connection).

Ingress is opt-in and additive: a client that never advertises `wire.ingress:1`,
or a binding the server never acked, uses the equivalent JSON frame - the two are
interchangeable and a deployment can serve both on the same destination.

The first consumer is the smoothed-entity command channel (`smooth.command:1`): a
flush batch of `{id, cmd}` commands encodes as `[count:varint]` then, per command,
`[idDelta:varint][cmd]`, where `cmd` is encoded with the generic compact value
codec (a tagged encoding of the JSON value space - null, boolean, integer as a
zigzag varint, other numbers as f64, string, array, object - matching a
`JSON.stringify`/`JSON.parse` round trip exactly). The decoded batch is identical
to what the JSON path delivers.

---

## 7. Resume

On reconnect a client recovers missed events instead of cold-starting. The model
is a per-topic `(offset, epoch)` pair:

- **offset** - the per-topic sequence number (`seq`) the client last observed,
  reported per topic (in `subscribe`/`subscribe-batch` `recover`, or in
  `resume.lastSeenSeqs`).
- **epoch** - the sequence-space generation for a topic. The server reports the
  current epoch in the `subscribed` ack; the client tracks it and reports it back
  per topic (in `recover.epoch`, or in the optional `resume.lastSeenEpochs`). An
  epoch is an OPAQUE generation stamp (wall-clock ms in the single-process
  default; backend-defined otherwise). **Epochs compare by EQUALITY ONLY** - a
  client MUST NOT infer ordering from epoch values.

Two mechanisms carry the same `(offset, epoch)` recovery, and both drive the
identical per-topic gap-fill:

- **Resume-on-subscribe (the reference client's mechanism).** Each resubscribed
  topic carries its recovery inline as the `recover` field (section 3.2). The
  recovery is chunked with the resubscribe, so it scales to any subscription
  count under the control-frame ceiling. The reference client uses this and sends
  no separate `resume` frame.
- **The `resume` frame (retained for compatibility).** A single whole-session
  frame carrying every topic's offset/epoch at once. The server still accepts it
  (so an older or third-party client keeps working), but at high subscription
  counts it overflows the control-frame ceiling (section 1.2) and is rejected
  (section 3.7) - which is why resume-on-subscribe is preferred. A silently
  downgraded resume would cold-start every topic with no signal; the explicit
  reject prevents that.

For each recovered topic (by either mechanism) the server compares the client's
reported epoch to the topic's current epoch:

- **Epochs match (or the client reported none)** - the offset is meaningful, and
  the server gap-fills the missed tail from its replay buffer (when the topic is
  recoverable).
- **Epochs differ** - the topic's sequence space was reset (a restart, a buffer
  expiry, or a shard move minted a new epoch), so the client's offset belongs to a
  different counter. The server does not gap-fill; it cold-rehydrates that topic
  (signalled by a `rehydrate` replay event, section 8).

Resume-on-subscribe is acked per topic by the ordinary `subscribed` frame (the
gap-fill precedes it); the whole-session `resume` frame is acked once with
`resumed`. The epoch is optional in both: a client that has no epoch for a topic
omits it, and the server treats an absent epoch as a match (single-generation
legacy behaviour). Epochs and recovery are additive - a new client against an old
server, or an old client against a new server, degrade to offset-only recovery
(or, for resume-on-subscribe against a server that predates it, to a plain
resubscribe) without breaking.

Some topic classes (cursors, for example) carry `seq` for uniformity and gap
*detection* but are not recoverable: a gap triggers a fresh snapshot, not a
replay. Recoverability is a per-topic property declared by the plugin, not a
property of the frame.

---

## 8. Plugin ingress frames

The bundled collaborative plugins receive a few plain-JSON control frames from
the client. These are plugin contracts layered on the core protocol, listed here
for completeness; an application that does not use a plugin never sees its frames.
Plugin server-to-client output is not a distinct control type - it rides the
data-event envelope (section 4) under reserved `__`-prefixed topics
(appendix C.2), or the `0x03` binary frame when a binary token is negotiated.

| Frame | Dir | Shape |
|---|---|---|
| `cursor` | c->s | `{"type":"cursor","topic":"<string>","data":<any>}` |
| `cursor-snapshot` | c->s | `{"type":"cursor-snapshot","topic":"<string>"}` |
| `cursor-viewport` | c->s | `{"type":"cursor-viewport","topic":"<string>","rect":{"x":<num>,"y":<num>,"w":<num>,"h":<num>,"zoom":<num>}}` |
| `presence-update` | c->s | `{"type":"presence-update","topic":"<string>","fields":{ ... }}` |
| `presence-snapshot` | c->s | `{"type":"presence-snapshot","topic":"<string>"}` |
| `replay` | c->s | `{"type":"replay","topic":"<string>","since":<int>,"reqId"?:<id>}` |

### 8.1 Replay results

`replay` results arrive as data-event frames on the reserved topic
`__replay:{topic}`. Five events can appear; the client dispatches them by
`event`. The `reqId` field echoes the request's `reqId` and is OMITTED when the
request omitted it (a client that always sends `reqId` always sees it back).

| Event | Payload | Meaning |
|---|---|---|
| `msg` | `{reqId?, seq, event, data}` | One recovered message. |
| `end` | `{reqId?}`, or `{reqId?, truncated:true}` | Terminal: recovery complete. `truncated:true` means the buffer was trimmed past the requested point (in-memory backend inlines truncation here). |
| `truncated` | `null` | Standalone terminal-precursor emitted by some backends before `end` to signal the buffer was trimmed past the requested point. |
| `denied` | `{code, reqId?}` | Terminal: the resume-time subscribe was denied; `code` is the denial reason (section 3.2.2). |
| `rehydrate` | `{epoch}` | Terminal: the reported epoch did not match the topic's current epoch (section 7); the topic must cold-rehydrate. `epoch` is the current generation. |

A client SHOULD treat `truncated`, `denied`, and `rehydrate` alike: recovery did
not complete cleanly, so re-snapshot the topic rather than trusting a gap-fill.
Not every backend emits every event: the in-memory backend signals truncation
inline on `end` and never emits `denied` or `rehydrate`; clustered backends emit
the standalone `truncated`, `denied`, and `rehydrate` forms.

---

## 9. What is not on the wire

The protocol has server-internal machinery that never reaches a client. A client
author can ignore all of it:

- **Cluster fan-out.** In a multi-worker or Redis-clustered deployment the server
  relays publishes between workers/instances and re-encodes binary frames locally
  for each instance's own subscribers. Cohort topic names, the server-wide
  binary-id allocation, the per-process codec registry, and the inter-worker relay
  envelopes are all server-side; a client only ever observes the `wire-id` frame
  and the `0x03` frame defined above, identical whether the deployment is a single
  process or a cluster.
- **Inter-worker / worker-thread messages.** The framework's internal
  `postMessage` frames (publish relays, heartbeats, lifecycle, simulation) are not
  WebSocket frames and are not part of this protocol.

---

## 10. Compatibility and versioning

- Every optional feature is gated by a capability token; a client advertises only
  what it can decode, and the server falls back to JSON otherwise.
- New fields are additive: a peer MUST ignore fields it does not recognise. New
  frame behaviour ships behind a new token (or a new schema version within a
  token), never by reinterpreting an existing field. A new control `type` or a
  new binary leading byte is safe to introduce because existing peers pass it
  through or ignore it (section 1.4).
- There is no wire version number, by design: the capability tokens ARE the
  versioning (appendix D). A client and server negotiate feature by feature.
- A zero-`hello`, JSON-only client is a fully supported first-class client.
- This document is revision 1, frozen for the 0.6.x line (see Meta). The shapes
  above are stable; only additive changes land within revision 1.

---

## 11. Guarantees and non-guarantees

What the protocol PROMISES (a client MAY rely on these):

- `welcome` is the first frame the server sends on a connection.
- Per-topic `seq` is monotonic per connection while the epoch is unchanged.
- A `wire-id` for an id arrives at or before the first `0x03` frame that uses
  that id (section 6.2).
- On resume, a topic's gap-fill frames precede its `subscribed` ack (or the
  whole-session `resumed`).
- `subscribe-batch` acks preserve the submission order of `topics` within a batch.
- Delivery of every event for a topic, across a disconnect, is guaranteed ONLY
  when that topic is recoverable AND the client resumes with a matching epoch and
  a valid offset (section 7).

What the protocol does NOT promise (a client MUST NOT assume these):

- **Subscribe acks do not resolve in request order.** An authorization gate is
  asynchronous, so two `subscribe` requests MAY be acked out of order. Correlate
  by `ref`/`topic`, never by arrival order.
- **No cross-topic ordering.** `seq` is per topic; there is no global order across
  topics.
- **No delivery guarantee without resume + a recoverable topic.** A non-recoverable
  topic (for example a cursor stream) fills a gap with a fresh snapshot, not a
  replay.
- **Binary is not a commitment.** A capability MAY revert to JSON mid-connection
  (section 6.4).
- **`request-n` credit is server-sized.** The next grant is not the `n` you sent
  (section 3.6).

---

## 12. Security considerations

- **Reserved-channel isolation.** Client `subscribe` to a `__`-prefixed topic is
  denied by default (section 3.2.1). Framework channels (`__signal:`, `__presence:`,
  `__replay:`, ...) carry control and other users' state; allowing arbitrary
  client subscription to them would be a channel-hijack vector. A deployment
  enables `allowSystemTopicSubscribe` only when it has its own gate.
- **Topic character rules are log-safety.** The control-character and
  quote/backslash bans (section 3.2.1) keep topic names from injecting into logs,
  metrics labels, and JSON. Non-ASCII is off by default so that bidirectional and
  line-separator code points cannot appear in a topic name unless a deployment
  opts in and accepts the responsibility.
- **DoS posture.** The 8192-byte control-frame ceiling (section 1.2) and the
  1 MiB payload cap (section 1.3) bound per-frame work; an oversized control
  frame is rejected WITHOUT being parsed. Deployments SHOULD additionally apply
  per-IP upgrade rate limiting and a per-connection subscription cap
  (`RATE_LIMITED`, section 3.2.2).
- **Authorization is fail-closed.** An authorization gate that throws denies with
  `INTERNAL_ERROR` (section 3.2.2); it never falls open.
- **Origin and cookies.** The WebSocket upgrade is subject to the server's origin
  policy; a companion authenticate endpoint exists so a session cookie can be set
  on a plain HTTP response (a `Set-Cookie` on the 101 upgrade is dropped by some
  proxies). These are server-API concerns, not wire frames, but a third-party
  client MUST be prepared for an upgrade to be refused by policy.
- **Compression and secrets.** When permessage-deflate is enabled, mixing
  attacker-influenced and secret data in one compression context is a
  BREACH-class risk; the server gates compression accordingly. An application
  SHOULD NOT place secrets in a topic shared with untrusted subscribers.
- **No PII on the wire by default.** Protocol-level frames carry no personal data;
  an application MUST NOT rely on the framework to redact application payloads.

---

## 13. Conformance classes

A client MAY implement a subset of the protocol and still be a first-class
client. Four cumulative classes let a third party claim precise conformance:

| Class | Implements | Sections |
|---|---|---|
| **Core** | welcome, hello (MAY be empty), subscribe/unsubscribe, data-event dispatch, resume-on-subscribe | 1-4, 7 |
| **Batch** | Core + decodes `batch` (advertises `batch`) | + 3.3 |
| **Flow-controlled** | Batch + honours `lease`/`request-n` (advertises `lease`) | + 3.6 |
| **Binary** | Flow-controlled + decodes `0x03` for one or more binary tokens (advertises them) | + 5, 6 |

A Core client that advertises no capabilities is complete and correct: it
receives every topic as JSON and recovers on reconnect. Each higher class is an
opt-in optimization, never a correctness requirement. A client MUST honour the
requirements of every class at or below the one it claims (for example, a Binary
client MUST still accept the JSON form of any topic, section 6.4).

The classes are labels for common bundles, not the only legal combinations:
capability tokens negotiate independently (section 5), so a client MAY
implement any token subset (binary without `lease`, for example) and remain
fully conformant - it simply claims the highest class whose whole row it
satisfies. The ladder mirrors the reference client's own build-up.

---

## Appendix A. Annotated session transcript

One connection, from open to a binary frame to a reconnect gap-fill. `->` is
client-to-server, `<-` is server-to-client. This transcript doubles as an
eyeball-checkable test vector (machine-readable vectors: appendix F).

```
     (WebSocket opens)
<-   {"type":"welcome","sessionId":"7b1c0d2e-...-a90f"}
->   {"type":"hello","caps":["batch","smooth.protocol:1"]}
->   {"type":"subscribe","topic":"arena:1","ref":1}
<-   {"type":"subscribed","topic":"arena:1","ref":1,"epoch":1720094400000}
<-   {"topic":"arena:1","event":"state","data":{"tick":41},"seq":1}
<-   {"type":"wire-id","topic":"arena:1","id":4294967297}
<-   03 01 81 80 80 80 10 AC 02 AA BB CC
       |  |  \___________/  \___/ \______/
       |  |  topicId         seq   payload (opaque codec bytes)
       |  |  = 4294967297     = 300
       |  schemaVersion = 1
       0x03 binary tag

     (connection drops; client reconnects, gets a fresh welcome, re-hellos)
->   {"type":"subscribe","topic":"arena:1","ref":1,
      "recover":{"offset":300,"epoch":1720094400000}}
<-   (gap-fill for seq 301..now, as codec frames or __replay events)
<-   {"type":"subscribed","topic":"arena:1","ref":1,"epoch":1720094400000}
```

Reading the `0x03` frame byte by byte:

- `03` - binary tag.
- `01` - schema version 1.
- `81 80 80 80 10` - `topicId` varint. LEB128, least-significant byte first,
  continuation bit `0x80`: `0x01 + (0x00<<7) + (0x00<<14) + (0x00<<21) + (0x10<<28)`
  = `1 + (16 * 2^28)` = `4294967297`. This id is at or above 2^32 because
  `arena:1` is a shared-cohort topic (section 6.2) - a client decoding this with
  32-bit shifts would read the wrong number.
- `AC 02` - `seq` varint: `0x2C + (0x02<<7)` = `44 + 256` = `300`.
- `AA BB CC` - payload, opaque to the framework (the `smooth.protocol:1` codec's
  own bytes).

The epoch `1720094400000` is a wall-clock-ms generation stamp in the
single-process default; the client stores it verbatim and reports it back on
`recover`. Because the reconnect reported the same epoch, the server gap-fills
from seq 300 rather than cold-rehydrating.

---

## Appendix B. Sequence diagrams

### B.1 Binary negotiation (with JSON fallback)

```
Client                                  Server
  |                                        |
  |--- hello caps:[smooth.protocol:1] ---->|
  |--- subscribe arena:1 ----------------->|
  |<-- subscribed arena:1 (epoch) ---------|
  |                                        |
  |            [token known + backpressure OK]
  |<-- wire-id arena:1 -> id --------------|
  |<-- 0x03 [id][seq][payload] ------------|   (binary from here)
  |                                        |
  |            [token absent, OR a frame dropped -> poisoned]
  |<-- {topic:arena:1,event,data,seq} -----|   (JSON, permanently for this cap)
```

A client MUST accept the JSON envelope for `arena:1` at any time, even after
`0x03` frames, because the server can revert to JSON for the rest of the
connection (section 6.4).

### B.2 Resume

```
Client reconnects, re-subscribes with recover:{offset, epoch}
  |
  |  server compares reported epoch to the topic's current epoch
  |
  +-- epochs EQUAL ------> gap-fill seq (offset+1 .. now) --> subscribed
  |
  +-- epochs DIFFER -----> rehydrate {epoch} (no gap-fill) --> subscribed
  |                        (client re-snapshots the topic)
  |
  +-- buffer trimmed ----> truncated / end{truncated:true} --> subscribed
                           (client re-snapshots the topic)
```

---

## Appendix C. Registries

### C.1 Control-frame `type` registry

Framework-defined `type` values. An unrecognized `type` is passed through
(server: to the app handler; client: ignored) per section 1.4.

`welcome`, `hello`, `lease-ok`, `subscribe`, `subscribe-batch`, `unsubscribe`,
`subscribed`, `subscribe-denied`, `batch`, `request`, `reply`, `wire-id`,
`resume`, `resumed`, `lease`, `request-n`, `error`, `ingress-ok`,
`ingress-bind`, `ingress-bound`, `reconnect`, and the plugin frames of section 8 (`cursor`,
`cursor-snapshot`, `cursor-viewport`, `presence-update`, `presence-snapshot`,
`replay`).

### C.2 Reserved topic-prefix registry

Topics beginning `__` are framework-owned and client-subscribe is denied by
default (section 3.2.1). Known prefixes and their owning layer:

| Prefix | Layer |
|---|---|
| `__replay:` | Replay / resume gap-fill |
| `__presence:` | Presence roster |
| `__cursor:` | Cursor |
| `__crdt:` | CRDT updates |
| `__smooth:` / `__smoothcell:` | Smoothed-entity state and interest cells |
| `__group:` | Group membership |
| `__signal:` | Signalling |
| `__conn:` | Per-connection channel |
| `__subscriptions:` | Subscription bookkeeping |

The list is illustrative, not closed: the whole `__` namespace is reserved. An
application MUST NOT define its own `__`-prefixed topics.

### C.3 Binary leading-byte registry

| Byte | Meaning |
|---|---|
| `0x00` | `svelte-realtime` binary RPC (client to server) |
| `0x01` | Upload chunk (`svelte-realtime`, client to server) |
| `0x02` | Upload cancel (`svelte-realtime`, client to server) |
| `0x03` | Topic payload (egress) / ingress payload (section 6) |
| `0x04`-`0xFF` | Reserved |

### C.4 Protocol `error` code registry

| Code | Meaning |
|---|---|
| `CONTROL_FRAME_TOO_LARGE` | A control-shaped frame exceeded the ceiling (sections 1.2, 3.7). |

---

## Appendix D. Design rationale (why the wire is shaped this way)

These non-choices are deliberate and are recorded so they are not relitigated:

- **No wire version number.** Capability tokens ARE the versioning. A monolithic
  protocol version forces a version matrix; independent per-feature tokens let a
  client and server negotiate one feature at a time and never desync on an
  unrelated change. The absence of a version field is a feature.
- **JSON default, binary opt-in.** A JSON-only client is complete and debuggable
  with no tooling. Binary is a per-capability optimization for hot paths, never a
  precondition for correctness.
- **Per-connection lazy topic ids.** No global id registry to coordinate,
  reconnect-safe, and an id is allocated only for a topic that actually sends
  binary to that connection.
- **Binary is server-to-client for topic payloads; client-to-server only for a
  negotiated ingress binding.** Fan-out is the dominant direction, so that is
  where the encoding lives; client input rides binary only when a hot path
  justifies the `wire.ingress:1` handshake.
- **Flow control is server-sized lease/grant, not client credit.** For a
  fan-out-dominant workload the server observes its own pressure and paces from
  there; per-stream client credit would over-engineer for a load shape that does
  not occur.
- **`j` is a de-herd window, not a server-rolled delay.** One frame fans out to
  many clients; a value the server pre-rolled would synchronize the herd it is
  meant to spread, so each client rolls its own delay in `[0, j)`.
- **Poison-to-JSON on a dropped binary frame** degrades one capability rather than
  desyncing a client dictionary or dropping the connection.
- **Epoch on resume.** A generation stamp per topic is what lets a resume survive
  a server restart or a shard move without silently serving stale sequence
  numbers - the failure mode most homegrown resume schemes hit.
- **`schemaVersion` rides every `0x03` frame** even though a connection's
  negotiated version is fixed at attach. The byte is what lets DIFFERENT tiers
  coexist on one topic and one connection - a per-connection dictionary encode
  and the shared baseline encode a degraded sibling receives carry different
  versions frame by frame - without re-announcing ids. One byte buys the whole
  degradation model of section 6.4.
- **Per-topic subscribe acks, even for a 256-topic batch.** Each `subscribed`
  ack is the ORDERING FENCE for its topic's resume gap-fill (section 11): the
  gap-fill precedes exactly that ack. One combined batch ack would have to wait
  for the slowest authorization gate and would leave gap-fill boundaries
  unmarked; N small acks are the price of per-topic resume that starts flowing
  immediately.
- **Acks exist only where the client must ACT.** `lease` gets `lease-ok`
  (start honouring windows), ingress gets `ingress-ok`/`ingress-bound` (start
  sending binary), but codec tokens get no acknowledgement: decoding is
  reactive, so there is nothing a client would do differently on a codec-token
  ack. `hello` therefore has no general ack, and an `ingress-bind` for a kind
  the server has not (yet) registered gets silence rather than a rejection -
  handlers register lazily, so "unknown" is routinely transient (section 3.8),
  and the JSON fallback is already correct while it lasts.

---

## Appendix E. Frame index

| Frame | Dir | Section |
|---|---|---|
| `welcome` | s->c | 3.1 |
| `hello` | c->s | 3.1 |
| `lease-ok` | s->c | 3.1 |
| `subscribe` | c->s | 3.2 |
| `subscribe-batch` | c->s | 3.2 |
| `unsubscribe` | c->s | 3.2 |
| `subscribed` | s->c | 3.2 |
| `subscribe-denied` | s->c | 3.2 |
| `batch` | s->c | 3.3 |
| `request` | s->c | 3.3 |
| `reply` | c->s | 3.3 |
| `wire-id` | s->c | 3.4 |
| `resume` | c->s | 3.5 |
| `resumed` | s->c | 3.5 |
| `lease` | s->c | 3.6 |
| `request-n` | c->s | 3.6 |
| `error` | s->c | 3.7 |
| `ingress-ok` | s->c | 3.8 |
| `ingress-bind` | c->s | 3.8 |
| `ingress-bound` | s->c | 3.8 |
| `reconnect` | s->c | 3.9 |
| data-event envelope | both | 4 |
| `0x03` binary | both | 6 |
| plugin ingress (`cursor`, `presence-*`, `replay`, ...) | c->s | 8 |

---

## Appendix F. Companion artifacts

Two machine-checkable artifacts live beside this document and are validated in CI
against the reference implementation, so the spec cannot drift from the wire:

- **`protocol.schema.json`** - a JSON Schema for every control frame and the
  data-event envelope. A third-party implementer can validate captured frames
  against it.
- **`test-vectors/`** - recorded transcripts (including a byte-exact `0x03`
  frame) a third-party implementer can replay to check a decoder.

A minimal dependency-free Core client (`examples/minimal-client.mjs`, ~40 lines)
implements connect, subscribe, data-event dispatch, and resume-on-subscribe - the
complete Core class (section 13) by construction. It is exercised by one CI test
against the reference server.
