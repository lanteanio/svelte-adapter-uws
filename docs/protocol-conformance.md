# Lantean protocol conformance index

[README](../README.md) | [wire protocol](../PROTOCOL.md) |
[protocol schema](../protocol.schema.json) | [test vectors](../test-vectors/README.md) |
[minimal Core client](../examples/minimal-client.mjs) |
[release history](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/CHANGELOG.md)

This is the traversal map for implementing or auditing the Lantean wire. It
does not define another protocol surface: normative prose remains in the
[wire protocol](../PROTOCOL.md), while the schema, vectors, example, reference
implementation, and CI proofs below make that prose executable.

## Choose the artifact for the task

| Task | Start here | What it establishes |
| --- | --- | --- |
| Decide what a peer MUST send or accept | [Wire protocol](../PROTOCOL.md) | The normative framing, lifecycle, capability, failure, and conformance-class contract. |
| Validate a JSON frame | [Protocol schema](../protocol.schema.json) | The machine-readable control-frame and data-event union plus frozen constants. |
| Replay known-good and known-bad bytes | [Test-vector index](../test-vectors/README.md) | Canonical JSON, binary, relay, and WebTransport reliable-stream transcripts. |
| Bootstrap a third-party implementation | [Minimal Core client](../examples/minimal-client.mjs) | A dependency-free JSON-only implementation of the Core class. It is an example, not a replacement for the normative protocol. |
| Compare client behavior | [Reference client](../src/client.js) | The shipped browser implementation, including negotiation, reconnect, resume, and binary dispatch. |
| Compare server behavior | [Wire primitives](../src/runtime/wire.js) and [runtime handler](../src/runtime/handler.js) | The shipped production encoder, decoder, and connection lifecycle. |
| Compare non-production behavior | [Vite surface](../src/vite.js) and [testing surface](../src/testing.js) | Development and in-process implementations that are required to speak the same wire. |
| Inspect the executable proof | [Protocol/schema test](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/protocol-schema.test.js), [minimal-client test](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/minimal-client.test.js), and [relay oracle](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/relay-oracle.test.js) | Schema/vector validation, real-server Core behavior, and byte-exact relay output. These repository-only tests are intentionally not part of the npm package. |
| Inspect when the proof runs | [CI workflow](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/.github/workflows/test.yml) | The hosted environment and blocking suite invocation. |

Relative links above name files that ship in the npm package. Repository-only
proofs use stable source links so the packaged copy of this index never points
at a file that is absent from the tarball.

## Conformance workflow

1. Choose the highest cumulative class you intend to claim from
   [protocol section 13](../PROTOCOL.md#13-conformance-classes): Core, Batch,
   Flow-controlled, or Binary. Capability tokens remain independently
   negotiable; a class claim does not authorize an unadvertised token.
2. Implement the normative sections named by that class. JSON fallback remains
   required even for a Binary implementation.
3. Validate captured JSON frames against
   [the schema](../protocol.schema.json), then replay every applicable valid and
   invalid corpus listed in the [vector index](../test-vectors/README.md).
4. Exercise reconnect, resume, refusal, malformed input, and unknown-version
   behavior against an independent server or client. Matching only successful
   example frames is not a conformance claim.
5. Record the protocol revision, claimed class, transport binding, capability
   tokens, Node/runtime versions, and exact vector revision with the result.

The WebTransport datagram lane is not Core. A datagram-only implementation
claims only [section 14](../PROTOCOL.md#14-the-webtransport-binding-the-game-lane-over-quic-datagrams).
A reliable-stream implementation carries the same inner classes and also
satisfies [section 15](../PROTOCOL.md#15-the-webtransport-reliable-stream-binding).

## Run the repository proofs

From a clean repository checkout with the pinned Node release and dependencies
installed:

```bash
npm run doctor -- --require-uws
npm exec vitest -- run test/protocol-schema.test.js test/minimal-client.test.js test/relay-oracle.test.js
```

The doctor command matters: `uWebSockets.js` is optional at install time, and a
missing native addon otherwise turns real-runtime suites into skips outside CI.
The focused command writes no conformance certificate or golden replacement;
its stdout is evidence for the exact checkout only. Run the normal static gate
and full suite before proposing a protocol change:

```bash
npm run check
npm test
```

## Interpretation limits

- The schema proves structural validity, not legal sequencing, authorization,
  delivery, or application-payload meaning.
- Vectors prove exact named cases, not every state-machine transition. Invalid
  vectors are as important as valid examples.
- The minimal client proves Core behavior only. It deliberately does not claim
  Batch, Flow-controlled, Binary, or either WebTransport binding.
- Source agreement is supporting evidence, never permission to contradict a
  normative MUST or silently edit a frozen shape.
- Passing against one checkout establishes that checkout and environment. A
  reusable result must identify revisions and must not hide skipped native
  tests.

When any companion disagrees with the normative document, treat the result as
a protocol defect: do not choose whichever artifact is most convenient.
