# svelte-adapter-uws wire protocol

This document specifies the WebSocket wire protocol spoken by `svelte-adapter-uws`
and its client (`svelte-adapter-uws/client`). It is the contract a third-party
client - in any language - implements against. The reference implementation is
`src/client.js` (client) and `src/runtime/wire.js` + `src/runtime/handler.js`
(server); the Vite dev server (`src/vite.js`) and the in-process test handler
(`src/testing.js`) speak the identical wire.

**Protocol revision: 1, as shipped in `svelte-adapter-uws@0.6.0-next`.**

**Status: stabilizing toward the 0.6.0 release. Changes until 0.6.0 are
additive only (new optional fields, new capability tokens); existing frame
shapes and the binary layout are settled. The wire is not yet frozen - a freeze
(a backward-compatibility commitment) lands with the 0.6.0 release.** The
capability-token mechanism (section 5) is how the wire evolves without breaking
pinned clients: every non-additive change ships behind a new, separately
advertised token.

---

## 1. Framing and demux

A connection carries three kinds of WebSocket frame, demuxed by the framework
before any application code runs:

- **Text frame, JSON object with a `type` field** - a *control frame* (section 3).
- **Text frame, JSON object with `topic` + `event`** - a *data-event* frame
  (section 4). It has no `type` field.
- **Binary frame, leading byte `0x03`** - a *binary topic payload* (section 6).
  Leading bytes `0x01` / `0x02` are reserved for the upload layer; an unknown
  leading byte is passed through untouched.

JSON is the default for everything. The binary `0x03` frame is the only non-JSON
shape, and it is opt-in per connection (section 5). A client that speaks only
JSON is a complete, correct client.

All multi-byte text frames are UTF-8. The protocol never relies on key ordering
in a JSON object.

---

## 2. Connection lifecycle

1. The client opens the WebSocket. The server immediately sends `welcome` with a
   session id.
2. The client MAY send `hello` to advertise capabilities (section 5). A client
   that never sends `hello` gets the zero-feature JSON path - this is the
   backward-compatible default and is always correct.
3. The client subscribes to topics (`subscribe` / `subscribe-batch`), each
   acknowledged by `subscribed` or `subscribe-denied`.
4. Data flows as data-event frames (and, for capability-negotiated topics, as
   `0x03` binary frames).
5. On reconnect, the client MAY send `resume` with its last-seen sequence numbers
   (and epochs) to gap-fill instead of cold-starting (section 7).

Capabilities and the per-topic binary id are connection-scoped: a reconnect is a
fresh connection that re-advertises `hello` and re-learns any `wire-id`.

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
capabilities (section 5); it is optional. `lease-ok` confirms the server will
honour credit-based flow control for a client that advertised `lease`.

### 3.2 Subscription

| Frame | Dir | Shape |
|---|---|---|
| `subscribe` | c->s | `{"type":"subscribe","topic":"<string>","ref":<int>}` |
| `subscribe-batch` | c->s | `{"type":"subscribe-batch","topics":["<string>", ...],"ref":<int>}` |
| `unsubscribe` | c->s | `{"type":"unsubscribe","topic":"<string>"}` |
| `subscribed` | s->c | `{"type":"subscribed","topic":"<string>","ref":<int\|string\|null>,"epoch":<int>}` |
| `subscribe-denied` | s->c | `{"type":"subscribe-denied","topic":"<string>","ref":<int\|string\|null>,"reason":"<string>"}` |

- `ref` is a client-allocated correlation id (a per-connection incrementing
  integer in the reference client; a string is also accepted). The server echoes
  it on the matching ack and never mints its own. If a request carries
  `ref === null`, the server performs the action but sends NO ack (a
  backward-compatible silent mode).
- `subscribe-batch` caps at 256 topics per frame and emits one
  `subscribed` / `subscribe-denied` ack per topic, all sharing the one `ref`.
- `unsubscribe` carries no `ref` and is not acked; the server drops the
  subscription silently.
- `epoch` on `subscribed` is the topic's sequence-space generation (section 7).
- `reason` on `subscribe-denied` is an open-ended string. The framework emits
  `INVALID_TOPIC` and `RATE_LIMITED`; an application authorization gate may
  return any other string.

### 3.3 Data and correlation

| Frame | Dir | Shape |
|---|---|---|
| `batch` | s->c | `{"type":"batch","events":[<data-event>, ...]}` |
| `request` | s->c | `{"type":"request","ref":<int\|string>,"event":"<string>","data":<any\|null>}` |
| `reply` | c->s | `{"type":"reply","ref":<int\|string>,"data":<any\|null>}` or `{"type":"reply","ref":<int\|string>,"error":"<string>"}` |

- `batch` carries N data-event envelopes (section 4) in one frame; it is sent
  only to a client that advertised the `batch` capability. A client decodes it by
  dispatching each element as if it had arrived on its own.
- `request` is a server-initiated round-trip: the client answers with `reply`
  carrying the same `ref`. A `reply` with a string `error` field is a rejection;
  otherwise `data` is the result. The server times the pending request out
  (default 5000 ms).

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

See section 7.

### 3.6 Flow control (optional)

| Frame | Dir | Shape |
|---|---|---|
| `lease` | s->c | `{"type":"lease","count":<int>,"ttlMs":<int>}` |
| `request-n` | c->s | `{"type":"request-n","n":<int>}` |

Credit-based backpressure, active only when the client advertised the `lease`
capability. The server grants a window (`lease`); the client replenishes
(`request-n`); the server re-grants. A client that does not advertise `lease`
never sees these frames and is never flow-controlled at the protocol layer.

---

## 4. The data-event envelope

The carrier for every published event. It has no `type` field - it is identified
by the presence of `topic` + `event`:

```
{"topic":"<string>","event":"<string>","data":<any>,"seq"?:<int>,"j"?:<int>}
```

- `data` is any JSON value (or `null`).
- `seq` is the per-topic monotonic sequence number. It is **omitted entirely**
  when the publisher disabled sequencing, so a frame without `seq` is the legacy
  shape and is valid. When present it is load-bearing for resume (section 7) and
  for gap detection.
- `j` is an optional de-herd window in milliseconds: a hint that the client
  should stagger its reaction to this event by a random delay in `[0, j)` to
  avoid a thundering herd. A client that ignores `j` is correct, just un-jittered.
- A client may additionally observe a reconstructed `t` field (a server
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

### 5.1 Capability table

| Token | Binary | schema version | Gates |
|---|---|---|---|
| `batch` | no | n/a | Server may coalesce multiple events into one `batch` frame. |
| `lease` | no | n/a | Credit-based flow control (`lease` / `request-n`, section 3.6). |
| `cursor.protocol:2` | yes | 1 | Binary cursor wire, full-string keys (stateless). |
| `cursor.protocol:3` | yes | 2 | Binary cursor wire, per-connection short-id dictionary. |
| `cursor.protocol:4` | yes | 3 | Binary cursor wire, time-stamped short-id dictionary (advertise with `:3`). |
| `presence.protocol:1` | yes | 1 | Binary presence roster wire. |
| `crdt.protocol:1` | yes | 1 | Binary CRDT update wire (opaque bytes; JSON fallback when absent). |
| `smooth.protocol:1` | yes | 1 | Binary smoothed-entity command/state wire. |

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

Two mechanisms look like they might be tokens but are not, and a client must not
advertise them:

- **Resume epochs** are not negotiated. They travel as the optional
  `lastSeenEpochs` field of the `resume` frame and the `epoch` field of the
  `subscribed` ack (section 7). There is no `resume.epoch` token.
- **Cursor viewport** culling is not negotiated. The `cursor-viewport` ingress
  frame (section 8) is plain JSON, gated only by topic membership; there is no
  `cursor.viewport` token. Viewport culling is a server-side option, transparent
  to the wire.

---

## 6. The binary topic frame (`0x03`)

A single optional binary frame type carries codec-encoded payloads for a
capability-negotiated topic. It is the only non-JSON wire shape.

### 6.1 Layout

```
[0x03][schemaVersion:u8][topicId:varint][seq:varint][payload ...]
```

- `0x03` - the demux byte (one octet).
- `schemaVersion` - one unsigned byte; the fine gate within a capability token
  (section 5). A client rejects a version its codec does not implement.
- `topicId` - the per-connection numeric topic id, announced by a `wire-id` frame
  (section 3.4, 6.2) before the first `0x03` frame for that topic.
- `seq` - the per-topic monotonic sequence number (the same value the JSON
  envelope carries in `seq`). It is `0` when the publisher disabled sequencing.
- `payload` - opaque codec bytes; the framework does not inspect them. Their
  layout is the plugin codec's own contract.

### 6.2 Topic-id binding

A `0x03` frame carries a numeric `topicId`, never a topic name. The server
allocates the id lazily, on the first binary frame it sends for a topic to a
given connection, and announces it in a `wire-id` frame (section 3.4) on the same
ordered socket immediately before that first binary frame. The client records the
`id -> topic` mapping from the `wire-id` frame and uses it to route subsequent
`0x03` frames. A topic that never sends binary to a connection never allocates an
id for it. Per-connection ids start at 1; the binding resets on reconnect.

### 6.3 Primitive encodings (for codec authors)

The framework helpers a plugin codec builds on:

- **varint** - unsigned LEB128: 7 data bits per byte, least-significant byte
  first, continuation bit `0x80` set on every byte but the last. The reference
  implementation advances the value with division (not a 32-bit shift), so values
  above 2^31 round-trip exactly - a sequence number is never truncated.
- **f32** - 4-byte big-endian IEEE-754 single precision.
- **str** - a varint byte-length prefix followed by that many UTF-8 bytes (not
  null-terminated).

### 6.4 Backward compatibility

A topic is sent in `0x03` form only to a connection that advertised the matching
binary token. Any other connection (no `hello`, missing token, or unknown schema
version) receives the JSON data-event envelope for the same topic. The two forms
are interchangeable at the topic level; a deployment can serve binary and JSON
subscribers of the same topic simultaneously.

---

## 7. Resume

On reconnect a client may recover missed events instead of cold-starting. The
model is a per-topic `(offset, epoch)` pair:

- **offset** - the per-topic sequence number (`seq`) the client last observed,
  reported per topic in `resume.lastSeenSeqs`.
- **epoch** - the sequence-space generation for a topic. The server reports the
  current epoch in the `subscribed` ack; the client tracks it and reports it back
  per topic in the optional `resume.lastSeenEpochs`.

On `resume`, for each topic the server compares the client's reported epoch to
the topic's current epoch:

- **Epochs match (or the client reported none)** - the offset is meaningful, and
  the server gap-fills the missed tail from its replay buffer (when the topic is
  recoverable).
- **Epochs differ** - the topic's sequence space was reset (a restart, a buffer
  expiry, or a shard move minted a new epoch), so the client's offset belongs to a
  different counter. The server does not gap-fill; it cold-rehydrates that topic.

The server acks the whole resume with `resumed`. `lastSeenEpochs` is omitted
entirely by a client that has no epochs; the server treats an absent epoch as a
match (the single-generation legacy behaviour). Epochs are additive - a new
client against an old server, or an old client against a new server, both degrade
to offset-only resume without breaking.

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
data-event envelope (section 4) under reserved `__`-prefixed topics, or the
`0x03` binary frame when a binary token is negotiated.

| Frame | Dir | Shape |
|---|---|---|
| `cursor` | c->s | `{"type":"cursor","topic":"<string>","data":<any>}` |
| `cursor-snapshot` | c->s | `{"type":"cursor-snapshot","topic":"<string>"}` |
| `cursor-viewport` | c->s | `{"type":"cursor-viewport","topic":"<string>","rect":{"x":<num>,"y":<num>,"w":<num>,"h":<num>,"zoom":<num>}}` |
| `presence-update` | c->s | `{"type":"presence-update","topic":"<string>","fields":{ ... }}` |
| `presence-snapshot` | c->s | `{"type":"presence-snapshot","topic":"<string>"}` |
| `replay` | c->s | `{"type":"replay","topic":"<string>","since":<int>,"reqId":<id>}` |

`replay` results arrive as data-event frames on `__replay:{topic}`: event `msg`
carrying `{reqId, seq, event, data}` per recovered message, then a terminal event
`end` carrying `{reqId}` (or `{reqId, truncated:true}` when the buffer had been
trimmed past the requested point).

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

## 10. Compatibility and versioning summary

- Every optional feature is gated by a capability token; a client advertises only
  what it can decode, and the server falls back to JSON otherwise.
- New fields are additive: a peer ignores fields it does not recognise. New frame
  behaviour ships behind a new token (or a new schema version within a token),
  never by reinterpreting an existing field.
- A zero-`hello`, JSON-only client is a fully supported first-class client.
- This revision tracks the wire shipped in `svelte-adapter-uws@0.6.0-next` and is
  stabilizing toward 0.6.0; the shapes above are settled, with only additive
  changes expected before the 0.6.0 freeze.
