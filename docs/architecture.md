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
| Cross-package responsibility decisions | This document and [the decision index](./decisions/README.md) |
| Tutorials, how-to guides, explanations, and searchable reference | [`svelte-realtime.dev`](https://svelte-realtime.dev/) |

The core schema deliberately covers core-owned frames, not every frame a
higher layer may pass through. Realtime ships its companion schema for its RPC,
stream, and revision frames.

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
growing so unsubscribe routing remains correct. These local defaults are not
durable and are not silently promoted to distributed guarantees.

Extensions own their Redis/Postgres key layouts, tables, migrations, cleanup,
and backend failure behavior. The application owns business tables and the
decision to fail closed, degrade to local-only behavior, or stop accepting
writes when an infrastructure guarantee is unavailable. A circuit breaker
bounds backend failure latency; it does not prove that missed cross-instance
events or writes were reconstructed.

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
replaced atomically.

## Accepted decisions

The decision index is [`docs/decisions/README.md`](./decisions/README.md):

- [Protocol compatibility](./decisions/protocol-compatibility.md)
- [Native runtime baseline](./decisions/native-runtime-baseline.md)
- [Cluster fan-out boundaries](./decisions/cluster-fanout-boundaries.md)
- [Persistence boundary](./decisions/persistence-boundary.md)
- [Release coupling](./decisions/release-coupling.md)
- [Documentation canonicality](./decisions/documentation-canonicality.md)

Wire-level rationale and conformance remain in [`PROTOCOL.md`](../PROTOCOL.md),
especially its compatibility rules, guarantees, conformance classes, and
design-rationale appendix.
