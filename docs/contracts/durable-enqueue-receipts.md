# Durable enqueue receipts

This is the implementation contract for a new extensions task-runner feature.
It is not a guarantee of the existing `enqueue()`: that method inserts a fresh
task ID on every call and only forwards `idempotencyKey` for handler effects.
The optional `run()` committed-result cache remains a separate feature.
Consumers must wait for the backend implementation and migration before using
the new methods below.

## Public surface and scope

```ts
interface TaskEnqueueReceipt {
  taskId: string;
  dedupExpiresAt: number; // database epoch milliseconds
}
interface TaskEnqueueOnceOptions extends TaskRunOptions {
  tenantId: string | null;
  idempotencyKey: string;
  dedupTtlMs?: number;
}
interface TaskEnqueueReceiptQuery {
  tenantId: string | null;
  idempotencyKey: string;
}
// Methods on the task runner:
enqueueOnce(name: string, options: TaskEnqueueOnceOptions): Promise<TaskEnqueueReceipt>;
lookupEnqueueReceipt(name: string, query: TaskEnqueueReceiptQuery): Promise<TaskEnqueueReceipt | null>;
```

A key is scoped by the configured database/schema/task table, exact tenant,
task name and idempotency key. Null is the untenanted scope, distinct from every
string. Tenant validation follows the [erasure identity contract](./tenant-erasure-identity.md);
keys remain nonempty strings of at most 256 characters. The same key for another
task name or tenant is independent. Callers supply tenant identity from trusted
server context and authorize receipt lookup; a key is not an access capability.
No client request may choose another tenant merely by supplying this option.

`dedupTtlMs` defaults to 24 hours and accepts a positive integer up to 30 days.
The first insertion fixes `dedupExpiresAt` using database time. Retries do not
extend it or replace the original tracing, owner, input or scheduling metadata.
A duplicate with a different TTL still returns that original expiry. Operators
choose a window long enough for their producer retries and recovery. This is a
bounded deduplication guarantee, not a promise of exactly-once handler effects.

## Input identity and concurrent insertion

Encode input once using the runner's existing payload validation, retaining the
exact validated JSON bytes for both insertion and identity comparison. Equal
bytes are equal input; object key order and `toJSON` output are significant.
Callers that need semantic equivalence must canonicalize before submission.
Never stringify a second time after validation. A digest can accelerate lookup,
but the stored validated bytes remain the equality authority.

The active receipt mapping stores task ID, those input bytes, qualified erasure
owner (when present), creation time and expiry. Its unique scope is the tuple
above, encoded without delimiter ambiguity and without SQL null-uniqueness
holes. A valid existing mapping with different input or erasure owner rejects
with `TaskEnqueueConflictError`; it does not insert, return the original task ID,
or run either handler. A nonnull extracted owner must match the enqueue tenant.
An absent owner is explicit unattributed data with the erasure coverage limits
in the identity contract.

Creation of the pending task and receipt mapping is one database transaction.
Concurrent producers serialize on the unique scope; one durable task wins and
all equal retries return its committed receipt. A rollback leaves neither row.
Process-local maps, a Redis result cache, a pre-insert SELECT, or a guessed UUID
cannot establish this guarantee. Workers and later processes recover the same
receipt from the same database rows. Task execution still uses the existing
fencing/retry rules and may repeat external effects unless the handler makes
those effects idempotent.

## Ambiguous replies and recovery

Return a receipt only after commit is confirmed or a committed mapping is read
back from the authoritative database. If the INSERT/COMMIT reply is lost and
recovery cannot establish whether it committed, reject with
`TaskEnqueueOutcomeUnknownError`. That error carries tenant, name and key, never
an unconfirmed task ID. It means the caller must recover or retry the same
submission, not generate a replacement key. Do not fall back to `enqueue()` or
execute the handler inline when the database is unavailable.

`lookupEnqueueReceipt` reads the authoritative mapping: it returns a currently
valid receipt, null when none is visible, or a backend error when the read
cannot establish that answer. It does not consult a replica that can lag the
commit. Null alone is not proof that another in-flight transaction cannot
commit later. Retrying `enqueueOnce` with the same input is safe while the
original deduplication window remains active because the unique transaction
resolves that race. Validation failures and confirmed rolled-back operations
remain ordinary failures with no claimed receipt; an uncertain commit is never
reported as a definite non-insertion.

## Retention, expiry and erasure

Task/result cleanup cannot delete a live receipt mapping. Its receipt remains
recoverable even if a completed task's result or row was cleaned up; awaiting
that task then reports the runner's existing missing/expired-result outcome,
not a cached handler result and not a replacement task. Store the task ID
without a cascading foreign key that could silently remove the mapping.
Receipt cleanup uses database time and removes only expired mappings.

Once expired, lookup returns null and a new enqueue may atomically replace the
mapping and create a new task, even if the previous task still exists or runs.
Concurrent expiry replacement uses the same unique-scope transaction. Returning
an old receipt or refreshing it implicitly is forbidden. Recovery attempted
past expiry cannot distinguish an old lost success from no submission; callers
must reconcile business state before retrying if duplication is unacceptable.

Qualified user erasure removes matching task rows, result material and receipt
mappings in the same erasure operation, including the input copy and owner
stamp. Enqueue/erase transactions coordinate by the same identity so a
pre-erasure in-flight insertion cannot resurrect a removed mapping. Any
external cache storing an associated result is an explicit erasure participant;
cache failure makes erasure incomplete. Applications revoke write authority
before erasure and keep it revoked; a later newly authorized request can create
a new task, since erasure intentionally removes its old deduplication memory.
There is no retained personal-data tombstone with an undocumented lifetime.

The `run()` cache neither supplies nor consumes these receipts. `enqueueOnce`
always forwards the original key to its handler like `enqueue`; consumers must
scope downstream effect keys themselves when another service has a broader key
namespace. Installing a cache does not alter receipt retention or uniqueness.

## Migration and required evidence

Extensions owns a versioned migration for the mapping table, unique constraint,
input/owner columns and expiry/erasure indexes through its migration ledger.
`autoMigrate: false` requires that migration before enabling the methods; a
missing schema fails explicitly. Do not synthesize receipts for historic
`enqueue()` rows: repeated keys were legal and there is no unique historical
winner. Existing run/enqueue behavior and rows keep their previous contract.
Rollback disables new receipt producers while preserving live mappings for
recovery; dropping them early shortens a guarantee already returned to callers.

Backend tests must cover simultaneous equal and conflicting producers, tenant
and task-name separation, exact input bytes, null scope, transaction rollback,
process restart, lost INSERT and COMMIT replies, authoritative recovery errors,
cleanup before expiry, concurrent expiry replacement and erasure races. Run
against the actual supported database, not only mocked query responses. Demo
consumers must retain the returned receipt, show uncertain outcomes as
recoverable, and retry with the same scope/key/input; enable a deduplication
claim only against the published backend version and its applied migration.
