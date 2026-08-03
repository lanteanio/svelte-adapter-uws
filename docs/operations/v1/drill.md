# Cold operations drill

Run this drill with a responder who did not write the current pack. Give them
only the alert card, the deployed application overlay, and the [pack index](./README.md).
An observer may answer questions only with evidence that the simulated systems
would expose.

## Automated corpus check

From the adapter repository, run `npm run drill:operations`. It must report the
pack version, expected files, runbook decision sections and local-link result
without network or production access. This check validates executability of the
document set; it does not replace the human decision drill.

## Human pass criteria

The responder passes when they:

1. assign ownership and select the correct runbook within five minutes;
2. state the relevant loss semantics before proposing a state-changing action;
3. refuse every forbidden shortcut named by that runbook's abort criteria;
4. name at least two independent recovery checks, including an application
   path rather than dependency health alone; and
5. produce a complete handoff record with exact, lower-bound and unknown facts
   distinguished.

Any unsafe replay, queue clear, uncoordinated package rollback, breaker reset as
proof, or readiness-triggered kill is an automatic fail. Repair the docs before
repeating the drill; coaching the responder is not a passing result.

## Scenario cards

### Card A: draining release

The new instance is `ready`, the old instance says `503 draining` while
liveness remains `200`, and the deployment controller proposes killing it
after ten seconds. The configured shutdown delay is 15 seconds and timeout is
30 seconds. Expected route: [process and deploy](./process-and-deploy.md).

### Card B: Redis returned

Redis answers its platform probe after a 12-minute outage. Two app instances
still report a broken breaker and clients have not refetched. The operator
proposes `breaker.reset()` and closing the incident. Expected route:
[Redis outage](./redis-outage.md).

### Card C: charged but running

A payment task is still `running` after its fence expired. The payment provider
shows a charge under the task's idempotency key, while the application row has
no terminal result. The operator proposes rerunning the handler. Expected
route: [durable work](./durable-work.md).

### Card D: bounded divergence evidence

A divergence record is incomplete, reports one pseudonymous stream with a
tail-gap lower bound, and the affected client's replay epoch is unknown. The
operator proposes incremental replay followed by a worker restart. Expected
route: [state delivery](./state-delivery.md).

### Card E: overload plus Redis latency

Both health and readiness are green, but protection is `siege`, the waiting
room is active, backpressure drop counters are rising, Redis guarded-operation
latency exceeds its budget, every breaker is `broken`, and realtime clients
received `degraded`. The metrics lifeline is fresh. The operator proposes a
fleet restart, `breaker.reset()`, pinning protection to `normal`, and reconnecting
every client. Redis later answers quickly, but one instance remains `probing`
and no bidirectional cross-instance publish, replay, or authoritative
rehydration has passed. Expected route:
[correlated resource controls](./resource-controls.md). The responder must keep
mitigation active, prove every instance with a real guarded operation, repair
state through a bounded jittered recovery cohort, and wait for fresh metrics,
zero new drops, drained admission/backpressure queues, and cross-instance state
agreement across two observation windows before relaxing one protection level.

## Drill evidence

Record date, pack version, scenario, responder/observer, time to ownership,
time to runbook, stated loss semantics, proposed actions, refused unsafe
actions, recovery checks, handoff text, result, and exact documentation changes
required. Keep this evidence in the application's incident-readiness system;
do not add production identities or secrets to this public pack.
