# Benchmark reproduction index

[README performance claims](../README.md#performance) |
[deterministic CI budgets](../README.md#deterministic-ci-io-budgets) |
[contributor verification](../CONTRIBUTING.md#what-to-run-before-you-propose-a-change)

This directory contains repository-only performance experiments. It is not in
the npm package: these programs need source, development dependencies, local
ports, and sometimes a native addon or browser. Run every command below from
the repository root after `npm ci`. Output is written to stdout; no command is
supposed to rewrite a source file or a committed golden.

## Which command reproduces which claim

| Claim or question | Exact command | Output | Interpretation limit |
| --- | --- | --- | --- |
| HTTP adapter overhead by layer | `node bench/run.mjs` | requests/s, average and p99 latency, and deltas from bare uWS | Wall-clock, loopback, synthetic fixed responses; compare matched runs on one idle host. |
| README HTTP and WebSocket comparison tables | `node bench/run-compare.mjs` | adapter/uWS/Node HTTP rows plus uWS/adapter/ws/socket.io delivery | Saturation on loopback is not an Internet workload or a general library ranking. Fan-out below the expected ratio means the sender outran delivery. |
| WebSocket implementations only | `node bench/run-ws-only.mjs` | sent/received rates and fan-out ratio for four servers | Treat received messages/s with the fan-out ratio; sent rate alone is not throughput. |
| Old versus optimized adapter WebSocket handler | `node bench/run-ws-compare.mjs` | old/current delivered messages/s | Historical code copies isolate one change; they are not supported server implementations. |
| Anonymous SSR render deduplication | `node bench/run-dedup.mjs` | renders per 200-request burst and reduction ratio | Proves same-key coalescing under the fixture's 5 ms delay, not end-user latency or personalized-route safety. |
| HTTP change A/B | `node bench/run-ab.mjs 4b-ssr-nodedup.mjs 4c-ssr-dedup.mjs 6 5` | alternating median/stddev requests/s and p99 | Replace both filenames only with HTTP servers that honor `PORT`; a delta inside baseline variation is noise. |
| WebSocket change A/B | `node bench/run-ws-ab.mjs 24-ws-adapter-uws.mjs 24-ws-adapter-uws-variant-dataview.mjs 5 6 50` | alternating median/stddev delivered messages/s | Both servers must implement the same adapter protocol and honor `PORT`; preserve client count and duration across comparisons. |
| Cursor binary decode claims | `node bench/micro-wire-decode.mjs` | JSON/v1/v2 bytes and median decode nanoseconds | CPU microbenchmark after warm-up; it excludes network, rendering, and compression. |
| Cursor encode/fan-out crossover | `node bench/encode-crossover.mjs` | per-subscriber CPU ratios and bytes/frame | A synthetic steady-state room; choose wire policy from CPU and bytes together, not one column. |
| Real compressed wire-size claims | `node bench/ws-compression-ab.mjs` | raw and TCP-observed bytes/frame for binary and JSON | Local negotiated permessage-deflate; proxy, TLS, dictionary history, and application payloads can change the result. |
| Smooth replay cost quoted in the README | `node bench/35-smooth-replay-ab.mjs` | nanoseconds per acknowledgement and replayed command | Pure steady-state predictor work; excludes transport and rendering. |
| CRDT merge/flush/compaction claims | `node bench/micro-crdt-apply.mjs` | nanoseconds/op, flush bytes, and explicit gates | Synthetic Yjs documents; data shape and edit locality matter in applications. |

The normal test gate does not consume these timings. It uses deterministic
operation counts in [`test/io-budget.test.js`](../test/io-budget.test.js) so a
slower CI runner cannot turn noise into a regression. Benchmark evidence may
support a change, but never replaces correctness, static checks, or the full
suite.

## Environment record

Record this beside any number you cite:

- repository revision or patch identity and whether the worktree was dirty;
- `node --version`, `npm --version`, operating system, architecture, CPU, and
  power profile;
- exact command and every non-default argument or environment variable;
- native-addon availability (`npm run doctor -- --require-uws` for a native
  profile), browser/headless mode for browser profiles, and client counts;
- warm-up/round counts, background-load posture, and the complete stdout,
  including variation and fan-out/recovery checks.

Use the Node release pinned by `.nvmrc`. Close competing workloads and keep the
power profile fixed. Do not compare results from different machines, Node
majors, browser modes, virtualization layers, or thermal states as if they were
an A/B. The runners use loopback ports (normally 9001, 9002, or 9100-9120); set
the script's documented `PORT` only when a default is occupied, and record it.

Environment labels used below:

- **JS**: pinned Node plus `npm ci`; no listening native server.
- **native**: JS plus a successful `npm run doctor -- --require-uws` and free
  loopback ports.
- **load**: native plus `autocannon`; use an idle, fixed-power host.
- **browser**: JS plus the Playwright Chromium installed by the repository
  bootstrap; headed and headless results are different profiles.
- **GC**: JS with the exact `--expose-gc` flag shown.

## Complete profile catalog

Every directly runnable profile is listed here. Defaults are part of the
command; if you change them, the changed command is the profile identity.

| Profile | Exact command | Environment | Output and limit |
| --- | --- | --- | --- |
| Publish-batched fan-out shapes | `node bench/27-publish-batched-ab.mjs` | native | Delivered messages/s for large-same, medium-over, and small-disjoint; local testing surface and synthetic subscribers. |
| Per-key throttle fairness | `node bench/28-throttle-per-key-ab.mjs` | JS | Fast/slow-user delivery percentages; deterministic algorithm model, not scheduler or network timing. |
| Cursor coalescing | `node bench/29-cursor-coalesce-ab.mjs` | JS | ns/update plus publish/byte reductions; timing is local, counts are the stronger evidence. |
| Cursor viewport culling | `node bench/30-cursor-viewport-cull-ab.mjs` | JS | entry/byte reductions, scan/index crossover, lazy-gate frames; seeded synthetic board. |
| Non-advertising publish path | `node bench/31-gateless-publish-ab.mjs` | native | median/stddev publishes/s for all built-in shapes; compare against a matched baseline build. |
| Cursor renderer | `node bench/33-cursor-render-browser.mjs` | browser | Canvas/WebGL ms/frame and 1K-cursor bars; headless software/GPU selection is not headed production GPU behavior. Use `--headed` as a separately recorded profile. |
| Smooth interpolation | `node bench/34-smooth-straddle-ab.mjs` | JS | microseconds/frame and ns/entity; pure sampling without DOM, network, or game work. |
| Smooth reconciliation | `node bench/35-smooth-replay-ab.mjs` | JS | ns/ack and ns/replayed command; fixed steady-state windows. |
| Smooth ingest record decision | `node bench/36-smooth-ingest-record-ab.mjs` | JS | Median ns/command and encoded bytes for current objects, a fixed accessor, and flat integers through the current codec; the printed 70% gap-closure decision applies only to the synthetic command corpus. |
| Upgrade admission overhead | `node bench/admission-upgrade-overhead.mjs` | native | live upgrade/open/close rates for accept paths; `CYCLES` and `LANES` alter the profile. |
| Wire encode crossover | `node bench/encode-crossover.mjs` | JS | CPU ratios and frame sizes by subscriber count; synthetic stable dictionary state. |
| Fatal-guard success path | `node bench/micro-assert-fatal-hotpath.mjs` | JS | alternating median/stddev and slowdown; success branch only. |
| Subscribe-batch landing policy | `node bench/micro-batch-landing-policy-ab.mjs` | JS | ns/frame for inline versus routed checks; armed/no-denial path only. |
| CRDT apply/diff/compaction | `node bench/micro-crdt-apply.mjs` | JS | ns/op, bytes, and gates; synthetic Yjs corpus. |
| Cursor feed boundary | `node bench/micro-cursor-feed-boundary.mjs` | JS | feed-boundary cost/reduction reported by the script; local synthetic scheduling. |
| Cursor microtask defer | `node bench/micro-cursor-microtask-defer.mjs` | JS | update fragmentation and bulk sizes; Promise turns model uWS dispatch but are not uWS. |
| Origin helper extraction | `node bench/micro-origin.mjs` | JS | alternating helper medians/stddev; valid hot-path inputs only. |
| Presence wire | `node bench/micro-presence-wire.mjs` | JS | raw JSON/binary size and codec timing; compressed results belong to the live compression profile. |
| Publish option capture | `node bench/micro-publish-capture-ab.mjs` | JS | alternating live-read versus one-read-capture option handling around the publish-lane sequence resolution; local synthetic topics, no sockets. |
| Publish codec gate | `node bench/micro-publish-codec-overhead.mjs` | JS | publish-path codec/no-codec timing and bytes; no sockets. |
| Resume-cutover publish guard | `node bench/micro-publish-resume-guard-ab.mjs` | JS | alternating publish-path cost; synthetic state distribution. |
| Relay receive path | `node bench/micro-relay-receive-ab.mjs` | native | live fan-out receive variants and rates; loopback, fixed synthetic envelope. |
| Request construction | `node bench/micro-request.mjs` | JS | `Request` construction cost; isolated primitive, not SSR latency. |
| Sequence stamping | `node bench/micro-seq-stamp-ab.mjs` | JS | alternating sequence-path cost; local synthetic topics. |
| Observed-sequence record | `node bench/micro-seq-seen-record-ab.mjs` | JS | alternating bare-set versus membership-reporting max-seen record inside a publish proxy; the fresh-topic shape is held at a small count on purpose, because a larger one measures `Map` growth rather than the record. |
| Observed-maximum guard | `node bench/micro-seq-monotone-stamp-ab.mjs --arm=legacy\|gated\|ungated` | JS | prices the monotone-max compare on the counter arm against the bare write it replaced, inside a publish proxy. Run ONE ARM PER PROCESS and compare across runs: an earlier single-process version of this file reported a cost near three times the real one, because the arms shared inline caches. The hot-topic delta is around a percent with the arms crossing over between runs, so a single run cannot separate them. |
| Delivered-sequence tracker | `node bench/micro-seq-tracker.mjs` | JS | marginal tracker/fan-out cost; no production multiworker IPC. |
| Batch entry reads | `node bench/micro-wire-batch-alias-ab.mjs` | JS | alternating per-entry read shapes at 1/8/64 entries; run-to-run spread exceeds the A/B delta, so treat a single run as inconclusive. |
| Per-viewer batch pinning | `node bench/micro-send-wire-batch-ab.mjs` | JS | alternating `sendWireBatch` payload-pinning shapes at 1/8/30/64 entries, on the JSON-only and binary paths separately; the JSON-only figures sit inside run-to-run spread because `JSON.stringify` dominates them, so read the binary column for the copy the change removes. |
| Smoother allocation | `node --expose-gc bench/micro-smooth-alloc.mjs` | GC | allocation/heap deltas; garbage collection and heap accounting are runtime-sensitive. |
| Replay allocation | `node --expose-gc bench/micro-smooth-replay-alloc.mjs` | GC | allocation/heap deltas by replay window; same GC caveat. |
| Subscribe try/catch | `node bench/micro-subscribe-trycatch.mjs` | JS | alternating exception-wrapper overhead; successful call path only. |
| Symbol versus string slot | `node bench/micro-symbol-vs-dunder.mjs` | JS | alternating access timing; engine-specific microbenchmark. |
| Shared utility extraction | `node bench/micro-utils.mjs` | JS | helper median/stddev, delta, and accumulator parity; a sub-percent delta is usually noise. |
| Cursor wire decode | `node bench/micro-wire-decode.mjs` | JS | bytes and decode ns/frame; warmed CPU-only frames. |
| Wire fan-out | `node bench/micro-wire-fanout.mjs` | JS | encode CPU and bytes/publish by subscriber count; no sockets or compression. |
| Pressure sampler bound | `node bench/pressure-sampler-micro.mjs` | JS | capped/uncapped microseconds/tick and growth ratio; synthetic connection objects. |
| Relay ring | `node bench/relay-ring-ab.mjs` | JS | primary-to-consumer transfer timing by variant; worker-thread model, not network IPC. |
| Relay frame admission | `node bench/relay-frame-admission-ab.mjs` | JS | best-of-round flush throughput with the sender frame ceiling on and off; the flush is driven synchronously through the injectable timer seam, so it isolates the admission branch and is not end-to-end relay timing. Repeat invocations - the per-invocation delta sits inside run-to-run spread. |
| Runtime clock/timer helpers | `node bench/runtime-overhead.mjs` | JS | ns/op and overhead gate; timer arm/clear cost is informational. |
| Compressed bytes on live uWS | `node bench/ws-compression-ab.mjs` | native | TCP-observed bytes/frame; loopback compression history and payload corpus constrain it. |
| Compression CPU scaling | `node bench/ws-compression-cpu.mjs` | native | microseconds/publish by mode and subscriber count; synchronous loop isolates server work and is not end-to-end latency. |
| Fan-out overload recovery | `node bench/ws-fanout-recovery.mjs` | native | buffered bytes, backpressured connections, recovery time, and close posture; loopback timing can vary, especially the optional close observation. |

## Runner-owned fixtures

The following files are components, not independent claims. Starting one alone
only opens a server or client and does not produce a comparable result. The
right-hand command is the exact orchestrator that owns its lifecycle.

| Component | Use through |
| --- | --- |
| [`1-baseline-uws.mjs`](./1-baseline-uws.mjs), [`2-baseline-cork.mjs`](./2-baseline-cork.mjs), [`3-static-sim.mjs`](./3-static-sim.mjs), [`4-ssr-sim.mjs`](./4-ssr-sim.mjs), [`5-request-only.mjs`](./5-request-only.mjs), [`6-async-overhead.mjs`](./6-async-overhead.mjs), [`7-header-iter.mjs`](./7-header-iter.mjs) | `node bench/run.mjs` |
| [`10-node-baseline.mjs`](./10-node-baseline.mjs), [`11-node-polka-sirv.mjs`](./11-node-polka-sirv.mjs), [`12-node-ssr-sim.mjs`](./12-node-ssr-sim.mjs) | `node bench/run-compare.mjs` |
| [`4b-ssr-nodedup.mjs`](./4b-ssr-nodedup.mjs), [`4c-ssr-dedup.mjs`](./4c-ssr-dedup.mjs) | `node bench/run-dedup.mjs` |
| [`20-ws-uws.mjs`](./20-ws-uws.mjs), [`21-ws-socketio.mjs`](./21-ws-socketio.mjs), [`22-ws-ws.mjs`](./22-ws-ws.mjs), [`23-ws-bench-client.mjs`](./23-ws-bench-client.mjs), [`24-ws-adapter-uws.mjs`](./24-ws-adapter-uws.mjs) | `node bench/run-ws-only.mjs` or `node bench/run-compare.mjs` |
| [`25-ws-adapter-uws-old.mjs`](./25-ws-adapter-uws-old.mjs) | `node bench/run-ws-compare.mjs` |
| [`24-ws-adapter-uws-variant-dataview.mjs`](./24-ws-adapter-uws-variant-dataview.mjs) | `node bench/run-ws-ab.mjs 24-ws-adapter-uws.mjs 24-ws-adapter-uws-variant-dataview.mjs 5 6 50` |

The orchestrators themselves are [`run.mjs`](./run.mjs),
[`run-compare.mjs`](./run-compare.mjs), [`run-ws-only.mjs`](./run-ws-only.mjs),
[`run-ws-compare.mjs`](./run-ws-compare.mjs),
[`run-dedup.mjs`](./run-dedup.mjs), [`run-ab.mjs`](./run-ab.mjs), and
[`run-ws-ab.mjs`](./run-ws-ab.mjs). This inventory is checked against every
`.mjs` file in the directory so a new profile cannot arrive undocumented.

## Reading a result honestly

- Prefer an alternating A/B runner and report median plus variation. One fast
  sample is not evidence.
- A result inside the baseline's variation is inconclusive. Do not relabel it
  as a win, and do not compare rounded README numbers to a new raw run.
- Throughput without delivery, fan-out, error, backpressure, or recovery checks
  can reward dropped work. Keep every integrity line from stdout.
- Pure and deterministic profiles answer algorithm questions; live profiles
  answer one local runtime question. Neither predicts a production topology by
  itself.
- Preserve negative or neutral results. They delimit when an optimization is
  useful and prevent a later run from cherry-picking a friendlier profile.
