# Operations pack v1

Operations pack version: **1**. This is the cold-start incident entry point for
the `svelte-adapter-uws`, `svelte-realtime`, and
`svelte-adapter-uws-extensions` runtime. Keep a deployed copy reachable when
the application and its source host are unavailable.

This pack supplies framework facts and stop conditions. The application owner
must add deployment names, dashboards, paging routes, data-store consoles,
credentials, and business recovery-point objectives next to its deployed copy.
Do not edit this version in place for local policy; overlay those values and
retain this version so an incident record can name the exact procedure used.

Before launch or a capacity-affecting topology change, produce and independently
review a passing [capacity kit v1](../../capacity/v1/README.md) result for the
exact release and deployment shape. Repository microbenchmarks and an idle
health probe are not substitutes for peak, saturation, and recovery evidence.

## First five minutes

1. Name one incident commander and one operator for each affected ownership
   lane. The commander decides; operators execute and report exact evidence.
2. Record the UTC start time, deployed versions of all three packages, release
   identifier, affected regions, and one request or diagnostic id. Do not copy
   payloads, raw topics, credentials, or personal data into the incident log.
3. Freeze rollout, manual replay, queue clearing, breaker resets, and repeated
   restarts until the [failure map](./failure-map.md) selects a runbook.
4. Read the selected runbook's loss semantics and abort criteria aloud before
   changing state.
5. Declare recovery only after every recovery check passes. A green dependency
   probe alone is not application recovery.

## Ownership lanes

| Lane | Owns during the incident | Does not decide alone |
|---|---|---|
| Incident commander | scope, priority, state-changing approval, communications, final recovery call | backend repair or task replay mechanics |
| Runtime operator | process, readiness/liveness, worker restart, drain and release tuple | whether an external side effect is safe to repeat |
| Realtime owner | RPC, subscription, replay, sequence and client rehydration behavior | Redis/Postgres restoration |
| Data/backend owner | Redis/Postgres health, replication, storage and connection limits | application-level loss acceptance |
| Workload owner | task/job idempotency, downstream fences, dead-letter disposition | force-completing unknown work without evidence |

One person may hold several lanes on a small team, but the incident record must
still name which decision they are making.

## Non-negotiable safety rules

- Do not restart an instance merely because readiness says `starting` or
  `draining`; liveness and the configured startup/shutdown budgets decide
  whether it is stuck.
- Do not call `breaker.reset()` as a recovery test. Let a real guarded
  operation take the probe slot and verify the application path afterward.
- Do not replay, complete, delete, or clear durable work whose external effect
  is unknown. Establish idempotency or downstream fence evidence first.
- Do not roll back one ecosystem package independently. Record and restore a
  known-compatible adapter/realtime/extensions tuple.
- Do not interpret a relay-gap count or a divergence sequence lower bound as
  an exact loss count. Rehydrate unless the configured replay/delta contract
  proves coverage.

## Runbooks

- [Process, worker, drain and bad-release recovery](./process-and-deploy.md)
- [Redis and cross-instance relay outage](./redis-outage.md)
- [Correlated resource-control response](./resource-controls.md)
- [Postgres durable jobs and tasks](./durable-work.md)
- [Replay gaps and cross-worker state divergence](./state-delivery.md)
- [Coordinated protocol release and rollback](./coordinated-release.md)

Use the [cold drill](./drill.md) after changing the pack and at least once per
release train. Repository validation is `npm run drill:operations`; it checks
the versioned corpus, required decision sections, the protective-state matrix,
the correlated overload-plus-Redis-latency scenario, and local links without
contacting production.

## Incident handoff record

Every handoff must include: UTC interval, current owner, affected deployment,
package tuple, user-visible impact, chosen runbook, actions taken, actions
explicitly not taken, diagnostic/request ids, known loss semantics, current
abort criterion, recovery checks already passed, and the next decision time.
