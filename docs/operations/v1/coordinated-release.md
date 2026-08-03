# Coordinated protocol release and rollback

## Trigger

Use this runbook before a breaking client/server contract change, when a fleet
contains mixed application or ecosystem versions, when protocol mismatch
signals appear, or when rollback would put a newer cached client against an
older server. Use it before renaming any stream with durable alarms.

## Owner

The release owner owns the exact application, adapter, realtime, extensions,
native-addon and client-asset tuple. The incident commander approves cutover
and rollback. The workload owner approves durable-alarm migration or terminal
disposition; a runtime operator must not delete unresolved rows alone.

## Loss semantics

A server range policy accepts only advertised versions from `minimum` through
`current`, inclusive. Under `reject`, missing, invalid, too-old and too-new
clients receive `PROTOCOL_MISMATCH` before application dispatch. Under
`notify`, work still executes; it is an observation stage, not containment.

Browser assets can outlive a server rollback in caches and open tabs. Restoring
only the server therefore does not restore the contract. Durable alarms written
before a path rename also outlive process code: a stable alarm id preserves
resolution, while an unknown/duplicate resolver is retained and requires
operator disposition.

## Abort criteria

- Do not raise `minimum` until every server understands the range policy and
  the remaining old/missing-client population is explained.
- Do not treat `notify` as enforcement or a green mismatch count as proof that
  cached clients have expired.
- Do not roll back only one ecosystem package or application asset. Restore
  one recorded tuple, and keep the restored server's `current` ceiling armed.
- Do not rename an alarm-bearing stream until its stable `alarm.id` has run on
  every writer and every row written without that id has fired, been cancelled,
  or been explicitly drained. A durable store has no framework retention cap.
- Do not delete an unresolved durable alarm merely to clear the diagnostic.

## Decision tree

1. If the range-policy baseline is not already deployed everywhere, stop. Ship
   it without a breaking change and make that release the rollback baseline.
2. If old and new clients are both supported, expand the range under `notify`
   and measure every reason before changing enforcement.
3. If an unexplained missing, invalid, too-old or too-new client remains, abort
   cutover and identify its asset, worker and release tuple.
4. If the client rollout is complete, switch to `reject` while the old version
   remains accepted; then raise `minimum` as the separate breaking cutover.
5. If recovery needs rollback, restore the complete last-known-good tuple. Its
   `current` ceiling rejects newer clients until matching assets are restored.

## Procedure

1. Record the candidate and last-known-good package/application tuples, client
   asset digest, protocol `current`/`minimum`, the inventory and disposition of
   every pre-id alarm row, and every alarm id/path migration.
2. Deploy policy support with the existing protocol version and `notify`.
   Confirm missing advertisements are observable before relying on the gate.
3. Deploy a server that supports both protocol versions; keep the old version
   at or above `minimum`. Exercise the matrix below on each worker cohort.
4. Deploy the new client asset. Verify new connections advertise `current`
   before resubscribe and queued work.
5. Change `onMismatch` to `reject` without raising `minimum`. Prove typed
   rejection and zero application-handler execution for both range directions.
6. Raise `minimum` only after the accepted old-client window closes. Keep the
   previous complete tuple and client artifact available for rollback.
7. For an alarm path rename, keep the same stable id across both releases and
   verify an overdue row written with the old path fires through the new path.

## Release and rollback matrix

The repository gate parses every row and verifies the advertised version lies
inside or outside the inclusive range exactly as the expected result states.
Realtime's driven protocol suite executes the same scenario ids through the
actual message hook and asserts whether application code ran.

| Scenario id | Server current | Server minimum | Client advertises | Policy | Expected result |
|---|---:|---:|---:|---|---|
| baseline | 2 | 2 | 2 | notify | admitted |
| range-expand | 3 | 2 | 2 | notify | admitted |
| client-cutover | 3 | 2 | 3 | reject | admitted |
| minimum-cutover | 3 | 3 | 2 | reject | PROTOCOL_MISMATCH |
| rollback | 2 | 2 | 3 | reject | PROTOCOL_MISMATCH |

A separate missing-advertisement case must return `PROTOCOL_MISMATCH` under
`reject`; it cannot be represented as an integer table cell.

## Recovery verification

- Every serving worker reports the same exact package/application tuple and
  protocol range.
- A client at `minimum` and one at `current` complete an idempotent RPC and
  representative stream; a below-minimum, above-current and missing client
  receive `PROTOCOL_MISMATCH`, with no application handler invocation.
- A new connection advertises before resubscribe, offline replay or queued RPC.
- Rollback restores matching client assets and clears incompatible health only
  through a fresh compatible connection, not a server-side reset.
- An alarm row persisted with an old RPC path and stable id fires once through
  the renamed handler; unresolved rows remain present for disposition.

## Escalation and handoff

Include both exact tuples, asset digests/cache headers, policy/range per cohort,
mismatch counts by bounded reason, client versions exercised, handler-execution
evidence, rollout/rollback step reached, alarm ids/path changes, unresolved row
counts, abort decision, and the next decision time.
