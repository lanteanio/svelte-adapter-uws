# Persistence boundary

Status: Accepted.

## Context

Zero-configuration development needs useful local primitives, while production
deployments may need durable replay, idempotency, tasks, presence, or locks.
Pretending an in-memory map and a database have identical failure semantics
creates false durability claims.

## Decision

The adapter and realtime own bounded in-memory defaults where saturation can
reject or evict safely, plus explicitly documented warn-only registries where
eviction would corrupt routing. A warn-only threshold is not a memory bound;
realtime's `TOPIC_WS_COUNTS_WARN_THRESHOLD` is one such exception. Both
packages state restart and multi-process limits. The extensions package owns
reusable Redis/Postgres storage contracts, key/table layouts, migrations,
cleanup, and backend failure behavior. The application owns business records,
tenant policy, retention, and the decision to stop or degrade when a required
backend is unavailable.

A circuit breaker is optional and must be passed to the extension that should
use it. Without one, the backend operation runs directly and exposes its native
error or timeout. With one, repeated failures open the breaker and later
operations fail fast or skip according to that extension's contract. Neither
path turns a missed durable write into a successful one. Recovery must follow
the owning store's documented reconciliation and rollback contract.

## Consequences

- A single process works without mandatory infrastructure.
- Adding a bus alone does not make replay, presence, locks, or application
  state durable.
- Durable schema changes are verified and released by the package that owns
  the schema.
- Application authorization runs before an identity-blind store receives a
  user, tenant, topic, or key.

Revisit when a primitive moves ownership and its migration, failure, and
rollback contract move with it.
