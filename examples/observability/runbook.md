# Runbook

One section per alert in [`rules.yml`](./rules.yml). A test in this repository
fails if an alert points at a section that does not exist here, and if a metric
ships with neither an alert nor an entry in [the no-alert list](#metrics-with-no-alert-by-design).

Queries are in [`queries.md`](./queries.md), generated from the adapter's signal
manifest.

Two things worth knowing before any of the below:

- **Read the pipeline alerts first.** If `AdapterMetricsSnapshotDegraded` is
  firing, every other number here is one worker's view of an N-worker cluster.
- **Do not add `sum()` to these queries.** You are scraping an already-merged
  document. Summing again multiplies whole-process readings by the worker count.

---

## AdapterMetricsSnapshotDegraded

**Means:** the cluster collection did not complete, so the document you are
looking at is a single worker. The expected/reporting pair cannot express this
case on its own - a worker that never heard back from the primary does not know
how many siblings it has - which is why this flag exists separately.

**Check:** whether the primary thread is healthy. This is the same thread that
relays every cross-worker publish, so if it is stalled you will usually also see
publish latency rise and workers being restarted by the watchdog.

**Do:** treat every other metric as untrustworthy until this clears. If it
persists, the primary is wedged or overloaded and the process needs a restart.

**Do not** raise `timeoutMs` to make it stop firing. The deadline is not the
problem; a primary that cannot answer within seconds is.

---

## AdapterMetricsSnapshotIncomplete

**Means:** at least one worker did not report before the deadline. Every summed
series - connections, subscriptions, admissions, publishes - is understated by
whatever that worker was carrying.

**Check:** whether a worker is restarting (the restart supervisor logs it), or
blocked long enough to miss the deadline. A worker doing a long synchronous
render or a large GC pause can miss it while being otherwise healthy.

**Do:** if it correlates with restarts, treat the restarts as the incident. If a
worker is persistently missing while alive, it is blocking its event loop.

**Do not** read the dip in summed series as a traffic drop. Counters are not
affected the same way: an exited worker's totals are carried forward, so
counters stay monotonic even while gauges dip.

---

## AdapterPressureSamplerStalled

**Means:** the 1 Hz pressure sampler has not completed a fold recently. Every
gauge it writes - saturation, posture, connections, subscriptions, backpressure,
memory - is frozen at its last value while the scrape target still reports up.

This is the failure that has no other symptom. Without this alert a wedged
sampler looks exactly like a perfectly steady server.

**Check:** whether the worker's event loop is blocked. The sampler rides an
`unref`'d interval, so it is starved by anything monopolising the loop.

**Do:** find what is blocking the loop. A stalled sampler is a symptom, not the
fault.

---

## AdapterMetricsAbsent

**Means:** the target is up but the adapter's own series are gone.

**Check:** that `websocket.metrics` is still configured in the build, and that
the scrape route still reaches `platform.metricsSnapshot()` rather than a second,
empty registry imported separately from app code. Importing the metrics module
again from app code creates a fresh instance that nothing writes to.

**Do:** confirm the route returns a body rather than the `503` the documented
example emits when no registry is configured.

---

## AdapterDescriptorHeadroomLow

**Means:** open descriptors are approaching the soft limit. New sockets fail with
`EMFILE` at the limit, and a socket server hits it as a hard connection ceiling.

**Check:** `open_fds` against `fd_soft_limit`. Both are whole-process values -
worker threads share one descriptor table - so the snapshot reports the maximum
and it is already the process-wide truth.

**Do:** raise the soft limit (`LimitNOFILE` under systemd, `ulimit -n`
otherwise). The adapter warns at boot when the limit is below 8192.

**Do not** sum either side across workers. That is the single most common way to
turn this into a false page.

---

## AdapterProtectionSiege

**Means:** the protection posture has engaged. At `elevated` the waiting room
widens its retry jitter; at `siege` new upgrades are refused at static-serve cost
and the admission check always reports busy.

**Check:** `upgrade_rejected_total` by `reason` for what is driving it, and
`pressure_reason` for what the sampler thinks the constraint is. The posture
transitions counter gives the incident timeline.

**Do:** if the load is legitimate, add capacity. If it is not, the per-IP picture
lives in the extensions bucket counters, not here - no client identity ever
reaches an adapter label.

---

## AdapterSaturationHigh

**Means:** the worst worker is near the configured pressure thresholds. This is a
worst-of scalar, so one hot worker raises it even if the rest are idle.

**Check:** `pressure_reason` for which threshold is closest, then the underlying
series for that reason.

**Do:** treat it as a leading indicator for the posture engaging.

---

## AdapterHeapPressure

**Means:** a worker isolate's V8 heap is nearly full. Heap is per-isolate, so
unlike resident memory this is one worker, and the snapshot reports the worst.

**Check:** whether it climbs monotonically (a leak) or tracks load (sizing).

**Do:** for a climb with no plateau, the optional resource-growth auditor exists
to catch exactly that; see `AdapterResourceGrowth`.

---

## AdapterCpuThrottled

**Means:** the cgroup CPU quota is suspending the process for a meaningful share
of each window. Latency will be poor in a way no application-level metric
explains.

**Check:** the container's CPU limit against actual usage.

**Do:** raise the quota or reduce per-request work. Nothing inside the adapter
can recover time the kernel took away.

---

## AdapterBackpressureSustained

**Means:** connections are holding an outbound queue - clients are not draining
as fast as you publish.

**Check:** `ws_backpressure_max_bytes` for the worst single connection against
your configured `maxBackpressure`.

**Do:** slow the publisher, coalesce, or shed. Sustained backpressure ends in uWS
dropping messages.

---

## AdapterUpgradeRejectRatioHigh

**Means:** a large share of upgrade attempts are refused.

**Check:** break `upgrade_rejected_total` down by `reason` before doing anything.
The reasons have completely different responses: `over_capacity` and `siege` are
capacity, `ip_rate_limit` is abuse or a misbehaving client, `bad_origin` is
usually a misconfiguration, `auth_rejected` is your own hook.

**Do not** treat this ratio as a client-side error rate. Attempts the adapter
never saw are in neither term, so it can read below what a load balancer counts.

---

## AdapterRateMapChurn

**Means:** rate-limit entries are being evicted at the map cap, which means
rotating client identities are filling a limiter faster than the periodic sweep
reclaims it.

**Check:** the `door` label - `upgrade` or `auth` - for which limiter.

**Do:** sustained churn on either door usually means distributed abuse with
rotating addresses. Eviction is per-eviction and sample-local; it is not a
promise that churn can never reach a ban.

---

## AdapterWaitingRoomBacklog

**Means:** clients have been sitting in the waiting room for a sustained period,
so admission is not draining them.

**Check:** the posture and the admission ceiling. The room is a symptom of the
gate being closed, not a fault of its own.

**Do:** address the capacity constraint. The queue depth is sampled, and reads
`0` when the room is off.

---

## AdapterStateDivergence

**Means:** two workers folded different state hashes for the same epoch. Clients
connected to different workers are seeing different data.

**Check:** the primary's divergence log line, which names the epoch, the majority
hash and the minority thread ids. No topic strings cross that boundary - the hash
is structure-only - so the log is the diagnostic, not the metric.

**Do:** the minority worker is the one that is wrong. `RESTART_ON_STATE_DIVERGENCE=1`
makes the primary restart it automatically so it re-converges; it is off by
default because restarting on a false positive is worse than the divergence.

---

## AdapterRelayGap

**Means:** a worker was sent relayed frames it never received. Unlike a hash
divergence there is nothing to vote on: the worker that reports the gap is the
worker that lost the data.

**Check:** the log line, which names the topic, the origin worker and the missing
ordinal range. It counts frames, not incidents, and is a lower bound - losses
inside an already-reported window fold into that report.

**Do:** the affected worker is missing state its siblings have. A restart re-syncs
it; the same `RESTART_ON_STATE_DIVERGENCE` gate covers this case.

---

## AdapterFatalAssertion

**Means:** a framework invariant failed. At the `fatal` tier the worker
terminates; at `soft` it is recoverable but indicates a state the framework did
not expect.

**Check:** the `category` label, which names the invariant. Categories are
source-declared and never user input, so the cardinality is bounded. The
queryable `platform.assertions` map mirrors the same counts.

**Do:** a fatal assertion is a bug report. Capture the category and the
surrounding logs before the worker is replaced.

---

## AdapterResourceGrowth

**Means:** the optional resource-growth auditor saw a resource climb over a long
window without plateauing.

**Check:** the `resource` label for which one, then correlate with
`heap_used_ratio` and `resident_memory_bytes`.

**Do:** this is a leak signal, not a threshold breach. It fires on the shape of
the curve, so act on the trend rather than waiting for an absolute limit.

---

## Metrics with no alert, by design

These are charted, not alerted. Each is either a raw input to an alert above, or
a quantity whose meaning is entirely workload-specific and would produce a
threshold nobody could justify.

- `upgrade_admitted_total` - the denominator of the reject ratio; alerting on
  traffic volume is a capacity-planning question, not an incident.
- `upgrade_inflight` - transient by nature; a sustained value shows up as
  saturation or a waiting-room backlog first.
- `protection_posture_transitions_total` - the incident timeline. The posture
  state itself is what is alerted.
- `ws_connections` - workload-specific. Chart it; alert on the constraints
  (descriptors, saturation, backpressure) instead.
- `ws_subscriptions` - as above; the derived subscriber ratio is the useful form.
- `ws_publishes_total` - throughput, not health.
- `ws_backpressure_max_bytes` - the diagnostic detail behind
  `AdapterBackpressureSustained`; compare against your configured ceiling.
- `pressure_reason` - a categorical explanation of saturation, read while
  triaging rather than alerted on.
- `pressure_sample_timestamp_seconds` - alerted through its AGE, not its value.
- `resident_memory_bytes` - process-wide; container memory limits are the right
  place to alert on this, and your platform already does.
- `psi_cpu_some_avg10` - host-level kernel pressure. Useful context while
  triaging, but it describes the machine rather than this process, and belongs
  on a node-level alert owned by whoever owns the host.
- `psi_memory_full_avg10` - as above; node-level.
- `psi_io_full_avg10` - as above; node-level.
- `fd_soft_limit` - a constant; the headroom ratio is what matters.
- `metrics_snapshot_workers_expected`, `metrics_snapshot_workers_reporting` -
  alerted as the comparison between them.
