# Error reference

Search this page with the exact stable ID, code, event, or beginning of the message you saw.
The indexed reference below covers 6 of the 33 distinct diagnostic events the runtime
emits; the [coverage list](#emitted-diagnostic-event-coverage) names all 33, so a search for any
emitted event name lands on this page. Runtime messages for indexed entries preserve the
documented prefix and append the stable ID plus this package-local help route.

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

## Emitted diagnostic event coverage

This inventory is derived at generation time by scanning `src/runtime/`, `src/observability.js`,
and `src/vite.js` for emitted diagnostic events; the runtime emits 33 distinct events.
The 6 indexed above carry stable IDs and full operator guidance. The remaining 27
are listed below with their emitting sources, so an operator searching any emitted event
name finds an authoritative row on this page.

Indexed events:

- `runtime.listen.failed` - [ADAPTER-ERR-LISTEN](#adapter-err-listen)
- `vite.handler.load-failed` - [ADAPTER-ERR-VITE-LOAD](#adapter-err-vite-load)
- `vite.handler.reload-failed` - [ADAPTER-ERR-VITE-RELOAD](#adapter-err-vite-reload)
- `install.native-load.failed` - [ADAPTER-ERR-NATIVE-LOAD](#adapter-err-native-load)
- `websocket.request.timeout` - [ADAPTER-ERR-REQUEST-TIMEOUT](#adapter-err-request-timeout)
- `websocket.request.connection-closed` - [ADAPTER-ERR-REQUEST-CLOSED](#adapter-err-request-closed)

### Emitted diagnostics not yet in the indexed reference

These events have no stable ID yet. Each one is emitted on the shared diagnostic line
format, so its searchable log prefix is:

`[lantean/diagnostic source=svelte-adapter-uws component=<component> event=<event> severity=<severity>] <message>`

| Event | Component | Severity | Emitting sources |
|---|---|---|---|
| `admin.handler-failed` | `runtime.admin` | error | [src/runtime/handler/admin.js](../src/runtime/handler/admin.js) |
| `cluster.worker-error` | `runtime.cluster` | error | [src/runtime/index.js](../src/runtime/index.js) |
| `divergence.detected` | `runtime.divergence` | error | [src/runtime/index.js](../src/runtime/index.js) |
| `invariant.violated` | `runtime.assertion` | varies by call site | [src/runtime/utils/assertions.js](../src/runtime/utils/assertions.js) |
| `metrics.merge-failed` | `runtime.metrics` | error | [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js) |
| `metrics.mirror-read-failed` | `runtime.metrics` | error | [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js) |
| `metrics.primary-unreachable` | `runtime.metrics` | error | [src/runtime/handler/metrics-snapshot.js](../src/runtime/handler/metrics-snapshot.js) |
| `operational.sink.failed` | `runtime.observability` | error | [src/runtime/diagnostic.js](../src/runtime/diagnostic.js) |
| `pressure.listener-failed` | `runtime.pressure` | error | [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js) |
| `pressure.publish-rate-listener-failed` | `runtime.pressure` | error | [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js) |
| `pressure.runaway-publisher` | `runtime.pressure` | warn | [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js) |
| `pressure.topic-registry-high` | `runtime.pressure` | warn | [src/runtime/handler/pressure-metrics.js](../src/runtime/handler/pressure-metrics.js) |
| `resume.hook-failed` | `runtime.resume` | error | [src/runtime/handler.js](../src/runtime/handler.js) |
| `resume.hook-read-failed` | `runtime.resume` | error | [src/runtime/handler/resume-buffer.js](../src/runtime/handler/resume-buffer.js) |
| `runtime.authenticate.failed` | `runtime.authenticate` | error | [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js) |
| `runtime.relay-gap.detected` | `runtime.relay-gap` | error | [src/runtime/handler.js](../src/runtime/handler.js) |
| `runtime.ssr.failed` | `runtime.ssr` | error | [src/runtime/handler/ssr.js](../src/runtime/handler/ssr.js) |
| `runtime.subscription.accepted` | `runtime.subscription` | debug | [src/runtime/handler.js](../src/runtime/handler.js) |
| `runtime.subscription.removed` | `runtime.subscription` | debug | [src/runtime/handler.js](../src/runtime/handler.js) |
| `runtime.websocket-upgrade.failed` | `runtime.websocket-upgrade` | error | [src/runtime/handler.js](../src/runtime/handler.js), [src/vite.js](../src/vite.js) |
| `subscribe.batch-hook-failed` | `runtime.subscribe` | error | [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js) |
| `subscribe.batch-result-read-failed` | `runtime.subscribe` | error | [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js) |
| `subscribe.hook-failed` | `runtime.subscribe` | error | [src/runtime/handler/subscribe-hooks.js](../src/runtime/handler/subscribe-hooks.js) |
| `tls.reload-skipped` | `runtime.tls` | warn | [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js) |
| `tls.swap-failed` | `runtime.tls` | error | [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js) |
| `tls.watch-failed` | `runtime.tls` | error | [src/runtime/handler/lifecycle.js](../src/runtime/handler/lifecycle.js) |
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
