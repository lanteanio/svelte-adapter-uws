# Ecosystem claim register: adapter ledger

[Package README](../README.md) |
[benchmark reproduction index](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/bench/README.md) |
[protocol conformance](./protocol-conformance.md)

`claim-register-v1` is the `svelte-adapter-uws` component of the ecosystem
claim register. Companion repositories keep their own ledger with the same
two evidence patterns, so a package never claims evidence owned by a different
worktree.

A consequential public claim uses exactly one visible pattern:

- **Measured / Conditions / Reproduce** for an observation. A number without
  its workload, environment, and exact command is not a retained claim.
- **Guarantee / Requires / Verified** for behavior. The guarantee is no wider
  than its prerequisites and executable evidence.

No adoption count, popularity rank, or ecosystem-usage claim is active for this
adapter. Adding one requires a source, collection date, population definition,
and reproduction route before it may appear in public copy.

## Current measurement session

The current local observations were collected on 2026-08-02 from the shared,
uncommitted development worktree with `svelte-adapter-uws@0.6.0-next.92`, Node
24.13.1, npm 11.8.0, Windows 10.0.26200, and an AMD Ryzen 9 9950X3D. The
repository baseline is Node 22.23.2, so these observations are not release-gate
or cross-machine baselines. Complete runner stdout is the evidence for one run;
rerunning may produce different values.

## Retained measured claims

### ADAPTER-PERF-HTTP

**Measured:** `adapter-uws` produced 86,294 static requests/s versus 5,174 for
the adapter-node fixture (16.7x), and 81,533 SSR requests/s versus 34,427
(2.4x).

**Conditions:** Loopback fixed-response fixtures, 100 connections, pipelining
10, ten seconds, two runs averaged, under the current measurement session.
This does not measure an application, Internet latency, or another server.

**Reproduce:** Run `node bench/run-compare.mjs`; retain the complete output and
compare only matched runs on one idle host.

### ADAPTER-PERF-WS

**Measured:** Delivered rates were 3,454,683 messages/s for bare uWS,
2,840,927 for the adapter, 129,595 for `ws`, and 136,676 for `socket.io`.

**Conditions:** Fifty loopback clients, ten senders, burst size 50, eight
seconds, one run per fixture, under the current measurement session. Fan-out
was 19.0x, 11.9x, 0.3x, and 0.4x respectively versus an expected 50x, so this
is a saturated delivered-rate observation rather than lossless capacity.

**Reproduce:** Run `node bench/run-compare.mjs`; read delivered rate together
with fan-out and preserve both in any citation.

### ADAPTER-PERF-BATCH

**Measured:** Median delivered rates across five alternating rounds were
1.861M/s batched versus 323.8K/s looped for the large single-topic shape
(5.75x), 1.386M/s versus 680.7K/s for overlapping topics (2.04x), and a 0.16%
difference for small disjoint topics, inside run-to-run variation.

**Conditions:** Synthetic local subscribers under the current measurement
session. The fast shapes share event slices; mixed or disjoint views exercise
the individual-frame fallback.

**Reproduce:** Run `node bench/27-publish-batched-ab.mjs` and retain all rounds,
standard deviations, and verdicts.

### ADAPTER-PERF-PRESENCE

**Measured:** With live permessage-deflate, 50-entry presence state/heartbeat
frames were 5.9-6.9% smaller with the shared compressor and 11.9-12.9% smaller
with dedicated compressors. A 500-entry heartbeat was 0.8-2.4% smaller. A
one-entry diff was 35.6% smaller with the shared compressor but 5.4% larger
with dedicated context takeover.

**Conditions:** Local uWS plus a `ws` client, TCP-observed bytes per frame, the
runner's fixed roster corpus, and the current measurement session. Proxy, TLS,
payload, and compression history can change the sign as well as the magnitude.

**Reproduce:** Run `node bench/ws-compression-ab.mjs`; retain every compression
mode and any row where binary is larger.

### ADAPTER-PERF-CURSOR

**Measured:** For 221 in-process keys, the full-string frame was 82.9% smaller
than JSON and decoded 4.1x faster; the warm short-id frame was 86.0% smaller and
decoded 18.2x faster. For clustered keys, the warm short-id frame was 88.7%
smaller and decoded 14.6x faster.

**Conditions:** Warmed CPU-only microbenchmark, seven rounds, fixed entry
counts, random numeric positions, and a complete result walk. It excludes
sockets, compression, rendering, and dictionary warm-up.

**Reproduce:** Run `node bench/micro-wire-decode.mjs`; cite the exact key corpus,
entry count, and schema row.

### ADAPTER-PERF-DEDUP

**Measured:** Across three 200-request bursts, the fixture averaged 200 render
calls without deduplication and 1.7 with it, a 120x render-call reduction.

**Conditions:** Concurrent anonymous same-key GET requests, 5 ms synthetic
render delay, bufferable response, and no personalization headers. This is a
work-count observation, not a latency or memory result.

**Reproduce:** Run `node bench/run-dedup.mjs`; keep the request count, delay,
round count, and full output with the result.

## Retained behavioral guarantees

### ADAPTER-CORRECT-IO

**Guarantee:** The normal test gate enforces the documented transport write,
allocation, payload-copy, zero-copy ingress, encode-once fan-out, and
per-subscriber stateful-write budgets with deliberately failing controls.

**Requires:** These are operation counts at injected boundaries, not elapsed
time, CPU, heap, kernel, or network guarantees. A budget change must update its
reason and control in the same change.

**Verified:** Run `npm exec vitest -- run test/io-budget.test.js`; authority and
non-vacuity live in
[`test/io-budget.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/io-budget.test.js).

### ADAPTER-CORRECT-BATCH

**Guarantee:** One complete relay-eligible `publishBatched` list crosses the
worker boundary in one IPC message; receiving workers independently choose a
shared batch or local fallback and do not relay `relay:false` entries.

**Requires:** Cluster sequence authority follows the public sequence contract,
and the shared-frame fast path requires capable subscribers with identical
event slices.

**Verified:** Run the focused `publish-batched`, `relay-ring`,
`sim-multiworker`, and `api-docs-contract` suites. The real two-server proof is
in [`test/api-docs-contract.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/api-docs-contract.test.js).

### ADAPTER-CORRECT-SEQUENCE

**Guarantee:** The in-memory topic counter is used only with one runtime worker.
With multiple workers, every production publish entry point refuses implicit
sequencing and refuses caller-supplied positive sequences on the built-in
multi-origin relay before delivery.

**Requires:** Cluster events are explicitly unsequenced, or one external
authority allocates every positive sequence and performs the ordered fan-out
with the adapter relay disabled. This is per-topic ordering, not global order
and not durable recovery by itself.

**Verified:** Run `npm exec vitest -- run test/cluster-sequence-policy.test.js
test/cluster-sequence-policy-real.test.js`. The first suite binds every
production entry point and adversarial option shape; the second boots real
one-worker and two-worker runtimes and observes allow/refuse outcomes over a
real WebSocket.

### ADAPTER-CORRECT-GAME

**Guarantee:** The built-in game lane is a single-I/O-home authority. A
multi-I/O-worker runtime refuses server grants and publishes and denies client
frames before local fan-out, rather than claiming delivery to remote sockets.

**Requires:** Exactly one I/O worker owns all sockets; additional compute
workers are allowed. Multi-home deployments need an external authoritative
room sequencer and fan-out not supplied by this primitive.

**Verified:** Run `npm exec vitest -- run test/game-cluster-policy.test.js
test/game-cluster-policy-real.test.js`. The unit suite binds the JSON,
binary, grant, and server-publish gates; the real suite boots unsafe multi-home
and allowed single-home-plus-compute variants.

### ADAPTER-CORRECT-CURSOR-WIRE

**Guarantee:** Cursor wire-form selection is negotiated per connection. From one
publish, a connection that advertised `cursor.protocol:3` receives the short-id
dictionary form, one that advertised only `cursor.protocol:2` receives the
full-string form, and one that advertised neither receives the JSON envelope.
The 1-byte schema version identifies the form, and a frame with an unknown
schema version is dropped rather than mis-decoded.

**Requires:** The capability handshake on connect; a payload the codec declines
rides the JSON fallback. This binds wire-form selection, not application
semantics across releases.

**Verified:** Run `npm exec vitest -- run test/wire-mode.test.js
test/wire-dict.test.js test/wire-codec.test.js`. The mixed-capability fan-out
proof (binary to a capable subscriber and JSON to a non-capable one from one
publish) lives in
[`test/wire-mode.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/wire-mode.test.js).

### ADAPTER-SEC-SSRF

**Guarantee:** Literal private, local, metadata, disallowed-scheme, and
supported IPv4-embedding forms fail closed, and resolved addresses receive the
same range classification.

**Requires:** Call `checkUrlResolved` with a trustworthy resolver for DNS
rebinding. Declare the translator's exact prefix when NAT64 cannot be inferred;
an incorrect trusted prefix can weaken classification.

**Verified:** Run `npm exec vitest -- run test/safe-url.test.js`; the corpus is
owned by [`test/safe-url.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/safe-url.test.js).

### ADAPTER-SEC-WEBHOOK

**Guarantee:** Webhook verification covers the timestamp and exact body bytes,
uses constant-time digest comparison, rejects stale or malformed inputs, and
returns `false` instead of throwing for invalid shapes.

**Requires:** Preserve raw bytes, configure a secret, retain the freshness
check, and deduplicate separately when replay inside the accepted window
matters.

**Verified:** Run `npm exec vitest -- run test/webhooks-delivery.test.js`; exact
byte-container, rotation, freshness, malformed-input, and sender round trips
live in [`test/webhooks-delivery.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/webhooks-delivery.test.js).

### ADAPTER-OPS-FD

**Guarantee:** A process cannot keep more sockets open than its descriptor soft
limit permits, and every other open descriptor reduces the available socket
headroom.

**Requires:** Read the deployed process's actual soft limit. Host, container,
service-manager, and login-shell limits differ; `1024` is not assumed.

**Verified:** A soft limit below `8192` produces a boot warning. When metrics
are configured, `open_fds` and `fd_soft_limit` expose the observed values; their
aggregation law is covered by
[`test/metrics-snapshot.test.js`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/test/metrics-snapshot.test.js).

## Withdrawn or narrowed copy

The register deliberately does not retain the previous universal "fastest" or
"every other JavaScript server" ranking, native-WebSocket parity, "near-zero"
adapter-overhead conclusion, isolated per-layer percentages, old comparison
tables, or exact 200-to-1 dedup result. The maintained runners did not reproduce
those statements in the current session, or the repository had no retained
profile that isolated the stated cause. They may return only with a bounded
pattern above.

## Change rule

A change to a registered statement must update the adjacent public pattern,
this ledger, and its executable or benchmark owner together. A new numerical
claim must also appear in the benchmark reproduction index. A green unrelated
test suite, an unlabeled table, or a link to a benchmark directory is not a
substitute for the exact evidence route.
