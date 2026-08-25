# Desync coverage: sequencing and gap handling per delivery path

A per-scope monotonic counter checked by the receiver, failing hard into a full
resync on any mismatch, catches every drop, duplicate, reorder and logic-bug
class behind the wire codec without reasoning about the codec itself. This
matrix records, for each server-side delivery path, whether it makes that
promise, whether a gap can be answered, what happens when it cannot - and the
test that holds each row's claim as behaviour a real client observes, so a row
can only change by turning a test red.

**Read the third column carefully.** Several paths deliberately make no
monotonic promise. That is a design position, not an omission, and each one
below states what re-establishes consistency instead. The failure this matrix
exists to surface is a path that *looks* sequenced but can apply a frame
cleanly after a missed one.

| Delivery path | Stamps a per-scope sequence | Gap answerable | Unrecoverable gap forces resync | Observed at a real client by |
|---|---|---|---|---|
| Topic frames (`stampSeq` / `nextTopicSeq`) | Yes, per topic, when the lane opts in | Yes, from the resume buffer | Yes - truncation marker, then close 1013 | `test/seq-wire.test.js`, `test/publish-batched.test.js` (one counter across primitives), `test/smooth-wire-batch.test.js` (per-entry batch seqs, explicit and counter-stamped) |
| Resume / replay buffer (`handler/resume-buffer.js`) | Consumes the topic sequence | Yes, replays from the client's offset | **Yes - the reference pattern, see below** | the resume escalation suites |
| Relay gap fill (`relay-ring.js`, `handler.js`) | Per-origin ordinal, dense by construction | Detected by contiguity, not by voting | Yes - opted-in subscribers of the gapped sequence-lane topic get an unsolicited `gap` marker (refusing even that closes 1013) - see below | `test/relay-receive-real.test.js` |
| Cluster fan-out (`handler/cluster-sequence-policy.js`) | Refuses the unsafe combination outright | n/a - a guard, not a stamper | n/a | `test/cluster-sequence-policy-real.test.js` (spawned two-worker fixture, refusal observed through a real probe client) |
| Presence (`plugins/presence/server.js`) | No, `seq: false` by declaration | No - diffs carry no ordinal | Periodic full roster; opting out is a two-option act, see below | `test/presence-heartbeat-recovery.test.js` |
| Cursor (`plugins/cursor/codec.js`) | No - best-effort by declaration | No - a bad frame is dropped | No, and it does not need to - see below | `test/cursor-worker-wire.test.js` (corrupt frames over the real wire, then convergence) |
| Smooth (`plugins/smooth/codec.js`) | Deltas ordered; a duplicate id is dropped at BOTH ends | No | No - a JSON fallback leaves the delta chain intact | `test/smooth-wire-batch.test.js` (fallback mid-stream), `test/ingress.test.js` (crafted duplicate-id frame over real ingress) |
| Game framing (`handler/game-ingress.js`) | Yes - per-binding ingress counter inbound, authoritative room seq on fan-out | Yes, via the room sequence | Follows the topic path | `test/relay-oracle.test.js`, `test/game-fanout.test.js` (contiguous room seq on both carriages) |

## The reference pattern, worth copying

`handler/resume-buffer.js` is the path to imitate. On an incomplete flush it
sends a truncation marker so the client drops its stale offset and cold-resyncs
rather than trusting a window it only partly received. If the socket refuses
even that marker, it closes with **1013**, because there is no way left to tell
the client it has a hole and *staying connected is the one outcome that leaves
it silently wrong*. The reconnect resumes from the last sequence the client
actually received, so the missed tail is re-delivered rather than lost.

The escalation is the point: signal, and if the signal itself cannot be
delivered, remove the connection that would otherwise carry on quietly wrong.

## Why two paths correctly make no promise

**Cursor** is best-effort by declaration. `decodeCursor` returns null on an
unknown opcode, an unknown schema version, a dictionary desync or a truncated
frame, and the frame is dropped. A dropped position is self-healing: the next
position frame is absolute for that connection's epoch, so the cursor converges
without any resync machinery. A sequence here would add cost to a 60 Hz hot path
to protect a value that is corrected milliseconds later. The whole claim - a
corrupt frame neither dispatches, nor kills the worker, nor poisons the
per-connection dictionary, and the next genuine move converges through the same
connection - is held over the real wire.

**Cluster fan-out** is a guard rather than a stamper, and its reasoning is worth
keeping in view: per-worker counters fork across a multi-origin relay, so a
clustered publish must declare `{ seq: false }` or `{ seq: <positive integer>,
relay: false }`. The module also documents a subtler hazard - a numeric seq
stamps every entry of a batch with the *same* number, so a client that received
only part of that batch reports the shared number as its watermark and the
resume dedup floor then discards the whole batch, including entries it never
received. That silent gap is precisely what the sequence lane exists to prevent.

## Presence reconvergence is one mechanism split across two options

Presence publishes diffs with `seq: false`; what re-establishes consistency is
the periodic full roster heartbeat (default 30 s) working WITH the client's
`maxAge` sweep - the sweep removes entries the heartbeat no longer confirms,
and the heartbeat re-adds an entry the sweep removed on a dropped diff. They
are one mechanism: disabling only the heartbeat (`heartbeat: 0`) leaves the
sweep removing entries nothing restores, so against a client on the default
90 s window a quiet room empties itself with nothing dropped at all. Both
option surfaces document the pairing, `createPresence` warns once when
`heartbeat: 0` is set without the `maxAge: 0` that completes the opt-out, and
`test/presence-heartbeat-recovery.test.js` holds the divergence as observed
client state.

## A relay gap reaches both the operator and the affected clients

Detection is sound: per-origin contiguity over a stream dense by construction,
confirmed gaps drained once, `relay_gap_frames_total` incremented and
`runtime.relay-gap.detected` emitted at `error` severity with the topic, origin
worker and ordinal span - the emission deriving its component, event, severity
and problem sentence from the error-registry entry itself, so the registry and
the wire can never state different facts.

The clients hear too, on the same drain, because for them the loss is uniquely
poisonous: the delivered envelopes step past the lost sequence, so a
subscriber's resume watermark advances beyond frames it never held and a later
reconnect gap-fills from after the hole rather than into it - the one desync
in this matrix that a reconnect does not heal. `signalRelayGaps`
(`handler/lifecycle.js`) sends each affected subscriber that negotiated
`relay.resync:1` an unsolicited `gap` marker on `__replay:{topic}` with the
proven-lost count and a subscriber-scaled de-herd window; the bundled client
drops the topic's offset and epoch on the marker and dispatches it to the
event stores for the application's re-snapshot. The blast radius is exactly
the loss: only subscribers of the gapped topic, only on the worker that lost
the frames, only for sequence-lane topics (a `{seq: false}` topic has no
offset to poison, and each reserved plugin lane owns its own reconvergence).
A socket refusing even the marker - past its backpressure ceiling - is closed
1013, the resume flush's own escalation, because staying connected is the one
outcome that leaves it silently wrong forever. A connection that never
advertised the capability keeps the surviving frames and the revision's
original silence. `test/relay-receive-real.test.js` holds the marker (count
and window) and the non-opted silence as observed client behaviour, and
drives the refused-marker 1013 close against the runtime's own
live-connection walk; `test/client-real.test.js` holds the client half: the
dropped offset is observable as a reconnect resubscribe that no longer
presents one.

## Duplicate ids cannot enter through the smooth command lane

The smooth command codec enforces strictly-increasing ids at both ends: encode
keeps only strictly-increasing entries (which also keeps the id delta encoding
total), and decode drops any entry whose id fails to increase past the first -
which catches a zero delta and the delta so large that float addition
collapses onto the previous id, the two spellings a crafted frame can use for
a duplicate. A crafted or corrupt frame therefore cannot double-apply a
command id, and the entries behind a dropped duplicate arrive intact because
the dropped entry's value is still consumed from the stream.
`test/ingress.test.js` holds this both as a unit round-trip and as the routed
batch a real connection's crafted frame produces.
