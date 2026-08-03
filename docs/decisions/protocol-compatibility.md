# Protocol compatibility

Status: Accepted.

## Context

The ecosystem has independently evolving clients, servers, optional binary
codecs, and higher-level realtime frames. A single protocol version would
force unrelated features into one compatibility matrix.

## Decision

`PROTOCOL.md` is the wire authority. Optional features are negotiated with
independent capability tokens. JSON is the complete compatibility carriage;
binary forms are opt-in encodings that decode to the same semantic envelope.
Unknown application frames remain available to higher layers where the core
contract permits them.

Wire changes are additive within a compatible release line unless a migration
explicitly declares otherwise. A sender must not emit a capability's frame
until the receiver advertised that capability.

## Consequences

- Old clients keep the JSON path when a server adds a binary optimization.
- A feature can evolve without pretending every unrelated frame changed.
- Conformance is stated by supported classes and capabilities, not by one
  marketing version number.
- Changes to framing, negotiation, fallback, or frozen semantics update
  [`PROTOCOL.md`](../../PROTOCOL.md), its schema/vectors, and compatibility
  tests together.

Revisit only if independent capability negotiation can no longer express a
required compatibility break.
