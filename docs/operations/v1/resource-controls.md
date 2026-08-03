# Correlated resource-control response

## Trigger

Use this runbook when two or more protective surfaces move together: admission
or waiting-room pressure, an `elevated`/`siege` posture, outbound
backpressure, descriptor/kernel/memory pressure, stale or degraded metrics,
Redis breaker latency, realtime client degradation, or state divergence. A
single alert still uses its specific observability procedure; this runbook owns
the interaction and the order in which mitigations may be removed.

## Owner

The incident commander owns recovery order. The runtime operator owns
admission, posture, process and metric evidence; the data/backend owner owns
Redis; the realtime owner owns client mitigation and rehydration. No one lane
may restart the fleet, reset a breaker, unpin protection, or start a reconnect
wave independently.

## Loss semantics

Protection preserves service availability; it does not make skipped work
durable. An admission refusal creates no connection. Backpressure status `2`
means that frame was dropped. A broken Redis relay keeps local delivery but
queues no cross-instance backfill. Divergence and relay-gap counts are lower
bounds, not exact loss totals. A realtime `recovered` event clears the
server-breaker input but does not prove application state was refetched, and a
client may remain degraded for independent flow, smooth, or CRDT recovery.

Restarting replaces in-memory state and makes every client reconnect; during
shared-store latency that can amplify the original load. Treat outcomes during
the correlated interval as unknown unless an application replay, delta, or
authoritative rehydrate contract proves them.

## Abort criteria

- Do not restart a ready/live fleet to clear load, a breaker, backpressure, or
  stale application state. Use the process runbook only when its liveness or
  fatal-path criteria independently require replacement.
- Do not call `breaker.reset()` or accept Redis `PING` latency as recovery.
- Do not pin protection to `normal`, remove admission limits, or release the
  waiting room while pressure samples are stale, drop counters are rising, or
  the recovery wave is still growing.
- Do not reconnect every client or rehydrate every stream at once. Keep the
  advertised jitter/de-herd window and an application-owned concurrency cap.
- Abort relaxation when any instance returns to broken/probing, the metrics
  lifeline ages past its bound, backpressure/drop rate rises, readiness changes,
  or representative state differs across instances.

## Decision tree

1. If liveness failed or a fatal path terminated the process, use
   [process and deploy](./process-and-deploy.md), but keep this runbook's
   reconnect and rehydrate gates for the replacement.
2. If Redis is broken/probing or latency is outside the application's guarded
   operation budget, keep client mitigation active and follow
   [Redis outage](./redis-outage.md) before changing admission.
3. If metrics are stale/degraded, treat sampled capacity values as unknown and
   use the lifeline, supervisor, and transition counters; do not infer recovery
   from a flat graph.
4. If drops, divergence, or relay gaps occurred, choose replay/delta/full
   rehydrate before relaxing the protection that bounds that recovery load.
5. Only after dependency, state, and load checks all pass may protection relax
   one level and the next bounded client cohort enter.

## Protective-state response matrix

The state column is a stable drill identifier. Evidence means the complete
signal set for the row, not one convenient green sample.

| State | Evidence | First safe action | Escalate or abort when | Loss and uncertainty | Recovery proof |
|---|---|---|---|---|---|
| `admission-constrained` | waiting-room depth or `upgrade_rejected_total{reason="over_capacity"}` rises while liveness is healthy | Keep the gate and jitter; slow the arrival source or add proven capacity | readiness/liveness changes, the queue grows after capacity is added, or rejection reasons are not capacity-owned | refused upgrades created no session; retry outcomes remain client-owned | queue and rejection rate fall for two observation windows and a bounded new cohort connects |
| `posture-normal` | protection state is `normal` and the pressure sample is fresh | Make no posture change; evaluate every other active row independently | another row is active or `normal` is presented as proof that Redis, state, or clients recovered | no direct protection loss; normal posture says nothing about earlier drops or skipped relay | all applicable dependency, state, client, queue, and freshness checks pass independently |
| `posture-elevated` | protection state is `elevated` with a fresh pressure reason/sample | Reduce publishers and optional work; keep widened retry jitter | pressure reason worsens, samples age, or drops begin | existing connections remain; optional/shed application work may be absent | fresh pressure stays below the entry threshold for the configured hysteresis and no dependent gate is worse |
| `posture-siege` | protection state is `siege`; new upgrades receive waiting-room/503 responses | Freeze new connection growth and preserve existing sockets; remediate the named constraint | an operator proposes `normal`, fleet restart, or an unbounded reconnect before dependency/state proof | new sessions are refused; existing sessions can still have relay or frame loss from other rows | dependency/state checks pass, drops stop, queues drain, then auto-relaxation or an approved one-level unpin succeeds |
| `backpressure` | buffered connections/max bytes stay high or dropped-frame/byte counters increase | Slow, coalesce, or shed publishers before adding receivers | drops continue, the affected stream is not replayable, or queues grow during recovery | status `2` frames are lost; sampled buffer gauges can undercount short queues | exact drop counters stop increasing and buffered gauges remain below the deployment threshold for two windows |
| `host-pressure` | low descriptor headroom, PSI, CPU quota, heap, or resident-memory signal names the constraint | Repair the named host/container limit or reduce work; retain admission protection | metrics are stale, OOM/fatal evidence appears, or scaling increases shared dependency latency | in-flight and socket outcomes may be unknown after a fatal exit; a limit change backfills nothing | fresh underlying signal and saturation recover without a new fatal/restart loop |
| `metrics-degraded` | snapshot degraded/incomplete, sample timestamp stale, or lifeline snapshot age exceeds its bound | Treat other sampled gauges as untrusted; use supervisor logs, transition counters, and the pause-aware lifeline | the lifeline is also stale or an operator proposes relaxing protection from flat metrics | observability loss is not workload loss, but it removes proof of both damage and recovery | all workers report, sample/lifeline ages are bounded, and transition counters advance on a controlled probe |
| `redis-broken` | shared breaker is `broken`/`probing`, guarded latency exceeds budget, or clients receive server `degraded` | Keep local-only semantics explicit, stop topology churn, and repair Redis without clearing keys/channels | any instance fails its real probe, replication is uncertain, or a reset/failover would change key history | cross-instance relay is skipped and not queued; primitive-specific writes may fail or be unknown | real guarded operation on every instance, bidirectional cross-instance publish, and representative replay read/write pass |
| `state-divergent` | relay gap, divergence, replay `truncated`, or inconsistent representative reads | Preserve ids/evidence and select replay, delta, or authoritative full rehydrate | coverage/epoch is unknown, evidence is incomplete, or incremental repair disagrees | gap counts are lower bounds; affected state is unknown without coverage proof | two instances and a fresh reconnect converge on authoritative state after the selected repair |
| `client-degraded` | realtime degradation is active from server, flow, smooth, or CRDT input | Honor the published mitigation; suppress named streams/RPCs and keep retries staggered | the cause is not identified or a server `recovered` event is treated as complete client recovery | server recovery clears only one input; cached/predicted/document state can remain stale | mitigation clears only after required refetch/resync and representative client health/state agree |
| `recovery-wave` | breaker probes succeed but reconnect, rehydrate, admission, or backpressure load is still rising | Admit one bounded jittered cohort while protection remains engaged | any breaker regresses, drops resume, queue depth rises, or metrics freshness is lost | an excessive wave can recreate every prior loss mode | all applicable earlier row checks hold through two windows, the cohort drains, and the next cohort does not increase saturation |

## Correlated overload plus Redis-latency drill

Run the repository's `npm run drill:operations` gate first, then give a cold
responder this timeline without the expected actions:

1. Both `/healthz` and `/readyz` are healthy. Protection is `siege`, admission
   is serving the waiting room, backpressure drop counters are rising, Redis
   guarded-operation latency exceeds its budget, every breaker is `broken`, and
   realtime clients received `degraded`. The pause-aware metrics lifeline is
   fresh. The proposed action is to restart every instance, call
   `breaker.reset()`, pin protection to `normal`, and reconnect all clients.
2. Redis latency returns to baseline. One instance has completed a real guarded
   probe, another remains `probing`, and no cross-instance publish has been
   checked. The proposed action is to emit `recovered` globally.
3. Every instance is healthy after a guarded operation and bidirectional
   cross-instance publish/replay passes. Drop counters have stopped, but
   rehydration increases waiting-room and buffered-connection gauges.
4. A bounded jittered cohort completes authoritative rehydration. Metrics stay
   fresh, no drop counter advances, queues drain, representative state agrees
   across two instances and a fresh reconnect, and the same holds for a second
   observation window.

The pass answer refuses every proposed action in step 1, holds mitigation in
step 2, starts only bounded rehydration in step 3, and relaxes protection by at
most one level after step 4. Restart is considered only if the independent
process runbook requires it. Dependency health, state repair, load drain, and
metrics freshness are four separate gates.

## Procedure

1. Record one timestamped row per instance: readiness/liveness, posture,
   pressure reason/sample age, admission/rejection, buffer/drop counters,
   metrics/lifeline age, Redis breaker/guarded latency, client degradation, and
   divergence/replay evidence.
2. Freeze rollout, fleet restart, breaker reset, topology changes, protection
   relaxation, and unbounded reconnect/rehydration.
3. Repair the earliest shared dependency or resource constraint while current
   admission and client mitigation bound amplification.
4. Prove the dependency through a real guarded application operation on every
   instance; then prove cross-instance and replay behavior.
5. Select replay, delta, or full rehydrate from coverage evidence. Release a
   jittered bounded cohort and stop if any abort condition fires.
6. After two clean observation windows, relax one protection level or admit the
   next cohort. Repeat the evidence row before every relaxation.

## Recovery verification

- Every instance is ready/live, its metrics snapshot/lifeline is fresh, and its
  breaker is healthy after a real guarded operation.
- Bidirectional cross-instance publish plus the representative replay/durable
  path passes; authoritative state agrees across two instances and a fresh
  client reconnect.
- Exact drop counters do not advance and buffered/admission queues drain across
  two observation windows that include a bounded recovery cohort.
- Client mitigation clears only after required refetch/resync, not merely after
  transport recovery, and no independent health input remains degraded.
- Protection relaxes no faster than one level/cohort per evidence cycle.

## Escalation and handoff

Include the per-instance evidence rows, package/release tuple, correlated
interval, actions held back, dependency probe and cross-instance results,
known dropped-frame counts, unknown state intervals, chosen rehydrate method,
cohort size/jitter, every abort decision, observation-window duration, current
protection level, and the next decision time.
