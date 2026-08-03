# Postgres durable jobs and tasks

## Trigger

Use this runbook for Postgres unavailability, a growing job/task backlog,
expired visibility/fences, repeated retries, stuck `running` tasks, or an
unknown outcome after a worker/process failure.

## Owner

The data/backend owner restores Postgres. The workload owner decides whether an
external effect is idempotent or fenced. The incident commander alone approves
manual takeover, retry, terminal disposition, or dead-letter replay.

## Loss semantics

Jobs use visibility timeout and are delivered at least once: a crashed worker's
claim expires and another worker may repeat the payload. Tasks use a fence UUID
and conditional commit so one current attempt owns the canonical result, but a
late expired attempt can overlap its successor and may already have performed
an external effect. Neither mechanism makes that external effect exactly once.
Stable downstream idempotency keys or equivalent fences are required.

## Abort criteria

- Do not retry, `complete`, delete, clear, or dead-letter work whose external
  outcome is unknown.
- Abort takeover when the handler ignores its abort signal or the downstream
  service cannot prove stable-key idempotency/fencing.
- Do not update task fences/status directly in SQL; use the task runner's
  takeover/recovery path so stale commits remain fenced out.
- Abort recovery if backlog falls only because rows were deleted, terminal
  failures rise, or new work cannot complete end to end.

## Decision tree

1. If Postgres is unavailable, stop producers whose acknowledgement requires a
   durable row; do not acknowledge work kept only in memory.
2. If rows are pending with no active workers, restore a compatible registered
   worker and wait for its normal dispatch/recovery sweep.
3. If a job claim expired, verify the handler's downstream idempotency before
   allowing redelivery.
4. If a task fence expired, inspect its request/idempotency key and downstream
   result. Use `takeover(taskId)` only for a controlled drain and only after the
   overlap contract is safe.
5. If an external effect exists but the row is not terminal, reconcile the row
   through application-owned logic; never blindly execute the effect again.

## Procedure

1. Record package tuple, database endpoint/role, workload name, task/job ids,
   request ids, attempt counts, fence/visibility deadlines and first failure
   time. Do not copy payloads or credentials into the incident log.
2. Stop or shed producers before the backlog exceeds the application's recovery
   capacity. Preserve rows and the database write-ahead/replication history.
3. Restore Postgres and wait for migrations/readiness. Inspect counts with the
   configured table names; defaults are `svti_tasks` and `svti_jobs`.
4. For every unknown outcome, query the downstream system by the stable
   idempotency key or fence before choosing retry, reconcile or manual review.
5. Resume one worker and one workload first. Let normal visibility/fence
   recovery claim a bounded batch; do not release the entire backlog at once.
6. Increase concurrency gradually while watching attempt, failure, latency and
   backlog direction. Move permanent failures only through the application's
   documented dead-letter policy.

## Recovery verification

- A newly enqueued canary row is durably visible, claimed once, performs an
  idempotent non-destructive effect, and reaches its expected terminal state.
- Pending/running counts decrease because work commits, not because rows are
  cleared; terminal failure and attempt rates remain within policy.
- A forced test worker interruption produces one safe visibility/fence recovery
  and rejects a stale completion in the existing integration test environment.
- Downstream systems show no duplicate effects for sampled recovered work.
- Cleanup/retention resumes only after outcome-unknown rows are reconciled.

## Escalation and handoff

Include table names, counts by state, oldest age, affected workload names,
sample task/job and request ids, downstream idempotency evidence, any manual
takeover/retry, duplicate-effect checks, and the exact rows still unknown.

