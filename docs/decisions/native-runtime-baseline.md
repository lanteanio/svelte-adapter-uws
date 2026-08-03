# Native runtime baseline

Status: Accepted.

## Context

The production listener is uWebSockets.js, a native addon distributed as
prebuilt binaries. Treating it like a portable JavaScript dependency defers
ABI, OS, CPU, or libc failures until deployment.

## Decision

The adapter supports Node 22 or newer only where the exact pinned
uWebSockets.js release ships a matching binary. The accepted native ref,
integrity, source commit, and file hashes are versioned in
`scripts/uws-accepted.json`. Linux requires the documented glibc baseline;
musl has no production fallback. Installation verifies the native import and
fails at the prerequisite boundary when the tuple is unsupported.

The `ws` package is an optional development transport for Vite parity. It is
not a production substitute and cannot be used as evidence that the native
server will start.

## Consequences

- Releases couple the adapter version to one audited native-addon tuple.
- Unsupported clean installs fail early instead of producing a build that
  cannot start.
- A skipped lifecycle check is an explicitly unverified, client-only install.
- Platform support changes update the compatibility manifest, install docs,
  native audit manifest, and clean-install gates together.

Revisit when the production transport has a separately verified portable
implementation with the same contract and performance posture.
