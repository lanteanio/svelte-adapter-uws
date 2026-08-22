# Desync coverage: sequencing and gap handling per delivery path

A per-scope monotonic counter checked by the receiver, failing hard into a full
resync on any mismatch, catches every drop, duplicate, reorder and logic-bug
class behind the wire codec without reasoning about the codec itself. This
matrix records, for each server-side delivery path, whether it makes that
promise, whether a gap can be answered, and what happens when it cannot.

**Read the third column carefully.** Several paths deliberately make no
monotonic promise. That is a design position, not an omission, and each one
below states what re-establishes consistency instead. The failure this matrix
exists to surface is a path that *looks* sequenced but can apply a frame cleanly
after a missed one.

| Delivery path | Stamps a per-scope sequence | Gap answerable | Unrecoverable gap forces resync |
|---|---|---|---|
| Topic frames (`stampSeq` / `nextTopicSeq`) | Yes, per topic, when the lane opts in | Yes, from the resume buffer | Yes - truncation marker, then close 1013 |
| Resume / replay buffer (`handler/resume-buffer.js`) | Consumes the topic sequence | Yes, replays from the client's offset | **Yes - the reference implementation, see below** |
| Relay gap fill (`relay-ring.js`, `handler.js`) | Per-origin ordinal, dense by construction | Detected by contiguity, not by voting | Operator signal only, confirmed against a real subscriber - see finding F2 |
| Cluster fan-out (`handler/cluster-sequence-policy.js`) | Refuses the unsafe combination outright | n/a - a guard, not a stamper | n/a |
| Presence (`plugins/presence/server.js`) | No, `seq: false` by declaration | No - diffs carry no ordinal | Periodic full roster, **optional** - see F1 |
| Cursor (`plugins/cursor/codec.js`) | No - best-effort by declaration | No - a bad frame is dropped | No, and it does not need to - see below |
| Smooth (`plugins/smooth/codec.js`) | Deltas ordered; non-monotonic entries dropped | No | No - the JSON fallback cannot desync the decoder |
| Game framing (`handler/game-ingress.js`) | Yes - per-binding ingress counter inbound, authoritative room seq on fan-out | Yes, via the room sequence | Follows the topic path |

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
to protect a value that is corrected milliseconds later.

**Cluster fan-out** is a guard rather than a stamper, and its reasoning is worth
keeping in view: per-worker counters fork across a multi-origin relay, so a
clustered publish must declare `{ seq: false }` or `{ seq: <positive integer>,
relay: false }`. The module also documents a subtler hazard - a numeric seq
stamps every entry of a batch with the *same* number, so a client that received
only part of that batch reports the shared number as its watermark and the
resume dedup floor then discards the whole batch, including entries it never
received. That silent gap is precisely what the sequence lane exists to prevent.

## Findings

**F1 - presence reconvergence is optional, and nothing says so at the point of
opting out.** Presence publishes diffs with `seq: false`; what re-establishes
consistency is the periodic full roster heartbeat (default 30 s) plus the
client's `maxAge` sweep. Setting `heartbeat: 0` is documented as an opt-out for
"apps that do not use the `maxAge` self-healing path", but it also removes the
only periodic reconvergence for a *dropped diff*. After it, a missed join or
leave diverges silently until the client rejoins. The trade is real and may well
be the right default; what was missing is that the option's documentation framed
it purely as a bandwidth choice.

Measuring it made the finding bigger. The sweep has no counterpart that restores
an entry, so against a client on the default 90 s window a room where nobody
joins, leaves or updates empties itself about 135 s after the last diff, with
nothing dropped at all. The option is now documented on both sides as one
mechanism split across them, `createPresence` warns once naming the `maxAge: 0`
that completes the opt-out, and `test/presence-heartbeat-recovery.test.js`
holds the divergence as observed client state.

**F2 - a relay gap is reported to the operator, not to the affected clients.**
Detection is sound: per-origin contiguity over a stream dense by construction,
confirmed gaps drained once, `relay_gap_frames_total` incremented and
`runtime.relay-gap.detected` emitted at `error` severity with the topic, origin
worker and ordinal span. What happens to the clients on that worker was open
when this matrix was written, and is now measured rather than read: a real
subscriber on the receiving worker gets the frames that survived and nothing
else. No resync instruction, no close, connection still open after the hole is
confirmed. The delivered envelopes also step over the lost sequence, so the
client's own resume watermark advances past a frame it never held and a later
reconnect asks only for what follows it - the hole is not merely unannounced,
it is out of reach of the resume path that exists.

So the event's words hold as written: those clients are "missing events that
clients on other workers received, so they disagree about state", and nothing
on the wire says so. That is a documented limit rather than a defect in
detection, and the argument for leaving it there is blast radius: a gap is
per-topic and per-origin, so "resync everyone on this worker" is far wider than
the loss, while "resync the subscribers of the affected topics" needs a
per-topic subscriber walk on a path that fires when the worker is already
behind. `test/relay-receive-real.test.js` pins the current answer, so a future
signal changes a failing assertion rather than passing unnoticed.

**F3 - the relay-gap emitter duplicates the registry rather than deriving from
it.** `error-registry.js` declares `ADAPTER-ERR-RELAY-GAP` with a component,
event, severity and message; `handler.js` emits the same four values as inline
literals and never references `ADAPTER_ERROR_IDS.RELAY_GAP`. They agree today.
Nothing keeps them agreeing.

## What this matrix does not yet carry

Regression tests per path, driving the built fixture with a real ws client and
asserting the gap-fill frames or the explicit resync signal **as the client
receives them**. Three paths now have that: the resume path's escalation
(existing tests), the relay-gap path (F2, which had to be driven to answer the
question at all), and presence with its heartbeat off (F1). The remaining rows
are read off the source, so treat their "Yes" as a claim about the code as
written rather than as observed client behaviour - which is the same distinction
that makes this matrix worth having.
