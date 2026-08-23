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
| Publish egress (`websocket.egress`) | None - the adapter parses no topic namespace; the tenant key comes from attribution | Adapter: the LOCAL egress budget - every publish-family fan-out charged once per logical publish, per-window `topic` and `tenant` ceilings enforced pre-hoc on this instance | The sender's adapter-hook `tenantId` on the client-relay game lane; the handler's `egressTenantOf(topic)` export (a pure `topic -> tenantId \| null` resolver - realtime's `@t/` convention plugs in here) for server-side publishes. The ledger keys tenants only: principal budgets are the inbound limiters' job, egress budgets are tenant fair-share |
| Pressure and backpressure (`websocket.pressure`, `maxBackpressure`) | None - transport-wide worker signals | Adapter: per-connection outbound bounds and worker pressure posture | None. Backpressure is per-socket transport fairness; a tenant-fair send policy is an application decision on top of the signals |

## The egress charge law

The adapter owns the LOCAL half of the outbound budget, and these are the
semantics the extensions bus must adopt verbatim for cross-instance
multiplication - the charge and the ceiling mean the same thing on every
instance or the cluster budget means nothing:

- **Charge** = serialized bytes times recipients, at the ORIGIN instance, once
  per logical publish (a batch of N events is N logical publishes under one
  admission decision). Bytes are the wire form the lane sends per recipient -
  UTF-8 of the JSON envelope, or the encoded `0x03` frame where the lane
  produces one for capability-advertising subscribers - pre-compression.
  Recipients are counted from each surface's own subscriber registry: the
  production runtime reads its tracked logical membership, `createTestServer`
  reads the native subscriber count, and the dev plugin walks the subscription
  map it maintains itself, counting only sockets in an open ready state. The
  three agree except for a socket subscribed behind the tracked path (a plugin
  calling `ws.subscribe` directly), which the harness counts and production
  does not.
  Recipients are the origin instance's local subscribers at the instant of the
  publish, an excluded socket that holds the topic deducted. An implementation
  may charge a cheaper approximation of the envelope's length while no BYTES
  ceiling is armed (the adapter charges the character length there, which is
  exact for ASCII), but every quantity a bytes ceiling decides on is the
  encoded length.
- **Ceilings** are per rotation window (`windowMs`, default 1000 ms) and per
  scope: `topic` and `tenant`, each with `messages`, `bytes`, and `deliveries`
  dimensions, `0` disabling a dimension deliberately.
- **Refusal is pre-hoc**: the decision lands before the first frame of a
  logical publish - nothing is sequence-stamped, serialized, delivered, or
  relayed for a refused publish, and there is no mid-walk shedding. The
  `messages` and `deliveries` ceilings refuse the publish that would cross
  them; the `bytes` ceiling refuses once the window's charge has reached it
  (byte weight exists only after serialization, which must not precede
  admission), overshooting by at most one admitted call - which for a batch
  is the whole batch, since a batch is one decision.
- **A batch frame is atomic**: a batching primitive that builds one wire frame
  is admitted once against the pooled weight of every topic it spans and every
  tenant that owns them, then delivered whole or refused whole. A tenant that
  owns several of the batch's topics decides once on their sum - deciding per
  topic against a window nothing has charged yet would let one batch pass
  repeatedly against a single allowance. A convenience wrapper that simply
  loops over independent publish calls is not covered by this and admits each
  call separately; in the adapter that is `platform.batch()`.
- **Relay is exempt**: a frame received from a sibling instance was charged
  once at its origin and is never re-charged or refused on receipt. The bus
  multiplying a publish across instances owns the cross-instance sum; each
  instance owns only its own egress.
- **The two tenant sources cover different lanes**, so which one an app needs
  follows from how it publishes. The client-relay game lane charges the
  sender's own attribution and needs no resolver. Every server-side
  publish-family call takes its tenant from `egressTenantOf(topic)`, so a
  deployment that omits that export charges those publishes UNATTRIBUTED: the
  `topic` ceilings and the worker figures still apply to them, and the `tenant`
  ceilings bound only what the game lane sends. Configuring `tenant` ceilings
  is therefore not by itself enough to bound a server-side broadcast.

## What the ledger holds

Ceilings are tracked per key, and the adapter bounds each scope's ledger to
4096 keys unless `egress.maxKeys` sizes it. The bound is a capacity limit on
the number of distinct keys, not on what any key may spend. Keys arriving as
the ledger approaches that bound reclaim windows that have already lapsed, a
little at a time, so the lapsed ones are gone before it is full - what the
bound counts is therefore the keys live at once, not every key the instance has
published to, and a population that fits inside the bound keeps every ceiling
however close to the bound that population sits.

`maxKeys` takes a safe integer between `1024` and `2^24` - the ceiling is V8's
own Map limit, past which an insert throws rather than seats - and is rounded
UP to the next power of two before it is applied. That rounding is the ledger's
memory law, not a convenience: V8 sizes a Map's backing table to a power of two
regardless, so the rounded bound holds no fewer keys in the same memory
the requested value would have occupied. Memory is paid only for keys actually
seated - about 56 bytes per entry under steady at-bound churn - so an oversized
cap over a small live population costs nothing, and the sizing rule is simply
the keys LIVE inside one window: when `egress_window_evicted_total{scope}`
shows sustained churn, raise `maxKeys` past that cardinality (or coarsen the
key space; both end the churn). There is deliberately no disable value, because
an unbounded ledger turns topic cardinality into unbounded memory.

Under the bound, every key is held to its ceiling. Over it - more topics (or
tenants) live inside a single window than the ledger holds - the ledger has to
give up a window to seat a new one, and the key it gives up stops being held to
its ceiling until its next window. It gives up the key that has spent the least
of its allowance across the current window and the one before, chosen from a
BOUNDED SAMPLE (`egress.evictionSample`, default 8) rather than from the whole
ledger: the sample is what keeps the choice O(1) on a publish path, and the
cost of that is that a group of keys which became busy together can lose some
members while quieter keys survive elsewhere. A deployment that raises
`maxKeys` by an order of magnitude may widen the sample to match - it is what
finds an expired window before a live one is taken - and any width stays
bounded, because a pass wraps the ledger at most once per eviction. Every
eviction that costs enforcement increments `egress_window_evicted_total{scope}`.

The consequence for a cross-instance implementation mirroring this contract:
report the same signal, and rank victims by spent allowance rather than by
insertion order or window age. Ranking by either of those feeds the
longest-lived publishers to whatever is churning, which is the opposite of what
a budget is for. Sampling is an implementation freedom - bound it however the
store allows - but say so, because "least spent" over a sample and "least
spent" over the whole ledger are different promises.

## Where a refusal shows up

Three places, and which ones exist depends on the surface:

- `egress_refused_total{scope}` on a configured metrics registry, beside
  `egress_window_evicted_total{scope}` for windows the ledger had to drop at
  its key cap. Refusals falling while evictions rise is enforcement lapsing,
  not load easing.
- The `platform.pressure.egress` slice - deliveries, bytes and refusals per
  sample window, always on, ceilings configured or not. `pressure.topPublishers`
  and `onPublishRate` entries additively carry `deliveriesPerSec`.
- A throttled `ADAPTER-ERR-EGRESS-REFUSED` operational event, which is
  `publishBatched`'s only refusal report because it returns nothing.

All three surfaces run one account, so the ceilings behave identically:
`createTestServer({ egress })` drives them directly, and the `uws()` dev plugin
enforces the same refusals live. Dev is the exception on REPORTING only - it
registers no metrics and its pressure egress figures are zeros, so on that
surface the operational event is the whole report.

## The dividing line

The adapter owns transport-level budgets (doorway, worker, connection, and the
local publish-egress ledger above) and the one trusted attribution contract
every in-process consumer reads. Tenant-aware
NAMESPACES live in the layer that owns the keys (the bundled plugin, the Redis
extension, realtime). Tenant-shared BUDGETS live where the bucket is: the
bundled plugin's `budget: 'tenant'` in-process, the extension's stores across
instances. No lower layer infers authorization from an attribution id, and no
surface reads tenant identity from the wire.
