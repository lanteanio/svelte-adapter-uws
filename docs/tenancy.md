# Tenancy: namespace, budget, and attribution ownership

This page is the cross-surface contract for fair-share isolation: which layer
owns each abuse-relevant surface's NAMESPACE, which owns its BUDGET, and where
each surface's attribution comes from. It is a responsibility contract in the
sense of [architecture.md](./architecture.md), not a runbook.

Two terms, defined once:

- **Namespace scoping** keeps tenants' accounting state APART: two tenants
  never share a bucket, a counter, or an admin operation's blast radius. A
  namespace-scoped `reset`/`ban`/`clear` touches one tenant and no other.
  Namespace scoping alone does not bound a tenant: a tenant with many
  principals gets many buckets.
- **Budget scoping** decides what one allowance COVERS: whether each principal
  (an IP, a connection, a user) draws from its own allowance, or all of a
  tenant's principals draw from one shared allowance. A per-tenant budget is
  what makes one tenant unable to starve another by adding principals.

The two compose and neither implies the other. A surface can namespace without
budgeting (tenant-scoped per-IP buckets), and a budget is only meaningful
inside a namespace (a shared allowance must belong to exactly one tenant).

## Where attribution comes from

- **The adapter hook.** The WebSocket handler module may export
  `attribution(user)` - `user` is `ws.getUserData()`, the identity the
  `upgrade` hook established server-side. The runtime resolves it once per
  connection at open, before the `open` hook, validates every present field
  (`tenantId`, `principalId`, `entitlement`; each `[a-zA-Z0-9_-]`, at most 64
  chars), freezes the result, and refuses the connection (close 1008,
  [`ADAPTER-ERR-ATTRIBUTION`](./errors.md#adapter-err-attribution)) on a
  resolver failure. Read it back with `attribution(ws)` from
  `svelte-adapter-uws/connection`. It is never derived from the wire.
- **realtime's `ctx.tenantId`.** `svelte-realtime`'s `realtime({ tenant })`
  resolver applies the same id rule over the same `ws.getUserData()` identity
  and carries the result on every live-module `ctx`. Per-tenant configuration
  declared with `live.tenant(id, config)` lives in realtime's tenant-config
  registry; budget-owning surfaces consume that registry rather than declaring
  a second per-tenant config carrier.
- **The app.** Both resolvers only derive from what the app's `upgrade` /
  authentication path stored. Identity and authorization policy stay
  application-owned; attribution is accounting identity, not access control.

## Per-surface ownership

| Surface | Namespace owner | Budget owner | Attribution source |
|---|---|---|---|
| Upgrade admission (`websocket.upgradeAdmission`, upgrade rate limits) | None - keys are transport-level (IP, worker) | Adapter: per-worker and per-address handshake ceilings | None. Runs before a connection exists, so no attribution has been resolved yet; this surface protects the doorway for every tenant at once |
| Message admission (`websocket.messageAdmission`) | None - scopes are `connection` and `global` (worker) | Adapter: per-connection and per-worker frame rates, byte rates (`perConnectionBytesRate`, `globalBytesRate`), concurrency, queue | Not consumed. The connection itself is the principal; per-tenant budgets belong to the surfaces below |
| Ratelimit plugin (`plugins/ratelimit`) | Plugin: tenant-scoped bucket keys and tenant-scoped `reset`/`ban`/`unban`/`clear` | Plugin: `budget: 'principal'` (per resolved key, default) or `budget: 'tenant'` (one shared allowance per tenant) | Adapter hook (`tenantId`, read from the slot) when the plugin's `tenant` option is unset; an explicit `tenant` resolver overrides |
| Extensions Redis limiters (`svelte-adapter-uws-extensions` `redis/ratelimit`) | Extension: NUL-delimited tenant-scoped Redis keys and tenant-scoped admin ops | Extension: per resolved key within the tenant namespace | The app's `tenant` resolver; an app on this adapter passes one that reads `attribution(ws)` so both limiters attribute identically |
| realtime per-ctx rate limits and guards | realtime: `@t/<id>/` topic namespace, `\0`-delimited keys, `ctx.tenantId` scoping | realtime: per-ctx allowances; per-tenant budget values declared via `live.tenant(id, config)` | realtime's `realtime({ tenant })` resolver over the same server-trusted userData |
| Pressure and backpressure (`websocket.pressure`, `maxBackpressure`) | None - transport-wide worker signals | Adapter: per-connection outbound bounds and worker pressure posture | None. Backpressure is per-socket transport fairness; a tenant-fair send policy is an application decision on top of the signals |

## The dividing line

The adapter owns transport-level budgets (doorway, worker, connection) and the
one trusted attribution contract every in-process consumer reads. Tenant-aware
NAMESPACES live in the layer that owns the keys (the bundled plugin, the Redis
extension, realtime). Tenant-shared BUDGETS live where the bucket is: the
bundled plugin's `budget: 'tenant'` in-process, the extension's stores across
instances. No lower layer infers authorization from an attribution id, and no
surface reads tenant identity from the wire.
