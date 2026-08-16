# Roadmap

This is the outcome contract for the 0.6 line of `svelte-adapter-uws`: what
the release is for, who each outcome serves, the measure that shows it
landed, and what is deliberately out of scope. The stable promotion of 0.6.0
from `next` to `latest` is an evidence decision before it is a procedure -
the mechanical steps live in [`docs/releasing.md`](./docs/releasing.md), and
they begin only when the exit contract at the bottom of this file is
satisfied. Historical prereleases are records; this file describes the line,
not any single prerelease.

## Outcome map

Each outcome names the actor it serves, the measure that shows it landed
(every measure is a gate, a suite, or a generated artifact in this
repository - never an intention), and the work that delivers it. The map is
the tracked grouping of the delivering work: an outcome whose measure cannot
be demonstrated is not done, whatever else has shipped.

### A realtime server that works without configuration

- **Serves:** SvelteKit application developers.
- **Measure:** the zero-configuration path - the adapter in
  `svelte.config.js` and the Vite plugin - boots SSR, static serving, and
  WebSockets on one uWebSockets.js binary, and the fixture suites drive that
  built output rather than a mock of it.
- **Delivered by:** the adapter build pipeline, the generated runtime, and
  the packed-tarball consumer suites that install and run README examples
  against the exact bytes a consumer would receive.

### Clustering without a message broker

- **Serves:** operators scaling one machine before reaching for
  infrastructure.
- **Measure:** a multi-worker fleet relays publishes through shared-memory
  rings with per-topic sequence continuity, detects cross-worker state
  divergence through the state-hash detector, and recovers a crashed worker
  under a bounded per-slot restart budget - each driven by real clustered
  fixtures in the suite.
- **Delivered by:** the cluster primary, the relay rings and their spill
  policy, the restart supervisor, and the divergence diagnostics.

### Delivery that keeps up with a game tick

- **Serves:** builders of latency-sensitive multiplayer applications.
- **Measure:** the wire path holds its byte and allocation budgets under the
  copy-authority seals in the suite, and the comparison benchmarks in
  `bench/` record the delta-codec and fan-out numbers the documentation
  cites.
- **Delivered by:** the binary wire codecs, the delta compression, the
  fan-out lanes, and the backpressure accounting.

### Failures an operator can act on

- **Serves:** operators running the adapter in production.
- **Measure:** every entry in the generated error reference is driven from
  the condition it claims by a test, or carries a recorded reason its
  emission cannot be conjured; the reference renders from the registry the
  runtime actually prints through.
- **Delivered by:** the error registry, the operational event pipeline, the
  posture export, and the per-entry driven suites.

### Reconnection without silent loss

- **Serves:** application developers whose clients ride unreliable networks.
- **Measure:** the resume and recover contracts - gap-fill floors, held-frame
  flushes, truncation escalation, epoch-gated acks - are driven through real
  sockets, and a client that cannot be made whole is told so rather than
  left silently behind.
- **Delivered by:** the resume buffers, the recover lane, the subscription
  grant model, and the bundled client's reconnect behavior.

### Staying up under abuse

- **Serves:** operators exposed to the open internet.
- **Measure:** the protection posture ladder (normal, elevated, siege), the
  upgrade admission queue, and the per-topic pressure thresholds are driven
  to their edges in the suite, and the posture surface reports what the
  worker is actually doing.
- **Delivered by:** the pressure samplers, the posture machines, the
  admission gate, and the waiting room.

### Releases whose bytes are the verified bytes

- **Serves:** every consumer of the published package.
- **Measure:** publication is possible only through the tag-triggered
  two-job workflow; the gate pins the workflow body, the script names AND
  bodies, and the coordinated train facts (sibling versions, qualification
  heads, wire-protocol revision) against their sources, and refuses drift.
- **Delivered by:** the release workflow, `scripts/check-release-workflow.js`,
  `scripts/check-compatibility.js`, and the compatibility manifest.

### Tests a contributor can trust

- **Serves:** contributors and the maintainers of the sibling packages.
- **Measure:** the runtime runs on an injectable clock, RNG, and timer seam
  gated by `scripts/check-determinism.js`; the deterministic simulator
  reproduces multi-worker schedules; suites drive built output, not mocks.
- **Delivered by:** the runtime seam, the simulator, the fixture build
  system, and the real-runtime helpers.

## Non-goals for 0.6

Naming what 0.6 will not do is part of the contract; none of these are
failures of the line.

- **HTTP/3, QUIC, or WebTransport as a serving default.** HTTP/1.1 with WSS
  remains the permanent default transport. The WebTransport reliable-stream
  binding freezes only after an implementation has carried real bytes, and
  no 0.6 promotion waits on it.
- **A Bun serving backend.** The shared-core direction is decided, and the
  work follows the 0.6.0 tag rather than gating it.
- **Reference UI.** The library ships primitives; interface components live
  in the demo application, not the package.
- **An interest-management scheduler.** The assignment core ships in 0.6;
  scheduling policies belong to the next line.
- **Sibling lifecycle parity as a 0.6 blocker.** The extensions and realtime
  packages adopt the release lifecycle in their own repositories; 0.6
  records coordination in the train manifest rather than blocking on
  sibling process.

## Stable promotion exit contract

Promoting 0.6.0 from `next` to `latest` requires all of the following, each
independently checkable at promotion time. The procedure in
[`docs/releasing.md`](./docs/releasing.md) treats this list as its
precondition; prerelease history is context, never a substitute.

1. **The verification contract is green where it gates.** The complete check
   chain and test suite pass on the platforms the repository gates,
   including the packed-tarball consumer suites.
2. **The train row is current and bound.** The compatibility manifest's
   prerelease row carries the exact qualified sibling versions and
   qualification heads, those heads equal the cross-repo gate's pins, and
   that gate is green at those pins.
3. **The wire protocol is frozen.** The manifest's recorded revision equals
   the revision parsed from `protocol.schema.json`, with no incompatible
   schema change pending.
4. **The error reference is complete.** Every registry entry is driven from
   the condition it claims or carries a recorded unreachability reason.
5. **The documentation describes what ships.** README, MIGRATION, and the
   docs tree claim no capability above or below the promoted bytes, and the
   migration guide's surface marker is current.
6. **No reachable open defect.** No known defect on the prerelease line is
   reachable through a documented surface without a documented workaround.
7. **The ledger is reconciled.** Every published identity of the line is
   recorded in the release manifest before the promotion row joins it.

An item that cannot be demonstrated blocks promotion; the answer is to
produce the evidence or fix the gap, never to shrink the list in the same
change that claims it.
