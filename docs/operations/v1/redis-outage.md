# Redis and cross-instance relay outage

## Trigger

Use this runbook when a shared Redis breaker leaves `healthy`, clients receive
the realtime `degraded` event, cross-instance publishes stop, or Redis-backed
presence, replay, rate limiting, locks, leases or registries fail.

## Owner

The data/backend owner restores Redis. The realtime owner owns client
mitigation and rehydration. The incident commander approves topology changes,
failover and early removal of mitigation.

## Loss semantics

The pub/sub wrapper continues local delivery while Redis relay is skipped, so
clients on different instances can observe different event histories. Other
primitives differ: presence and replay awaited calls throw, distributed rate
limiting fails closed, and fire-and-forget heartbeat/relay/cursor work is
skipped. The breaker queues no work for later. A recovered connection therefore
does not backfill the outage by itself.

## Abort criteria

- Do not use `breaker.reset()` to declare recovery; it bypasses the real probe.
- Do not reshard, change key/channel prefixes, clear replay keys, or fail over
  to a store with unknown replication position during the incident.
- Do not dismiss client mitigation after `PING` alone. Abort recovery if any
  instance remains broken/probing or a representative guarded operation fails.
- Do not claim gap-free delivery unless replay or delta coverage proves it;
  otherwise require full rehydration.

## Decision tree

1. If only one instance is degraded, inspect its network, DNS, credentials and
   client state before changing Redis topology.
2. If every instance is degraded, restore the shared service or perform the
   platform's proven failover while application mitigation remains active.
3. If Redis responds but breakers have not recovered, wait for the configured
   reset timeout and let one real guarded operation take each probe slot.
4. If recovery succeeds, treat all cross-instance streams as potentially stale
   during the outage and select replay, delta sync, or full rehydrate.

## Procedure

1. Record breaker state/failure count per instance, first degraded time,
   affected Redis endpoint and every primitive sharing that breaker.
2. Keep local service available only where its documented degraded semantics
   are acceptable. Disable or shed operations that require distributed locks,
   cross-instance ordering, replay, presence truth, or distributed rate limits.
3. Restore Redis connectivity without clearing keys or channels. Verify server
   role/replication and credentials through the deployment's normal console.
4. Wait for the configured breaker reset timeout. Exercise one representative
   guarded operation on each instance; do not manually force state.
5. Confirm each instance emits/observes recovery, then trigger application
   rehydration for streams whose outage interval lacks proven replay/delta
   coverage. Keep the recovery wave staggered.
6. Re-enable shed features gradually and watch breaker transitions, replay
   truncation, stale presence and request error rates.

## Recovery verification

- Every instance's shared breaker is `healthy` after a real guarded operation,
  not just a Redis transport probe.
- Cross-instance publish works in both directions between two distinct
  instances and a representative replay read/write succeeds.
- Distributed rate limiting, presence/registry ownership and any lock/lease
  primitive used by the application pass one non-destructive check.
- Clients clear degradation only after refetch/rehydration completes; a fresh
  event and a reconnect across instances produce the same state.
- No new `degraded` transition occurs for two reset-timeout windows.

## Escalation and handoff

Include breaker state by instance, Redis topology/replication evidence,
affected primitives, exact degraded interval, whether local-only delivery
continued, which streams were fully rehydrated, and any interval whose delivery
coverage remains unknown.

