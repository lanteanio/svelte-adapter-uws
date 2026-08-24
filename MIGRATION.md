# Migration index

[README](./README.md) | [wire protocol](./PROTOCOL.md) |
[protocol schema](./protocol.schema.json) | [test vectors](./test-vectors/README.md) |
[current release](./docs/releases/0.6.0-next.93.md) |
[release history](./CHANGELOG.md)

This stable URL is the permanent entry point for adapter migrations. Versioned
guides do not move when a newer transition becomes current.

## Version selection

<!-- compatibility-migration:start -->
For the archived [0.4.x to 0.5.x guide](./docs/migrations/0.4-to-0.5.md), pin `svelte-adapter-uws@0.5.8`. The `@latest` and `@next` dist-tags move as releases are promoted; `@next` currently follows the `0.6.0-next` prerelease line. The active [0.5.x to 0.6.x guide](./docs/migrations/0.5-to-0.6.md) follows that prerelease line. See the generated compatibility table in the [README](./README.md#version-compatibility) before choosing a dist-tag.
<!-- compatibility-migration:end -->

## Migration paths

| From  | To    | Lifecycle                                   | Guide                                             |
| ----- | ----- | ------------------------------------------- | ------------------------------------------------- |
| 0.5.x | 0.6.x | Active prerelease transition                | [0.5.x to 0.6.x](./docs/migrations/0.5-to-0.6.md) |
| 0.4.x | 0.5.x | Archived; factual and link corrections only | [0.4.x to 0.5.x](./docs/migrations/0.4-to-0.5.md) |

For upgrades spanning all three packages, follow the permanent
[ecosystem 0.5-to-0.6 sequence](./docs/migrations/ecosystem-0.5-to-0.6.md).

## URL lifecycle

- `MIGRATION.md` remains the stable index.
- Files under `docs/migrations/` are immutable version-addressed routes; a new
  transition adds a file instead of replacing an older guide.
- Archived guides may receive factual, security, or broken-link corrections,
  but their transition scope never changes.

## Legacy deep-link compatibility

The former generic guide exposed the anchors below. Each id stays on this index
and points to the same section at its permanent archived URL, so saved links do
not degrade into an unrelated current-transition page.

- <a id="migration-guide-svelte-adapter-uws-04x-to-05x"></a>[0.4.x to 0.5.x guide](./docs/migrations/0.4-to-0.5.md#migration-guide-svelte-adapter-uws-04x-to-05x)
- <a id="critical-read-first"></a>[Critical (read first)](./docs/migrations/0.4-to-0.5.md#critical-read-first)
- <a id="async-subscribe--subscribebatch-hooks-now-fail-closed"></a>[Async subscribe hooks](./docs/migrations/0.4-to-0.5.md#async-subscribe--subscribebatch-hooks-now-fail-closed)
- <a id="wire-level-subscribes-to--prefixed-system-topics-blocked-by-default"></a><a id="wire-level-subscribes-to-__-prefixed-system-topics-blocked-by-default"></a>[System-topic subscribe policy](./docs/migrations/0.4-to-0.5.md#wire-level-subscribes-to-__-prefixed-system-topics-blocked-by-default)
- <a id="ssr-dedup-cache-key-includes-baseorigin-cross-tenant-leak-fix"></a><a id="ssr-dedup-cache-key-includes-base_origin-cross-tenant-leak-fix"></a>[SSR dedup origin fix](./docs/migrations/0.4-to-0.5.md#ssr-dedup-cache-key-includes-base_origin-cross-tenant-leak-fix)
- <a id="replay-plugin-checks-subscribe-authorization-before-reading-a-topics-buffer"></a>[Replay authorization](./docs/migrations/0.4-to-0.5.md#replay-plugin-checks-subscribe-authorization-before-reading-a-topics-buffer)
- <a id="resume-hook-now-awaited-before-the-resumed-ack-frame"></a>[Awaited resume hook](./docs/migrations/0.4-to-0.5.md#resume-hook-now-awaited-before-the-resumed-ack-frame)
- <a id="required-source-changes"></a>[Required source changes](./docs/migrations/0.4-to-0.5.md#required-source-changes)
- <a id="runtime-nodejs-22-required-was-node-20"></a>[Node.js 22 requirement](./docs/migrations/0.4-to-0.5.md#runtime-nodejs-22-required-was-node-20)
- <a id="refuse-to-start-on-same-origin-policy-without-host-pin"></a>[Same-origin host pin](./docs/migrations/0.4-to-0.5.md#refuse-to-start-on-same-origin-policy-without-host-pin)
- <a id="platformsubscribe-and-platformchecksubscribe-are-now-async"></a>[Async platform subscriptions](./docs/migrations/0.4-to-0.5.md#platformsubscribe-and-platformchecksubscribe-are-now-async)
- <a id="cookie-path--domain-attribute-injection-blocked-in-serializecookie"></a>[Cookie attribute validation](./docs/migrations/0.4-to-0.5.md#cookie-path--domain-attribute-injection-blocked-in-serializecookie)
- <a id="parseasbytes-rejects-negative-and-non-finite-values"></a><a id="parse_as_bytes-rejects-negative-and-non-finite-values"></a>[Byte-limit parsing](./docs/migrations/0.4-to-0.5.md#parse_as_bytes-rejects-negative-and-non-finite-values)
- <a id="notable-defaults-and-behaviors"></a>[Notable defaults and behaviors](./docs/migrations/0.4-to-0.5.md#notable-defaults-and-behaviors)
- <a id="default-maxpayloadlength-raised-from-16-kb-to-1-mb"></a>[Payload default](./docs/migrations/0.4-to-0.5.md#default-maxpayloadlength-raised-from-16-kb-to-1-mb)
- <a id="wsauth-post-requires-origin--x-requested-with--sec-fetch-site"></a><a id="__wsauth-post-requires-origin--x-requested-with--sec-fetch-site"></a>[Auth POST origin policy](./docs/migrations/0.4-to-0.5.md#__wsauth-post-requires-origin--x-requested-with--sec-fetch-site)
- <a id="dynamic-compression-skipped-for-credentialed-responses-breach-defense"></a>[Credentialed compression](./docs/migrations/0.4-to-0.5.md#dynamic-compression-skipped-for-credentialed-responses-breach-defense)
- <a id="wire-topic-accept-set-tightened-to-printable-ascii"></a>[Wire-topic accept set](./docs/migrations/0.4-to-0.5.md#wire-topic-accept-set-tightened-to-printable-ascii)
- <a id="isvalidwiretopic-rejects--and-"></a>[Wire-topic quote and slash rejection](./docs/migrations/0.4-to-0.5.md#isvalidwiretopic-rejects--and-)
- <a id="client-status-store-expanded-to-a-five-state-machine"></a>[Client status states](./docs/migrations/0.4-to-0.5.md#client-status-store-expanded-to-a-five-state-machine)
- <a id="presence-plugin-wire-format-switched-to-a-compact-diff-protocol"></a>[Presence diff protocol](./docs/migrations/0.4-to-0.5.md#presence-plugin-wire-format-switched-to-a-compact-diff-protocol)
- <a id="wire-single-subscribe-frames-consult-subscribebatch-when-only-subscribebatch-is-exported"></a>[Single-to-batch subscribe policy](./docs/migrations/0.4-to-0.5.md#wire-single-subscribe-frames-consult-subscribebatch-when-only-subscribebatch-is-exported)
- <a id="initial-mount-client-subscribes-are-microtask-batched"></a>[Initial subscribe batching](./docs/migrations/0.4-to-0.5.md#initial-mount-client-subscribes-are-microtask-batched)
- <a id="dev-plugin-enforces-allowedorigins-on-the-wss-upgrade"></a>[Dev origin enforcement](./docs/migrations/0.4-to-0.5.md#dev-plugin-enforces-allowedorigins-on-the-wss-upgrade)
- <a id="bounded-by-default-capacity-caps-across-the-adapter-and-bundled-plugins"></a>[Capacity caps](./docs/migrations/0.4-to-0.5.md#bounded-by-default-capacity-caps-across-the-adapter-and-bundled-plugins)
- <a id="queue-plugin-maxsize-default-changed-from-infinity-to-1000000"></a>[Queue size default](./docs/migrations/0.4-to-0.5.md#queue-plugin-maxsize-default-changed-from-infinity-to-1000000)
- <a id="lockclear-rejects-pending-waiters-with-lockcleared"></a><a id="lockclear-rejects-pending-waiters-with-lock_cleared"></a>[Lock clear behavior](./docs/migrations/0.4-to-0.5.md#lockclear-rejects-pending-waiters-with-lock_cleared)
- <a id="lockwithlock-accepts-maxwaitms-and-rejects-with-locktimeout"></a><a id="lockwithlock-accepts-maxwaitms-and-rejects-with-lock_timeout"></a>[Lock wait timeout](./docs/migrations/0.4-to-0.5.md#lockwithlock-accepts-maxwaitms-and-rejects-with-lock_timeout)
- <a id="start-is-now-async-init--shutdown-lifecycle-hooks-supported"></a>[Async lifecycle hooks](./docs/migrations/0.4-to-0.5.md#start-is-now-async-init--shutdown-lifecycle-hooks-supported)
- <a id="per-event-coalescekey-collapses-duplicates-in-publishbatched"></a>[Per-event coalescing](./docs/migrations/0.4-to-0.5.md#per-event-coalescekey-collapses-duplicates-in-publishbatched)
- <a id="x-no-dedup-header-is-no-longer-consulted"></a>[Dedup header removal](./docs/migrations/0.4-to-0.5.md#x-no-dedup-header-is-no-longer-consulted)
- <a id="recommended-new-patterns"></a>[Recommended patterns](./docs/migrations/0.4-to-0.5.md#recommended-new-patterns)
- <a id="use-init-platform---shutdown-platform--for-once-per-worker-setup"></a>[Worker lifecycle setup](./docs/migrations/0.4-to-0.5.md#use-init-platform---shutdown-platform--for-once-per-worker-setup)
- <a id="cosmetic"></a>[Cosmetic changes](./docs/migrations/0.4-to-0.5.md#cosmetic)
- <a id="parsecookies-returns-a-null-prototype-object"></a>[Cookie object prototype](./docs/migrations/0.4-to-0.5.md#parsecookies-returns-a-null-prototype-object)
- <a id="per-connection-adapter-scratch-state-moved-to-symbol-keyed-slots"></a>[Symbol-keyed connection state](./docs/migrations/0.4-to-0.5.md#per-connection-adapter-scratch-state-moved-to-symbol-keyed-slots)
- <a id="after-upgrading"></a>[After upgrading](./docs/migrations/0.4-to-0.5.md#after-upgrading)
