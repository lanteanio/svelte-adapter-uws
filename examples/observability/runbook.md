# Runbook

One section per alert in [`rules.yml`](./rules.yml). A test in this repository
fails if an alert points at a section that does not exist here, and if a metric
ships with neither an alert nor an entry in [the no-alert list](#metrics-with-no-alert-by-design).

Queries are in [`queries.md`](./queries.md), generated from the adapter's signal
manifest.

Import [`dashboard.v1.json`](./dashboard.v1.json) into Grafana for the compact
versioned dashboard. Its datasource, job, instance and runbook URL are variables;
replace the example runbook URL after import. The evaluated acceptance cases live
in [`rule-tests.v1.yml`](./rule-tests.v1.yml).

## Deployment contract

The no-data rules must distinguish adapter targets from every other Prometheus
target. Add this constant target label to the scrape config that exposes the
merged snapshot:

```yaml
scrape_configs:
  - job_name: websocket
    static_configs:
      - targets: ['app-1:3000', 'app-2:3000']
        labels:
          adapter: svelte-adapter-uws
```

Alert links use Prometheus's rule-template external-label map instead of a local
relative path. Configure the absolute URL where your deployed copy of this
runbook lives:

```yaml
global:
  external_labels:
    adapter_runbook_url: https://ops.example.com/runbooks/svelte-adapter-uws
```

Every rule preserves all scrape/external labels. Two targets may share a job
name and still evaluate independently by instance, cluster, region or any other
labels your scrape config attaches. Do not put a global `sum()` around the pack.
The only aggregation in the reject ratio removes its internal `reason` label
with `sum without (reason)`, which deliberately retains every target label.

This repository's pack covers adapter-owned metrics only. Metrics shipped by
sibling extension repositories, including clustered backends, need their own
rules, dashboard panels and acceptance fixtures in those repositories; they are
not silently folded into this adapter artifact.

Two things worth knowing before any of the below:

- **Read the pipeline alerts first.** If `AdapterMetricsSnapshotDegraded` is
  firing, every other number here is one worker's view of an N-worker cluster.
- **Do not add a global `sum()` to these queries.** You are scraping an
  already-merged document per target. A global sum combines deployments and
  can also multiply whole-process readings by the worker count.

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

If the `metrics_snapshot_degraded` series itself disappears while the marked
target's `up` series remains `1`, `AdapterMetricsAbsent` fires for that target;
silence is not interpreted as a healthy zero.

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

This comparison is evaluated independently for each live marked target. A down
target is owned by the ordinary Prometheus target-down alert, not duplicated by
this rule.

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

**Means:** the marked target is up but at least one pipeline witness is gone:
the pressure sample timestamp, degraded flag, expected worker count or reporting
worker count. In particular, a missing `metrics_snapshot_degraded` is not
treated as `0`.

**Check:** that `websocket.metrics` is still configured in the build, and that
the scrape route still reaches `platform.metricsSnapshot()` rather than a second,
empty registry imported separately from app code. Importing the metrics module
again from app code creates a fresh instance that nothing writes to.

**Do:** confirm the route returns a body rather than the `503` the documented
example emits when no registry is configured.

The rule starts from each `up{adapter="svelte-adapter-uws"} == 1` series and uses
per-target `unless` joins. It therefore retains job, instance and every other
target label instead of collapsing several deployments into one alert.

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

**Check:** `ws_backpressure_max_bytes` for sampled headroom against your
configured `maxBackpressure`, then `rate(ws_dropped_frames_total[5m])` and
`rate(ws_dropped_bytes_total[5m])` for exact loss. The bounded socket walk can
miss a short-lived queue or a connection beyond its cap; the native drop-event
counters cannot.

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
The denominator is the actual admitted-plus-rejected rate with no clamp to one,
so a target handling 0.1 attempts per second still reports the correct share.
Targets with admissions and no rejection series are represented by an explicit
zero numerator.

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

**Check:** copy the opaque `diagnosticId` from the primary's divergence log and
resolve `GET <adminPath>/diagnostics/<diagnosticId>` through the authenticated
svelte-realtime admin plane. The response contains a bounded per-worker sequence
summary keyed by process-lifetime HMAC stream ids, never raw topic names. A
`tail-sequence-gap` gives a proven lower bound; incomplete or truncated evidence
is marked explicitly and must not be assumed to be frame loss.

**Do:** use the sequence evidence to identify the affected application stream
through your own authorized topic inventory. `RESTART_ON_STATE_DIVERGENCE=1`
makes the primary restart the minority automatically so it re-converges; it is
off by default because incomplete evidence still requires operator judgement.

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

## AdapterRelaySpillQuarantine

**Means:** a worker stopped draining cross-worker relay traffic before its
finite pending-byte or pending-age ceiling. The primary discarded that peer's
producer spill, quarantined it once, and asked the normal supervisor to replace
it rather than letting the primary queue grow without bound.

**Check:** the bounded `reason` label (`bytes` or `age`),
`relay_spill_dropped_bytes_total`, and `relay_spill_pending_age_seconds`. Then
inspect the primary log for the target worker and configured
`CLUSTER_RELAY_MAX_PENDING_KB` / `CLUSTER_RELAY_MAX_PENDING_MS` ceilings. These
metrics deliberately contain no topic or client identity.

**Do:** confirm the worker was replaced and recovered. Treat repeated events as
a worker stall or sustained capacity problem; correlate with process health,
CPU, memory, and event-loop pressure before changing a ceiling. A quarantined
worker can have missed state, so do not suppress the replacement.

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

## Acceptance drill

Run the official Prometheus evaluator after changing the pack:

```sh
promtool test rules examples/observability/rule-tests.v1.yml
```

CI runs this exact command from a digest-pinned official Prometheus image. The
test file imports `rules.yml`, so mutations change the expressions Prometheus
actually parses and evaluates. It covers low-volume rejection ratios,
two targets with different outcomes, incomplete and degraded snapshots, a
missing degraded flag, a stalled sampler, and a down target that must not receive
a duplicate no-data alert. It also feeds triggering same-named metrics from an
unrelated target and requires every adapter alert to remain silent. The Vitest
contract uses the official Prometheus grammar to validate every selector and
also parses the dashboard as JSON to validate its version, datasource
variables, selectors and target-bearing legends.

For a staging drill, scrape two marked targets with distinct instances, then:

1. Confirm both appear separately in the dashboard and recording rules.
2. Withhold the adapter metrics route from one target while leaving its ordinary
   health endpoint up. Only that instance should raise `AdapterMetricsAbsent`.
3. Stop the target. The adapter absence alert should clear; the platform's
   target-down alert now owns the incident.
4. Restore it and generate a small, known admitted/rejected attempt rate. Confirm
   the recorded ratio equals rejected divided by admitted plus rejected even when
   the total rate is below one attempt per second.

The repository's normal JavaScript tests do not download a platform binary.
The dedicated Linux CI lane supplies the pinned official evaluator.

---

## Metrics with no alert, by design

These are charted, not alerted. Each is either a raw input to an alert above, or
a quantity whose meaning is entirely workload-specific and would produce a
threshold nobody could justify.

- `http_requests_total` - workload-specific traffic and status mix.
- `http_request_duration_seconds` - chart its p95 by method/outcome; the
  acceptable latency threshold belongs to the application SLO.
- `upgrade_admitted_total` - the denominator of the reject ratio; alerting on
  traffic volume is a capacity-planning question, not an incident.
- `upgrade_duration_seconds` - handshake latency is charted; authentication
  backends and deployment SLOs determine the actionable threshold.
- `upgrade_inflight` - transient by nature; a sustained value shows up as
  saturation or a waiting-room backlog first.
- `upgrade_deferred_depth` - the pacing queue's instantaneous depth is bounded
  by the configured `maxDeferred` and drains within ticks; sustained pressure
  is visible as queue age and as `deferred_overflow` rejections instead.
- `upgrade_deferred_oldest_age_seconds` - how long a deferred upgrade may
  acceptably wait depends on the deployment's `perTickBudget` and client
  timeout envelope; chart it beside the reject ratio.
- `upgrade_deferred_rejected_total` - the exact shed count behind the pacing
  queue. The same decisions increment
  `upgrade_rejected_total{reason="deferred_overflow"}`, which already feeds
  the reject-ratio alert; a second alert would page twice for one incident.
- `ws_connection_headroom` - exact remaining `maxConnections` permits.
  Exhaustion already appears in the bounded connection-capacity rejection
  series and reject-ratio alert; a warning threshold above zero depends on the
  deployment's reconnect and autoscaling envelope.
- `protection_posture_transitions_total` - the incident timeline. The posture
  state itself is what is alerted.
- `ws_connections` - workload-specific. Chart it; alert on the constraints
  (descriptors, saturation, backpressure) instead.
- `ws_connection_duration_seconds` - connection lifetime is workload-specific.
- `ws_messages_total` - message throughput/error mix is charted; applications
  decide which handler error rate pages.
- `ws_message_admission_rejected_total` - exact established-message shed rate,
  split by bounded reason and scope. Chart it beside handler latency and set an
  application SLO; an actionable threshold depends on whether the lane is
  idempotent, lossy, or request/response.
- `ws_message_duration_seconds` - chart handler p95 by kind/outcome; the
  application owns its latency SLO.
- `ws_subscriptions` - as above; the derived subscriber ratio is the useful form.
- `ws_publishes_total` - throughput, not health.
- `ws_publish_outcomes_total` - delivery/no-subscriber outcome mix is
  application-specific; a no-subscriber publish can be intentional.
- `ws_backpressure_max_bytes` - the sampled headroom detail behind
  `AdapterBackpressureSustained`; compare against your configured ceiling.
- `ws_dropped_frames_total` - exact native frame-loss counter. Chart its rate
  beside sampled headroom; workload policy decides when volatile-message loss
  should page.
- `ws_dropped_bytes_total` - exact native byte-loss counter. Chart its rate
  beside sampled headroom; workload policy decides when volatile-message loss
  should page.
- `relay_spill_dropped_bytes_total` - impact detail for
  `AdapterRelaySpillQuarantine`; the quarantine event owns paging, while the
  byte count explains its size.
- `relay_spill_pending_age_seconds` - diagnostic context captured at relay
  quarantine. The event owns paging; a universal age threshold would merely
  restate the deployment's configured finite ceiling.
- `pressure_reason` - a categorical explanation of saturation, read while
  triaging rather than alerted on.
- `pressure_reason_transitions_total` - the incident timeline behind that
  categorical explanation. The saturation and posture gauges own paging.
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
