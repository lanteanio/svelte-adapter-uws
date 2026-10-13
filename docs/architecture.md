# Ecosystem architecture

This document is the versioned responsibility and accepted-decision contract for the
`svelte-adapter-uws` ecosystem. It answers which layer owns a behavior, which
topologies preserve it, and where a failure must be handled. The
[documentation site](https://svelte-realtime.dev/docs/architecture) provides
the long-form, cross-version tour. Package and wire facts that vary by installed
version remain authoritative in this package-shipped corpus.

## Official links and domains

**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](https://svelte-realtime.dev/) | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.

The GitHub owner is the source and issue-tracker identity, the documentation
site is the canonical product guide, and the hosted demo is the public example
application. Runtime `https://svti.me/<slug>` URLs are permanent compatibility
surfaces that redirect to reviewed pages on the documentation site; the opaque
domain never changes the package or ecosystem that owns the diagnostic.

Redirect destinations must carry the svelte-realtime family breadcrumb and
routes back to the official owner, documentation, and demo. Existing runtime
slugs are preserved indefinitely. Retiring or transferring an official domain
is an identity and security migration, not routine link maintenance.

## Context and package boundaries

| Layer | Owns | Does not own |
|---|---|---|
| Application | Authentication policy, authorization policy, business invariants, tenant boundaries, and the application's durable data | Socket transport, protocol framing, or generic distributed primitives |
| `svelte-adapter-uws` | SvelteKit build output, native HTTP/TLS and WebSocket transport, connection lifecycle, protocol framing, local pub/sub, and fan-out between this runtime's worker threads | Application authorization, application records, Redis/Postgres schemas, or RPC semantics |
| `svelte-realtime` | Live-module discovery, RPC and stream dispatch, application-facing guards, client stores, reconnect orchestration, and recovery composition | Native listener ownership, external datastore provisioning, or application business policy |
| `svelte-adapter-uws-extensions` | Optional Redis/Postgres buses, durable or distributed stores, leader election, and backend-specific lifecycle | Starting the SvelteKit server, defining the client wire protocol, or deciding who may access application data |
| Documentation site | Tutorials, how-to guides, explanations, and searchable reference | Redefining a package contract independently of the versioned source document |

The adapter is the required base. Realtime is an optional application
framework above it. Extensions are optional infrastructure beneath either
adapter-level plugins or realtime composition. An application may use the
adapter alone, adapter plus extensions, adapter plus realtime, or all three.

## Request and event flow

An HTTP request terminates at the adapter's native listener and enters the
SvelteKit server generated at build time. The application remains responsible
for route authorization and business data.

A WebSocket flow crosses these boundaries in order:

1. The adapter validates the HTTP upgrade. If the application exports an
   authentication hook, the adapter calls it before accepting the socket. With
   no hook, the default is an anonymous accepted connection, not an
   authenticated identity.
2. Identity returned by an application hook is stored as trusted server-side
   socket data. An anonymous connection carries only adapter-owned socket data.
3. The adapter decodes transport frames and applies configured transport/topic
   gates. Client-named subscriptions are open by default until the application
   enables and supplies an authorization policy.
4. If realtime is installed, it dispatches RPC or stream frames to the
   application's live module and applies the application's declared guards.
5. A publish reaches local subscribers through the adapter. In a multi-worker
   runtime, the adapter relays it through the primary to sibling workers.
6. In a multi-instance deployment, an extension-owned bus carries the event
   between processes or hosts. The receive path suppresses a second adapter
   relay where required, so one external event is not multiplied.
7. The adapter encodes the client capability's supported carriage, with JSON
   as the compatibility fallback.

No lower layer may infer business authorization from a topic, user-shaped key,
or storage record. Applications that require identity authenticate at upgrade,
authorize at the subscribe/RPC boundary, and pass only trusted identifiers into
plugins or stores. A deliberately public application may keep the anonymous,
open defaults.

## Replay and recovery flow

The adapter stamps and transports sequence metadata where the selected lane
supports it. The realtime client detects a reconnect or sequence gap and asks
for recovery. The server authorizes the requested topic before reading history.
An in-memory adapter replay buffer can cover a bounded same-process gap; an
extension-owned Redis/Postgres replay store can cover the store's configured
cross-instance or restart window. If history is absent or truncated, realtime
discards the partial recovery and runs the application loader for a fresh
snapshot. The application owns whether that loader and its business records
are durable.

Replay does not make every event exactly-once. A publish, persistence write,
and client acknowledgement cross separate failure boundaries unless the
application introduces one authoritative transaction/outbox and an idempotent
consumer.

## Publish and send outcomes

### Existing return values

`platform.publish()` keeps its boolean return. In the JavaScript adapter,
`true` means native local fan-out found subscribers or worker relay was
scheduled. A subscribed socket can still drop the message under backpressure,
and scheduling a relay does not confirm admission or delivery on another
worker. `false` means no local subscribers and no relay, or refusal by a
configured egress ceiling. The boolean cannot distinguish those cases.

`platform.send()` keeps its numeric uWS result: `0` is `BACKPRESSURE` (accepted
into the local buffer), `1` is `SUCCESS`, and `2` is `DROPPED`. The platform
also maps a send on an already closed socket to `2`. Test the numeric value,
not its truthiness. A buffered or successful local write does not prove the
remote application received or processed the event; disconnects can still
lose accepted writes.

These results are local to their implementation boundary. The native C++
follower predicts a send result from its connection mirror before the owning
transport executes the write, so that prediction can differ from the later
transport result. Wire and batch methods retain their own documented return
contracts; no result is an aggregate receipt from every recipient or worker.
The `delivered` label in the publish-outcome metric also classifies local
fan-out, not remote acknowledgements.

### Decision on asynchronous receipts

The family rejects a separate asynchronous publish/send receipt API. There is
no new method, option, receipt store, or change to legacy return values.
Transport outcomes help diagnose pressure, but do not establish whether it is
safe to retry an application operation. A publish may reach some recipients
before another drops it; retrying the publication can duplicate that prefix.
Use the adapter's bounded pressure/drop signals for operations, and an
application acknowledgement with stable event identity and idempotent
handling when processing confirmation is required.

Exact per-publication transport counts would require instrumentation below the
native broadcast boolean and a new response path from every participating
worker or engine. The existing relay forwards events without a per-operation
outcome reply. A count taken from current membership or buffered bytes cannot
reconstruct which recipients a previous write reached. A correct receipt
contract would also need to distinguish transport admission, queued writes,
drops, closed recipients, and unknown outcomes after worker loss or timeout;
cancellation could stop observation but could not undo an admitted write.

Those costs are not justified by the existing diagnostic and processing needs.
This decision preserves native broadcast and relay behavior without adding a
second acknowledgement mechanism that applications could mistake for
processing confirmation. It does not strengthen any delivery guarantee.

## Observability flow

The adapter owns transport, listener, worker, backpressure, and connection
signals defined in [`observability.md`](./observability.md). Realtime owns
RPC/stream and application-operation signals. Extensions own Redis/Postgres
operation, breaker, queue, and durable-worker signals. The application supplies
the registry/exporter and operational sink that collect those package-owned
events, then attaches deployment-specific service, tenant-safe, and trace
context. Raw user identifiers and payloads are not default metric labels.

An adapter-only snapshot cannot prove a Redis store or live handler is healthy;
an extension metric cannot prove the socket delivered a frame. Incident
correlation joins the owning signals rather than treating one package as the
whole system.

## Contract authorities

| Contract | Authority |
|---|---|
| Wire semantics and compatibility rules | [`PROTOCOL.md`](../PROTOCOL.md) |
| Core-owned machine-readable frame schema | [`protocol.schema.json`](../protocol.schema.json) |
| Conformance examples | [`test-vectors/`](../test-vectors/README.md) |
| Supported release lines and native tuple | [`docs/compatibility.v1.csv`](./compatibility.v1.csv) |
| Published adapter identities and candidate evidence | [`release-manifest.md`](./release-manifest.md) and [`releasing.md`](./releasing.md) |
| Adapter observability names and aggregation | [`observability.md`](./observability.md) |
| Tenancy: namespace, budget, and attribution ownership | [`docs/tenancy.md`](./tenancy.md) |
| Cross-package responsibility decisions | This document |
| Tutorials, how-to guides, explanations, and searchable reference | [`svelte-realtime.dev`](https://svelte-realtime.dev/) |

The core schema deliberately covers core-owned frames, not every frame a
higher layer may pass through. Realtime ships its companion schema for its RPC,
stream, and revision frames.

Wire-level rationale stays with the wire: [`PROTOCOL.md`](../PROTOCOL.md)
holds the compatibility rules, guarantees, conformance classes, and the
design-rationale appendix.

## Deployment topologies

### One worker

The zero-configuration topology keeps connections, pub/sub, counters, and
in-memory plugin state in one worker. It needs no external bus. Restarting the
process loses in-memory state; durable business state remains application-owned.

### Multiple workers in one runtime

The adapter owns worker creation, health, restart, and inter-worker relay.
Connections remain local to their owning worker, while eligible publishes fan
out through adapter IPC. Per-topic ordering that needs one global allocator
must use a single authority: choose an unordered `seq:false` lane or provide an
externally authoritative sequence with external fan-out. The runtime refuses
configurations that would silently claim a global order it cannot provide.

### Multiple processes or hosts

Each process still owns its local listener, workers, and connections. An
extensions bus or an application-provided equivalent owns cross-instance
fan-out. Distributed presence, replay, rate limits, locks, and leaders require
the matching extension primitive; enabling a bus does not make unrelated
in-memory state distributed.

## Persistence boundary

The adapter and realtime ship bounded in-memory defaults where eviction or
rejection preserves correctness, and explicitly named warn-only registries
where eviction would corrupt routing. For example, realtime's
`TOPIC_WS_COUNTS_WARN_THRESHOLD` warns at its threshold but the map may keep
growing so unsubscribe routing remains correct. A warn-only threshold is not a
memory bound. These local defaults are not durable and are not silently
promoted to distributed guarantees.

Extensions own their Redis/Postgres key layouts, tables, migrations, cleanup,
and backend failure behavior. The application owns business tables and the
decision to fail closed, degrade to local-only behavior, or stop accepting
writes when an infrastructure guarantee is unavailable. A circuit breaker is
optional and is passed to the extension that should use it. It bounds backend
failure latency; it does not prove that missed cross-instance events or writes
were reconstructed.

A store that erases by user must carry the tenant dimension or declare itself
unscoped. A topic-bearing store scopes erasure by the tenant-qualified topic its
records carry; an unscoped store relies on globally unique user IDs or on one
physical store per tenant, which the caller selects.

## Subscription-pressure signal

Subscription pressure is the per-connection mean: every settled logical
subscription on a worker divided by that worker's live connection count, or
zero with no connections. The default threshold is 50. This is not a total
membership budget: 10,000 connections with 49 subscriptions each remain below
this threshold, even though they retain 490,000 memberships. Other memory,
publication, and admission signals measure different resource constraints.

Each connection contributes its actual membership count, up to the independent
65,536-subscription admission cap. One connection at that cap alone crosses the
default threshold on a worker with up to 1,310 live connections. That effect is
intentional: membership state and publication fanout consume worker resources
even when the memberships belong to one client. Clipping each contribution at
50 would prevent the mean from reaching 50 unless every connection reached
that count, masking concentrated membership load.

The same uncapped mean reduces newly issued flow-control lease windows above
25 subscriptions per connection, including windows granted to other clients
on the worker. With `protection: 'auto'`, five consecutive active pressure
samples move a normal worker to elevated posture. The subscription signal can
therefore affect other clients' grants and admission posture; it is deliberately
a worker-wide response to shared cost.

Operators can change `websocket.pressure.subscriberRatio`, or set it to `false`
to disable this pressure signal. That setting does not disable the independent
lease-window scaling above 25. Use subscribe authorization to enforce
application-specific topic access and per-client membership limits below the
hard admission cap. These controls preserve the measured mean rather than
silently clipping one client's contribution.

## Memory-pressure signal

Every adapter in the family reports memory pressure as the distance to the
nearest memory wall: the worse of two arms, each measured with the quantity its
wall kills on.

- The engine arm compares `heapUsed` with the engine's reported allocation
  ceiling (V8: `v8.getHeapStatistics().heap_size_limit`). An engine that
  reports no ceiling contributes nothing on this arm.
- The container arm compares the resident set with the cgroup memory limit
  (v2 `memory.max`, v1 `memory.limit_in_bytes`), found at the cgroup root and
  along the process's own group path; `max` and the v1 unlimited sentinel mean
  no wall.

A known wall yields a 0..1 saturation that approaches 1 as the nearest
out-of-memory death approaches. No discoverable wall means an unavailable
measurement, not measured zero. Pressure decisions use zero in that case:
`MEMORY` remains silent, the memory contribution to `value` is zero, and the
send gate does not shrink its window for memory. Measured PSI pressure and
`resident_memory_bytes` remain independent signals.

The `heap_used_ratio` metric is absent when neither wall is available. Its
worker mirror removes an earlier sample if a cgroup-only limit becomes
unlimited and resumes reporting when a finite limit returns. External metrics
registries can support this transition with optional `gauge.remove()`, which
removes the gauge's sample. Registries without removal receive this gauge only
when a latched engine ceiling makes its availability permanent; cgroup-only
samples are omitted there to avoid retaining a stale ratio. Empty HELP/TYPE
metadata may remain registered. A registry whose removal method throws is
contained like other metric failures; its external sample may remain stale,
while the worker mirror still clears the value.

The `memoryHeapUsedRatio` option name and its 0.85 default are shared across
the family. Setting the threshold to `false` disables `MEMORY` without
disabling measurement or independent PSI thresholds. A known reading feeds
the `MEMORY` reason, which outranks every other pressure reason, the `value`
fold, the gauge and send-gate window sizing. Arena fullness
(`heapUsed/heapTotal`) is not part of the contract on any engine. This adapter
implements measurement in `src/runtime/utils/memory-wall.js`.

### OS memory notifications

For adapters that expose native memory notifications, OS warning and critical
notifications are sampling hints, not measurements of memory capacity. Both levels set the same pending hint. Multiple notifications
coalesce until the next normally scheduled pressure tick, which refreshes
cgroup membership discovery before reading the memory walls. The tick still
owns the counter window, measured PSI readings, pressure fold and posture
transition; notifications do not run an extra sample or create another timer.

The hint is consumed by that tick and carries no pressure level to decay or
clear. `memoryHeapUsedRatio: false` continues to disable only the `MEMORY`
threshold; independent PSI thresholds keep their configured behavior. Without
a discoverable wall or measured PSI, an OS notification alone cannot assert
memory saturation. This preserves the meaning of the reported measurements.
A runtime with no notifications keeps its ordinary sampling behavior.

Native listeners belong to sampler lifecycle and are detached when sampling
stops. Simulations supply notifications and source readings through their
controlled runtime environment; they never install a host notification
listener or derive a fingerprint from host pressure events.

## Failure ownership

| Failure | First owner | Required response |
|---|---|---|
| Unsupported native binary, Node ABI, OS, CPU, or libc | Adapter | Fail install/startup and select a supported native tuple |
| Upgrade identity rejected | Application policy through adapter hook | Refuse before the socket becomes trusted |
| Unauthorized topic or RPC | Application policy through adapter/realtime gate | Fail closed before subscription, handler work, or data disclosure |
| Backpressure or closed socket | Adapter transport | Report/drop/close according to the documented delivery contract; application retries only idempotent work |
| Worker crash or stalled worker | Adapter runtime | Replace or terminate according to worker policy; clients reconnect |
| Redis/Postgres unavailable | Owning extension and application | Without a configured breaker, handle the backend operation's native error/timeout; with a breaker, fail fast once it opens. In either case apply the application's declared degradation or stop policy |
| Durable schema or migration failure | Owning extension or application datastore | Stop the dependent feature and follow that owner's migration/rollback guide |
| Live-module handler failure | Realtime/application | Return the typed application error or route the operational failure to the configured sink |
| Incompatible package tuple | Release process | Refuse promotion and restore one verified tuple |

## Release coupling

The packages are independently published but not independently proven. Verify
and promote in dependency order:

1. `svelte-adapter-uws` with its exact native-addon tuple.
2. `svelte-adapter-uws-extensions` against that packed adapter.
3. `svelte-realtime` against the packed adapter and extensions pair.
4. The application and browser fixtures against the complete tuple.

Use the [compatibility manifest](./compatibility.v1.csv) for supported release
lines and the native tuple. Exact candidate Git heads, tags, packed artifacts,
digests, and registry identities belong to the release workflow and
[release manifest](./release-manifest.md). Follow the
[ordered ecosystem migration](./migrations/ecosystem-0.5-to-0.6.md). On
rollback, restore dependants before dependencies unless the whole tuple is
replaced atomically. A breaking client/server cutover follows the
[coordinated release runbook](./operations/v1/coordinated-release.md), which
owns the forward/rollback matrix and the abort criteria.

## Extra server entries

A Vite plugin can put code in front of the handler by writing a file into the
SvelteKit server output whose name starts with `__` and ends in `.js` (the
realtime layer's generated registry is one). The adapter bundles each such file
as its own entry and imports all of them at the top of the built `index.js`,
in file-name order, before the handler loads, so the order is the same on
every filesystem. They are static ES module imports: one whose top level
awaits does not hold back the next, so an entry that needs another's finished
work should import that entry itself. Each is imported by the file name Rollup
wrote for it, which differs from the entry name when the name holds a
character Rollup will not put in a file name.

## HTTP pipelining

uWS answers pipelined HTTP/1.1 requests only while each response is completed
before the next request on the connection is parsed. If a route is still awaiting
its first response bytes, parsing the next request closes the connection without
answering either request. If a large static response has already written a prefix
and is waiting for socket capacity, that close can truncate the first body and
leave the next request unanswered.

Large static responses deliberately retain one shared cache buffer and resume
with `tryEnd` rather than copying the entire unsent body into a native buffer for
every slow reader. This bounds retained memory even with many paused clients;
HTTP/1.1 pipelining does not override that memory bound. The parser closes before
JavaScript receives the later request, so the adapter cannot queue it. Clients
should send one outstanding request per connection; a client that pipelines must
detect incomplete bodies and retry eligible idempotent requests on a new
connection, including a truncated first request. node:http, and therefore
`vite dev`, queues pipelined requests instead. `test/http-pipelining-real.test.js`
pins synchronous responses, waiting routes, and the Linux large-static case;
`test/static-backpressure-real.test.js` pins bounded memory and complete delivery
for slow clients without pipelining.

The native close flag also has a narrower meaning than a request-dispatch
boundary. With uWebSockets.js 20.69, `end(body, true)` sends `Connection: close`
and ends the connection after writing, but the parser can still dispatch a
following request already buffered in that read. This includes bytes behind an
ambiguous-framing 400 response. The 400 and server hangup therefore do not prove
that buffered following bytes were never interpreted as another request. Stopping
that dispatch requires a native parser change; the adapter does not claim that
property for this runtime version.

A native cork can span multiple synchronous request callbacks in the same read.
If a later handler calls `res.close()`, it can discard corked bytes belonging to
an earlier response that the application already completed. A large earlier
response may have overflowed the cork and reached the socket, so the amount
retained by the client depends on what was flushed before the close. The adapter
does not promise preservation of an earlier completed response across that later
close; per-request cork ownership requires a native change.
