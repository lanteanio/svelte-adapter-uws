# Test vectors - the Lantean protocol, revision 1

Machine-checkable companions to `../PROTOCOL.md`. They are validated in CI
(`../test/protocol-schema.test.js`) against both `../protocol.schema.json` and
frames captured from the reference server, so the specification cannot drift
from the shipped wire.

- **`frames.json`** - one canonical example per control frame plus the
  data-event envelope (`frames`), and a set of deliberately invalid frames the
  schema must reject (`invalid`). Each valid entry names the `$defs` definition
  in `../protocol.schema.json` it validates against.
- **`binary.json`** - a byte-exact `0x03` binary topic frame with its decoded
  fields. Its `topicId` is above 2^32 (a shared-cohort id, PROTOCOL.md section
  6.2) to catch a decoder that uses 32-bit varint shifts.

A third-party implementer can validate captured frames against
`../protocol.schema.json` with any JSON Schema validator, and replay these
vectors through an encoder/decoder to check conformance.
