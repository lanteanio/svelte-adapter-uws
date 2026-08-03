# Replay gaps and cross-worker state divergence

## Trigger

Use this runbook for `AdapterRelayGap`, `AdapterStateDivergence`, replay
`truncated` or `rehydrate` events, unexplained replica disagreement, or a client
whose reconnect state differs from a fresh load.

## Owner

The realtime owner classifies coverage and rehydration. The runtime operator
owns worker replacement. The incident commander approves automatic or manual
restart when evidence is incomplete.

## Loss semantics

A relay gap proves that a worker missed at least the reported ordinal range; it
does not prove that this is the only hole. A divergence diagnostic reports
bounded per-worker sequence maxima under pseudonymous stream ids and may be
partial or truncated. A `tail-sequence-gap` is a lower bound, not proof of the
root cause. Replay covers only the retained generation/window; `truncated` or
epoch mismatch requires full rehydration.

## Abort criteria

- Do not expose raw topics or payloads to logs while correlating a pseudonymous
  diagnostic id.
- Do not restart the reported worker until the diagnostic record and preceding
  relay/restart evidence are captured; retained diagnostics are bounded.
- Do not use a sequence lower bound as an exact lost-event count or claim
  recovery from matching aggregate hashes alone.
- Abort incremental replay on truncation, epoch mismatch, incomplete coverage
  or any sequence that moves backward; use full authoritative rehydration.

## Decision tree

1. Resolve the opaque diagnostic id through the authenticated admin route and
   preserve its completeness/truncation flags and per-worker sequence summary.
2. If a relay gap names a worker or the diagnostic identifies a minority, keep
   that worker out of new traffic and capture evidence before replacement.
3. If the client's epoch/window and durable replay store prove full coverage,
   replay from the last covered sequence.
4. If coverage is partial, truncated, reset or unknown, discard the cursor and
   perform a full authoritative load; do not combine an uncertain replay with
   live cutover.
5. If divergence returns after rehydrate/replacement, stop the restart loop and
   escalate as a deterministic state/relay defect.

## Procedure

1. Record UTC interval, worker/instance ids, diagnostic id, completeness,
   evidence truncation, sequence lower bounds, replay epoch and client cursor.
2. Stop routing new connections to a known-minority worker. Keep other healthy
   replicas serving only if application policy accepts the uncertainty.
3. Query the authenticated diagnostic endpoint before the eight-record bound
   evicts the record. Treat its HMAC stream ids as sensitive pseudonyms; they
   correlate entries inside the evidence but do not reveal raw topics.
4. Select replay/delta only where its retained range and epoch prove coverage.
   Otherwise trigger a full loader/authoritative-state rehydrate.
5. Replace the affected worker once evidence is captured. Observe the new
   worker through ready, state fold, a live publish and a reconnect cutover.
6. Compare independently loaded state across at least two workers/instances.

## Recovery verification

- Aggregate state remains converged across at least two fold intervals and no
  new relay-gap diagnostic appears.
- A client with a valid covered cursor catches up exactly once; a deliberately
  stale/reset cursor takes the full-rehydrate path.
- A fresh authoritative load matches the reconnected client's state after one
  new live event.
- Replacement workers reach readiness before retained records are replayed,
  and operators can retrieve those records only through the authenticated
  admin surface.
- The incident record labels all counts as exact, lower-bound or unknown.

## Escalation and handoff

Include opaque diagnostic ids, completeness/truncation flags, worker sequence
summaries, replay epoch/window evidence, which clients/streams were fully
rehydrated, whether a worker was replaced, and any loss interval still unknown.
Never include raw topics, payloads or credentials.
