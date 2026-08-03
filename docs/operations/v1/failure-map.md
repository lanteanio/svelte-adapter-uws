# Failure map

Start here after the first-five-minute checklist in the [pack index](./README.md).
The table states framework behavior, not the application's business impact.

| Signal | Framework impact and loss semantics | First safe action | Primary owner | Runbook |
|---|---|---|---|---|
| `/healthz` is unavailable | Process or route is unavailable; in-flight outcomes may be unknown | Stop rollout, capture supervisor/process evidence, verify whether a drain was in progress | Runtime operator | [Process and deploy](./process-and-deploy.md) |
| `/readyz` says `starting` | Listen socket may be bound but `init` has not committed; traffic must not be promoted | Inspect init progress and startup budget; do not restart on readiness alone | Runtime operator | [Process and deploy](./process-and-deploy.md) |
| `/readyz` says `draining` | Planned shutdown has begun; liveness should remain green while work drains | Remove traffic and wait through the configured delay/budget | Runtime operator | [Process and deploy](./process-and-deploy.md) |
| Fatal assertion or worker restart loop | A framework invariant failed or a worker stopped answering; local in-memory state on that worker is discarded | Capture category and preceding diagnostics before replacement removes context | Runtime operator | [Process and deploy](./process-and-deploy.md) |
| Release raises boot, handshake, RPC or subscription errors | A bad or incompatible tuple may be in rotation; old or newer cached clients may still reconnect | Freeze rollout and record every deployed package, application and client-asset version before rollback | Release owner | [Coordinated release](./coordinated-release.md) |
| Redis breaker is `broken` or clients receive `degraded` | Local delivery continues, but cross-instance relay is skipped; presence/replay/limiter operations have mode-specific fail behavior | Stop topology changes and identify every primitive sharing the breaker | Data/backend owner | [Redis outage](./redis-outage.md) |
| Redis is reachable but no `recovered` event/path success | Transport recovery is not application recovery; instances may not all have probed | Leave mitigation active and verify a guarded operation on every instance | Data/backend owner | [Redis outage](./redis-outage.md) |
| Admission, pressure, backpressure and Redis degradation overlap | Restart or an eager recovery wave can amplify the shared constraint; several loss semantics apply at once | Freeze restart, reset, protection relaxation and unbounded reconnect; capture one evidence row per instance | Incident commander | [Correlated resource controls](./resource-controls.md) |
| Postgres unavailable or task/job backlog grows | New durable operations may fail; claimed work can become eligible again after visibility/fence expiry | Freeze manual retry and classify each workload's idempotency/fence contract | Workload owner | [Durable work](./durable-work.md) |
| Task is `running` past its fence or job past visibility | At-least-once recovery may overlap a late original attempt; external effects can already exist | Check downstream idempotency evidence before takeover or retry | Workload owner | [Durable work](./durable-work.md) |
| `AdapterRelayGap`, replay `truncated`/`rehydrate`, or state divergence | At least one replica/client may lack state; counters and gap bounds are not exact loss proofs | Preserve diagnostic ids and choose replay/delta/full rehydrate by proven coverage | Realtime owner | [State delivery](./state-delivery.md) |
| Sustained backpressure, saturation, waiting room or metrics-pipeline alerts | Capacity or observability is degraded; response depends on the exact signal | Use the response matrix, then the alert-specific procedure; do not infer health from aggregate traffic | Runtime operator | [Correlated resource controls](./resource-controls.md) |

If more than one row applies, the incident commander selects one primary
runbook and lists the others as dependent work. Never let two operators perform
restart, rollback, takeover, or replay independently.
