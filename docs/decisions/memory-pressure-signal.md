# Memory-pressure signal basis

Status: Accepted.

## Context

The adapter family shares one pressure surface: a `MEMORY` reason with top
precedence, a 0..1 saturation value, and a `memoryHeapUsedRatio` threshold
defaulting to 0.85. The original sample, `heapUsed/heapTotal`, measures how
full the engine keeps its arena - a V8-shaped quantity. V8 over-allocates,
so the ratio loosely tracks headroom; JavaScriptCore keeps `heapTotal`
fitted to usage, so on Bun the ratio sits at 0.90-0.94 on an idle server and
falls under allocation as the arena grows. Even on V8 the arena reading
fires on idle processes (60-90% full of a small heap) and misses the
container kill entirely: the kernel's OOM killer charges the resident set
against the cgroup limit, which no heap ratio sees.

## Decision

The family memory-pressure sample is distance to the nearest memory wall:
the worst of two arms, each measured with the quantity its wall kills on.

- The engine arm: `heapUsed` against the engine's reported allocation
  ceiling (V8: `v8.getHeapStatistics().heap_size_limit`). An engine that
  reports no ceiling (JavaScriptCore) contributes nothing on this arm.
- The container arm: the resident set against the cgroup memory limit,
  discovered at the cgroup root and, where `/proc/self/cgroup` names a
  deeper visible path, along the process's own group ancestry (v2
  `memory.max`, v1 `memory.limit_in_bytes`; `max` and the v1 unlimited
  sentinel mean no wall).

Idle reads near zero on every engine, and the reading approaches 1 as the
worker approaches whichever out-of-memory death is nearest. A process with
no discoverable wall on either arm reports 0 rather than a fabricated
signal - the signal degrades to silence, never to a false alarm - and PSI
memory pressure plus `resident_memory_bytes` carry the native-growth story
there. The `memoryHeapUsedRatio` option name and its 0.85 default are
shared across the family, every signal stays disableable with `false`, and
the same reading feeds the `MEMORY` reason, the `value` fold, the
`heap_used_ratio` gauge, and send-gate window sizing, so no consumer is
calibrated to a different basis. Arena fullness (`heapUsed/heapTotal`) is
not part of the contract on any engine.

This repository's implementation is `src/runtime/utils/memory-wall.js`; the
sibling adapter implements the same contract on its runtime's primitives.

## Consequences

- A sleeping server reads a few percent on both runtimes, so the first real
  elevated reading is believable.
- Bun deployments get a meaningful default signal (the container arm in any
  limited container) instead of a permanently-firing one, with no
  per-runtime threshold divergence.
- A container-limited process is warned before the resident-set kill, which
  a heap ratio could never see.
- Send-gate windows narrow near a real wall instead of on idle arena
  fullness, on both runtimes.

Revisit when an engine ships a portable allocation-ceiling API, or the
family adds a runtime whose container visibility differs from the cgroup
model above.
