# Cluster fan-out boundaries

Status: Accepted.

## Context

One worker, several worker threads in one runtime, and several processes or
hosts have different communication and ordering authorities. Calling all
three "clustered" hides where a message can actually travel.

## Decision

The adapter owns local delivery and fan-out among its worker threads. An
extensions bus or application-provided equivalent owns fan-out between
processes or hosts. Socket ownership remains local in every topology.

Each event has one fan-out authority per boundary. A message arriving from an
external bus suppresses a second outward relay where the integration contract
requires it. A global ordered sequence also has one allocator; built-in
implicit topic counters are not presented as globally ordered across multiple
I/O workers.

## Consequences

- Multi-worker deployment does not require Redis for worker-to-worker fan-out.
- Multi-instance deployment does require an external bus for cross-instance
  delivery.
- Wiring a bus does not distribute every in-memory plugin or application map.
- A topology that cannot uphold an advertised sequence or single-home
  invariant fails closed rather than delivering a partial success.

Revisit when a new transport supplies a proven shared ordering and delivery
authority across these boundaries.
