# Process, worker, drain and bad-release recovery

## Trigger

Use this runbook for unavailable liveness, readiness stuck at `starting` or
`draining`, fatal assertions, repeated worker replacement, or a release that
raises boot/handshake/RPC/subscription failures.

## Owner

The runtime operator executes. The incident commander approves forced
termination and rollback. The release owner supplies the exact compatible
adapter/realtime/extensions tuple.

## Loss semantics

A clean drain first marks readiness unavailable and waits the configured
load-balancer delay. Its realtime shutdown hook then rejects new work with
`UNAVAILABLE`, waits for in-flight work, advises WebSocket clients to reconnect,
and closes them with `1001`. A forced exit can leave in-flight outcomes unknown. Process-local
presence, replay and registries are lost on a full process restart; configured
Redis/Postgres state survives according to its own runbook. Client retry is
safe only where the application operation is idempotent.

## Abort criteria

- Abort a rollout when any new instance misses its startup budget, readiness
  never becomes `200`, or the compatible package tuple is not known.
- Abort a normal drain only after its configured `SHUTDOWN_DELAY_MS` plus
  `SHUTDOWN_TIMEOUT` has elapsed and the supervisor's own termination deadline
  requires escalation.
- Abort automatic worker replacement when the process reaches its restart cap
  or the same fatal category repeats; preserve evidence and stop the fleet from
  looping before increasing the cap.
- Never kill a merely `starting` or `draining` instance because readiness is
  `503`; liveness and elapsed budget are the deciding signals.

## Decision tree

1. If liveness is green and readiness says `starting`, inspect `init` progress,
   dependency readiness and the startup budget. Keep it out of rotation.
2. If liveness is green and readiness says `draining`, confirm the deployment
   controller removed traffic, then wait for the single shutdown budget.
3. If liveness is absent or a worker is unresponsive, capture diagnostics and
   let the configured supervisor replace it once.
4. If replacement repeats the same failure, stop replacement escalation and
   classify a release regression, backend outage, or state-delivery incident.
5. If the failure began with a deploy, restore one previously verified
   ecosystem tuple; never independently downgrade one package.

## Procedure

1. Record UTC time, instance/worker identity, package tuple, release id,
   readiness body, liveness result, exit code, fatal category, and the previous
   100 diagnostic lines. Keep payloads and secrets out of the incident record.
2. Freeze the rollout. Remove failing instances from new traffic through the
   load balancer; do not use a liveness kill to perform graceful removal.
3. For a planned drain, confirm `/readyz` is `503 draining` while `/healthz`
   remains `200`. Wait through the configured delay and shutdown budget.
4. For a wedged or crashed worker, allow one supervised replacement and watch
   its startup acknowledgements/readiness. Do not manually race the supervisor.
5. For rollback, restore the recorded known-good adapter, realtime and
   extensions versions together. Preserve database migrations unless their
   documented rollback is independently proven safe.
6. Keep old and new instances separated from traffic if their tuple or wire
   compatibility is uncertain. Prefer completing the rollback over a long
   mixed fleet.

## Recovery verification

- Every serving instance returns liveness `200` and readiness `200`; no
  instance remains `starting` or `draining` unexpectedly.
- Worker count is stable for at least two health intervals and the fatal/restart
  category does not recur.
- A fresh authenticated WebSocket can connect, complete one idempotent RPC,
  subscribe to a representative stream, receive a new event, disconnect and
  reconnect to a different instance.
- Redis/Postgres dependent checks from their runbooks pass when those systems
  are configured.
- Rollout state and the exact package tuple match on every instance.

## Escalation and handoff

Escalate with the incident handoff record plus exit code, fatal category,
startup/drain elapsed times, supervisor decisions, last known-good tuple, and
which in-flight operations remain outcome-unknown. State explicitly whether a
forced termination occurred.
