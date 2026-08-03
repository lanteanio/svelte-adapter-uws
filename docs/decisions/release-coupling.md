# Release coupling

Status: Accepted.

## Context

The packages publish separately but consume one another's runtime, type, wire,
and storage surfaces. A green repository in isolation does not prove that a
mixed tuple works.

## Decision

Verification and promotion follow dependency order: adapter and native addon,
extensions, realtime, then application/browser fixtures. Each later rung tests
the exact packed artifacts from the earlier rungs. The compatibility manifest
records supported package release lines and the adapter/native tuple. Exact
candidate Git heads, tags, packed filenames/digests, and published registry
identities are owned by [`releasing.md`](../releasing.md) and the
[release manifest](../release-manifest.md); moving tags or broad registry
ranges are not release evidence.

Rollback restores dependants before dependencies unless the complete tuple is
replaced atomically. Storage-format rollback first stops incompatible writes
and follows the owning migration guide.

Before a breaking client/server cutover, every rollback candidate must already
support the realtime inclusive protocol range. Expansion uses notify-only
observation; cutover uses typed rejection for missing, below-minimum and
above-current clients. Durable alarm resolver ids are staged before any RPC
path rename, and the old release remains deployable until every pre-id row has
fired, been cancelled, or been explicitly drained. The packaged
[coordinated release runbook](../operations/v1/coordinated-release.md) owns the
executable forward/rollback matrix and abort criteria.

## Consequences

- A package may be independently published only after the full candidate tuple
  has been tested.
- Promotion stops at the first failed downstream rung.
- Operators keep one last-known-good lock and artifact set for rollback.
- A rollback baseline predating range enforcement cannot contain newer cached
  clients and is not eligible for a breaking cutover.
- Release notes and migration routes describe cross-package prerequisites
  instead of implying isolated compatibility.

The executable order is documented in the
[ecosystem migration guide](../migrations/ecosystem-0.5-to-0.6.md).

Revisit when package boundaries no longer create runtime or release
dependencies.
