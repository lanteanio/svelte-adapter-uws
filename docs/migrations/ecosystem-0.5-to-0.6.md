# Ecosystem upgrade sequence: 0.5.x to 0.6.x

[migration index](../../MIGRATION.md) | [adapter guide](./0.5-to-0.6.md) |
[compatibility table](../../README.md#version-compatibility)

This is the permanent ordered route for upgrading the adapter, extensions, and
application framework together. Do not promote one independently just because
its own tests pass: each later package consumes public runtime and type surfaces
from the packages before it.

## Ordered package upgrade

1. **svelte-adapter-uws** - follow the local [0.5.x to 0.6.x adapter guide](./0.5-to-0.6.md), pack the candidate, and verify its runtime/type export map.
2. **svelte-adapter-uws-extensions** - install that exact adapter artifact, then follow the extensions [migration index](https://github.com/lanteanio/svelte-adapter-uws-extensions/blob/main/MIGRATION.md). Verify Redis and database integrations against the packed adapter rather than a registry fallback.
3. **svelte-realtime** - install the exact packed adapter and extensions candidates, then follow the framework [migration index](https://github.com/lanteanio/svelte-realtime/blob/main/MIGRATION.md). Run its browser, component, database, and deployment fixtures against that pair.

Promote only after the cross-repository heads gate installs all three packed
artifacts into disposable consumers and the recorded compatibility tuple agrees
with those artifacts. If a later rung fails, keep the already-published stable
tuple routed and correct the candidate forward; do not silently mix lines.

## Prerequisites and evidence at each rung

Start from one exact stable lock, a restorable application artifact, and
snapshots required by extension-owned storage. Record the Node and native-addon
versions, the selected compatibility row, and the packed filename plus digest
for every candidate. Each rung must run its own static, unit, public-export,
and migration rehearsal before the next repository consumes its tarball. A
registry range or moving dist-tag is not cross-repository evidence.

The adapter owns runtime and wire policy but no durable database schema. The
extensions repository owns its Redis/database migrations; the realtime
repository owns application-facing edits and browser/component compatibility.
Do not infer storage compatibility from an adapter-only green run.

## Rollback order

Before promotion, prove that the stable tuple can still be installed from its
recorded lock and artifacts. After a failed deployed candidate, stop writes
that use any new storage format, restore the owning backend as its guide
requires, then restore dependants before dependencies: realtime application,
extensions, adapter and its matching native addon. A single atomic deployment
may restore the complete tuple together. Restart workers and reconnect clients
at the boundary; do not leave one 0.6 package running against a 0.5 sibling.

## Permanent routes

- This page remains the ecosystem route for the 0.5.x to 0.6.x transition.
- Each repository's `MIGRATION.md` remains an index; versioned pages are added,
  never overwritten for a new transition.
- Links between repository indexes are canonical GitHub routes so packaged
  Markdown and source checkouts resolve to the same preserved documents.
