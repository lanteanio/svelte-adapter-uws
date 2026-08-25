# Roadmap

This describes the 0.6 line of `svelte-adapter-uws`: what the release is for,
what is deliberately out of scope, and the evidence that gates its stable
promotion. Promoting 0.6.0 from `next` to `latest` is an evidence decision
before it is a procedure - the mechanical steps live in
[`docs/releasing.md`](./docs/releasing.md), and they begin only when the exit
contract at the bottom of this file is satisfied. Historical prereleases are
records; this file describes the line, not any single prerelease.

The 0.6 line is a zero-configuration realtime server for SvelteKit: SSR,
static serving, and WebSockets on one uWebSockets.js binary, with
broker-free multi-worker clustering, a binary wire path built for game-tick
delivery, resume and recover contracts that refuse silent loss, a protection
posture for the open internet, and an operator-actionable error surface -
all driven by suites that exercise the built output rather than a mock of it.

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
