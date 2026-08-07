# Error reference

Search this page with the exact stable ID, code, event, or beginning of the message you saw.
Every failure emitted as a diagnostic event is indexed below with its cause, what it means
for traffic, whether anything recovers on its own, and what to do next: 33 entries against
the 36 distinct diagnostic events emitted from the scanned sources. The rest are
informational, listed under [coverage](#emitted-diagnostic-event-coverage) with no recovery guidance
because there is nothing to recover from. A new failure event cannot be added to those sources
without an entry here: the generator fails the build until one exists. Plain console output that
is not a diagnostic event is outside this index.

This is the adapter-owned part of the ecosystem index. The sibling packages
generate and ship their own runtime-owned references on the same release channel:

- [svelte-realtime errors](https://github.com/lanteanio/svelte-realtime/blob/dev/docs/errors.md)
- [svelte-adapter-uws-extensions errors](https://github.com/lanteanio/svelte-adapter-uws-extensions/blob/dev/ERRORS.md)

| Stable ID | Code or event | Searchable message prefix |
|---|---|---|
| [ADAPTER-ERR-LISTEN](#adapter-err-listen) | `LISTEN_FAILED` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.listener event=runtime.listen.failed severity=fatal] runtime.listen.failed: Could not bind the server listener on` |
| [ADAPTER-ERR-VITE-LOAD](#adapter-err-vite-load) | `vite.handler.load-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.load-failed severity=error] vite.handler.load-failed: Initial loading of the WebSocket handler` |
| [ADAPTER-ERR-VITE-RELOAD](#adapter-err-vite-reload) | `vite.handler.reload-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.reload-failed severity=error] vite.handler.reload-failed: Hot reloading of the WebSocket handler` |
| [ADAPTER-ERR-NATIVE-LOAD](#adapter-err-native-load) | `install.native-load.failed` | `Could not load uWebSockets.js.` |
| [ADAPTER-ERR-REQUEST-TIMEOUT](#adapter-err-request-timeout) | `websocket.request.timeout` | `request timed out` |
| [ADAPTER-ERR-REQUEST-CLOSED](#adapter-err-request-closed) | `websocket.request.connection-closed` | `connection closed` |
| [ADAPTER-ERR-ADMIN-HANDLER](#adapter-err-admin-handler) | `admin.handler-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.admin event=admin.handler-failed severity=error] The admin handler failed; the request was answered 500.` |
| [ADAPTER-ERR-RELAY-FRAME-OVERSIZED](#adapter-err-relay-frame-oversized) | `cluster-relay.frame-oversized` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.frame-oversized severity=error] A worker sent a relay frame larger than this process will reassemble; its relay stream was stopped.` |
| [ADAPTER-ERR-RELAY-FRAME-REFUSED](#adapter-err-relay-frame-refused) | `cluster-relay.frame-refused` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.frame-refused severity=warn] A publish was too large for the cluster relay and was not sent to other workers. Local subscribers received it.` |
| [ADAPTER-ERR-RELAY-SPILL-OVERFLOW](#adapter-err-relay-spill-overflow) | `cluster-relay.up-spill-overflow` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.up-spill-overflow severity=error] This worker could not hand its relay backlog to the primary within its spill ceiling and is exiting to be replaced.` |
| [ADAPTER-ERR-CLUSTER-WORKER-ERROR](#adapter-err-cluster-worker-error) | `cluster.worker-error` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster event=cluster.worker-error severity=error] A worker thread reported an error.` |
| [ADAPTER-ERR-DIVERGENCE](#adapter-err-divergence) | `divergence.detected` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.divergence event=divergence.detected severity=error] Cross-worker state divergence was detected; evidence is retained behind the authenticated diagnostic lookup.` |
| [ADAPTER-ERR-INVARIANT](#adapter-err-invariant) | `invariant.violated` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.assertion event=invariant.violated severity=` |
| [ADAPTER-ERR-METRICS-MERGE](#adapter-err-metrics-merge) | `metrics.merge-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.merge-failed severity=error] The cluster metrics merge failed; this scrape answers with the local worker only.` |
| [ADAPTER-ERR-METRICS-MIRROR-READ](#adapter-err-metrics-mirror-read) | `metrics.mirror-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.mirror-read-failed severity=error] The metrics mirror read failed during cluster collection; this worker reports as a gap between expected and reporting.` |
| [ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE](#adapter-err-metrics-primary-unreachable) | `metrics.primary-unreachable` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.primary-unreachable severity=error] The metrics snapshot request could not reach the primary; this scrape answers degraded with the local worker only.` |
| [ADAPTER-ERR-SINK-FAILED](#adapter-err-sink-failed) | `operational.sink.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.observability event=operational.sink.failed severity=error] The configured operational event sink failed; console fallback was restored for this event.` |
| [ADAPTER-ERR-PRESSURE-LISTENER](#adapter-err-pressure-listener) | `pressure.listener-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.listener-failed severity=error] A pressure listener failed.` |
| [ADAPTER-ERR-PRESSURE-RATE-LISTENER](#adapter-err-pressure-rate-listener) | `pressure.publish-rate-listener-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.publish-rate-listener-failed severity=error] A publish-rate listener failed.` |
| [ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER](#adapter-err-pressure-runaway-publisher) | `pressure.runaway-publisher` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.runaway-publisher severity=warn] A publisher crossed a configured per-topic pressure threshold.` |
| [ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY](#adapter-err-pressure-topic-registry) | `pressure.topic-registry-high` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.topic-registry-high severity=warn] The topic registry crossed its cardinality warning threshold.` |
| [ADAPTER-ERR-RESUME-HOOK](#adapter-err-resume-hook) | `resume.hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-failed severity=error] The resume hook threw; the client falls back to a fresh subscribe.` |
| [ADAPTER-ERR-RESUME-HOOK-READ](#adapter-err-resume-hook-read) | `resume.hook-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-read-failed severity=error] Reading the resume hook result threw for a topic; that topic is treated as covering nothing.` |
| [ADAPTER-ERR-AUTHENTICATE](#adapter-err-authenticate) | `runtime.authenticate.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.authenticate event=runtime.authenticate.failed severity=error] The WebSocket authentication endpoint failed.` |
| [ADAPTER-ERR-RELAY-GAP](#adapter-err-relay-gap) | `runtime.relay-gap.detected` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.relay-gap event=runtime.relay-gap.detected severity=error] This worker is missing relayed state that sibling workers received.` |
| [ADAPTER-ERR-SSR](#adapter-err-ssr) | `runtime.ssr.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.ssr event=runtime.ssr.failed severity=error] SvelteKit request handling failed.` |
| [ADAPTER-ERR-UPGRADE-HOOK](#adapter-err-upgrade-hook) | `runtime.websocket-upgrade.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.websocket-upgrade event=runtime.websocket-upgrade.failed severity=error] The WebSocket upgrade hook failed.` |
| [ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK](#adapter-err-subscribe-batch-hook) | `subscribe.batch-hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-hook-failed severity=error] The subscribeBatch hook threw; every topic in the batch was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT](#adapter-err-subscribe-batch-result) | `subscribe.batch-result-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-result-read-failed severity=error] Reading the subscribeBatch result threw; every topic in the batch was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-SUBSCRIBE-HOOK](#adapter-err-subscribe-hook) | `subscribe.hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.hook-failed severity=error] The subscribe hook threw; the subscribe was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-TLS-RELOAD-SKIPPED](#adapter-err-tls-reload-skipped) | `tls.reload-skipped` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.reload-skipped severity=warn] A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.` |
| [ADAPTER-ERR-TLS-SWAP](#adapter-err-tls-swap) | `tls.swap-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.swap-failed severity=error] A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.` |
| [ADAPTER-ERR-TLS-WATCH](#adapter-err-tls-watch) | `tls.watch-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.watch-failed severity=error] The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.` |

## Emitted diagnostic event coverage

This inventory is derived at generation time by scanning `src/runtime/`, `src/observability.js`,
and `src/vite.js` for emitted diagnostic events; the runtime emits 36 distinct events.
The 33 indexed above carry stable IDs and full operator guidance; the remaining 3
are informational. That split is enforced by severity rather than by a list: an emitted event
is exempt from the indexed reference only while every severity it is emitted at is
informational, so promoting one to a warning or an error fails generation until it is indexed.

Indexed events:

- `runtime.listen.failed` - [ADAPTER-ERR-LISTEN](#adapter-err-listen)
- `vite.handler.load-failed` - [ADAPTER-ERR-VITE-LOAD](#adapter-err-vite-load)
- `vite.handler.reload-failed` - [ADAPTER-ERR-VITE-RELOAD](#adapter-err-vite-reload)
- `install.native-load.failed` - [ADAPTER-ERR-NATIVE-LOAD](#adapter-err-native-load)
- `websocket.request.timeout` - [ADAPTER-ERR-REQUEST-TIMEOUT](#adapter-err-request-timeout)
- `websocket.request.connection-closed` - [ADAPTER-ERR-REQUEST-CLOSED](#adapter-err-request-closed)
- `admin.handler-failed` - [ADAPTER-ERR-ADMIN-HANDLER](#adapter-err-admin-handler)
- `cluster-relay.frame-oversized` - [ADAPTER-ERR-RELAY-FRAME-OVERSIZED](#adapter-err-relay-frame-oversized)
- `cluster-relay.frame-refused` - [ADAPTER-ERR-RELAY-FRAME-REFUSED](#adapter-err-relay-frame-refused)
- `cluster-relay.up-spill-overflow` - [ADAPTER-ERR-RELAY-SPILL-OVERFLOW](#adapter-err-relay-spill-overflow)
- `cluster.worker-error` - [ADAPTER-ERR-CLUSTER-WORKER-ERROR](#adapter-err-cluster-worker-error)
- `divergence.detected` - [ADAPTER-ERR-DIVERGENCE](#adapter-err-divergence)
- `invariant.violated` - [ADAPTER-ERR-INVARIANT](#adapter-err-invariant)
- `metrics.merge-failed` - [ADAPTER-ERR-METRICS-MERGE](#adapter-err-metrics-merge)
- `metrics.mirror-read-failed` - [ADAPTER-ERR-METRICS-MIRROR-READ](#adapter-err-metrics-mirror-read)
- `metrics.primary-unreachable` - [ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE](#adapter-err-metrics-primary-unreachable)
- `operational.sink.failed` - [ADAPTER-ERR-SINK-FAILED](#adapter-err-sink-failed)
- `pressure.listener-failed` - [ADAPTER-ERR-PRESSURE-LISTENER](#adapter-err-pressure-listener)
- `pressure.publish-rate-listener-failed` - [ADAPTER-ERR-PRESSURE-RATE-LISTENER](#adapter-err-pressure-rate-listener)
- `pressure.runaway-publisher` - [ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER](#adapter-err-pressure-runaway-publisher)
- `pressure.topic-registry-high` - [ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY](#adapter-err-pressure-topic-registry)
- `resume.hook-failed` - [ADAPTER-ERR-RESUME-HOOK](#adapter-err-resume-hook)
- `resume.hook-read-failed` - [ADAPTER-ERR-RESUME-HOOK-READ](#adapter-err-resume-hook-read)
- `runtime.authenticate.failed` - [ADAPTER-ERR-AUTHENTICATE](#adapter-err-authenticate)
- `runtime.relay-gap.detected` - [ADAPTER-ERR-RELAY-GAP](#adapter-err-relay-gap)
- `runtime.ssr.failed` - [ADAPTER-ERR-SSR](#adapter-err-ssr)
- `runtime.websocket-upgrade.failed` - [ADAPTER-ERR-UPGRADE-HOOK](#adapter-err-upgrade-hook)
- `subscribe.batch-hook-failed` - [ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK](#adapter-err-subscribe-batch-hook)
- `subscribe.batch-result-read-failed` - [ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT](#adapter-err-subscribe-batch-result)
- `subscribe.hook-failed` - [ADAPTER-ERR-SUBSCRIBE-HOOK](#adapter-err-subscribe-hook)
- `tls.reload-skipped` - [ADAPTER-ERR-TLS-RELOAD-SKIPPED](#adapter-err-tls-reload-skipped)
- `tls.swap-failed` - [ADAPTER-ERR-TLS-SWAP](#adapter-err-tls-swap)
- `tls.watch-failed` - [ADAPTER-ERR-TLS-WATCH](#adapter-err-tls-watch)

### Informational events

These carry no stable ID and no recovery guidance because they report normal operation
rather than a failure. Each is emitted on the shared diagnostic line format, so its
searchable log prefix is:

`[lantean/diagnostic source=svelte-adapter-uws component=<component> event=<event> severity=<severity>] <message>`

| Event | Component | Severity | Emitting sources |
|---|---|---|---|
| `runtime.subscription.accepted` | `runtime.subscription` | debug | [src/runtime/handler.js](../src/runtime/handler.js) |
| `runtime.subscription.removed` | `runtime.subscription` | debug | [src/runtime/handler.js](../src/runtime/handler.js) |
| `vite.handler.recovered` | `vite.websocket` | info | [src/runtime/utils/operational-diagnostic.js](../src/runtime/utils/operational-diagnostic.js) |

<a id="adapter-err-listen"></a>
## `ADAPTER-ERR-LISTEN`

- **Code/event:** `LISTEN_FAILED`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.listener event=runtime.listen.failed severity=fatal] runtime.listen.failed: Could not bind the server listener on`
- **Cause:** The configured address or port could not be bound, or the process lacks permission.
- **Consequence:** The process never becomes ready and exits with status 1.
- **Automatic recovery:** None. The adapter does not retry a failed bind.
- **Next action:** Check address availability, port conflicts, and bind permissions, then restart the process.
- **Runtime help:** `docs/errors.md#adapter-err-listen`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js), [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-vite-load"></a>
## `ADAPTER-ERR-VITE-LOAD`

- **Code/event:** `vite.handler.load-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.load-failed severity=error] vite.handler.load-failed: Initial loading of the WebSocket handler`
- **Cause:** The initial development WebSocket handler or one of its imports failed to load.
- **Consequence:** The Vite HTTP server stays active, but WebSocket upgrades return HTTP 500 until a handler loads.
- **Automatic recovery:** Vite retries the handler when its module graph changes again.
- **Next action:** Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.
- **Runtime help:** `docs/errors.md#adapter-err-vite-load`
- **Runtime sources:** [src/vite.js](../src/vite.js)

<a id="adapter-err-vite-reload"></a>
## `ADAPTER-ERR-VITE-RELOAD`

- **Code/event:** `vite.handler.reload-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.reload-failed severity=error] vite.handler.reload-failed: Hot reloading of the WebSocket handler`
- **Cause:** A development handler hot reload failed after an earlier handler had loaded.
- **Consequence:** Existing WebSocket connections keep the previous handler, but new upgrades return HTTP 500 until recovery.
- **Automatic recovery:** Vite retries the handler when its module graph changes again.
- **Next action:** Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.
- **Runtime help:** `docs/errors.md#adapter-err-vite-reload`
- **Runtime sources:** [src/vite.js](../src/vite.js)

<a id="adapter-err-native-load"></a>
## `ADAPTER-ERR-NATIVE-LOAD`

- **Code/event:** `install.native-load.failed`
- **Message prefix:** `Could not load uWebSockets.js.`
- **Cause:** The optional native addon is absent or has no binary for the active Node ABI, CPU, OS, or libc.
- **Consequence:** The adapter cannot install or start, and there is no JavaScript transport fallback.
- **Automatic recovery:** None. Package installation and process startup stop at this failure.
- **Next action:** Install the exact supported archive and a binary for the active OS, CPU, Node ABI, and documented Linux libc floor.
- **Runtime help:** `docs/errors.md#adapter-err-native-load`
- **Runtime sources:** [src/uws-load-hint.js](../src/uws-load-hint.js)

<a id="adapter-err-request-timeout"></a>
## `ADAPTER-ERR-REQUEST-TIMEOUT`

- **Code/event:** `websocket.request.timeout`
- **Message prefix:** `request timed out`
- **Cause:** A platform.request reply did not arrive within timeoutMs; the recipient may already have executed the request.
- **Consequence:** The caller promise rejects while the remote operation outcome remains unknown.
- **Automatic recovery:** None. The adapter does not retry requests because replay may duplicate an operation.
- **Next action:** Reconcile application state first, or retry only through an idempotent operation; then investigate the handler, connection, and measured timeout budget.
- **Runtime help:** `docs/errors.md#adapter-err-request-timeout`
- **Runtime sources:** [src/runtime/handler/platform.js](../src/runtime/handler/platform.js), [src/vite.js](../src/vite.js)

<a id="adapter-err-request-closed"></a>
## `ADAPTER-ERR-REQUEST-CLOSED`

- **Code/event:** `websocket.request.connection-closed`
- **Message prefix:** `connection closed`
- **Cause:** The target WebSocket closed before its pending request produced a reply.
- **Consequence:** The caller promise rejects while the remote operation outcome remains unknown.
- **Automatic recovery:** None. The adapter does not retry requests because replay may duplicate an operation.
- **Next action:** Reconcile application state first, or retry only through an idempotent operation after the connection recovers.
- **Runtime help:** `docs/errors.md#adapter-err-request-closed`
- **Runtime sources:** [src/runtime/handler/platform.js](../src/runtime/handler/platform.js), [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js)

<a id="adapter-err-admin-handler"></a>
## `ADAPTER-ERR-ADMIN-HANDLER`

- **Code/event:** `admin.handler-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.admin event=admin.handler-failed severity=error] The admin handler failed; the request was answered 500.`
- **Cause:** An admin route handler threw or returned a rejected promise.
- **Consequence:** That one admin request answered 500. Application traffic and WebSocket delivery are unaffected.
- **Automatic recovery:** None for the failed request; the next admin request runs the handler again.
- **Next action:** Read the attached error attribute and fix the admin handler. Admin routes are separately gated, so this does not indicate a fault in the serving path.
- **Runtime help:** `docs/errors.md#adapter-err-admin-handler`
- **Runtime sources:** [src/runtime/handler/admin.js](../src/runtime/handler/admin.js)

<a id="adapter-err-relay-frame-oversized"></a>
## `ADAPTER-ERR-RELAY-FRAME-OVERSIZED`

- **Code/event:** `cluster-relay.frame-oversized`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.frame-oversized severity=error] A worker sent a relay frame larger than this process will reassemble; its relay stream was stopped.`
- **Cause:** A worker declared a relay frame above the reassembly ceiling, which is four times the configured relay frame ceiling. Either the ceiling is set far below real payloads, or the stream is corrupt.
- **Consequence:** That worker relay stream is stopped, so its cross-worker publishes no longer reach this process. Local delivery on the sending worker continues, which is what makes the split silent.
- **Automatic recovery:** None for the stopped stream itself. The sending worker is expected to retire through its own spill overflow and be replaced, which is the path that actually restores its relay.
- **Next action:** Compare the declaredBytes and maxFrameBytes attributes. If the payload is legitimate, raise the relay frame ceiling; otherwise treat the stream as corrupt and replace the worker.
- **Runtime help:** `docs/errors.md#adapter-err-relay-frame-oversized`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-relay-frame-refused"></a>
## `ADAPTER-ERR-RELAY-FRAME-REFUSED`

- **Code/event:** `cluster-relay.frame-refused`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.frame-refused severity=warn] A publish was too large for the cluster relay and was not sent to other workers. Local subscribers received it.`
- **Cause:** A publish exceeded the configured relay frame ceiling for cross-worker delivery.
- **Consequence:** Subscribers on this worker received the message and subscribers on every other worker did not. Clients therefore disagree about state depending on which worker they landed on.
- **Automatic recovery:** None. The refused publish is not retried or fragmented.
- **Next action:** Reduce the payload size, or raise the relay frame ceiling to cover it. Treat repeated occurrences as a correctness problem rather than a capacity warning, because the split is invisible to clients.
- **Runtime help:** `docs/errors.md#adapter-err-relay-frame-refused`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-relay-spill-overflow"></a>
## `ADAPTER-ERR-RELAY-SPILL-OVERFLOW`

- **Code/event:** `cluster-relay.up-spill-overflow`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster-relay event=cluster-relay.up-spill-overflow severity=error] This worker could not hand its relay backlog to the primary within its spill ceiling and is exiting to be replaced.`
- **Cause:** The worker queued more relay bytes, or held them longer, than its spill ceiling allows while waiting on the primary.
- **Consequence:** The worker exits deliberately rather than growing an unbounded queue. Connections on it drop and those clients reconnect, normally to another worker.
- **Automatic recovery:** Yes. The worker exits so the supervisor replaces it.
- **Next action:** Read the reason, droppedBytes, and pendingAgeMs attributes. A blocked or slow primary is the usual cause; if the backlog is legitimate peak traffic, raise the relay ring pending ceilings.
- **Runtime help:** `docs/errors.md#adapter-err-relay-spill-overflow`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-cluster-worker-error"></a>
## `ADAPTER-ERR-CLUSTER-WORKER-ERROR`

- **Code/event:** `cluster.worker-error`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster event=cluster.worker-error severity=error] A worker thread reported an error.`
- **Cause:** A worker thread emitted an error event to the primary, which usually means it threw outside a request or failed during startup.
- **Consequence:** That worker is unhealthy. Its connections are lost when it exits, and cluster capacity drops until it is replaced.
- **Automatic recovery:** The supervisor replaces an exiting worker; the error itself is reported, not retried.
- **Next action:** Read the attached error attribute. A repeating worker error at startup usually means a configuration or import fault that every replacement will hit as well.
- **Runtime help:** `docs/errors.md#adapter-err-cluster-worker-error`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-divergence"></a>
## `ADAPTER-ERR-DIVERGENCE`

- **Code/event:** `divergence.detected`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.divergence event=divergence.detected severity=error] Cross-worker state divergence was detected; evidence is retained behind the authenticated diagnostic lookup.`
- **Cause:** Workers that should hold identical state reported different state hashes.
- **Consequence:** Clients on different workers can observe different state for the same topic. The log line carries only an opaque diagnostic id, because per-thread hashes and keyed sequence summaries are identifier-bearing.
- **Automatic recovery:** None. Divergence is reported, never silently reconciled.
- **Next action:** Resolve the diagnosticId attribute to its retained per-worker evidence, then treat it as a correctness incident. In an adapter-only deployment that lookup is `platform.diagnostic(id)`; the authenticated admin HTTP route exists only where the realtime layer is configured to serve one.
- **Runtime help:** `docs/errors.md#adapter-err-divergence`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-invariant"></a>
## `ADAPTER-ERR-INVARIANT`

- **Code/event:** `invariant.violated`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.assertion event=invariant.violated severity=`
- **Cause:** A framework-internal assertion failed. The message is the assertion category and the severity is chosen by the call site, so both vary.
- **Consequence:** Depends on the tier. A recorded violation appears in the platform.assertions map; a development-only assertion is logged and thrown WITHOUT being recorded there, so an empty map does not mean none fired. At the fatal tier the worker is scheduled to exit with a dedicated status code and the supervisor replaces it.
- **Automatic recovery:** None for the condition itself. A fatal-tier violation exits the worker, which is replacement rather than recovery.
- **Next action:** Read the severity first, because it selects the tier and therefore the blast radius, then the category and context attributes. These are library-internal invariants, so a violation is an adapter defect rather than an application misconfiguration; report it with both attributes.
- **Runtime help:** `docs/errors.md#adapter-err-invariant`
- **Runtime sources:** [src/runtime/utils/assertions.js](../src/runtime/utils/assertions.js)

<a id="adapter-err-metrics-merge"></a>
## `ADAPTER-ERR-METRICS-MERGE`

- **Code/event:** `metrics.merge-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.merge-failed severity=error] The cluster metrics merge failed; this scrape answers with the local worker only.`
- **Cause:** Combining per-worker metric snapshots into one cluster answer threw.
- **Consequence:** That scrape reports one worker instead of the cluster, so counters appear to drop sharply for a single interval.
- **Automatic recovery:** Yes. The next scrape attempts the merge again.
- **Next action:** Treat an isolated occurrence as a degraded scrape, not lost data. If it repeats, read the attached error; alerting on absolute counter values across this interval will produce false alarms.
- **Runtime help:** `docs/errors.md#adapter-err-metrics-merge`
- **Runtime sources:** [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js)

<a id="adapter-err-metrics-mirror-read"></a>
## `ADAPTER-ERR-METRICS-MIRROR-READ`

- **Code/event:** `metrics.mirror-read-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.mirror-read-failed severity=error] The metrics mirror read failed during cluster collection; this worker reports as a gap between expected and reporting.`
- **Cause:** Reading one worker metrics mirror threw during collection.
- **Consequence:** That worker contributes nothing to the scrape and appears as a difference between the expected and reporting worker counts, which is the intended signal rather than a silent omission.
- **Automatic recovery:** Yes. The next collection reads the mirror again.
- **Next action:** Compare expected against reporting worker counts over time. A persistent gap for the same worker points at that worker rather than at the metrics layer.
- **Runtime help:** `docs/errors.md#adapter-err-metrics-mirror-read`
- **Runtime sources:** [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js)

<a id="adapter-err-metrics-primary-unreachable"></a>
## `ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE`

- **Code/event:** `metrics.primary-unreachable`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.primary-unreachable severity=error] The metrics snapshot request could not reach the primary; this scrape answers degraded with the local worker only.`
- **Cause:** Posting the snapshot request to the primary threw, which means this worker's message port to the primary is closed or unusable - the primary has gone or the worker is shutting down.
- **Consequence:** The scrape is answered from the local worker and marked degraded rather than failing outright, so the endpoint stays up while the numbers describe one worker.
- **Automatic recovery:** Yes. The next scrape posts to the primary again.
- **Next action:** Treat this as a dead port rather than a slow primary. A primary that is merely slow does NOT emit this event: that path answers degraded silently when its deadline passes, so the absence of this line is not evidence the primary is healthy. Compare the expected and reporting worker counts for that.
- **Runtime help:** `docs/errors.md#adapter-err-metrics-primary-unreachable`
- **Runtime sources:** [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js)

<a id="adapter-err-sink-failed"></a>
## `ADAPTER-ERR-SINK-FAILED`

- **Code/event:** `operational.sink.failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.observability event=operational.sink.failed severity=error] The configured operational event sink failed; console fallback was restored for this event.`
- **Cause:** The application-supplied operational event sink threw while handling an event.
- **Consequence:** That event went to the console instead of the sink. If the sink is the only path into log aggregation, events are reaching the process output and nothing else.
- **Automatic recovery:** Per event. The sink is attempted again for the next event rather than being disabled.
- **Next action:** Fix the sink so it cannot throw; a sink that throws for a class of events loses exactly that class from aggregation while the console keeps them.
- **Runtime help:** `docs/errors.md#adapter-err-sink-failed`
- **Runtime sources:** [src/runtime/diagnostic.js](../src/runtime/diagnostic.js)

<a id="adapter-err-pressure-listener"></a>
## `ADAPTER-ERR-PRESSURE-LISTENER`

- **Code/event:** `pressure.listener-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.listener-failed severity=error] A pressure listener failed.`
- **Cause:** An application listener registered for backpressure notifications threw.
- **Consequence:** That listener missed the notification. Pressure accounting itself is unaffected, so shedding and limits still apply.
- **Automatic recovery:** Yes. A throwing listener stays registered and is called again on the next notification.
- **Next action:** Fix the listener. Application code that reacts to pressure by shedding load is not running while it throws, so the process can stay under pressure longer than intended.
- **Runtime help:** `docs/errors.md#adapter-err-pressure-listener`
- **Runtime sources:** [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js)

<a id="adapter-err-pressure-rate-listener"></a>
## `ADAPTER-ERR-PRESSURE-RATE-LISTENER`

- **Code/event:** `pressure.publish-rate-listener-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.publish-rate-listener-failed severity=error] A publish-rate listener failed.`
- **Cause:** An application listener registered for publish-rate notifications threw.
- **Consequence:** That listener missed the notification. Rate accounting is unaffected.
- **Automatic recovery:** Yes. The listener stays registered and is called again.
- **Next action:** Fix the listener, and check whether it was the component expected to throttle publishing.
- **Runtime help:** `docs/errors.md#adapter-err-pressure-rate-listener`
- **Runtime sources:** [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js)

<a id="adapter-err-pressure-runaway-publisher"></a>
## `ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER`

- **Code/event:** `pressure.runaway-publisher`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.runaway-publisher severity=warn] A publisher crossed a configured per-topic pressure threshold.`
- **Cause:** One topic exceeded its configured publish pressure threshold. The event is emitted only when no publish-rate listener is registered, and at most once per minute per topic, so it reports the condition rather than every crossing.
- **Consequence:** Nothing is dropped by this event alone. It is the early signal that one topic is consuming a disproportionate share of outbound capacity.
- **Automatic recovery:** None. Nothing throttles the publisher on the strength of this threshold.
- **Next action:** Identify the topic from the attributes and decide whether the rate is intended. Because the line is suppressed entirely while an onPublishRate listener is registered and otherwise throttled per topic, its absence is not evidence the condition ended - read the pressure metrics for that. Left alone, a runaway publisher is what later produces slow-consumer disconnects on unrelated topics.
- **Runtime help:** `docs/errors.md#adapter-err-pressure-runaway-publisher`
- **Runtime sources:** [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js)

<a id="adapter-err-pressure-topic-registry"></a>
## `ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY`

- **Code/event:** `pressure.topic-registry-high`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.topic-registry-high severity=warn] The topic registry crossed its cardinality warning threshold.`
- **Cause:** The number of distinct live topics passed the configured warning threshold.
- **Consequence:** Nothing is refused at this threshold. Topic bookkeeping grows with cardinality, so this is the memory-growth signal.
- **Automatic recovery:** None. Cardinality is not reduced in response to the threshold.
- **Next action:** Check whether topic names embed unbounded identifiers. The line fires ONCE per process: it is latched after the first crossing and never repeats, so it cannot tell you whether cardinality later fell or kept climbing - read the topic-registry gauge for that. Unbounded cardinality is a slow leak rather than a spike, so act at the warning rather than at exhaustion.
- **Runtime help:** `docs/errors.md#adapter-err-pressure-topic-registry`
- **Runtime sources:** [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js)

<a id="adapter-err-resume-hook"></a>
## `ADAPTER-ERR-RESUME-HOOK`

- **Code/event:** `resume.hook-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-failed severity=error] The resume hook threw; the client falls back to a fresh subscribe.`
- **Cause:** The application resume hook threw while answering a client gap-fill request, so some or all of the replay frames it owed were never sent.
- **Consequence:** The client is still sent `resumed`, because that ack is not conditional on the hook. It therefore believes its gap was handled and reports nothing. Whether the history is actually recovered depends on whether the subscribe frames it sends next carry recover offsets; if they do not, the gap is permanent and silent on both sides.
- **Automatic recovery:** None for the gap. Despite the message text, no fallback subscribe is triggered by this failure - the client simply continues its normal sequence.
- **Next action:** Fix the hook if resume coverage matters for these topics, and do not read a `resumed` ack as evidence a gap was filled. Clients that subscribe with recover offsets recover anyway; clients that do not are missing history without any signal.
- **Runtime help:** `docs/errors.md#adapter-err-resume-hook`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js)

<a id="adapter-err-resume-hook-read"></a>
## `ADAPTER-ERR-RESUME-HOOK-READ`

- **Code/event:** `resume.hook-read-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-read-failed severity=error] Reading the resume hook result threw for a topic; that topic is treated as covering nothing.`
- **Cause:** The resume hook returned a value whose properties threw while being read, typically a getter or a proxy.
- **Consequence:** That topic is treated as covering nothing, which is the same answer a hook returning a non-number gives, so it is served without gap-fill. Other topics in the same batch are unaffected: the read is guarded here precisely so one unreadable topic cannot abort the loop and leak the rest as permanently in-flight.
- **Automatic recovery:** None for the gap itself. The subscribe still completes, on the ordinary no-coverage path rather than an error path.
- **Next action:** Return a plain object from the resume hook. Values whose property reads have side effects cannot be read safely on this path.
- **Runtime help:** `docs/errors.md#adapter-err-resume-hook-read`
- **Runtime sources:** [src/runtime/handler/resume-buffer.js](../src/runtime/handler/resume-buffer.js)

<a id="adapter-err-authenticate"></a>
## `ADAPTER-ERR-AUTHENTICATE`

- **Code/event:** `runtime.authenticate.failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.authenticate event=runtime.authenticate.failed severity=error] The WebSocket authentication endpoint failed.`
- **Cause:** The application `authenticate` export threw or rejected while answering its HTTP POST endpoint, which the client posts to before opening its WebSocket.
- **Consequence:** That POST is answered 500. This is an ordinary HTTP route rather than the upgrade path, so no upgrade is refused and established connections are untouched; a client that treats the failed POST as fatal never goes on to open its WebSocket.
- **Automatic recovery:** None for the failed request. The client may post again, which runs the hook again.
- **Next action:** Read the attached error and requestId and fix the hook. Look at the authentication endpoint and its dependencies, not at the upgrade path: the two are separate routes and this event never comes from an upgrade.
- **Runtime help:** `docs/errors.md#adapter-err-authenticate`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js)

<a id="adapter-err-relay-gap"></a>
## `ADAPTER-ERR-RELAY-GAP`

- **Code/event:** `runtime.relay-gap.detected`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.relay-gap event=runtime.relay-gap.detected severity=error] This worker is missing relayed state that sibling workers received.`
- **Cause:** A gap was detected in the relayed sequence this worker received from its siblings.
- **Consequence:** Clients on this worker are missing events that clients on other workers received, so they disagree about state.
- **Automatic recovery:** None. A detected gap is reported rather than back-filled.
- **Next action:** Treat as a correctness incident. Check for accompanying relay frame or spill events, which usually name the cause of the loss.
- **Runtime help:** `docs/errors.md#adapter-err-relay-gap`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js)

<a id="adapter-err-ssr"></a>
## `ADAPTER-ERR-SSR`

- **Code/event:** `runtime.ssr.failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.ssr event=runtime.ssr.failed severity=error] SvelteKit request handling failed.`
- **Cause:** The SvelteKit server handler threw while rendering or handling a request.
- **Consequence:** That request is answered with an error response. Other requests and WebSocket connections are unaffected.
- **Automatic recovery:** None for the failed request.
- **Next action:** Read the attached error. This is application rendering code rather than adapter transport, so the fault is normally in a route, hook, or load function.
- **Runtime help:** `docs/errors.md#adapter-err-ssr`
- **Runtime sources:** [src/runtime/handler/ssr.js](../src/runtime/handler/ssr.js)

<a id="adapter-err-upgrade-hook"></a>
## `ADAPTER-ERR-UPGRADE-HOOK`

- **Code/event:** `runtime.websocket-upgrade.failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.websocket-upgrade event=runtime.websocket-upgrade.failed severity=error] The WebSocket upgrade hook failed.`
- **Cause:** The application upgrade hook threw while a client was being upgraded.
- **Consequence:** That upgrade does not complete and the client cannot open its WebSocket.
- **Automatic recovery:** None. The client retries by reconnecting, which runs the hook again.
- **Next action:** Read the attached error and fix the hook. Persistent failure presents to users as a connection that never establishes, while HTTP continues to work.
- **Runtime help:** `docs/errors.md#adapter-err-upgrade-hook`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-subscribe-batch-hook"></a>
## `ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK`

- **Code/event:** `subscribe.batch-hook-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-hook-failed severity=error] The subscribeBatch hook threw; every topic in the batch was denied INTERNAL_ERROR.`
- **Cause:** The application subscribeBatch authorization hook threw.
- **Consequence:** Every topic in that batch is denied with INTERNAL_ERROR. Authorization is fail-closed, so a throwing hook denies rather than admits.
- **Automatic recovery:** None. The client may retry the subscribe, which runs the hook again.
- **Next action:** Fix the hook. Because one throw denies the whole batch, a fault touching a single topic presents as a client that can subscribe to nothing.
- **Runtime help:** `docs/errors.md#adapter-err-subscribe-batch-hook`
- **Runtime sources:** [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js)

<a id="adapter-err-subscribe-batch-result"></a>
## `ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT`

- **Code/event:** `subscribe.batch-result-read-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-result-read-failed severity=error] Reading the subscribeBatch result threw; every topic in the batch was denied INTERNAL_ERROR.`
- **Cause:** The subscribeBatch hook returned a value whose properties threw while being read, typically a getter or a proxy.
- **Consequence:** Every topic in that batch is denied with INTERNAL_ERROR, exactly as though the hook itself had thrown.
- **Automatic recovery:** None. The client may retry the subscribe.
- **Next action:** Return a plain object or array from the hook. Property reads on this path must be free of side effects.
- **Runtime help:** `docs/errors.md#adapter-err-subscribe-batch-result`
- **Runtime sources:** [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js)

<a id="adapter-err-subscribe-hook"></a>
## `ADAPTER-ERR-SUBSCRIBE-HOOK`

- **Code/event:** `subscribe.hook-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.hook-failed severity=error] The subscribe hook threw; the subscribe was denied INTERNAL_ERROR.`
- **Cause:** The application subscribe authorization hook threw for a single topic.
- **Consequence:** That subscribe is denied with INTERNAL_ERROR. Authorization is fail-closed, and the reason is deliberately distinct: returning false denies with FORBIDDEN, so a throw is reported as a fault rather than as a refusal.
- **Automatic recovery:** None. The client may retry the subscribe, which runs the hook again.
- **Next action:** Read the attached error and fix the hook. A client seeing INTERNAL_ERROR rather than FORBIDDEN or UNAUTHENTICATED is being told this is a defect, not a permissions decision, so treat it as one and do not go looking at authorization rules first.
- **Runtime help:** `docs/errors.md#adapter-err-subscribe-hook`
- **Runtime sources:** [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js)

<a id="adapter-err-tls-reload-skipped"></a>
## `ADAPTER-ERR-TLS-RELOAD-SKIPPED`

- **Code/event:** `tls.reload-skipped`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.reload-skipped severity=warn] A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.`
- **Cause:** A certificate change was seen on disk but not applied, usually because the new material was unreadable or incomplete at the moment it was read.
- **Consequence:** The server keeps serving the previous certificate and enters a degraded TLS state. The renewal on disk is not in use, so the served certificate can expire while a valid one sits unread. READINESS PROBES STAY GREEN throughout, which is what makes this quiet.
- **Automatic recovery:** The next reload that succeeds applies the certificate and clears the degraded state.
- **Next action:** Confirm the served certificate matches the one on disk rather than assuming renewal succeeded, and read the TLS degraded state rather than the probe, which cannot see this. Treat the warning as expiry risk, not noise.
- **Runtime help:** `docs/errors.md#adapter-err-tls-reload-skipped`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-tls-swap"></a>
## `ADAPTER-ERR-TLS-SWAP`

- **Code/event:** `tls.swap-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.swap-failed severity=error] A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.`
- **Cause:** Applying a new certificate set failed partway through the swap.
- **Consequence:** The swap is partial, so some SNI hosts may have no usable certificate and fail the TLS handshake until a retry completes. The TLS degraded state is set for the duration.
- **Automatic recovery:** A one-shot retry is armed from the failure itself, rather than from the next filesystem event, because the throw may have consumed the last event of a renewal burst and the next one could be months away. A persistent fault therefore retries at that cadence instead of spinning.
- **Next action:** Verify every SNI host still completes a handshake rather than only checking the default host, then correct the certificate material and reload.
- **Runtime help:** `docs/errors.md#adapter-err-tls-swap`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-tls-watch"></a>
## `ADAPTER-ERR-TLS-WATCH`

- **Code/event:** `tls.watch-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.watch-failed severity=error] The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.`
- **Cause:** The filesystem watch on the certificate directory could not be established.
- **Consequence:** Certificate hot reload is off for the process lifetime and the TLS degraded state is set. The current certificate keeps serving and no renewal is ever picked up, so the failure surfaces much later as an expired certificate.
- **Automatic recovery:** None. The watch is not retried, so this does not resolve without a restart.
- **Next action:** Fix the path or permissions and restart the process. Until then, treat certificate renewal as requiring a restart, and alert on certificate expiry independently. In a clustered deployment the primary reports its own watch failure as a plain `[tls]` console line rather than this event, so search the console text as well as this event name.
- **Runtime help:** `docs/errors.md#adapter-err-tls-watch`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)
