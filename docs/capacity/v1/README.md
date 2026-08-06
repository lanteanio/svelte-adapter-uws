# Capacity kit v1

Capacity-kit version: **1**. This is the launch gate for production deployments
that combine `svelte-adapter-uws`, `svelte-realtime`, and
`svelte-adapter-uws-extensions`. It turns an expected peak, a real traffic mix,
a pinned topology, latency/error objectives, the first saturated resource, and
post-overload recovery into one reviewable artifact.

The repository benchmarks answer narrow implementation questions. They do not
claim production capacity. A launch candidate has capacity evidence only when
the workload owner has customized this kit, run it against the candidate
deployment, retained the result, and obtained a passing independent review.

## Launch gate

Do not launch or raise an autoscaling maximum until a result conforming to
[`result.schema.json`](./result.schema.json) exists for the exact release and
topology. The result must have `pass: true`; all six gates must pass:

Results kept from before latency became `scheduled-arrival`-anchored no longer
conform, and that is deliberate: their percentiles excluded the wait for a
launch slot, so they are not comparable with the numbers these gates now read.
Re-run rather than reinterpret them - an artifact without `latencyAnchor` is
evidence about a different measurement.

1. expected-peak p95 latency;
2. expected-peak p99 latency;
3. expected-peak error rate;
4. an overload-phase first-saturated-resource witness;
5. one complete recovery window inside the declared recovery objective, which
   carried at least `recoveryMinAttemptRatio` of that window's offered
   arrivals (reported as `minAttempts` beside the window that certified); and
6. generator integrity: no injector drops, drain timeout, sample errors, or
   missing/slow telemetry intervals or excessive p99 scheduling lag.

A failed or incomplete run is evidence, not approval. Keep it for comparison,
fix the bottleneck or the test environment, and run a new immutable artifact.
Never edit a result into a pass.

The result retains the complete `autoscaling` envelope and exposes the earliest
threshold crossing as `firstSaturatedResource`; reviewers need both to decide
whether the observed knee belongs to an instance, a shared backend, or scaling
that reacted too late.

## Required worksheet

Write a deployment-owned `.mjs` profile. Every field below is mandatory because
omitting any one changes what a capacity number means.

| Decision | Profile field | What to record before the run |
| --- | --- | --- |
| Expected peak | `expectedPeak` | Arrival rate, simultaneously live connections, and established-message rate from a named forecast window. Do not substitute average traffic. |
| Traffic mix | `scenarios` | Weighted HTTP, upgrade, established-message, publish/fan-out, replay, upload, and application work actually present at peak. A scenario weight is relative, not a percentage. |
| User SLO | `slo` | Peak p95/p99 and error ceiling plus recovery p95/error/window/deadline, and `recoveryMinAttemptRatio` - the share of the recovery phase's offered arrivals a window must actually have carried before it may certify recovery (default `0.5`; a sparse window is a symptom, not evidence). Count timeouts and rejected application work as errors. |
| Release | `release` | Application revision, immutable image digest, clean/dirty patch identity, and the exact adapter/realtime/extensions versions or revisions. |
| Environment | `environment` | Load-generator location and host class, OS image, fixed power profile, and the complete network path to the target. |
| Topology | `topology` | Regions, instances, workers, CPU/RAM limit per instance, load balancer, Redis/Postgres shape, and autoscaling min/max/signal/target/cooldown. |
| Load phases | `phases` | Warm-up, exact expected peak, deliberate overload above peak, then recovery. Use long enough windows to cover connection lifetime, cache warm-up, autoscaling cooldown, and backend tail latency. |
| Saturation | `saturation` | Ordered resource thresholds read from target-side telemetry. The first crossing during overload is the reported bottleneck. Include CPU/quota, event-loop delay, RSS/limit, send backpressure, Redis/Postgres latency/pools, and downstream limits that can bind. |
| Injector safety | `generator` | Max in-flight work, operation/sample timeout, sample interval, drain timeout, and acceptable scheduler-lag p99 for the load-generator host. |

Record a dirty tree as a content-addressed patch identity, not merely `dirty`.
Use an image digest such as `sha256:...`, never a mutable tag. Synthetic users,
credentials, and payloads belong in the deployment secret store and must not be
returned by `sample()` or embedded in the result.

## Profile contract

The profile's default export is an object, or an async function returning one.
This abbreviated skeleton shows the contract; replace every sample value and
workload with deployment evidence:

```js
export default {
  schemaVersion: 1,
  name: 'eu-chat-2026-q3-launch',
  target: 'https://capacity.example.invalid',
  expectedPeak: {
    arrivalsPerSecond: 2_000,
    liveConnections: 80_000,
    messagesPerSecond: 12_000
  },
  release: {
    appRevision: 'git:0123456789abcdef',
    imageDigest: `sha256:${'0'.repeat(64)}`,
    worktree: 'clean',
    packages: {
      'svelte-adapter-uws': process.env.CAPACITY_ADAPTER_REVISION,
      'svelte-realtime': process.env.CAPACITY_REALTIME_REVISION,
      'svelte-adapter-uws-extensions': process.env.CAPACITY_EXTENSIONS_REVISION
    }
  },
  environment: {
    location: 'eu-west load-generator subnet',
    hostClass: 'dedicated 16 vCPU / 32 GiB',
    osImage: 'immutable image digest',
    powerProfile: 'fixed performance',
    networkPath: 'generator -> production LB -> candidate pool'
  },
  topology: {
    regions: ['eu-west'],
    instancesPerRegion: 4,
    workersPerInstance: 4,
    cpuPerInstance: 4,
    memoryMiBPerInstance: 4096,
    loadBalancer: 'production class; idle timeout and balancing policy pinned',
    dataStores: ['Redis 7 cluster: 3 primaries + replicas', 'Postgres 17: pool 80'],
    autoscaling: {
      minInstances: 4,
      maxInstances: 12,
      signal: 'CPU and active connections',
      target: 0.65,
      cooldownSeconds: 180
    }
  },
  phases: [
    { name: 'warmup', durationMs: 300_000, arrivalRate: 1_000 },
    { name: 'expected_peak', durationMs: 900_000, arrivalRate: 2_000 },
    { name: 'overload', durationMs: 600_000, arrivalRate: 3_000 },
    { name: 'recovery', durationMs: 600_000, arrivalRate: 1_000 }
  ],
  scenarios: [
    {
      name: 'http-read',
      weight: 30,
      description: 'authenticated SSR/API read with production payload shape',
      async run({ target, signal }) {
        const response = await fetch(`${target}/your-read-route`, { signal });
        return { ok: response.ok, status: response.status, bytesIn: Number(response.headers.get('content-length')) || null };
      }
    },
    {
      name: 'established-realtime-message',
      weight: 70,
      description: 'deployment helper sends one message over a pre-opened synthetic-user socket and awaits its application acknowledgement',
      async run(context) {
        return syntheticFleet.messageRoundTrip(context);
      }
    }
  ],
  slo: {
    p95MsMax: 150,
    p99MsMax: 400,
    errorRateMax: 0.001,
    recoveryP95MsMax: 150,
    recoveryErrorRateMax: 0.001,
    recoveryWindowMs: 120_000,
    recoveryWithinMs: 300_000,
    recoveryMinAttemptRatio: 0.5
  },
  generator: {
    maxInFlight: 50_000,
    operationTimeoutMs: 10_000,
    sampleIntervalMs: 1_000,
    drainTimeoutMs: 60_000,
    maxSchedulerLagMs: 20
  },
  saturation: [
    { resource: 'event loop', metric: 'runtime.eventLoopP99Ms', operator: 'gte', threshold: 50, unit: 'ms' },
    { resource: 'Redis', metric: 'redis.commandP99Ms', operator: 'gte', threshold: 25, unit: 'ms' },
    { resource: 'memory limit', metric: 'runtime.rssRatio', operator: 'gte', threshold: 0.9, unit: 'ratio' }
  ],
  async sample({ signal }) {
    const response = await fetch(process.env.CAPACITY_TELEMETRY_URL, {
      headers: { authorization: `Bearer ${process.env.CAPACITY_TELEMETRY_TOKEN}` },
      signal
    });
    if (!response.ok) throw new Error(`telemetry HTTP ${response.status}`);
    return response.json();
  }
};
```

`syntheticFleet` above represents deployment-owned setup that opens the declared
connection population before the measured peak and keeps it alive through
overload and recovery. Replacing established-message traffic with a fresh
connection per message measures a different system and must be named as such.
Similarly, a publish scenario must wait for the expected subscriber
acknowledgements; measuring only the publisher's enqueue time is not fan-out
capacity.

Each `run()` returns `undefined` for success or an object with `ok`, `status`,
`errorCode`, `bytesIn`, and `bytesOut`. It receives `target`, `phase`,
`arrivalIndex`, and an `AbortSignal`. Return `ok: false` for an application
error even when transport status is 200. Do not catch and discard timeouts.

`sample()` returns JSON-safe target-side metrics. Dot-separated `metric` names
in `saturation` address nested values. Threshold order is the tie-breaker when
several resources cross in the same sample. Launch saturation is always taken
from the overload phase; a warm-up or recovery crossing cannot satisfy that
gate.

## Open-arrival semantics

The runner schedules each arrival from the phase start time and target rate. It
does not wait for a prior operation to complete. Slow service therefore creates
concurrency instead of silently lowering offered load, which is the coordinated
omission failure of a closed-loop benchmark.

`scheduled` is intended load; `started` is what the injector actually began;
`completed` counts only the attempts that finished inside the phase, so work
draining into the next phase is never credited as this phase's throughput.
`injectorDropped` means the injector's own in-flight ceiling hid offered load,
and it fails generator integrity outright.

Two things to know before reading those numbers, because the artifact cannot
tell you either one:

- **`completed` and `completionRate` are the only completion-attributed
  fields.** `succeeded`,
  `failed`, `errorRate`, the per-scenario counts and every latency family are
  attributed to the phase that STARTED the attempt, and they cover all of
  `started`. So `succeeded + failed === started`, not `completed`, and a
  healthy phase whose work outlives it can legitimately read
  `started: 8, completed: 0, succeeded: 8`. That is not a broken generator.
- **A gap between `completionRate` and `achievedStartRate` is the primary
  saturation signal of an open model, but it is never exactly zero.** Arrivals
  launched within one service time of the phase boundary cannot finish inside
  it, so the gap has a floor of roughly `serviceTime / phaseDuration` **of the
  offered rate** even on a perfectly healthy target: 0.025% for a 150 ms p95
  over a ten-minute phase, and about 31% for an 80 ms phase serving 25 ms
  requests. Read the gap against that floor, which is why phases must be long
  relative to service time. A gap far above it is saturation.

Latency is anchored to the SCHEDULED arrival, not to the moment the injector
managed to start the operation, because time an arrival spends waiting for a
launch slot is delay a real client would have felt. `latencyMs` is therefore
what a client at this offered rate observes, and it is what the SLO gates read;
`serviceLatencyMs` (actual start to completion) and `queueDelayMs` (scheduled
arrival to actual start) publish the two halves, so a slow target and a late
generator are told apart rather than inferred. A generator that cannot keep up
raises `queueDelayMs`, which raises `latencyMs`, which fails the same p95/p99
gates a slow target does - the run cannot look clean by being late. Scheduler
lag is reported alongside as a direct integrity signal, and its budget must be
no looser than the tightest latency SLO, so a profile cannot declare a lag
allowance larger than the latency target it is judged against.

Telemetry ticks are anchored to the run clock, not delayed from the completion
of the previous sample. The artifact records expected, started, and missed ticks
plus their p50/p95/p99 scheduling lag. Missing ticks, a sample slower than its
interval, or telemetry scheduling lag over the generator limit fails integrity;
a sparse trace cannot make an overload look healthy.

The required phases have distinct jobs:

- `warmup` establishes caches, JIT state, socket population, and backend pools;
- `expected_peak` is the only phase judged against the launch p95/p99/error SLO;
- `overload` must cross at least one declared resource threshold and identifies
  the first observed saturated resource at a known offered rate; and
- `recovery` continues a nonzero workload and must produce a complete passing
  window before `recoveryWithinMs`. An idle health probe is not recovery.

## Run and retain evidence

The runner ships in the package, so an application that installed
`svelte-adapter-uws` runs it directly - by its bin, or by path if you prefer
not to rely on `node_modules/.bin` being on `PATH`:

```bash
npx svelte-adapter-uws-capacity --profile ./capacity/chat.mjs --validate
node node_modules/svelte-adapter-uws/scripts/capacity/open-arrival.mjs --profile ./capacity/chat.mjs --validate
```

Contributors working inside this repository have the same runner behind an npm
script; every form below accepts identical flags.

Validate locally without contacting the target:

```bash
npm run capacity:run -- --profile /secure/evidence/chat-capacity.mjs --validate
```

Run from a dedicated generator host. The output path is mandatory and opened
with create-new semantics, so an old result cannot be overwritten:

```bash
npx svelte-adapter-uws-capacity \
  --profile /secure/evidence/chat-capacity.mjs \
  --output /secure/evidence/results/chat-2026-08-03T0100Z.json
```

The command atomically reserves the output path before it imports the profile or
contacts the target. An existing path is refused without running setup,
scenarios, or telemetry and its bytes remain unchanged. A failed gate exits
nonzero and still writes the evidence; an invalid profile or incomplete run
removes its empty reservation and exits with configuration status 2. Store the
profile, result, target dashboard interval, raw logs, and review decision
together in the deployment evidence system, not as ad-hoc JSON files in a
repository root.

## Review checklist

An independent reviewer verifies that the forecast window and traffic weights
come from production planning; synthetic users exercise authorization and
tenant distribution; live connection and fan-out counts are observed rather
than inferred; target telemetry is from every instance and backing service;
autoscaling was either exercised through its full cooldown or explicitly pinned;
the image and three package identities match the candidate; generator and
target hosts were not colocated; the first saturation witness is plausible;
and recovery includes application success, fresh metrics, drained queues, and
stable error/latency for the whole window. Read `recovery.attempts` against
`recovery.minAttempts`: a window that certified on the fewest attempts it was
allowed to is the weakest evidence the gate accepts. Check `latencyAnchor` is
`scheduled-arrival`, and read `queueDelayMs` beside `latencyMs` - a large
queue delay means the generator, not the target, produced the number.

Capacity is topology-specific. Multiplying a one-instance number by an instance
count is not evidence because load balancing, Redis/Postgres, inter-instance
relay, fan-out, and autoscaling can move the knee. Re-run after changing traffic
shape, topology, native uWS/Node major, package tuple, data-store shape,
autoscaling policy, payload size, compression, or an admission/backpressure
control that affects the measured path.
