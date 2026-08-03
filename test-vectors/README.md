# Test vectors - the Lantean protocol, revision 1

[README](../README.md) | [wire protocol](../PROTOCOL.md) |
[conformance index](../docs/protocol-conformance.md) |
[protocol schema](../protocol.schema.json) |
[release history](../CHANGELOG.md)

Machine-checkable companions to the [wire protocol](../PROTOCOL.md). They are
validated in CI by the [repository protocol contract test](https://github.com/lanteanio/svelte-adapter-uws/blob/main/test/protocol-schema.test.js)
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
  declarations and a byte-exact three-record transcript (welcome, hello,
  binary `0x03`). Its fragment sizes split prefixes and bodies independently
  of message boundaries, and its invalid prefixes pin zero, non-canonical, and
  over-limit rejection.

A third-party implementer can validate captured frames against the
[protocol schema](../protocol.schema.json) with any JSON Schema validator, and replay these
vectors through an encoder/decoder to check conformance.

Return to the [conformance index](../docs/protocol-conformance.md) to choose a
claim class, find the minimal client and reference surfaces, and run the
executable proof. These vectors are examples and rejection fixtures; the
[wire protocol](../PROTOCOL.md) remains normative.
