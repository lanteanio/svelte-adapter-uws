# Architecture decision index

These accepted decisions define cross-package boundaries that are easy to
break when a feature is viewed from only one repository. Each decision names
the consequence and the evidence that must change before it is revisited.

| Decision | Scope |
|---|---|
| [Protocol compatibility](./protocol-compatibility.md) | Capability negotiation, JSON fallback, and wire evolution |
| [Native runtime baseline](./native-runtime-baseline.md) | Node, native addon, platform, and development fallback |
| [Cluster fan-out boundaries](./cluster-fanout-boundaries.md) | One worker, worker-thread relay, and cross-instance buses |
| [Persistence boundary](./persistence-boundary.md) | In-memory defaults, durable extensions, and application data |
| [Release coupling](./release-coupling.md) | Verification, promotion, and rollback order |
| [Memory-pressure signal basis](./memory-pressure-signal.md) | Engine walls, container walls, and degradation to silence |
| [Documentation canonicality](./documentation-canonicality.md) | Normative package contracts and site-owned explanations |

The [ecosystem architecture](../architecture.md) is the context map for these
decisions. [`PROTOCOL.md`](../../PROTOCOL.md) remains the detailed wire
contract and wire-design record.
