# Reference queries

Generated from the adapter's signal manifest by `scripts/generate-observability.js`.
Do not edit by hand - a test regenerates this file and fails if it differs, so a new
metric cannot ship without an entry here.

These assume you scrape [`platform.metricsSnapshot()`](../../README.md#cluster-wide-metrics),
which returns ONE already-merged document for the whole cluster. Do not add another layer
of `sum()` over these: the cross-worker aggregation has already been applied, by the law
each metric declares. If you scrape `platform.metrics.serialize()` instead you are reading
one randomly chosen worker and none of these queries mean what they say.

| Metric | Type | Unit | Query | Cross-worker law |
| --- | --- | --- | --- | --- |
| `upgrade_admitted_total` | counter | count | `rate(upgrade_admitted_total[5m])` | Per-worker quantity; the snapshot has already summed it across workers. |
| `upgrade_rejected_total` | counter | count | `sum by (reason) (rate(upgrade_rejected_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. |
| `upgrade_rate_map_evicted_total` | counter | count | `sum by (door) (rate(upgrade_rate_map_evicted_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. |
| `upgrade_inflight` | gauge | count | `upgrade_inflight` | Per-worker quantity; the snapshot has already summed it across workers. |
| `waiting_room_queue_depth` | gauge | count | `waiting_room_queue_depth` | Per-worker quantity; the snapshot has already summed it across workers. |
| `protection_posture_transitions_total` | counter | count | `sum by (from, to) (rate(protection_posture_transitions_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. |
| `protection_posture_state` | gauge | enumerated state (see the description) | `protection_posture_state` | The snapshot reports the worst worker. |
| `ws_connections` | gauge | count | `ws_connections` | Per-worker quantity; the snapshot has already summed it across workers. |
| `ws_subscriptions` | gauge | count | `ws_subscriptions` | Per-worker quantity; the snapshot has already summed it across workers. |
| `ws_publishes_total` | counter | count | `rate(ws_publishes_total[5m])` | Per-worker quantity; the snapshot has already summed it across workers. |
| `ws_backpressure_max_bytes` | gauge | bytes | `ws_backpressure_max_bytes` | The snapshot reports the worst worker. |
| `ws_backpressure_connections` | gauge | count | `ws_backpressure_connections` | Per-worker quantity; the snapshot has already summed it across workers. |
| `pressure_saturation` | gauge | ratio | `pressure_saturation` | The snapshot reports the worst worker. |
| `pressure_reason` | gauge | enumerated state (see the description) | `pressure_reason` | The snapshot reports the worst worker. |
| `pressure_sample_timestamp_seconds` | gauge | seconds | `pressure_sample_timestamp_seconds` | The snapshot reports the stalest worker, so this is the freshness of the whole cluster. |
| `resident_memory_bytes` | gauge | bytes | `resident_memory_bytes` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. |
| `heap_used_ratio` | gauge | ratio | `heap_used_ratio` | The snapshot reports the worst worker. |
| `psi_cpu_some_avg10` | gauge | percent | `psi_cpu_some_avg10` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `psi_memory_full_avg10` | gauge | percent | `psi_memory_full_avg10` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `psi_io_full_avg10` | gauge | percent | `psi_io_full_avg10` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `cpu_throttled_ratio` | gauge | ratio | `cpu_throttled_ratio` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `open_fds` | gauge | count | `open_fds` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `fd_soft_limit` | gauge | count | `fd_soft_limit` | Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it. (not always registered) |
| `state_divergence_total` | counter | count | `sum by (role) (rate(state_divergence_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. |
| `relay_gap_frames_total` | counter | count | `rate(relay_gap_frames_total[5m])` | Per-worker quantity; the snapshot has already summed it across workers. |
| `framework_assertion_violations_total` | counter | count | `sum by (category, severity) (rate(framework_assertion_violations_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. |
| `framework_resource_growth_suspected_total` | counter | count | `sum by (resource) (rate(framework_resource_growth_suspected_total[5m]))` | Per-worker quantity; the snapshot has already summed it across workers. (not always registered) |
| `metrics_snapshot_workers_expected` | gauge | count | `metrics_snapshot_workers_expected` | Written by the merge itself; no worker registers it. |
| `metrics_snapshot_workers_reporting` | gauge | count | `metrics_snapshot_workers_reporting` | Written by the merge itself; no worker registers it. |
| `metrics_snapshot_degraded` | gauge | count | `metrics_snapshot_degraded` | Written by the merge itself; no worker registers it. |

## Derived quantities

These combine two metrics and are the ones most often written wrongly by hand.

```promql
# Subscriber ratio. Exported as numerator and denominator on purpose: averaging
# per-worker ratios is NOT the cluster ratio.
ws_subscriptions / clamp_min(ws_connections, 1)

# Descriptor headroom. Both sides are whole-process maxima, so this is already
# the process-wide truth - summing either side would multiply it by the worker count.
open_fds / clamp_min(fd_soft_limit, 1)

# Share of upgrade attempts refused. Attempts the adapter never saw (a client that
# disconnects mid-handshake) are in neither term, so this can read below a load
# balancer's own refusal rate.
sum(rate(upgrade_rejected_total[5m]))
  / clamp_min(sum(rate(upgrade_admitted_total[5m])) + sum(rate(upgrade_rejected_total[5m])), 1)

# Age of the pressure sample every gauge above was written from. The sampling timer
# is unref'd; if it stops, those gauges keep serving their last value while the
# target still reports up. This is the only thing that tells you.
time() - pressure_sample_timestamp_seconds
```

