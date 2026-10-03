# Test vectors - the Lantean protocol, revision 1

[README](../README.md) | [wire protocol](../PROTOCOL.md) |
[conformance index](../docs/protocol-conformance.md) |
[protocol schema](../protocol.schema.json) |
[release history](../CHANGELOG.md)

Machine-checkable companions to the [wire protocol](../PROTOCOL.md). They are
validated in CI by the [repository protocol contract test](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/protocol-schema.test.js)
against both the [protocol schema](../protocol.schema.json) and
frames captured from the reference server, so the specification cannot drift
from the shipped wire.

- **`frames.json`** - one canonical example per control frame plus the
  data-event envelope (`frames`), and a set of deliberately invalid frames the
  schema must reject (`invalid`). Each valid entry names the `$defs` definition
  in the [protocol schema](../protocol.schema.json) it validates against.
- **`binary.json`** - a byte-exact `0x03` binary topic frame with its decoded
  fields. Its `topicId` is above 2^32 (a shared-cohort id, PROTOCOL.md section
  6.2) to catch a decoder that uses 32-bit varint shifts.
- **`webtransport-stream.json`** - the section-15 reliable-stream CONNECT
  declarations and a byte-exact eight-record transcript: welcome, hello,
  binary `0x03`, an ambiguous pair, an empty text message, and a draining
  server's `reconnect` advisory followed by its close record. Each record
  carries the one-byte text, binary, or close `kind` between the length prefix
  and the message bytes (section 15.1). Records four and five are the SAME
  valid-UTF-8 JSON bytes carried once as a text data-event and once as an
  opaque binary application payload - a decoder that ignores `kind` reproduces
  the payloads but cannot tell those two records apart, which is exactly what
  the byte exists to prevent. The empty record shows that a zero length is a
  complete prefix the `kind` byte still follows, and the close record carries
  the WebSocket close payload as the last record before FIN (section 15.4).
  Its fragment sizes split prefixes, kind bytes, bodies, and the close code
  independently of message boundaries, and a decoder delivers each record in
  the read that completes it. `validRecords` holds single-record streams for
  edges the transcript cannot: an empty binary message, an empty close, a
  close with no reason, the codes at each edge of the sendable close-code
  ranges, and a reason of exactly 123 bytes in multi-byte characters. Every
  invalid entry names the `check` that refuses it, and `checks` says what each
  one means: the invalid prefixes pin non-canonical, over-limit, and
  past-the-5-byte-cap rejection, and each of the `invalidRecords` is a whole
  stream ending in FIN, refused for an unregistered `kind`, an invalid-UTF-8
  text record, a close payload no WebSocket endpoint could send (including the
  code just outside each range edge), bytes after a close record, a record FIN
  cut short, or a length above the assumed receiver limit. The entries with
  bytes after a close record are marked `assumesReceiverReadsOn`: a receiver
  may instead stop reading once it has the close, and either way the close
  stands, with the code `reportsCode` gives. Record size is the receiver's own
  (section 15.1), so the file states the receiver it assumes as
  `assumedReceiverMessageBytes` and marks the five entries whose verdict
  depends on it with
  `dependsOnReceiverLimit`: a receiver configured higher accepts a length the
  file refuses, one at the 125-byte floor refuses a long close reason for its
  length first, and every such behaviour is conformant.

A third-party implementer can validate captured frames against the
[protocol schema](../protocol.schema.json) with any JSON Schema validator, and replay these
vectors through an encoder/decoder to check conformance.

Return to the [conformance index](../docs/protocol-conformance.md) to choose a
claim class, find the minimal client and reference surfaces, and run the
executable proof. These vectors are examples and rejection fixtures; the
[wire protocol](../PROTOCOL.md) remains normative.
