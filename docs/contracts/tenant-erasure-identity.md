# Tenant-qualified erasure identity

This is the implementation contract for the extensions stores and realtime
in-memory dead-letter store. The new qualified options below are not available
until those packages implement and publish them. Existing options keep their
legacy behavior during migration.

## Identity and public options

```ts
interface ForgetIdentity {
  tenantId: string | null;
  userId: string;
}
```

`tenantId` is server-trusted and uses realtime's existing tenant validation: 1 to 64
ASCII letters, digits, `_` or `-`, or exactly `null`. `userId` is a nonempty
string, preserved exactly without coercion, trimming or case folding. An absent
identity is `null` or `undefined`; `{ tenantId: null, userId }` is an attributable
identity in the untenanted scope. It never means all tenants. Missing
`tenantId` in an identity object is invalid.

Add optional `forgetIdentity` extractors to Redis sessions (`data`), Postgres
tasks (`input, name`) and in-memory dead letters (`{ topic, event, data }`),
returning `ForgetIdentity | null | undefined`. Each is mutually exclusive with
its existing `forgetUserId` option; configuring both throws at construction.
Extract once before accepting a write, validate and retain the resulting tuple
with that record. A thrown or malformed qualified extractor rejects the write;
it must not silently create an unattributed record. An explicit absent identity
allows an unattributed record whose erasure coverage is documented separately.

Registry qualified mode uses `identifyIdentity(ws)` instead of `identify(ws)`;
the two options are mutually exclusive. Its `lookup`, `request`, `send` and
`sendCoalesced` targets accept the same identity object in qualified mode.
Bare-string targets are rejected there. In legacy mode those methods continue
to take strings. Registry attribute cohorts may span identities, but every
member, owner lookup and dispatch retains the full tuple. An attribute named
`tenantId` is not an identity substitute or an authorization boundary.
Independent app-session routing keeps opaque globally unique session IDs;
implementations must not infer their tenant from a user ID or a routing string.

The existing erasure seam stays `purgeUser(tenantId, userId, cascade?)`. A
qualified store converts those two arguments to the exact tuple once; direct
calls and `createForgetStore`/`live.forget` composition use identical validation
and matching. Topic-bearing stores retain their existing tenant-qualified topic
scope. In-memory dead-letter records and their in-flight purge tombstones use
the same tuple, so purging tenant A cannot suppress tenant B's late capture.

## Storage and transport

Use `JSON.stringify([tenantId, userId])` as the canonical logical tuple encoding;
encode its UTF-8 bytes as unpadded base64url when embedded in a Redis key. This
keeps null distinct from strings and avoids delimiter collisions. Qualified
registry keys and session owner indexes use new versioned namespaces, such as
`identity:v1:conns:<tuple>` and `identity:v1:byuser:<tuple>`, under the existing
configured prefix. Qualified session record metadata stores the tuple beside
the payload, and replacement removes the previous owner's index association.
Opaque session-token lookup remains unchanged; reserve the new internal key
prefix against token collisions before enabling qualified writes.

Registry event and push envelopes use a new protocol version and carry
`identity: { tenantId, userId }` on open, close, forget and user-targeted traffic.
Use distinct versioned channels so legacy subscribers cannot interpret a
qualified event as a bare-user event. Bootstrap scans, ownership replacement,
TTL refresh, secondary indexes and forget relays all use the same version.
Never reconstruct a qualified identity by splitting a legacy raw user ID.

Postgres task rows store explicit identity version, nullable `tenant_id` and
`user_id`, with an index on qualified identity. Version distinguishes a
qualified null tenant from an old unqualified row. Equality uses null-safe
matching. New writes, retries, recovery and cleanup preserve the stamp. The
extensions migration ledger owns schema creation and upgrade; do not infer
migration completion from a column merely existing.

A qualified write cannot report success while its erasure index is missing or
belongs to another identity. Store owners must provide atomic writes where the
backend permits, or a recoverable write/index protocol with authoritative scan
repair and explicit incomplete outcomes. Redis Cluster slot constraints are a
backend implementation concern, not permission to silently keep the current
best-effort index behavior. Erasure removes matching records, indexes and local
replicas, and fences in-flight pre-erasure work from resurrecting them. The
application must stop new authorized writes for a deleted identity; erasure is
not a permanent authentication ban.

## Compatibility and migration

Legacy `forgetUserId` and registry `identify` remain explicitly unscoped. Their
bare keys and events keep the existing globally unique user-ID or physically
per-tenant-prefix deployment contract. A nonnull purge argument does not add a
tenant dimension to that legacy store. The caller must select the correct
isolated prefix/store instance; combining tenants with overlapping user IDs in
one legacy store remains unsupported.

Qualified operations never fall back to legacy keys, erase every matching bare
user ID, or guess a tenant from a topic-less payload. Deploy the new schema and
readers first, drain incompatible registry peers, then enable qualified writers
and channels. Backfill durable rows and indexes only from authoritative
application ownership data. Unknown rows remain marked legacy/unattributed;
do not relabel them as the null tenant. For ephemeral registries, reconnect or
re-register authenticated connections rather than guessing ownership.

Maintain an explicit coverage inventory through migration. A successful
qualified erasure receipt requires every relevant store and pre-migration row
to be covered, independently removed, or verified absent. Legacy/unattributed
residue and failed index reconciliation produce an incomplete erasure outcome,
not a zero-row success. Preserve committed per-store counts on partial failure
and retry the same identity. Old unscoped deployments can continue making their
existing scoped-by-deployment claims; they cannot claim qualified coverage.

## Required implementation evidence

Exercise equal user IDs in two tenants and the null tenant; delimiter-like and
Unicode user IDs; invalid/missing tenant and throwing extractors; identity
replacement; direct and composed purge parity; cross-instance forget and
bootstrap; stale close ownership; in-flight capture/write races; interrupted
index repair; and legacy-to-qualified rollout with unknown historical rows.
Tests must prove both removal of the target and retention of every other
identity, including when no target row exists. Package owners publish the new
types and migration instructions before consumers enable qualified mode.
