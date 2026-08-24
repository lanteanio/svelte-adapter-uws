# Error reference

Search this page with the exact stable ID, code, event, or beginning of the message you saw.
Every failure emitted as a diagnostic event is indexed below with its cause, what it means
for traffic, whether anything recovers on its own, and what to do next: 38 entries
against the 41 distinct diagnostic events emitted from the scanned sources, plus
33 entries indexing consequential plain console lines that never enter the diagnostic
pipeline - each such line is printed through the registry and carries its stable ID tag, so
the emitted text cannot drift from the prefix indexed here. The remaining emitted events are
informational, listed under [coverage](#emitted-diagnostic-event-coverage) with no recovery guidance
because there is nothing to recover from. A new failure event cannot be added to those sources
without an entry here: the generator fails the build until one exists. Plain console output is
held to the same rule from the other side - check-console-index walks every console.warn and
console.error across the production runtime, the dev server, the test harness and the shipped
plugins, and fails the build unless the line prints through this registry or carries a recorded
reason an operator who read it needs nothing more. A failure absent from this page is therefore
a decision someone made rather than one nobody noticed. The build-time adapter and the browser
client print for other audiences and are deliberately outside that walk.

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
| [ADAPTER-ERR-DIVERGENCE-QUIET](#adapter-err-divergence-quiet) | `divergence.quiet-state` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.divergence event=divergence.quiet-state severity=warn] Workers disagree about quiet-topic history; this is expected after a worker restart and never triggers a restart.` |
| [ADAPTER-ERR-INVARIANT](#adapter-err-invariant) | `invariant.violated` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.assertion event=invariant.violated severity=` |
| [ADAPTER-ERR-METRICS-MERGE](#adapter-err-metrics-merge) | `metrics.merge-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.merge-failed severity=error] The cluster metrics merge failed; this scrape answers with the local worker only.` |
| [ADAPTER-ERR-METRICS-MIRROR-READ](#adapter-err-metrics-mirror-read) | `metrics.mirror-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.mirror-read-failed severity=error] The metrics mirror read failed during cluster collection; this worker reports as a gap between expected and reporting.` |
| [ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE](#adapter-err-metrics-primary-unreachable) | `metrics.primary-unreachable` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.metrics event=metrics.primary-unreachable severity=error] The metrics snapshot request could not reach the primary; this scrape answers degraded with the local worker only.` |
| [ADAPTER-ERR-SINK-FAILED](#adapter-err-sink-failed) | `operational.sink.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.observability event=operational.sink.failed severity=error] The configured operational event sink failed; console fallback was restored for this event.` |
| [ADAPTER-ERR-PRESSURE-LISTENER](#adapter-err-pressure-listener) | `pressure.listener-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.listener-failed severity=error] A pressure listener failed.` |
| [ADAPTER-ERR-PRESSURE-RATE-LISTENER](#adapter-err-pressure-rate-listener) | `pressure.publish-rate-listener-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.publish-rate-listener-failed severity=error] A publish-rate listener failed.` |
| [ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER](#adapter-err-pressure-runaway-publisher) | `pressure.runaway-publisher` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.runaway-publisher severity=warn] A publisher crossed a configured per-topic pressure threshold.` |
| [ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY](#adapter-err-pressure-topic-registry) | `pressure.topic-registry-high` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.pressure event=pressure.topic-registry-high severity=warn] The topic registry crossed its cardinality warning threshold.` |
| [ADAPTER-ERR-EGRESS-REFUSED](#adapter-err-egress-refused) | `egress.publish-refused` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.publish-refused severity=warn] A publish crossed a configured egress ceiling and was refused.` |
| [ADAPTER-ERR-EGRESS-EVICTED](#adapter-err-egress-evicted) | `egress.window-evicted` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.window-evicted severity=warn] The egress ledger dropped a usage window that was still counting, so that key is unmetered for the rest of it.` |
| [ADAPTER-ERR-EGRESS-TENANT-RESOLVER](#adapter-err-egress-tenant-resolver) | `egress.tenant-resolver-invalid` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.tenant-resolver-invalid severity=error] The egress tenant resolver returned an unusable id; publishes are charged unattributed.` |
| [ADAPTER-ERR-RESUME-HOOK](#adapter-err-resume-hook) | `resume.hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-failed severity=error] The resume hook threw; the client falls back to a fresh subscribe.` |
| [ADAPTER-ERR-RESUME-HOOK-READ](#adapter-err-resume-hook-read) | `resume.hook-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-read-failed severity=error] Reading the resume hook result threw for a topic; that topic is treated as covering nothing.` |
| [ADAPTER-ERR-AUTHENTICATE](#adapter-err-authenticate) | `runtime.authenticate.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.authenticate event=runtime.authenticate.failed severity=error] The WebSocket authentication endpoint failed.` |
| [ADAPTER-ERR-RELAY-GAP](#adapter-err-relay-gap) | `runtime.relay-gap.detected` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.relay-gap event=runtime.relay-gap.detected severity=error] This worker is missing relayed state that sibling workers received.` |
| [ADAPTER-ERR-SSR](#adapter-err-ssr) | `runtime.ssr.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.ssr event=runtime.ssr.failed severity=error] SvelteKit request handling failed.` |
| [ADAPTER-ERR-UPGRADE-HOOK](#adapter-err-upgrade-hook) | `runtime.websocket-upgrade.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.websocket-upgrade event=runtime.websocket-upgrade.failed severity=error] The WebSocket upgrade hook failed.` |
| [ADAPTER-ERR-ATTRIBUTION](#adapter-err-attribution) | `runtime.websocket-attribution.failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.websocket-attribution event=runtime.websocket-attribution.failed severity=error] The WebSocket attribution hook failed; the connection was refused at open.` |
| [ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK](#adapter-err-subscribe-batch-hook) | `subscribe.batch-hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-hook-failed severity=error] The subscribeBatch hook threw; every topic in the batch was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT](#adapter-err-subscribe-batch-result) | `subscribe.batch-result-read-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.batch-result-read-failed severity=error] Reading the subscribeBatch result threw; every topic in the batch was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-SUBSCRIBE-HOOK](#adapter-err-subscribe-hook) | `subscribe.hook-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.subscribe event=subscribe.hook-failed severity=error] The subscribe hook threw; the subscribe was denied INTERNAL_ERROR.` |
| [ADAPTER-ERR-TLS-RELOAD-SKIPPED](#adapter-err-tls-reload-skipped) | `tls.reload-skipped` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.reload-skipped severity=warn] A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.` |
| [ADAPTER-ERR-TLS-SWAP](#adapter-err-tls-swap) | `tls.swap-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.swap-failed severity=error] A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.` |
| [ADAPTER-ERR-TLS-WATCH](#adapter-err-tls-watch) | `tls.watch-failed` | `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.watch-failed severity=error] The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.` |
| [ADAPTER-ERR-CLUSTER-CONFIG-WORKERS](#adapter-err-cluster-config-workers) | `cluster.config.invalid-workers` | `[svelte-adapter-uws] Invalid CLUSTER_WORKERS value: '` |
| [ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE](#adapter-err-cluster-config-compute) | `cluster.config.invalid-compute-count` | `[svelte-adapter-uws] websocket.workers.compute (` |
| [ADAPTER-ERR-CLUSTER-CONFIG-MODE](#adapter-err-cluster-config-mode) | `cluster.config.invalid-mode` | `[svelte-adapter-uws] Invalid CLUSTER_MODE: '` |
| [ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT](#adapter-err-cluster-config-reuseport) | `cluster.config.reuseport-unsupported` | `[svelte-adapter-uws] CLUSTER_MODE=reuseport requires Linux (SO_REUSEPORT is not reliable on ` |
| [ADAPTER-ERR-TLS-PRIMARY-BOOT-READ](#adapter-err-tls-primary-boot-read) | `tls.primary.boot-read-failed` | `[tls] boot certificate unreadable on the primary (hot-reload broadcast stays armed)` |
| [ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ](#adapter-err-tls-primary-reload-read) | `tls.primary.reload-read-failed` | `[tls] renewed certificate unreadable on the primary (workers gate on their own reads)` |
| [ADAPTER-ERR-TLS-PRIMARY-WATCH](#adapter-err-tls-primary-watch) | `tls.primary.watch-failed` | `[tls] primary cert watch failed to start, cluster hot-reload disabled (server keeps running)` |
| [ADAPTER-ERR-SHUTDOWN-LISTENER-REJECTED](#adapter-err-shutdown-listener-rejected) | `shutdown.listener-rejected` | `[svelte-adapter-uws] a sveltekit:shutdown listener rejected` |
| [ADAPTER-ERR-SHUTDOWN-LISTENER-THREW](#adapter-err-shutdown-listener-threw) | `shutdown.listener-threw` | `[svelte-adapter-uws] a sveltekit:shutdown listener threw` |
| [ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED](#adapter-err-shutdown-requests-dropped) | `shutdown.requests-dropped` | `[svelte-adapter-uws] in-flight requests did not finish within the shutdown budget (` |
| [ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED](#adapter-err-shutdown-listeners-unsettled) | `shutdown.listeners-unsettled` | `[svelte-adapter-uws] sveltekit:shutdown listeners did not settle within the shutdown budget (` |
| [ADAPTER-ERR-SHUTDOWN-FAILED](#adapter-err-shutdown-failed) | `shutdown.failed` | `[svelte-adapter-uws] graceful shutdown failed` |
| [ADAPTER-ERR-WORKER-RESTART-LIMIT](#adapter-err-worker-restart-limit) | `cluster.worker.restart-limit` | `[svelte-adapter-uws] Worker restart limit reached for ` |
| [ADAPTER-ERR-TLS-DEGRADED-EXPIRY](#adapter-err-tls-degraded-expiry) | `tls.degraded-expiry-alert` | `[svelte-adapter-uws] [tls] certificate hot-reload is DEGRADED (` |
| [ADAPTER-ERR-SENDTO-ASYNC-FILTER](#adapter-err-sendto-async-filter) | `ws.sendto.async-filter-refused` | `[ws] platform.sendTo filter returned a Promise; treating as fail-closed.` |
| [ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW](#adapter-err-ws-shutdown-hook-threw) | `ws.shutdown-hook.threw` | `[ws] the WebSocket shutdown hook threw` |
| [ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED](#adapter-err-ws-shutdown-hook-unsettled) | `ws.shutdown-hook.unsettled` | `[ws] the WebSocket shutdown hook has not settled after ` |
| [ADAPTER-ERR-MESSAGE-HOOK](#adapter-err-message-hook) | `ws.message-hook.threw` | `[ws] the message hook threw` |
| [ADAPTER-ERR-RECOVER-HOOK](#adapter-err-recover-hook) | `ws.recover-hook.threw` | `[ws] the recover-on-subscribe hook threw` |
| [ADAPTER-ERR-METRICS-MODULE-SHAPE](#adapter-err-metrics-module-shape) | `ws.metrics.module-shape` | `[ws] the metrics module must export a registry object as `default`, `metrics` or `registry`; got ` |
| [ADAPTER-ERR-METRICS-INSTRUMENT](#adapter-err-metrics-instrument) | `ws.metrics.instrument-threw` | `[ws] a metrics instrument threw; further errors from it are suppressed` |
| [ADAPTER-ERR-POSTURE-EXPORT-DISABLED](#adapter-err-posture-export-disabled) | `ws.posture-export.disabled` | `[ws] posture export disabled: ` |
| [ADAPTER-ERR-POSTURE-OBSERVER](#adapter-err-posture-observer) | `ws.posture-observer.threw` | `[ws] a posture transition handler threw` |
| [ADAPTER-ERR-UPGRADE-DEFERRED](#adapter-err-upgrade-deferred) | `ws.upgrade.deferred-failed` | `[ws] a deferred upgrade failed` |
| [ADAPTER-ERR-WAITING-ROOM-FALLBACK](#adapter-err-waiting-room-fallback) | `ws.waiting-room.renderer-failed` | `[svelte-adapter-uws] the waiting-room renderer failed; serving the built-in English page instead` |
| [ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE](#adapter-err-diagnostic-record-shape) | `ws.diagnostic.record-shape` | `[ws] operational event dropped, invalid record shape` |
| [ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE](#adapter-err-diagnostic-render-collapse) | `ws.diagnostic.render-collapse` | `[ws] diagnostic render failed: ` |
| [ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE](#adapter-err-diagnostic-console-write) | `ws.diagnostic.console-write` | `[ws] diagnostic rendered but the console refused it: ` |
| [ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE](#adapter-err-diagnostic-sink-notice) | `ws.diagnostic.sink-notice` | `[ws] operational sink failed and its failure notice could not be built: ` |
| [ADAPTER-ERR-RESOURCE-GROWTH](#adapter-err-resource-growth) | `ws.resource-growth.trending` | `[ws] resource-growth auditor: ` |
| [ADAPTER-ERR-RELAY-SPILL-QUARANTINE](#adapter-err-relay-spill-quarantine) | `cluster-relay.spill-quarantine` | `[primary] relay spill quarantining ` |
| [ADAPTER-ERR-POSTURE-TRANSITION](#adapter-err-posture-transition) | `ws.protection-posture.transition` | `[ws] protection posture ` |
| [ADAPTER-ERR-WORKER-EXIT-SIGKILL](#adapter-err-worker-exit-sigkill) | `cluster.worker-exit-sigkill` | `[primary] worker ` |

## Emitted diagnostic event coverage

This inventory is derived at generation time by scanning `src/runtime/`, `src/observability.js`,
and `src/vite.js` for emitted diagnostic events; the runtime emits 41 distinct events.
The 38 indexed above carry stable IDs and full operator guidance; the remaining 3
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
- `divergence.quiet-state` - [ADAPTER-ERR-DIVERGENCE-QUIET](#adapter-err-divergence-quiet)
- `invariant.violated` - [ADAPTER-ERR-INVARIANT](#adapter-err-invariant)
- `metrics.merge-failed` - [ADAPTER-ERR-METRICS-MERGE](#adapter-err-metrics-merge)
- `metrics.mirror-read-failed` - [ADAPTER-ERR-METRICS-MIRROR-READ](#adapter-err-metrics-mirror-read)
- `metrics.primary-unreachable` - [ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE](#adapter-err-metrics-primary-unreachable)
- `operational.sink.failed` - [ADAPTER-ERR-SINK-FAILED](#adapter-err-sink-failed)
- `pressure.listener-failed` - [ADAPTER-ERR-PRESSURE-LISTENER](#adapter-err-pressure-listener)
- `pressure.publish-rate-listener-failed` - [ADAPTER-ERR-PRESSURE-RATE-LISTENER](#adapter-err-pressure-rate-listener)
- `pressure.runaway-publisher` - [ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER](#adapter-err-pressure-runaway-publisher)
- `pressure.topic-registry-high` - [ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY](#adapter-err-pressure-topic-registry)
- `egress.publish-refused` - [ADAPTER-ERR-EGRESS-REFUSED](#adapter-err-egress-refused)
- `egress.window-evicted` - [ADAPTER-ERR-EGRESS-EVICTED](#adapter-err-egress-evicted)
- `egress.tenant-resolver-invalid` - [ADAPTER-ERR-EGRESS-TENANT-RESOLVER](#adapter-err-egress-tenant-resolver)
- `resume.hook-failed` - [ADAPTER-ERR-RESUME-HOOK](#adapter-err-resume-hook)
- `resume.hook-read-failed` - [ADAPTER-ERR-RESUME-HOOK-READ](#adapter-err-resume-hook-read)
- `runtime.authenticate.failed` - [ADAPTER-ERR-AUTHENTICATE](#adapter-err-authenticate)
- `runtime.relay-gap.detected` - [ADAPTER-ERR-RELAY-GAP](#adapter-err-relay-gap)
- `runtime.ssr.failed` - [ADAPTER-ERR-SSR](#adapter-err-ssr)
- `runtime.websocket-upgrade.failed` - [ADAPTER-ERR-UPGRADE-HOOK](#adapter-err-upgrade-hook)
- `runtime.websocket-attribution.failed` - [ADAPTER-ERR-ATTRIBUTION](#adapter-err-attribution)
- `subscribe.batch-hook-failed` - [ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK](#adapter-err-subscribe-batch-hook)
- `subscribe.batch-result-read-failed` - [ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT](#adapter-err-subscribe-batch-result)
- `subscribe.hook-failed` - [ADAPTER-ERR-SUBSCRIBE-HOOK](#adapter-err-subscribe-hook)
- `tls.reload-skipped` - [ADAPTER-ERR-TLS-RELOAD-SKIPPED](#adapter-err-tls-reload-skipped)
- `tls.swap-failed` - [ADAPTER-ERR-TLS-SWAP](#adapter-err-tls-swap)
- `tls.watch-failed` - [ADAPTER-ERR-TLS-WATCH](#adapter-err-tls-watch)

Indexed console lines (no diagnostic event; the searchable key is the printed prefix and
the stable ID tag on the line):

- `[svelte-adapter-uws] Invalid CLUSTER_WORKERS value: '` - [ADAPTER-ERR-CLUSTER-CONFIG-WORKERS](#adapter-err-cluster-config-workers)
- `[svelte-adapter-uws] websocket.workers.compute (` - [ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE](#adapter-err-cluster-config-compute)
- `[svelte-adapter-uws] Invalid CLUSTER_MODE: '` - [ADAPTER-ERR-CLUSTER-CONFIG-MODE](#adapter-err-cluster-config-mode)
- `[svelte-adapter-uws] CLUSTER_MODE=reuseport requires Linux (SO_REUSEPORT is not reliable on ` - [ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT](#adapter-err-cluster-config-reuseport)
- `[tls] boot certificate unreadable on the primary (hot-reload broadcast stays armed)` - [ADAPTER-ERR-TLS-PRIMARY-BOOT-READ](#adapter-err-tls-primary-boot-read)
- `[tls] renewed certificate unreadable on the primary (workers gate on their own reads)` - [ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ](#adapter-err-tls-primary-reload-read)
- `[tls] primary cert watch failed to start, cluster hot-reload disabled (server keeps running)` - [ADAPTER-ERR-TLS-PRIMARY-WATCH](#adapter-err-tls-primary-watch)
- `[svelte-adapter-uws] a sveltekit:shutdown listener rejected` - [ADAPTER-ERR-SHUTDOWN-LISTENER-REJECTED](#adapter-err-shutdown-listener-rejected)
- `[svelte-adapter-uws] a sveltekit:shutdown listener threw` - [ADAPTER-ERR-SHUTDOWN-LISTENER-THREW](#adapter-err-shutdown-listener-threw)
- `[svelte-adapter-uws] in-flight requests did not finish within the shutdown budget (` - [ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED](#adapter-err-shutdown-requests-dropped)
- `[svelte-adapter-uws] sveltekit:shutdown listeners did not settle within the shutdown budget (` - [ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED](#adapter-err-shutdown-listeners-unsettled)
- `[svelte-adapter-uws] graceful shutdown failed` - [ADAPTER-ERR-SHUTDOWN-FAILED](#adapter-err-shutdown-failed)
- `[svelte-adapter-uws] Worker restart limit reached for ` - [ADAPTER-ERR-WORKER-RESTART-LIMIT](#adapter-err-worker-restart-limit)
- `[svelte-adapter-uws] [tls] certificate hot-reload is DEGRADED (` - [ADAPTER-ERR-TLS-DEGRADED-EXPIRY](#adapter-err-tls-degraded-expiry)
- `[ws] platform.sendTo filter returned a Promise; treating as fail-closed.` - [ADAPTER-ERR-SENDTO-ASYNC-FILTER](#adapter-err-sendto-async-filter)
- `[ws] the WebSocket shutdown hook threw` - [ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW](#adapter-err-ws-shutdown-hook-threw)
- `[ws] the WebSocket shutdown hook has not settled after ` - [ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED](#adapter-err-ws-shutdown-hook-unsettled)
- `[ws] the message hook threw` - [ADAPTER-ERR-MESSAGE-HOOK](#adapter-err-message-hook)
- `[ws] the recover-on-subscribe hook threw` - [ADAPTER-ERR-RECOVER-HOOK](#adapter-err-recover-hook)
- `[ws] the metrics module must export a registry object as `default`, `metrics` or `registry`; got ` - [ADAPTER-ERR-METRICS-MODULE-SHAPE](#adapter-err-metrics-module-shape)
- `[ws] a metrics instrument threw; further errors from it are suppressed` - [ADAPTER-ERR-METRICS-INSTRUMENT](#adapter-err-metrics-instrument)
- `[ws] posture export disabled: ` - [ADAPTER-ERR-POSTURE-EXPORT-DISABLED](#adapter-err-posture-export-disabled)
- `[ws] a posture transition handler threw` - [ADAPTER-ERR-POSTURE-OBSERVER](#adapter-err-posture-observer)
- `[ws] a deferred upgrade failed` - [ADAPTER-ERR-UPGRADE-DEFERRED](#adapter-err-upgrade-deferred)
- `[svelte-adapter-uws] the waiting-room renderer failed; serving the built-in English page instead` - [ADAPTER-ERR-WAITING-ROOM-FALLBACK](#adapter-err-waiting-room-fallback)
- `[ws] operational event dropped, invalid record shape` - [ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE](#adapter-err-diagnostic-record-shape)
- `[ws] diagnostic render failed: ` - [ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE](#adapter-err-diagnostic-render-collapse)
- `[ws] diagnostic rendered but the console refused it: ` - [ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE](#adapter-err-diagnostic-console-write)
- `[ws] operational sink failed and its failure notice could not be built: ` - [ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE](#adapter-err-diagnostic-sink-notice)
- `[ws] resource-growth auditor: ` - [ADAPTER-ERR-RESOURCE-GROWTH](#adapter-err-resource-growth)
- `[primary] relay spill quarantining ` - [ADAPTER-ERR-RELAY-SPILL-QUARANTINE](#adapter-err-relay-spill-quarantine)
- `[ws] protection posture ` - [ADAPTER-ERR-POSTURE-TRANSITION](#adapter-err-posture-transition)
- `[primary] worker ` - [ADAPTER-ERR-WORKER-EXIT-SIGKILL](#adapter-err-worker-exit-sigkill)

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
- **Consequence:** The process never becomes ready. Single-process, the bind failure exits with status 1. In acceptor mode the primary hard-exits with workers still alive, which is delivered as a self-SIGKILL rather than an exit status. In reuseport mode only the failing worker exits; the process stays up while the supervisor respawns it.
- **Automatic recovery:** None single-process or in acceptor mode. In reuseport mode the supervisor respawns the failed worker and the replacement retries the same bind - under a persistent conflict each attempt fails the same way until the slot exhausts its restart budget and the whole service goes down, the outcome ADAPTER-ERR-WORKER-RESTART-LIMIT documents from the other end.
- **Next action:** Check address availability, port conflicts, and bind permissions, then restart the process. In reuseport mode a repeating restart line for the same worker slot beside this one is the same conflict burning restart budget, not a second fault.
- **Operator shortlink:** `https://svti.me/listen-failed`
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
- **Operator shortlink:** `https://svti.me/ws-handler-load`
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
- **Operator shortlink:** `https://svti.me/ws-handler-load`
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
- **Operator shortlink:** `https://svti.me/native-load`
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
- **Operator shortlink:** `https://svti.me/request-timeout`
- **Runtime help:** `docs/errors.md#adapter-err-request-timeout`
- **Runtime sources:** [src/runtime/handler/platform.js](../src/runtime/handler/platform.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-request-closed"></a>
## `ADAPTER-ERR-REQUEST-CLOSED`

- **Code/event:** `websocket.request.connection-closed`
- **Message prefix:** `connection closed`
- **Cause:** The target WebSocket closed around a platform.request - before the request frame could be sent at all, or with the frame already handed to the transport and unanswered.
- **Consequence:** The caller promise rejects. The rejection detail names which side of transmission the close landed on: a frame that was never sent leaves the remote outcome known - nothing was requested - while a frame handed to the transport leaves it unknown.
- **Automatic recovery:** None. The adapter does not retry requests because replay may duplicate an operation.
- **Next action:** Read the rejection detail first. A request whose frame was never sent is safe to retry as-is once the connection recovers; a sent but unanswered request must be reconciled or retried only through an idempotent operation.
- **Operator shortlink:** `https://svti.me/request-closed`
- **Runtime help:** `docs/errors.md#adapter-err-request-closed`
- **Runtime sources:** [src/runtime/handler/platform.js](../src/runtime/handler/platform.js), [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

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
- **Consequence:** The worker exits deliberately rather than growing an unbounded queue. Connections on it drop and those clients reconnect to whichever workers are still up.
- **Automatic recovery:** Within the slot restart budget. The worker exits and the supervisor respawns it, but a slot that keeps exiting without reaching stable uptime exhausts that budget and the primary then exits the whole process (see ADAPTER-ERR-WORKER-RESTART-LIMIT). A blocked primary - the usual cause here - starves every worker at once, so repeated occurrences are the shape that reaches exhaustion rather than a series each worker recovers from.
- **Next action:** Read the reason, droppedBytes, and pendingAgeMs attributes. A blocked or slow primary is the usual cause; if the backlog is legitimate peak traffic, raise the relay ring pending ceilings. Check whether siblings are reporting this too - a process-wide cause will not resolve by replacing one worker.
- **Runtime help:** `docs/errors.md#adapter-err-relay-spill-overflow`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-cluster-worker-error"></a>
## `ADAPTER-ERR-CLUSTER-WORKER-ERROR`

- **Code/event:** `cluster.worker-error`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.cluster event=cluster.worker-error severity=error] A worker thread reported an error.`
- **Cause:** A worker thread emitted an error event to the primary, which usually means it threw outside a request or failed during startup.
- **Consequence:** That worker is unhealthy. Its connections are lost when it exits, and cluster capacity drops until it is replaced.
- **Automatic recovery:** The supervisor replaces an exiting worker; the error itself is reported, not retried. Under a startup or import fault every replacement hits the same error, each attempt is charged against the slot's restart budget, and an exhausted slot takes the whole service down - the outcome ADAPTER-ERR-WORKER-RESTART-LIMIT documents from the other end.
- **Next action:** Read the attached error attribute. A repeating worker error at startup usually means a configuration or import fault that every replacement will hit as well.
- **Runtime help:** `docs/errors.md#adapter-err-cluster-worker-error`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-divergence"></a>
## `ADAPTER-ERR-DIVERGENCE`

- **Code/event:** `divergence.detected`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.divergence event=divergence.detected severity=error] Cross-worker state divergence was detected; evidence is retained behind the authenticated diagnostic lookup.`
- **Cause:** Workers that should hold identical state reported different state hashes.
- **Consequence:** Clients on different workers can observe different state for the same topic. The log line carries only an opaque diagnostic id, because per-thread hashes and keyed sequence summaries are identifier-bearing.
- **Automatic recovery:** None by default: divergence is reported, never silently reconciled. With RESTART_ON_STATE_DIVERGENCE=1 the primary asks each minority worker to exit, and the exit handler respawns it under the same slot restart budget as any other worker exit, so the replacement reconnects and re-converges - automatic per incident, and only when that knob is explicitly on. The quiet lane never restarts anyone (see ADAPTER-ERR-DIVERGENCE-QUIET).
- **Next action:** Resolve the diagnosticId attribute to its retained per-worker evidence, then treat it as a correctness incident. In an adapter-only deployment that lookup is `platform.diagnostic(id)`; the authenticated admin HTTP route exists only where the realtime layer is configured to serve one.
- **Runtime help:** `docs/errors.md#adapter-err-divergence`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-divergence-quiet"></a>
## `ADAPTER-ERR-DIVERGENCE-QUIET`

- **Code/event:** `divergence.quiet-state`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.divergence event=divergence.quiet-state severity=warn] Workers disagree about quiet-topic history; this is expected after a worker restart and never triggers a restart.`
- **Cause:** The cross-worker comparison is split by activity: topics whose sequence moved recently carry the restart-authorized vote, while quiet topics ride this log-only lane. A worker that restarted holds none of its siblings' quiet-topic history, and with nobody publishing those topics it can never re-learn it, so the quiet hashes legitimately disagree. The report requires the same disagreement to persist across consecutive comparison epochs, so a one-round classification skew between report phases never logs.
- **Consequence:** No effect on current traffic: nothing is being delivered on a quiet topic by definition. The disagreement can also be the trace of a PAST loss - a final frame one worker missed on a topic that then went quiet surfaces here rather than in the restart lane - so it is visibility without kill authority, not proof of health. The record carries only counts and an epoch.
- **Automatic recovery:** The disagreement is reported once per distinct constellation (deduplicated), re-arms after agreement, and clears on its own when the quiet topics see traffic again or the cluster recycles together.
- **Next action:** Usually nothing: correlate with a recent worker restart. If no worker restarted and the constellation keeps changing, treat it as a lead for the active-lane divergence diagnostics instead.
- **Runtime help:** `docs/errors.md#adapter-err-divergence-quiet`
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
- **Cause:** Combining the delivered per-worker snapshots into one cluster answer threw. Every report a primary can deliver is normalized before it is combined - non-object samples are dropped, names outside the manifest are dropped, histogram shapes are validated against their declared buckets, non-numeric values collapse to NaN, label sets are bounded in key count and value length with keys held to the exposition label grammar, the registration inventory is trimmed to a bounded length, and the document seats a bounded number of distinct series - so no message that survives the thread boundary reaches the combine step in a shape it does not handle. A throw here is a defect in the merge itself or a rewrapped runtime built-in underneath it, not bad input. The catch exists because every concurrent scrape on the worker shares one in-flight promise: a throw that escaped it would leave that promise unsettled and hang every later scrape on the worker.
- **Consequence:** That scrape reports one worker instead of the cluster, so counters appear to drop sharply for a single interval.
- **Automatic recovery:** Yes. The next scrape attempts the merge again.
- **Next action:** Treat an isolated occurrence as a degraded scrape, not lost data; alerting on absolute counter values across this interval will produce false alarms. Because no deliverable report can reach this line, a repeat is an adapter defect - report it with the attached error rather than hunting for a misbehaving worker.
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
- **Cause:** Posting the snapshot request to the primary threw. A dead channel does not do this: posting to a closed or torn-down MessagePort is a silent no-op on current Node, and the request itself is a small plain literal that always survives structured clone. The throw comes from whatever wrapped the worker's message port - process-wide instrumentation that rewraps postMessage can make the underlying call throw a DataCloneError the moment its piggybacked context carries a value structured clone refuses, or raise an error of its own.
- **Consequence:** The scrape is answered from the local worker and marked degraded rather than failing outright, so the endpoint stays up while the numbers describe one worker.
- **Automatic recovery:** Yes. The next scrape posts to the primary again.
- **Next action:** Read the attached error and look at whatever instruments the process; a DataCloneError names the wrapper's payload, not the adapter's. A primary that died or a port that closed does NOT emit this event - that posting is a silent no-op and the collection deadline answers degraded without a line - so the absence of this line is not evidence the primary is healthy. Compare the expected and reporting worker counts for that.
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
- **Cause:** An application listener registered through platform.onPressure for pressure-state notifications threw.
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
- **Cause:** One topic exceeded its configured publish pressure threshold. The event is emitted only when no publish-rate listener is registered, and per topic it is throttled to once a minute through a bounded dedup table - with more simultaneously runaway topics than the table holds, a topic can re-report sooner - so it reports the condition rather than every crossing.
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
- **Next action:** Check whether topic names embed unbounded identifiers - the `topPublishers` attribute names the busiest topics at the crossing and `topicCount` carries the count that tripped it. The line fires ONCE per process: it is latched after the first crossing and never repeats, and the runtime publishes no continuous topic-cardinality metric, so neither this line nor the metrics will tell you whether cardinality later fell or kept climbing. The naming scheme is what settles that. Unbounded cardinality is a slow leak rather than a spike, so act at the warning rather than at exhaustion.
- **Runtime help:** `docs/errors.md#adapter-err-pressure-topic-registry`
- **Runtime sources:** [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js)

<a id="adapter-err-egress-refused"></a>
## `ADAPTER-ERR-EGRESS-REFUSED`

- **Code/event:** `egress.publish-refused`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.publish-refused severity=warn] A publish crossed a configured egress ceiling and was refused.`
- **Cause:** A publish-family call would have taken one topic or one tenant past a `websocket.egress` ceiling for the current window, so it was refused before anything was stamped, serialized, or handed to the native layer. Per (scope, topic) the line is throttled to once a minute through a bounded dedup table, so it reports the condition rather than every refusal; the exact counts are `egress_refused_total{scope}` and the pressure snapshot egress figures.
- **Consequence:** The refused publish delivered nothing anywhere: no local subscriber received it, no cross-worker relay fired, and no sequence number was consumed, so subscribers see no gap. The caller received the refusal shape (`false`, a zero count, or `{ seq: null, delivered: 0 }` on the game lane) and owns any retry.
- **Automatic recovery:** Yes, by time: the window rotates (default 1000 ms) and publishing under the ceiling resumes on its own. Relayed frames from sibling workers are never refused.
- **Next action:** Decide whether the traffic or the ceiling is wrong. The attributes name the scope, the dimension (messages, bytes, or deliveries), and the configured limit; read the topic reference beside your `pressure.topPublishers` deliveries figures to see whether one publisher is spending the budget. Raise the ceiling in `websocket.egress` if the load is intended. On the dev plugin this event is the whole report: dev enforces the ceilings live but registers no metrics and reports its pressure egress figures as zeros, so the counts named above exist only in production and createTestServer.
- **Runtime help:** `docs/errors.md#adapter-err-egress-refused`
- **Runtime sources:** [src/runtime/handler/egress-budget.js](../src/runtime/handler/egress-budget.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-egress-evicted"></a>
## `ADAPTER-ERR-EGRESS-EVICTED`

- **Code/event:** `egress.window-evicted`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.window-evicted severity=warn] The egress ledger dropped a usage window that was still counting, so that key is unmetered for the rest of it.`
- **Cause:** More distinct topics or tenants published inside one window than the ledger can hold, so seating a new key took a live window from another. The ledger reclaims lapsed windows first and only evicts a live one when none is left, which makes this a statement about topic or tenant CARDINALITY rather than about publish volume. Per scope the line is throttled to once a minute, so it reports the condition rather than every eviction - which would fire at the rate of the churn causing it.
- **Consequence:** The evicted key starts its next publish from an empty window, so its ceiling cannot refuse anything it already spent: enforcement is not wrong for other keys, it is ABSENT for that one until the window it lost would have rotated. A deployment that evicts steadily is one where the busiest topics are metered and the tail is not.
- **Automatic recovery:** Partly, and only by the traffic changing: the ledger holds its bound and keeps serving, and cardinality falling back under the bound restores full enforcement on its own. Nothing raises the bound.
- **Next action:** Treat it as a cardinality problem, not a capacity one. Check whether topic names embed unbounded identifiers, and scope tenant ids to the tenants you actually meter. The exact count is `egress_evicted_total{scope}` in production and createTestServer; the dev plugin registers no metrics, so there this line is the whole report.
- **Runtime help:** `docs/errors.md#adapter-err-egress-evicted`
- **Runtime sources:** [src/runtime/handler/egress-budget.js](../src/runtime/handler/egress-budget.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-egress-tenant-resolver"></a>
## `ADAPTER-ERR-EGRESS-TENANT-RESOLVER`

- **Code/event:** `egress.tenant-resolver-invalid`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.egress event=egress.tenant-resolver-invalid severity=error] The egress tenant resolver returned an unusable id; publishes are charged unattributed.`
- **Cause:** The handler module `egressTenantOf(topic)` export threw, or returned something other than null/undefined or a string of `[a-zA-Z0-9_-]` (1-64 chars) - the same id rule the attribution resolver enforces. The line fires once per worker: the defect repeats on every publish and refusing to attribute is already the fail-closed behavior.
- **Consequence:** Publishes on the affected topics are charged as unattributed: the topic-scope ceilings and the worker egress figures still apply, but no tenant window is charged, so a tenant ceiling cannot bound this traffic until the resolver is fixed. Nothing is misattributed - an invalid id is never used as a key.
- **Automatic recovery:** None. The resolver stays installed and its valid answers keep working; only invalid results (and thrown calls) stay unattributed.
- **Next action:** Fix `egressTenantOf` to return a rule-conforming tenant id or null. The attributes carry the returned value TYPE only; reproduce locally by calling the resolver with the topics your server publishes.
- **Runtime help:** `docs/errors.md#adapter-err-egress-tenant-resolver`
- **Runtime sources:** [src/runtime/handler/egress-budget.js](../src/runtime/handler/egress-budget.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-resume-hook"></a>
## `ADAPTER-ERR-RESUME-HOOK`

- **Code/event:** `resume.hook-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.resume event=resume.hook-failed severity=error] The resume hook threw; the client falls back to a fresh subscribe.`
- **Cause:** The application resume hook threw while answering a client GAP-FILL request, so some or all of the replay frames it owed were never sent. The same hook failing on the subscribe-time backfill is ADAPTER-ERR-RECOVER-HOOK instead.
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
- **Consequence:** That topic loses only the hook's watermark report, not its replay: the hook has already run to completion, so whatever it replayed is on the wire, and the held-frame flush falls back to the pre-window floor and delivers the whole captured window. The client can therefore see duplicates inside that window rather than a gap. Other topics in the same batch are unaffected: the read is guarded here precisely so one unreadable topic cannot abort the loop and leak the rest as permanently in-flight.
- **Automatic recovery:** The subscribe completes on the ordinary no-watermark path, the same answer a hook returning a non-number gives. Possible re-delivery inside the captured window is the cost; nothing is silently lost, because an overflowed or refused flush still escalates to the truncation signal like any other.
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
- **Consequence:** A failure before the response starts is answered with an error response. A response already streaming its body is aborted instead, so the client sees the truncation rather than a clean end that reads as a complete response. Other requests and WebSocket connections are unaffected.
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

<a id="adapter-err-attribution"></a>
## `ADAPTER-ERR-ATTRIBUTION`

- **Code/event:** `runtime.websocket-attribution.failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.websocket-attribution event=runtime.websocket-attribution.failed severity=error] The WebSocket attribution hook failed; the connection was refused at open.`
- **Cause:** The handler module's `attribution` export threw, returned a promise, returned a misshaped result, or returned an id outside the allowed form (a string of [a-zA-Z0-9_-], at most 64 characters).
- **Consequence:** That connection is closed with code 1008 before the application open hook runs. Attribution is fail-closed: a connection that cannot be attributed is refused rather than admitted unattributed, because an unattributed admission would silently stand down every tenant-scoped limit that reads the attribution.
- **Automatic recovery:** None for that connection. The client may reconnect, which runs the resolver again against a fresh userData.
- **Next action:** Read the attached error and fix the `attribution` export: return { tenantId?, principalId?, entitlement? } synchronously - each present value a string of [a-zA-Z0-9_-] with 1-64 characters - or null/undefined for an unattributed connection. Resolve identity itself in the upgrade hook; attribution only derives from the userData that hook produced.
- **Runtime help:** `docs/errors.md#adapter-err-attribution`
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
- **Next action:** Return a plain object keyed by topic from the hook, and keep property reads on it free of side effects. An array is not that shape: its entries are read back under index keys, so its denials name topics like 0 and 1 and every real topic in the batch is silently allowed.
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
- **Consequence:** The swap is partial: a host already moved to the new certificate has a fresh, empty SNI router until the retry replays the routes, so its handshakes complete while its requests are force-closed; a host removed but not yet re-added falls back to the default context, so it serves the boot-time certificate and its handshakes complete wherever that certificate covers it. The TLS degraded state is set for the duration.
- **Automatic recovery:** A one-shot retry is armed from the failure itself, rather than from the next filesystem event, because the throw may have consumed the last event of a renewal burst and the next one could be months away. A persistent fault therefore retries at that cadence instead of spinning.
- **Next action:** Probe every SNI host with an HTTP request rather than only a handshake: both partial shapes complete handshakes while a host is either force-closing requests or still serving the boot certificate. Then read the attached error to pick the repair - certificate material explains only a throw inside the apply step, while a route-replay failure has nothing wrong with the material and resolves through the armed retry or a restart.
- **Runtime help:** `docs/errors.md#adapter-err-tls-swap`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-tls-watch"></a>
## `ADAPTER-ERR-TLS-WATCH`

- **Code/event:** `tls.watch-failed`
- **Message prefix:** `[lantean/diagnostic source=svelte-adapter-uws component=runtime.tls event=tls.watch-failed severity=error] The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.`
- **Cause:** The filesystem watch on the certificate directory could not be established.
- **Consequence:** Certificate hot reload is off for the process lifetime and the TLS degraded state is set - and stays set, because no later reload can resurrect the watcher. One arm-time catch-up read runs right after this failure, so a renewal already on disk at that moment is still served; nothing that lands afterwards is ever picked up, and the failure surfaces much later as an expired certificate.
- **Automatic recovery:** None for the watch itself: it is not retried, so this does not resolve without a restart. The arm-time catch-up may still swap in a renewal that was already on disk when the watch failed; the degraded state and its expiry sentinel survive even that success.
- **Next action:** Fix the path or permissions and restart the process. Until then, treat certificate renewal as requiring a restart, and alert on certificate expiry independently. In a clustered deployment the primary reports its own watch failure separately as ADAPTER-ERR-TLS-PRIMARY-WATCH.
- **Runtime help:** `docs/errors.md#adapter-err-tls-watch`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-cluster-config-workers"></a>
## `ADAPTER-ERR-CLUSTER-CONFIG-WORKERS`

- **Code/event:** `cluster.config.invalid-workers`
- **Message prefix:** `[svelte-adapter-uws] Invalid CLUSTER_WORKERS value: '`
- **Cause:** CLUSTER_WORKERS is set to something other than a positive integer or 'auto'.
- **Consequence:** The cluster primary exits with status 1 before spawning any worker; the service never comes up.
- **Automatic recovery:** None. Startup configuration is validated once, at boot.
- **Next action:** Set CLUSTER_WORKERS to a positive integer or 'auto' (or unset it) and restart.
- **Runtime help:** `docs/errors.md#adapter-err-cluster-config-workers`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-cluster-config-compute"></a>
## `ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE`

- **Code/event:** `cluster.config.invalid-compute-count`
- **Message prefix:** `[svelte-adapter-uws] websocket.workers.compute (`
- **Cause:** websocket.workers.compute is greater than or equal to the total worker count, which would leave no I/O worker to listen.
- **Consequence:** The cluster primary exits with status 1 before spawning any worker; the service never comes up.
- **Automatic recovery:** None. Startup configuration is validated once, at boot.
- **Next action:** Lower websocket.workers.compute or raise CLUSTER_WORKERS so at least one I/O worker remains.
- **Runtime help:** `docs/errors.md#adapter-err-cluster-config-compute`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-cluster-config-mode"></a>
## `ADAPTER-ERR-CLUSTER-CONFIG-MODE`

- **Code/event:** `cluster.config.invalid-mode`
- **Message prefix:** `[svelte-adapter-uws] Invalid CLUSTER_MODE: '`
- **Cause:** CLUSTER_MODE is set to an unknown value.
- **Consequence:** The cluster primary exits with status 1 before spawning any worker; the service never comes up.
- **Automatic recovery:** None. Startup configuration is validated once, at boot.
- **Next action:** Use 'reuseport' (Linux only) or 'acceptor', or unset CLUSTER_MODE for the platform default.
- **Runtime help:** `docs/errors.md#adapter-err-cluster-config-mode`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-cluster-config-reuseport"></a>
## `ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT`

- **Code/event:** `cluster.config.reuseport-unsupported`
- **Message prefix:** `[svelte-adapter-uws] CLUSTER_MODE=reuseport requires Linux (SO_REUSEPORT is not reliable on `
- **Cause:** CLUSTER_MODE=reuseport was requested on a platform other than Linux, where the kernel does not distribute accepts reliably across listeners.
- **Consequence:** The cluster primary exits with status 1 before spawning any worker; the service never comes up.
- **Automatic recovery:** None. Startup configuration is validated once, at boot.
- **Next action:** Remove CLUSTER_MODE to use the default acceptor mode on this platform, or deploy on Linux to keep reuseport.
- **Operator shortlink:** `https://svti.me/cluster-mode`
- **Runtime help:** `docs/errors.md#adapter-err-cluster-config-reuseport`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-tls-primary-boot-read"></a>
## `ADAPTER-ERR-TLS-PRIMARY-BOOT-READ`

- **Code/event:** `tls.primary.boot-read-failed`
- **Message prefix:** `[tls] boot certificate unreadable on the primary (hot-reload broadcast stays armed)`
- **Cause:** The cluster primary could not read or parse the boot certificate while arming the hot-reload watch.
- **Consequence:** Primary-side expiry observability starts blind: no baseline identity or expiry is recorded, so a later reload failure is reported without the number that says how urgent it is. Workers gate on their own certificate reads and keep serving; the reload broadcast stays armed.
- **Automatic recovery:** The next reload that reads cleanly records identity and expiry.
- **Next action:** Verify the certificate path and PEM contents on the primary host.
- **Runtime help:** `docs/errors.md#adapter-err-tls-primary-boot-read`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-tls-primary-reload-read"></a>
## `ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ`

- **Code/event:** `tls.primary.reload-read-failed`
- **Message prefix:** `[tls] renewed certificate unreadable on the primary (workers gate on their own reads)`
- **Cause:** A certificate change was seen on disk but the renewed material was unreadable or incomplete when the primary read it.
- **Consequence:** The reload broadcast still goes out and every worker gates on its OWN read, so a primary-local failure (a read racing the renewal writer at the primary debounce instant) can leave the workers correctly swapped while only the primary is blind. What certainly failed is the primary side: no renewed identity or expiry is recorded, the primary enters the degraded TLS state with its expiry sentinel armed, and READINESS PROBES STAY GREEN. When the renewal itself is broken, every worker read fails the same way and the fleet keeps the previous certificate.
- **Automatic recovery:** Every certificate change broadcasts again; the next change the primary reads cleanly records identity and expiry and clears the degraded state.
- **Next action:** Check whether the workers actually swapped (compare the served certificate against the renewal on disk) before assuming the fleet is stale, then fix the certificate material or the primary-host read.
- **Runtime help:** `docs/errors.md#adapter-err-tls-primary-reload-read`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-tls-primary-watch"></a>
## `ADAPTER-ERR-TLS-PRIMARY-WATCH`

- **Code/event:** `tls.primary.watch-failed`
- **Message prefix:** `[tls] primary cert watch failed to start, cluster hot-reload disabled (server keeps running)`
- **Cause:** The filesystem watch on the certificate directory could not start on the cluster primary, commonly a not-yet-mounted secret volume or a mistyped path.
- **Consequence:** Cluster-wide certificate hot reload is off for the process lifetime: with no watcher on the primary, no worker is ever told to reload, so the whole fleet serves its current certificate until it expires. The primary enters the degraded TLS state; readiness probes stay green throughout.
- **Automatic recovery:** None. The watch is not retried, so this does not resolve without a restart.
- **Next action:** Fix the path or permissions and restart the primary. Until then, treat certificate renewal as requiring a restart and alert on certificate expiry independently.
- **Runtime help:** `docs/errors.md#adapter-err-tls-primary-watch`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-shutdown-listener-rejected"></a>
## `ADAPTER-ERR-SHUTDOWN-LISTENER-REJECTED`

- **Code/event:** `shutdown.listener-rejected`
- **Message prefix:** `[svelte-adapter-uws] a sveltekit:shutdown listener rejected`
- **Cause:** An async sveltekit:shutdown listener's promise rejected during shutdown.
- **Consequence:** That listener's cleanup did not complete. The rejection is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.
- **Automatic recovery:** Not applicable; shutdown proceeds without the failed cleanup.
- **Next action:** Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.
- **Runtime help:** `docs/errors.md#adapter-err-shutdown-listener-rejected`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-shutdown-listener-threw"></a>
## `ADAPTER-ERR-SHUTDOWN-LISTENER-THREW`

- **Code/event:** `shutdown.listener-threw`
- **Message prefix:** `[svelte-adapter-uws] a sveltekit:shutdown listener threw`
- **Cause:** A sveltekit:shutdown listener threw synchronously during shutdown.
- **Consequence:** That listener's cleanup did not complete. The throw is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.
- **Automatic recovery:** Not applicable; shutdown proceeds without the failed cleanup.
- **Next action:** Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.
- **Runtime help:** `docs/errors.md#adapter-err-shutdown-listener-threw`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-shutdown-requests-dropped"></a>
## `ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED`

- **Code/event:** `shutdown.requests-dropped`
- **Message prefix:** `[svelte-adapter-uws] in-flight requests did not finish within the shutdown budget (`
- **Cause:** In-flight HTTP requests were still open when the configured shutdown budget expired.
- **Consequence:** The remaining open requests are dropped as the sockets close; their clients see resets. The drop is bounded and deliberate: the budget exists so a wedged request cannot hold the process open.
- **Automatic recovery:** Not applicable; shutdown proceeds by design.
- **Next action:** Raise SHUTDOWN_TIMEOUT if legitimate requests need longer to drain, or find the handler that never finished. SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.
- **Runtime help:** `docs/errors.md#adapter-err-shutdown-requests-dropped`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-shutdown-listeners-unsettled"></a>
## `ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED`

- **Code/event:** `shutdown.listeners-unsettled`
- **Message prefix:** `[svelte-adapter-uws] sveltekit:shutdown listeners did not settle within the shutdown budget (`
- **Cause:** One or more sveltekit:shutdown listeners were still pending when the shutdown budget expired.
- **Consequence:** The process exits with that cleanup unfinished: final writes and teardowns those listeners were performing did not complete.
- **Automatic recovery:** Not applicable; the budget exists so a wedged listener cannot hold the exit.
- **Next action:** Make the listener finish within the budget or raise SHUTDOWN_TIMEOUT; SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.
- **Runtime help:** `docs/errors.md#adapter-err-shutdown-listeners-unsettled`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-shutdown-failed"></a>
## `ADAPTER-ERR-SHUTDOWN-FAILED`

- **Code/event:** `shutdown.failed`
- **Message prefix:** `[svelte-adapter-uws] graceful shutdown failed`
- **Cause:** The graceful shutdown sequence itself threw. Every application-supplied input is contained behind its own entry (a throwing ws shutdown hook, a rejecting or wedged sveltekit:shutdown listener, an overrunning drain), so this line means the sequence's own machinery raised - an adapter defect, or an application-side patch of a global the sequence reads, such as an instrumentation layer's rewrap of process or EventEmitter internals throwing when the listener list is read.
- **Consequence:** The orderly steps after the throw were skipped, so the shutdown was not clean; the process still exits rather than hanging.
- **Automatic recovery:** Not applicable.
- **Next action:** Read the attached error. A stack through application instrumentation points at a broken global patch; anything else is adapter-owned and worth reporting with the attached error.
- **Runtime help:** `docs/errors.md#adapter-err-shutdown-failed`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-worker-restart-limit"></a>
## `ADAPTER-ERR-WORKER-RESTART-LIMIT`

- **Code/event:** `cluster.worker.restart-limit`
- **Message prefix:** `[svelte-adapter-uws] Worker restart limit reached for `
- **Cause:** A worker slot crashed and was respawned repeatedly without ever reaching stable uptime, exhausting its restart budget.
- **Consequence:** The primary exits - hard-killing if other workers are still alive, so the teardown is clean - and the whole service goes down until an orchestrator respawns the process.
- **Automatic recovery:** None inside the process. An orchestrator respawn, where one is configured, is the recovery path.
- **Next action:** Read the failing worker crash output above this line: the restart limit is the symptom and the repeated worker crash is the fault. A loop this fast is usually a boot-time error, not load.
- **Operator shortlink:** `https://svti.me/worker-restart-limit`
- **Runtime help:** `docs/errors.md#adapter-err-worker-restart-limit`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)

<a id="adapter-err-tls-degraded-expiry"></a>
## `ADAPTER-ERR-TLS-DEGRADED-EXPIRY`

- **Code/event:** `tls.degraded-expiry-alert`
- **Message prefix:** `[svelte-adapter-uws] [tls] certificate hot-reload is DEGRADED (`
- **Cause:** TLS hot-reload is in the degraded state and the recorded certificate expiry is inside the alert window.
- **Consequence:** On a worker the figure is the certificate that worker actually serves, so the countdown is real: the renewal on disk is not being applied and handshakes fail at the printed expiry while readiness probes stay green. On the CLUSTER PRIMARY the figure is the last certificate the primary read cleanly, not necessarily what the workers serve - after a primary-local reload-read failure this alarm can count down against a certificate the fleet already replaced.
- **Automatic recovery:** The alert re-checks hourly while degraded. A reload that succeeds clears the degraded state and silences it.
- **Next action:** From a worker, treat this as an outage countdown: fix the certificate files now, and restart the instance if the reload cannot be repaired before the printed expiry. From the primary, verify the served certificate first (see ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ) before treating the countdown as real.
- **Runtime help:** `docs/errors.md#adapter-err-tls-degraded-expiry`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js), [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js)

<a id="adapter-err-sendto-async-filter"></a>
## `ADAPTER-ERR-SENDTO-ASYNC-FILTER`

- **Code/event:** `ws.sendto.async-filter-refused`
- **Message prefix:** `[ws] platform.sendTo filter returned a Promise; treating as fail-closed.`
- **Cause:** A platform.sendTo filter returned a Promise. The filter must be synchronous, because sendTo iterates every active connection in one pass.
- **Consequence:** Every connection whose filter returns a Promise is skipped - fail-closed - on this and every later sendTo call, so the targeted delivery silently reaches nobody the filter cannot answer synchronously. The warning prints once per worker.
- **Automatic recovery:** None. The filter stays fail-closed until the code is fixed.
- **Next action:** Resolve the fields the filter needs into userData in your upgrade hook so the filter can read them synchronously.
- **Operator shortlink:** `https://svti.me/sendto-async`
- **Runtime help:** `docs/errors.md#adapter-err-sendto-async-filter`
- **Runtime sources:** [src/runtime/handler/platform.js](../src/runtime/handler/platform.js)

<a id="adapter-err-ws-shutdown-hook-threw"></a>
## `ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW`

- **Code/event:** `ws.shutdown-hook.threw`
- **Message prefix:** `[ws] the WebSocket shutdown hook threw`
- **Cause:** The `shutdown` export of the WebSocket handler threw synchronously or rejected while the server was closing.
- **Consequence:** Whatever that hook was flushing did not finish - final writes, external deregistration, or draining a queue. The throw is contained and the teardown carries on regardless, so the loss is silent unless this line is read. The same line prints for the same hook on all three surfaces: under the production runtime and createTestServer the listen socket closes after the hook, and on the dev server the hook runs from the server's own close event, so the socket is already gone by then.
- **Automatic recovery:** None. Shutdown is best-effort and proceeds without the hook.
- **Next action:** Fix the hook, then check whatever it was flushing for state left behind. Under the production runtime and createTestServer the hook is handed a `signal` it can watch to give up cleanly instead of throwing - but only when a shutdown budget is configured, and it is null without one. The dev server passes no such field at all, so a hook that reads it must tolerate undefined.
- **Runtime help:** `docs/errors.md#adapter-err-ws-shutdown-hook-threw`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-ws-shutdown-hook-unsettled"></a>
## `ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED`

- **Code/event:** `ws.shutdown-hook.unsettled`
- **Message prefix:** `[ws] the WebSocket shutdown hook has not settled after `
- **Cause:** The `shutdown` export of the WebSocket handler was still running when the shutdown budget expired.
- **Consequence:** The close path stops waiting and the listen socket closes anyway. The hook keeps running - user code cannot be interrupted - but nothing awaits it any more, so whether it finishes is now a race against whatever ends the process next. It may well complete: under `createTestServer` the process often continues afterwards and the flush lands. What is gone is the guarantee, so a hook that prints this is one deploy timing away from losing whatever it was flushing. createTestServer prints the same line for the same hook.
- **Automatic recovery:** None by design: the budget exists so a wedged hook cannot hold the process open.
- **Next action:** Make the hook finish inside the budget, or raise SHUTDOWN_TIMEOUT. The hook receives a `signal` that aborts when the budget expires - honoring it turns this into a clean early return.
- **Runtime help:** `docs/errors.md#adapter-err-ws-shutdown-hook-unsettled`
- **Runtime sources:** [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-message-hook"></a>
## `ADAPTER-ERR-MESSAGE-HOOK`

- **Code/event:** `ws.message-hook.threw`
- **Message prefix:** `[ws] the message hook threw`
- **Cause:** The application or plugin `message` hook threw or rejected while handling a client frame.
- **Consequence:** That client's connection is closed with code 1011 and the reason `Message handler error`; the cause stays server-side and is not sent to the client. Other connections are unaffected. A client that reconnects and replays the same frame is closed again.
- **Automatic recovery:** None for the frame. The client sees a close, and reconnection is the client library's own resume path.
- **Next action:** Fix the hook, or catch inside it and answer the client deliberately. The error printed with this line is the original throw.
- **Runtime help:** `docs/errors.md#adapter-err-message-hook`
- **Runtime sources:** [src/runtime/utils/hook-boundary.js](../src/runtime/utils/hook-boundary.js)

<a id="adapter-err-recover-hook"></a>
## `ADAPTER-ERR-RECOVER-HOOK`

- **Code/event:** `ws.recover-hook.threw`
- **Message prefix:** `[ws] the recover-on-subscribe hook threw`
- **Cause:** The `resume` hook threw on the RECOVER-ON-SUBSCRIBE path - a client subscribing to a topic the server was asked to backfill - so the backlog that subscription should have replayed could not be produced. The same hook failing on a client resume frame is ADAPTER-ERR-RESUME-HOOK instead.
- **Consequence:** The subscription itself still completes: the client is subscribed and receives live frames from that moment on, but the events it missed before subscribing are not delivered and no gap is reported to it. It looks like a working subscription with a hole at the start.
- **Automatic recovery:** None. Live delivery continues; the missed range is not retried.
- **Next action:** Fix the hook or make it fail closed for the topics it cannot serve. A hook that throws for a topic it does not own should return an empty result for it instead.
- **Runtime help:** `docs/errors.md#adapter-err-recover-hook`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js), [src/testing.js](../src/testing.js)

<a id="adapter-err-metrics-module-shape"></a>
## `ADAPTER-ERR-METRICS-MODULE-SHAPE`

- **Code/event:** `ws.metrics.module-shape`
- **Message prefix:** `[ws] the metrics module must export a registry object as `default`, `metrics` or `registry`; got `
- **Cause:** The export the build SELECTED from the module named by `websocket.metrics` cannot carry instrument factories. This is a statement about that one value, not about the module: the build takes the first of `default`, `metrics` and `registry` that is not nullish and forwards it without validating its shape, so a module carrying a perfectly good `metrics` registry prints this line whenever a primitive `default` sits in front of it.
- **Consequence:** In the built runtime, metrics are disabled for the whole worker: no instrument is ever created, so the adapter series are ABSENT from the scrape rather than present at zero. Dashboards read as no data and alerts that fire on a threshold never fire at all. On the dev plugin the shape is the same and the loss is smaller, because dev registers no adapter instruments in any case: `platform.metrics` stays null and `metricsSnapshot()` answers null, so a scrape route being developed against dev reads as though no registry were configured at all. Dev keeps serving either way - a metrics module is not worth a dev server.
- **Automatic recovery:** None. The runtime keeps serving traffic with metrics off - the alternative is a boot failure naming neither metrics nor the option that caused it.
- **Next action:** The guard accepts any object or function, so what printed this is a PRIMITIVE - the `got` value on the line says which type. Export the registry itself under any one of the three names the build reads, which it tries in order: `default`, then `metrics`, then `registry`. The first one that is not nullish wins, so a primitive `default` masks a perfectly good named `metrics` beside it and is worth ruling out first. Note the two shapes that pass this guard and still do not work: a module exporting none of those three names is treated as no registry configured and prints nothing at all, and a factory is accepted as-is and never called.
- **Runtime help:** `docs/errors.md#adapter-err-metrics-module-shape`
- **Runtime sources:** [src/runtime/utils/metrics.js](../src/runtime/utils/metrics.js), [src/vite.js](../src/vite.js)

<a id="adapter-err-metrics-instrument"></a>
## `ADAPTER-ERR-METRICS-INSTRUMENT`

- **Code/event:** `ws.metrics.instrument-threw`
- **Message prefix:** `[ws] a metrics instrument threw; further errors from it are suppressed`
- **Cause:** Recording a value threw. The containment wraps the adapter's own mirror of the instrument, so the throw is usually from the registry module the `websocket.metrics` option names, but adapter code runs first on that path and a failure there surfaces the same way.
- **Consequence:** Where the value ends up depends on which side threw. The adapter records into its own mirror BEFORE delegating, so a throw from the configured registry loses the value only from that registry's scrape - `metricsSnapshot()` still has it. Every later call is attempted again, the containment being per call, so an instrument that throws for one label set or one transient keeps recording the rest; but the failures are printed once and then suppressed, so nothing tells you whether it kept failing. A series that stops moving reads as an idle server rather than a broken instrument.
- **Automatic recovery:** The throw is contained per call, so the request or frame that triggered it completes normally, and a transient failure self-heals on the next call.
- **Next action:** Read the error printed with this line - it is the original throw, and its stack says which side failed. Label cardinality and type mismatches in the registry module are the usual causes.
- **Runtime help:** `docs/errors.md#adapter-err-metrics-instrument`
- **Runtime sources:** [src/runtime/utils/metrics.js](../src/runtime/utils/metrics.js)

<a id="adapter-err-posture-export-disabled"></a>
## `ADAPTER-ERR-POSTURE-EXPORT-DISABLED`

- **Code/event:** `ws.posture-export.disabled`
- **Message prefix:** `[ws] posture export disabled: `
- **Cause:** The posture export socket could not listen on its configured path, or its socket failed later in its life; the line says which. A stale socket file is removed automatically before every listen attempt, so the listen shape means a permission denial (including a stale path the process could not remove), a missing parent directory, or a Windows named pipe already taken.
- **Consequence:** The worker keeps serving traffic, but nothing can read its live pressure posture over that socket: an external supervisor watching it sees a connection failure rather than a posture, and any shedding decision built on it stops updating. A failed listen never had readers to lose; a later socket error drops whichever readers were connected.
- **Automatic recovery:** None. The export is not retried for the life of the worker.
- **Next action:** Read the shape on the line. For a failed listen, fix the directory permissions, create the missing parent directory, or point the export at a free path, then restart the worker - removing a stale socket file by hand is not the repair, because the runtime already removes one before every listen. For a later socket error the export is down until restart; its consumers key on the 1 Hz cadence stopping either way.
- **Runtime help:** `docs/errors.md#adapter-err-posture-export-disabled`
- **Runtime sources:** [src/runtime/utils/posture-export.js](../src/runtime/utils/posture-export.js)

<a id="adapter-err-posture-observer"></a>
## `ADAPTER-ERR-POSTURE-OBSERVER`

- **Code/event:** `ws.posture-observer.threw`
- **Message prefix:** `[ws] a posture transition handler threw`
- **Cause:** The adapter's own protection-posture transition handler threw. It records the transition metric, prints the posture line, then pushes the new posture to the export socket. The metric is contained and the export push contains its own failures, so what remains is the console write.
- **Consequence:** The posture CHANGED and the runtime is shedding or recovering as configured, but the record of it did not finish. What went missing is the posture log line, and with it the IMMEDIATE export push that follows it - a defense daemon reacting to the change does not get it at the instant of transition. The staleness that leaves is shorter than a sample, not longer: the posture advances from inside the 1 Hz pressure sampler, and that same sampler run pushes the ordinary posture heartbeat a few statements later, so an export reader carries the true posture before the tick that raised it has finished.
- **Automatic recovery:** The heartbeat later in the SAME sampler run carries the new posture, so no export reader waits for another transition or another second; the next transition runs the handler again, since a throw does not unregister it. Only the incident-timeline console line for this transition is gone for good.
- **Next action:** This is an adapter-internal failure - report it with the error printed beside it. The console write is the candidate to look at first: the transition metric is recorded before it and is contained, and the export push after it contains its own failures (a non-serializable snapshot and a slow client are both handled inside it). A configured metrics registry is NOT a candidate - an instrument that throws is contained and prints ADAPTER-ERR-METRICS-INSTRUMENT instead of reaching this handler.
- **Runtime help:** `docs/errors.md#adapter-err-posture-observer`
- **Runtime sources:** [src/runtime/utils/pressure.js](../src/runtime/utils/pressure.js)

<a id="adapter-err-upgrade-deferred"></a>
## `ADAPTER-ERR-UPGRADE-DEFERRED`

- **Code/event:** `ws.upgrade.deferred-failed`
- **Message prefix:** `[ws] a deferred upgrade failed`
- **Cause:** A WebSocket upgrade held back by the admission queue threw when it was finally completed, after the client had already passed admission.
- **Consequence:** That one client never connects. Its response is left unfinished rather than refused, so it typically waits out its own timeout instead of seeing an error, and it retries as if the server were briefly unavailable. The admission slot it held is released, and the other upgrades in the same drain still run.
- **Automatic recovery:** None for that connection; the client reconnects on its own schedule.
- **Next action:** Read the error printed with this line. Its source cannot be your upgrade hook - the hook had already resolved before the completion was deferred; what runs here is the socket write, the native upgrade, the permit bookkeeping, and, on the fast path, the tracing hook. A repeated throw usually means sockets are dying in the queue before their turn comes - the admission backlog is holding upgrades longer than clients wait.
- **Runtime help:** `docs/errors.md#adapter-err-upgrade-deferred`
- **Runtime sources:** [src/runtime/utils/upgrade-admission.js](../src/runtime/utils/upgrade-admission.js)

<a id="adapter-err-waiting-room-fallback"></a>
## `ADAPTER-ERR-WAITING-ROOM-FALLBACK`

- **Code/event:** `ws.waiting-room.renderer-failed`
- **Message prefix:** `[svelte-adapter-uws] the waiting-room renderer failed; serving the built-in English page instead`
- **Cause:** The module named by `waitingRoom.renderer` threw, or returned a result the runtime could not accept, while rendering the over-capacity page.
- **Consequence:** The visitor turned away by that request receives the built-in English page instead of the rendered one, so localization, branding and any per-request content are lost for it. The capacity decision itself is unaffected. The line prints once per worker, so a renderer that keeps failing reports only the first one.
- **Automatic recovery:** The renderer is called again on the next request, so a failure that depends on the request self-heals; a renderer that always throws serves the built-in page every time.
- **Next action:** Fix the renderer and redeploy. A renderer must return a complete document meeting the accessible baseline, which is validated on the first successful render rather than at build time; when the baseline is what failed the error printed with this line names the requirement, and for any other throw it is the renderer's own error.
- **Runtime help:** `docs/errors.md#adapter-err-waiting-room-fallback`
- **Runtime sources:** [src/runtime/utils/upgrade-admission.js](../src/runtime/utils/upgrade-admission.js)

<a id="adapter-err-diagnostic-record-shape"></a>
## `ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE`

- **Code/event:** `ws.diagnostic.record-shape`
- **Message prefix:** `[ws] operational event dropped, invalid record shape`
- **Cause:** Something emitted an operational diagnostic the runtime could not build a record from - a malformed event name, an unknown severity or data class, or a bad timestamp. A field that cannot be SERIALIZED is a different, quieter failure: the renderer absorbs it by printing the envelope with the attributes stripped, so the event still appears minus its attributes and no error line prints - the render path reports only its own total collapse (see ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE).
- **Consequence:** That diagnostic is DROPPED: it reaches neither the configured sink nor the log, so the failure it was reporting leaves no structured trace. Everything else keeps emitting normally.
- **Automatic recovery:** None for the dropped record. Telemetry deliberately never throws, so the emitting path continued as if it had been reported.
- **Next action:** Read the event name printed with this line and fix the emitter. If it is application or plugin code calling the diagnostic surface, check the record against the documented shape.
- **Runtime help:** `docs/errors.md#adapter-err-diagnostic-record-shape`
- **Runtime sources:** [src/runtime/diagnostic.js](../src/runtime/diagnostic.js), [src/runtime/utils/operational-diagnostic.js](../src/runtime/utils/operational-diagnostic.js)

<a id="adapter-err-diagnostic-render-collapse"></a>
## `ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE`

- **Code/event:** `ws.diagnostic.render-collapse`
- **Message prefix:** `[ws] diagnostic render failed: `
- **Cause:** Formatting an operational diagnostic threw, and formatting it again with the attributes stripped threw as well. That SECOND failure is what makes this environmental rather than a bad record: the strip leaves only fields createDiagnostic produced and validated itself, every one a bounded string or number - the message is cut to 512 characters at creation - so no record this runtime accepted can fail the retry. What can fail it is the JSON serialization the format is built on: a replaced or wrapped `JSON.stringify`, a `toJSON` added to `Object.prototype`, an instrumentation agent that patched either. A value in the ATTRIBUTES that cannot be serialized is absorbed by the retry and never reaches this line, and a console that refuses the finished text prints the diagnostic-console-write line instead.
- **Consequence:** That diagnostic is lost. How much goes with it depends on what the serialization refuses: one that fails outright takes the whole operational stream, and one that refuses only certain shapes - a wrapper scrubbing a field, a size ceiling - takes every diagnostic matching that shape and lets the rest through. So a log that still carries other events does NOT mean this was isolated to the record named here; it means the refusal is selective. The request path is unaffected either way: the failure is contained so telemetry cannot take a worker down with it.
- **Automatic recovery:** None for the lost record, and a later diagnostic printing normally is not recovery - under a selective refusal the ones that do not match keep working throughout, which is exactly what makes the gap easy to miss. Nothing is retried and nothing is unregistered; each event is formatted independently and meets the same serialization.
- **Next action:** Do not start at the emitter or the record - neither can produce this line. Look for what changed this process's JSON serialization: an APM or instrumentation agent, a polyfill, a test harness stubbing `JSON.stringify`, or a dependency that added `toJSON` to `Object.prototype`. Do NOT clear it on `JSON.stringify({})` alone: a selective wrapper returns `{}` for that and still refuses the shape that produced this line. Serialize a record of the shape the RETRY formats - the diagnostic envelope with no attributes, every field a bounded string or number - and compare that with the trivial case; a difference between them IS the wrapper. Do not test the event's own attributes: an attribute that cannot be serialized is absorbed by the retry and never produces this line, so a throw from serializing them proves nothing about this failure and reads as a wrapper that is not there. The event name on the line is what was in flight, not a suspect.
- **Runtime help:** `docs/errors.md#adapter-err-diagnostic-render-collapse`
- **Runtime sources:** [src/runtime/diagnostic.js](../src/runtime/diagnostic.js)

<a id="adapter-err-diagnostic-console-write"></a>
## `ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE`

- **Code/event:** `ws.diagnostic.console-write`
- **Message prefix:** `[ws] diagnostic rendered but the console refused it: `
- **Cause:** The diagnostic formatted correctly and the console method carrying its severity threw when handed the finished line. The record is not the suspect here: a console replaced or wrapped by the host, or one whose write end has gone, refuses a well-formed string exactly the same way.
- **Consequence:** That one diagnostic is lost, and so is every later one carried by the SAME console method for as long as it keeps throwing - this is a broken channel rather than a bad value, so it does not stop at the record that revealed it. The mapping is not one method per severity: debug, info, and warn ride their own methods, while error and fatal share console.error, so a broken error channel loses both and a fatal line missing from the log means console.error is broken. Severities riding other methods are unaffected, and this line itself is written through console.error, which is a different method in every case but a failing error or fatal channel.
- **Automatic recovery:** None, and none is attempted: nothing re-routes a severity to another method, because silently moving warnings into the error stream would corrupt the log an operator reads.
- **Next action:** Look at the console rather than the emitter - specifically anything in the deployment that replaces, wraps, or proxies it (a log shipper, an APM agent, a test harness stub). The event name on the line says what was being reported when it went; the severity that is missing from the log tells you which method is broken. If nothing wraps the console, check whether its destination still exists - a closed pipe or a full stream refuses writes the same way.
- **Runtime help:** `docs/errors.md#adapter-err-diagnostic-console-write`
- **Runtime sources:** [src/runtime/diagnostic.js](../src/runtime/diagnostic.js)

<a id="adapter-err-diagnostic-sink-notice"></a>
## `ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE`

- **Code/event:** `ws.diagnostic.sink-notice`
- **Message prefix:** `[ws] operational sink failed and its failure notice could not be built: `
- **Cause:** A configured operational event sink threw, the console fallback printed the original event in its place, and then BUILDING the record that announces the sink failure threw. Only the wall clock the notice stamps can do that: every other field is a constant or a value read off the already-validated original record, and a clock either throws or returns a timestamp the shape accepts - no clock RETURN value can be rejected. The console is not implicated: this very line is written through it.
- **Consequence:** One record is lost, and it is the notice, not the event. The event named on this line was printed by the console fallback immediately above it, so the telemetry the sink was carrying is in the log; what is missing is the machine-readable statement that the sink is broken, which is what a collector watching for sink health would have keyed on.
- **Automatic recovery:** None for the lost notice. The sink is not unregistered and is called again for the next event. This line is inherently intermittent: it needs the same clock to succeed for the event's own record and then fail for the notice moments later, so a clock broken outright does not keep printing it - the next emission dies earlier, at record construction, and prints the record-shape line instead.
- **Next action:** Two independent things failed and both are worth a look. The sink is the deployment-supplied component that failed first, and the event name on the line says what it was carrying. The notice failure is separate and is the adapter-side wall clock - an injected clock that throws intermittently, or an async sink rejection settling after the clock broke. A deployment that has not injected a clock should treat this half as a defect worth reporting.
- **Runtime help:** `docs/errors.md#adapter-err-diagnostic-sink-notice`
- **Runtime sources:** [src/runtime/diagnostic.js](../src/runtime/diagnostic.js)

<a id="adapter-err-resource-growth"></a>
## `ADAPTER-ERR-RESOURCE-GROWTH`

- **Code/event:** `ws.resource-growth.trending`
- **Message prefix:** `[ws] resource-growth auditor: `
- **Cause:** A runtime structure the growth auditor samples has been trending upward across consecutive samples without shedding. The auditor is opt-in and off unless an audit interval is configured, so silence here means it is disabled just as often as it means nothing is growing.
- **Consequence:** Nothing is refused yet - this is the early warning, printed once per worker lifetime while the metric keeps carrying the ongoing signal. What the auditor has is a DIRECTION across consecutive samples, not a prediction: a trend that continues ends in memory pressure and eventually exhausts the heap, and one that levels off or starts shedding later never gets there, which is why the metric rather than this line is what says which happened. If it does continue, whether anything sheds before the end depends on configuration - the protection posture is opt-in, so on a default deployment there is no posture to raise. No worker is restarted on account of memory either, so what follows an exhausted heap is the process aborting rather than one thread being replaced.
- **Automatic recovery:** None. The auditor observes; it does not evict.
- **Next action:** The line names the structure. Find the path that stopped shedding for it - a close, unsubscribe or eviction that no longer runs - rather than raising a limit; framework_resource_growth_suspected_total carries the structure as its `resource` label and shows whether the trend continued.
- **Runtime help:** `docs/errors.md#adapter-err-resource-growth`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js)

<a id="adapter-err-relay-spill-quarantine"></a>
## `ADAPTER-ERR-RELAY-SPILL-QUARANTINE`

- **Code/event:** `cluster-relay.spill-quarantine`
- **Message prefix:** `[primary] relay spill quarantining `
- **Cause:** The primary could not hand relay traffic DOWN to this worker inside the worker's spill ceiling - its ring backlog crossed the byte limit, or the worker stopped making drain progress for longer than the age limit - so the primary quarantined it. This is the opposite direction from ADAPTER-ERR-RELAY-SPILL-OVERFLOW, which is a worker that could not reach the primary.
- **Consequence:** The primary stops forwarding relay traffic to that worker and asks it to exit, so its clients are dropped and reconnect onto a sibling. Until they do, that worker's subscribers were already missing whatever the ring could not deliver. Quarantine happens once per worker - the primary does not re-evaluate it - and the line names the reason, the bytes dropped and how long the backlog had been pending.
- **Automatic recovery:** The exit is a request, not a guarantee: quarantine posts a terminate message the quarantined worker's own event loop must process, and an AGE quarantine means exactly that loop stopped making progress. A worker that processes the request exits and the primary replaces it; one still wedged when the exit grace expires is resolved by killing the whole process for the orchestrator to respawn - the mechanism ADAPTER-ERR-WORKER-EXIT-SIGKILL documents. Either way the dropped frames are not resent, so a client that was subscribed on that worker has a hole its own resume path must fill when it reconnects.
- **Next action:** Read the reason on the line. An AGE spill means that worker stopped draining its ring - a blocked event loop is the usual cause, and it is the worker's own thread to profile, not the primary's. A BYTES spill can mean either: a peer merely behind on a ceiling sized too close to the largest relayed frame, where raising CLUSTER_RELAY_MAX_PENDING_KB to a few times that frame is the fix, or sustained fan-out the relay is undersized for, where a wider ceiling only delays the next spill. The droppedBytes on the line tells you which.
- **Runtime help:** `docs/errors.md#adapter-err-relay-spill-quarantine`
- **Runtime sources:** [src/runtime/relay-spill-policy.js](../src/runtime/relay-spill-policy.js)

<a id="adapter-err-posture-transition"></a>
## `ADAPTER-ERR-POSTURE-TRANSITION`

- **Code/event:** `ws.protection-posture.transition`
- **Message prefix:** `[ws] protection posture `
- **Cause:** The worker moved between protection postures - normal, elevated and siege. Normal to elevated is decided by sampled pressure holding over a configured threshold (memory, CPU quota, kernel stall time, publish rate or subscriber ratio). Elevated to siege is decided instead by the rate of capacity rejections crossing the siege rate, independently of those signals. Both directions relax after a run of quiet samples, and siege steps down to elevated rather than straight to normal. The line names the posture it left, the posture it entered, the rejection rate at that moment and the highest pressure signal.
- **Consequence:** What the posture changes depends on which one it entered. At ELEVATED nothing is refused - the admission effect is only a wider Retry-After jitter on capacity responses that were already going out - so this line is a warning rather than an outage. It does change what the worker REPORTS, though: from here a sample reads its pressure state as active, and its reason as CAPACITY unless the underlying signal is MEMORY, which is preserved and reported as itself - so `platform.pressure`, the pressure gauge, the posture export and any onPressure listener follow the posture rather than the underlying signal, except for the one signal you would least want masked. At SIEGE the worker additionally refuses EVERY new upgrade at static-serve cost, and clients see a capacity refusal rather than an error. A worker that settles at either is running at its ceiling.
- **Automatic recovery:** Yes, and a de-escalation prints this same line: the posture steps back down after a run of quiet samples, and both directions are dwell-gated so it cannot flap.
- **Next action:** Read the two numbers together, because which one decided depends on the edge. Entering elevated is decided by the pressure signal named on the line. Entering siege is decided by rejected/s crossing the siege rate and can print pressure=NONE - that is a capacity-reject storm rather than a resource problem, so read rejected/s there. A relaxation always prints pressure=NONE, because a run of quiet samples is what causes it. A posture that returns to normal on its own needs nothing; one that stays raised means the worker is undersized for the load or something is not shedding - the resource-growth line and the per-topic pressure entries cover that side.
- **Runtime help:** `docs/errors.md#adapter-err-posture-transition`
- **Runtime sources:** [src/runtime/handler.js](../src/runtime/handler.js)

<a id="adapter-err-worker-exit-sigkill"></a>
## `ADAPTER-ERR-WORKER-EXIT-SIGKILL`

- **Code/event:** `cluster.worker-exit-sigkill`
- **Message prefix:** `[primary] worker `
- **Cause:** A worker was asked to exit and had not done so within the exit grace period, so the primary killed the WHOLE PROCESS with SIGKILL. A wedged worker cannot close itself, and worker.terminate() would abort the process anyway.
- **Consequence:** Every worker dies, not just the wedged one: all connections drop, in-flight requests are lost, and no shutdown hook runs. The process is expected to be respawned by whatever supervises it - systemd, a container runtime, an orchestrator. Without one, the service stays down.
- **Automatic recovery:** None inside the process. Recovery is the supervisor restarting it.
- **Next action:** Find why the worker would not exit. A blocked event loop is the usual cause - a synchronous hook, an unbounded loop, or a native call that does not return - and it will happen again at the next exit request. Most exit requests print their reason above this line; the one that does not is the shutdown budget expiring, where the request went to every worker at once and this one did not go.
- **Runtime help:** `docs/errors.md#adapter-err-worker-exit-sigkill`
- **Runtime sources:** [src/runtime/index.js](../src/runtime/index.js)
