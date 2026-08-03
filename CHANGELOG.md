# Changelog

All notable changes to `svelte-adapter-uws` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0-next.91] - 2026-08-01

<!-- consumer-release-summary:start -->
### Consumer summary

- **Added: verifiable package and operations contracts.** Structured compatibility, migration, protocol, observability, contribution, security, and release surfaces now ship with executable drift checks, giving consumers one route to supported version tuples, production signals, incident guidance, and upgrade evidence instead of requiring source-code or CI archaeology.
  - **Affects:** Package consumers, operators, contributors, and release maintainers.
  - **Action:** Start from the README documentation map and select one complete generated compatibility row before installing or upgrading.
  - **Requires:** No runtime option; operators must supply the deployment-specific alert, runbook, and release evidence named by the contracts.
  - **Compatibility:** Additive documentation and verification surfaces; existing runtime imports remain available.
  - **Detail:** [Added engineering detail](#added).

- **Added: transport and performance evidence.** The WebTransport stream candidate, deterministic I/O budgets, cross-repository head checks, and benchmark or claim registers now state exactly what is frozen or measured, allowing adopters to distinguish protocol experiments and regression budgets from production transport availability or universal performance promises.
  - **Affects:** Teams evaluating the prerelease transport, throughput, allocation, or cross-package claims.
  - **Action:** Keep WebSocket as the permanent JavaScript runtime default, leave the WebTransport negotiation/fallback client lane unscheduled, and reproduce the workload-specific evidence before using a number as a deployment budget.
  - **Requires:** The recorded toolchain and fixtures for any cited benchmark or cross-repository result.
  - **Compatibility:** Additive evidence and a protocol freeze candidate; no JavaScript WebTransport server path or client negotiation ladder is enabled.
  - **Detail:** [Added engineering detail](#added).

- **Changed: presence and cursor projection defaults.** Connections now expose only the configured dedup key for presence and an own id for cursors unless an application supplies `select`, preventing accidental profile-field publication while preserving explicit projection policies and trusted server-side updates.
  - **Affects:** Applications that previously relied on implicit names, avatars, colors, roles, or other profile fields in presence or cursor payloads.
  - **Action:** Add an explicit `select` callback containing only the public display fields each client needs.
  - **Requires:** The selected identity value must be a string or finite number.
  - **Compatibility:** Intentional breaking default for implicit profile projection; explicit selectors retain their application-owned behavior.
  - **Detail:** [Changed engineering detail](#changed).

- **Fixed: realtime delivery and lifecycle boundaries.** The adapter now rejects unsafe multi-worker sequence and game-relay modes, enforces the advertised development payload ceiling, counts exact backpressure drops, closes Rollup handles, and balances logical subscriptions, turning silent divergence, oversized development frames, stale build resources, and misleading loss telemetry into explicit bounded behavior.
  - **Affects:** Clustered realtime deployments, Vite WebSocket development, programmatic builds, and pressure monitoring.
  - **Action:** Configure an external ordered sequence or single-worker game lane where required, and align any custom development payload ceiling with production.
  - **Requires:** Existing cluster and payload options; no new dependency.
  - **Compatibility:** Invalid multi-worker modes now fail closed, while valid single-worker and explicitly ordered deployments keep their public APIs.
  - **Detail:** [Fixed engineering detail](#fixed).

- **Fixed: public contracts and verification coverage.** Strict consumer types, clean native-addon acquisition, repository-wide link checks, complete worker metrics, fresh optional-pressure samples, exact metric-contract parity, and hardened policy oracles now fail at the owned boundary, so missing or incompatible binaries, documentation drift, and observability regressions surface before publication instead of after installation.
  - **Affects:** Server installers, strict TypeScript consumers, metric collectors, documentation maintainers, and policy-gate contributors.
  - **Action:** Use the matched HTTPS native-addon archive from the generated compatibility row, then rerun the normal static and unit gates after changing public declarations, metrics, links, compatibility, or subscription policy.
  - **Requires:** Node 22 or newer and a published binary for the current Node ABI, CPU, OS, and, on Linux, glibc 2.38 or newer; no runtime API migration.
  - **Compatibility:** Clean server installs fail earlier when the native addon is unavailable; other corrections tighten validation and stale-data behavior without renaming documented public signals.
  - **Detail:** [Fixed engineering detail](#fixed).

- **Changed: the over-capacity waiting room is an accessible, host-identified, localizable surface.** Built-in and custom capacity pages now meet one validated document baseline, carry optional host identity and light/dark theming, can be localized per request through a server renderer, and answer a browser navigation to the WebSocket path for every enabled admission ceiling.
  - **Affects:** Deployments that set any upgrade-admission ceiling, and any deployment shipping a custom `waitingRoom.template`.
  - **Action:** Extend a custom template to the documented accessible baseline before upgrading, because one that lacks a required element now fails the build instead of shipping.
  - **Requires:** Existing `upgradeAdmission` options; per-request localization additionally needs a server module path in `waitingRoom.renderer`.
  - **Compatibility:** Breaking for a non-conforming custom template; built-in pages, WebSocket handshakes, and non-HTML clients keep their previous responses.
  - **Detail:** [Changed engineering detail](#changed).

<!-- consumer-release-summary:end -->

### Added

- **Server-enforced established-message admission.** The opt-in
  `websocket.messageAdmission` gate bounds per-connection/global rate and
  concurrent application work across the app hook, binary ingress, and JSON
  game-publish lanes; retains at most `maxQueue` waiting frames; answers sheds
  with typed `message-overloaded` responses; and records the bounded
  `ws_message_admission_rejected_total{reason,scope}` counter; protocol control
  frames remain serviceable and the zero-limit default remains disabled.

- **Bounded cross-worker relay spill quarantine.** Shared-memory relay writers
  now retain at most 4 MiB or five seconds of producer spill per receiving
  worker by default. Crossing either finite ceiling closes that peer's ring and
  routes the lagging worker through the existing clean-exit/restart supervisor,
  so one stalled sibling cannot grow the primary without bound. The pending
  queue drains as an O(1) deque, the limits are configurable with
  `CLUSTER_RELAY_MAX_PENDING_KB` and `CLUSTER_RELAY_MAX_PENDING_MS`, and bounded
  metrics report quarantine reason, discarded pending bytes, and worst pending
  age without topic or client labels.

- **Finite whole-lifetime WebSocket connection admission.** The new opt-in
  `upgradeAdmission.maxConnections` ceiling is enforced per I/O worker across
  reserved upgrades and established sockets: a permit is acquired before
  per-request upgrade work, transferred across `res.upgrade()`, and released
  exactly once from the close lifecycle. Crossed attempts receive `503`, the
  waiting-room capacity probe observes both admission ceilings, and metrics
  expose `upgrade_rejected_total{reason="connection_capacity"}` plus the
  optional `ws_connection_headroom` gauge. `maxConcurrent` deliberately
  remains a handshake-only circuit breaker, so existing configurations and the
  unlimited default are unchanged; set the new non-negative safe integer when
  a deployment needs a finite per-worker live-socket bound.

- **Versioned production capacity launch gate.** A deployment-owned worksheet
  now pins expected peak, weighted traffic mix, latency/error SLO, release
  identity, environment, topology, backing stores, and autoscaling envelope.
  Its open-arrival runner schedules work independently of completions, reports
  achieved p50/p95/p99 and errors by phase and scenario, identifies the first
  configured resource threshold crossed under deliberate overload, and proves
  recovery under continuing traffic. The machine-readable v1 result fails
  closed on missing saturation/recovery evidence or injector drops, drain
  timeout, telemetry errors, and excessive scheduler lag; outputs are
  create-new artifacts outside the repository root rather than scratch files.

- **One deployer-facing privacy and retention contract across the ecosystem.**
  A versioned machine-readable inventory now reconciles browser, process,
  Redis, Postgres, telemetry, durable-work, and application-owned processing
  across all three packages. Its generated integration guide names exact
  default retention and erasure limitations, while a host-fillable RoPA, DPA,
  and transfer worksheet prevents a successful `live.forget` call from being
  mistaken for deletion from browsers, sinks, backups, or unregistered stores.
  The normal check rejects missing activities, vague retention, incomplete
  erasure boundaries, package omissions, or generated-document drift.

- **Correlated resource-control incident response.** The versioned operations
  pack now maps admission, protection posture, backpressure, host pressure,
  metrics degradation, Redis breakers, state divergence, client degradation,
  and recovery-wave load to safe actions, abort conditions, loss semantics, and
  explicit recovery proof. Its cold drill combines overload with Redis latency
  and rejects fleet restart, manual breaker reset, premature protection
  relaxation, or an unbounded reconnect/rehydration wave.

- **Explicit external recovery policies and a real-process drill.** Complete
  systemd and container examples now pair readiness gates with restart and
  termination-grace settings, making the supervisor dependency of fatal and
  wedged-worker exits operationally explicit. A dedicated Linux CI lane wedges
  a clustered worker through the built runtime, verifies the documented
  whole-process `SIGKILL` is respawned and ready, then kills the replacement
  primary and verifies readiness after a second external respawn.

- **Executable coordinated release and rollback procedure.** The versioned
  operations pack now includes an inclusive client/server protocol-range
  matrix with baseline, range expansion, client cutover, minimum cutover, and
  rollback outcomes. Its offline drill rejects an unsafe order or a missing
  typed-rejection posture, and the same runbook stages stable alarm ids before
  handler renames so retained work remains recoverable across mixed releases.

- **Versioned cold-start operations pack.** The shipped `docs/operations/v1`
  corpus provides one failure map and decision runbooks for process/drain and
  bad-release recovery, Redis relay outages, Postgres durable work, and
  replay/state divergence. Every runbook names ownership, loss semantics,
  abort criteria, procedures, recovery checks, and handoff evidence. The
  offline `npm run drill:operations` gate verifies the complete corpus and its
  local links before publication; the included cold drill rejects unsafe
  replay, queue clearing, breaker-reset-as-proof, uncoordinated package
  rollback, and readiness-triggered restarts.

- **Optional W3C distributed tracing across native and ecosystem work.** A
  top-level `tracing` module path bundles one vendor-neutral provider whose
  `startSpan()` may return an OpenTelemetry Span directly. The adapter
  validates `traceparent` / `tracestate`, isolates concurrent async contexts,
  spans SSR/static/admin, authentication, WebSocket admission/upgrade/message,
  and injects outbound webhook carriers. `platform.traceContext` and the
  frozen `platform.trace` surface let realtime, Redis/Postgres bus, and
  durable-work integrations continue the same operation. The provider is
  optional; without it native hot paths retain direct no-span branches. A
  configured module with no `startSpan` export now fails generated-server
  startup instead of silently disabling tracing.

- **One production operational-event sink across the realtime stack.**
  `svelte-adapter-uws/observability` now exports
  `setOperationalEventSink()` and `emitOperationalEvent()`. The
  process-wide sink receives structured adapter, extensions, and realtime
  records, defaults to canonical JSON console lines, and fails over to console
  if a custom sink throws or rejects. Listener, Vite, SSR, authentication,
  upgrade, and relay failures now use that path.

- **Externally supplied diagnostic values are structurally routable and
  bidirectionally safe.** Client subscription topics, relay-gap topics,
  Redis/Postgres channels and group names, RPC paths, correlation IDs, and
  error details now live in structured `attributes` under stable event
  identities instead of being interpolated into English console prose.
  Canonical physical lines visibly escape controls, bidirectional formatting
  characters, and non-ASCII text while preserving the exact attribute values
  for `parseDiagnostic()`.

- **One ecosystem translation boundary now separates machine identifiers from
  human prose.** English is the declared package source and diagnostic fallback
  locale, while applications own message keys, catalogs, formatting, escaping,
  and bidirectional isolation. A shipped registry classifies structured
  diagnostics, error references, denial and close reasons, waiting-room
  placeholders, protocol fields, and telemetry vocabulary so consumers do not
  parse or render unstable \`.message\` and \`.reason\` strings as UI contracts.

- **An accessible cursor composition, written in runes.** It
  pairs public names and deterministic shapes with color, exposes meaningful
  board locations in a navigable collaborator roster, announces only joins
  and leaves, and drives the same cursor update from pointer movement and
  focusable board controls. Canvas users get an explicit presentation-only
  boundary (the promoted canvas example is `aria-hidden` with a keyboard
  publish path) and a low-rate feed route for the semantic companion. Remote
  names, roster bursts, colors, and visual coordinates are bounded before
  rendering or announcement. The pure helpers ship in the package; the
  `.svelte` composition itself is repository-only (the library ships
  primitives, reference UI lives with the docs), reached from the README by
  its stable source route, and its compile gate runs under forced runes
  accepting no warning at all.

- **Honest integrated-onboarding contract.** The adapter front door now states
  that one process and port do not remove the native preflight, Vite plugin,
  WebSocket option, authentication, authorization, or production-build
  checkpoints. Ecosystem docs consume the coordinated candidate tuple and
  show one current configuration instead of a zero-config promise followed by
  contradictory setup steps.

- **Official ecosystem links are now an explicit trust contract.** The package front door and versioned architecture identify the GitHub owner, canonical documentation, hosted demo, and `svti.me` runtime-help role, including the permanent-redirect and domain-retirement policy.

- **Package-attributed structured diagnostics.** `svelte-adapter-uws/observability` now exports `formatDiagnostic`, `createDiagnostic`, and `parseDiagnostic`; canonical lines expose stable `source`, `component`, `event`, and `severity` routing fields before a versioned JSON record. Listener, Vite-handler, and framework-assertion emitters use that grammar. The parser also normalizes the previous adapter, extensions, and realtime prefixes during the documented migration window, so mixed-version collectors can move without a flag day.

- **The public first-success route now stops at an executable native prerequisite boundary.** The shipped `svelte-adapter-uws-preflight` binary checks Node, OS, CPU, Linux libc, and a real load of the pinned uWebSockets.js addon before configuration or build work begins. The freshly installed minimum Svelte profile runs the exact public command in CI before its type, build, HTTP, SSR-store, and WebSocket checkpoints.

- **A versioned ecosystem architecture and decision corpus now ships with the package.** It defines adapter, realtime, extensions, application, and documentation ownership; traces request and event flow through single-worker, worker-thread, and multi-instance topologies; assigns failure and persistence responsibility; records release order; and indexes accepted decisions for protocol compatibility, the native baseline, cluster fan-out, persistence, release coupling, and documentation canonicality. Focused tests and the repository link gate require every decision to remain packaged, indexed, and reachable from the public entry surface.

- The README entry surface now renders a bounded reader-path table from a
  packaged documentation manifest. Local identity, first-success, and
  compatibility routes are separated from the site-owned tutorial, how-to,
  reference, explanation, and operations routes; the normal check rejects
  route drift, an overgrown entry surface, or native-version facts copied
  outside the generated compatibility block.

- **Operator-facing failures now have a generated, searchable error reference.** Production and Vite runtime emissions are built from one owning registry and include a stable ID plus package-local help route. Each entry records cause, consequence, automatic recovery, next action, and every owning source; normal checks reject missing sources, registry drift, stale generated output, and release-channel-incompatible ecosystem links.

- Svelte 4 support now has an independently locked application profile with an
  exact Svelte, SvelteKit, Vite plugin, Vite, and type-checker tuple. CI installs
  it as a normal local package and runs type/store, production build, SSR/HTTP,
  and WebSocket round-trip checks; the public support row is generated from the
  same fixture metadata.
- Applications can now assign `Cache-Control` policies to versioned custom
  static paths with validated `staticCacheControl` exact-file and directory
  rules. Policies are resolved once during static indexing, preserve ETag,
  range, and compressed-representation correctness, and cannot override the
  adapter's built-in `/_app/immutable/` policy.
- A generated Public entry points catalog now assigns every export-map key a
  role, environment, stability, guide, and deprecation state, and the normal
  check rejects an unowned new subpath. Runnable homes now cover the standalone
  upgrade-response helper, CRDT binary client sink, and deterministic smooth
  random stream alongside the existing safe-URL and webhook guides.
- The README now opens with the reader outcome and immediate install, HTTP,
  and realtime paths; the project origin story lives in a later dedicated
  section.
- A packaged adapter claim register now requires visible
  Measured/Conditions/Reproduce or Guarantee/Requires/Verified evidence for
  consequential public copy. Current HTTP, WebSocket, batching, dedup,
  presence-compression, and cursor-codec figures were rerun and bounded; stale
  universal rankings, parity, zero-cost, and per-layer claims were withdrawn.
- WebSocket onboarding now puts the required Vite step and default-open
  authentication boundary beside setup, names WSS as TLS transport rather than
  complete security, and qualifies in-process dedup before its convenience
  examples. A copy-order gate rejects unbounded absolute wording in these
  decision surfaces.
- Cursor smoothing and prediction guidance now separates decisions, required
  actions, reasons, limits, mechanics, and evidence into rendered prose units
  of at most 80 words. The safety-critical authority, replay, health, snapping,
  and event-fan-out actions appear before their implementation mechanics, and a
  copy-structure gate prevents those jobs from collapsing together again.
- The newest release now opens with bounded consumer outcomes and ordered
  Affects/Action/Requires/Compatibility/Detail fields before the engineering
  log. A release-note gate enforces one sentence, 40-60 lead words, exact field
  order, visible source, category coverage, and valid detail routes while
  leaving immutable historical narratives untouched.
- Public API reference blocks can now be owned by declaration JSDoc and
  generated into bounded README regions. The first governed contract,
  `platform.publishBatched`, documents the cross-worker relay's key
  coalescing, cluster sequence authority, local fallback, and compression
  behavior (both relay shapes - fast path and per-event fallback - are
  stated by the later entry in this section); a blocking generator and real
  two-server parity test prevent either copy from drifting again.
- A packaged protocol-conformance index now joins the normative specification,
  schema, vectors, minimal Core client, reference surfaces, and executable CI
  proofs into one reciprocal task map. A repository-only benchmark index maps
  every performance claim and all 62 scripts to exact commands, environment
  requirements, reported outputs, and interpretation limits without adding
  development tooling to the npm tarball.
- A stable migration index now routes to permanent versioned 0.4-to-0.5 and
  0.5-to-0.6 guides plus an ordered three-package ecosystem upgrade page; old
  transitions are explicitly archived instead of masquerading as current.
- A dependency-free `svelte-adapter-uws/connection` production subpath exposes
  `connectionSessionId(ws)` without loading test helpers or publishing the
  adapter's internal user-data slot.
- **Transport RED telemetry now covers ordinary traffic, not only admission
  and sampled pressure.** Bounded-label counters and explicit seconds-valued
  histograms measure HTTP completion, WebSocket upgrade decisions, awaited
  inbound message handling, and connection lifetime. Every native TopicTree
  publish result is classified as delivered or no-subscribers without walking
  recipients. Histogram buckets, counts, and sums merge across workers and
  survive routine worker replacement with the same monotonicity as counters.
  Registries without the optional histogram factory retain counter coverage;
  with metrics disabled the original handlers are registered unchanged and
  publish sites perform only a null-hook check.
- **The reliable Lantean protocol now has a WebTransport bidirectional-stream
  freeze candidate.** A repeated `lantean-cap` CONNECT query declaration gates
  exactly one client-opened bidi stream; canonical unsigned-LEB128 lengths wrap
  byte-identical WebSocket messages, so welcome/hello, subscription, batch,
  lease, resume, and `0x03` codecs share their existing schemas and vectors.
  The binding settles FIN/session-close and QUIC-migration lifecycle, independent
  datagram membership, 1 MiB record and pending-byte bounds, slow-consumer
  reset posture, and four registered stream errors. Machine-readable schema
  constants plus a fragmented byte-exact transcript pin prefix, topology,
  capability, and rejection behavior pending independent freeze review.
- **Deterministic I/O budgets now gate hot paths on operation counts, never
  timings.** The normal suite pins HTTP cork/write counts, outbound frame
  allocation and copy counts, zero-copy inbound frame parsing, stateless
  encode-once fan-out, and one stateful batch frame per subscriber. Sixfold
  input and subscriber fixtures prove which counts must stay constant, and
  deliberately scaling and zero-work controls prove the detector can fail.
  Binary framing now exact-sizes its destination, reducing each outbound frame
  to one allocation and one codec-payload copy. Lower budgets are welcome;
  raising one requires a recorded design reason beside the changed number.
- **Primary docs now expose their companion surfaces.** README, migration,
  protocol, schema, vectors, source entry points, and stable GitHub release
  history are reachable as links instead of requiring package-source path
  knowledge. Companion documents link back to the primary entry points.
- **Documentation ownership is explicit.** A visible, versioned ownership table
  assigns adapter identity, installation, support status, and routing to the
  package README, and long-form ecosystem guides, searchable reference, and
  operations walkthroughs to the documentation site. The site is linked from
  both the top-level map and related projects. The contract permits only bare
  canonical Markdown links at those two route locations and rejects rendered
  style elements, stylesheet links, inline styles, rendered event handlers,
  raw scripts, browser-effective JavaScript URLs (including schemes split by
  encoded ASCII tab, line-feed, or carriage-return characters), iframe source
  documents, refresh redirects, and rendered base elements that rewrite
  relative companion routes, so hidden, inert,
  inaccessible, styled-away, retargeted, or non-canonical substitutes fail
  closed. A bounded owner, authority, home, stewardship, maintenance, and
  documentation-scope grammar permits active, passive, gerund, causal, colon,
  slash, parenthetical, and dash-separated restatements consistent with the
  table. It recognizes authority possession, stewardship, charge, residency,
  explicit assignment, joint ownership, and joint responsibility. Visible
  table rows, HTML cards, and split grids are evaluated as semantic containers,
  so an owner and scope cannot evade the contract by occupying adjacent
  elements. Package-qualified documentation compounds remain package scope in
  either word order, including guides to installation and support references.
  Mismatched, joint, or ambiguous ownership statements fail closed without
  claiming arbitrary natural-language understanding.
- **Compatibility data is packaged and generated.** A versioned CSV manifest
  (`docs/compatibility.v1.csv`) is the single source of truth for the legacy,
  stable, and prerelease ecosystem lines: sibling package series, install
  dist-tags, the Node floor, and the native addon pin. The README and
  MIGRATION.md compatibility blocks are generated from it byte-for-byte.
  Every published stable fact is digest-bound to the immutable
  `svelte-adapter-uws@0.5.8` npm identity, so its `v20.67.0` native pin stays
  truthful while the current prerelease validates independently against
  `v20.69.0`; the moving prerelease row is bound to the adapter's own
  lockstep release series and additionally cross-checked against sibling
  workspace checkouts whenever they are present. A hand-written compatibility
  table, moving dist-tag advice, or a manual install command anywhere else in
  the packaged documentation fails the gate, which classifies rendered
  Markdown and HTML rather than raw text, so encoded, quoted, wrapped,
  aliased, or visually hidden variants cannot introduce a second source of
  version truth. The gate runs first in `npm run check`, and publication runs
  that same fail-closed chain.
- **README navigation is executable documentation.** The table of contents now
  covers every major section and the public webhook, plugin, testing,
  simulation, and leak-harness entry points. A focused test fails when a new
  major section or one of those high-value subsections is no longer reachable
  from the table of contents.
- **A public security-reporting policy.** `SECURITY.md` names the supported
  stable and prerelease channels, routes vulnerability reports through
  GitHub's enabled private-advisory form, describes the evidence maintainers
  need, and avoids promising a response-time SLA the project cannot guarantee.
- **Pressure-reason transition telemetry.**
  `pressure_reason_transitions_total{from,to}` retains brief pressure
  incidents and recoveries that begin and end between scrapes. The bounded
  reason vocabulary keeps its label matrix finite, and the generated query
  sheet and runbook classify the new signal.
- **A versioned observability dashboard and executable Prometheus drill corpus.**
  The shipped Grafana dashboard preserves deployment-target labels. A
  digest-pinned official `promtool` CI lane parses and evaluates the shipped
  recording and alert expressions against low-volume math, per-target no-data,
  completeness, sampler-stall, down-target, and unrelated-target fixtures.
  Every raw and recorded selector is scoped to the adapter target label. Alert
  runbook links use a deployer-provided absolute base URL.
- **A public, versioned observability contract.** The exported
  `svelte-adapter-uws/observability` manifest declares the event/log envelope,
  levels, request and trace correlation fields, data classifications, bounded
  metric label and enum domains, worker/process aggregation, and explicit
  local-versus-snapshot no-data laws. `observability.md` and the query sheet
  are generated from that runtime manifest, and a reusable validator lets
  sibling packages reject partial schema copies.
- **A pinned cross-repository heads workflow.** It packs the adapter,
  extensions, and realtime repositories at recorded commits, installs their
  tarballs into disposable consumers on Linux and Windows, checks peer and
  public-type coherence, and overlays packed sibling heads into the component,
  browser, and database source trees before the existing cross-repo harness
  runs them. An adapter-owned direct `tsc` replay verifies every installed head
  byte-for-byte against its lock-integrity-pinned tarball, then attests the
  locked compiler tree, strict config, and generated import corpus. A separate
  direct corpus expands shipped wildcard export patterns to their concrete
  package files, so wildcard declarations are checked even though the sibling
  harness reports only its concrete export-key count. It compiles that corpus
  under Bundler ESM, NodeNext ESM, and NodeNext CJS and requires identical
  process results, covering standard `node`, `import`, `require`, `default`, and
  nested `types` declaration branches. The result
  is recorded in a closed evidence frame and reconciled with the harness's full
  provenance header and exact rung transcript. Only the
  exact pinned fingerprint of the known extensions type defect is non-blocking; any
  other type, pack, install, peer, harness, or
  missing-evidence failure still fails the workflow.
- **A public contribution and backlog contract.** Structured bug, feature, and
  usage-question forms, a pull-request evidence checklist, EditorConfig, and an executable
  contract test now expose the rules before review. `CONTRIBUTING.md` defines
  Ready and Done, risk-first priority, a provisional WIP limit, blocked and
  30-day review rules, curated good-first work, generated/lockfile handling,
  and the explicit no-CLA/no-DCO policy.
- **An explicit release, hotfix, abort and rollback contract.**
  `releasing.md` defines branch roles, freeze and promotion gates, immutable
  package-version Git tags, dependency-ordered ecosystem publication, stable
  hotfix merge-back, and dist-tag rollback. The append-only
  `release-manifest.md` starts with registry-verified stable and prerelease
  rollback identities; a contract test guards candidate identity continuity,
  channel-role routing, publication ordering, exact quarantine restoration,
  exactly one quarantine opening per published identity, forward-route denial
  after rollback across cleanup and every later public event kind, strictly
  increasing SemVer for ordinary and corrected public routes, downgrade-only
  rollback to a version previously routed on that channel, canonical npm SemVer
  without build-metadata aliases,
  canonical UTC instants, previously routed rollback targets, complete
  correction chains, row shape and uniqueness.

### Changed

- Moved `OBSERVABILITY.md`, `PRIVACY-INTEGRATION.md`, `RELEASE-MANIFEST.md`, `RELEASING.md` and `TRANSLATING.md` into `docs/` under the lowercase naming the rest of `docs/` already uses. The root keeps only what npm, GitHub, or a named package contract reads from there. The canonicality decision now states the placement rule and a test enforces it.
- **Client failure text is explicitly diagnostic.** Every non-null `failure`
  value now includes `diagnosticReason`; the former `reason` property remains
  as a deprecated byte-identical alias for the 0.6 compatibility window.
  Applications should map stable `class`, `kind`, `code`, and `status` fields
  to localized message keys instead of rendering external HTTP status text,
  browser WebSocket close text, or adapter fallback English.
- **Zero-config presence and cursor projection is now fail-closed.** Presence
  publishes only its configured dedup key by default, and cursor publishes only
  an own `id`; either value must be a string or finite number. Display names,
  avatars, colors, roles, profile data, and other fields now require an explicit
  `select`. An explicit selector remains an application-owned policy override
  and is not redacted. This is an intentional breaking change for applications
  that relied on implicit profile projection.
- **Wire presence updates now require an allowlist.** With
  `clientUpdateFields` omitted, client `presence-update` frames cannot add
  durable fields. Rejected fields are removed before nested reads,
  serialization, or depth traversal. Trusted server-side
  `presence.update()` calls retain their existing contract.

### Fixed

- **Diagnostic lines carry the family's public name.** The canonical
  structured log prefix is now `[lantean/diagnostic ...]` and the
  process-wide operational sink registers under
  `Symbol.for('lantean.operational-event-sink.v1')` - the Lantean protocol
  is the family identity every shipped document already defines, replacing
  an internal working label that no consumer could resolve. Sibling
  packages rename in lockstep on the same unreleased line. The attribution
  gate now also covers `console.log`/`console.info`, and every boot and
  lifecycle line carries the package prefix (the version banner is
  attributed by its own first token).
- **The tag-push release path can actually publish.** The release workflow
  ran the identity verifier before `npm ci`, and the verifier imports an
  installed dependency at module load - so every tag push died with a
  module-resolution error before any check ran. The install now precedes
  the verifier, the workflow checker holds a closed, ordered, unique-name
  step inventory (an interposed step between pack and publish is exactly
  where an artifact swap would live), the pack step's script body is
  matched whole rather than by substring (an added interior line is the
  other place that swap could hide), the event revision is bound to the
  annotated tag object or the checked-out HEAD, and a test spawns the
  verifier as a real process so a dead module graph can never again look
  like a green gate.
- **The test harness enforces the payload cap it reports.**
  `createTestServer` enforced a 64 KiB receiver limit on its real socket
  while `platform.maxPayloadLength` reported 1 MiB - the same
  report-versus-enforce split the production and Vite surfaces were fixed
  for. One value (a new `maxPayloadLength` option, defaulting to the
  production 1 MiB) now drives both, and a test proves the boundary against
  the real socket: a frame under the reported cap is delivered, a frame
  over it closes the connection. Guard messages for options that refuse
  zero now state the real floor.
- **The subscription-cap oracle closes its laundering routes.** A shipped
  module comparing the live subscription Set's size outside the canonical
  policy is now an offense repo-wide at any threshold (previously only the
  three wire surfaces were scanned and only the exact cap constant was
  matched elsewhere), the observer-lane predicate moved into the canonical
  policy module where exclusive export ownership and the shadow ban apply,
  and the shared plugin lane carries the same no-private-threshold rule.
- **Observer snapshots under strict wire authorization are documented as
  requiring the server grant** even when an application authorization hook
  exists - strict means both authorities, and the presence and cursor
  observer sections now say so instead of describing the permissive-hook
  model.
- **The observability pack can prove its alerts fire.** Every alert now has
  a positive firing case in the promtool corpus - previously 15 of the
  alerts appeared only in stay-silent assertions, which a rule that can
  never fire satisfies identically - and the isolation cases use foreign
  values that would fire each rule without its target matcher. Transport
  SLO series ship as recording rules (HTTP server-error ratio, WebSocket
  message error ratio, p95 latency overall and by method) with dashboard
  panels and disabled-by-default burn-rate alert templates. A new
  `AdapterTargetMissing` meta-alert pages when no scrape target carries the
  required `adapter` label, so a forgotten relabel surfaces as an alert
  instead of permanent silence. `AdapterBackpressureSustained` now fires on
  the backpressured share of connections and `AdapterWaitingRoomBacklog` on
  a sustained depth above ten, with tuning rationale in the runbook, and
  the generated histogram queries use the canonical target-preserving
  quantile form.
- **Dev handler failures keep their stack, and recovery keeps its word.**
  The structured Vite handler load/reload failure events are joined by the
  raw error on the dev console (the structured record deliberately bounds
  away the stack and source location a developer needs), recovery from an
  initial load failure now fires the user's `init` hook so the recovered
  event's no-action claim is true, the composed diagnostic line caps each
  field so the action can never be truncated away, and the dev-console help
  pointer is an absolute short link again instead of a repository-relative
  path a console cannot resolve.
- **The batched-publish contract states both relay shapes.** The canonical
  `publishBatched` documentation claimed the origin always sends one
  cross-worker frame; that holds only when the origin itself takes the fast
  path, and the fallback (a subscriber without the `batch` capability, or
  interested subscribers seeing different event slices) relays each
  surviving event individually. The declaration-owned block now states that
  the relay mirrors the origin's own path selection, a parity test drives
  the fallback branch end to end, and the generator refuses a README region
  marked generated whose id has no owning source block.
- **No-body HTTP responses are counted.** `res.endWithoutBody` is a terminal
  call - static assets answered to `HEAD`, bodyless SSR responses such as
  redirects, and empty admin replies complete through it - but the transport
  RED wrapper only instrumented `end`, `close`, and aborts, so that whole
  class of ordinary traffic was invisible to `http_requests_total` and
  `http_request_duration_seconds` while the transport read healthy. The
  wrapper now patches it like `end`, the unit mock carries the method so the
  omission is observable, and the real-runtime test drives a production
  static-asset `HEAD` (SSR pages carry a body even for `HEAD`) and asserts
  the counter moved.
- **A throwing pressure listener can no longer take the worker down.** The
  two listener-failure diagnostics carried an undeclared data class, so
  `createDiagnostic` threw a `TypeError` from inside a catch block on the
  1 Hz pressure timer - a documented `platform.onPressure` callback that
  threw crashed the process instead of producing one log line. The records
  now use the declared pseudonymous class with a bounded shared error
  classifier (name, code, message; never the stack), and the pipeline is
  hardened one layer down: `emitOperationalEvent` is total - an invalid
  record is dropped to a plain console line and an unserializable attribute
  falls back to the envelope - so telemetry can never turn the failure it
  reports into a crash. A static gate keeps every `dataClass` literal in the
  runtime inside the declared set.
- **Operational failures converge on the process sink.** The TLS swap,
  reload, and watch failures, the cluster metrics mirror/merge/primary
  paths, worker thread errors, the admin handler, the subscribe and
  subscribeBatch hooks, the resume hook, and the divergence detection signal
  now emit canonical structured events (console prose before), the relay-gap
  event pseudonymizes its topic like its pressure siblings, and the three
  duplicated per-file error classifiers were replaced by the shared bounded
  one.
- **`vite dev` mirrors production correlation and the platform surface.**
  The dev platform now carries `traceContext`, `trace`, and `diagnostic`
  (degrading to the same answers production gives when tracing or clustering
  is not configured), and the two adapter-owned dev 500s - authenticate and
  upgrade hook failures - echo `X-Request-ID` and emit the same structured
  events as production instead of dev-only prose.
- **Divergence detail is proven against the real cluster.** A real
  two-worker runtime with the state-hash reporter armed now drives the whole
  production round trip in tests - a forked stream, the aggregate detector,
  the primary's bounded per-worker collection over the thread boundary, the
  replicated store, and the `platform.diagnostic` lookup - and asserts no
  topic name survives into the evidence. The worker honors the primary's
  requested topic bound (capped by its own), and the primary's divergence
  signal uses the canonical diagnostic grammar.
- **The bundled plugins declare their own cluster sequence authority.** The
  multi-worker sequence guard on `platform.publish`/`publishWire` previously
  made cursor, presence, and groups throw on every broadcast in any clustered
  runtime, because those internal callers passed no options - and an
  application could not fix it, since the plugins own the options bag. All
  three now declare `{ seq: false }` (their state is re-established by
  snapshot, not by replaying missed frames), a real two-worker cluster test
  drives the groups plugin end to end to a client-delivered frame, and a
  static gate fails on any new plugin publish site that declares nothing. The
  in-memory replay buffer now refuses creation in a multi-worker runtime with
  the fix in the message - its history and counter are per-worker, so a
  cluster would serve divergent replay histories; the shared-backend replay
  in svelte-adapter-uws-extensions is the clustered form. The per-publish
  topology check is hoisted to a module constant, so the single-worker hot
  path pays one boolean read.
- **The game lane refuses compute workers, not just multi-I/O topologies.**
  `gameLaneClusterSafe` gated only on the I/O-worker count, so in the
  supported one-I/O-plus-compute topology a compute worker could run
  `publishGame` and sequence rooms into its own counters while fanning out to
  zero sockets - a second, silently-empty room sequencer forked from the real
  one. The gate now also checks the worker's role; a real cluster test boots
  the single-home fixture and proves the compute worker is denied while the
  socket-owning I/O worker still passes.
- **The authenticate cookie API can no longer fail open.** `createCookies`
  now requires the request URL instead of defaulting to `http://localhost`;
  the default computed `secure: false`, so a call site that dropped the
  argument silently produced session cookies without `Secure` and no test
  could tell. Relative cookie paths now resolve against the request URL
  before serialization, as SvelteKit resolves them (RFC 6265 clients discard
  a relative `Path` attribute), and a real-runtime test drives the
  production authenticate endpoint end to end, asserting the `Set-Cookie`
  header a client actually receives on localhost and non-localhost request
  URLs.
- **Consumers no longer download publisher-only tooling.** `markdown-it` and
  `semver` moved from production `dependencies` to `devDependencies`, and the
  compatibility checker script is no longer shipped in the package: it is
  publisher tooling that runs in the repository through `prepublishOnly`,
  and declaring its imports as production dependencies made every consumer
  install download the whole markdown-it tree for a gate only the publisher
  ever executes. `parse5` remains a production dependency
  because the runtime waiting-room template sanitizer imports it. Publication
  also no longer runs the compatibility gate twice, and the check-chain
  policy now accepts any repository script while still rejecting
  short-circuit shapes.
- **The pacing-queue metrics now reach cluster snapshots.**
  `upgrade_deferred_depth`, `upgrade_deferred_oldest_age_seconds`, and
  `upgrade_deferred_rejected_total` were registered and documented but missing
  from the signal manifest, so `platform.metricsSnapshot()` silently dropped
  them from every merged document while the README stated their cross-worker
  aggregation law. All three are declared now (`sum`, `max`, `sum`), and the
  exported `validateObservabilityContract` additionally enforces the unit and
  naming conventions and the aggregation-law legality rules that previously
  lived only in this repository's test suite, so sibling packages validating
  their own signals fail closed on a millisecond-valued name, an unknown law,
  or a summed process-scoped gauge.
- **Healthy workers now satisfy the metrics snapshot completeness gate.**
  `relay_spill_pending_age_seconds` was declared a required worker gauge but
  written only when a relay spill quarantine fired, so no healthy worker ever
  produced a complete report: `metrics_snapshot_workers_reporting` rendered
  `0` against the expected worker count in every deployment - including the
  zero-config single process - which fired the shipped alert pack out of the
  box and kept the healthy-zero counter and histogram families from ever
  rendering. The gauge is now written every sampler tick (an explicit `0`
  until the first quarantine, then the observed peak), and a real-runtime
  test boots the production build and asserts the merged document reports
  complete, non-degraded, with the zero families present.
- **Upgrade pacing now has bounded memory and bounded recovery work.**
  `upgradeAdmission.perTickBudget` no longer retains an unlimited array of
  response closures or drains it with front-removing `shift()`. Its O(1) FIFO
  ring retains at most `maxDeferred` callbacks per worker (default `1024`
  while pacing is enabled); overflow releases both admission permits and
  responds with `503 Service Unavailable`. Set `maxDeferred: 0` to retain no
  queue after the current tick budget. Live depth, oldest age, and rejection
  counts are exported as `upgrade_deferred_depth`,
  `upgrade_deferred_oldest_age_seconds`, and
  `upgrade_deferred_rejected_total`, with the shared rejection counter using
  reason `deferred_overflow`.
- **A hybrid subscribe hook can no longer replace a framework's tenant or room
  grant.** `authorizeWireSubscribe: 'strict'` and
  `platform.authorizeWireSubscribe('strict')` require both existing
  server-grant membership and an application-hook allow across single, batch,
  replay, resume, and observer lanes. The legacy boolean/no-argument policy is
  unchanged, strict arming cannot be downgraded, and realtime can feature-test
  the returned policy and fail startup instead of silently running open.
- **Cross-worker divergence signals now identify the affected stream without
  exposing topic names in logs.** The aggregate hash remains the normal path;
  only a proven mismatch triggers a bounded per-worker snapshot of
  process-lifetime HMAC stream ids and sequence maxima. The primary log carries
  one opaque diagnostic id, default introspection lists metadata only, and the
  exact record resolves through svelte-realtime's mandatory-auth, no-store
  admin endpoint. Tail sequence gaps carry a lower bound, while missing,
  truncated, or incomplete evidence remains explicitly inconclusive.

- **Default pressure and invariant logs no longer retain raw topics.** Topic
  cardinality and runaway-publisher diagnostics now carry a process-local
  keyed reference plus character/byte counts under `dataClass=pseudonymous`.
  Assertion contexts omit topic/event values, and debug publish lines use the
  same opaque references. `platform.onPublishRate()` still receives raw topics
  as an explicit application-owned observability surface.

- **Remote cursor smoothing now follows reduced-motion preferences.** The
  worker and main-thread canvas renderers watch the live
  `prefers-reduced-motion: reduce` query, suppress interpolated in-between
  frames while it matches, and reset sample history when the preference
  changes so stale motion cannot replay. The accessible cursor composition
  also includes an application-owned pause/hide control that leaves the board
  and collaborator roster available.

- **Owned failures now keep their correlation key.** SSR, authentication
  endpoint, and WebSocket upgrade-hook failures emit canonical diagnostics with
  the resolved request id and echo it as `X-Request-ID` on the adapter-owned
  `500`, so concurrent failures can be joined without exposing raw exceptions.

- **BREAKING: alternative capacity responses now preserve one accessible document baseline.** `waitingRoom: false` content-negotiates a minimal HTML `503` for browser navigation while leaving WebSocket and non-HTML clients byte-identical. Custom string templates and localized renderer output are parsed and validated for document language and direction, non-empty title/body, exposed main/status semantics, and an enabled named recovery control or safe link; comments and hidden/inert subtrees cannot impersonate the accessible tree. The public `AccessibleWaitingDocument` type and starter template make that contract reusable instead of accepting fragments as pages. A previously accepted plain branded template that lacks any required element now FAILS THE BUILD instead of shipping an inaccessible page; extend it to the documented baseline (the starter template is a compliant starting point). Document validation runs on the first rendered response per surface, not per request, so the overload route stays the cheap path. The template literal-brace escape is now the single atomic form `{{{{token}}}}` for a literal token; runs of closing braces (nested CSS, minified scripts) pass through verbatim, where the earlier independent `}}}}` escape silently corrupted them.

- **Waiting-room host identity and theming.** `waitingRoom` accepts optional escaped `appName`, `statusUrl`, `supportUrl` (both link fields render a relative URL or the `http`, `https`, `mailto` and `tel` schemes, and nothing else), and `incidentId` fields (whitespace-trimmed; absent fields render no empty UI), the built-in page themes through semantic `--waiting-room-*` custom properties with light defaults and `prefers-color-scheme` dark, carries no adapter branding, and the same four identity fields ride custom templates as escaped tokens.

- **Per-request waiting-room localization.** `waitingRoom.renderer` names a build-serializable server module whose synchronous `renderWaitingRoom` (or default) export receives the queue context plus a detached request snapshot and returns body, BCP 47 `lang`, `dir`, and optional extra headers; the adapter makes the metadata authoritative, emits `Content-Language` and `Vary: Accept-Language` on both navigation and rejection responses, rejects adapter-owned header overrides, and falls back once-logged to the built-in English document on any invalid output. A browser NAVIGATION to the WebSocket path itself now serves the same negotiated response for every enabled admission ceiling - including `perTickBudget` - whether the waiting room is on (holding page) or opted out (accessible `503`); previously an enabled waiting room sent navigations to the SSR catch-all.

- Every README fenced block now has a checked-in classification and content
  fingerprint. Normal and documentation verification compile standalone
  JavaScript, TypeScript, Svelte, JSON, and YAML examples, keep intentional
  fragments/configuration/output explicit, execute the packed runtime example,
  and report coverage by class and channel so an unreviewed fence cannot drift
  into publication.
- Waiting-room string templates now compile when the adapter is configured and
  reject unknown or unclosed `{{token}}` syntax with the supported-token list,
  instead of deploying typos as visible page text. Quadruple braces provide a
  documented literal-token escape, while repeated valid tokens remain valid.
- The WebSocket `authenticate` cookie API now matches SvelteKit's protective
  defaults: `HttpOnly`, `SameSite=Lax`, and `Secure` except on plain HTTP at
  `localhost`. Setters and deletions require an explicit `path`, the request
  URL drives the `Secure` decision in production and Vite, and only explicit
  `false` disables a protection.
- Clean installs now acquire uWebSockets.js from one exact HTTPS tag archive
  shared by package metadata, the compatibility manifest, generated install
  commands, and runtime recovery hints. The package postinstall hook imports the
  addon immediately and preserves the native loader cause, so missing binaries
  and Node ABI, CPU, OS, or libc mismatches fail during installation instead of
  surfacing at build time. Linux requires glibc >= 2.38 and musl remains
  unsupported. `SVELTE_ADAPTER_UWS_SKIP_NATIVE_CHECK=1` is the explicit escape
  hatch for intentional client-only installs; disabling lifecycle scripts has
  the same unverified result. The lockfile archive integrity and accepted
  per-file digests replace Git and SSH as both the acquisition path and byte
  identity.
- The public plugin-authorization example now constructs `createLock()` and
  invokes its `withLock()` method instead of importing a nonexistent named
  function. CI extracts that exact README fence, resolves its public subpath
  from an npm tarball, and executes the authorized path.
- Current `sv create` onboarding now configures the adapter through the
  generated `vite.config.ts` and direct `sveltekit({ adapter })` path, with the
  pre-2.62 two-file form explicitly scoped as legacy. A real fixture canary
  requires that consolidated form to produce `build/index.js` and serve its
  first HTTP response, preventing a green adapter-auto build with no runnable
  adapter output.
- WebSocket onboarding now promises and lists all four steps it actually
  presents, while capacity guidance describes failure-resistant defaults by
  their refusal and eviction behavior instead of labeling the reader.
- Fatal listener and degraded Vite handler diagnostics now state the immediate
  effect, retry behavior, recovery path, and operator action in both readable
  text and the canonical structured event envelope. Bind failures include host,
  port, bounded error fields, and `willRetry: false`; handler load/reload errors
  report HTTP and socket impact, and successful hot recovery emits `info`.
- Programmatic adapter builds now close their Rollup build handle after both a
  successful write and a failed write, so plugin cleanup hooks always run.
- Outbound backpressure loss is now counted from uWS's exact `dropped` callback,
  with per-window frame/byte fields and cumulative metrics; the bounded socket
  walk remains headroom telemetry instead of being treated as evidence of loss.
- The Vite dev WebSocket receiver now enforces its reported 1 MiB payload ceiling (or the configured flat `maxPayloadLength`) instead of silently inheriting `ws`'s 100 MiB default.
- Refuse per-worker implicit topic sequences and built-in-relayed numeric sequences in multi-worker runtimes, preserving the protocol's monotonic-per-connection guarantee.
- Refuse the single-home game relay lane when sockets span multiple I/O workers, preventing silent worker-local fan-out and divergent room sequencing.

- **The cross-surface subscribe oracle now follows the live subscription Set,
  not merely a descendant expression.** Cap calls must read `size` and
  `has(topic)` through the same exact `WS_SUBSCRIPTIONS` alias, and socket
  decision modules may not hand that Set or its size to an opaque helper. A
  three-surface differential reaches sizes 16 and 1,000,000 without allocating
  a million entries, pinning new-topic denial at the canonical boundary and
  admission for an already-held topic.
- **The public test-server declaration typechecks under strict consumers.** Its
  `primaryInit` option now has one authoritative `{ env }` signature instead of
  two conflicting interface members.
- **Ordinary Markdown links are checked across the whole owned surface.** The
  normal static gate now crawls every tracked and packaged Markdown document,
  including release policy, security guidance, observability docs, test
  vectors, and the changelog. Two stale historical links now resolve, and a
  Markdown-only pull request can no longer bypass the gate. Relative targets
  must remain inside the repository, use exact path casing, and be present in
  the actual npm dry-run inventory when their source document is packaged.
- **Cluster metrics no longer call an empty or partial worker complete.**
  Worker reports include a bounded registration inventory, required gauges need
  numeric samples, and restarted or partially initialized workers make snapshot
  completeness truthful instead of hiding behind a fresh sibling.
- **Optional pressure gauges no longer retain stale kernel values under a fresh
  sample timestamp.** PSI and cgroup read failures clear the live reading, and
  cgroup recovery starts from a fresh baseline. Availability is tri-state:
  transient registration or lazy first-tick errors remain retryable, while
  only confirmed missing kernel paths switch to the zero-cost disabled state.
- **Metric contract parity is exact rather than name-only.** Runtime factories,
  metric types, labels, help, units, scope, aggregation, origin, and formulas
  are checked bidirectionally against the manifest and public documentation.
  `metricsSnapshot()` is explicitly canonical and unprefixed; registry
  serialization remains allowed to apply an operator prefix.
- **Logical WebSocket subscriptions are accounted exactly once.** Wire,
  platform, and plugin-tracked membership now share one add/remove primitive;
  duplicate joins add zero, async revoke/unwind paths balance, and close removes
  only memberships still present. The live counter is clamped after a soft
  negative assertion so one mismatch cannot poison pressure decisions.
- **The shared subscribe-policy oracle now rejects copied policy modules,
  shadows in every binding position, parked or decorative calls, and
  statically dead padding.** Production differentials exercise real
  plugin-owned single and batch topics plus a revoke-during-hook race, and the
  built handler-resolution assertion follows the marked side-effect hook.
- Projection screening also recognizes `rawHeaders` transport containers,
  closing authorization and cookie-name variants without treating ordinary
  display fields as sensitive.

## [0.6.0-next.90] - 2026-08-01

### Fixed

- **`histogram` was in the registry contract and in no documentation.** `0.6.0-next.89` added
  `histogram(name, help, { labelNames, buckets })` to the `MetricsRegistry` type, while the
  paragraph introducing the `metrics` option still described the contract an operator
  implements as two positional factories - so the options form, and the fact that buckets can
  be passed at all, was discoverable only by reading the type declarations. `metrics` takes a
  registry the operator supplies, which makes every member of that interface something somebody
  has to implement against the README. All four methods are now documented in one table with
  their signatures, their return shapes and which two are optional, and the paragraph that
  described a two-method contract defers to it rather than restating half of it.
- **The bucket convention now says the part that bites.** Durations are seconds with fractional
  bucket bounds, so buckets starting at `1` put a 5 ms call and a 900 ms call in the same bucket
  and measure nothing - and `createMetrics()`, the registry this same section recommends,
  defaults to exactly those buckets. A seconds-valued histogram has to pass `buckets`
  explicitly. Samples already recorded into the wrong buckets cannot be repaired afterwards.
- **Nothing was gating any of that.** The metrics contract test asserted three-way parity for
  metric NAMES, so a method could join the registry interface without the README ever
  mentioning it. It now also asserts the interface and the README agree member for member,
  in both directions, including optionality and the documented signature - re-documenting
  `histogram` in the positional form is the drift that made buckets unreachable in the first
  place, and a name-only comparison cannot see it. The walk reads property-style members
  (`name?: (...) => ...`) as well as method syntax, and is pinned by a probe on the last member
  so a parser that stops halfway fails instead of passing vacuously.
- The `0.6.0-next.89` entry below said `metricsSnapshot()` collects each worker's _exposition
  text_, which its own next paragraph and the implementation both contradict: what crosses the
  thread boundary is recorded values, never rendered text. Corrected in place.

## [0.6.0-next.89] - 2026-07-31

### Added

- **`platform.metricsSnapshot()` - cluster-wide metrics.** Every worker thread builds its own
  registry and they all serve the same port, so a scrape route reading
  `platform.metrics.serialize()` returned whichever worker the kernel or the acceptor picked:
  counters appeared to jump backwards between scrapes, gauges aliased across workers, and
  every `rate()` over them was noise. There is no per-worker port to scrape instead. The new
  method collects every live worker's recorded values through the primary and merges them, each
  metric combining by its declared law. It merges in a single process too, so the document has
  the same shape whether or not clustering is on. Concurrent callers share one collection, so
  an unauthenticated scrape route cannot amplify into one cluster broadcast per request.
  What crosses the thread boundary is the values the adapter itself wrote, keyed by its own
  declared names - never a registry's rendered text, which would stop matching anything the
  moment a registry namespaced its output with `createMetrics({ prefix })` and would quietly
  go back to summing `open_fds` across workers. Metrics your app registered are therefore not
  in the snapshot: the adapter cannot know how yours should combine, and guessing would be a
  silent wrong number. `serialize()` is not required.
  Cluster counters do not decrease between consecutive documents, which takes three separate
  mechanisms because a summed counter can fall for three different reasons and only one of
  them is a restart. A worker that EXITS has its final counter totals carried forward, so a
  replacement starting at zero does not drop the sum. A LIVE worker that misses the collection
  deadline - a long synchronous stretch, a major collection - contributes its last known
  counter totals rather than dropping out; a per-worker counter never decreases, so re-using
  its previous total undercounts it for one scrape instead of erasing it. A DEGRADED document
  omits counter families entirely rather than publishing one worker's fraction of them,
  because a gap reads as staleness while a smaller value for a growing series reads as a
  counter reset. Only counters get this treatment - a gauge describes a live worker, so gauges
  do dip when one is missing, and `metrics_snapshot_workers_reporting` is what says so. The
  residual is one-directional: a total can lag reality by up to one collection interval of one
  worker's traffic, and never goes backwards.
- **A signal manifest** (`src/runtime/observability-manifest.js`) declaring every metric's type,
  labels, unit, scope and cross-worker aggregation law. The law is executed by the merge rather
  than described beside it - summing a process-wide reading like `open_fds` multiplies one truth
  by the worker count, which is the failure this replaces.
- **Twelve metrics the 1 Hz pressure sampler already computed and then discarded**:
  `ws_connections`, `ws_subscriptions`, `ws_publishes_total`, `pressure_saturation`,
  `pressure_reason`, `resident_memory_bytes`, `heap_used_ratio`,
  `pressure_sample_timestamp_seconds`, and, where the kernel exposes them,
  `psi_cpu_some_avg10`, `psi_memory_full_avg10`, `psi_io_full_avg10` and `cpu_throttled_ratio`.
  These are gauge writes inside a callback that already runs; no per-request or per-message
  path is touched.
- **`pressure_sample_timestamp_seconds`, the sampler's own freshness.** The sampling timer is
  `unref`'d; if it ever stopped, every sampled gauge kept serving its last value while the
  scrape target still reported up, and nothing distinguished healthy-and-steady from frozen.
  Alert on this timestamp's age.
- **`histogram()` in the `MetricsRegistry` contract**, with an explicit `buckets` option and a
  documented seconds-with-fractional-bounds unit convention. The adapter registers no histogram
  yet; the method is declared because a registry that omits it cannot be told what buckets to
  use, and a duration histogram with the wrong ones measures nothing.
- **Publish accounting as a counter, not a rate.** `ws_publishes_total` counts publish calls,
  never per-recipient deliveries - uWS fans out in C++, and counting recipients would mean
  walking the subscriber set in JS on every publish.
- **A shipped observability pack** at `examples/observability/`, which reaches consumers because
  `examples` is in the package `files` list. The adapter's metrics have non-obvious aggregation
  laws - `open_fds` is whole-process and must never be summed across workers, freshness is taken
  from the stalest worker, connections and subscriptions are exported separately because
  averaging per-worker ratios is not the cluster ratio. Shipping the queries is how those laws
  become executable rather than prose an adopter reads once and then writes the wrong query
  against.
  - `queries.md` - the canonical expression and cross-worker law for every metric, GENERATED from
    the signal manifest and regenerated by a test, so a new metric cannot ship without an entry.
  - `rules.yml` - Prometheus recording and alerting rules, including the derived quantities most
    often written wrongly by hand and a no-data rule.
  - `runbook.md` - what each alert means, what to check, and what not to do.
- **A coverage gate.** Every metric must either be referenced by a rule or named in the runbook's
  explicit no-alert list, and every alert must name a runbook section that exists. In a rules file
  "nobody thought about this metric" and "we decided not to alert on it" look identical; the list
  forces them apart. A test also fails if any shipped query sums a whole-process metric across
  workers, which would re-introduce the defect the cluster merge exists to remove.

No Grafana dashboard ships. Dashboard JSON is tied to a schema version and ages into a liability
faster than anything else in the pack, while `queries.md` carries every expression needed to build
one against whatever you run.

### Fixed

- **The two documented metric inventories had drifted from the code and from each other.** Six
  of fifteen registered metrics were missing from the `metrics` option's JSDoc list, four from
  the README table, and `relay_gap_frames_total` and `framework_resource_growth_suspected_total`
  were in neither. Both inventories are now complete, and the existing acorn-based metrics
  contract test asserts three-way parity between the code, the manifest and both documents, so
  they cannot drift apart again.
- `ws_subscriptions` and `ws_connections` are exported separately rather than as the sampler's
  precomputed subscriber ratio: averaging per-worker ratios is not the cluster ratio, while
  summing a numerator and a denominator is.
- **Two long-standing bugs that read `worker.threadId` inside the `exit` handler.** Node nulls
  the worker handle before emitting `exit`, so it reads `-1` there, and any cleanup keyed on the
  thread id addresses a worker that never existed. The cross-worker state-hash detector never
  dropped a dead worker from its open epoch buckets, where a stale entry could stall a
  comparison, and the restart log line reported `Worker thread -1 exited`. The id is now stamped
  into the worker's record at spawn and used for every id-keyed cleanup in that handler.
- A `metrics` module default-exporting a non-object (a string, a number) threw at module
  evaluation in every worker, with a message naming neither metrics nor the option that caused
  it. It now disables metrics and says so.

## [0.6.0-next.88] - 2026-07-31

### Breaking Changes

Each of these is detailed in the section below that owns it; this list is the upgrade
checklist.

- **A request repeating a single-valued header is now refused with `400 Bad Request`.** The
  affected names are `host`, `content-length`, `transfer-encoding`, `content-type`,
  `authorization`, `proxy-authorization` and `origin`. Previously the last line won silently.
  A WebSocket upgrade carrying one is refused the same way. Nothing well-behaved in front of
  the adapter emits these twice; a proxy that does was already producing a request this layer
  and the proxy disagreed about.
- **Every other repeated header now reaches the app merged rather than as the last line
  alone.** `event.request.headers` sees the joined value - `", "` for list-valued headers,
  `"; "` for `cookie`. An app that read a single hop out of `x-forwarded-for` behind a proxy
  emitting one line per hop now sees the whole chain, which is the point of the fix, but it
  is a value change on a surface apps read.
- **`SHUTDOWN_TIMEOUT=0` now means NO budget rather than no wait.** Zero previously aborted
  in-flight teardown immediately; it now awaits the `shutdown` hook and the
  `sveltekit:shutdown` listeners to completion with nothing cutting them off, and the hook
  receives `signal: null, deadline: null` so it can see that. An operator who set `0` to get
  a fast exit should set `1`. The default of `30` is unchanged.
- **The `groups` plugin caps membership at `1_000_000` by default, where it was unbounded.**
  The cap sits at the process connection ceiling, so it cannot bite a real group; it exists
  so an app that wires the group's `subscribe` hook without its `close` hook cannot pile up
  member entries forever. Opt out with `createGroup(name, { maxMembers: Infinity })`.
- **`CrdtAuthority.persistNow()` resolves to a `CrdtFlushResult` instead of `undefined`, and
  is now bounded.** Callers that await and ignore the value are unaffected; a TypeScript
  caller that annotated it `Promise<void>` must update the annotation. The flush is bounded
  by the new `flushTimeout` (default 10000 ms, chosen to sit inside the adapter's own 30 s
  shutdown grace); nothing is discarded on expiry - the record stays dirty and its retry
  keeps running. A store that legitimately exceeds 10 s needs a raised `flushTimeout`, a
  per-call `persistNow({ timeout })`, or `Infinity` for the old unbounded wait.
- **Each precompressed static representation now carries its own `ETag`.** Caches holding an
  entry under the previously shared validator revalidate once into a full `200`. Nothing is
  served incorrectly in the meantime, and the change is what stops a compressed response
  being validated against the uncompressed entity.
- **The built-in waiting-room page no longer claims a queue position or a wait estimate.**
  `You are in line`, `Ahead of you: N` and `Estimated wait: N seconds` are gone, because
  upgrade admission keeps no per-client identity, arrival order or reservation and so had no
  position to report. Operator pages written against the `{{queueDepth}}` and
  `{{estimatedSeconds}}` template tokens keep working with unchanged values.

### Added

- `upgrade_rejected_total{reason="duplicate_header"}` counts upgrades refused for an
  ambiguous repeated header. The documented reason list now also names `auth_rate_limit`,
  which the authentication preflight has always emitted on this counter, and says which
  rejections it does NOT cover: the preflight's own duplicate-header `400` is counted on no
  series.

- `hooks.ws` `shutdown` receives `{ platform, reason, signal, deadline }`: `reason` is the signal or
  message that started the shutdown, `signal` aborts when the shutdown budget is spent, and
  `deadline` is the wall-clock epoch milliseconds it expires at. `sveltekit:shutdown` listeners
  receive the same three as a second argument alongside the existing `reason`. The published type
  declares all four and states what the awaiting adapter actually guarantees - the three budget
  fields are typed optional because the `vite dev` plugin fires the hook with `platform` alone,
  a dev server having no budget to report.
- The reload path's health is readable as state, not only as log lines: watcher liveness, whether
  renewals are being picked up at all, per-worker reload generation (a generation skew across a fleet
  means one worker missed a renewal), failure count and timestamps, and the served certificate's
  expiry. No key material and no certificate bytes.
- `readCertIdentity` also returns the leaf's expiry, in both the certificate's own printed form and
  the epoch form the remaining-validity arithmetic needs.
- The built runtime's handler module re-exports the whole lifecycle surface - `beginDrain`,
  `lifecycleState` and `tlsReloadState` alongside the existing `start` / `shutdown` / `drain` - so a
  caller reads them from the module the runtime imports instead of reaching into a submodule and
  depending on the file split.

- The built-in waiting-room holding page now carries a persistent status region
  (`role="status" aria-live="polite" aria-atomic="true"`) that is present at
  first paint rather than injected on change, so a screen reader is told when
  the waiting count moves, when a capacity check fails, and when it recovers.
  Previously the page mutated two plain `<strong>` nodes and swallowed fetch
  failures entirely, leaving assistive tech with no programmatic status at all.
  Rewrites happen only when the composed line actually changes, and unforced
  rewrites no more often than once per 10 seconds, so a short `pollIntervalMs`
  cannot turn the region into a stream of near-identical announcements.
- A native `Pause live updates` button (an `aria-pressed` toggle) on the same
  page, which previously had no focusable element at all. While paused the page
  stops rewriting the status line and stops reloading itself, but it keeps
  polling on the same cadence: a poll that fails, recovers, or reports a new
  count while paused changes nothing on screen. The two things a paused page
  still says are the ones its own paused wording promises - that a slot has
  opened, offered as a `Reload now` button instead of a navigation, and that an
  offered slot was taken by somebody else before the visitor pressed it.
  Unpaused, the documented automatic reload is unchanged.
- Because the capacity check reports live capacity and reserves nothing, an
  offered slot can close again. The page keeps polling across an offer, so the
  offer is withdrawn and announced within one poll interval rather than leaving
  a visitor holding a `Reload now` button for a slot that is long gone. The
  button is only withdrawn when it does not hold focus: pulling the focused
  element out of the document mid-press is worse than an offer one interval
  stale, and pressing it then simply re-serves the holding page. The pause
  control likewise keeps its place throughout.
- The status region is never given `aria-live="off"`. Pausing controls which
  rewrites happen, not whether the region can speak, so the pause confirmation
  and the free-slot news still reach a screen reader.
- `button:focus-visible` styling on the page, which had no focus indicator.

- **`snapSpeedPerSec`, an absolute teleport ceiling, on `createSmoothChannel` options and on `smooth` for `cursor()`** (threaded to the cursor render worker as well as to the main-thread fallback). `'auto'`, the default, is the detection described above. A positive number adds an exact ceiling in world units per second on top, for a topic that knows its own scale; set it above anything the simulation can legitimately produce, since a ceiling below real motion snaps constantly. It is deliberately a speed and not a distance: a distance tuned for the steady cadence fires on every dropped frame, where an honest pair spans several intervals and covers several times the ground. `0` turns both the automatic test and the ceiling off and restores pure interpolation, for content whose motion genuinely arrives in isolated one-interval bursts.

- **Queue plugin: aggregate bounds.** `createQueue()` accepts `maxKeys`,
  `maxPendingTotal` and `maxRunningTotal` alongside the existing per-key
  `maxSize` and `concurrency`. `maxKeys` bounds how many keys hold live work,
  `maxPendingTotal` bounds waiting tasks summed across all keys, and
  `maxRunningTotal` bounds tasks in flight across all keys. All three accept
  `Infinity` to opt out, and all three default to `1_000_000` - high enough
  that they never bind in practice, so the zero-config path behaves exactly as
  it did before. They are ceilings that turn a runaway into a typed rejection,
  not working limits: a queue that should push back needs real numbers, and
  `maxRunningTotal` in particular has to be chosen rather than assumed, because
  a task that awaits work pushed later would deadlock under a low in-flight cap
  it never asked for.
- **Queue plugin: `queue.stats()`.** Snapshot of `keysCurrent`,
  `pendingCurrent`, `runningCurrent`, `readyCurrent` (keys waiting for a
  running slot), their peaks, `pushedTotal`, `completedTotal`, `failedTotal`,
  `clearedTotal`, `onDropErrorsTotal`, and a `dropped` breakdown counted per
  bound that tripped. The peaks are what tell you whether a bound needs
  raising.
- **Queue plugin: typed rejections.** Overload and cancellation errors now carry
  `err.code` (`QUEUE_FULL`, `QUEUE_TOO_MANY_KEYS`, `QUEUE_BACKLOG_FULL`,
  `QUEUE_CLEARED`), `err.key`, and the bound that tripped under its own option
  name, so a handler can shed to 503 without parsing messages. Exported as
  `QueueError` / `QueueErrorCode` / `QueueStats` types.
- **Queue plugin: `onDrop` reason.** The `onDrop` payload gained
  `reason: 'maxSize' | 'maxKeys' | 'maxPendingTotal'`, and now fires for every
  bound that sheds a task, not only `maxSize`.

- `createRateLimit({ onEvict })` - called once per eviction with `{ key, banned }`. `key` is the
  stored bucket key (`tenantId + '\0' + key` when a `tenant` resolver is set). `banned: true`
  means every sampled candidate was still serving a ban and enforcement state had to be dropped
  anyway, which is the case worth alerting on: it says the cap is too small for the number of
  bans in flight.
- `createRateLimit({ evictionSample })` - how many entries an eviction inspects before choosing
  a victim, default 16. The whole map is inspected when it holds fewer entries than this.

- **`plugins/webhooks` gains a first-attempt admission gate keyed by the PINNED DESTINATION ADDRESS,
  so an endpoint's outbound allowance stops being a product of how many things name it.** Until now
  the only rationed part of an outbound delivery was the retry: `hooks.budget` is consulted inside
  the retry loop and never before the first request, and it is scoped by the caller-chosen
  `hooks.key`. A scheduler that holds one registration per alias therefore gave the same endpoint one
  unrationed first attempt and one full retry bucket per entry, and the ceiling an operator
  configured came out multiplied by the number of entries (and again by the number of replicas
  holding them) - a `capacity: 3` budget admitted 30 retries across ten aliases of one endpoint, and
  one publish to 16 registrations issued 48 requests. `deliverWebhook`'s `hooks` seam now also
  accepts `hooks.admission`, consulted for exactly one hop per delivery - after the SSRF gate has
  resolved and pinned the destination, before any request is issued - and keyed on `<address>:<port>`
  rather than on `hooks.key` or on the URL. Keying on the URL (or its origin) would not have closed
  this: the caller picks the hostname too, so `127.0.0.1:8080`, `localhost:8080`, `localhost.:8080`
  and every name a wildcard-DNS record can mint are distinct URLs reaching one listener. A pinned
  address is the one part of a delivery the caller cannot rename, so registrations, aliases, path
  rewrites and per-event `url` callbacks that land on one address now draw on one allowance. The gate
  charges EVERY address in the pin rather than one chosen member of it, and that detail is what makes
  the ceiling hold: which member the socket lands on is decided by the connect logic (dual-stack, one
  address after another), and a caller who controls its DNS answer picks both the contents and the
  order of that set, so any single-member rule - lowest address, first address - names a bucket the
  caller can point away from the address the request actually reaches. Charging the whole set makes
  the choice moot: wherever the socket ends up, that address paid, and a resolver rotating its answer
  charges the same buckets because the set is sorted and deduplicated. Stated exactly, since the
  difference matters when sizing an outbound path: one endpoint published on several addresses
  (separate IPv4 and IPv6 literals, or DNS answers whose address sets differ) is several destinations,
  holds one allowance each, and a delivery to it spends one unit at each of them; a caller controlling
  its own DNS answer can therefore spend an unrelated address's allowance without sending it traffic
  (what no answer can do is reach an address without spending that address's unit); a refusal
  part-way through a set keeps the units already taken, since the interface only takes, so a refused
  delivery can cost more than it sent, never less; and the gate is per process, so a cluster
  multiplies by replica count until a shared implementation with the same `take(destination)`
  interface is injected through the same seam. The pin itself is now capped at 32 addresses (dropped
  after the whole answer has been range-checked, so a private address anywhere in it still rejects
  the delivery - the cap can only narrow where a socket may go), which bounds the buckets and the work
  one delivery can cost. `createWebhookAdmission({ capacity = 100, refillPerSec = 10,
maxKeys = 1024 })` ships as the in-process default, reading time only through the runtime seam so
  refill stays deterministic under a seeded harness. Its AGGREGATE ceiling is `maxKeys * capacity`
  admitted deliveries in a burst and `maxKeys * refillPerSec` per second sustained - 102,400 and
  10,240 on the defaults, and lowering `maxKeys` is how that is lowered. Those figures bound admitted
  DELIVERIES, not HTTP requests: one admitted delivery may still issue up to `retry.attempts` x
  (`maxRedirects` + 1) requests - 18 on the delivery defaults - so an outbound path carries that
  multiple of them. A refused delivery is
  terminal with `attempts: 0` and carries `WebhookAdmissionDeniedError`
  (`code: 'WEBHOOK_ADMISSION_DENIED'`), deliberately distinguishable from a delivery failure: nothing
  was sent and the endpoint said nothing, so a caller requeues rather than dead-letters, and the
  circuit breaker is not moved. The gate is consulted after the breaker (an already-ejected endpoint
  costs no tokens) and after the SSRF gate (a URL the guard rejects - an unparseable one, a `file:` /
  `data:` / `gopher:` scheme, a link-local metadata address - can never reach the network, so it must
  not cost a destination anything). A redirect hop is NOT charged: a redirect target is chosen by the
  endpoint being delivered to, so charging it would let anyone who can register a webhook drain a
  bystander's allowance by answering 302 to that bystander. The unmetered amplification that leaves
  is bounded by `maxRedirects` requests per admitted delivery, with the SSRF gate still running on
  every hop. Only a definite no from the gate (`false`, or the `0` a Lua-scripted shared backend
  replies with) refuses a delivery; a throw, or an implementation that answers with nothing, admits -
  a shared backend having a bad minute must not become an outbound outage. Fully opt-in and backward
  compatible: omit `hooks.admission` and delivery is byte-identical to before, first attempts
  unrationed as documented.

- **CRDT: `persist.store` and `persist.load` receive the context they run in.** `store` is
  now called as `store(topic, bytes, { signal, deadline, attempt })` and `load` as
  `load(topic, { signal })`: `signal` aborts when a flush deadline expires, when the topic is
  erased with `drop()`, or when the authority is destroyed, so a host can cancel its own
  query instead of writing into a torn-down authority; `deadline` is the epoch-ms reading at
  which the last flush waiting on that write stops waiting (`null` for a store the background
  schedule owns), sized for a statement timeout; `attempt` is 1 for the first store of the
  current unstored state and increments per consecutive write of that state that did not
  confirm, so a host can back off
  without tracking per-topic state. Existing two-argument hooks are unaffected. Honouring
  `signal` stays optional: an abandoned write is never read as durable either way, but a host
  that ignores it can see the rescheduled write overlap the abandoned one, so honouring it is
  how a host keeps a topic's writes strictly serialized.
- **CRDT: `flushTimeout` authority option and a per-call `persistNow(topic?, { timeout })`.**
  Milliseconds the explicit flush waits before reporting the rest as timed out; `Infinity`
  waits indefinitely. `persistNow({ timeout })` is accepted as the every-topic form.
- **CRDT: `destroy()` aborts the host I/O still in flight** rather than dropping the replicas
  and leaving the store and load calls running against nothing.

- **`groups`: read-only `group.maxMembers`.** Reports the resolved cap, including the default,
  so an app can show remaining slots or refuse a queued join without duplicating the option it
  passed to `createGroup()`.

- **`npm run check` now fails when any tracked file names a `uWebSockets.js#<ref>` install spec other than the `optionalDependencies` pin** (`scripts/check-uws-pin.js`, wired into the `check` chain and so into `pretest`). The addon is a GitHub-hosted native build pinned by tag, and because it is an OPTIONAL dependency npm says nothing when a different tag is fetched, so a stale install line in a doc, a snippet or a test harness silently sends people to a different binary than the one the adapter is built and tested against. That skew has now happened twice. The expected tag comes from `uwsInstallSpec()` in `src/uws-load-hint.js`, the same derivation the runtime install hints use, so the guard and the messages it protects cannot disagree about what the pin is.

  The guard only sees the copy-pasteable spec form (`uNetworking/uWebSockets.js#<tag>`), never a bare version named in prose, so `CHANGELOG.md` and `MIGRATION.md` keep describing past pin moves exactly as written - a guard that forced history to be rewritten on every bump would be worse than the drift. `CHANGELOG.md` is skipped whole as append-only history. Lockfiles are reported as a note rather than failing the build, since a stale one is corrected by rerunning `npm install` in that directory and never by editing it. A deliberately synthetic spec (a unit-test fixture, say) opts out with a `uws-pin-allow: <reason>` comment on its line.

- **`npm run doctor`** - one command that answers whether a green run on this
  machine proves anything. It checks the Node version against `engines` and
  against the baseline CI runs, whether the running npm is new enough to write
  the committed lockfile format (an older one rewrites the whole file on the
  next install), whether the platform/arch/libc has a prebuilt native binary at
  all, `git` on PATH (the addon is fetched with it), the root and fixture
  installs, whether a loopback listener can bind, and whether Playwright's
  browser is present. A missing native addon is a WARNING locally and a FAILURE
  under `--require-uws`, `REQUIRE_UWS=1` or `CI` - the rule the test suites
  already applied, now applied to the environment as well.
- **`npm run bootstrap`** - installs what a clone actually needs, which is not
  what a root install gives you: `test/fixture` is a separate app with its own
  lockfile and its own `node_modules`, and several suites build it to boot the
  real runtime. Without it they failed minutes later inside a `vite build`
  whose output never mentioned the missing install. Ends by running the doctor.
- **`.nvmrc`**, pinning the Node baseline (22.23.2) that the hosted gate runs.
  Both workflows now resolve their Node version from that file instead of a
  floating major, so `nvm use` and CI read one line. It is the ONLY baseline on
  purpose: a Node release bundles an npm, so a second pin naming a different one
  would be a baseline that contradicts the first, and the doctor would warn on
  exactly the setup contributors are told to adopt. The npm question the doctor
  does ask is answerable from this tree - can the running npm write the
  committed lockfile format.
- **An accepted-binaries record for uWebSockets.js** (`scripts/uws-accepted.json`)
  and `scripts/check-uws-binaries.js`, wired into `npm run check`. The addon is
  pinned by a Git TAG, which is mutable; it carries 15 prebuilt native binaries
  built elsewhere, one of which is dlopen'd in every production process, and a
  git dependency has no registry integrity hash and no signature. Retagging
  upstream changes what a fresh install runs while every version string stays
  identical. The record holds the resolved commit, the upstream source commit
  and a SHA-256 for every shipped file, and the check fails when the installed
  tree is not the accepted one. Re-accepting after a deliberate pin bump is
  `node scripts/check-uws-binaries.js --update`, and the diff it writes is the
  record of which binaries changed. Text files are compared with CRLF
  normalized, because npm checks a git dependency out with the contributor's own
  git config; the binaries are compared byte for byte. An installed entry that
  is not a file is reported as a change of SHAPE rather than stepped over, and
  `--update` refuses to bless a tree containing one, because the verdict this
  prints claims the whole tree.
- **`npm run verify:fast` / `verify:suite` / `verify:sim` / `verify:pr` /
  `verify:full`** - the verification lanes, named once. Both workflows invoke a
  lane verbatim, so "it passed locally" and "CI is green" cannot drift into
  meaning different things, and a step added to a lane lands in both places at
  once. `verify:pr` is exactly the union of the hosted lanes; `verify:full` adds
  the Playwright run, which no workflow runs.
- **`npm run check:links`** - a dependency-free checker for the shipped
  documentation: every `](#anchor)` names a heading that exists and every
  relative file link names a file that exists. It reproduces GitHub's slug rule
  exactly, including the double hyphen a deleted word leaves behind, because an
  approximation either passes dead links or fails live ones. External links are
  not fetched.
- **An advisory job** in the test workflow: `npm audit --audit-level=high` over
  the root and fixture lockfiles. The locks were swept clean once and nothing
  kept them that way - an advisory published afterwards arrives through a plain
  `npm ci`, silently, and the suite has no opinion about it. It fails the
  workflow only on the SHIPPED tree (`--omit=dev`), which is the one where an
  advisory describes exposure a consumer has; the development and fixture trees
  are reported without blocking, because an advisory against a transitive
  dependency of a benchmarking tool that ships to nobody would otherwise turn
  every unrelated change red with no in-repo remedy.
- **A support-floor job**: `peerDependencies` publishes `svelte ^4.0.0`, and
  every other lane installs what the lockfile resolves, which is a current
  svelte 5. The floor half of the published range had never been executed once.
  The job installs `svelte@4.0.0` and `ws@8.0.0` exactly and runs the suites
  that load the browser client, which is the only code here importing a peer at
  runtime. It builds no fixture, but it is not addon-free - one selected suite
  drives a real socket - so it verifies the native addon loaded before running
  anything, rather than answering a question about svelte 4 with a message
  about a missing addon.

### Changed

- **`uWebSockets.js` moves from v20.67.0 to v20.69.0**, picking up native uWS v20.78.0 and
  v20.79.0. Two upstream changes matter to this adapter:
  - Upgrading an HTTP socket to a WebSocket inside a `cork()` callback from an ASYNC context
    - a timer, or any callback uWS did not itself drive - was buggy upstream. The adapter has
      always upgraded that way and still does: an `authenticate` hook resumes the corked upgrade
      after an await, and the per-tick admission budget resumes it after a `setImmediate`. No
      workaround is removed here, because none was carried - the pattern the adapter already
      uses is simply correct upstream now.
  - A build compiled with `UWS_WITH_PROXY` sitting behind an L4 (TCP) proxy could be made to
    report an attacker-chosen `getProxiedRemoteAddress()`: an L4 proxy does not parse HTTP, so
    a remote client could simply send an extra PROXY v2 frame and uWS would update its record
    for the connection. Any IP-level blocking or rate limiting built on that value was
    spoofable. Fixed upstream. This affects only builds compiled with `UWS_WITH_PROXY`; the
    published prebuilt binaries the adapter installs are not compiled with it.
    `beginWrite()` is also new upstream, for establishing the chunked write path before the
    first chunk is known; the adapter does not use it yet. The full suite passes across the
    bump with no adapter change, and `npm run check` now fails if any tracked file names a
    different tag than the pin.

- **A repeated single-valued header now refuses the request with `400 Bad Request`**, where
  the last line used to win silently: `host`, `content-length`, `transfer-encoding`,
  `content-type`, `authorization`, `proxy-authorization`, `origin`. Whichever value this
  layer picks, the proxy in front may have picked the other, and the two then disagree about
  where the request ends, how its body parses, who it is from, or which origin it claims.
  Merging is meaningless and choosing is a security decision no transport layer should make
  silently. A WebSocket upgrade carrying one is refused with the same `400` before the client
  address is decoded, and the in-flight admission slot is handed straight back.
- `X-Forwarded-For` chains that arrive on several lines now resolve to the hop `XFF_DEPTH`
  names instead of falling back to the socket address. A chain genuinely SHORTER than
  `XFF_DEPTH` still answers the socket address: that no longer happens through multi-line
  proxy emission, and the only alternative - the leftmost address - is client-authored by
  construction, so taking it would let any client name its own rate-limit identity.
  `x-forwarded-for` stays comma-joined when `ADDRESS_HEADER` names it, which is the
  documented configuration and the case the merge exists for; every OTHER configured
  address header keeps the last line, because that is the one the resolver can read.

- Each precompressed static representation carries its own `ETag`, derived from the uncompressed one
  with the coding appended inside the quotes. Existing caches holding an entry under the old shared
  validator revalidate once into a full `200`; nothing is served incorrectly in the meantime.
- Byte ranges are served from whichever representation the request negotiated, not from the
  uncompressed bytes. `Accept-Ranges: bytes`, `Content-Range` and `If-Range` all now refer to that
  representation, and a `206` for a compressed representation carries its `Content-Encoding`. A
  `Range` header that cannot be honoured (malformed, multi-range, or a stale `If-Range`) still falls
  through to a normal negotiated response, so a junk `Range` does not cost a client its compression.
- `304 Not Modified` responses for static assets now carry `ETag`, `Vary: Accept-Encoding` and
  `Cache-Control`. A 304 updates a stored response, and without those a shared cache can attach it
  to the wrong stored variant or keep it under a freshness policy the origin no longer applies.

- **BREAKING (only for `SHUTDOWN_TIMEOUT=0`; the default 30 is unchanged): `SHUTDOWN_TIMEOUT=0` now
  means NO budget - wait as long as the shutdown takes.** The budget added above covers application
  code, so the value had to be given a meaning it did not have before: read as a budget of zero
  milliseconds it aborts on the first macrotask, and every flush an app performs on the way out is
  lost - the exact data loss the budget exists to prevent. It also has to be sayable at all, because
  the `hooks.ws` `shutdown` hook used to be awaited with no deadline whatever `SHUTDOWN_TIMEOUT` was
  set to, and an app that must never be cut off mid-flush needs a spelling for that. 0 is what a
  disabled timeout is spelled as elsewhere in Node. With no budget the hook receives
  `signal: null, deadline: null`, nothing aborts, and the shutdown path says so on the way out.
  Previously `SHUTDOWN_TIMEOUT=0` meant "do not wait for in-flight requests" (only the drain was
  bounded); an operator who set it for a fast exit should now set `SHUTDOWN_TIMEOUT=1`, and one who
  set it and relied on their hook finishing keeps exactly the behaviour they had.

- Boot and shutdown log lines now distinguish the three states an operator has to reason about.
  `Listening on ... (ready in Nms)` is now `(bound in Nms)` and is followed by a separate
  `Ready for traffic (Nms since boot)` once `init` commits; entering the drain prints
  `Readiness now reports NOT ready (draining); still accepting.`; and `Shutdown complete.` now
  carries how long the close took, or is replaced by a `was NOT clean` error line naming the phase
  that ran out of budget.

- The built-in holding page no longer claims a queue position or a wait
  estimate. `You are in line`, `Ahead of you: N` and `Estimated wait: N seconds`
  are gone: upgrade admission is a concurrency gate that keeps no per-client
  identity, arrival order or reservation, so there is no position to report, and
  the wait was a hardcoded one-slot-per-second projection that nothing measured.
  The page now reads `Server at capacity` and, when the caller seeds a live
  count, `About N people are waiting for a free slot.` - a crowd size, which is
  what the underlying rolling poll counter actually observes.
- The waiting count is bucketed before display (exact under 10, to the nearest
  10 under 100, to the nearest 100 above) so the shown figure carries only the
  precision the estimate has.
- Rendering the page without a live count - which the upgrade-refusal path does
  - now shows `Waiting for a free slot.` instead of `Ahead of you: 0` and
    `Estimated wait: 0 seconds`. A refused visitor no longer reads a fabricated
    zero until the first poll lands.
- `{{queueDepth}}` and `{{estimatedSeconds}}` remain supported template tokens
  with unchanged values, for operator pages written against them. Their meaning
  is now documented where they are substituted: a count of browsers polling the
  page, and that count at a nominal one slot per second - neither is a position
  or a measured wait.

- **`smoothWorld.set()` now documents where a placement is rendered.** The replacement travels as an ordinary update on the ordinary cadence, so nothing on the wire marks it discontinuous; the docstring (and `plugins/smooth/server.d.ts`) now names `snapSpeedPerSec` as the knob that governs how it is drawn.

- **The 256-topic-name cap is documented in the unit it has always been enforced in: UTF-16 code units.** No behaviour change - `topic.length` was and remains the measure. The unit is stated because it is load-bearing: the server-side `maxTopicLength` caps in the cursor and throttle plugins read the same `topic.length` against the same default of 256, so a wire boundary counting Unicode code points instead would admit up to 512 units and hand a client-named topic to a plugin that then refuses it (throttle by throwing out of the app's own publish call, cursor by dropping every frame with no signal, with the client picking which). The wire ceiling stays at or below the narrowest downstream cap, in the same unit.

- **Queue plugin: O(1) dequeue.** The per-key waiting list is a linked FIFO
  instead of an array with `Array#shift`, which was O(n) in the backlog length
  and therefore slowest exactly when the queue was saturated. The list threads
  itself through the queued task records rather than wrapping each one in a
  node, so a waiting task still costs a single object. A/B against the released
  implementation at default options, best of three runs each: one key with 200k
  tasks 7.7s -> 0.10s (-98%), 1000 keys x 200 tasks -1% to -6%, 50k keys x 4
  tasks -7% to -9% (lower is faster; no shape regressed).

- **BREAKING (return type): `CrdtAuthority.persistNow()` resolves to a `CrdtFlushResult`
  instead of `undefined`.** Callers that `await` the flush and ignore the value are
  unaffected; a caller that typed the result as `Promise<void>` needs its annotation updated.
- **BREAKING (default): `persistNow()` is bounded by default.** It previously waited
  indefinitely for the host's stores; it now waits `flushTimeout` ms (default 10000, well
  inside a typical shutdown grace period) and then reports the unfinished topics in
  `timedOut` and aborts their signals. A deployment whose store legitimately takes longer
  than 10s must raise `flushTimeout` or pass `persistNow({ timeout })`; `Infinity` restores
  the old unbounded wait. Nothing is discarded on expiry - the record goes back to dirty and
  a fresh write is scheduled - but a host that honours the new `signal` will now stop a write
  the flush gave up on, and the rescheduled write is one attempt at the `debounceMaxWait`
  cadence (floored at 1000 ms), not an unbounded retry loop: only an explicit flush carries a
  deadline, so if that write also never settles the topic's persistence stalls until it
  settles or until the next `persistNow()` abandons it. Editing does NOT clear that stall -
  the edit's own capture queues behind the wedged write and is never dispatched (verified:
  the host's store is entered twice and stays there across an edit and three seconds; the
  next `persistNow()` takes it to three) - so a deployment that can wedge a write needs a
  periodic flush, not traffic. The flush result is where a caller learns that, which is why a
  shutdown path should act on `dirty` rather than flush and exit.

- **`groups` plugin: `maxMembers` now defaults to `1_000_000` instead of `Infinity`.** Groups
  were the one plugin whose internal state had no bound unless the app remembered to set one,
  even though the capacity model promises that every plugin cap is finite by default. The new
  default matches the rest of the plugin caps and sits at the connection ceiling of the process,
  so it cannot bite a real group; it does stop member entries piling up past that ceiling when an
  app wires the group's `subscribe` hook without its `close` hook and departed sockets never
  leave. Apps that genuinely want an unbounded group opt out explicitly with
  `createGroup(name, { maxMembers: Infinity })`. Saturation behaviour is unchanged: `join()`
  returns `false` and `onFull` fires.

- The test workflow now triggers on `PROTOCOL.md`, `protocol.schema.json` and
  `test-vectors/**`. The spec says those artifacts are validated in CI against
  the reference implementation, and the suites that do it existed, but a pull
  request touching only the schema or a recorded vector triggered nothing at
  all, so the promise held only for changes that happened to touch `src/`.
- The test workflow now also triggers on `README.md`, `MIGRATION.md` and
  `CONTRIBUTING.md`. `npm run check` reads all four shipped documents, so a pull
  request that only rewords a heading - orphaning every link pointing at it -
  used to match no filter at all, and the one gate that can see a dead anchor
  would have run on every change EXCEPT the change that breaks one.
- The simulation workflow now triggers on `package-lock.json`, `.nvmrc` and its
  own workflow file. A dependency move changes what the simulation runs and
  could previously reach `main` without the swarm executing once.
- `test/protocol-schema.test.js` and `test/minimal-client.test.js` take their
  native-runtime gate from `test/helpers/real-runtime.js` instead of each
  rolling a local `try { await import(...) }` around `describe.skip`. A local
  gate can only ever skip; `REQUIRE_UWS=1` could not reach either suite, so the
  two suites standing behind the published conformance promise were the two the
  hard-fail rule did not cover.

### Fixed

- **Repeated request header lines are no longer last-wins.** Every entry point collected
  headers with `headers[key] = value` per line, so a second line of the same name silently
  overwrote the first. A proxy that emits one `X-Forwarded-For` LINE per hop (HAProxy's
  `option forwardfor`) therefore arrived as a single address: with `XFF_DEPTH >= 2` the
  resolver found fewer addresses than configured hops and answered the socket peer, which
  collapses every client behind that proxy onto one rate-limit identity - reachable through
  ordinary infrastructure rather than an attack. Repeated lines are now merged per header
  class by one shared collector used at all four collection sites (WebSocket upgrade, auth
  preflight, SSR, reserved admin route) and in the `createTestServer` mirror, which had
  drifted from each other:
  - list-valued headers (`x-forwarded-for`, `forwarded`, `via`, `accept-encoding`, and any
    unenumerated vendor chain) join with `", "` in arrival order, the form RFC 9110 defines
    as equivalent to the separate lines;
  - single-valued proxy headers keep the LAST line, the one the appending hop in front
    wrote: `x-forwarded-proto`, `x-forwarded-protocol`, `x-forwarded-scheme`,
    `x-forwarded-host`, `x-forwarded-port`, `x-real-ip`, `cf-connecting-ip`,
    `true-client-ip`, `x-client-ip`, `fly-client-ip`, plus whatever names `PROTOCOL_HEADER`
    / `HOST_HEADER` / `PORT_HEADER` / `ADDRESS_HEADER` were configured with;
  - `cookie` joins with `"; "` - several `Cookie` lines are what an HTTP/2 to HTTP/1.1
    downgrade at an edge proxy produces, and a comma join would fold every later cookie into
    the previous cookie's value;
  - `set-cookie` is never joined (a comma is legal inside an `Expires` date); the first line
    is kept, the rest are dropped, and the request is still served.
- **A repeated `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Forwarded-Port` no longer breaks
  origin derivation.** Each carries one scheme, one host, one port, so a join produces a
  value of the wrong shape rather than a longer one. With the documented
  `PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host` configuration behind a
  proxy that APPENDS its line, `"https, https"` is not a protocol - origin derivation throws,
  and SSR answers 500 on every request of that deployment - and `"a.test, a.test"` builds a
  request URL the WHATWG parser refuses outright. The same rule protects the client address:
  a joined `x-real-ip` puts the client's own bytes in FRONT of the proxy's, and the
  resolver's 128-character bound truncates to the leading ones, which would have handed a
  client its own choice of rate-limit identity and of `getClientAddress()`.
- **The WebSocket auth preflight answers `400` instead of hanging when no origin can be
  derived.** Origin derivation throws on a missing or malformed Host, or on a
  client-supplied `PROTOCOL_HEADER` / `PORT_HEADER` value, and nothing wrapped that route:
  the throw escaped the uWS callback as a synchronous exception, so no response was ever
  written and the pooled request-state object was never handed back. Guarded the way the
  reserved admin route already was, `Request` construction included.
- **A chain header named as `ADDRESS_HEADER` no longer lets a client choose its own
  rate-limit identity.** The header class was decided by the header's GRAMMAR, so
  `ADDRESS_HEADER=x-original-forwarded-for` (ingress-nginx, the GCP external load balancer),
  `=forwarded` (RFC 7239) or `=via` kept the comma join. The client-IP resolver counts hops
  in `x-forwarded-for` and in nothing else: every other configured name reaches its
  single-address branch, which truncates an over-long value keeping the LEADING bytes -
  the proxy's bytes on one line, the CLIENT'S on a joined one. Behind a proxy that appends
  its own line, a client padding that header past 128 characters therefore decided the
  per-address upgrade limiter's key and `getClientAddress()` outright: rotate the padding to
  keep evading the cap, or pin it to spend a victim's budget. Without padding the same
  request resolved to the literal string `9.9.9.9, 203.0.113.5`, which is not an address at
  all. The class now follows what PARSES the value rather than the header's grammar: every
  configured proxy header keeps its last line except `x-forwarded-for`, whatever it is
  called. Chains that are not the configured address header are untouched and still join, so
  an app reading one off `event.request.headers` still sees every hop.
- **A refused header no longer changes how the rest of a request collects.** The ambiguity
  check ran before the merge, so once one repeated single-valued header was seen, every
  later repeated header kept its FIRST line instead of merging - a third policy nothing
  documented. The refusal now names the first offender without altering any other header's
  class.

- Static assets no longer hand a resumed download bytes from a different representation. Byte
  ranges were always cut out of the uncompressed buffer, whatever content-coding the request had
  negotiated. A client that fetched an asset with `Accept-Encoding: br` stored brotli bytes, and its
  resume (`Range: bytes=N-` with the same `Accept-Encoding`, which is what `curl -C - --compressed`,
  `wget --continue` and every download manager send) came back `206` with uncompressed bytes sliced
  at offsets the client had computed against the brotli stream, a `Content-Range` total quoting the
  uncompressed length, and no `Content-Encoding` at all. Nothing reported an error at either end;
  the assembled file simply failed to decompress. Content negotiation now runs first and the range
  is cut from the representation the request selected, in that representation's own coordinates, so
  a resumed compressed download joins back into the original file. Sending `If-Range` did not avoid
  this either: the single validator matched across codings, so it confirmed the wrong
  representation. Each content-coding now carries its own validator
  (`W/"<mtime>-<size>-br"`, `-gzip`), so a cross-representation `If-Range` is a mismatch and the
  full selected representation is returned instead of a meaningless slice.
- `416 Range Not Satisfiable` no longer quotes the wrong entity length. `Content-Range: bytes */N`
  reported the uncompressed file size even when the request had negotiated a much smaller
  compressed representation, telling the client its download was many times longer than the bytes
  it was actually receiving. The length quoted is now the selected representation's.
- Static assets no longer answer `304 Not Modified` across content-codings. `If-None-Match` was
  compared against the uncompressed ETag whatever the negotiated coding was, so a client holding a
  brotli copy that revalidated without `Accept-Encoding: br` was told its copy was current and kept
  using compressed bytes as if they were the decoded file. The conditional check now runs against
  the validator of the representation the request would actually receive, and answers `200` with
  the right body when they differ.

- **Readiness no longer reports ready while the server is still starting up.** The listen socket is
  bound before the app's `hooks.ws` `init` hook runs (deliberately - the kernel queues arriving
  connections instead of refusing them), but `/readyz` answered `200 ready` from the moment of the
  bind, so a load balancer could route into an instance whose database pools, warmup or cron
  registration had not finished. The instance now has an explicit lifecycle state
  (`starting -> ready -> draining -> closed`); readiness answers `503` until `init` resolves and
  commits it, and an `init` that throws leaves the instance `starting`, so readiness never turns
  green for a failed boot.

- **The readiness `503` names which not-ready state it is instead of always saying `draining`.** The
  route wrote one fixed word for every `503`, so an instance that was still booting told operators it
  was draining - during a rolling deploy, every freshly started instance, which reads as a stuck or
  reversed rollout and is the standard trigger for a rollback. The body is now the lifecycle state:
  `starting`, `draining` or `closed`, with `200 ready` unchanged. The routing DECISION is unchanged -
  all three are not-ready and answer `503`.

- **`createTestServer` no longer disagrees with production about shutdown or about readiness.** The
  shipped test server is what an app verifies its handshake and its teardown against, and it fired the
  `shutdown` hook with `{ platform }` alone and awaited it forever, while production passes
  `{ platform, reason, signal, deadline }` and stops waiting when `SHUTDOWN_TIMEOUT` is spent. A hook
  written to give up cleanly on `signal` could not be exercised at all, and a hook that never settled
  passed locally while production cut it off and logged that its work did not finish. The mirror now
  reads the same `SHUTDOWN_TIMEOUT` (seconds, default 30, `0` = no budget) at `close()`, passes the
  same four-field context, races the hook against the same signal and logs the same not-settled error.
  Its readiness is the same four-state machine too, so `/readyz` answers `503 starting` while the
  app's `init` hook is running exactly as a real instance does. Two differences remain by design:
  `ENV_PREFIX` is not applied to the variable here (the harness reads the bare name), and the harness
  has no in-flight-request drain or `sveltekit:shutdown` phase for the budget to cover.

- **Readiness now flips at the START of the load-balancer drain delay instead of at the end of it.**
  `SHUTDOWN_DELAY_MS` exists so a balancer can deregister an instance before its sockets close, and
  the signal it deregisters on is readiness - which used to flip only once the delay had elapsed and
  the sockets were about to close. New work was therefore routed to a deliberately draining instance
  for the whole propagation window, and then met a closed socket. Draining and closing are now two
  separate steps: readiness answers `503` immediately on `SIGTERM`/`SIGINT` (and, in cluster mode,
  when the primary broadcasts the drain to its workers), while the listen socket stays open and keeps
  serving for the configured delay. Liveness (`healthCheckPath`) is unaffected in every state, so a
  readiness 503 can never trip a liveness probe into restarting a pod that is shutting down on
  purpose.

- **`SHUTDOWN_TIMEOUT` now bounds the whole shutdown, including application code.** It previously
  bounded only the in-flight request drain - the one phase the adapter controls. The `hooks.ws`
  `shutdown` hook was awaited with no deadline before the listen socket was even closed, so a hook
  that never settled (an `await` on a dependency that was already gone) held the socket open, kept
  the drain race unarmed and held the process until the supervisor's SIGKILL - with in-flight
  requests dropped and, under systemd, a stop that looked like it was progressing. One budget is now
  computed once and shared by every phase as an `AbortSignal`; when it expires the close path
  continues and the phase that ran out of it is named in the log.

- **`process.on('sveltekit:shutdown')` listeners are awaited instead of being abandoned mid-await.**
  The event was emitted synchronously and the process exited immediately afterwards, and
  `EventEmitter` discards what a listener returns - so the documented
  `async (reason) => { await db.close(); }` cleanup never resumed past its first `await`. Pool
  closes, final durable writes and shutdown telemetry were lost silently. Listeners are now invoked
  directly and any promise they return is awaited under the shared shutdown budget, after the drain,
  so a listener sees no request still using what it is closing. A listener that throws or rejects is
  reported by the shutdown log instead of surfacing as an uncaught error during exit, and one that
  never settles is reported and cannot hold the exit past the budget.

- **A cluster worker told to drain while it is still booting leaves the rotation immediately.** The
  primary broadcasts the drain to its workers, and a worker buffers everything the primary sends
  until its handler graph is live - correct for relay and shutdown traffic, wrong for this one
  message, which touches nothing but the readiness state. Replayed after boot, the worker first
  announced `Ready for traffic` for an instance the primary had put into shutdown seconds earlier,
  and only then reported that it was draining, so a slow rollout read backwards in the log. The drain
  is now applied on arrival, and a worker drained during boot never announces itself ready at all.

- **A failure inside the shutdown sequence can no longer leave the process with no way out.** The
  budget timer is deliberately ref'd (it is what keeps the process alive across the awaited
  teardown), and it was cleared on the success path only. A throw between arming and clearing - the
  teardown of a listen socket or a reconnect advisory - escaped as an unhandled rejection with that
  timer still holding the event loop: the process either died on the rejection with the clean exit
  never reached, or, in an app that installs an `unhandledRejection` handler, kept running with no
  exit path at all. The sequence now clears the timer and exits from a `finally`, and reports the
  failure.

- **A failed TLS reload is no longer silent about the certificate it keeps serving.** Validation
  failures, a mid-apply swap failure and a cert watcher that fails to start each kept the previous
  certificate (correct for availability) and logged one line, after which every probe stayed green
  while renewal was in fact dead - the first symptom being every handshake failing at once at expiry.
  The reload path now records its own health, and while it is degraded an hourly sentinel re-reports
  the failure together with the served leaf's expiry and remaining validity once that leaf is inside
  a 14-day window. The sentinel is armed only while degraded and is silent otherwise. Readiness is
  deliberately NOT wired to certificate expiry: taking a fleet out of rotation because its
  certificate is running out removes a service that is still serving.

- The page rendered `Estimated wait: 1 seconds`. The status line now agrees its
  noun and verb with the count (`About 1 person is` / `About 2 people are`), and
  large counts are grouped with an explicit locale. The whole sentence is
  composed by one function whose source is embedded into the page script, so the
  server's first paint and every polled update cannot drift apart in grammar or
  rounding - the previous page updated only the number and left the unit as
  static text, so a server-side plural branch alone would not have fixed it.
- A failed capacity check no longer retries silently behind a stale number: it
  is shown and announced, and the recovery is announced as soon as a check gets
  through again.
- Every line the status region can hold is composed in one place from the page's
  own flags, and no branch writes a literal of its own. A branch that announced
  its own text went on asserting it after the condition behind it had passed -
  which is how a page could sit on an offer of a slot that had already been
  taken, or replace live news with a paused notice that contradicted the button
  still on screen.

- **Remote interpolation renders a teleport as a teleport, with no configuration.** The smoother treated a straddling sample pair as a discontinuity only when the pair spanned more than `snapGapMs` (default 500) - a TIME test. A server-side placement (`world.set`, a warp, a respawn, a scripted move) is delivered on the ordinary tick, so its two samples sit one interval apart like any other pair, and the render frame lerped the entity the whole way to the new position: a streak across the board, and in cells mode a pop between cells. The interpolator now also judges a pair against the entity's OWN neighbouring samples and snaps one that outruns both of them by a wide factor. That comparison needs no knowledge of the topic's units, which is what makes it safe to have on by default - the same code renders cursors in CSS pixels and game entities in arbitrary world units, and an entity the app has never moved has no absolute baseline at all while it always has neighbouring samples.

  Ordinary motion is untouched by construction: a pair is a jump only if it outruns the pair BEHIND it and, once a later sample has arrived, the pair AHEAD of it. Uniform motion, hard acceleration, hard braking and a dead stop each keep an adjacent pair moving at a comparable speed, and the first pair of a ring has no baseline behind it and is never judged.

- **Dead-reckoning no longer flies an entity onward at teleport speed.** When the buffer runs dry the extrapolation velocity comes from the last two samples, and the only rejection was a pair spanning more than `snapGapMs`. A last pair judged a jump now contributes no velocity either, so the entity rests at the placement instead of continuing across the world at the jump's implied speed for the whole extrapolation cap - the longest smear this pipeline could paint.

- **A placement during a resync is snapped, not smeared across the resume window.** The resume ease slides each remote entity from where it was last drawn to the rebuilt basis over `resumeEaseMs` (default 150). It armed unconditionally, so a server-side placement during a short blackout was painted every frame of that window - the same defect as the straddle smear, stretched over 150ms instead of one sample interval. The ease now measures its own slide against the entity's peak honest speed from the history being discarded (captured by `renderedSnapshot`, once per resume) and snaps when the slide would outrun it. An entity that was at REST before the resume has a peak of zero, so any disagreement between the two bases snaps: two bases should agree about where a resting entity is.

- **Unpaired surrogates are rejected in wire topic names.** With `websocket.allowNonAsciiTopics: true` a client could subscribe to a topic containing a lone high or low surrogate - reachable through a JSON `\uD83D` escape in the subscribe frame, which parses to a lone surrogate without the frame itself ever being ill-formed UTF-8. Such a name is not encodable as UTF-8, so it is replaced by U+FFFD on the way back out of the socket: the `subscribed` ack and every published frame carry a name the client's own dispatch does not recognise, and the subscription stays open while silently delivering nothing. The same rule now applies on the server-named `platform.subscribe` / `platform.checkSubscribe` APIs, which run the same widened alphabet - there a name sliced mid-pair by app code leaves the client with no name it could send back to unsubscribe again. Both are answered with `INVALID_TOPIC` at the point of subscribe.

- **Queue plugin: a per-key bound did not bound the queue.** `maxSize` capped
  one key's backlog and `concurrency` capped one key's in-flight tasks, but
  nothing capped the totals: N distinct keys each below `maxSize` accumulated
  N x maxSize waiting tasks, and N keys each below `concurrency` started
  N x concurrency tasks simultaneously with no rejection at any point. High key
  cardinality therefore bypassed queueing entirely and launched arbitrary work.
  The new aggregate bounds close both dimensions once they are set to real
  numbers.
- **Queue plugin: keys are serviced round-robin.** Task completion used to
  restart the completing key immediately, so once a global in-flight bound
  binds, a saturated key would hold the whole budget and starve keys that
  arrived later. The scheduler now takes one task per key per visit and sends
  the key to the back of the line.
- **Queue plugin: the scheduler's service line no longer keeps places for keys
  that are gone.** A key waiting for a running slot holds a place in the line.
  Emptying it with `clear()` - the ordinary cancel-this-user's-pending-work
  path - used to leave that place behind, and the only code that consumes
  places is blocked by exactly the condition that made the key wait, so under a
  saturated `maxRunningTotal` the line grew without bound and each abandoned
  place pinned its key string. Measured before the fix: one held task at
  `maxRunningTotal: 1`, then 500 x (`push('user:N')` + `clear('user:N')`) left
  500 places for keys that no longer existed while `keysCurrent` reported 1. A
  key now gives its place back the moment it stops having startable work, so
  the line never holds more entries than there are live keys, and
  `stats().readyCurrent` reports its size.
- **Queue plugin: a throwing `onDrop` no longer escapes `push()`
  synchronously.** `push()` is documented to return a promise, but a metrics
  sink that threw was called before the rejection was constructed, so the throw
  came out of `push()` itself and a caller's `.catch()` never saw it. The sink
  is now reported to, not consulted: a throw is contained, counted as
  `stats().onDropErrorsTotal`, and the caller still gets the rejection.
- **Queue plugin: a rejected push no longer allocates its key.** Every bound is
  checked before any per-key state is created, so a shed push cannot leave an
  empty key behind - which would itself have leaked the cardinality `maxKeys`
  exists to bound.

- **Rate-limit plugin: bucket eviction can no longer be aimed at an active ban.** At
  `maxBuckets` the plugin deleted the oldest insertion-order entry with no reference to
  `bannedUntil`, so a key that had just been auto-banned (`blockDuration`) or banned through
  `ban()` was the first entry dropped as new keys arrived, and its next message recreated it
  with a full allowance. Anyone able to mint identities - a new address, a new value for a
  custom `keyBy` - could therefore push their own banned key out of the map and walk straight
  back in. Eviction now samples the map and takes an entry that is still serving a ban only
  when every sampled candidate is banned; the one it takes then is the most recently placed
  ban of that sample, which at the far end means the ban placed longest ago in the whole map
  is never the victim - so identity churn, which can only add newer bans, cannot clear the
  OLDEST ban (wherever an eviction can compare two entries at all: at `evictionSample: 1` or
  a one-bucket cap it takes the entry it lands on). Every lost ban is reported through the
  new `onEvict` with `banned: true`.
  Three things this deliberately does not claim. The choice is sample-local, not map-wide: an
  eviction consults `evictionSample` entries, so it can drop a ban while newer bans sit
  elsewhere in the map (measured at `maxBuckets: 64` with the default sample of 16: 241 of
  ~300 last-resort evictions dropped a ban that still had newer ones resident). A ban is
  therefore not indestructible - a map saturated with bans must drop one to admit any new
  key, and traffic that first fills the map with a map's worth of its own bans can then have
  a ban placed after those churned out from under it, which is what `banned: true` and sizing
  `maxBuckets` above the bans in flight are for. And evicting an unbanned bucket always hands
  its key a fresh allowance, so identity churn still buys throughput per identity the way a
  per-key limiter always allows.
- **Rate-limit plugin: eviction no longer feeds the longest-lived clients to identity churn.**
  Insertion order puts resident clients at the head of the map, so evicting the head handed a
  flood of one-shot identities exactly the buckets worth keeping. The victim is now the least
  active entry of a rotating sample, where activity is the allowance drawn across the current
  window and the one before it - the same two-window span the adapter core's upgrade limiter
  scores on. A bucket whose window has elapsed no longer wins outright, which had made every
  client that messages more slowly than one `interval` the outright preferred victim; it is
  now only a tiebreak, and it is the right tiebreak because such a bucket refills to full on
  its owner's next message either way. The rotating cursor is also what keeps the sample
  cheap: a fresh iterator re-walks the tombstone run that every previous eviction left behind,
  so it degrades as the cap grows.
- **Rate-limit plugin: `onEvict` is called after the triggering call has finished deciding.**
  It fired between the bucket insert and the ban check, so a listener that threw skipped the
  charge and the ban that call owed - under a flood, where every call evicts, one bad logger
  turned every `consume()` into an exception that had already inserted a bucket but never
  drawn from it. The listener still throws through to the caller (it is the app's own error,
  not something to swallow), but it can no longer change what the call charged, refused or
  banned.
- **Rate-limit plugin: `ban()` on a key that has not been seen is held to `maxBuckets`.** It
  inserted unconditionally, so an app banning attacker-supplied keys grew the bucket map past
  its own cap. Note the trade this makes, now stated on `ban()` itself: at the cap such a ban
  evicts another key's bucket, so an app that bans ids supplied by the traffic it is defending
  against hands the attacker one eviction of somebody else's rate-limit state per ban.

- **`plugins/webhooks` delivery controls no longer hand back the state they are supposed to enforce
  when their key cap is reached.** `createRetryBudget` and `createWebhookBreaker` reclaimed a slot by
  deleting the oldest key in insertion order, and the next access recreated it - a drained budget
  came back full, an ejected endpoint came back healthy. Anything able to push entries out of the map
  could therefore clear its own enforcement record simply by naming keys nobody cares about, which
  costs one throwaway key per slot and is trivially met by a per-event `url` callback under wildcard
  DNS. Both controls now reclaim only entries that carry no enforcement state: a token bucket that
  has refilled to full (dropping it is exactly equivalent to keeping it, since the next access
  recreates the same full bucket) and a breaker key that is healthy with no failures recorded. When
  nothing is reclaimable, a token bucket REFUSES a key it has no slot to account for rather than
  granting it an untracked allowance - which is what makes `maxKeys * capacity` a real aggregate
  bound instead of an arithmetic product - and the breaker leaves the new key untracked (it can never
  be ejected) rather than forgetting an ejection. The reclaim pass is a full walk rather than a
  sample of the insertion-order head, which is the worst possible sample because it holds the
  longest-lived keys; it runs only when a new key arrives at the cap, and a pass that frees nothing
  is not repeated until enough time has passed for one to be able to free something, so a flood of
  one-shot keys cannot turn every insert into a walk of the whole map. Both observability reads are
  read-only as well - `tokensFor()` no longer instantiates a bucket and `stateOf()` no longer
  instantiates a breaker entry - so polling them cannot take the last slot, evict anything, or set off
  a reclaim walk. `tokensFor()` answers a destination's allowance and nothing about slot
  availability, which the type now says out loud: at `maxKeys` with nothing reclaimable, an untracked
  destination reports `capacity` while `take` refuses it for want of a slot.

- **CRDT: a graceful `persistNow()` flush no longer reports a failed or declined store as
  a durable one.** Every per-topic store chain ends in its own terminal `catch` (it reports
  through `onError`, marks the replica dirty and arms a retry), and `persistNow()` awaited
  exactly those already-caught chains before resolving `undefined` - so `await
authority.persistNow()` resolved successfully after every host `store` call had rejected,
  and a store that resolved `false` to decline the write was indistinguishable from one that
  wrote. A shutdown path could destroy the authority believing the documents were safe. The
  flush now resolves to `{ ok, durable, declined, failed, timedOut, dirty }`, so the caller
  learns per topic what actually happened to the bytes. `persistNow()` still never rejects.
- **CRDT: a host `store` that never settles can no longer hang shutdown forever.**
  `persistNow()` had no deadline and no `Promise.race`: one wedged write blocked the flush
  indefinitely, and the documented escape (`destroy()`) discards pending edits without
  storing them, making the recovery from a hung flush data loss. The flush is now bounded
  (see `flushTimeout` below): on expiry the topics still in flight are reported in
  `timedOut` and their host I/O is aborted through its `AbortSignal`.
- **CRDT: a flush deadline no longer drops the state of the write it gave up on.** Expiry
  reported the topic in `timedOut` and aborted the write, but the record had already had its
  dirty flag cleared at capture time and its schedule cancelled, and neither was restored -
  so recovery depended entirely on the host's store REJECTING, which the hooks explicitly do
  not require. Two ways that lost bytes. A store that never settles at all was never retried
  (measured: the host was called exactly once in the three seconds after the timeout). And a
  host that honoured the abort the obvious way - abandoning the write and RESOLVING, having
  written nothing - had that resolution read as `durable`, so the NEXT `persistNow()`
  returned `{ok: true, durable: ['t'], dirty: []}` with zero bytes ever written, after which
  `release()` unloaded the replica and the edit was gone. Abandoning a write is now distinct
  from it succeeding: its answer is discarded however it settles, its captured state goes
  back to dirty, a fresh full-state write is scheduled at the `debounceMaxWait` cadence, and
  the topic's store chain is released so that write can actually run (previously a promise
  that never settled wedged every later store for that topic, retry included). A write
  abandoned before it was ever dispatched is not sent at all rather than handed a signal that
  has already fired.
- **CRDT: a short-budget flush no longer cancels the write a concurrent longer-budget flush
  is waiting on.** The deadline belongs to one flush but the abort was applied to every
  in-flight call on the RECORD, and two callers share one store chain, so the smallest
  timeout in the process decided for everybody: with one dirty topic and a healthy 800 ms
  write, `persistNow({timeout: 100})` issued alongside `persistNow({timeout: 5000})` made
  the long flush report `failed` with zero bytes written. Any second caller - a test, an
  admin checkpoint, a periodic flush - could therefore make the shutdown flush lose the
  document it existed to save. Each flush now registers as a waiter on the writes it awaits
  and cancels one only when it is the last waiter left; the short flush reports its own
  `timedOut` and the long flush still gets its `durable`.
- **CRDT: the `deadline` handed to `persist.store` is the longest budget waiting on that
  write, not the budget of the flush that armed it.** It was stamped from the arming flush
  and never widened when a longer-budget flush joined as a waiter, so a host doing exactly
  what the hook documents - sizing its statement timeout by `deadline` - reproduced the
  cancelled-write symptom through the hint instead of through the signal: with the same
  100 ms / 5000 ms pair over an 800 ms write, the host aborted its own write at 96 ms and
  BOTH flushes reported `failed` with zero bytes written. The deadline is now read when the
  write is dispatched and is the latest deadline among the flushes waiting on it (`null`
  when nothing bounds it, including when a waiter opted out with `Infinity`). Residual, now
  stated on the field: a flush that starts waiting on a write ALREADY dispatched cannot
  widen the reading the host took: that write is not aborted, but a host that bounded its
  own I/O by the earlier reading has already stopped, so bound on `signal` too.
- **CRDT: `attempt` handed to `persist.store` counts retries again, not writes.** It was
  incremented on every capture and only reset by a store that was still the newest when it
  settled, so sustained editing against a slow-but-healthy backend climbed without bound
  (measured: six edits with `snapshotEvery: 1` produced attempts 1 through 6 with zero
  failures and zero declines). A host doing what the hook documents - exponential backoff on
  `attempt`, or an alert above a threshold - would throttle or page against a backend that
  was working perfectly. It is now 1 for the first write of the current unstored state and
  only grows for a write of that same state that did not confirm: failed, declined, or
  abandoned by a flush deadline.
- **CRDT: `drop()` and `destroy()` no longer report a spurious store or load failure.**
  Cancelling the host's in-flight I/O makes it reject with the abort reason, which went
  straight to `onError` as `store: crdt: authority destroyed` - a false "CRDT persistence
  failed" on every shutdown that had writes in flight, and a new page for an operator whose
  handler alerts. An intentional teardown is no longer a persistence fault; a store cancelled
  by a flush DEADLINE still reports, because there the host really did run out of budget.
- **CRDT: `persistNow()` validates its first argument instead of taking any object as the
  options bag.** `persistNow(['a'])` - a plausible mistake when the RESULT is topic arrays -
  flushed every topic and reported `durable: ['a', 'b']` for a call the caller believed was
  scoped to one. Only a plain options object is read as options now; anything else in the
  topic position throws `crdt: persistNow topic must be a string`, and an array in the
  options position throws too.
- **CRDT: `ok` no longer disagrees with `dirty`.** It was computed from failed/declined/timed
  out alone, so a topic edited while the flush ran, or any topic at all on an authority with
  no `store` hook, resolved `{ok: true, dirty: ['t']}` - and the one-line check the API
  recommends, `if (result.ok) authority.destroy()`, then discarded unconfirmed bytes while
  reporting success. `ok` is now exactly `dirty.length === 0`.

### Security

- Every third-party action in both workflows is pinned to a full commit SHA
  rather than a tag, with the release it corresponds to in a trailing comment.
  `@v4` re-resolves on every run: a moved tag changes the code that checks the
  tree out and runs it without changing anything in this repository.

### Internal

- `SampleRing.sampleInto` takes one resolved bounds object instead of a positional argument list whose neighbouring entries were in different units (`snapGapMs` in milliseconds, the speed bound per millisecond). Each pair's jump verdict is resolved when its sample lands and stored as one bit per ring slot, so a render frame costs a single bit test. Measured on `bench/34-smooth-straddle-ab.mjs` (medians of 3 runs of 7 rounds): 29 ns/entity with detection on against 29 ns/entity with it off at 200 entities, 35 vs 35 at 1000. `bench/micro-smooth-alloc.mjs` reports 0.642 bytes/entity/frame against its gate of 2.

## [0.6.0-next.87] - 2026-07-30

### Breaking Changes

- **`runSimSwarm`'s fault-enablement knob is renamed `faultMode`.** `buggify` becomes `faultMode`, `buggifyProbability` becomes `faultProbability`, and the per-run flag and summary counter `buggified` become `faulted`. The bundled runner's environment variables follow (`DST_BUGGIFY` -> `DST_FAULTS`, `DST_BUGGIFY_PROB` -> `DST_FAULT_PROB`), as does the `sim-swarm` workflow input. The old name was a term coined by another project: it explained nothing to a reader who did not already know that project, while `faultMode` shares a stem with the `faultProfile` and `faultProbability` knobs beside it. Note that `runSim`'s own `faults` option (the per-frame drop/duplicate/reorder spec) is unrelated and unchanged.
- **The committed golden corpus was re-blessed.** Under `faultMode: 'random'` the per-seed fault coin is drawn from a seed-suffixed string that changed with the rename, so which seeds get faulted moved and `adapter-single` fingerprints shift with it. `adapter-cluster` runs with the mode off and never draws that coin; its fingerprints are byte-identical across the rename, which is the evidence that the rename itself carries no behavior change. Regenerate any local corpus with `npm run sim:golden -- --update`.

### Added

- **The Core client example gained `close()`.** `examples/minimal-client.mjs` reconnects 500 ms after any close, which is correct for a client whose server restarted and wrong for one the caller is finished with: there was no way to stop it, so it retried into a dead port for as long as the process lived. `close()` stops the retry and closes the socket.
- **A `THIRD-PARTY-LICENSES` file now ships with the package.** Several modules were adapted from MIT-licensed projects rather than written from scratch - the global polyfill install and the locked-response-body error from `@sveltejs/kit`, the `ENV_PREFIX` collision guard, the forwarding-header client-address resolution, the byte-size and origin parsers and the Rollup externalisation step from `@sveltejs/adapter-node`, and the extension-to-MIME table from `mrmime` - and none of them carried the copyright and permission notice those licenses require to accompany a distribution. The notice is reproduced once per upstream project in a single file listed in `files`, so it travels with the published tarball rather than living in per-file header comments.
- **The real uWS runtime suite is now a required CI gate.** Pull requests that change runtime, tests, examples, scripts, manifests, or the Vitest configuration run `npm test` on Ubuntu and Windows with `REQUIRE_UWS=1`; a missing optional native binding fails loudly instead of turning every real-runtime suite into a green skip. Fixture dependencies install reproducibly with `npm ci`, and the built fixture variants are cached by source contents and OS, with their internal content-addressed stamps revalidated before reuse.

### Removed

- **The unused `splitCookiesString` helper.** It existed to reverse comma-folded `Set-Cookie` headers, and the adapter never folds them: every response path emits each cookie separately via `getSetCookie()`, so the function had no callers and no route to one. It was internal (never listed in `exports`), so nothing downstream can be relying on it.

### Security

- **A subscribe denied after a mid-flight revocation no longer leaves the subscription behind.** An authorization hook that establishes membership before deciding - a plugin join, which is what `createGroup().hooks.subscribe` does - can install it for the very topic still in flight. A revocation landing in that window cancels the attempt, so the landing refuses it; but when a SECOND attempt for the same topic was still parked, the first landing left the membership for that attempt to judge, and if the second attempt was then refused by its own hook it returned without judging anything. Both frames were answered with a denial while the connection stayed subscribed and kept receiving the topic until it disconnected. Each surface now reads the membership at its denial exits as well as at its acks: when the last attempt leaves and no live grant backs the membership, it is removed on both registries and the app's `unsubscribe` hook runs, so a plugin roster cannot keep a member the runtime dropped. A topic the connection already held when the first attempt enrolled is treated as the standing grant it is - whichever lane opened the record, including a presence or cursor snapshot handshake running concurrently - so a hook that refuses an ordinary re-subscribe answers the frame without evicting anything. The same denial reading covers those snapshot handshakes themselves, on both of their exits: an authorization chain that establishes membership and then refuses the observer request has that membership removed and the app's `unsubscribe` hook run, and a handshake whose authorization allowed but was revoked mid-await unwinds a deferred membership the same way when it is the last attempt left to judge it - where previously either shape left the membership standing and the socket kept receiving the topic's fan-out after being refused.
- **`platform.subscribe` can now answer a denial for a topic the connection appears to hold.** The same reading applies to the programmatic path: when a revocation cancelled the call and no grant backs the membership left behind, it resolves with `'FORBIDDEN'` and unwinds instead of reporting the stale membership as success. A re-grant issued after the revocation still resolves `null`.
- **Presence and cursor observer lanes now fail closed and use the wire topic policy end to end.** Their snapshot handshakes previously skipped authorization entirely when handed a partial/wrapped Platform without `checkSubscribe`; cursor mutation and viewport frames likewise proceeded when the socket lacked `isSubscribed`. Both missing capabilities now refuse the frame. Client-named internal topics are rejected before they can turn an already-minted plugin tap into a doubly-prefixed self-authorizing subscription, and `{ requireGrant: true }` now applies the configured printable-ASCII topic policy on production, Vite and the published test server rather than accepting a larger alphabet than an equivalent wire subscribe. The observer decision re-reads current grant membership after an async side-effect hook, so `platform.unsubscribe` landing in that await cannot leave a stale allow result; a real re-grant remains valid. Ordinary server-side `platform.checkSubscribe` keeps its looser trusted-topic contract. The README now describes the observer exception to the otherwise authorization-free plugin APIs and correctly scopes runtime arming to one worker.

- **A throwing WebSocket message hook no longer terminates the worker.** The socket message callback is async on production, the published testing server and Vite, but none of their hosts await the callback's returned Promise. The app/plugin `message` hook was invoked without an exception boundary inside it, so both a synchronous throw and a returned rejection became an unhandled rejection and, under Node's default policy, exited the worker. Every app-message delegation now awaits one shared boundary that logs the server-side cause and closes only the offending connection with code 1011; unrelated connections remain open. Healthy hooks and their wire behavior are unchanged.

- **The default presence and cursor projections drop the remaining reproduced credential spellings.** Product-qualified keys (`awsKey`, `stripeKey`, `hostKey`), request authenticators (`hmac`, `signature`, `sig`, `nonce`, `csrf`, `xsrf`), recovery/login material (`recoveryCode`, `backupCode`, `inviteCode`, `magicLink`), and numeric key versions such as `api2Key` no longer ride a roster. Numeric normalization is limited to the key token and its qualifier, and bare `hmac` / `signature` / `nonce` are exact matches, so structural identifiers including `clientSort2Key`, `hmacHashKey`, `signatureRouteKey`, and `nonceSortKey` still pass. The README's server example now shows an explicit public-field allowlist instead of a passthrough that silently disabled the documented default denylist.

- **Flat contact identifiers receive the same private-by-default projection as their camelCase twins.** A flat database/profile field is one tokenizer word, so `userPhone` was dropped while `userphone`, `customerphone`, `usertelephone`, and `userfax` rode presence rosters and cursor catalogs; the standard `msisdn` and `e164` spellings passed too. High-signal contact owners now recover that lost boundary without substring-matching `phone` or `fax`, so `microphone`, `headphone`, `smartphone`, and `halifax` remain ordinary fields. The cursor regression covers the stored `list()` value and a real uWS binary snapshot catalog, proving the projection happens before `sendWire` encodes it rather than only on the JSON test path. This does not change the Redis-backed variants in `svelte-adapter-uws-extensions`: their older sanitizer still retains personal-data and alternate transport names before Redis persistence, so cross-repository projection parity remains open.

- **Malformed webhook verifier inputs fail closed without disabling freshness.** `verifyWebhookSignature` now returns `false` rather than throwing for malformed header/config containers and detached byte buffers. Non-finite `toleranceSeconds` or `nowMs` values are refused; previously `NaN` and `Infinity` made the age comparison false and could accept a correctly signed stale payload forever. The numeric timestamp header is capped before parsing and signed-prefix allocation, and the public option declarations state the finite-value requirement.

- **The default projection denylist matches a compound anywhere a word starts, matches its short tokens in a flat name, and stops condemning ordinary key-shaped identifiers.** Four measured defects, all in the same file. (1) The multi-word compounds were compared against the WHOLE name, so one qualifier defeated every entry in the set: `cardNumber` dropped while `userCardNumber` - the same card - rode the roster, and `cardSecurityCode` defeated `securitycode`. Across ten qualifiers and eleven suffixes, ten of the twelve entries leaked under all twenty-one variants. They are now matched at any word start of the tokenized name, which is what separates `taxIdNumber` from `syntaxId` and `nationalIdNumber` from `internationalId` once the separators are gone. (2) The PII set was thin where it mattered most: `socialSecurityNumber`, `dateOfBirth`, `birthDate`, `passportNo`, `driversLicenseNumber`, `bankAccountNumber`, `bankRoutingNumber`, `nationalIdNumber`, `taxIdNumber`, `cardCvv`, `cvvCode`, `cardSecurityCode`, `telephone` and `mobileNumber` all passed, and so did Supabase's `serviceRoleKey`, the credential that bypasses row-level security. `service` is now a credential key qualifier and the government-identifier, payment-instrument and date-of-birth compounds are covered. `cvv` and `cvc` moved to the word set where they belong - they are single words, and filing them under multi-word compounds is precisely what let `cardCvv` and `cvvCode` through. (3) `pwd`, `ssn`, `dob`, `otp`, `mfa` and `totp` were matched per word only, so `userPwd` dropped while `userpwd` - the spelling a SQL column hands you - did not; swept across 35 bases and 23 affixes that left 231 divergent spelling families. They now also match inside a flat name, which is the only shape that was broken. (4) The `key` rule scanned EVERY word for a credential qualifier, so one ordinary environment or tier adjective condemned any key-shaped identifier: measured as a cross product of 22 canonical key-nouns against 28 such adjectives, 616 of 616 real product names were dropped - `clientSortKey`, `serverCacheKey`, `testHashKey`, `livePartitionKey`. The qualifier attached to the key now decides, so those pass while `apiKey`, `streamKey`, `serverKeyMap` and `apiUserKey` still drop. That also makes the flat and separated spellings agree by construction rather than by two lists that had drifted three times. Separately, flat `authorid` and `authorname` were being DROPPED while `authorId` and `author_id` passed, in the one family this default works hardest to keep on a roster. Verdict cost is unchanged in the direction that matters: 616 ns for an uncached name against the ~900 ns the previous rule measured, and 6.6 ns for the memoised hit that answers on a real projection.
- **The default projection drops a compound in its FLAT spelling, an ordinal-suffixed name, and an absurdly long one.** Three holes, all found by an adversarial pass over the rewrite above rather than by the rewrite's own corpus. (1) The compound set is anchored to a word start, and a flat lowercase name tokenizes to a SINGLE word, so the anchor degenerated to "starts with" and anything in front defeated every entry: `userTaxId` dropped while `usertaxid` passed, and likewise `usercardnumber`, `customerdateofbirth`, `userpassportnumber`, `usersocialsecurity` and `userhomeaddress`. Measured across the set and six qualifiers, 243 of 252 families diverged and every divergence leaked. That is the same "same value, two spellings, opposite verdicts" defect this file had already fixed three times - for the short tokens, for the `key` rule, and for the author family - and never here, which is where all the regulated personal data lives. It matters because Postgres folds an unquoted identifier to lowercase, so the flat spelling is exactly what a plain `select` hands an upgrade hook. A flat name now scans the compounds unanchored, which accepts the collisions that come with having no word boundaries to anchor to (`syntaxid` drops alongside `taxid`) - this file's standing trade, already taken for `iban`. (2) The tokenizer counts digits as word characters, so `phone2` was one word and matched nothing while `phone` dropped: `phone1`/`phone2` are the standard CRM column pair, and `address1`/`address2` the canonical form-field pair. A trailing ordinal is now stripped before the word rules, by stripping rather than splitting so that `ipv4` and `ipv6` keep matching whole. (3) The verdict memo declined to STORE a name over 64 characters but still computed it, which made the cap an amplifier rather than a short-circuit - presence asks this once per key of every update frame, so an uncachable name was recomputed at frame rate, measured at 173.7 us per frame against 0.4 us for an ordinary one, from one crafted key inside the ordinary byte cap. Such a name is now dropped outright, which is both the cheap answer and the safe one. Measured against the same file without these three changes, medians of 25 interleaved reps: the memoised hit path - the one that answers per field per message - is at parity (four samples spanning -1.6% to +0.9%, sign flipping, so noise), the uncached path likewise (-1.6% to +1.3%), and the crafted long name goes from 3,966 ns to 5.8 ns. Two structural choices earn that: the length test sits AFTER the cache read, since an over-long name is never stored and would otherwise tax every cache hit; and the ordinal strip is gated on the last character rather than run unconditionally, which alone was worth 1.3 points on the uncached path.
- **`verifyWebhookSignature` hashes the body in every container a receiver can hold, and is documented.** The previous fix moved it off `rawBody.toString('utf8')` onto the raw bytes, but tested only `Buffer.isBuffer` and coerced everything else with `String()` - which reintroduced the same defect one level down and made it worse. `String(arrayBuffer)` is the constant `'[object ArrayBuffer]'`, so for a receiver passing `await request.arrayBuffer()` - the shape this project's own framework hands over, and the one the documentation invites - the digest stopped covering the body at all and any two bodies accepted each other's signature. A `Uint8Array` hashed the decimal CSV of its bytes and so never verified, silently rejecting every delivery. `Buffer`, `ArrayBuffer`, any typed-array view (sliced to its own window, not the backing buffer) and strings now all take the byte path, and a body that cannot be hashed byte-exactly - an already-parsed object - fails closed instead of being coerced into a stand-in that hashes to something meaningless. Omitting `options` entirely now returns `false` like every other malformed input, where it used to throw and turn a receiver's typo into a 500. The header bound is counted in bytes rather than UTF-16 code units. `verifyWebhookSignature` is now documented in the README, which it was not.
- **A truncated `X-Forwarded-For` cannot have its cut fragment counted as an address.** The guard that drops the partial first element was correct and shipped, but nothing covered it: the test that claimed to was written at `xffDepth: 1`, which selects the LAST element, so a fragment at index 0 was never read either way and the guard could be deleted with the suite still green. The guard decides exactly one shape - a depth reaching past the complete addresses onto the fragment - and that case is now pinned. Without it, `XFF_DEPTH=2` behind a single appending hop answered a client-controlled run of padding as the rate-limit identity.
- **The default projection drops five personal postal names.** `homeAddress`, `billingAddress`, `postalAddress`, `streetAddress` and `mailingAddress` rode the roster, in every spelling, on a zero-config app whose `upgrade` hook returned a user record - the same shape that was already publishing `email`, `phone` and `dob` before those were closed. They are now dropped. **This is a behavior change if your app relied on one of those names reaching peers**; name it in `select` to keep it. **This is those five names, not postal coverage in general**: `deliveryAddress`, `residentialAddress`, `permanentAddress`, `addressLine1`, `street`, `houseNumber` and `postalCode` all still pass, and no denylist of names can close that set. Select your fields if a postal address must not reach peers. `shippingAddress`, `addressBook` and `walletAddress` deliberately still pass: an order surface and a contacts surface legitimately broadcast the first two, and a wallet address is a public chain identifier rather than personal data. That boundary is why these are named one compound at a time instead of matching the word `address`, which would take all three - and it is pinned by a test asserting both directions, because the tempting simplification breaks it silently. Verdict cost is unmeasurably changed: against the same file without these entries, the median of 25 interleaved runs moved -3.45% and -0.15% across two processes while the within-variant spread was itself about 30%, so the five added entries sit well under this measurement's noise floor, and the memoised hit the wire actually pays stayed at 7 ns.
- **An over-long `x-forwarded-for` no longer collapses every client behind a proxy onto one rate-limit identity.** The XFF branch answered the socket peer for any value over 8 KB, which is the behaviour the same resolver's own comment argues is unacceptable for the single-address headers beside it: it merges distinct clients into a single bucket, and a client that can pad a header it controls the head of can force that merge on demand. Every hop APPENDS to X-Forwarded-For, so the padding lands on the left and the addresses `xffDepth` counts sit on the right - the value is now truncated at the HEAD, which keeps exactly the addresses the depth selects and bounds the parse. A cut landing mid-address leaves a fragment, and that fragment is not counted as an address. The depth guard is unchanged: a header with fewer hops than the configured depth still answers the socket peer, because there is no address at that position to read.
- **Outbound webhook signatures are verified over the body's BYTES, and the signature header is bounded before it is parsed.** `rawBody.toString('utf8')` replaced every invalid sequence with U+FFFD before hashing, with two consequences: a sender that signed the actual bytes of a non-UTF-8 body never verified, and two different bodies differing only inside invalid sequences decoded to the same string and therefore accepted each other's signature. The HMAC now runs over the buffer, which is byte-identical to the old behaviour for any body that was valid UTF-8, so no legitimate sender changes. Separately the attacker-controlled `x-webhook-signature` header was split unbounded, so a multi-megabyte value allocated one string per comma and then ran a constant-time compare against every one of them, once per configured secret; it is now refused over 1 KB and at most eight entries are compared. Failing closed is the right direction here, unlike the client-IP resolver above: a refused signature fails one delivery that no legitimate sender produces, where refusing to parse an address merges identities.
- **Webhook signature freshness uses the exact wall clock rather than the runtime's 1 Hz cache.** The cached clock is correct for hot-path timestamps and duration bookkeeping, but after a long event-loop stall it remains minutes old until its interval callback runs. The first delivery or receiver verification after that stall could therefore emit an already-stale timestamp or accept a captured signature against the stale cache. Signing and default verification now read the exact injectable wall-clock seam; pin-cache duration checks remain on the cheap cached clock.

### Documentation

- **`websocket.idleTimeout: 0` is documented as disabling the idle timeout.** Its siblings `upgradeTimeout` and `upgradeRateLimit` both say what their zero does and this one did not, while `maxPayloadLength: 0` and `maxBackpressure: 0` are refused outright because there zero INVERTS the option. `idleTimeout: 0` genuinely disables, so a guard would refuse a legitimate setting - what was missing is the consequence: it also stands down the automatic ping, so a peer that vanished silently is never reaped and keeps its slot.

- **The SSRF gate no longer mistakes an IPv4-embedding IPv6 address for a public destination.** NAT64 (`64:ff9b::/96`, RFC 6052) and 6to4 (`2002::/16`) are unwrapped to their embedded IPv4 and re-checked, and Teredo (`2001::/32`) is refused outright. The RFC 8215 local-use prefix `64:ff9b:1::/48` needed particular care: RFC 6052 section 2.2 splits the address _around_ the reserved octet at bits 64-71, so a contiguous 32-bit read starts an octet late and shifts every octet after it - under that reading `64:ff9b:1:c0a8:0:101::` decodes to a public address when it is really 192.168.0.1. Because the address text does not say which prefix length produced it, all six lengths are decoded **unconditionally** and the address is blocked if any of them lands somewhere private. Nothing about the address is allowed to disqualify a reading, because everything that could - the reserved u-octet, the padding after the embedded address - is under the sender's control and is not part of the embedded address at that length. Gating on either one hands an attacker an off switch: dirty the bits a given reading does not use, that reading is discarded, and a public-looking reading at another length acquits the address. `64:ff9b:1:a9fe:a9:fe00:808:808` is 169.254.169.254 under the RFC 8215 `/48` with a junk suffix, and it is refused. The only reading ever skipped is one landing in `0.0.0.0/8`, which is an artifact rather than a destination - read short it picks up prefix bits, read long it reads into the zero padding - and it is skipped only while some other reading carries a real address. An address with nothing after the prefix at all is the translator prefix itself, which resolves to `0.0.0.0`, and is refused. The whole of `64:ff9b::/32` is covered rather than just the well-known `/96` and the RFC 8215 `/48`, including the `/32` and `/40` layouts: `64:ff9b:c0a8:101::` is 192.168.1.1 under a `/32` deployment. That span is a deliberate fail-closed choice over space no deployment is entitled to use, **not** a spec requirement - IANA assigns only `64:ff9b::/96` and `64:ff9b:1::/48` inside the `/32`, and RFC 6052 section 2.2 says the well-known prefix "can only be used in the last form of the table", i.e. at `/96`. An earlier draft of this entry called a `/32` deployment "the most literal reading of the registered prefix", which is backwards: there is no registered `/32`, and reading those two layouts is what buys the 35% figure below. One property of the address _can_ be acted on, and is: RFC 6052 section 2.2 reserves bits 64-71 and requires them to be zero in every layout, so an address inside the prefix with a non-zero value there is not a legal encoding at any length and is refused outright. Note the polarity, which is the opposite of the rejected gates - _discarding a reading_ when those bits are dirty would hand the sender an off switch, whereas _refusing the address_ cannot be used that way. It is checked only after every reading, so a private destination still reports its own range rather than being flattened to a conformance error. What it closes is a divergence class: this reader steps around the reserved octet and a translator doing a contiguous 32-bit read would not. Two residuals remain irreducible, because the prefix length is simply not recoverable from the address text when no `nat64Prefix` is declared. An address can be a legal encoding under two lengths at once, so a public destination encoded at `/48` may also be a legal `/56` encoding of something reserved: measured over random public destinations that refuses about 25% at `/48` and 35% at `/32` and `/40`. The well-known `64:ff9b::/96` is unaffected (0.00%), but every other shape pays, and some pay everything. A `/96` sourced from the RFC 8215 `/48` carries a 16-bit subnet id that becomes the leading octets of the phantom address, so 16557 of the 65536 subnet ids (25.3%) refuse **every** public destination while the rest are entirely clean - a subnet is dead or fine, never partial. The same trap applies at other lengths and is not limited to `/96`: a `/56` on a poisonous subnet byte refuses 100%, and a `/40` averages 43.8% across subnet bytes for that reason. There is no way to tell from the prefix alone whether yours is one of the dead ones, which is the argument for declaring it. `allow` cannot be used to escape this - the range check runs before the allow-list by design, so allowlisting never re-opens a blocked address - and an earlier draft of this entry wrongly said it could. The escape is `nat64Prefix` below. And a destination inside `0.0.0.0/8` is allowed when another reading of the same bits looks public - including `0.0.0.0` itself, since the bare-prefix rule above requires groups 3 to 7 to be entirely zero and junk in a group the matching reading does not use switches it off, so `64:ff9b:1:0:0:0:8:8` reads `0.0.0.0` at `/48` and is allowed. What bounds that residual is the shape of the skip itself: it tests for a zero leading octet, which is exactly the condition reported as `unspecified` and no other reason's, so it cannot hide a loopback, RFC1918 or metadata address. The entire class it can suppress is `0.0.0.0/8`. That residual is real rather than theoretical, and an earlier draft of this entry wrongly called it harmless: reaching loopback by way of `0.0.0.0` is not merely a `connect(2)` quirk, because Linux substitutes the loopback route inside `__ip_route_output_key_hash`, the generic output-route lookup every in-kernel caller reaches. A NAT64 translator that routes its own translated packet through it - Jool does, without validating the destination - therefore lands on the translator's own loopback, and neither RFC 7915 (which requires no destination validation) nor RFC 6052 section 3.1 (whose MUST-drop is scoped to the well-known prefix, which none of the reachable shapes use) prevents it. The floor is blind SSRF against the translator appliance itself; what the range bound above guarantees is that it cannot reach the calling host's own metadata or RFC1918. Declaring `nat64Prefix` removes it entirely. ISATAP (RFC 5214) is unwrapped too: it carries its IPv4 in the low 32 bits behind a `0000:5efe` or `0200:5efe` interface identifier under any unicast prefix, so unlike 6to4 and NAT64 there is no prefix to recognise. A 6to4 address whose own embedded IPv4 is public no longer short-circuits that check, since 6to4 and ISATAP coexist on the same host in the standard Windows configuration and the private address hides in the identifier. On the IPv4 side, RFC 6598 carrier-grade NAT (`100.64.0.0/10`, which carries Alibaba Cloud's metadata endpoint at 100.100.100.200), benchmarking (`198.18.0.0/15`), multicast (`224.0.0.0/4`), reserved (`240.0.0.0/4`) and the IETF protocol block (`192.0.0.0/24`) are now classified. The IPv6 side gained the twins it was missing - multicast `ff00::/8`, deprecated site-local `fec0::/10`, and the RFC 2765 IPv4-translated form `::ffff:0:0:0/96` (one group longer than the IPv4-mapped `::ffff:0:0/96`, and not to be confused with it) - so an attacker-controlled AAAA record can no longer reach through a gate that blocks the IPv4 spelling of the same address. GCP's bare `metadata` hostname joins the fully-qualified form, since the instance search domain makes the short spelling resolve identically. A resolver returning zero addresses now fails closed instead of skipping the rebinding check entirely.
- **A WebSocket subscribe that was revoked mid-authorization can no longer install its grant.** `platform.unsubscribe` cannot remove a subscription that does not exist yet, so a revocation arriving while an async authorization hook is parked used to be lost, and the subscribe completed afterwards against a permission that had already been withdrawn. Revocation now bumps a per-topic epoch that each in-flight attempt carries, and an attempt whose epoch is stale discards its grant and answers the client with a denial rather than an acknowledgement. The epoch is per attempt rather than a single per-topic flag because a flag has one slot: a client sending the same subscribe frame twice re-armed it, so the already-revoked attempt landed to find itself apparently permitted while the innocent one was denied - both halves wrong, and both driven from the wire.
- **The auth preflight endpoint is rate limited (`authPathRateLimit`, default 30 per 10s per IP).** The upgrade door was metered and the preflight beside it was not, so the app's `authenticate` hook - typically a credential check against a database, the most expensive thing an app does per connection - was reachable at raw server capacity from a single address. Only an Origin gate and a body cap stood in front of it, and an Origin gate does not bound rate: a non-browser client sends whatever `Origin` it likes. The check runs after the cheap origin/CSRF predicate but before any body is read. Proofless or cross-origin traffic therefore cannot spend the shared per-IP budget of legitimate clients behind the same NAT; a non-browser client that supplies accepted origin proof is metered before body read and hook invocation. It does not save the header walk - resolving the client address needs `ADDRESS_HEADER` before there is an identity to meter by, so the headers are collected first. The default is deliberately higher than `upgradeRateLimit`: every reconnect that preflights also upgrades, so this door sees at least as much traffic during a deploy's reconnect wave, and matching them 1:1 would make the preflight the binding constraint and refuse traffic the upgrade limit would have admitted. `0` disables it. The sliding-window estimator, the entry cap and the eviction policy were extracted into one module for the new door to use rather than being written a second time by hand - the upgrade limiter had accumulated several non-obvious and individually load-bearing decisions (evict rather than refuse at the cap, sample rather than scan, bound the key length as well as the entry count) and a hand-written copy would have reproduced the shape while missing at least one. The upgrade door now runs that same module rather than its own inlined copy, so the two cannot drift; the copies were behaviourally identical when written, which is exactly why keeping both was a bad bet - the IPv6 key fold below had to land in one place, not two.
- **A presence field is bounded by depth as well as size.** The byte cap does not bound nesting: a value roughly 8 KB on the wire can nest thousands of levels deep, which is about four times deeper than the `structuredClone` serializer the cluster relay publishes through can survive. Stored, it terminated the worker on the next relayed publish - far worse than a dropped frame, and not something any byte cap can prevent. Client-supplied fields nested past the projection depth cap are now dropped silently, like every other malformed update. The depth check is iterative rather than recursive, because a recursive one would blow its own stack on exactly the input it exists to reject.
- **The default presence and cursor projections drop more personal data and transport metadata than credentials alone.** This is a best-effort DEFAULT, not a boundary: it is a denylist and it cannot close, so a novel credential name passes until it is added. An app that puts a user record on a peer-visible entry must select the fields it wants published; do not rely on this list to withhold anything in particular. The denylist covered credential shapes only, so a zero-config app whose `upgrade` hook returned a user record broadcast every peer's `email`, `phone`, `dob`, `ssn`, `iban`, card number and PIN on the roster - and again on every diff, heartbeat and snapshot. The set is now the runtime's own sensitive-name list, so one idea of "sensitive" covers logs and broadcasts alike. The client IP was also crossing under two spellings this project's own documentation endorses: the ratelimit plugin reads `ud.remoteAddress || ud.ip || ud.address` and documents all three, so matching only `remoteAddress` left an app following that convention publishing peer IPs. `ip`, `address`, `headers`, `url` and `requestId` are now dropped too - the case the denylist exists for is an upgrade hook that spreads its whole context, which puts `x-forwarded-for` and a token-bearing query string on the wire verbatim, and neither is credential-shaped. Short names (`ssn`, `dob`, `cc`, `pin`) are matched per word rather than as substrings of a separated name, so `account`, `success` and `spinner` are unaffected; `ssn` and `dob` additionally match inside a name carrying no separator and no hump, where there is no word boundary to find (see the compound entry above), while `cc` and `pin` deliberately do not, because flat `account` and `spinner` contain them. **`author`, `authorId`, `authorName` and `authoredAt` now pass**, where a bare `auth` substring match had been silently dropping them from every roster; `authorization`, `oauth` and `authToken` are still refused.
- **The `resume` frame honours the server-grant model.** Resume is client-named - the frame carries the topics in `lastSeenSeqs` and the app's resume hook typically answers each one with that topic's replay buffer - and it was the one client-named lane with no grant check, which made it the largest of them: it yields a topic's message history, not a roster. Under the pure-grant model (armed, no app subscribe hook) topics the connection was never granted are now dropped before the hook sees them. Filtered rather than refused whole, because a reconnect names every topic the client held and it legitimately holds some of them - refusing the frame would break every legitimate reconnect while serving nothing extra. Untouched when the gate is off or an app hook owns the topic decision, which is the same condition the other lanes use.
- **`presence.update()` charges a field name at its serialized size.** The budget counted the raw name while storing and re-broadcasting the JSON-escaped one, so a name of control characters cost a sixth of what it occupied - a client could retain roughly six times the documented `maxTotalFieldsBytes` with every frame staying under the per-frame cap, and every byte of it rode each subsequent snapshot and heartbeat. `presence` also gained `topicThrottle`, bounding how often a topic's diffs are published: the byte caps bound how much state one user retains, and this bounds how often it is re-broadcast, which is the other half of the same amplification. It defaults to 16 ms, matching cursor's roughly-60-Hz topic cadence; `0` explicitly restores the previous next-tick-only coalescing.
- **Revoking a topic now releases the presence and cursor observer taps derived from it.** `__presence:<topic>` and `__cursor:<topic>` are separate subscriptions established on the connection's behalf, and both plugins keep them alive across a participant leave on purpose - a co-resident observer's roster would otherwise freeze - releasing them only on socket close. So `platform.unsubscribe(ws, topic)`, which is what a kick, ban or lease expiry runs, removed the grant and left the tap in place: the revoked client kept receiving the roster and every peer's cursor position, and for cursor kept _publishing_ too, because that lane authorizes an outgoing frame by asking whether the socket still holds the tap. Plugins now declare their derived prefix and the platform releases it on revocation, so this is one release point rather than a rule each plugin has to remember. The registry is held under a `Symbol.for` key rather than a module binding, because the bundler gives the plugin package and the runtime separate instances of that module - with a plain binding the plugin registered into one registry while the platform read another, which passed in-process and did nothing in a real build.
- **A plugin's subscribe hook no longer disarms the server-grant gate.** The gate steps aside when the app exports a `subscribe` hook, on the reasoning that an app which took over the topic decision owns it. Presence's hook is not that - it joins a roster and returns `undefined` on every path, so it never denies - yet the documented wiring re-exports it, which meant arming `authorizeWireSubscribe` and following the presence README produced _no enforcement at all_: any client could name any topic, be subscribed, and receive that topic's roster and live diffs. Plugin hooks are now marked as side effects and do not count as the app taking over authorization. They still run exactly as before, and an app that wraps a plugin hook in its own function is deliberately not marked, so the documented escape hatch keeps working.
- **A flag that restricts access is refused when its value is not a boolean, and the dev plugin warns on options it does not recognize.** `authorizeWireSubscribe` is read as `=== true`, which treats every other value as "off" - so `websocket: { authorizeWireSubscribe: process.env.WS_AUTHZ }` built cleanly, emitted `false`, and left the gate disarmed. That is the same silent no-op as dropping the key, moved from the key to the value, and the unknown-key warning cannot catch it because the key is spelled correctly. A non-boolean value is now a build error naming the env-var conversion, matching how every other misshaped adapter option is treated. Permissive siblings like `allowSystemTopicSubscribe` still coerce, because for them coercing lands on the safe state; this one is the inverted case. Separately, the Vite dev plugin had no option checking at all, so `uws({ authorizeWireSubcribe: true })` ran dev wide open while the developer's own testing showed the app working - it now refuses the misshaped value and warns on an unrecognized key, and the message notes that the dev plugin takes these flags flat rather than under `websocket`. Both checks live in one shared module rather than a copy per surface. The adapter's three build-internal root exports also gained the declarations they were missing, so importing them typechecks instead of only running.
- **The wire-subscribe security posture is explicit and validated on all three development surfaces.** `createTestServer({ authorizeWireSubscribe: 'true' })` used to silently run permissively even though production and Vite rejected the same misshaped value, creating a false-green authorization harness; it now uses the shared restrictive-boolean guard too. The Vite documentation now states the other parity requirement plainly: adapter `websocket` options are build configuration and are not copied into the separately-created dev plugin, so an app that arms production statically must repeat `uws({ authorizeWireSubscribe: true })` in `vite.config.js`. Real built-runtime and real Vite-server tests drive both `subscribe` and `subscribe-batch`, and the Vite option test derives equality between runtime reads, the known-key warning table and `UWSPluginOptions` instead of maintaining a one-way/manual list.
- **A plugin leave or evict now cancels a subscribe that is still being authorized, and the grant gate is re-checked where the grant is installed.** The revocation epoch was bumped only by `platform.unsubscribe`, so the shared membership primitive behind presence leave, groups leave and cursor viewport changes removed a subscription while a subscribe parked in its authorization await sailed past it and re-installed the membership afterwards - leaving the socket subscribed to a topic it had just been evicted from. That primitive now tombstones the topic exactly as `platform.unsubscribe` does, which covers every plugin leave path at once rather than one call site at a time. Separately, the wire subscribe and subscribe-batch landings re-evaluate the server-grant gate against the _current_ grant set rather than the reading taken before the awaits, so a revocation that drops a membership without bumping the epoch cannot be defeated by a decision made before it happened. Under the grant model that re-check can only refuse a topic whose grant disappeared mid-flight: a topic that was never authorized is already refused before the hook runs, and an authorized one takes the idempotent acknowledgement path. The in-process test server carries the same landing re-check, and the Vite dev server carries it on its batch path.
- **`upgradeResponse()` rejects headers that would split the 101 response.** uWS writes header names and values verbatim into the handshake, so a CR, LF or NUL in a value (or a name outside the RFC 7230 token alphabet) let an app that composed untrusted data into a header inject arbitrary response lines. Validation happens at construction, so the failure surfaces inside the app's own upgrade hook, and independently in the runtime, which snapshots the headers and validates the snapshot it is about to write. Validating the app's live object would not have been enough: the object stays the app's own, and admission control can defer the write to a later macrotask, so a shared or module-level headers object rewritten by another connection's hook in that gap would have gone out unvalidated. Non-string values are refused too: uWS rejects them at write time, which is _after_ the 101 status line has already been corked, so `{ 'x-ratelimit-remaining': 3 }` - an entirely natural mistake - left the client holding a half-written handshake instead of getting a clean refusal. Passing no headers at all is explicitly fine (`upgradeResponse(ud, needsRefresh ? h : undefined)`), since there is nothing to validate and the runtime skips the write. The refused character class is Node's own `checkInvalidHeaderChar` - tab, printable ASCII and the high range are accepted, everything else refused. Listing only CR, LF and NUL let VT, FF and DEL through to the wire verbatim, so a value this guard accepted was one `cookies.set()` in the same package refused, and one that would throw inside the first Node-based proxy in front of the app rather than being refused cleanly here.
- **Handshake header snapshots no longer execute app-controlled array hooks.** Calling an array value's `slice()` let it return a custom iterable that yielded safe bytes during validation and CRLF when the runtime iterated it again at the wire sink. Header arrays are now copied by index into native arrays and consumed by index in both production and the published test server, so overrides of `slice`, `Symbol.iterator`, and `Symbol.species` cannot create a validate/use split.
- **The in-process test server enforces the same handshake, subscribe-authorization and revocation rules as production.** `svelte-adapter-uws/testing` is a published export, and it reimplemented these decisions by hand: it wrote upgrade-response headers with no validation at all, ignored the `requireGrant` mode of `checkSubscribe` that the shared `Platform` type advertises, and had no revocation tracking, so `platform.unsubscribe` racing an async authorization hook silently missed. An app verifying its own tenancy boundary or ban logic against it could therefore see a clean pass for behaviour production refuses - the worst possible direction for a test double to be wrong in. The header guard, the grant conjunct and the revocation epoch are now the same shared predicates the runtime uses rather than copies of them, and a parity suite drives one vector table through every surface so a future divergence fails a test instead of waiting for an audit. `platform.unsubscribe` there now returns `true` when it cancels an in-flight grant, matching production. The Vite dev server gained the grant conjunct for the same reason, and its own revocation tracking (see the dev entry below); it discards upgrade-response headers rather than writing them, so it was never a splitting sink.
- **The presence and cursor default projections no longer broadcast credentials.** Both plugins previously passed the whole of `ws.getUserData()` to every peer on a topic, which for most apps means the session object. They now share one denylist (`plugins/_shared/sensitive.js`) that drops auth/session-shaped names, credential-shaped key names (`key` standing alone, or qualified as `apiKey`, `accessKey`, `privateKey`, `licenseKey` and similar - structural identifiers like `primaryKey`, `foreignKey` and `sortKey` still pass, as do `monkey` and `keyboard`), the adapter-injected `remoteAddress`, and the prototype gadgets; binary views become a `'[bytes: <len>]'` placeholder. `select: (ud) => ud` restores the old passthrough. The denylist covers the configured dedup `key` field with no exemption, because the resolved key is broadcast as the roster key in every frame - so a credential-shaped one is dropped and the tracker warns at construction rather than publishing it.
- **`presence.update()` can no longer overwrite the identity its peers see, or grow without bound.** Server-reserved names (the dedup key field, `id`, `role`, `__`-prefixed, `constructor`/`prototype`, credential-shaped) are stripped from updates; `clientUpdateFields` replaces that guard with an explicit allowlist, though it can never re-admit the prototype gadgets. A fields blob over `maxFieldsBytes` (8 KB) is dropped, and one user's durable fields are held to `maxTotalFieldsBytes` (64 KB) cumulatively - counting field names and their JSON framing, not just values, since a client sending long names with one-byte values otherwise stored megabytes under the cap and every byte of it rode each subsequent snapshot and heartbeat. `maxTopicsPerConnection` (100) bounds the remaining cross-topic multiplier at about 6.25 MiB of retained dynamic fields per socket. Connection-cap eviction now releases the evicted roster entries too; previously it discarded only the connection lookup, orphaning those fields in snapshots and heartbeats with no later close path able to remove them.
- **Binary decode paths define `__proto__` as an own property instead of assigning it.** The wire value codec, the presence roster codec and the smooth field-delta codec all reached the inherited setter, replacing the decoded object's prototype with wire-controlled data instead of creating the key - and in presence's case producing a roster member who was in every server-side count but invisible in every client-rendered list. The roster accumulators are null-prototype for the same reason, as is the subscribe-batch denial map, where a topic literally named `__proto__` could not be allowed even when the app's hook allowed it.
- **The per-IP upgrade rate map is bounded at insertion.** It was previously trimmed only by the 60 s sweep, so a burst of rotating client identities grew it unbounded in between. At the cap the least active of a bounded rotating sample is evicted rather than the new client being refused: refusing looks like the fail-closed choice, but the map is a shared resource, and one host rotating `X-Forwarded-For` could otherwise fill it cheaply and lock out every other client until the next sweep - turning a slow leak into a total outage for new connections. A full scan per insertion would have been its own amplification, hence the sample. Evictions are counted on `upgrade_rate_map_evicted_total`. Keys are also truncated to 128 characters, matching the accepted single-address-header ceiling, which makes the entry cap bound _memory_ rather than only entry count while preserving every identity the single-address resolver accepts. Longer `X-Forwarded-For` chains sharing a prefix collapse into one limiter bucket, so an oversized rotating flood rate-limits itself sooner.
- **The `same-origin` WebSocket check honours the `ORIGIN` env.** The startup guard counts `ORIGIN` as a host pin, but the check itself compared the request `Origin` against the `Host` header - which a non-browser client controls, so two attacker-supplied headers were being compared. `ORIGIN` is now authoritative when set, including at both Vite auth and upgrade boundaries. Vite also resolves its handler before deciding whether a missing Origin may defer to `upgrade()`; an upgrade arriving while the module loaded previously observed no hook and returned 403 even though production and every later dev request admitted the hook-authenticated client. Deployments reachable under several hostnames should leave `ORIGIN` unset or list the origins explicitly; see the `allowedOrigins` documentation. The default-port strip is also anchored now, so `example.com:8080` is no longer rewritten to `example.com80`.
- **`presence.sync()` and `cursor.snapshot()` honour the server-grant model.** Both are gated only by `platform.checkSubscribe`, which consulted the app's hook chain but never the grant set, so under a pure-grant deployment (armed, no app hook) they handed over a roster for any topic named. They now pass `{ requireGrant: true }`, which additionally requires the topic to already be in the connection's grant set. That mode is opt-in rather than the default because the ordinary use of `checkSubscribe` is to gate _before_ establishing a grant, and it defers to an app subscribe hook exactly as the wire gate does.
- **Plugin snapshot lanes respect the per-connection subscription cap**, and `presence.join()` rolls its roster entry back if the subscribe is refused rather than leaving a user visible to every peer on a channel they will never receive. Ingress bindings are capped per connection and by retained target size, measured in bytes.
- **The Vite handler handoff reads SvelteKit's resolved configuration, including direct `sveltekit(config)` setups.** The first repair imported only `svelte.config.{js,mjs,cjs}` and assumed SvelteKit had cached that exact URL. Current SvelteKit can intentionally ignore those files when configuration is passed directly, and its file loader uses a cache-busting query, so the import could both miss the live adapter and evaluate app config a second time. Build and dev now take the validated adapter object from SvelteKit's resolved plugin API, with the file import retained only for older Kit releases. Adapter-owned handler paths also keep the adapter's project-working-directory base when Vite has an explicit `root`, instead of being silently reinterpreted relative to that root.
- **`websocket.handler` is honoured when the Vite plugin is installed, and a build where the two disagree is refused.** The plugin resolves the WebSocket handler and emits it into the SSR output _before_ the adapter runs, and the adapter then took that file as it stood - so with the plugin installed, which is the setup the adapter's own build warning tells you to adopt, a handler named in `websocket.handler` was never read and the auto-discovered `src/hooks.ws.js` was built instead. Silently, while the build log positively reported that a handler had been built. That is not a configuration nicety, because the module that wins decides which hooks the app has and an app-supplied `subscribe` hook stands the server-grant model down: an app that armed `authorizeWireSubscribe` and pointed `websocket.handler` at a deliberately hook-free module got a build whose serialized options said `"authorizeWireSubscribe":true` while an ungranted wire subscribe was admitted over a real socket, because the substituted module exported a `subscribe` hook and the gate stepped aside for it. The gate's own documented escape hatch became reachable by accident. The plugin now reads `websocket.handler` from the app's Svelte config, so one value drives the dev server and the build; naming a _different_ module on the plugin as well is refused rather than settled by precedence, since there is no reading of the two under which one is meant to lose in silence. The adapter additionally records which module was bundled and refuses to build when that disagrees with its own option - the plugin honours the option, so this catches only the paths where it could not, such as an unreadable Svelte config or a second copy of the package - and the build log now names the module it built rather than only asserting that one exists, which is what kept the substitution invisible. The dev server resolved independently too, never consulting `websocket.handler` at all, so an app naming its handler there developed against one set of authorization hooks and shipped another; both surfaces now go through one resolver. A handler named explicitly but missing from disk is reported by name instead of surfacing as a bundler resolve error.

- **A `subscribe-batch` frame no longer runs the app's subscribe hook for a topic the grant gate already refused.** The single-subscribe path denies before its hook; the batch path computed the same decision, ran the hooks over every valid topic anyway, and consulted the decision only when installing the membership. Hooks are not pure - the documented presence wiring joins a roster and opens a `__presence:` observer tap - so for a refused topic those side effects had already happened: in one frame, holding no grant, a caller was added to a private topic's roster, broadcast to its real members as a join, handed the full roster, and left holding a live tap that kept delivering, and only then told `FORBIDDEN`. The same request spelled as a single `subscribe` leaked nothing, and that asymmetry between two spellings of one thing was the defect. The batch resume/recover call between the hook and the landing was covered at the same time: it sits after the awaits and before the membership is installed, so it took its decision from the reading captured _before_ the hook parked, and served a revoked topic's replay history - the largest thing any client-named lane yields - while the landing afterwards correctly refused the subscription. It now re-reads the current grant set and the revocation tombstone. Both mirrors carry the fix.
- **The `groups` plugin's documented wiring no longer stands the server-grant gate down.** The gate steps aside for the whole connection when the app exports a subscribe hook, and this plugin's README tells apps to re-export its own. That hook decides exactly one topic - the group's `__group:` channel - and returns nothing for every other topic, so arming `authorizeWireSubscribe` and following the plugin's README produced no enforcement anywhere: any client could name any topic and be subscribed. It is now marked a side effect, exactly as presence's was, which keeps the gate armed while the hook still runs and its `false` still refuses. Presence was fixed for this; groups was the identical unfixed instance beside it.
- **Both rate limiters key IPv6 on the /64 rather than the full address.** A /64 is the smallest block a host is routinely _given_ - the standard allocation from every major provider and most residential ISPs - so keying on the /128 let one ordinary attacker source every request from a fresh address, never collide with itself, and drive either door at full server speed while the limiter recorded one request per identity. Both `upgradeRateLimit` and `authPathRateLimit` were void against a single dual-stack host. IPv4 keeps its full address, and so does anything that is not unambiguously a global IPv6 address: IPv4-mapped (`::ffff:1.2.3.4`, which is what an IPv4 client looks like on a dual-stack listener and whose /64 is shared by the entire IPv4 internet), any address whose first four groups are zero, and a value that does not parse - with `ADDRESS_HEADER` set the key need not be an address at all. Merging distinct clients is the worse error, so every uncertain case declines to fold.
  Shared translation prefixes are kept whole too: NAT64, Teredo, and link-local `/64`s can represent unrelated clients. Conversely, 6to4 gives one site `2002:V4ADDR::/48`, so its key folds to that `/48`; otherwise one site can rotate through 65,536 independently metered subnets. Scoped values and bracketed literals with malformed suffixes are left opaque so an attacker-controlled address header cannot alias a legitimate bucket by appending ignored text.
- **An option that sizes a rate limit refuses a value that is not a number.** `authPathRateLimit: process.env.AUTH_LIMIT` is the natural way to write these, and what you get depends on how the variable is set: an empty or unset one produced `''`, which **disabled the limiter outright** (`'' > 0` is false, so the whole block was skipped), while `'30'` happened to work and `NaN`/`Infinity` fell back to the default. A door whose enforcement depends on which of those three you land on is refused at build time instead. `0` still disables a LIMIT deliberately; a zero WINDOW is now refused too, because it does not disable anything - it makes every request look like a fresh window, the sliding estimate evaluate to `NaN`, and `NaN >= limit` false, so everything is admitted.
- **A typo nested inside an object-valued option is reported.** The unknown-key warning walked top-level `websocket.*` keys only, and for `upgradeAdmission` that was not cosmetic: every gate reads `maxConcurrent > 0`, so `maxConcurent: 500` left the concurrency ceiling, the cursor lane sized from it, and the waiting room all switched off with nothing said at build or boot - and the 1 MB `maxPayloadLength` default is documented as safe _because_ that ceiling bounds it. `upgradeAdmission`, its `waitingRoom` and `cursorLane`, and the `pressure` thresholds are now walked too, and an unknown key is reported by its full path.
- **`cursor.update()` bounds client data by depth as well as size.** Nesting costs about two bytes a level, so 8 KB of client JSON - comfortably inside the 8192-byte `maxDataBytes` default - reaches roughly 4000 levels, while the `structuredClone` the cluster relay publishes through overflows around 1834. Stored, the blob is re-serialized on every read: it threw out of `cursors.list()`, the documented SSR call, so every server render of that board returned 500 until the sender's socket closed, and on the relay path it terminated the worker rather than dropping one frame. Presence has bounded this since the same class was found there; cursor took client data on the identical path and did not.
- **The default projections drop credential-shaped names that a closed qualifier list was letting through.** `key` qualified by a word was matched against a list of qualifiers that make it secret, so every unlisted one passed: `streamKey` (RTMP), `serverKey` (FCM), `hmacKey`, `deviceKey`, `webhookKey`, `signKey`, `cryptoKey`, `symmetricKey`, `recoveryKey`, `pairingKey`, `vapidKey`, `idempotencyKey` and `authorKey` all rode the roster - while their snake_case spellings were correctly dropped, because only the camelCase form lacked the separator the word rule needed. Same value, two spellings, opposite verdicts. The rule is inverted: `key` as a word is a credential unless its qualifier makes it an identifier (`primaryKey`, `foreignKey`, `sortKey`, `partitionKey`, `rowKey`, `cacheKey`, `publicKey`, `userKey`). The client IP was crossing under every qualified spelling for the same reason - only the bare `ip`, `address` and `remoteAddress` were matched, so `clientIp`, `ipAddress`, `remoteIp`, `peerIp`, `ip_address`, `ipv4`, `ipv6` and `remoteAddr` all published peer IPs - as were `x-forwarded-for`, `userAgent`, `host` and `referer`. Names whose words are ordinary on their own (`url`, `host`) are still matched whole, so `avatarUrl`, `imageUrl` and `hostId` keep riding a roster.
- **An own `toJSON` can no longer replace a projected subtree at serialize time.** `typeof fn === 'object'` is false, so a function value was not projected - it took the pass-through branch and was copied to the wire verbatim. `JSON.stringify` then invoked it and substituted whatever it returned for the whole subtree, so every name check above it counted for nothing and a projection that had already dropped `email` and `sessionToken` published both. Function values are now dropped by both defaults.
- **Revoking a topic withdraws write access as well as read access.** The client-driven `game` lane carries no topic and publishes to whatever `platform.grantPublish` bound, so a kick or ban that ran `platform.unsubscribe` removed the subscription and the derived taps while leaving the sender still bound to the room - still able to publish into it, silently, to everyone who remained. Read and write are granted together and are now revoked together, scoped to the revoked topic.
- **The `resume` frame's grant filter reached the mirrors.** Production filtered ungranted topics out of a resume before the hook saw them; `svelte-adapter-uws/testing` and the Vite dev server both passed the client's list through raw, so an app verifying its tenancy boundary against the published test double saw a clean pass for behaviour production refuses, and dev handed the replay backend topics production would not.
- **A revocation that lands while a presence or cursor snapshot is authorizing now cancels that snapshot.** Both observer lanes authorize the real topic, `await`, and then subscribe the socket to a derived `__presence:` / `__cursor:` channel. Only a subscribe the revocation can SEE is cancellable, and neither lane enrolled itself as in-flight, so `platform.unsubscribe` released the taps and the parked lane re-installed one immediately afterwards. A kicked or banned client kept receiving the roster and every peer's cursor position, and kept publishing, because that lane authorizes an outgoing frame by asking whether the socket still holds the tap. An attacker could hold the window open by parking the app's own authorization hook.
- **A `resume` frame can no longer be used to read a plugin-owned topic's history without a grant.** The observer gate stood aside for any registered plugin prefix, and the same predicate answers for the client-named resume filter - a lane with no landing re-check behind it, where the filter IS the gate. A client refused `__group:private-lobby` on the live-subscribe path was served that channel's buffered history by naming it in a resume frame. The wire-subscribe path keeps its carve-out, because there the exemption only defers the decision to the plugin's hook and real membership is re-tested when it lands.
- **`registerPluginOwnedPrefix` validates the prefix it is given.** It punches a hole in the server-grant gate, so what it accepts is a security surface; it previously took any non-empty string. `'__'` made every internal topic plugin-owned, and an ordinary namespace such as `'room:'` handed the exemption to a whole class of app topics - a client the gate had refused still landing on a private room's roster with a live observer tap. A prefix must now be `__`-namespaced and `:`-terminated, which also makes two distinct prefixes provably unable to claim each other's topics.
- **The default projections drop a credential key under either word order.** The rule read only the word immediately before `key`, so `userApiKey` was dropped while `apiUserKey` - the same value, the same credential - rode the roster, along with 682 other mirrored spellings. Every qualifying word must now be structural. `userKey` and the other documented identity spellings are unaffected.
- **The per-IP rate map's eviction is no longer O(map size) per request.** V8 leaves a tombstone on `Map.delete` and only compacts on rehash, so at the entry cap - where every miss deletes one entry and inserts another - a fresh iterator walked an ever-growing tombstone run before reaching the first live entry. A sample that read as bounded measured 8.5x more per request at a 10,000-entry cap and 19.4x at 50,000, getting worse as the cap grew, and it was reachable from a single routed /48 with no address header configured: an amplifier inside the guard meant to bound one. The sample now advances a rotating cursor, and the cursor is released when the map empties so it cannot pin a superseded table for the life of the process.
- **A non-`X-Forwarded-For` address header is bounded, and the address no longer retains it.** Nothing limited the length of `x-real-ip`, `cf-connecting-ip` and friends, so a client could name itself with kilobytes and have that string become a rate-limit identity. Worse, `split()` and `trim()` return a view that keeps the whole parent header alive, so the documented 128-character key bound counted characters while the memory sat in what each key retained - 10,000 entries held about 25 MB per worker instead of the ~2 MB the entry cap implies. An over-long value is TRUNCATED rather than discarded in favour of the socket address: some of these headers legitimately chain (`x-original-forwarded-for` from ingress-nginx and the GCP external load balancer, and RFC 7239 `Forwarded`, where a few IPv6 hops already cross any sane bound), and answering with the socket address there would merge every client behind one proxy into a single rate-limit identity. Merging distinct clients is the worse error of the two.
- **The dropped-field warning no longer does unbounded work.** The escape ran over the full field name before the name was truncated and before the duplicate check, and the warn set was keyed on the TRUNCATED name - so names sharing a 64-character prefix collapsed to one entry and the 32-name cap never engaged to stop them. The log and the set were bounded; the work was not, and repeated on every join for the life of the process.
- **The projection's field-name memo no longer freezes, and its hit path does nothing but read.** Filling and then freezing assumed the app connected before an attacker. Nothing enforced that: a hostile client connecting first filled all 1024 slots and the app's own field names were then never cached again for the life of the process. Replacing it with least-recently-used was worse still - the only way a `Map` expresses LRU is to delete and re-insert the key on every HIT, and touching a live key in a full table thrashes V8's shrink/grow: 754ns per hit against roughly 4ns for a plain read, which is what recomputing the verdict costs anyway. Eviction now happens only on a miss, dropping the oldest inserted entry, so a hit is a single lookup and the table returns to full speed as soon as a flood stops. It also refuses to store an over-long name, so the entry cap bounds bytes as well as count.
- **The presence field-name check is memoised on the per-MESSAGE path, not only the per-connection one.** The reserved-field test runs once per client-chosen name on every `presence-update` frame, and it called the matcher directly: 560ns per name against the 7.5ns single regex it replaced, so one legal 8 KB frame spent about 459us classifying names. The memo was sitting in front of the path that runs once per join and behind the one a client can drive at will.
- **The plugin-owned carve-out reaches the single-subscribe path in the test server and the dev plugin.** It was on the batch path in all three surfaces and the single path in production only, so the same client, server and topic got opposite answers depending on how many topics happened to be pending when the client flushed - a documented group join worked or failed on microtask coalescing. The dev plugin gained the landing re-check that makes the carve-out safe there.
- **The dev server's `platform.unsubscribe` withdraws write access and releases derived taps.** Both are stated unconditionally elsewhere in this section and were true of production and of the in-process test server, but false in dev: a revoked client kept its `__presence:` / `__cursor:` subscriptions and kept its client-publish binding, so it went on receiving the roster and publishing into the room it had been removed from. Dev being the looser surface is how an app comes to depend on a revocation that does not hold in production.
- **An option that sizes a payload, a backpressure budget or a timeout refuses a misshaped value.** The guard covered the rate limits only, so `maxPayloadLength: '1000'` serialized into the build as a string with no warning and reached uWS, which never validates it back - a bound the operator wrote to limit a resource, silently not applying. `maxBackpressure: 0` and `maxPayloadLength: 0` are refused outright, because measured against the real binary zero INVERTS them rather than disabling them: at `maxBackpressure: 0` a slow client buffered 99.75 MB where the default held it to 1.00 MB, and `maxPayloadLength: 0` closes the connection on any message. `idleTimeout` and `upgradeTimeout` genuinely do disable at 0 and still accept it.
- **The dev server's `platform.unsubscribe` releases derived taps and the write grant for an observer-only socket.** Both statements were added below the membership early-return, so they were inert in exactly the shape they exist for: `cursor.snapshot` and `presence.sync` subscribe only `__cursor:{topic}` / `__presence:{topic}` and never the base topic, so the revoke found no membership, answered `false` and changed nothing. Production and the in-process test server both act before that return.
- **Every socket surface now makes its subscribe decisions from one shared definition.** Production, the published `svelte-adapter-uws/testing` server and the Vite dev server each drove their own plumbing and each re-derived the same authorization decisions inline, with nothing enforcing that the three agreed. They repeatedly did not: the plugin-owned carve-out reached the batch path on all three and the single path on one, so a documented group join worked or failed depending on how many topics happened to be pending when the client flushed; the recover guard reached two of three; the gap-fill fall-through reached one; and the same decision was spelled `isNew` in one file and `!subs.has(topic)` in another, which is how it drifted unseen. The decisions are now pure functions in one module, pinned by exhaustive truth tables and cross-surface behavioural differentials. Effects stay per-surface; only the answers are shared. The structural source oracle is an additional enrolment check, not proof by itself: dead or decorative calls and equivalent private copies require mutation review until that oracle is strengthened.
- **Handshake-header snapshotting and validation are shared across production, the public test server and Vite dev.** Production and `createTestServer` had copied the null-prototype snapshot loop by hand, while Vite only inspected the result it was about to discard. A duck-typed upgrade result with `headers: 'abc'` or an array therefore became numeric 101 headers in production/test while the published `upgradeResponse()` helper rejected it, and dev accepted an upgrade production could not run. One shared operation now validates the container, copies each array value at the moment its property is read, validates that exact null-prototype snapshot, and returns the only object a surface may consume. This also closes the getter-order edge where `Object.entries()` let a later getter mutate an earlier array before it was copied. The docs no longer call the Vite/test implementations identical to production; both preserve the protocol/API contract, while built-runtime tests remain required for production wiring.
- **A revocation landing during authorization is honoured on all four of the Vite dev server's subscribe paths.** It had no pending-subscribe tracking anywhere, so a `platform.unsubscribe` inside that window was a silent no-op and the parked subscribe re-installed the membership afterwards - dev being the looser surface is how an app comes to depend on a gate that is not there in production. The single wire `subscribe`, the `subscribe-batch` frame, the server-side `platform.subscribe` and the client's own `unsubscribe` frame now all enrol or tombstone. The batch frame is the one that mattered most: the client store sends a single frame only when exactly one topic is queued, so before this a ban was defeated or honoured in dev depending on nothing but microtask coalescing. A client `unsubscribe` also drops the publish grant and the derived observer taps, which it previously left standing.
- **The in-process test server's single `subscribe` guards its recover lane.** It served the topic's replay history and denied the subscription afterwards - the messages had already gone out. Its batch lane had the guard; only the single spelling was missed. The gap-fill fall-through for an already-subscribed socket also reached the test server and the dev plugin, so a regression test written against the documented harness no longer passes against the old behaviour.

### Changed

- **`presence.list()` returns the same shape as the `state` snapshot** - identity plus durable `update()` fields, minus `transient` - instead of identity alone. An SSR render and the client's first WebSocket snapshot now agree, where previously the page rendered without typing, selection or lock state until the socket opened. Note that this carries client-written fields into server-rendered output.
- **The rate limit plugin is documented as fixed-window, which is what it implements.** It was described as a token bucket; the allowance refills wholesale at each interval boundary, so up to 2x `points` can pass across a boundary seam. Behaviour is unchanged.
- **BREAKING: outbound webhook signatures now cover a timestamp. Update your receiver BEFORE upgrading.** `x-webhook-signature` is now `HMAC(secret, '<unix-seconds>.' + body)` with the timestamp emitted alongside as `x-webhook-timestamp`, so a captured delivery stops verifying once the receiver's freshness window (documented: 5 minutes) has passed - a body-only signature replays forever. Any receiver still verifying `HMAC(secret, body)`, which is what the previous contract prescribed, will reject **100% of deliveries** the moment a sender upgrades. There is no overlap period by design: a legacy body-only signature is deliberately **not** emitted alongside the new one, because a receiver that accepts either is still replayable through the legacy entry, which would leave the vulnerability open while appearing to fix it. That is a deliberate replay-closing decision and should not be softened later. During a `previousSecret` rotation both keys sign the same timestamped material. The timestamp is drawn once per delivery, so every retry and redirect hop of one delivery carries identical signed material.
- `redactUrl()` keeps only the origin, since webhook URLs routinely carry their credential in the path (`/services/T00/B00/SECRET`) and the redacted value is persisted in dead-letter records and logs. Signature and idempotency headers are no longer forwarded to a cross-origin redirect target, for the same reason browsers strip `Authorization`.

### Added

- **`npm run check` now refuses source where an identifier does not resolve.** Two defects of exactly that shape have shipped from this repo - a helper used without being added to the import list, and a `const` read after its block closed - and both parse cleanly, so `node --check` and the syntax check pass them and they throw only when the line runs. The new gate resolves every identifier read against the enclosing scopes, imports, and the `/* global */` names a build step injects, and it found a third live one on its first run. It is not a general linter: one question, no configuration, and its only dependency is the acorn already in the tree. Temporal-dead-zone and use-before-declaration are deliberately out of scope, so it reports only names that cannot resolve at all. A file it cannot parse is reported as unchecked rather than skipped quietly.
- **A field the default projection drops is now reported once, by name.** The name rules are biased toward dropping - a word that reads as sensitive makes the whole field sensitive, so `tokenCount`, `emailVerified` and `sessionCount` go with it - and that bias is only defensible if an app can see it. A silently missing roster field is otherwise debugged from the client, against a server working as designed. The warning names the field and shows the `select` that would keep it.
- **`npm run check` now refuses a named runtime export that carries no declaration.** Three root exports shipped undeclared and were declared one at a time; nothing checked the class, so the next change re-broke it, and adding this gate immediately found a fourth and then two more on `./client`, the package's most imported subpath. A consumer importing an undeclared name gets `any` from a package whose whole premise is that the types ship, and nothing fails until somebody notices by hand. Every subpath in the `exports` map is paired automatically rather than from a hand-kept list, and the runtime side is read from acorn's AST: a hand-rolled scanner cannot tell a regex literal from division, and one that treated `/['"]/` as the start of a string silently swallowed 42,000 of `src/index.js`'s 47,420 characters and reported that file as having no exports at all.
- `websocket.adminAuthAcknowledged` silences the boot warning that the auto-mounted admin route carries no adapter-level authentication, once an operator has confirmed the handler gates itself. A warning that cannot be turned off after it has been acted on is how a log learns to be ignored.
- `presence` gained `maxFieldsBytes`, `maxTotalFieldsBytes` and `clientUpdateFields`.
- **`safe-url` gained `nat64Prefix`**, so a deployment on a NAT64 network can state its exact prefix (`{ nat64Prefix: '64:ff9b::/96' }`, `'64:ff9b:1:a::/96'`, or one from its own address space) instead of paying for prefix-length ambiguity. With the exact value, one RFC 6052 reading is taken rather than all six, which takes both the over-block and the `0.0.0.0/8` residual described above to zero while still refusing private embedded addresses. For a Network-Specific Prefix outside the default-recognised `64:ff9b::/32`, the option is required for SSRF protection. **Treat it as a trusted assertion and declare the exact prefix your translator uses.** A parseable wrong length in either direction can turn a blocked address into an allowed one: a shorter declaration reads prefix bits as the destination, while a longer declaration reads destination and suffix bits. The real length is not recoverable from the address text, and trying every length would restore the false positives this option exists to remove. A non-zero suffix proves some mismatches and is refused, but a clean suffix does not prove the declaration correct. Only an _unparseable_ value is safe by default - that one is ignored in favour of reading every length. At `/96` RFC 6052 additionally requires bits 64-71 of the prefix itself to be zero, and a declaration violating it refuses the whole range rather than none. Accepted by `isSafeUrl`, `checkUrl`, `checkUrlResolved`, `classifyAddress` and `isAddressSafe`.

### Fixed

- **A smooth channel in cells mode no longer throws on its first sync.** The client assigned to an undeclared name, which is a `ReferenceError` in a module, so the sync handler died at that line: the cell sink was never registered, the catalog never applied, and the clock never seeded. The flag was written once and read nowhere - cells mode is already tracked by the channel name the next line sets - so it is gone.
- **`upgradeResponse()` requires an object of headers.** A string was accepted, because `Object.entries('abc')` yields index keys, so the 101 went out carrying headers `0: a`, `1: b`, `2: c` - each individually valid, so the name and value guard had nothing to object to.
- **`uws({ timeoutMs })` is honoured.** Documented, type-exposed and on the plugin's known-key list - so the new unknown-key warning stayed quiet for it - and read nowhere: both call sites take their own `options` parameter, which shadows the plugin bag of the same name, so the value was looked for as a per-call argument, not found, and the hardcoded default used instead.
- **`presence.update()` cannot plant a confusable identity field.** The reserved-name check compared `id` and `role` exactly while the transport half of the same guard case-folded, so `ID`, `Id`, `Role`, `ROLE`, `userId` and `user_id` were all writable by a client onto its own peer-visible entry. It could not overwrite the identity its peers see, but it could put a lookalike beside it, which spoofs any client rendering `entry.userId ?? entry.id`.
- **`websocket.authorizeWireSubscribe`, `postureExport` and `resourceGrowthAuditIntervalMs` reach the runtime.** All three were documented and read by the handler but never serialized into the build's options payload, so setting them did nothing - in the first case leaving the wire-subscribe authorization arming as dead code. The build now warns on any unrecognized `websocket.*` key, and the option table is checked in both directions so a key can neither be serialized without being known nor known without reaching the runtime.
- **The default projections are much harder to hang.** They are depth-capped, and memoised per node: the cycle guard alone bounded depth but not work, so an object graph reaching the same child by several paths was re-expanded once per path - twenty levels of a node holding the same child twice is over a million expansions from twenty-one objects, which turned a fast stack overflow into an unkillable worker. A property read that throws now skips that field rather than surfacing out of `join()` / `update()`, since the previous passthrough default read no properties at all. **The memo bounds the PROJECTION, not the serialization behind it:** it stores one result object per input node, so a graph reaching the same child by many paths projects to a shared-structure result that `JSON.stringify` still expands as a tree. Around 29 shared objects is enough to make `list()` throw `RangeError: Invalid string length`, and around 21 to spend 32 MB on one roster. Select your fields rather than handing the projections an arbitrary object graph.
- **An unchanged deep presence field no longer re-broadcasts.** The depth cap added to the equality check reported "changed" past its limit, and because an identical value has a zero byte delta the budget never intervened - handing a client an O(subscribers) fan-out it could repeat indefinitely with a constant payload. Past the cap the comparison falls back to serialized equality.
- **A subscribe that asked to recover from an offset is served its gap-fill after a revoke and re-grant.** Two separate faults produced the same silence. The revocation epoch only ever rises, so a revoke followed by a legitimate re-grant inside one await window could never clear it and the replay was refused forever while the subscription was acked. Membership is now read first, and the epoch only when the socket does not hold the topic. Underneath that, the single-subscribe path took an idempotent-ack shortcut whenever something else had installed membership during the await - but live membership carries no HISTORY, so a re-grant left the client acked, believing itself caught up, with the tail between its last-seen seq and now missing entirely. Both spellings are covered.
- **Arming `authorizeWireSubscribe` at runtime no longer discloses a topic's replay history to a batch subscribe already in flight.** The batch gap-fill lane decided against a snapshot of the arming flag taken BEFORE the authorization hooks were awaited, while the landing beside it read the flag fresh. `platform.authorizeWireSubscribe()` flips that flag process-wide and only ever false to true, so arming it while any connection had a `subscribe-batch` parked in an async hook left the gap-fill guard reading "gate off": it served the topic's buffered history and the landing then answered `FORBIDDEN` for the same topic in the same frame. Whether a client saw the history depended only on whether its subscribes had been coalesced into a batch. All three surfaces now read the flag at the point of decision.
- **The dev server no longer serves a revoked topic's replay history.** In a `subscribe-batch` carrying `recover` offsets, the dev gap-fill lane asked only the wire-subscribe grant gate, so with that gate off - the default - a topic whose pending subscribe had been cancelled by a `platform.unsubscribe` during the authorization await still had its history read and sent. Production and the `testing` server both consult the revocation tombstone there as well as the grant set. All three now ask the same question, membership first.
- **The dev server answers a batch subscribe the way production answers it.** At the landing the dev server settled the topic's pending enrolment before anything else and denied `FORBIDDEN` whenever that came back false, so a revoke followed by a legitimate re-grant inside one authorization await was refused in dev while production and the `testing` server both acked it - the same "read membership first, the revocation epoch only when the socket does not hold the topic" reading the recover lane already takes. The early settle also answered `FORBIDDEN` over a hook's own denial reason and over `RATE_LIMITED`. Replayed over the whole input space the two landings disagreed on 11 of 48 combinations, every one of them in the revocation path; they now agree on all 48.
- **A field whose `Symbol.toStringTag` claims to be a `Date` no longer throws out of `join()` / `update()`.** The tag is forgeable, so a plain object wearing it reached `Date.prototype.getTime`, which rejects it - surfacing an exception out of two fire-and-forget calls that previously projected the same object harmlessly.
- **`keyCode`, `keyDown`, `keyMap`, `heldKeys` and the rest of the input family ride a roster again.** Requiring a structural qualifier before `key` had no word to inspect when `key` came first, so ordinary UI and game state was dropped as though it were a credential. The exception reads an input word on either side, so the trailing spellings (`heldKeys`, `arrowKeys`, `modifierKeys`) are covered as well as the leading ones, and it exempts only the `key` word itself rather than the rest of the name - `keyMaterial`, `keyData` and `keyMapToken` are all still dropped.
- **The default projections drop a credential key in its FLAT spelling too.** A lowercase name carrying no separator and no hump is a single word, so the rule that reads words never saw `key` inside one: `streamKey` and `stream_key` were dropped while `streamkey` rode the roster, and 192 of 210 qualifier-and-key pairs had one spelling dropped and another passed. That is the spelling a database column, a SQL row and plenty of JSON payloads actually give you, and it covered every name this projection already claimed to catch - `serverkey`, `hmackey`, `devicekey` and the rest. An unrecognized `<qualifier>key` is now a credential; the ordinary English words that merely end in "key" are a closed list and keep riding a roster.
- **The `select` snippet the dropped-field warning suggests is code that runs.** It emitted the `{ apiKey }` shorthand, which reads as a free variable rather than `ud.apiKey`, so every developer who pasted the message's own example got a `ReferenceError` - and an identifier is the common case, since nearly every real field name is one.
- **A getter that throws inside the depth check no longer escapes the projection.** Its sibling `JSON.stringify` over the same value was already guarded, so a getter that throws only on its second read passed the stringify and then surfaced out of the walk. An unreadable subtree is now treated as over budget and dropped, which is what a genuinely too-deep value does.

## [0.6.0-next.86] - 2026-07-17

### Fixed

- **A relay frame lost to one worker mid-stream is now detected and reported; it used to be structurally invisible.** The cross-worker check compared each topic's highest delivered sequence, and a maximum can only ever reveal a lost _tail_: a worker that received frames 2 and 3 of a stream and one that received 1, 2 and 3 both top out at 3, so their hashes agreed exactly and nothing fired - `RESTART_ON_STATE_DIVERGENCE` could not repair what it could not see. What distinguishes those two workers is contiguity, so each worker now numbers the frames it hands to the relay, per topic, and a receiver that finds a hole in that numbering has lost data. That is reported directly, on a new `[adapter-uws/relay-gap]` log line naming the topic, the worker that sent the frames and the missing ordinals, and counted on `relay_gap_frames_total` when a `metrics` registry is configured. It is deliberately _not_ folded into the divergence hash: a hole is decidable by the worker that finds it, because the numbering is dense at the sender by construction, so no majority is needed to establish it - and a vote would be actively wrong here, since a worker never receives its own relayed frames and so could never hold a view of a stream it publishes. `RESTART_ON_STATE_DIVERGENCE=1` covers the new case too, unambiguously: the reporter is the worker that lost the data. The numbering counts relayed frames rather than reusing the publish sequence, which is not dense over the relay and so cannot be checked for holes - a topic also published locally-only (`{ relay: false }` for an external pub/sub source, or the game lane) advances its sequence without relaying anything, an explicit `{ seq: n }` authority interleaves values from several workers at once, and a `{ seq: false }` topic carries no number at all, the last of which is now covered despite having no sequence to compare. Frames are numbered as they reach the wire rather than when they are queued, because a batched publish is written synchronously while a single publish defers a tick: a batch issued after a publish on the same topic overtakes it, and numbering at the wire is what keeps the numbering and the arrival order the same order. Separating a lost prefix from a legitimate mid-stream join needs to know whether a stream was already running when a worker attached, so frames carry the instant their sender opened the stream; that instant is read on the timeline the whole process shares rather than each worker's own epoch-anchored clock, whose anchor is snapshotted per module load and so drifts between workers loaded at different times by whatever NTP has since done to the wall clock. A hole is reported only once it has outlived any plausible in-process reorder, so a frame that is merely late is never called lost, and confirmation is by elapsed time rather than by how many frames followed it, so a drop on a quiet topic surfaces as promptly as one on a busy topic. Each loss is reported once and the stream then resumes clean tracking, so one lost frame is one event rather than a state restated forever. Steady state is unaffected: the tracker only runs when the cross-worker reporter is configured (so a default deployment pays one boolean test on the relay receive path and allocates nothing), it reads no clock while a stream is contiguous, and a stream sitting behind a lost frame stops buffering rather than retaining an entry per subsequent publish. Above the buffer cap the stream keeps the SMALLEST ordinals it has seen, because the report boundary is the lowest arrival above the hole; ordinals evicted there stop being individually auditable, so a second loss inside an already-reported window is folded into that report. The reported count is therefore frames _proven_ lost - a lower bound, not a total. Measured against a real uWebSockets.js app fanning out to 200 real subscribers, the added tracking is unresolvable against the noise floor of that harness: repeated 8- and 16-round runs put the delta anywhere between -3.6% and -0.25% with a relative standard deviation of 5-7%, and in two of three runs the arm doing strictly _more_ work measured faster than the baseline. The honest statement is that no effect is measurable at this precision, not a single sample quoted to two decimal places. Regression tests drive the real relay producer over a real shared-memory ring through the primary's forward loop into a decoding sibling: they assert the frames carry a dense per-topic ordinal from the worker that actually sent them, and that the numbering follows wire order when a batch overtakes a single publish (both red without the fix). The rest cover what must stay silent - late joiners, reordered delivery, duplicate re-delivery, a filled buffer that must not turn a straggler into a loss, and above all a worker that received everything.

## [0.6.0-next.85] - 2026-07-17

### Fixed

- **Restored the deterministic-clock gate (`npm run check`).** The cluster restart supervisor's default monotonic clock read `performance.now()` directly instead of the runtime's injectable `monotonicNow`, tripping the check that keeps every clock and randomness source injectable for deterministic simulation - so `npm run check` (and therefore `npm test`, which runs it as `pretest`) failed on an enforced violation. The default now routes through `monotonicNow`. Runtime behavior is unchanged: the supervisor uses the clock only for duration math (aging a slot's stable uptime), and the two sources differ by a constant offset that cancels in the subtraction.

### Fixed

- **The `upgradeResponse` helper's type declarations now match what actually ships at runtime, closing two import forms that typechecked but were `undefined`.** The `svelte-adapter-uws/upgrade-response` subpath pointed its TypeScript types at the full adapter declaration file (which declares a default adapter export), while the subpath's runtime module exports only the named `upgradeResponse` helper - so `import adapter from 'svelte-adapter-uws/upgrade-response'` compiled but was `undefined` at runtime. Inversely, the package root declared a named `upgradeResponse` that the root runtime never exported, so `import { upgradeResponse } from 'svelte-adapter-uws'` also compiled but was `undefined`. The subpath now has its own declaration file describing exactly the named helper (no phantom default), and the phantom root declaration is removed: `upgradeResponse` is imported solely from `svelte-adapter-uws/upgrade-response`, a tiny standalone module with no build-time dependencies. This is deliberate - the package root is the build-time adapter (it pulls in Rollup and Node built-ins), so re-exporting the helper there would risk dragging build tooling into a runtime bundle, and the usual `sideEffects: false` mitigation is unsafe here because some modules register wire codecs on import. Importing `upgradeResponse` from the package root is now a compile error instead of a silent runtime `undefined`, failing fast at the point of the mistake. A new export-shape gate test asserts the runtime exports and the declarations agree at both entry points, so the two can no longer drift.

## [0.6.0-next.83] - 2026-07-17

### Fixed

- **A server-managed subscription no longer leaks on the server (and its `unsubscribe` hook no longer stays silent) when the last local consumer leaves with the socket open.** The client store's ref-counted release suppressed the wire unsubscribe frame for server-managed topics, on the same reasoning as the subscribe skip: a managed topic never sent a client subscribe frame, so there was assumed to be no wire state to release. That reasoning is wrong for the release direction. The server established real wire subscription state for a managed topic - its stream RPC ran `platform.subscribe` (uWS `ws.subscribe` membership plus the subscribe hook chain) - and the client is the only party that knows when the last local ref dropped. Suppressing the frame left the socket subscribed to a topic nothing consumes: the server kept delivering publishes to it, the server's subscription total drifted upward, and the application's per-topic `unsubscribe` hook - and everything an app chains on it, such as room-enumeration release, presence leave, or ownership succession - never fired for that leave at all. The membership was released only when the whole socket eventually closed, which fires the connection-level `close` hook over the entire subscription set, not the per-topic `unsubscribe` hook. So a live "leave" (dropping the last store subscriber while the connection stays open) leaked server-side membership for the life of the connection. Managed topics now send the unsubscribe frame on last release. The subscribe direction stays asymmetric on purpose: the server drives the subscribe, so a client subscribe frame would be redundant and would race the server's re-subscribe on reconnect - only the release is client-driven. `__`-prefixed framework tap topics keep their existing suppression unchanged (they hold no releasable wire state and the server's `INVALID_TOPIC` gate would reject a frame). Both release paths are fixed: the ref-counted last-release and the public force-`unsubscribe(topic)`. The server release path is idempotent - an absent subscription unsubscribes to a no-op, the membership-set delete reports false so the subscription total cannot go negative, and the unsubscribe hook chain is required to be idempotent - so a framework that also sends its own release frame (to compensate on older adapter versions) is safe: the duplicate is absorbed. If your application registers an `unsubscribe` hook, ensure it is idempotent. Regression tests drive the real client store against a mock socket: a managed topic sends no subscribe frame but emits the unsubscribe frame on last ref release and via force-unsubscribe (both red without the fix), while a `__`-prefixed topic still sends neither.

## [0.6.0-next.82] - 2026-07-16

### Fixed

- **A collaborative document no longer stays stale forever when the LAST edit's fan-out frame is lost.** The CRDT channel's loss detector watches the replica's pending-structs gauge, which Yjs only populates when a causally-later update arrives referencing the missing one - so it recovers every mid-stream drop but is structurally blind to a terminal one: a peer makes an edit, the server-to-subscriber fan-out frame is dropped (backpressure, a poisoned wire lane), and the peer goes idle. Nothing ever references the gap, no resync is scheduled, and that subscriber shows the old document indefinitely - until an unrelated reconnect happens to run the sync exchange. The healthy channel now re-runs the same two-way state-vector exchange on a low-frequency background cadence (`reconcileIntervalMs` on `createCrdtChannel`, default 30 seconds, `0` opts out), which converges every drop path including the terminal one: the server's diff re-supplies whatever is missing, and anything the server lacks re-uploads. An in-sync exchange costs one tiny request answered with an empty diff - nothing is uploaded and state consumers are not re-notified, so steady state stays silent. Two edge cases in the healthy exchange are handled explicitly. A background reconcile that fails on an otherwise-open socket (a transient server blip) marks the channel degraded but keeps it synced - outbound edits must never pause on a healthy connection - so the recovery retry now also fires while degraded and clears the latch without waiting for a reconnect; before this the degraded flag would stick forever (the retry only ran while un-synced and the reconcile chain skips while degraded), silently disabling the terminal-drop protection and surfacing a degraded read on an open connection until an unrelated reconnect. And because the server re-runs its access guard on every sync, the reconcile is the standard delivery path for a mid-session access change: the quiet-in-sync suppression no longer swallows one, so a downgrade to read-only reaches state consumers in the same tick the mutators begin throwing and the UI disables its inputs immediately instead of leaving them live. The module's convergence notes and the README no longer claim the pending-structs detector alone covers every silent-drop path. Regression tests drive the real channel against a scripted server replica: a terminally-dropped update converges without a reconnect or a later edit (red without the reconcile), steady state produces no uploads and no redundant state callbacks, `0` disables the exchange, destroy stops the ticks, a failed healthy reconcile clears its degraded latch through the retry loop with no reconnect, and a mid-session access downgrade arriving on a healthy reconcile reaches the state callback.

## [0.6.0-next.81] - 2026-07-16

### Fixed

- **TLS with the default cert hot-reload (`SSL_WATCH=1`) no longer refuses every real-world client.** Registering the cert's host as a uWS SNI server name creates an empty per-domain HTTP router, and every request on a connection whose TLS handshake matched that name is routed through the domain router instead of the app's main router - where a route miss force-closes the socket with zero response bytes. The hot-reload registered the server names at boot, so any client that sends SNI matching the cert host - which is every browser and every curl against the real domain - had its first request force-closed: a 100% TLS outage in any real deployment, invisible to local smoke tests because hitting the server by IP or localhost sends no matching SNI and stays on the default context. The SNI overlay is now lazy and fingerprint-gated: boot registers nothing (serving is byte-identical to `SSL_WATCH=0`), and only a cert whose fingerprint genuinely differs from the one being served activates the swap - after which the server's full route set (SSR catch-all, WebSocket upgrade, health/readiness, auth endpoint, waiting room, admin) is mirrored onto each host's domain router, and re-mirrored after every subsequent swap, because a reload replaces the domain router with a fresh empty one. Every route registration now flows through a record-and-replay registry so the mirror can never miss a route, and handlers are shared by reference so routing behavior is identical whichever router a connection resolves to. In clustered mode the primary (which terminates no TLS in either cluster mode) just broadcasts the reload; each worker validates and fingerprint-gates its own swap, so watcher double-fires and unchanged-cert broadcasts are no-ops. The gate's baseline fingerprint is captured in the same tick the TLS context loads the certificate, not when the reload arms after the boot sequence - on a real app those are seconds apart, and a renewal completing in that window would otherwise be recorded as already served and gated off until the stale cert expired; an arm-time catch-up reload additionally swaps immediately when the cert on disk already differs from the one being served. A swap that fails after the cert was validated but mid-registration is reported for what it is (some SNI hosts may be unroutable) instead of claiming the previous cert was kept, the fingerprint gate is cleared, and a one-shot timer retries the full swap and mirror shortly - recovery no longer waits on a future file event that may be months away. Verified by real integration tests that build the fixture and prove with fresh TLS handshakes: an SNI-matched request is served at boot (force-closed without the fix), a cert swapped on disk is served to new SNI handshakes without a restart, HTTP and the WebSocket upgrade keep working through the swap, and a non-SNI client keeps the boot cert (the uWS default context is static - the documented caveat); an acceptor-mode cluster proves the same swap end to end through the primary's broadcast, every worker serving the renewed cert on fresh handshakes; and a boot-window test recreates the renewal-during-startup race deterministically and proves the arm-time catch-up serves the renewed cert on the first fresh handshake.

## [0.6.0-next.80] - 2026-07-16

### Fixed

- **A worker slot that flaps a brief `ready` between every crash now exhausts instead of restarting forever.** The per-slot crash-restart budgets reset a slot's attempt count and backoff the moment its worker reported ready, so a slot whose worker booted, went ready for a moment, then crashed - over and over - reset its budget on every recovery and never reached the restart cap that escalates a hopeless slot to a loud primary exit. It flapped indefinitely, burning CPU respawning a worker that could not stay up, with no operator-visible escalation. The budget reset now happens on the slot's next exit, and only when the worker had been ready for at least a stable window (30 s): a genuinely healthy worker that finally dies still earns a fresh backoff and restarts fast, while a worker up for less than the window between crashes keeps accumulating attempts until it exhausts and the primary exits (which an orchestrator restarts cleanly, instead of leaving a zombie slot thrashing). A slot that never reports ready is unchanged - it already accumulated. A brief ready between crashes also no longer zeroes the exponential backoff, so a flapping slot's respawn interval grows rather than hammering at the base delay. The stable window is aged by the primary's monotonic clock (injected, so the scheduling stays deterministically unit-testable) and is the only new per-slot state; the hot path is untouched, since this runs only when a worker exits. Regression coverage added on top of the existing deterministic timer queue: a slot flapping faster than the window climbs to its cap and exhausts, and a crash one millisecond short of the window keeps its accumulated budget - both red against the pre-fix reset-on-ready supervisor.

## [0.6.0-next.79] - 2026-07-14

### Fixed

- **Acceptor-mode cluster workers now run their `init` hook before serving.** On non-Linux hosts (macOS, Windows) a cluster defaults to acceptor mode, and acceptor I/O workers only posted their `getDescriptor()` to the primary, which began listening immediately - they never went through `start()`, which is what fires the documented per-worker `hooks.ws.init`. So on those platforms (and on acceptor-forced Linux) every I/O worker took traffic without running its init: no database connectivity check, no connection-pool warmup, no migration validation, even though reuseport and compute workers all run init before they are considered ready. The acceptor branch now `await start(host, port, { listen: false })` (fire init without binding a listen socket - the primary's acceptor owns the socket and routes connections to this child app by descriptor) before posting the descriptor, so an acceptor I/O worker runs the exact same init as every other role and a throwing init fails the boot loudly instead of registering a half-initialized worker. As a bonus the acceptor path now comes under the boot-deadline watchdog like the other roles. Verified by a real integration test that builds the fixture and spawns it in acceptor cluster mode, asserting an I/O worker fires init (red without the fix: pre-fix the hook never runs for acceptor I/O workers).

## [0.6.0-next.78] - 2026-07-13

### Fixed

- **A cluster worker whose `init` hook blocks the event loop is no longer stranded forever.** The primary's heartbeat watchdog only escalated a worker that had already confirmed ready (its liveness clock starts at zero and the sweep skipped a zero clock as "still starting"), and the per-slot restart supervisor deliberately leaves a still-booting slot alone. So a worker whose `init` hook blocked the event loop - a synchronous infinite loop, a native hang - never sent its first message, was never escalated, and sat booting forever: one slot of permanent capacity loss, reachable purely through a bad init. A naive boot-deadline would be worse, because a zero clock also covers a legitimately slow-but-healthy init (cron registration, dataset warmup, opening external connections), and killing those would crash-loop a healthy boot. The fix keeps both cases apart: each worker now answers the primary's liveness heartbeats from _before_ its `init` hook runs, so a healthy async init - however slow - keeps acking and is never disturbed, while an init that blocks the event loop stops acking and is escalated after a separate, generously-defaulted boot deadline (`WORKER_BOOT_TIMEOUT_MS`, default 60s, `0` disables it, values below two heartbeat intervals are raised to that floor so a mis-sized knob cannot crash-loop a healthy slow boot) that is distinct from the 30s steady-state timeout so a slow warmup whose sync stretches exceed the tight timeout is not false-killed. The watchdog regime flips from boot deadline to steady-state at the ready/descriptor moment, not at the first ack. Relay and control traffic that arrives while a worker is still booting is buffered and replayed in order once the handler graph is live, never dispatched into a half-built graph. Escalation reuses the existing wedged-worker path - the worker is asked to close and exit, and a genuinely event-loop-blocked worker that cannot self-close falls through to the same whole-process `SIGKILL` fallback a steady-state wedge already uses (the orchestrator respawns), because a worker thread holding a uWS App cannot be force-terminated without aborting the process. Two boundaries by design: a warmup that _synchronously_ blocks the event loop cannot ack and so still reads as wedged, and an `init` that hangs while keeping the event loop _free_ (an `await` that never resolves) keeps acking and is treated as alive - catching that is a readiness concern, not a liveness one. The health verdict moved into a standalone, unit-tested module that the deterministic cluster simulator drives through the same decision it ships, with an init-wedge fault that reproduces the stranded slot and its recovery.

## [0.6.0-next.77] - 2026-07-13

### Fixed

- **A message published during a resume no longer vanishes into the reconnect gap.** When a client reconnects and re-subscribes with a recovery offset, the server runs the resume hook (a replay backend gap-fills the tail the client missed) and only then subscribes the connection to live updates. If that hook awaited I/O - as a Redis or Postgres replay backend does - a message published in the window between the backend read and the live subscribe was lost: past the read, not yet live, so the client never saw it and had no way to know. The recover-on-subscribe cutover (single and batch) now opens a per-connection buffer before the resume runs; every publish path holds frames for a resuming topic in that buffer, and once the connection goes live the held frames are flushed to it in order, before the acknowledgement. Held frames are skipped when the resume already covered them, so nothing is delivered twice: a resume backend that reports the highest sequence it delivered (by returning `{ [topic]: seq }`) gets exact de-duplication, and a backend that reports nothing is delivered at-least-once - a possible duplicate, never a gap. A synchronous in-memory resume never yields the event loop, so its buffer stays empty and delivery is byte-identical to before; on the publish hot path the whole mechanism is one map-size check, measured free.

## [0.6.0-next.76] - 2026-07-13

### Fixed

- **A cluster no longer loses a worker permanently when two workers restart at once.** The crash-restart backoff, the attempt counter, and the pending-respawn timers were single values shared across the whole worker cohort, and any worker reaching its ready state reset that shared budget and cleared EVERY pending respawn timer. So when two workers crashed at nearly the same moment, the first replacement to come back up cancelled the second dead worker's still-pending respawn - and capacity stayed permanently reduced by one, with no further restart ever scheduled. Each worker slot (a stable `role` plus index that a replacement re-occupies with the same replayed state) now carries its own attempt count, exponential backoff, and respawn timer, so a slot only ever resets or reschedules itself and readiness is slot-local. The heartbeat sweep also runs a reconciliation that reschedules any slot left with no live worker, no booting worker, and no pending respawn - a self-heal for the live-plus-spawning-plus-pending-equals-desired invariant that a booting slot never trips. One consequence of per-slot budgets: the restart-attempt cap that hard-exits the primary is now per slot (a single slot crash-looping past the cap exits), rather than a shared count across all workers, so unrelated occasional crashes across different slots no longer add up to a shutdown. Restart scheduling moved into a standalone, fully unit-tested module (deterministic timer queue, including a two-worker-flap regression that reproduces the lost slot).

## [0.6.0-next.75] - 2026-07-11

### Fixed

- **The client now reacts to the browser going offline and online.** The connection detected a dead socket only through its silence timer (about 150 s) plus a suspend-gap check, so a real network drop - or an emulated one (`context.setOffline(true)` in a test) - that fires the browser `offline` event without closing the socket left the status stuck at `open` for the full silence window: the offline queue never armed and the status indicator stayed lit. The client now listens for the window `offline` / `online` events. `offline` closes a live socket at once (or, with no live socket, sets `disconnected` directly) so the normal close path flips the status and schedules the reconnect, which is also what arms the realtime offline queue; `online` skips the remaining backoff and reconnects immediately, mirroring the tab-visible recovery. Listeners are registered only when `window.addEventListener` exists (never during SSR) and are removed on `close()`.

## [0.6.0-next.74] - 2026-07-11

### Added

- **`server.track(clientSocket)` on the test server.** Registers a client socket the server owns for teardown: `close()` now terminates every tracked socket and awaits its terminal event (bounded), then joins the server-side close callbacks of its own connection kicks, before releasing the port. A resolved `close()` means the sockets are gone, not merely told to go - an in-flight client dial can no longer race the next test's `listen()` on a recycled port, which is the cross-test contention behind parallel-pool flakes.

### Fixed

- **The cross-worker relay ring can no longer sleep through its only wake-up.** Both sides of the shared-memory ring re-loaded the peer's index immediately before registering their `Atomics.waitAsync` - so a peer that advanced (and sent its one notify) between the full/empty verdict and the registration was never heard: the wait was armed against the post-advance value and slept forever, a writer stall growing an unbounded spill queue behind a frozen relay direction, or a reader stranding delivered bytes in the ring. Each wait now registers against the exact index value its verdict was computed from, making `waitAsync`'s atomic compare the predicate re-check: an advance in the gap fails the compare and retries immediately. No new atomics on the hot path; deterministic gap-interleaving regression tests cover both directions.
- **CRDT client entries no longer reach the server runtime.** `plugins/crdt/codec.js` imported `WS_CAPS` from the `runtime/utils.js` barrel, which re-exports server utilities that import `node:` builtins (`node:perf_hooks` via the runtime seam, `node:fs` via the fd-limit probe). Any browser bundle importing `plugins/crdt/channel` or `plugins/crdt/client` - which is every app using the framework's `doc()` codegen - failed its production build with `"performance" is not exported by "__vite-browser-external"`, because Rollup's missing-export check runs before tree-shaking. The codec now imports the symbol from its side-effect-free leaf module (`runtime/utils/ws-symbols.js`). A regression test walks the static import graph of every client-safe export subpath and fails if any reachable module imports a `node:` builtin, so no client entry can regress this way again.

### Documentation

- **`protocol.schema.json` scopes itself to core-owned frames.** The schema described itself as covering "every control frame" while the protocol's own forward-compatibility rule passes unrecognized application control frames through to higher layers - so a validator taking the description literally rejected legitimate ecosystem traffic (svelte-realtime's connect-time revision advertisement). The description now states the core-owned scope, the frame-level pass-through rule, and how to compose with a layer's companion schema (svelte-realtime ships `svelte-realtime/protocol.schema.json`).

## [0.6.0-next.73] - 2026-07-10

### Added

- **Compact binary fan-out for the game lane (`game.fanout:1`).** The `game` lane's server-to-client fan-out could be sent compact only in the ingress direction (a granted publisher's `game:1` binary input); every subscriber still RECEIVED the JSON data-event envelope, so a high-frequency input echoed to a room paid the envelope's fixed overhead (the topic string repeated per event per subscriber, text-encoded numbers) on a payload that is a handful of numbers. A subscriber now advertises `game.fanout:1` in `hello.caps` and receives the event as the `0x03` topic frame carrying a single value-codec value `[event, data]` (or `[event, data, id]`) - the exact byte-inverse of the `game:1` ingress twin, one codec table for both directions. The JSON lane stays the conformance oracle: the compact frame decodes to the identical `{event, data, id?}` a JSON subscriber of the same room receives, with the identical room seq; the sender is excluded on both forms; a subscriber that does not advertise the capability keeps receiving the JSON envelope byte-identically. The reference client advertises it automatically (like `wire.ingress:1`), so it is zero-config; it is independent of `wire.ingress:1` (a connection may decode compact fan-out while sending JSON inputs, or the reverse). PROTOCOL.md freezes both carriages - the WebSocket form (section 6.7) and the WebTransport datagram form (section 14.6, reserved id `0` = the session's bound room, so one client decoder serves both); this release implements the WebSocket carriage. Conformance bytes: `test-vectors/game-fanout-compact.json`.

## [0.6.0-next.72] - 2026-07-10

### Added

- **`TRUSTED_PROXIES` - mechanical trust for forwarded client addresses.** `ADDRESS_HEADER` has always been trusted verbatim: any peer that can reach the listener directly could send the header and spoof its rate-limit identity (the per-IP upgrade limiter and the `plugins/ratelimit` per-message limiter both key on the resolved address) and `getClientAddress()`. `TRUSTED_PROXIES` is a comma-separated allowlist of proxy addresses or CIDR ranges (IPv4 + IPv6, IPv4-mapped forms normalized): when set, the header is honored only when the DIRECT socket peer is in the list - a claim from anyone else is ignored in favor of the socket address, with a one-shot warning naming the untrusted peer. Applies uniformly to the WebSocket upgrade path, the auth endpoint, and SSR `getClientAddress()`. Unset keeps the historical behavior byte-identical; a malformed entry throws at boot rather than failing open or closed unpredictably.
- **`PROXY_PROTOCOL=1` - native PROXY protocol v2 support.** uWS parses a PP2 preamble natively and the adapter now consumes it: when enabled, the preamble's source address becomes the effective client address for rate limiting and `getClientAddress()` (the LB-without-HTTP-headers deployment shape: HAProxy `send-proxy-v2`, AWS NLB). Gated on `TRUSTED_PROXIES` when that is set, because uWS accepts a preamble from ANY peer - ungated, a direct client could spoof its address exactly like an ungated header. An `ADDRESS_HEADER` on top composes: the header (from a trusted app proxy) wins over the PP2 address (from the outer LB). Verified against the shipped binary with a live socket test (preamble parsed, absent preamble reports empty).

### Fixed

- **Prefixed env validation knows the full knob set.** `CLUSTER_RELAY_RING_KB`, `RESTART_ON_STATE_DIVERGENCE`, and `STATE_HASH_EPOCH_MS` were read via `env()` but missing from the expected-name set, so configuring any of them with an `envPrefix` threw a spurious "should change envPrefix" boot error.

## [0.6.0-next.71] - 2026-07-10

### Added

- **CRDT document authority: `drop(topic)` - whole-document erasure.** The authority could release references and destroy everything, but nothing could erase ONE topic's replica on demand: a right-to-erasure flow (a forgotten user's edits are merged into the document with no per-user attribution, so dropping the whole document is the only true erasure) had no primitive to call. `drop(topic)` erases the topic's replica regardless of live references, cancelling its persistence schedule and destroying the doc WITHOUT running any store - an erasure must never write back the state it is erasing. Live holders observe the topic as unloaded from the next call on (`applyUpdate`/`diff` return null, later `release` calls no-op), and a subsequent `acquire` cold-loads from persistence - deleting the persisted copy is the `persist`-store owner's half. Consumed by `svelte-realtime`'s `live.forget(userId, { cascade: { crdt: [...] } })`.

## [0.6.0-next.70] - 2026-07-09

### Changed

- **The cross-worker publish relay moved off structured-clone `postMessage` onto shared-memory rings.** The cluster relay is a star through the primary: a publishing worker hands over its batch, and the primary re-sends every message to every other worker - each hop a structured clone, so a hot topic on an N-worker box paid O(N) clones per publish on the primary, the star's scaling bottleneck. Each worker now shares two SharedArrayBuffer rings with the primary (one per direction), each a single-producer/single-consumer BYTE STREAM woken by `Atomics.waitAsync` (no polling): the publisher encodes each relayed message to bytes ONCE, the primary forwards the framed bytes VERBATIM (a memcpy - it never parses relay traffic), and only the receiving workers decode. Byte-stream semantics make the hard cases structural: order is exactly preserved (one stream per direction, no second path to race on), a full ring spills into the producer's pending queue and flushes as the consumer drains (the same unbounded-queue-under-lag behavior `postMessage` had, minus its allocations), and a frame larger than the whole ring streams through in pieces. Measured on the A/B harness (`bench/relay-ring-ab.mjs`, 1 producer through the primary to 3 consumers, realistic ~250 byte envelopes): end-to-end throughput 202k -> 422k messages/s and primary forwarding cost 4210ns -> 772ns per message (5.5x) - and since the primary's cost is the piece that grows with worker count, the gap widens on bigger boxes. Ring traffic also proves a worker alive to the primary's heartbeat monitor, exactly as the `postMessage` traffic it replaces did. Sized by `CLUSTER_RELAY_RING_KB` (default 256 per direction per worker); `CLUSTER_RELAY_RING_KB=0` restores the `postMessage` path byte-identically. Payloads cross with JSON semantics, which is what the relay contract already guarantees (the `data` field is JSON-serializable by construction - the envelope traveling beside it is the same value as a JSON string). Control traffic (heartbeats, TLS reload, shutdown, state-hash reports) stays on `postMessage`.

## [0.6.0-next.69] - 2026-07-09

### Added

- **Outbound webhooks cache the validated DNS pin per host (`pinCacheMs`, default 30s with the built-in resolver).** Every delivery - and every redirect hop - re-resolved the target host and re-validated the address set before pinning the socket, so a delivery burst to one endpoint paid one DNS round trip per attempt for an answer that had just been validated. The SSRF gate now keeps a small per-config cache of VALIDATED pins: within the TTL, a delivery (or a redirect hop back to an already-validated host) reuses the pinned address set and skips the resolution entirely. The security posture is unchanged by construction - only successful validations are cached (a failed resolution is retried on the next delivery, never remembered), the cache is keyed by host AND range-check mode inside a per-config map (one webhook's allowlist or `urlMode` can never leak into another's), the map is bounded so attacker-steered redirect hostnames cannot grow it, and serving a cached pin is strictly rebinding-safe: the socket still reaches only addresses that passed the range check, and a DNS answer that changes mid-window cannot redirect an in-flight burst at all. `pinCacheMs: 0` disables; a custom `resolve` defaults the cache off (a caller-supplied resolver owns its own rotation semantics) and opts back in with an explicit `pinCacheMs`.

### Fixed

- **The TLS-reload test suite now resolves `openssl` at collection time, with a Git-for-Windows fallback.** Test-only: the suite's skip-when-no-openssl guard was decided before the availability check ran, so on a machine without `openssl` on the shell PATH the nine certificate-backed cases failed on missing fixtures instead of skipping; the binary is now discovered at module scope (checking the Git for Windows bundle on win32), so the cases run where a usable openssl exists anywhere and skip cleanly where none does.

## [0.6.0-next.68] - 2026-07-09

### Added

- **The smooth wire's steady state got cheaper twice: a repeat-set field delta and a batched update frame.** Under steady motion the field-delta frame re-lists the same changed-field references tick after tick - with a typical game record that is a fifth to a third of every frame's bytes spent saying "the same fields as last time". The codec now remembers each entity's last delta field set on both ends (the same advance-on-delta / freeze-on-fallback / clear-on-remove / reset-on-reconnect discipline the baseline keeps), and a frame whose changed numeric set repeats it - no literals, no removals - elides the field list entirely: the byte-aligned head collapses to the key reference and the temporal bit-stream values. And where every entity update used to travel as its own frame (own opcode, own stamp, own WebSocket frame, own send), one tick's updates can now travel as ONE frame per connection: a shared stamp, then per entity a sub-op byte plus that op's head, with every entity's numeric values in a single trailing bit block. The platform grew the fan-out to feed it - `publishWireBatch` (one binary frame per capable connection, the per-entry JSON envelopes byte-identical to N `publishWire` calls for everyone else, per-ENTRY sender exclusion so each update can suppress its own author, per-entry seq/relay/stats, and the same poison-to-JSON degradation on a dropped frame or announce) and `sendWireBatch` (the per-subscriber twin for culled delivery walks), mirrored on the dev and test-server platforms per the parity contract. The smooth client splits a batch frame back into per-entity updates sharing the frame's stamp and one receive time, exactly as N back-to-back single frames would have landed; own-key rebase, remote-set merge, and the stall detector behave identically. Encode hardening rode along: a field-delta literal is now pre-serialized before any dictionary state is touched, so a value the codec cannot carry (a throwing getter, a cyclic structure) declines to JSON with both ends' dictionaries provably untouched instead of risking a mid-frame intern. Both forms are additive opcodes inside `smooth.protocol:1`'s schema (the decoder-superset discipline the field delta itself shipped under); JSON delivery, single-frame encoding, and every other consumer are byte-identical to before.

## [0.6.0-next.67] - 2026-07-09

### Added

- **The cursor wire gains a temporally-streamed position form (`cursor.protocol:5`, schema version 4): each cursor's position travels bit-packed against its own previous sample instead of as two raw float32s.** The smoothing cursor pipeline is the highest-cadence stream in the framework - every pointer move, for every visible cursor, to every subscriber - and after the short-id dictionary and the delta-coded stamp, the eight bytes of raw position per frame were the remaining cost. On the new rung of the negotiation ladder, positions ride the same general temporal value codec the smooth entity wire uses (`src/runtime/wire-stream.js`): whole-pixel drift lands on the integer delta-of-delta path at a few bits per axis, fractional drift on the XOR path at a couple of bytes, and a coalesced `bulk` carries byte-aligned keyrefs plus one trailing bit block. The streamed value is the float32-narrowed position (`Math.fround`), so a client decodes exactly the value the float32 wire would have delivered - the precision contract is unchanged across every schema version, only the bytes drop. The per-cursor stream state lives on the per-connection dictionaries with the established discipline (in-order, reset on reconnect, untouched on a JSON-fallback frame, cleared by that cursor's `remove` on both ends so a re-appearing cursor starts fresh, released on detach). The capability is advertised exactly where the time capability already is - by smoothing pipelines only (the lazy main-connection advert and the dedicated worker's hello) - and the negotiation ladder stays linear: stream requires time requires dictionary, and a connection missing any rung stays on its highest complete form, so every client keeps receiving exactly what it negotiated. Registered in the PROTOCOL.md capability table; no protocol revision (additive token, the registry's designed extension point). The presence wire deliberately does not adopt the stream: its codec is stateless encode-once-send-many by design (arbitrary JSON at roster cadence, not fixed-cadence numerics), where per-connection stream state would trade CPU for nothing.

- **PROTOCOL.md section 14: the WebTransport binding - the `game` lane carried over QUIC datagrams.** A spec-only addition (no adapter code changes; the JS runtime does not terminate QUIC): it defines how a WebTransport session (extended CONNECT over HTTP/3) joins exactly one room at accept - the CONNECT request is the upgrade analogue and the same trust boundary, with the publish grant still a server-side primitive distinguishing publisher from spectator sessions - and how the frozen relay frames ride datagrams with zero new wire: a client-to-server datagram is either the section 6.6 binary frame byte-for-byte (the `ingressId` slot carries the reserved `0`, because the session itself is the binding and needs no `ingress-bind` handshake) or the JSON `game` frame, demuxed by first byte exactly like section 1; fan-out to a session is the ordinary section 4 data-event envelope, byte-identical to what a WebSocket subscriber receives, so rooms are transport-agnostic and a WebSocket connection and a WebTransport session share one room, one relay, one seq order, and one set of conformance vectors. Loss is skipped, never repaired (the room seq makes gaps visible; resume does not apply), hello/caps/batch/lease and server-to-client `0x03` frames do not apply, and streams are reserved for future additive lanes. The section is normative for any runtime that terminates QUIC; the committed section 3.10 vectors are the behavioral oracle its relay output is proved against.

## [0.6.0-next.66] - 2026-07-08

### Changed

- **The smooth entity wire now sends an object state as a FIELD DELTA - and compresses each numeric field's value against its own history - instead of re-serializing the whole state every tick.** A smoothed topic broadcasts every entity's state to every viewer each tick; at scale that fan-out is bandwidth-bound, and re-sending unchanged fields (the velocity, the health, the weapon, the field NAMES themselves) plus a full eight-byte double for every coordinate is the bulk of it. A per-tick object state now travels as only the fields that changed plus the names of any that dropped out, split by value type: `[nNumChanged][numFieldRef]* [nLitChanged][litFieldRef,value]* [nRemoved][fieldRef]* [numericBitStream]`. Field NAMES ride a second per-connection short-id dictionary (shared across every entity on the connection, because a topic's entities share a field vocabulary, so a name is interned once and then costs a 1-2 byte ref). NUMERIC field values ride a temporal value stream (delta-of-delta for integers, XOR-against-previous for other finite numbers) bit-packed in a trailing block: a coordinate that drifts a little costs a handful of bits, not eight bytes, and a value moving at a constant rate costs a single bit. Every other changed field rides the JSON-faithful value codec inline. A field counts as changed by the same reference-inequality the authority's own change detection already rests on (a functional update makes a changed value a new reference), so an unchanged field costs nothing and an unchanged entity's whole frame is the op, the stamp delta, the key ref, and three zero counts. The reconstruction is byte-identical (deep-equal) to the previous full-state round trip. The per-connection baseline and the per-field numeric stream state follow the same discipline as the key dictionary and the delta stamp: they advance only on a delta frame, are left frozen by an exactly-`{x,y}` fast-path frame, a full array/primitive frame, or a JSON-fallback frame (so an object stream that resumes after one still deltas against a basis both ends hold), a field's numeric stream resets when it is sent as a literal or removed, the whole entity clears on removal, and everything resets on reconnect. The exactly-`{x,y}` fast path, the acknowledgement frame, the JSON fallback, and array / primitive states are unchanged, and the change is a decoder superset with no capability or schema-version bump - a client reads both the old full-state frames and the new delta frames, so a new client still decodes an old server through a rolling upgrade. The cross-instance cluster relay carries logical events (not encoded bytes) and re-encodes per connection on each instance, so the delta is active cluster-wide with no coordinator change. The temporal codec is a general primitive (`src/runtime/wire-stream.js` over a new `src/runtime/wire-bits.js` bit reader/writer), reusable by any fixed-cadence numeric stream; the smooth wire is its first consumer. Local measurement: a representative ten-field entity whose position moves each tick drops the steady-state frame to a fraction of the full field set.

### Added

- **A client-driven relay lane (the `game` lane): an authorized client can publish to the one room it was granted, with the server stamping the ordering seq and fanning out to the room.** Until now only server code published to a topic; the game lane is the wire for a real-time session where every participant emits input (a game, a shared simulation) rather than one server-side author. `platform.grantPublish(ws, topic)` binds a connection to publish to exactly one room - the trusted server-side dual of `platform.subscribe`, typically called at join once your guard authorized the connection; `revokePublish(ws)` clears it and `publishGrant(ws)` reads it back. A granted client sends `{ type: 'game', event, data, id? }` carrying **no topic** - the server derives it from the grant, so a client can never publish to a room it did not join nor spoof another room. The server stamps a monotonic per-room `seq` (the session-home sequencer) and fans the frame out to the room's other subscribers as an ordinary event envelope `{ topic, event, data, seq, id? }` with the **sender excluded** (echo suppression - it already holds its own input and predicts locally) and the client-chosen `id` echoed for prediction-reconcile. An ungranted frame is answered to the sender with `{ type: 'game-denied', reason: 'FORBIDDEN' }`; a granted-but-malformed frame (a non-string `event`) with `reason: 'INVALID'`. `platform.publishGame(senderWs, topic, event, data, id?)` is the same relay from server code (pass `senderWs: null` to include everyone, e.g. a bot frame), returning `{ seq, delivered }`. The lane is additive and unknown-type-safe, so it needs no capability token; it is mirrored across all three platforms (production, `createTestServer`, the Vite dev server) and typed on `Platform`. The wire is frozen in PROTOCOL.md section 3.10, schema'd in `protocol.schema.json` (`game` / `game-denied`), and pinned by a committed conformance transcript (`test-vectors/game-relay.json`, exercised end-to-end in `test/relay-oracle.test.js`). A compact `0x03` **binary twin** of the same semantics also ships (PROTOCOL.md section 6.6): a `wire.ingress:1` client binds an ingress id to kind `game:1` (no topic in the frame - topic-from-grant) and sends `[0x03][schemaVersion][ingressId][seq][encodeValue([event,data,id?])]` over the existing `0x03` ingress transport, using the same generic value codec the smooth command channel uses; the server decodes and fans out byte-identically to the JSON lane (the test drives a real binary frame end to end, and a byte-exact vector is committed for a third-party implementation to A/B against). Binary ingress is opt-in, so a JSON-lane client stays complete and correct.

## [0.6.0-next.65] - 2026-07-07

### Added

- **`platform.pressure` now reports outbound-queue backpressure telemetry, so the silent per-subscriber shedding under fan-out overload is finally observable.** `publish` fans out in native C++ and drops frames past `maxBackpressure` without any JS-visible signal; the 1 Hz pressure sampler now folds a bounded, sample-capped walk of `getBufferedAmount()` into two new `PressureSnapshot` fields: `maxBufferedBytes` (the worst per-connection outbound queue seen this tick - compare against `maxBackpressure`, 1 MB default, to gauge how close the worst consumer is to being shed) and `backpressuredConnections` (how many sampled connections hold a notable, over-64 KB queue). The walk is capped at 1024 connections per tick so the cost is fixed even on a large worker (a micro-bench confirms ~2.7 us/tick flat from 1k to 100k connections, versus a naive uncapped walk's 226 us/tick at 100k), and it runs only on the sampler tick, never on the publish path. Both fields surface on `platform.pressure`, `platform.onPressure(cb)` snapshots, and `platform.introspect()` (so svelte-realtime's `introspect()` inherits them under `transport`), plus two optional metrics gauges (`ws_backpressure_max_bytes`, `ws_backpressure_connections`). A new opt-in `websocket.closeOnBackpressureLimit` (default `false`, zero-config behavior unchanged) closes a chronically wedged consumer instead of shedding its frames forever - the bounded-recovery knob for a slow client that would otherwise tie up buffer memory. A `bench/ws-fanout-recovery.mjs` proves the shape end-to-end (overload raises the telemetry; a load drop clears it within a bounded window).
- **The deterministic simulator gains a committed golden-set regression gate (`buildSimGoldens` / `checkSimGoldens` on `svelte-adapter-uws/sim`).** The seed swarm proves each seed reproduces itself, but a code change that deterministically alters sim behavior still reproduces the new behavior, so the swarm passes it unnoticed. The gate pins the per-seed structural fingerprints to a committed baseline: `buildSimGoldens` projects a swarm result into a corpus (`{ seed, weight, fingerprint, digest }` plus the swarm config the fingerprints are only comparable under), and `checkSimGoldens` re-runs those seeds and fails when the weighted sum of drifted fingerprints exceeds a budget (default `0` - any drift on a weighted seed fails; a `weight: 0` seed is a watch-list entry that reports but never gates). A `npm run sim:golden` runner verifies the committed corpus and `--update` re-blesses it (refusing a broken or nondeterministic swarm), a committed corpus covers single-worker and cluster runs, and a CI golden-verify step joins the sim-swarm workflow. An intentional behavior change is blessed by re-running `--update` and committing the corpus diff.
- **TLS certificate hot-reload now works across a cluster, not only single-process.** When SSL is configured in a clustered deployment, the primary watches the cert directory and, on a renewed cert, broadcasts a reload to every worker so each swaps its own app's SNI context in place; in acceptor mode the primary also reloads its own acceptor context. The listen socket is never re-bound and live connections survive, exactly as in single-process mode. This supersedes the next.64 note that automatic reload was single-process only - a cluster no longer has to restart to pick up a renewed cert. A non-SNI / unmatched-SNI client still keeps the boot-time cert until a restart (the uWS default context is not hot-swappable).

## [0.6.0-next.64] - 2026-07-07

### Added

- **Graceful shutdown now disperses client reconnections instead of stampeding the replacement, via `platform.adviseReconnect()` and an additive `reconnect` control frame.** A draining or restarting node sends `{type:'reconnect',windowMs,afterMs?}` to each client immediately before closing it; the client reconnects on its own jittered delay in `[afterMs, afterMs + windowMs)` (failure class `'DRAIN'`) instead of all reconnecting in one backoff window and hammering the replacement. `platform.adviseReconnect({ windowMs, afterMs?, close?, filter? })` broadcasts the advisory (optionally to a filtered subset), optionally closes each connection with a graceful `1001`, and returns the count advised; graceful `shutdown()` calls it automatically when `RECONNECT_DISPERSAL_MS > 0` (default `5000`; `0` restores the exact legacy shutdown). The frame is additive and unknown-type-safe - an old client ignores the unknown type and falls back to normal backoff - so the protocol revision is unchanged (PROTOCOL.md 3.9). A `'DRAIN'` `FailureClass` lets a consumer show "server updating, reconnecting" distinctly from a generic drop.
- **TLS certificates now hot-reload: a renewed cert on disk (certbot / cert-manager) is served WITHOUT dropping the listen socket or live connections.** When SSL is configured the server auto-discovers the certificate's SAN host(s), registers them as uWS SNI server names, and watches the cert directory; on a renewal it re-reads the cert and swaps the SNI context in place, so new handshakes get the fresh cert while the listener and in-flight connections are untouched. The cert + key are validated (parse + pairing) BEFORE the swap, so a half-written file keeps the previous certificate and TLS never drops on a partial write. Default ON when SSL is set (`SSL_WATCH=0` opts out); `SSL_RELOAD_DEBOUNCE_MS` (default `500`) coalesces a burst of file writes and `SSL_SNI_HOSTS` overrides the SAN discovery. A non-SNI / unmatched-SNI client keeps the boot-time cert until a restart (the uWS default context is not hot-swappable), which covers the SNI-sending majority. The debounce runs through the injectable runtime timer, so it stays deterministic under a seeded harness. (Automatic reload is single-process in this release; a cluster deployment reloads on restart - the cluster primary-broadcast reload is a follow-up.)
- **`svelte-adapter-uws/safe-url` now exports `classifyAddress(ip)` and `isAddressSafe(ip)` - the address-level companions to `checkUrl` / `isSafeUrl`.** A caller that already holds a bare IP (a resolved DNS result, a proxied forwarded-for hop, a socket peer) no longer has to wrap it in a throwaway `http://<ip>/` URL just to reach the SSRF range check. `classifyAddress(ip)` returns the blocked reason (`loopback`, `rfc1918`, `link-local`, `metadata`, `ula`, `unspecified`) or `null` when the input is a real, public IP literal, accepting every IPv4 encoding (dotted-decimal / octal / hex / short-form / bare-integer) and both bracketed and bare IPv6, including the IPv4-mapped forms that unwrap and re-check. `isAddressSafe(ip)` is the boolean gate (`classifyAddress(ip) === null`). Crucially `null` means "a real public IP literal" and nothing else: a DNS name returns the new `'not-an-ip'` reason and a malformed literal returns `'parse-error'`, so a hostname can never masquerade as a safe address (resolve it first, then classify). The webhooks SSRF pin now classifies its resolved address directly instead of re-wrapping it into a probe URL.
- **The deterministic simulator gains an end-of-run steady-state hypothesis layer, folded into `result.invariantViolations`.** Alongside the existing per-step invariant auditor and the quiescent convergence / misdelivery checks, a lightweight trajectory recorder (a running virtual-clock monitor, a publish-time subscriber-set log, and the drained / pending signals - all O(1) per step) feeds a set of pure whole-run predicates evaluated once at end-of-run: the virtual clock never steps backward (`steady.time-nonmonotonic`), the run drains to zero pending refed work on its own (`steady.no-quiescence`), each client's per-topic broadcast seq is strictly increasing (`steady.delivery-nonmonotonic`), every publish-time subscriber eventually receives its topic (`steady.starvation`), and no topic is left in the index with no subscriber (`topic.zero-subscribers`). Delivery-monotonic is guarded off under reorder / duplicate / corrupt faults (and a multi-originator cluster topic) and starvation under drop / corrupt faults (and a lost cluster worker), so a legitimately-faulted interleaving never turns the swarm red; the subscriber set is captured at publish time, so a mid-run subscribe / unsubscribe stays sound. The predicates stay pure (no clock / RNG / timer) so a folded steady-state violation reproduces bit-for-bit under its seed, and a clean run's `invariantViolations` stays byte-identical (`[]`), so the swarm oracle, `replaySim` self-gate, and CI sim-swarm cover them for free with no workflow change.

## [0.6.0-next.63] - 2026-07-07

### Added

- **`platform.publish`, `platform.publishWire`, and `platform.publishBatched` now accept `seq: <number>` to stamp an explicit, externally-authoritative sequence on the broadcast frame.** The `seq` option widens from `boolean` to `boolean | number`: `seq: false` still omits the seq, an absent option (or a legacy truthy `seq: true`) still uses the in-memory per-worker counter, and a `number` (which must be a positive integer - the wire reserves 0 and rejects non-integer / negative / non-finite values rather than corrupting the frame) stamps that exact value onto both the JSON envelope and the `0x03` binary frame without advancing the counter. This is the hook a replay backend uses to put the broadcast frame and its buffer on ONE authoritative sequence space: a client resuming after a reconnect then gap-fills against the same offsets the live stream carried - across a process restart, or (with the Redis / Postgres replay layer) across cluster instances - instead of deduping against a divergent counter and duplicating or dropping events. An explicit numeric seq is recorded through the monotone-max guard, so an out-of-order authoritative seq cannot regress the cross-worker convergence detector; the in-memory replay plugin threads its own buffer seq through automatically. The common no-seq publish is unchanged and byte-identical.
- **A reusable resource-leak harness, exported from `svelte-adapter-uws/sim`.** A pure, deterministic trend kernel - `detectGrowth(samples, opts)` - decides whether a numeric series is leaking by a three-way vote (least-squares slope AND monotonic fraction AND total delta), so a noisy or sawtooth series is never mistaken for a leak. Around it: `createResourceTracker(probes)` samples many named series and `analyze()`s each; `assertNoResourceGrowth(tracker)` throws a `LeakError` (carrying `.leaks`) when any series climbs; `structuralResourceProbes(sources)` builds probes over live Map/Set sizes (deterministic) and `processResourceProbes({ forceGc })` over heap/rss/handles (for a real-server harness). The deterministic simulator gains an opt-in `leakProbe: true` that samples structural sizes each step into `result.resourceGrowth` and folds it into the `replaySim` reproducer gate, plus a `churnScenario` helper (open+close N clients across many steps) whose clean shed proves zero growth. Production gains an opt-in, observe-only trend auditor via the `resourceGrowthAuditIntervalMs` ws option (default `0` = off): it emits `framework_resource_growth_suspected_total{resource}` and one throttled warning, and never asserts or terminates.

### Fixed

- **A `CONTROL_FRAME_TOO_LARGE` reject is now counted in the connection's outbound traffic totals.** The oversized-control-frame reject wrote its error frame with a raw socket send that skipped the per-connection outbound accounting, so a close hook's `messagesOut` / `bytesOut` under-counted by that one small error frame while every sibling control-demux send (welcome, lease-ok, resumed, ingress-ok, subscribe-denied) counted its bytes. The reject now routes through the same counter, symmetric with its siblings, in the production handler, the testing server, and the dev-server middleware alike.

## [0.6.0-next.62] - 2026-07-06

### Changed

- **`platform.topic(name)` now returns a referentially-stable helper per name.** Repeated `platform.topic(name)` calls previously allocated a fresh seven-closure helper object every time; they now reuse one cached helper per topic name (a small per-server LRU, cap 256), cutting allocation churn for apps that scope by topic in a hot loop. Behavior is otherwise identical - the same methods, forwarding to the same `publish` - and the reference stability is a strict improvement.

### Fixed

- **A backgrounded browser tab no longer force-reconnects a healthy WebSocket.** The client's zombie-connection detector closes a socket that has gone silent past the server-timeout window; but when a browser throttles the 30s check timer in a backgrounded tab, that "silence" is the client's own frozen loop, not a dead server, so the check could needlessly tear down a perfectly live connection. The detector now notices when its own tick fired far later than its interval and suppresses only the pure-silence close in that case (re-measured on the next on-cadence tick); a genuine OS sleep still reconnects and resumes via the unchanged suspend-gap path.
- **A clustered worker no longer aborts the whole process on teardown (crash under sustained fan-out).** A worker thread holds uWebSockets.js's raw libuv socket handles, which Node does not track, so tearing a worker down while it still held its uWS App aborted the entire process with `uv_loop_close() while having open handles` (`node::worker::WorkerThreadData::~WorkerThreadData`). It fired on graceful shutdown, on a hard-tier `fatal()` restart, and - the trigger seen in the wild - when the primary force-terminated a busy-but-alive worker whose heartbeat ack was starved behind a flood of publish/relay traffic under high topic fan-out; after the abort the reuseport cluster stopped accepting new upgrades. Fixed on three fronts: (1) every worker exit now closes the uWS App (dropping the listen socket + accepted connections) and lets one real event-loop turn run so libuv's close callbacks complete before `process.exit`, which exits cleanly even with live connections; (2) the primary asks a worker to close-and-exit itself instead of calling `worker.terminate()` (which aborts), falling back to a whole-process `SIGKILL` (clean orchestrator respawn) only if a genuinely wedged worker cannot self-close; and (3) the heartbeat monitor now treats ANY inbound worker message (including publish/relay) as proof of life, so a saturated worker is never false-flagged as unresponsive. A `fatal()` in a worker is routed through the same clean-exit path. Single-process (non-clustered) deployments are unaffected. Verified on Linux (the only platform reuseport runs on): the pre-fix path reproduces the exact abort, the fix exits 0 with a live connection.

## [0.6.0-next.61] - 2026-07-06

### Added

- **`plugins/webhooks` gains injectable delivery controls: a retry budget and an endpoint-ejection breaker.** Outbound webhooks fan out one fire-and-forget delivery per subscribed endpoint per publish, with no ceiling - so a busy topic pointed at a slow or failing endpoint can pile up unbounded in-flight retries. `deliverWebhook(config, topic, event, data, hooks)` now takes an optional fifth `hooks` argument to bound that: `hooks.breaker` fast-fails an ejected endpoint (an open circuit returns a terminal `attempts:0` outcome without touching the network, so the caller dead-letters it) and records each terminal result, and `hooks.budget` rations retry _amplification_ - a token consumed before each backoff, distinct from the per-delivery `attempts` cap, so a storm of failing deliveries to one endpoint cannot launch unbounded retry work while every delivery's first attempt still proceeds unrationed. Both are scoped by `hooks.key` (the caller passes the endpoint's identity), so one endpoint cannot starve or trip another. Only outcomes that actually reached the network (`attempts > 0`) move the breaker - a pre-network rejection (SSRF block, redirect error, bad config) is a configuration signal, not an endpoint-health one. Two in-process defaults ship for single-instance use: `createRetryBudget({ capacity, refillPerSec })` (a per-key token bucket) and `createWebhookBreaker({ failureThreshold, resetMs })` (a per-key circuit breaker that half-opens a single probe after the reset window and closes on success). Both read time only through the runtime seam, so backoff, refill, and reset stay deterministic under a seeded harness; `WebhookCircuitOpenError` (`code: 'WEBHOOK_CIRCUIT_OPEN'`) marks an ejected delivery. A cluster deployment injects a shared (Redis-backed) budget/breaker with the same interface instead. Fully backward compatible: omit `hooks` and delivery is byte-identical to before.

## [0.6.0-next.60] - 2026-07-06

### Added

- **`plugins/webhooks` - a generic outbound-webhook delivery primitive.** The SSRF-gated, DNS-pinned, HMAC-signed HTTP POST engine with jittered-exponential retry now ships as a standalone adapter plugin (`svelte-adapter-uws/plugins/webhooks`), matching the plugin model of `smooth`/`crdt`/`cursor`. `deliverWebhook(config, topic, event, data)` takes a per-webhook config plus one event and returns a terminal `{ ok } | { ok: false, err, attempts }` outcome: it resolves the payload and URL through bounded callbacks, attaches a stable idempotency key (HMAC-keyed when a `secret` is set, a plain content hash otherwise) and an optional `x-webhook-signature` (dual-signed during a `previousSecret` rotation), then delivers with a per-hop SSRF gate + DNS pin (no rebinding window) and retries 5xx/429/network/timeout. Transport-only and framework-free - it never throws, reports nothing, and holds no state, so the caller owns failure reporting and dead-letter capture; every timer and random draw routes through the runtime seam for deterministic backoff. `redactUrl(url)` strips credentials/query for safe logging. This is the reusable home for the delivery engine that previously lived only inside `svelte-realtime`; a future retry-budget / endpoint-ejection layer rides the same config object.

## [0.6.0-next.59] - 2026-07-06

### Added

- **Frame-arrival stall detection - a blackout on a still-open socket is no longer invisible.** Prediction overflow only watches the LOCAL command window; when the server stops sending REMOTE frames while the socket stays up, the world silently coasts to a halt with no signal. The smooth channel now stamps every inbound authority frame and, while remote entities are tracked, reports `stalled` once the gap exceeds `stallMs` (default 1000), clearing when frames resume. Observe it as transitions through `onStall(cb)`, the synchronous `channel.stalled` getter, or the new `stats().stalled` field - the app health surface's second input alongside `onOverflow`.
- **Per-entity freshness on every remote frame.** Each interpolated remote state now carries its freshness under the exported `SMOOTH_FRESHNESS` Symbol key: `'live'` (position covered by real samples), `'coasting'` (dead-reckoned past the newest sample, within the extrapolation cap), or `'stale'` (extrapolation exhausted - frozen on stale data, the per-entity half of a stall). A renderer reads `state[SMOOTH_FRESHNESS]` to dim or flag a coasted entity; the Symbol never collides with an app field, stays invisible to JSON, and is absent on non-positional states. No second per-frame structure - the tag rides the existing frame spread.
- **Eased remote resume - a reconnect no longer pops the world.** A resync used to clear the remote set and reset the smoother, snapping every entity to its rebuilt catalog position. Entities now ease from where they were last drawn into the new basis over `resumeEaseMs` (default 150; 0 restores the snap) with a per-entity decaying offset - but only when the world was briefly absent. After a blackout longer than `snapGapMs` it still snaps, the same call the local predictor makes on a wide ack gap (easing across a blackout would smear entities over the whole gap).
- **Suspend-survived light resume.** A `'suspended' -> 'open'` transition (a tab refocus where the socket stayed open and frames kept arriving) took the full clear + refetch path, popping the world on every refocus. It now reconciles the catalog in place - no clear, no smoother reset, no ring rebuild - so the rendered world is continuous across a background pause. A genuine reconnect on a new socket is unchanged (full rebuild with the eased resume above).

### Added

- **Kernel pressure sources: PSI stall time + CFS quota throttling feed the protection posture.** The pressure surface gains two signals the process-local counters cannot see. PSI (`/proc/pressure/{cpu,memory,io}`) reports the share of the last 10s tasks spent STALLED on a contended resource - cpu contention from a noisy neighbor, memory pressure absorbed by reclaim long before the heap ratio moves, a saturated io device - and fires a new `PSI` pressure reason at configurable avg10 thresholds (`pressure.psiCpuSome` 60 / `psiMemoryFull` 15 / `psiIoFull` 50, each `false`-disableable). Cgroup `cpu.stat` (v1 and v2 layouts) reports CFS quota throttling - a quota-throttled container is not merely contended, it is periodically STOPPED by the scheduler, a failure mode PSI `some` can miss entirely - and fires its own higher-precedence `CPU_QUOTA` reason when the process sat suspended for more than `pressure.cpuThrottledRatio` (default 0.25) of the sample window. Reason precedence is now `MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS`; both readings ride `platform.pressure.psi` / `platform.pressure.cpuThrottle` and fold into the `value` saturation scalar worst-of. Probed once at startup; on any host without the sources (non-Linux, PSI compiled out, no cgroup limits) every path is byte-identical to before.
- **`websocket.postureExport` - push the live protection posture to a local socket.** An external process (an edge-defense daemon, a watchdog) connects to a unix domain socket (or a Windows named pipe) and receives newline-delimited JSON - posture, reason, saturation value, and the kernel pressure readings - once on connect, once on every posture/reason transition, and once per 1 Hz pressure sample. The steady cadence doubles as a liveness contract: silence means the adapter is gone (killed, frozen, deadlocked). Local-only, read-only, payload-free, and unable to hurt the server it reports on: a failed listen logs once and disables the export, nothing is serialized with zero consumers, and a consumer that stops draining is disconnected rather than buffered without bound.
- **systemd readiness + watchdog (`Type=notify`), automatic.** Under systemd the runtime detects `NOTIFY_SOCKET` and sends `READY` when the service actually accepts traffic (after the app's `init` hook resolves in single-process mode; on first listen in clustered modes) - so dependents and rolling restarts wait for real readiness, not process launch - plus `STOPPING` on graceful shutdown. With `WatchdogSec=` set, a `WATCHDOG` ping fires at half the timeout from a main-loop timer: the ping itself is the event-loop liveness proof, so a frozen loop stops the pings and systemd applies the unit's recovery action - the failure mode an HTTP health route can never report. Notifications ride the `systemd-notify` helper (unit needs `NotifyAccess=all`; README carries the unit example); on any non-systemd host the whole integration is a no-op.

## [0.6.0-next.57] - 2026-07-05

### Added

- **`websocket.authorizeWireSubscribe` (default off) + `platform.authorizeWireSubscribe()`: opt-in wire-subscribe authorization.** By default the adapter is a primitive - any connected client may subscribe to any (non-`__`, shape-valid) topic - and per-topic authorization is entirely the app's `subscribe` hook. That leaves a gap for a framework that authorizes subscriptions server-side (in an RPC) rather than in a wire hook: a client could send a raw `{type:'subscribe', topic}` frame for a topic it was never granted - a private room, another tenant's channel - and receive its fan-out, because the server-side check ran only on the server-initiated subscribe, not the client's wire frame. With this policy on, a CLIENT-initiated `subscribe` / `subscribe-batch` frame is honored only for a topic the server already authorized for that connection via `platform.subscribe` (recorded in its subscription set) - unless the app exports its own `subscribe` / `subscribeBatch` hook, which then decides every topic exactly as before. Server-side `platform.subscribe` / `platform.checkSubscribe` are the trusted authorization path and are never gated. Off by default (the standalone contract is unchanged); enable via the `svelte.config.js` websocket option, or programmatically at startup with `platform.authorizeWireSubscribe()` (what svelte-realtime calls in its `init` hook). Denials use the existing `subscribe-denied` `FORBIDDEN` reason - no wire-protocol change. Mirrored across the production runtime, the Vite dev server, and the test handler for dev/prod/test parity.
- **`setTopicManaged(topic)` on the client: attach a topic without a client subscribe frame.** For a framework that subscribes the socket server-side (the server's RPC ran `platform.subscribe`), the client's own `subscribe` frame is redundant, and under wire-subscribe authorization a reconnect resubscribe would race ahead of the server's re-subscribe and be denied. Marking a topic managed makes the client attach its dispatch store WITHOUT emitting a subscribe frame and WITHOUT including the topic in the reconnect resubscribe-batch - exactly the treatment `__`-prefixed framework taps already get. Inbound dispatch through `on(topic)` is unchanged; only the redundant outbound frame is suppressed (a small efficiency win even with the policy off).

## [0.6.0-next.56] - 2026-07-05

### Added

- **The wire protocol is now specified as a frozen, citable contract: the Lantean protocol, revision 1.** `PROTOCOL.md` was a good working description of the wire; it is now a freeze-grade specification a third-party client - in any language - can implement against with confidence, and it is named implementation-neutrally (the same wire is spoken by the uWS runtime, the Vite dev server, the test handler, and the simulator; `svelte-adapter-uws` is the reference implementation). The document now states, as normative contract, every rule the reference client is engineered around and a spec-only reader would otherwise miss: that a client-to-server control frame must be compact JSON with `"type"` first (the server's hot-path demux recognizes control frames by byte prefix), the exact topic-name character rules and the `__` reserved-channel denial, the full set of framework-minted subscribe-denial reasons, that binary topic ids reach past 2^32 for shared fan-out (a 32-bit decoder breaks), that a topic can revert from binary to JSON mid-connection, that `request-n` credit is server-sized, and the complete `__replay` event vocabulary. It adds a guarantees/non-guarantees section, security considerations, conformance classes, an annotated byte-level session transcript, a design-rationale appendix, and machine-checkable companions - `protocol.schema.json` and `test-vectors/` (validated in CI against frames captured from the reference server, so the spec cannot drift) plus a dependency-free ~40-line minimal Core client (`examples/minimal-client.mjs`, exercised by one CI test).
- **The contract pins the subtle rules explicitly.** The capability registry states the cursor token stack (`cursor.protocol:2` is the gating token for the whole family; `:3` and `:4` are modifiers that do nothing alone); `hello` parsing leniency is specified (a non-array `caps` is ignored, non-string entries are skipped, unknown tokens are harmless); the shared-fan-out `wire-id` announce timing covers the already-subscribed-at-promotion case; the `ingress-bind` no-rejection design is explained (handlers register lazily, so an unknown `kind` is routinely transient and the client re-announces to converge); the conformance classes are labels over freely-combinable tokens; and the design-rationale appendix records why `schemaVersion` rides every binary frame, why batch subscribes ack per topic (each ack is that topic's resume gap-fill fence), and why acks exist only where the client must act.
- **`CONTROL_FRAME_TOO_LARGE` - an oversized control frame is now rejected explicitly instead of vanishing.** A client-to-server control-shaped text frame (one that begins `{"type`) at or above the 8192-byte control-parse ceiling was silently dropped: the server stopped treating it as a control frame and it fell through as opaque application data, so a too-large `subscribe-batch`, `resume`, or `reply` produced no ack and no error. The server now replies with `{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":8192,"size":<bytes>}` and does not act on the frame, turning a silent loss into a signal (the reference client surfaces it). The frame is rejected on size and prefix alone, never parsed - so it cannot be a parse-amplification vector, and since no `ref` or `type` can be echoed, `size` (the frame's byte length) is the one handle a developer has on which frame overflowed. A large text frame that is not control-shaped (a data-event, or any other application text) is unaffected and still delivered. Documented in `PROTOCOL.md` (sections 1.2, 3.7) and reflected in `protocol.schema.json` and the test vectors.
- **Overflowing the `subscribe-batch` topic cap is now a loud denial, not a silent drop.** A `subscribe-batch` carrying more than 256 topics was truncated at the cap: the topics past it were never subscribed, never acked, and never denied, so a third-party client that overflowed the cap waited forever on acks that would not come, with no signal which topics were missing. Every topic past the cap is now answered with an ordinary `subscribe-denied` carrying the new framework reason `BATCH_OVERFLOW` (silent-mode batches stay silent, like every other ack). The same rule lands in the dev server and the in-process test handler, so all surfaces answer identically. The reference client is unaffected - it chunks at 200 topics - but the wire no longer has a place where requests vanish. Documented in `PROTOCOL.md` (sections 3.2, 3.2.2).

## [0.6.0-next.55] - 2026-07-05

### Added

- **Resume-on-subscribe - reconnect recovery now rides the resubscribe and scales to any subscription count.** On reconnect the client recovered missed events by sending one `resume` frame listing every subscribed topic's last-seen offset. Above a few hundred topics that single frame exceeds the 8 KiB control-frame parse ceiling and the server drops it wholesale - so a client with many subscriptions silently lost its recovery. The client now attaches the per-topic recovery (`{offset, epoch}`) inline to each `subscribe` / `subscribe-batch` frame instead, so it is chunked with the resubscribe and every frame stays under the ceiling. The server gap-fills each recover-tagged topic (epoch-checked, through the same resume hook the `resume` frame uses) ahead of the first live frame, and skips a topic the auth gate denied. The standalone `resume` frame is still accepted from older or third-party clients. Additive and transparent: a subscribe without `recover` is byte-identical to before, and the whole `resume` frame path is unchanged for servers or clients that still use it. Documented in `PROTOCOL.md` (sections 3.2, 7), where the 8 KiB control-frame ceiling is now also stated as a normative limit.

## [0.6.0-next.54] - 2026-07-04

### Added

- **Binary ingress - a client-to-server binary frame for hot input paths.** A connection can now negotiate an id-addressed binary `0x03` frame in the client-to-server direction (the mirror of the existing server-to-client binary topic frame), moving a high-frequency input path off the JSON control envelope and, on the server, off the per-frame `JSON.parse` that envelope costs. A client advertises the `wire.ingress:1` capability; the server confirms with `ingress-ok`; the client binds a client-allocated id to a decode-and-route destination (`ingress-bind`), which the server acks (`ingress-bound`) before the client sends binary. Anything not negotiated - an old server, or a destination the server does not recognize - transparently uses the existing JSON path, so a message is never silently lost. The transport is generic: a consumer registers a decode-and-route handler for a `kind` (`registerIngress`, from `svelte-adapter-uws/plugins/smooth`) and the client binds it (`bindIngress`, from `svelte-adapter-uws/client`); the framework frames, routes, and falls back. The first consumer is the smoothed-entity command channel: its 60 Hz flush batch now rides a binary frame decoded straight to the same authority the JSON command RPC reaches, so the decoded batch is identical. A new generic compact value codec (a tagged binary encoding of the JSON value space, matching a `JSON.stringify`/`JSON.parse` round trip exactly) encodes each command with zero server-side JSON parsing. Fully additive and documented in `PROTOCOL.md` (sections 3.7, 6.5).

## [0.6.0-next.53] - 2026-07-04

### Fixed

- **Anonymous Server-Sent-Events endpoints no longer hang the SSR renderer.** The response-dedup path that shares one render across concurrent identical anonymous GETs buffered the whole body before deciding shareability - and for an SSE (`text/event-stream`) response, which never ends, that buffering awaited forever, parking the leader and every concurrent waiter on the same request until the socket dropped. Event-stream responses now stream straight through (dedup only ever buffers finite renders), so an unauthenticated SSE route stays responsive.
- **`upgradeResponse()` custom headers no longer break the WebSocket handshake.** Attaching an extra header to the 101 wrote the header before the upgrade, and uWS emits an implicit `200 OK` on the first header write - so strict clients saw a 200 and rejected the connection ("Unexpected server response: 200"). The switching-protocols status is now written first, so the handshake completes with the header attached.
- **Coalesced sends no longer stall a healthy socket or over-push a backpressured one.** The coalesce-buffer drain read the uWS send status with two values transposed (it treated "sent clean" as "under pressure" and vice versa), so a healthy connection flushed only one pending key per trigger while a backpressured one kept getting pushed. The drain now follows the real status contract: it flushes every pending key while sends land clean and stops the moment the socket signals backpressure.
- **The uWebSockets.js install error now names the pinned version.** When the native addon failed to load, the hint hardcoded a version seven tags behind the actual pin, so following it installed a skewed build. The message now derives the exact `npm install` target from the package's own dependency pin and names the real causes (it needs `git` on PATH, and as an optional dependency npm skips it silently on failure - check `npm ls uWebSockets.js`).

## [0.6.0-next.52] - 2026-07-03

### Fixed

- **Client prediction snaps a post-blackout correction instead of smearing it.** When the server goes silent past a reconnect-scale gap - a backgrounded tab, a radio stall, a device sleep too brief to trip the prediction-window kill - the local entity keeps predicting, so the first acknowledgement back carries a correction spanning the whole gap. The reconciler used to ease every above-threshold correction over `smoothTimeMs`, which visibly dragged the entity across that distance; it now snaps the pixels when an acknowledgement lands more than `snapGapMs` after the previous one (the same discontinuity threshold the remote interpolation path already uses to snap a wide straddle), while the simulation state snaps as it always did. Steady-state play, where acknowledgements arrive well inside `snapGapMs`, is byte-identical - the snap engages only on the long-gap-plus-real-divergence case that a blackout produces.

## [0.6.0-next.51] - 2026-07-03

### Added

- **File-descriptor budget preflight and gauges.** Every WebSocket connection holds one descriptor, and the classic 1024 soft limit caps a process at roughly a thousand connections while the CPU sits idle - a ceiling that only surfaces as `EMFILE` during the first connection storm. The server now checks the soft limit once at boot (main thread only; worker threads share one process-wide descriptor table) and logs a one-line warning with the launcher remediation (`ulimit -n` / systemd `LimitNOFILE` / docker `ulimits`) when it is below 8192. With the `metrics` option configured, two new gauges chart the live headroom: `open_fds` (sampled every ~5 pressure intervals - the directory read's cost scales with the count itself) and `fd_soft_limit`. Dependency-free (`/proc/self/limits` with a `process.report` fallback, `/proc/self/fd` or `/dev/fd` for the count) and a silent no-op on platforms without a source.
- **Suspend detection in the client - a wake from device sleep no longer trusts a stale socket.** A device sleep freezes the monotonic clock while the wall clock keeps counting, so on wake the client compares the two deltas. When the gap exceeds 60 seconds and no server frame has arrived in the last few seconds, a still-OPEN socket is not trusted - the server has usually idle-dropped it without the close frame ever arriving - and the client force-reconnects immediately with a session resume instead of showing frozen data until the silence detector catches up. A socket that provably survived the sleep (a fresh frame already arrived) is left alone. Checked when the tab becomes visible, when it hides, and on the 30-second detector tick, so a lid-close on a visible tab is caught whichever event fires first. Where no monotonic clock source exists the gate is inert.

### Fixed

- **A superseded socket's late close event no longer mutes its replacement.** The socket close handler unconditionally nulled the connection reference, so when a forced close (suspend detection, zombie detection) raced the visibility handler's immediate reconnect, the OLD socket's asynchronous close event landed after the NEW socket was created and wiped it - leaving a connection that was open on the wire but never sent its hello, resume, or resubscribe, with outbound frames queued indefinitely. Every socket's event handlers now act only while that socket is still the current one, so a stale close cannot touch the state of the connection that superseded it.

## [0.6.0-next.50] - 2026-07-03

### Added

- **`ctx.key` on the smooth apply context - the attribution handle for authoritative side effects.** An `apply` that produces an authoritative side effect (spawning the server's copy of a fired shot, logging a player action) had no way to know WHOSE command it was applying: the state deliberately carries no identity (the channel owns addressing), and threading an identity field through every state would put it on the wire every tick. The authority now sets `ctx.key` to the entity key for every application - client-commanded and server-injected alike - and the predicting client reports its own entity key through the same field (null until the first sync reply announces the identity), so an `apply` that reads it sees the same value on both sides of the same command and stays deterministic. Zero wire cost, additive: an `apply` that never reads `ctx.key` is untouched.

### Added

- **Smooth channel wire views (`options.wire`) - app-owned codecs at the wire boundary.** A rich simulation state serializes to kilobytes of verbose JSON, and it changes every tick, so every acknowledgement and every remote update paid that price per entity per tick (the binary framing is compact, but a non-`{x,y}` state rides inside it as a JSON string). `wire.state = { pack, unpack }` declares the state's compact wire form: the channel unpacks every inbound state - updates, acknowledgements, the sync roster - back into the simulation shape before the predictor and the interpolation consume it. `wire.command = { pack, unpack }` is the outbound counterpart: each transmitted command (and shot) is packed, while the prediction always replays the ORIGINAL command objects - packing touches only the transmit copy. The pairs must be the same functions the server topic declares (share the module, like `apply`). A state frame whose unpack throws is dropped as malformed; a command whose pack throws surfaces at the `command()` call. Off by default - without `wire`, the channel is byte-identical to before.

## [0.6.0-next.48] - 2026-07-02

### Fixed

- **Display-rate motion for the predicted local entity - the smooth channel's owner no longer smears on fast displays.** The prediction advances one command per simulation tick, so on a display refreshing faster than the tick rate (a 120Hz panel over a 60Hz simulation) the owner's own entity rendered every predicted position twice: a stair-step the eye reads as a velocity-proportional smear while tracking the moving entity. Remote entities never showed it - the interpolation already samples them per display frame; only the local entity lacked between-tick motion. `renderInto` now sweeps each tick's motion across the measured command cadence: at a command's application the rendered position stays exactly where the previous sweep had it and glides to the new prediction over slightly more than one command interval, so every display frame samples forward motion at any refresh rate. Continuity is exact across command boundaries, same-frame catch-up bursts, and reconciliation corrections (an acknowledgement leaves the sweep term unchanged, so the correction offset's continuity guarantee carries over unmodified). The sweep arms only on a tick-like command cadence (gaps up to 100ms) - sporadic commanders snap exactly as before - and clears on sync, rebase, overflow, and reset. Allocation-free on the frame path; the channel's frame loop keeps painting while a sweep is in flight and still goes idle once it lands.

## [0.6.0-next.47] - 2026-07-02

### Added

- **Smooth authority: server-entity spawn and server-driven state replacement.** `createSmoothAuthority` gains two additive pieces the realtime layer's server world hook builds on. `ensure(key, ws, initialState, { active: true })` creates an entity ACTIVE, so `onMissing` drives it from its first tick without ever seeing a command - the spawn path for genuinely simulated entities (NPCs, scripted movers), which were previously impossible: activity only ever started with a client command, so a never-commanded entity could never move. The default stays inactive and byte-identical (a joined-but-idle client entity costs no `onMissing` calls until its first command; the `onMissing` docs now state the activation contract explicitly). `set(key, state)` REPLACES an entity's authoritative state from server logic - the discontinuous counterpart of `inject`, which routes through `apply`: a teleport, a respawn, a scripted placement. It wakes the entity so `onMissing` continues from the new state, never touches the queue, the ack watermark, or `lastCommand`, and is designed to run post-drain (the caller broadcasts the change for the current tick; the next drain's change-detection baseline is then the already-broadcast state, so nothing double-publishes). Existing call sites are unchanged.

## [0.6.0-next.46] - 2026-07-01

### Added

- **Stateless cell-snapshot wire codec (`createCellWireCodec`) for spatial cell-topic fan-out.** The smooth wire codec is per-connection stateful (a short-id dictionary), so it cannot fan out natively - each capable connection is encoded against its own dictionary. For a high-population spatial topic, area-of-interest can instead be expressed as SUBSCRIPTION to grid-cell topics; each cell's snapshot is then identical to all its subscribers, so it rides the native cohort fan-out (one encode, the C++ TopicTree does the sends). This codec is that identical-to-all form: stateless (full key strings + absolute stamps, so a frame is self-contained and a new cell subscriber decodes it with no prior state) and `shared: true` (cohort-eligible). Ops are STATE / XY / REMOVE - no ACK (an acknowledgement is per-owner and stays on the stateful self channel). Exposed from `plugins/smooth` as `createCellWireCodec` / `decodeCell` / `CELL_CAPABILITY` / `CELL_TOPIC_PREFIX`; the smooth client registers it as a prefix SINK so a channel receives every `__smoothcell:<name>#<cell>` frame (server-driven subscription) through one registration and ingests it into the same remote-entity path, with a self-key dedup and cell-scoped removes. This is the adapter primitive `svelte-realtime`'s `live.smooth({ interest: { cells: true } })` builds spatial cell-topic interest on; additive and JSON-compatible (a client without the capability gets the JSON envelope on the cell topic).

- **`websocket.primaryInit` + `websocket.workers` - a cross-worker shared-memory seam and dedicated compute workers for clustered deployments.** Adapter workers were islands: no way to hand them shared state set up before they spawn, and every worker listened, so a latency-critical compute loop competed with connection I/O on the same thread. Two additive primitives close that. `primaryInit` is a module path (like `metrics`) whose default (or named `primaryInit`) export runs ONCE in the primary thread before any worker spawns; its return value - a `SharedArrayBuffer`, SPSC/MPSC rings, a `MessagePort`, or any object - is attached to every worker's `workerData` and surfaced to the `init` hook as a new `workerData` field. It is replayed IDENTICALLY when a crashed worker respawns (a fresh buffer would be a different world), and bundled as its own isolated entry so the primary loads only that module, never the app graph (a top-level side effect in `hooks.ws` never runs in the supervisor). `websocket.workers: { compute }` splits the `CLUSTER_WORKERS` pool into I/O workers (listen + serve) and `compute` dedicated compute workers that fire `init` (receiving the shared memory) but never bind a listen socket - under the same unified lifecycle (drain, crash-respawn with identical `workerData`, heartbeat, metrics). General-purpose: cross-worker LRU caches, shared rate-limit/token-bucket tables, shared metric counters, shared model weights, or a shared simulation world. No effect in single-process mode (`workerData` is `null`); with neither option set, behavior is byte-identical to before. `init` hooks now receive `{ platform, workerData }` (the added field is `null` unless `primaryInit` is configured). The `createTestServer` harness accepts a `primaryInit` function so the contract is testable in-process.

## [0.6.0-next.45] - 2026-06-28

### Added

- **`anchorRange` / `resolveRange` on the collaborative text facet (`crdt` channel) - position anchors that survive concurrent edits.** A text selection expressed as raw `(start, end)` offsets is wrong the instant another user edits before it. `text.anchorRange(start, end)` encodes the range as opaque bytes (a packed pair of relative positions) that `text.resolveRange(bytes)` maps back to current `{ start, end }` offsets on any converged replica, after arbitrary concurrent inserts and deletes. The start binds right and the end binds left, so an insert exactly at either edge stays outside the range while an insert strictly inside it extends the range to keep covering the original characters; a delete of the anchored text collapses the range to a zero-width caret at the deletion point. `anchorRange` is a read (no write access required); `resolveRange` returns `null` for a malformed blob or a position that cannot resolve against this replica, so a stale anchor drops rather than throws. The CRDT library stays confined to the adapter - the API takes and returns plain numbers and opaque `Uint8Array`, no library types leak. This is the primitive `svelte-realtime` builds CRDT-anchored multiplayer selections on; rides the existing `./plugins/crdt/channel` export (no new entry point).

## [0.6.0-next.44] - 2026-06-27

### Added

- **`PROTOCOL.md`: the wire protocol is now a published, citable spec.** A frame-by-frame reference for the WebSocket wire the adapter and its client speak - every control frame with its exact JSON shape and direction, the data-event envelope, the capability table, the binary `0x03` payload byte layout (with the varint / `f32` / length-prefixed-string primitives), and the `(offset, epoch)` resume model. JSON by default, binary opt-in; the doc is what a non-JavaScript client implements against. It now ships in the package (`files`) and is linked from the README's "Message protocol" section. Labelled "revision 1, as shipped in `0.6.0-next`" and marked stabilizing toward 0.6.0 (additive changes only until then; not yet frozen). Reconciles the wire as actually shipped, including the three cursor codec generations (`cursor.protocol:2`/`:3`/`:4`), and explicitly documents that cluster fan-out (cohort topics, server-wide binary ids, the cross-worker relay) is server-internal and never reaches a client.

## [0.6.0-next.43] - 2026-06-27

### Added

- **`publishWire` shared binary fan-out: a stateless codec marked `shared: true` fans a high-fan-out topic out via native cohort topics instead of a per-connection walk.** For a topic where every binary subscriber receives the IDENTICAL frame - a mega-lobby world snapshot - one publish becomes TWO native `app.publish` calls: the byte-identical `0x03` binary frame to the binary cohort and the JSON envelope to the JSON cohort, with no per-subscriber JS loop. The frame is identical for every binary subscriber because the topic-id is a server-wide shared id (partitioned far above the per-connection id space so the two can never collide in a client's id map), announced when a connection joins the binary cohort. The first shared publish migrates the topic's current subscribers into cohorts; later joiners are cohorted at subscribe time (including via `platform.subscribe` and the `trackedSubscribe` plugin primitive). An excluding publish (`excludeWs`) or a declined encode falls back to the per-connection walk. Cohort membership is a transport detail kept out of the subscription bookkeeping (so the cap accountant, the close hook's `subscriptions`, and the consistency auditor are unaffected). Opt-in via the codec's `shared: true`; every existing codec is unchanged. In a clustered deployment each receiving worker re-derives the registered codec and runs its own cohort split, so register a shared codec via `registerWireCodec` (its type now carries `shared?`). Mirrored on the `createTestServer` platform; a no-op shape on the dev (Vite) platform.

## [0.6.0-next.42] - 2026-06-27

### Added

- **Cross-worker subscribers in a clustered deployment now receive the compact binary `0x03` wire frame instead of JSON.** A binary wire publish (cursor positions, presence rosters) is encoded against the publishing worker's own connections and then relayed to sibling workers - which, until now, re-published it as the JSON envelope, so a binary-capable subscriber on a _different_ worker than the publisher fell back to the larger JSON frame (on an N-worker box, roughly `(N-1)/N` of binary subscribers). The relay now carries the codec's capability and raw payload alongside the envelope, and each receiving worker re-derives the codec from a per-worker registry and re-encodes binary locally against its own connections - per connection for a stateful codec (the cursor short-id dictionary), once for a stateless one (presence). The origin sequence number rides through unchanged (no re-stamp), the local re-encode never re-relays (no cross-worker loop), and a worker with no binary subscribers for a codec - or no codec registered - keeps the cheaper single JSON fan-out. The bundled cursor and presence plugins register their codec automatically, so this is transparent and on by default; it is perf-only and fully backward-compatible (a single-process deployment, and a publish through an unregistered codec, are byte-identical to before). A relayed frame now also re-gates permessage-deflate on the receiving worker via its own compressor (the cross-worker compression intent was previously dropped).
- **`platform.registerWireCodec(wire)`: register a plugin-author wire codec for the cross-worker relay.** The cursor and presence plugins call this automatically on first use; a custom codec published through `publishWire` registers under its capability so a clustered deployment can re-encode it binary on a receiving worker (without it, cross-worker subscribers of that codec get the JSON envelope). Idempotent (last registration per capability wins); a no-op in single-process mode and for a codec with no string capability. Mirrored on the dev (Vite) platform as a no-op (dev is single-process) and on the `createTestServer` platform.

## [0.6.0-next.41] - 2026-06-26

### Fixed

- **The client now forwards the de-herd window `j` to topic subscribers, so `publish(..., { jitterMs })` actually staggers.** The inbound dispatch rebuilt the app-facing envelope as `{ topic, event, data }` (plus `seq` / `t`) and dropped the top-level `j` the server stamps, so a de-herd consumer (svelte-realtime's stream / health dispatcher) read `envelope.j === undefined` and never deferred - every client reacted at t+0, defeating `jitterMs`. `j` now rides the dispatched envelope alongside `seq` / `t`. A frame without a window carries no `j`. Regression-tested through the real serialize -> dispatch round trip.

### Added

- **`platform.publish(topic, event, data, { jitterMs })` - de-herd window for thundering-herd broadcasts.** When one broadcast makes many clients all react at once (retry, refetch, re-render), `jitterMs` stamps a small `j` field on the frame carrying a de-herd WINDOW. Each receiving client rolls its OWN random delay in `[0, jitterMs)` before dispatching, so N clients ramp their follow-up actions across the window instead of spiking at t+0. The outbound fan-out stays a single native `app.publish` (the window is carried verbatim, never a server-rolled offset - which would defer every subscriber identically and spread nothing); the staggering is entirely client-side, so the server holds no per-subscriber timers. Omit / `0` = immediate, and the no-jitter wire frame is byte-identical to before. Consumed by `svelte-realtime`'s `ctx.publish(..., { jitterMs })` (which clamps the window to a 60s ceiling) and the de-herd client dispatch.

### Added

- **`platform.requestTopic(topic, event, data, options?)`: broadcast-with-reply.** The request/reply analog of `publish` - sends a request to EVERY connection subscribed to `topic` on this instance and resolves with one result per subscriber (`{ ok: true, reply }` or `{ ok: false, error }`). Partial success is the contract: a subscriber that times out, errors, or whose socket closed lands in the array as an error entry and never fails the whole call. `timeoutMs` (default 5000) bounds each request, so run concurrently it is the whole-fan-out budget. Walks this worker's subscriber set (the cross-instance broadcast is the extensions layer). svelte-realtime's `live.push({ topic })` / `live.notify({ topic })` aggregate it. Mirrored on the dev (Vite) and `createTestServer` platforms.

## [0.6.0-next.38] - 2026-06-26

### Added

- **`readinessCheckPath`: a readiness probe, distinct from the `/healthz` liveness probe.** It reports `200 ready` normally and `503 draining` once graceful shutdown has begun, so a fronting load balancer stops routing NEW traffic to a draining instance while its in-flight requests finish. Crucially **separate** from `healthCheckPath`: liveness stays `200` throughout the drain, so a Kubernetes liveness probe never restarts a pod mid-shutdown (it would, if a single endpoint served both purposes and returned `503` during the drain). Default `/readyz`; set `false` to disable; must differ from `healthCheckPath` (validated at build time). The drain flag flips at the very start of the graceful-shutdown sequence, before connections are closed, so the load balancer can deregister the instance first.

## [0.6.0-next.37] - 2026-06-26

### Added

- **`websocket.adminPath`: relocate or disable the auto-mounted admin route.** The reserved `/__realtime/*` admin route (auto-wired when the WebSocket handler exports `admin`) is now configurable. Set a string to mount it at a different prefix (defense-in-depth, or to avoid colliding with an app route), or `false` to **disable the auto-mount entirely** - for apps that mount the `admin` handler themselves via a SvelteKit `+server.js` route with their own middleware, so there is no second adapter-owned mount point. Default stays `/__realtime`. Validated at build time (must be an absolute path that differs from `path` / `authPath`). The svelte-realtime admin handler is mount-prefix agnostic, so a custom path is set in this one place. The auto-mount remains a no-op unless the handler exports `admin`.

## [0.6.0-next.36] - 2026-06-26

### Added

- **Reserved `/__realtime/*` admin route: the adapter auto-wires it to the app's `admin(request)` handler.** When the WebSocket handler exports an `admin(request)` function (svelte-realtime's auth-gated observability handler is the canonical one), the adapter mounts it at the reserved `/__realtime/*` prefix - registered before the SSR catch-all so admin traffic never hits page routing - and bridges the uWS request to the framework-agnostic Web `Request` -> `Response` contract the handler speaks (synchronous header/method/url read, a bounded body read under the global `body_size_limit` for non-GET methods, then the response written back in a single corked syscall with a default `x-content-type-options: nosniff`). It is pure transport plumbing: ALL authorization lives in the app handler (the adapter never inspects or short-circuits the auth decision), and a handler that throws, rejects, or returns a non-`Response` yields a generic `500` with no detail leaked to the client. No-op unless the handler exports `admin` - existing apps are unaffected.
- **`platform.introspect()`: a PII-free transport-layer health snapshot.** Returns this worker's `connections`, `closedWsAborts`, `protection` posture, `maxPayloadLength`, the scalar `pressure` signals (without `topPublishers` - topic names can embed ids), and the framework-invariant `assertions` counters. Counts and enums only - never a topic name, user id, or socket handle. svelte-realtime's `introspect()` composes this under a `transport` key when present, so an app-level admin route surfaces the dispatch snapshot and this transport snapshot from one call; usable standalone behind your own authorization. Mirrored on the dev (Vite) and `createTestServer` platforms.

## [0.6.0-next.35] - 2026-06-26

### Added

- **`createSmoothChannel(...)` now exposes a `stats(monoNow?)` telemetry snapshot** for a devtools / per-stream inspector. It bundles the channel's prediction + interpolation state in one pull-based read (so it costs nothing when nothing reads it): `self`, `topic`, `overflowed`, `unacked` + `windowCap` (the reconciliation window - `unacked` nearing the cap predicts an overflow kill), `lastDivergence` (the most recent reconciliation error magnitude) + `correcting` (whether a correction is still easing in), `interpDelayMs` (the applied remote render-behind), `clockSynced`, and `remoteCount`. The predictor gained the matching getters (`windowCap`, `lastDivergence`, `correcting`) behind it. No behaviour change to the prediction/interpolation path - `lastDivergence` is recorded as a side effect of the reconciliation it already computed, and resets to 0 on a clean rebase (sync / recovery).

## [0.6.0-next.34] - 2026-06-25

### Fixed

- **Graceful shutdown now closes WebSocket connections cleanly instead of forcefully, so buffered outbound frames flush and clients receive a `1001 (Going Away)` close frame.** On `SIGTERM`/`SIGINT` the server closed each socket with `ws.close(1001, 'Server shutting down')`, but uWS `close()` is the forceful variant: it takes no arguments (so the `1001` code and reason were silently dropped - no close frame was sent at all) and discards the send buffer, so any frames still queued behind backpressure were lost on an otherwise-graceful deploy. It now uses `ws.end(1001, 'Server shutting down')` - the graceful close that flushes the send buffer and sends a proper close frame with the code - so clients see a clean Going-Away and reconnect to the new instance. Connections are snapshotted before the loop since `end()` synchronously fires the close handler that removes them from the connection set.

## [0.6.0-next.33] - 2026-06-24

### Added

- **`staticHeaders` adapter option: attach security headers to static and prerendered responses.** Headers set in the SvelteKit `handle` hook only reach SSR responses - static assets (`/llms.txt`, `favicon.ico`, `robots.txt`, `.well-known/*`) and prerendered pages are served from an in-memory fast path that returns before SSR, so a CSP, HSTS, `X-Frame-Options`, or `Referrer-Policy` set in `handle` never reached them. `staticHeaders: Record<string, string>` (top-level) is merged into every static and prerendered response once at index time, so there is zero per-request cost. Keys are case-insensitive; the handler's own transfer / caching / range headers (`content-type`, `content-encoding`, `content-range`, `content-length`, `date`, `etag`, `cache-control`, `vary`, `accept-ranges`) cannot be overridden - supplying one logs a build warning and is ignored - while every other header (including the default `x-content-type-options`) is applied.
- **`platform.metrics`: read the configured metrics registry from a route.** Exposes the same registry instance the adapter populates with admission/posture instruments, so a scrape route can serve its Prometheus text directly (`new Response(platform.metrics.serialize())`) without re-importing the metrics module (which would create a second, empty copy). `null` when `websocket.metrics` is unset.
- **A one-time boot warning when the per-IP upgrade rate limiter has collapsed into a global cap behind a proxy.** The first time an upgrade is rejected (`429`) keyed on a loopback or private address while `ADDRESS_HEADER` is unset - the signature of an address-rewriting reverse proxy, L4 load balancer, or docker `userland-proxy` that makes every client share one gateway IP - the runtime logs how to restore real per-IP limiting (set `ADDRESS_HEADER`/`XFF_DEPTH`, use docker `userland-proxy: false`, or disable with `upgradeRateLimit: 0`). A directly internet-facing server sees real public client IPs and never trips this. The same proxy interaction (and remedy) is now documented next to `upgradeRateLimit`.

### Changed

- **BREAKING: `websocket.metrics` is now a module path string, not a live registry object.** Adapter options are serialized into the build, so a registry constructed in `svelte.config.js` could never reach the production runtime - the documented inline form was a silent no-op there. Point `metrics` at a module whose default export (or a named `metrics` / `registry` export) is the registry; the adapter bundles it, populates it, and exposes the same instance on `platform.metrics`. Passing a non-string now throws at build with migration guidance. (`createTestServer` still accepts a live registry object for tests.)
- **BREAKING: `upgradeAdmission.waitingRoom.template` is now an HTML string with `{{tokens}}`, not a function.** A function could not survive options serialization and was silently dropped. Use a string template with `{{queueDepth}}`, `{{estimatedSeconds}}`, `{{pollIntervalMs}}`, `{{retryAfterSeconds}}`, `{{admitCheckPath}}` placeholders (values are HTML-escaped on substitution). A function passed at build now logs a warning; one passed programmatically (e.g. the test harness) is still honored.

### Fixed

- **`websocket.protection` now reaches the production runtime.** The graduated protection posture (`'auto'` / `'elevated'` / `'siege'`) was read by the runtime but never serialized into the build config, so configuring it in `svelte.config.js` was a no-op in production (the posture machine was never built). It is a plain string enum and now rides the build placeholder like every other option.
- **`websocket.metrics` now reaches the production runtime.** See Changed - the option existed and was consumed by the runtime, but a live registry object could never cross the build-time serialization boundary, so admission/posture metrics were never emitted in production. Now wired via a bundled module path.

## [0.6.0-next.32] - 2026-06-23

### Added

- **`presenceUpdate(topic, fields)` on the presence client: push per-user fields (a typing flag, a selection, a status) from the browser.** The presence plugin already broadcast field updates and merged them on receive, but there was no way to SEND them through the plugin - an app had to wire its own RPC. The new client function sends a `presence-update` frame, and the presence plugin's server message hook routes it to the existing `update()` (per-field change detection, durable/transient split, diff broadcast). The server self-gates on membership: a connection that has not joined the topic is a silent no-op, so an unsubscribed socket cannot inject fields. Mirrors the cursor plugin's `move()` send. The receive side and the cluster cross-instance relay were already shipped; this completes the client-to-server field-update loop without an out-of-band RPC.

## [0.6.0-next.31] - 2026-06-23

### Added

- **`runSimSwarm(config)` on `svelte-adapter-uws/sim`: run many seeds and get an exact reproduce key per failure.** Drives `runSim` across a seed range (`count` consecutive integer seeds from `startSeed`, or an explicit `seeds` list) and returns a `summary` (total / passed / failed / `firstFailingSeed` / `ok`) plus a compact per-seed `runs[]`. The failing seed string IS the local reproduce command. A `faultMode` knob (`'off'` / `'on'` / `'random'`, with `faultProfile` + `faultProbability`) decides per-seed fault enablement so one swarm covers quiet and chaotic interleavings reproducibly; `checkRatio` replays a deterministic fraction and flags any run that fails to reproduce as a distinct determinism regression; every run carries an 8-hex-char structural `fingerprint`. The function owns no wall clock and reads no environment, so it stays inside the determinism seam. A bundled runner (`npm run sim:swarm`, `scripts/sim-swarm.js`) reads the config from `DST_*` env vars, stamps wall-clock metadata, writes a result JSON, and exits non-zero on any failure - the shape a scheduled CI job runs.
- **`framework_assertion_violations_total{category,severity}` Prometheus counter.** When a `metrics` registry is configured, the framework's own invariant checks (`assert`, `fatal`) now increment this counter alongside the in-memory `platform.assertions` Map - `severity="soft"` for a recoverable `assert`, `severity="fatal"` for a hard-tier termination - so an ops dashboard can scrape invariant-violation rates without polling the Map. The emit is best-effort (a throwing registry can never turn an invariant check into a crash), label cardinality is bounded by the source-declared categories (never user input), and a deployment with no registry is byte-identical to before.
- **`createSharedRandom` is now public on its own dependency-free subpath, `svelte-adapter-uws/plugins/smooth/random`.** The deterministic reseedable generator the smooth predictor and authority seed per command (`{ reseed(seed), float(), u32() }`) was reachable only through the smooth server entry, which loads the full authority runtime. It now has its own side-effect-free subpath that imports nothing else, so an app can draw the same reproducible randomness outside `apply` - world generation, spawns, deterministic tests - on both the server and the browser without pulling in the smooth runtime. It is also re-exported from `svelte-adapter-uws/plugins/smooth/client` for symmetry with the server entry. The generator itself is unchanged; this is purely an export-surface addition.

## [0.6.0-next.30] - 2026-06-22

### Added

- **`plugins/ratelimit`: an optional per-connection `tenant` resolver scopes the bucket key by tenant.** `createRateLimit({ tenant: (ws) => id | null })` joins the returned tenant id to the rate-limit key with a NUL (so it stays unambiguous even when the key is an IPv6 address), so two tenants sharing an IP / connection / custom key get independent buckets. A tenant id containing the NUL delimiter is rejected. `reset` / `ban` / `unban` take a trailing optional tenant id and `clear(tenantId)` drops only that tenant's buckets (no tenant -> clears all). Mirrors the `redis/ratelimit` extension. Omit the resolver and the bucket key, the bucket map, and `clear()` are byte-identical to before.

## [0.6.0-next.29] - 2026-06-21

### Added

- **A shot echoes the latest server stamp (`ackT`) so the server can bound lag-compensation rewind to a latency it measures itself.** A shot already carries the client's render-time; it now also carries `ackT` - the most recent absolute server-clock stamp the client has received (tracked from the broadcast stream, so it stays fresh even for a still, non-commanding shooter). The server measures the round trip as `now - ackT`, where BOTH ends are server-authored wall times, so a client cannot claim a lower latency than the network allows (it can only inflate it, which costs real responsiveness and is detectable). This is the tamper-resistant input the rewind window's width is derived from, replacing any reliance on a client-asserted latency.

### Changed

- **`channel.shoot` suppresses the render-time until the server clock has synced (cold start).** Before the first clock sample a render-time built from the raw local wall clock could be arbitrarily skewed (an un-synced machine can be seconds off), resolving the shot at a wildly wrong instant. The shot now goes out stampless until the clock syncs, so the server resolves it at the present (an honest miss on a moving target, never a wrong-position hit). The `ackT` echo and the render-time are gated on the topic's lag-compensation advert (`lc`), so a non-hit-testing topic's shot frame stays byte-identical.

## [0.6.0-next.28] - 2026-06-21

### Added

- **The smooth channel gains `channel.shoot(cmd)`: a fire-and-forget, non-predicted command for server-side lag compensation.** A shot is not movement - it owns no entity state to predict, and its outcome (a hit) is the server's authoritative verdict, not a reconciliation - so it bypasses the prediction ring entirely. `shoot` stamps the render-time the shooter actually saw the world at (the synced server clock minus the interpolation delay, the same instant remote entities are rendered at) and ships it on the shot, so the authority can rewind directly to that instant. The stamp is appended only when the topic advertised lag compensation - a new `lc` flag on the sync reply, set by a `svelte-realtime` topic that declares a `hitTest` - so a topic without it sends a byte-identical, stampless shot frame and the default smooth surface is unchanged. The shot rides a new optional `sendShoot` transport method; a transport that predates it leaves `shoot` inert. Pairs with the `0.6.0-next.27` authority `inject` primitive to drive `svelte-realtime`'s `live.smooth({ hitTest })` server-rewind resolution.

## [0.6.0-next.27] - 2026-06-21

### Added

- **The smooth authority can apply a server-initiated command to any entity: `authority.inject(key, cmd)`.** Until now every entity update came from its own owner's command queue, acknowledged back to that owner. A server-authoritative consequence - one entity's action changing another entity's state, like a hit dropping a victim's health - had no clean primitive: enqueueing the change on the victim's own queue would mis-acknowledge the victim (a foreign command id) and author-exclude the victim from its own state-change broadcast. `inject` is that primitive. It applies a synthetic command through the shared `apply` step and emits a non-commanded update: broadcast to all subscribers including the affected entity's owner, with no acknowledgement. The injected command runs on a separate per-entity server queue with a descending server id space, so it never collides with the owner's ascending command ids and never advances the owner's acknowledgement watermark - the owner's client-side prediction is left undisturbed and simply receives the authoritative new state through the normal update broadcast. Injected commands are drained after the entity's own commands in the same tick and the acknowledgement carries the final post-injection state, so an entity that both moves and is changed by the server in one tick reconciles to the truth in a single step with no flicker. Unknown keys are ignored (the target may have left); the return value is the caller's cue to arm the tick. Inert unless a layer calls it; the default command/acknowledge path is byte-identical. Consumed by `svelte-realtime`'s server-side lag-compensation layer for authoritative cross-entity mutation inside a hit handler.

## [0.6.0-next.26] - 2026-06-19

### Added

- **The smooth channel delivers discrete one-shot events client-side: `channel.onEvent` plus optimistic local delivery.** The predicted-event channel's producer halves (`ctx.emitEvent` in `apply`, drained by the predictor and the authority) shipped in 0.6.0-next.24; this wires the client end. `createSmoothChannel` gains `onEvent(cb)`, a single consumer mirroring `onFrame`/`onOverflow`. Each `command` now drains the events its `apply` emitted on the optimistic (first-time) application and delivers them synchronously the same frame, tagged `origin:'local'` - the shooter's own muzzle flash, drawn the instant the input is read, with no wait for the acknowledgement. The drain runs unconditionally so the predictor's event sink starts every command empty (a killed or overflowed command runs no `apply` and drains nothing), and the delivered batch is snapshotted before any callback fires, so a consumer that issues a command from inside its handler is safe. Inbound, the channel's tap gains an `event` case that delivers the authority's broadcast tagged `origin:'server'`: the authority author-excludes the owner's own echo (the owner already drew it optimistically), so a frame arriving here is another author's event - or, for an event that opted into `toAuthor`, the owner's own authoritative confirmation. The optimistic and authoritative copies of one event share the `<commandId>:<ordinal>` correlation key the producer halves mint identically, so a consumer that receives both can match them; the channel itself never suppresses by key - author-exclusion is the authority's decision, and a global key set would mis-collide one author's `7:0` with another's. The v1 wire is the JSON envelope (`event` is declined by the binary codec and rides the fallback, exactly like the cursor `time`/`you` events); a binary `OP_EVENT` is a later additive step. Discrete events never enter the smoother or the remote set - they are delivered once and not replayed. No new export subpath: `onEvent` and the `SmoothChannelEvent` type extend the existing `plugins/smooth/client` surface.
- **Cross-worker state-divergence detection for the built-in relay (clustered mode).** The relay carries every published message to every worker, so under healthy operation all workers agree on the highest sequence number delivered per topic. Setting `websocket.stateHashIntervalMs` (default `0`, off) has each worker periodically fold a structure-only projection of its delivered-sequence map into a single 32-bit hash and report it to the primary; the primary buckets the reports by its own monotonic clock (a worker's clock skew never matters), and once every live worker has reported it compares them. A disagreement at rest - a relay frame that reached some workers but not another - is logged as a `state-divergence` event (epoch, per-thread hash, majority/minority split) and, when a `metrics` registry is configured, increments the new `state_divergence_total{role}` counter. Only the integer hash and the worker's thread id cross the thread boundary: no topic strings, no payloads, no client identity. Observe-only by default; the new `RESTART_ON_STATE_DIVERGENCE=1` environment variable additionally has the primary terminate a diverged (minority) worker so it restarts and re-converges (default off - terminating a worker is disruptive and the right response is usually operator judgement). Single-process deployments and the `stateHashIntervalMs: 0` default schedule no timer and pay nothing. Topics fed from an external pub/sub source (`{ relay: false }`) carry a per-process sequence and are deliberately excluded from the comparison - the guarantee is scoped to the in-process relay. Reuses the structural state hash the deterministic simulator already ships.
- **Per-worker consistency auditor (on by default).** Each worker now runs a background check that evaluates the framework's structural invariants (for example, that a connection's subscription bookkeeping is internally consistent) against a snapshot of its live connections, turning a silent state-corruption bug into a logged signal. It runs off the hot path - publish, send, subscribe, and close pay nothing; the auditor reads existing state on a slow, jittered, unref'd timer that never holds the event loop open - and the snapshot is bounded to a fixed slice of connections per tick walked round-robin, so a worker with a million connections does a constant amount of work each tick. The snapshot is structure-only: no payloads, no topic strings, no client identity beyond the per-connection session id used as a log label. A violation logs a `[adapter-uws/assert]` line and increments the queryable `platform.assertions` counter (the soft tier) without terminating the worker; the single exception is a subscription slot that has become a non-`Set` (heap or dispatch corruption that cannot heal), which - only if it persists across two consecutive audits - escalates to a deferred worker restart (exit code 78). Configure the cadence with the new `websocket.consistencyAuditIntervalMs` option (default `5000`; `0` disables the auditor entirely, scheduling no timer). Unlike the cross-worker state-divergence reporter, the auditor runs in single-process and clustered deployments alike - it is a per-worker net, not a cross-worker comparison. The auditor and the deterministic simulator share one invariant-predicate path, so a tightened invariant tightens both at once.

### Changed

- **A small set of genuinely-unrecoverable structural invariants now terminate the worker (deferred exit code 78) instead of only logging.** Five framework-internal checks that previously logged a soft `[adapter-uws/assert]` line and continued were promoted to the hard tier: a duplicate or re-entrant connection open on a handle whose platform slot is already set, a message on a connection with no platform slot (open never ran or the slot was clobbered), a per-connection subscription slot that is not a `Set` (on the wire-subscribe and server-side `platform.subscribe` paths), and a zero-length frame at the `platform.publish` / `platform.publishWire` send sites. Each is a structural corruption that cannot be recovered by dropping one frame - continuing would broadcast garbage or overwrite live per-connection state - so they now schedule a deferred worker restart with exit code 78 (the same code the cross-worker divergence restart uses), after the current callback frame unwinds, exactly like the existing relay frame-type guards. Healthy traffic never trips them; the guard at each site is a single truthiness or `instanceof` check identical in cost to the assertion it replaces, so the publish, message-dispatch, and subscribe hot paths are byte-unchanged. The deliberately-recoverable counterpart - a momentary negative subscription-cap counter under concurrent-close churn - stays soft (it logs and surfaces in the counter rather than risking a worker kill on a transient dip). The neighbouring `send`, batch, and unsubscribe shape checks also stay soft.

## [0.6.0-next.25] - 2026-06-13

### Added

- **The CRDT document replica: the server authority and the client channel behind conflict-free shared documents.** Two new export subpaths complete the document primitive whose wire codec shipped in 0.6.0-next.20. `svelte-adapter-uws/plugins/crdt/replica` (server): `createCrdtAuthority(options)` manages per-topic authoritative replicas - reference-counted lifecycle where concurrent cold joins coalesce onto ONE `persist.load` (N simultaneous joiners to an empty document produce exactly one database read), `applyUpdate` merging inbound updates and returning the normalized bytes for verbatim fan-out, `diff(topic, stateVector)` answering each joiner with exactly the structs it lacks regardless of how long it was away, and a persistence schedule that is never on the message path: a trailing debounce (`debounceWait` 2000ms) with a sustained-edit force (`debounceMaxWait` 10000ms), update-count compaction (`snapshotEvery` 200), and a final store on the empty transition (`persistOnEmpty`) so an edit-then-disconnect is never lost - a dirty replica is never destroyed before its bytes are durable, store failures surface through `onError` and retry on a floored cadence, and a connect/disconnect flap coalesces instead of multiplying store calls. `persist.store` may resolve `false` to DECLINE a write without failing it (a cluster instance that does not hold the per-topic persist lease): the topic stays dirty and re-probes at the `debounceMaxWait` cadence until a write lands, and the replica may still unload (the data is durable wherever the write does land). The app owns the I/O through two hooks (`persist.load` / `persist.store`); the authority owns only the schedule. `normalizeCrdtAccess` ships alongside: the `{read, write, comment}` access record with boolean widening (a `() => user != null` guard never learns the record shape) and safe partial-record defaults (`{read: true}` means read-only). `svelte-adapter-uws/plugins/crdt/channel` (client): `createCrdtChannel({ transport })` owns the local replica every read hits - local writes apply synchronously (there is no pending state) and emit one opaque update per transaction; remote updates apply origin-tagged so they are never echoed back; on every connection open the channel runs one idempotent two-way state-vector exchange (apply the server's diff, upload exactly what the server lacks), which makes the local document itself the offline queue - a two-hour offline session reconnects with one bounded blob and zero frame bookkeeping. Frames that race the first sync are buffered and replayed (the merge is idempotent, so overlap is free), and after every apply the channel checks the replica's pending-structs gauge: a dependency gap means a frame was lost somewhere - backpressure, a dropped fallback, anything - and schedules a debounced resync, so every silent-drop path converges through one detector. Container facets (`map` / `array` / `text`) expose imperative reads/writes with granular change notifications for a reactive layer; read-only mounts fail fast on mutation (a CRDT cannot reconcile away local-only edits, so silently accepting writes the server will reject would fork the local view forever). Built on `yjs` (new dependency; loaded only when a crdt subpath is imported - the codec subpaths stay dependency-free). Single-edit merge measures ~2us and full-state compaction ~51us at a 100-entry document (`bench/micro-crdt-apply.mjs`).
- **Client wire codecs now receive the resolved topic name.** The binary demux passes the topic as a fifth argument to `decode` (and `onCrdtFrame` handlers receive it on the frame), so a sink codec serving several documents on one prefix routes each frame to the right replica. Additive; existing codecs ignore the extra argument.
- **`CRDT_TOPIC_PREFIX` is exported from the server-side crdt plugin** (it previously existed only on the client side), so server code building document topics shares the one definition.

## [0.6.0-next.24] - 2026-06-12

### Added

- **Sender exclusion on `platform.publishWire`: `{ excludeWs }` withholds a publish from one local socket on every delivery path.** A publisher whose client already holds the state can broadcast an update without echoing it back to the originating connection: the per-subscriber walk skips the excluded socket for binary frames and JSON fallbacks alike, and a publish that would have taken the single C++ fan-out (no capable client, or a codec-declined frame) takes a per-subscriber walk instead, so the exclusion holds there too. The cross-worker relay still fires exactly once - exclusion is local to the instance that owns the socket, the only place it can be connected. Mirrored in `createTestServer` and in the vite dev platform (dev `publishWire` delegates to the dev `publish`, which now honors the same option), and typed on the `Platform` interface. `sendWire` is single-target and is unchanged.
- **Cursor self identity (`you`) and an opt-in `hideSelf` render filter.** The cursor server now tells every connection which roster key is its own via a single-target `you` event: once before the connection's first `join` broadcast on a topic, and in every snapshot reply (between the `time` seed and the `catalog`), so snapshot-then-move keeps one identity and a pure viewer is never announced to others. The event is additive and JSON-only (the binary codec declines it, like `time`); an older client's merge ignores it as an unknown event, and it never becomes an entry in the cursor Map. On the client, the plain `cursor(topic)` store gains a `self` readable and the canvas handle gains a `self` getter - both `null` until the server assigns the key (the first `move()` on a topic triggers it for connections that never snapshot). The new `hideSelf: true` canvas option excludes the viewer's own cursor from the canvas and the optional `mainThreadFeed`, in the worker and the main-thread fallback alike, so the painted layer stops echoing the OS pointer; the filter key always crosses from the main connection (the render worker's own socket has a different key and never adopts its own `you`), and the data surface stays complete - the filter affects pixels, never data.
- **The smooth plugin: prediction, reconciliation, and the command/acknowledgement wire for server-authoritative entities (`smooth.protocol:1`).** Two new export subpaths complete the smoothing primitive whose interpolation half shipped in 0.6.0-next.23. `svelte-adapter-uws/plugins/smooth` (server): `createSmoothAuthority({ apply, onMissing, queueCap })` - the authoritative command processor for one topic: per-owner command queues drained whole per tick in arrival order through the app's shared `apply(state, command, ctx)`, acknowledgements carrying the last applied command id plus the resulting state (the owner's reconciliation basis), per-tick `onMissing` continuation for command-less entities with rest detection, re-bind semantics for a returning identity on a new socket, and a pure time/transport-free surface the caller ticks and publishes for; `createSmoothWireCodec()` - the binary codec for smoothed topics (compact coordinate and JSON state updates with the delta-coded server stamp, acknowledgements with an absolute in-data stamp so the round trip seeds the client clock even over JSON, removals; dictionary-only, additive JSON fallback for everything else). `svelte-adapter-uws/plugins/smooth/client`: `createSmoothChannel(options)` - the client half wiring the prediction core to the singleton connection with an injected transport: immediate local apply per command with a sliding un-acked window, replay-on-acknowledgement reconciliation where corrections below `errorThreshold` snap silently and larger ones keep the rendered position continuous while easing over `smoothTimeMs`, frame-batched command flushing (`cmdRate`), remote-entity interpolation through the shipped smoother, acknowledgement round trips feeding the server-clock estimator's upper bound, window-overflow prediction kill with resync-driven recovery, and `now()` - the estimated server wall clock for command stamping. The pure cores are also new: `plugins/smooth/predict.js` (the window/replay/correction state machine), `plugins/smooth/random.js` (`createSharedRandom` - a reseedable deterministic generator; `ctx.rng` is reseeded per command id so randomness inside `apply` is identical on prediction, replay, and the server), and `files/keydict.js` (the per-connection short-id key dictionary and delta-stamp helpers, extracted unchanged from the cursor codec and now shared by both wires). Replay of a 5-command window measures ~85ns and the steady-state loop allocates nothing beyond the by-contract window entries (`bench/35-smooth-replay-ab.mjs`, `bench/micro-smooth-replay-alloc.mjs`).

### Fixed

- **A binary frame dropped under backpressure no longer desyncs that connection's wire permanently.** The per-connection dictionary codecs (the stamped cursor wire, the new smooth wire) advance their state during encode, so a frame uWS silently dropped past `maxBackpressure` left the client's decoder out of lock-step forever: later short-id references decoded to nothing (an entity frozen on that connection until reconnect) and later delta stamps skewed. A dropped send (including a dropped `wire-id` announce) now disposes that connection's codec state for that capability and degrades the connection to the JSON envelope - full keys, absolute values, correct by construction - until it reconnects, when binary resumes. Mirrored in `createTestServer`.
- **Dispatched topic envelopes now carry the codec metadata the decoders attach.** The inbound `0x03` demux reconstructed each frame's server stamp (`t`) and sequence (`seq`), but the store dispatch rebuilt the envelope without them, so no consumer on the main connection could read either - including the cursor canvas's main-thread fallback, whose interpolation had silently run on frame-arrival times instead of server stamps. Both fields now ride the dispatched event (typed on `WSEvent`); store merges ignore them as before.
- The smooth codec declines an acknowledgement whose stamp is missing or invalid instead of coercing it to epoch 0 (the JSON form simply omits the field, and both wire forms now behave identically), and both binary codecs route coordinates beyond float32 range to the lossless JSON encoding instead of narrowing them to Infinity on the wire.

## [0.6.0-next.23] - 2026-06-12

### Added

- **Smooth remote cursors: `cursor(topic, { canvas, smooth })` renders remote pointers through buffered interpolation.** Each remote cursor keeps a short ring of server-stamped position samples, and every render frame paints the position interpolated between the two samples straddling a render time held a small delay behind the newest data - so motion between wire frames fills in at full display rate and a single dropped frame is invisible instead of a freeze. `smooth: true` selects the tuned defaults; the object form exposes three knobs: `interpolationMs` (the render-in-the-past delay; `'auto'`, the default, tracks twice the measured update interval and collapses toward a 32ms floor when updates already arrive at display rate, so a fast LAN pays almost nothing), `extrapolateMs` (a hard cap on dead-reckoning when the buffer runs dry, default 250; past it the cursor rests where extrapolation stopped rather than flying off a stale heading), and `snapGapMs` (a sample gap treated as a discontinuity - a view re-entry, an idle resume - and snapped rather than smeared, default 500). The identical state machine runs in the render worker and the main-thread fallback, so the worker/fallback split keeps painting the same motion; the dirty gate widens to "render while any ring holds un-played motion" and closes again once everything settles, so an idle board stays as cheap as before; the `mainThreadFeed` keeps shipping raw wire positions (smoothing changes pixels, never the data surface). The interpolation core lives in dependency-free modules (`plugins/smooth/interpolate.js`, `plugins/smooth/clock.js`) that take every time reading as an argument, ready for reuse by non-cursor smoothed entities. The hot path is allocation-free and costs ~35ns per cursor per frame (`bench/34-smooth-straddle-ab.mjs`, `bench/micro-smooth-alloc.mjs`).
- **A server-stamped cursor wire (`cursor.protocol:4`, schemaVersion 3) and a per-socket server-clock estimator.** A client that advertises the new capability on top of the dictionary wire receives position frames carrying the server's wall clock, delta-coded against the connection's previous stamp - one byte per frame steady-state, the absolute epoch only on the first frame after (re)connect - written between the op byte and the first keyref of `update`/`bulk` (roster ops carry no stamp). The stamp state lives in the per-connection dictionaries with the same discipline as the key dictionary: in-order, reset on reconnect, untouched on a JSON fallback. The snapshot reply now leads with a `time` event carrying the server wall clock (an additive JSON envelope older clients ignore as an unknown event; sent even for an empty board), pairing the snapshot request into a measurable round trip. The client-side estimator reconstructs the server's clock as a windowed maximum of one-way lower bounds clamped under the round trip's upper bound, applied through a slew limiter so the render time axis never jumps, sampled against the monotonic clock (immune to local NTP steps), and reset per socket per reconnect (a reconnect may land on a different machine). Smoothing degrades gracefully without the capability - the interpolator runs on arrival times, which still smooths but breathes with network jitter. Old client and old server combinations are unaffected: unknown capability tokens are ignored, unknown schema versions are dropped.

## [0.6.0-next.22] - 2026-06-12

### Added

- **Canvas rendering for cursors: `cursor(topic, { canvas })` moves the whole ingest-decode-merge-paint pipeline into a dedicated worker.** Hand the existing `cursor()` call a canvas element and it returns a handle instead of a store: `mount()` (returns its teardown, so `$effect(() => cursor(t, { canvas }).mount())` is the complete lifecycle), `viewport(source)`, `configure({ colorOf, hide })`, and `destroy()`. The worker owns a second WebSocket subscribed only to the cursor topic (identified with the `svelte-realtime-cursor` subprotocol so the admission gate's cursor lane can route and shed it), decodes binary cursor frames off the main thread, tracks the viewport source (reporting the rect on its own socket for server-side culling and culling its own paint), reconnects on its own backoff with the same liveness recycling as the main connection, and paints through a density-aware renderer: Canvas2D below `gpuThreshold` (default 500) in-view cursors, automatic promotion to an instanced WebGL2 backend above it (one draw call per frame at any count; a canvas's context type is permanent, so promotion keeps the target's 2d context as a presenter and blits an internal surface - never a backend thrash). `rendering: 'main'` forces main-thread rendering and exposes `handle.store` (the classic reactive Map); `rendering: 'worker'` refuses to silently degrade. On browsers without the worker pipeline the same call renders on the main thread through the same backends with identical output. The opt-in `mainThreadFeed` posts a thinned, rate-capped position feed back as `handle.feed` (board coordinates, transferred buffers, roster-joined; ~30 microseconds of main-thread work per tick at 500 in-view cursors). Unmounting pauses the worker and a remount on the same canvas resumes it, same or different topic; `FinalizationRegistry` reaps the worker when the canvas element is collected. The classic no-canvas store path is byte-for-byte unchanged.
- **`trackedSubscribe` / `trackedUnsubscribe` in `files/utils.js`:** subscribe/unsubscribe a socket the way the wire-level path does - the native uWS call plus the connection's subscription registry. Plugins establishing server-side membership must use these (cursor, presence, and groups now do); the registry is what `platform.publishWire`'s per-subscriber walk delivers by.
- **The vite dev WebSocket server now echoes a client's offered subprotocol**, matching the production upgrade's pass-through, so clients that dial with one (the cursor render worker) complete their handshake in dev.
- **The vite plugin extends `server.fs.allow` with its own package directory**, so the cursor worker's module chunk (a raw `?worker_file` request that does not get the known-module bypass regular imports get) serves in dev under linked installs instead of 403ing.

### Fixed

- **Sockets subscribed server-side by a plugin now receive stateful-codec binary publishes.** `platform.publishWire`'s per-subscriber walk delivers by the connection's subscription registry, but the cursor snapshot handshake and presence join/sync subscribed sockets natively only - so the moment any binary-capable client subscribed a topic, every snapshot-joined cursor subscriber and every presence member silently received nothing from that topic's binary publishes (JSON-only deployments were unaffected). Membership now registers through `trackedSubscribe`/`trackedUnsubscribe` at every cursor, presence, and groups site, with symmetric removal on presence leave paths. One accounting consequence, intentionally kept: plugin-established memberships now count toward the per-connection wire-subscription cap, since they consume the same per-socket resources.
- **Browser production builds that bundle the cursor plugin client no longer fail on node-only imports.** `plugins/cursor/decode.js` read its clock through the node-side runtime module (which imports node builtins); it now reads the browser runtime seam, which binds to the identical primitives under node, so tests and the characterization suite are unchanged.
- **Renderer surfaces follow a changing device pixel ratio.** A monitor move or browser zoom changes `devicePixelRatio` mid-session; the viewport pump now carries the current value to the worker and the main-thread fallback re-reads it every frame, so the canvas rescales instead of painting at the stale density.

### Changed

- **The reconnect backoff curve (`nextReconnectDelay`) moved to `client-runtime.js`** - the worker-safe module every socket owner can import - and is re-exported from `client.js`, so the public surface is unchanged.

### Added

- **Admission and posture observability via a new `websocket.metrics` option.** Pass a Prometheus-style registry (the extensions `createMetrics()` fits as-is) and the adapter registers and emits six instruments covering the whole admission stack: `upgrade_admitted_total`, `upgrade_rejected_total{reason}` (reasons `siege`, `over_capacity`, `cursor_lane`, `ip_rate_limit`, `bad_origin`, `auth_timeout`, `auth_rejected`, `hook_error`), `upgrade_inflight`, `waiting_room_queue_depth`, `protection_posture_state` (0/1/2), and `protection_posture_transitions_total{from,to}`. The gauges ride the existing pressure sampler (no new timer); the accept path adds one unlabelled counter increment when enabled and a single undefined check when off; no client identity ever appears in a label; the counters record server decisions, so a client that disconnects mid-upgrade is counted in neither. Instrument failures are contained - a registry that throws on emit logs once and is silenced, never disturbing a response, an admission slot, or the sampler, while a registry that throws at instrument creation fails at startup, loudly. Each posture change additionally logs one `[ws] protection posture <from> -> <to>` line with the rolling reject rate and the base pressure reason that drove the machine, registry or not. `createPosture` gained an optional `onTransition(from, to)` observer (fired after the machine settles, exception-contained, never fired by a pinned level). `createTestServer` mirrors the two counters at the upgrade branches it mirrors and accepts the same `metrics` option, so admission counters are assertable in integration tests; a new `bench/admission-upgrade-overhead.mjs` bounds the accept-path overhead with and without a registry.

### Fixed

- **A synchronously-throwing `upgrade` hook no longer leaks its admission slot.** The hook call site only handled rejected promises; a hook that threw before returning escaped the upgrade callback without serving a response and without releasing the in-flight admission slot, so repeated synchronous hook failures could pin `upgradeAdmission.maxConcurrent` shut until restart. A synchronous throw now takes the same path as an async rejection: a `500`, the slot released, and (with metrics enabled) an `upgrade_rejected_total{reason="hook_error"}` increment. Same fix in the production handler and the `createTestServer` mirror.
- **`TestServerOptions` now declares the `protection` option** that `createTestServer` has accepted since the posture shipped; previously TypeScript users had to cast to pass it.
- **The waiting-room queue-depth estimate no longer freezes at its last count after polling stops.** The rolling two-window poll counter only decayed when a new poll rolled the window, so a reader with no poll in front of it - the holding page served by a direct navigation, and the new `waiting_room_queue_depth` gauge - kept reporting the final window's count indefinitely after the room emptied. The window math (now shared between the production handler and `createTestServer` as `createPollCounter`) fades an un-rolled window to zero over one interval and reads zero after two.

## [0.6.0-next.20] - 2026-06-10

### Added

- **A CRDT document wire codec that rides the existing `0x03` binary frame.** `svelte-adapter-uws/plugins/crdt` exports `createCrdtWireCodec()` - hand it to `platform.publishWire` / `platform.sendWire` and a subscriber that negotiated the `crdt.protocol:1` capability receives a compact `0x03` frame carrying opaque CRDT update bytes with opcode discrimination (`update` / `snapshot` / `sync-request`); everyone else transparently receives the identical JSON frame, so a non-capable client keeps working with no update lost. The companion `svelte-adapter-uws/plugins/crdt/client` registers the decoder as a `sink` (it applies each frame in place and dispatches no store event) and exposes `onCrdtFrame(handler)` to observe the decoded `{ op, bytes, schemaVersion, seq }` as it is applied. The codec is intentionally library-agnostic: it frames the update bytes verbatim and never interprets them, and it is built from one definition shared with the cluster-backed CRDT backend so the in-memory and cluster wires never drift. Purely additive: no behaviour change for any existing plugin or transport.

- **A hard-tier framework assertion (`fatal`), a shared invariant-predicate module, and an in-process consistency auditor.** A new `fatal(cond, category, context)` sits next to `assert` as the hard tier for genuinely unrecoverable worker state: it shares the same `platform.assertions` counter Map (one namespace; the structured log carries `severity: 'fatal'`), and in production schedules a DEFERRED worker termination with exit code 78 after the current callback frame unwinds - distinct from the supervisor's config-error exit so ops can tell a crash-on-bad-state apart from a crash-on-bad-config. In test mode it throws; the deferred exit is injectable via `setFatalSink` so a simulation harness captures fatals instead of exiting. The shared invariant predicates (`files/invariants.js`) run against a plain, structure-only state snapshot (no payload bytes, no user data) and are now the single source of truth imported by both the simulator and the new auditor (`files/auditor.js`), which runs them on a slow, unref'd, RNG-jittered background timer (default 5s) over a bounded round-robin window, NEVER on the hot path. The simulator's existing subscription-bookkeeping check now delegates to the shared predicate with no change in the violations it reports. Purely additive infrastructure.

### Changed

- **The cross-worker relay's structural guards (`relay.topic-type`, `relay.envelope-type`) are now hard-tier.** A non-string topic or an empty/non-string envelope arriving from a sibling worker means the framework's own relay serialization is structurally broken and would misroute or send garbage to every local subscriber and, transitively, cluster-wide; that is not recoverable by dropping one frame, so it now escalates from a soft log to a deferred worker restart (exit code 78). Well-formed relay traffic is unaffected.

## [0.6.0-next.19] - 2026-06-07

### Added

- **`svelte-adapter-uws/sim` now re-exports the composition primitives a downstream package needs to build a custom multi-instance runner over the same virtual clock.** `setRuntimeEnv` / `resetRuntimeEnv` (install and tear down the runtime seam), `resetProcessEpoch` (re-latch the per-process seq-space generation), and `createInMemoryUwsHelpers` (the in-memory uWS helper bundle `createTestServer` needs alongside the in-memory app) are now public alongside the already-exported `createScheduler` / `createSeededRng` / `createFaultEngine` / `createInMemoryApp`. This lets an external harness - for example a redis or postgres-backed simulation in another package - drive the same `createTestServer` dispatch over the in-memory app on one shared scheduler, installing the seam on its own runtime module too, without re-implementing the runner. Purely additive: no behaviour change, and `runSim` / `runSimMany` / `replaySim` are unaffected.

## [0.6.0-next.18] - 2026-06-07

### Added

- **`svelte-adapter-uws/sim`: `runSim({ workers })` extends the deterministic simulator to a multi-worker cluster, so a seed reproduces a clustered interleaving - cross-worker delivery, the restart-budget supervisor, and worker-flap outcomes - bit-for-bit.** With `workers > 1` the runner builds N in-memory servers over one shared virtual clock and models the production cluster the single-worker harness could not reach. The cross-worker pub/sub relay is modeled end to end: a worker's publish coalesces into a batch, crosses a fault-gated in-memory bus, and re-publishes on every other worker with no seq re-stamp and no re-relay - covering both the single-publish path and the wire-batched path (the latter re-running its fan-out detection against the receiving worker's own subscriber and capability set, and honouring per-message `relay: false`). The restart-budget supervisor is modeled too: heartbeat-driven wedged-worker detection, exponential-backoff restarts, and a reproducible `restart-budget-exhausted` outcome when a worker crash-loops (surfaced on `result.fatals`). A `relayFaults` spec applies drop / delay / reorder / duplicate / corrupt to the cross-worker channel independently of the per-worker wire faults; `clusterMode: 'reuseport' | 'acceptor'` selects the topology (acceptor adds the all-workers-down listen pause). `api.worker(i)`, `flapWorker`, `wedgeWorker`, and `advanceTime` script a multi-worker scenario, and a quiescent no-misdelivery invariant (checked against the uncorrupted routing key, so it is immune to the corrupt fault) runs per worker. `replaySim` self-gates that the same per-worker frames, restart outcomes, metrics, and virtual end-time reproduce. `workers` defaults to 1, which is byte-identical to a single-worker run. The relay is modeled at the platform level via a sim-only injection seam on `createTestServer` (off on every normal path); production `handler.js` / `index.js` are untouched. Dev/test infrastructure - it ships in the package but pulls in no new runtime dependency.

## [0.6.0-next.17] - 2026-06-07

### Added

- **`svelte-adapter-uws/sim`: a deterministic simulation harness that drives the real wire dispatch over an in-memory server under a virtual clock and a seeded fault model, so a seed plus a commit is the entire bug report.** `runSim(config?)` connects in-memory clients to an in-memory app, scripts subscribe/publish traffic, and runs framework dispatch under a discrete-event scheduler that models the event loop's microtask -> timers -> check phase boundary (a `setTimeout(0)` lands in a later timers phase, never collapsed into the microtask drain, so the publish/relay coalescers batch exactly as in production). A seeded PRNG backs every clock, RNG, UUID, and timer through the injectable runtime, and a seeded fault engine applies drop / delay / reorder / duplicate / corrupt per wire frame - so the seed fully determines the run. `runSimMany({ seeds, base })` sweeps seeds; `replaySim(result)` re-runs and self-gates that the same invariant violations and structural state reproduce bit-for-bit. The harness runs the same `createTestServer` dispatch that runs over real `uWebSockets.js`, so there is no second implementation to drift; `createTestServer` gained an internal injected-app path and its timers/clock/UUID now route through the runtime seam (behaviour is unchanged for existing callers, and the default path still constructs a real server). After every step a subscription-bookkeeping invariant checks that each connection's fan-out subscription set agrees with its counted set. Dev/test infrastructure - it ships in the package but pulls in no new runtime dependency.

## [0.6.0-next.16] - 2026-06-07

### Security

- **Presence and cursor snapshot handshakes now authorize against the underlying topic before joining the tap channel.** The `presence-snapshot` / `cursor-snapshot` messages are the server-side path by which a socket joins the `__presence:` / `__cursor:` broadcast channel (the client deliberately never wire-subscribes a `__` topic). That path previously granted membership - and emitted the current roster / positions - with no authorization, so a client could read a tap channel for a topic it was not allowed to subscribe to (a bypass of the wire-level `__`-subscribe block added earlier). The handshake now runs `platform.checkSubscribe(ws, topic)` (the same check a wire-subscribe runs) and drops a denied request without subscribing or emitting. High-frequency cursor `update` / `viewport` frames keep their synchronous `isSubscribed` gate - they require a prior authorized snapshot - so the hot path is unchanged.

### Fixed

- **In-memory cursor sync no longer silently no-ops in the zero-config server.** The cursor plugin gated its message hook on the socket being subscribed to `__cursor:{topic}` but never subscribed it (and the client does not wire-subscribe `__` topics), so `cursor()` / `move()` reached nobody. The plugin now owns membership: the `cursor-snapshot` handshake subscribes the socket (after the authorization above), mirroring the presence plugin, so cursor sync works with `createMessage({ onUnhandled: cursor.hooks.message })` out of the box.

- **Presence no longer freezes a sync-observer's roster when a co-resident participant leaves.** A single socket can be both a participant (`presence.join`) and a sync-observer (`presence-snapshot`) of the same topic; leaving the participant role unconditionally unsubscribed the socket from `__presence:{topic}`, so the observer stopped receiving the leave diff and later heartbeats. Membership teardown now peels one role at a time and releases the wire subscription only when no role remains.

## [0.6.0-next.15] - 2026-06-07

### Added

- **`svelte-adapter-uws/safe-url` (`isSafeUrl` / `checkUrl` / `checkUrlResolved`): an SSRF-defence URL validator for server-side handlers that fetch a user-supplied URL.** A handler that fetches an attacker-controlled URL (an outbound webhook, a link-preview, an avatar-from-URL import) can be steered back inside the trust boundary - the cloud instance-metadata endpoint (`169.254.169.254`), a loopback admin panel, an RFC1918 service. `isSafeUrl(url)` answers "is it safe to fetch this" with one boolean in a zero-config strict default: it rejects non-http(s) schemes and blocks loopback, the unspecified address, IPv4 link-local, the cloud-metadata targets, RFC1918, IPv6 ULA, and IPv6 link-local, defeating the IP-obfuscation evasions a naive string match misses (decimal/octal/hex/short-form IPv4, IPv4-mapped/compatible IPv6, userinfo smuggling, trailing-dot/case) by reading the parsed `URL.hostname`. `checkUrl(url, options)` returns `{ safe, reason }` and supports `mode` (`strict` / `allowlist` / `off`); the async `checkUrlResolved(url, { resolve })` closes the DNS-rebinding gap with a caller-supplied resolver. Pure, dependency-free, isomorphic. This is the single canonical copy for the ecosystem: `svelte-adapter-uws-extensions/safe-url` re-exports it and `svelte-realtime` imports it directly, so there is no duplicated SSRF logic to drift. (It previously lived only in the extensions package; that export is unchanged.)

## [0.6.0-next.14] - 2026-06-07

### Added

- **`upgradeAdmission.cursorLane`: a sheddable, deprioritised upgrade lane for a cursor-only second WebSocket, so a flood of cursor connects can never starve the main WebSocket admission.** When `maxConcurrent` is set, `cursorLane: { fraction }` reserves a fraction of the gate (default `0.25`, at least one slot) for upgrades that request the `svelte-realtime-cursor` subprotocol. A cursor upgrade is admitted only while both the main ceiling and the cursor sub-budget have room; the main lane's own admission never waits on the cursor sub-budget. The cursor lane is refused first and, under `siege`, refused entirely - always with a bare `503` (never the holding page, since the cursor connection is not a browser). The full cursor budget stays available at both `normal` and `elevated`. A saturated cursor lane counts as genuine capacity pressure, so it can still let an `auto` posture escalate. The server keeps echoing the negotiated subprotocol back to the client unchanged. Strictly additive: omit `cursorLane` and the second counter never increments - admission is byte-identical to before.

- **An injectable clock/RNG/timer runtime, surfaced as `platform.now()` / `platform.monotonic()` / `platform.hlc()` / `platform.random`.** Every wall-clock read, monotonic timer, PRNG, UUID, and timer in the adapter (runtime, plugins, and the browser client) now routes through one swappable runtime module; its default binds the native primitives with no measurable hot-path cost (a micro-benchmark gates `now()` under single-digit-percent overhead). `platform.now()` is the cached wall clock, `platform.monotonic()` a clock-step-immune duration source, `platform.random` a `{ float, u32, uuid, bytes }` generator, and `platform.hlc()` a hybrid logical clock (`{ wall, logical, nodeId }` with a non-decreasing wall and a same-millisecond tiebreaker). The browser client gets the same surface via a browser-backed runtime (Web Crypto + global timers, no Node built-ins). A dependency-free `scripts/check-determinism.js` check, wired into `pretest`, keeps raw native time/RNG/timer calls out of the routed source. Strictly additive and zero-config; an existing deployment is unaffected.

## [0.6.0-next.13] - 2026-06-06

### Added

- **Resume now carries a per-topic epoch so a reconnecting client that points at a seq space which has since reset is cold-rehydrated instead of being served a fresh seq space as if it were contiguous.** The per-topic `subscribed` ack gains an `epoch` field (the current generation of that topic's seq space); the client tracks it per topic and presents it back, alongside its `lastSeenSeqs`, as `lastSeenEpochs` on resume. The resume hook receives `ctx.lastSeenEpochs` and a new `platform.topicEpoch(topic)` accessor: compare them per topic and gap-fill on a match, or re-read from the source of truth on a mismatch (a process restart resets the in-memory counters, so the generation differs). Strictly additive - an old client omits the epoch and resumes exactly as before (missing is treated as a match), and an unchanged single-worker deployment emits the byte-identical `{"type":"resumed"}` ack. In a single worker the in-memory counters all reset together on a restart, so every topic shares one per-process generation; the per-topic wire shape lets a backend with its own per-topic seq authority vary the value independently without a wire change. The `epoch` field is best-effort: if a backend's `topicEpoch(topic)` accessor throws, the ack still goes out with the per-process generation as a fallback, and the throw is never charged to the closed-socket abort counter.

## [0.6.0-next.12] - 2026-06-05

### Added

- **`protection`: a graduated admission posture (`normal` / `elevated` / `siege`, or `auto`) that escalates the upgrade stance under load and relaxes on recovery.** `auto` reads the existing `platform.pressure` signal (no new sampler) and moves through the levels with hysteresis - escalate fast, relax slow, so it cannot flap: `normal -> elevated` after a sustained active-pressure dwell, `elevated -> siege` only when over-capacity upgrade rejects run at twice the gate's admit rate, and downward only after a longer quiet dwell. Each level drives the admission waiting room: `elevated` widens the `Retry-After` jitter, `siege` refuses every new upgrade (holding page / 503) and makes `/__admit-check` always poll-again. Existing connections are never dropped at any level. `platform.protection` exposes the live level; pin `'elevated'` / `'siege'` for incident response. The pressure `reason` enum gains `CAPACITY` (precedence `MEMORY > CAPACITY > PUBLISH_RATE > SUBSCRIBERS`), surfaced when posture is engaged; no other reason is added. Default `'normal'` is a true no-op - the reject path, pressure, and poll responses are byte-identical to before.

## [0.6.0-next.11] - 2026-06-05

### Added

- **`upgradeAdmission.waitingRoom`: turn the over-capacity `503` into a content-negotiated waiting room.** When the upgrade gate is at capacity (`maxConcurrent` set), a browser navigation now gets a small self-polling HTML holding page that auto-reloads the moment capacity frees, while a WebSocket upgrade or a non-HTML client keeps a `503` - refined with a jittered `Retry-After` header. On by default whenever `maxConcurrent > 0`; opt out with `waitingRoom: false` to disable polling. An opted-out HTML navigation receives a minimal accessible `503` document, while WebSocket and non-HTML clients retain the exact bare response. The page polls a read-only `/__admit-check` endpoint that returns `202` with a queue-depth/ETA body while full and `200` when capacity exists, consuming no gate slot (the poll can never itself be rejected). Configure the routes, poll cadence, `Retry-After` base, and page template via `waitingRoom: { path, admitCheckPath, retryAfterSeconds, pollIntervalMs, template }`. No WebSocket frame or existing-connection behavior changes.

## [0.6.0-next.10] - 2026-06-05

### Added

- **`platform.pressure` gains a `value` field: a single `0..1` saturation scalar (`0` idle, `1` saturated).** It folds the worst of the existing threshold signals (publish rate, subscriber ratio, memory) with the worst per-connection outbound send-pressure, so `platform.pressure.value > 0.8` is a coarse "is the server under load" gauge you can read without inspecting individual reasons. The `reason` enum is unchanged (`NONE | PUBLISH_RATE | SUBSCRIBERS | MEMORY`).

### Changed

- **Connections now flow-control their own outbound work, bounding a slow consumer's queue without any configuration.** When a client opts in at the handshake, the server hands it a windowed send budget sized from live server pressure and replenishes it as work drains; the client paces its flow-controlled sends against that window and, under sustained pressure, surfaces `degraded` health instead of growing an unbounded send queue. The mechanism is entirely internal adapter-to-adapter - no budgets, deadlines, or counts ever reach the application surface, and the pressure `reason` enum gains no new value. A connection that does not opt in takes the byte-identical immediate send path as before, verified by a no-regression bench on the non-flow-controlled publish/single-target hot path.

## [0.6.0-next.9] - 2026-06-05

### Changed

- Extracted the client-side cursor-store merge into `plugins/cursor/decode.js` (`applyEvent`, `mergeOutput`, `sweepExpired`) as pure functions over an explicit `{ positionMap, userMap, timestamps }` state. `plugins/cursor/client.js` now imports them instead of inlining the catalog/join/update/bulk/remove arms, the output build, and the maxAge sweep, so the merge is a single definition. Behavior-preserving refactor: no API, wire, or option change, and the full cursor suite stays green (a new `test/cursor-decode.test.js` pins the merge semantics for a fixed frame sequence). `decode.js` is an internal module (not a new package export); it consumes the already-decoded `{ event, data }` shape that the JSON path dispatches and `plugins/cursor/codec.js#decodeCursor` produces for a binary frame, so transport makes no difference to it.

## [0.6.0-next.8] - 2026-06-05

### Added

- **Cursor jitter filter (`minMove`).** Opt-in cursor-volume reducer alongside viewport culling and backpressure, at ingest rather than fan-out: `cursors.update` drops a move when it has not moved at least `minMove` (Chebyshev distance, in the units `position` returns) from the **last broadcast** position, so a burst of sub-threshold wobble around a point is never fanned out (the threshold is measured against what the subscriber last saw, not the last stored value, so a slow drift still delivers every `minMove` units). When movement then stops, a debounced settle delivers the final resting position once - even if it is within `minMove` of the last broadcast - so a still cursor is never left stranded at a stale point; an exact repeat stays dropped because the settle sends nothing when the rest position is unchanged. Reuses the `position` extractor shipped for culling (a non-finite or unextractable coordinate is always delivered, never silently filtered) and keeps the dropped frame as the latest value, so `list()`/`snapshot()` (SSR, late joiners) see the true current position. `cursors.stats()` gains `jitterDropped` to confirm the filter is firing. Off by default (`0`) for parity with viewport culling and backpressure and because the right threshold depends on the app's coordinate scale; `minMove: 1` drops exact-repeat integer-pixel frames at no visual cost, `2`-`4` suppresses high-DPI sub-pixel wobble. No wire change; the zero-config path pays nothing (the filter and its `position` call run only when `minMove > 0`).

## [0.6.0-next.7] - 2026-06-04

### Added

- **Cursor viewport culling (`viewport: true` / `viewport: { enabled, padding, cell }`) + `position` extractor + client auto-reporting.** Opt-in server-side culling that sends each reporting subscriber only the moving cursors inside its last reported viewport rect, widened by a `padding` overscan (board units, grown by `1 / zoom` when zoomed out). A subscriber that never reports a rect is treated as whole-board and is never culled, so culling can never blank a board. `position` (default reads finite `data.x` / `data.y`) extracts the coordinate the cull tests; returning `null` (or throwing) opts a single frame out of culling so a coordinate-less frame is delivered to everyone. The client side becomes one option: `cursor(topic, { viewport: () => boardEl })` auto-reports the visible region on scroll/resize/zoom/late-mount while subscribed (a getter handles a late-bound `bind:this`), sending only on change - no manual `reportViewport` wiring (still exported for custom transforms). Internally the flush builds a transient per-flush spatial index only past a large mover count and falls back to a flat bounds test below it (the common case); a degenerate wide viewport delivers everything (bounded cost), never a blank board. The per-subscriber walk engages **lazily**: a viewport-enabled topic keeps the shared fan-out until one of its subscribers reports a viewport, so enabling culling globally costs nothing on topics whose clients never report. `cursors.stats()` gains `viewportsReported` + `culledEntriesDropped` for diagnosing a misconfigured setup (e.g. a coordinate-space mismatch). On a spread-out board this cuts per-subscriber cursor traffic by roughly the board-to-viewport ratio (~26x in the bundled `bench/30` A/B). Additive and off by default - the zero-config path keeps the shared-frame fan-out unchanged - and adapter-only (no wire-format change: a per-subscriber slice rides the same `update` / `bulk` frames an old client already merges).

- **Cursor backpressure-aware per-subscriber drop (`backpressure: true` / `backpressure: { enabled, maxBufferedBytes }`).** Opt-in: when enabled, a topic's flush walks the subscribers and skips any whose queued bytes (`platform.bufferedAmount`) exceed `maxBufferedBytes` (default 1 MiB) for the current flush. Cursors are latest-value, so a skipped subscriber catches up on the next flush with the latest coalesced positions - it renders one cadence later, never accumulating a backlog - and a stalled consumer's write queue can never exceed the cap plus one flush of cursor bytes. Independent of viewport culling (enable either alone). Both reducers switch the flush to a per-subscriber walk (`O(connections)`, wired into the coalesced and the `topicThrottle: 0` immediate path alike) and fall back to the shared frame on a host without `forEachSubscriber`. The `true` shorthand and the object form both work; setting a tuning key without `enabled` throws rather than silently doing nothing. `cursors.stats()` gains `perSubscriberFlushes` and `bpSkips`. Off by default; the zero-config path is unchanged.

### Changed

- Added a dependency-free `npm run check` (`scripts/check-types.js`, wired into `pretest`) that fails the build if any `exports` subpath stops resolving, a `types` condition is not a `.d.ts`, or a packaged file falls outside the `files` allowlist. No runtime or public API change.

## [0.6.0-next.6] - 2026-06-01

### Added

- **Presence field-level updates + transient fields (`presence.update()`, `transient` option).** `presence.update(ws, topic, fields, platform)` sets dynamic fields on the present user as a field-level delta: only fields whose value changed are merged into the user and broadcast in the next `diff` under `updates[key]` - a typing toggle sends `{ typing: true }`, not the whole user object. The update targets the user (per dedup key), so any of a multi-tab user's connections may call it. The new `transient: string[]` option marks fields (e.g. `['typing', 'selection']`) that are broadcast live but excluded from the `state` snapshot and the heartbeat roster, so a (re)joining or swept-then-readded client never inherits a possibly-stale transient value - a disconnected typer leaves no stuck indicator. Fully additive: a deployment that never calls `update()` sends the exact `{ joins, leaves }` diff as before (and the binary codec encodes it unchanged); the field-level `updates` map rides the JSON form and is ignored by an old client; the client `presence()` store merges `updates` into the existing user. No new capability token.

- **Cursor viewport reporting (`cursor-viewport` ingress).** A subscriber can now report which region of a board it is looking at, so the server can later cull cursors outside the visible region. New client primitive `reportViewport(topic, source)` (`svelte-adapter-uws/plugins/cursor/client`) sends a `requestAnimationFrame`-coalesced `cursor-viewport` frame, resolving the rect from a scroll-container element, an explicit `{ x, y, w, h, zoom? }` rect, or a getter. The cursor plugin's `hooks.message` handles the frame automatically (gated by the same `ws.isSubscribed` check as `cursor-snapshot`), recording the latest rect per `(subscriber, topic)`; `cursors.viewportFor(ws, topic)` reads it back (or `null` if the subscriber never reported one) and `tracker.stats().viewportsReported` counts reporting subscribers. Reporting is per-subscriber and opt-in - a non-reporting subscriber is treated as whole-board and is never culled - so it can never blank a board. Additive: a malformed rect is dropped silently, no frame is broadcast on a viewport message, and the recorded rect is torn down with the subscriber. The server-side viewport culling that consumes the rect is a separate change.

- **`platform.forEachSubscriber(topic, fn)`.** Invokes `fn(ws, userData)` once for every connection on this instance subscribed to `topic`. Where `platform.subscribers(topic)` returns a count, this yields the sockets themselves, so a plugin can make a per-subscriber decision the shared `publish` fan-out cannot: send a culled / per-viewport slice, skip a back-pressured consumer (`platform.bufferedAmount`), or vary the payload per recipient. The walk is O(connections), synchronous, and paid only by the caller - the zero-config `publish` path never calls it - and mirrors the subscriber walk `publishBatched` already performs. In clustered mode each instance walks its own local subscriber set. Additive; no existing method changes.

- **`sink: true` on the client `registerWireCodec` contract.** A binary wire codec can now declare itself a sink: its `decode` applies each `0x03` frame in place (e.g. into a local document replica that drives its own reactive surface) and returns nothing, instead of returning a `{ event, data }` store event. The inbound demux runs the decode (so the frame is applied) but dispatches no store update for a sink codec, so a frame that mutated local state never also fans out through the shared store ladder. The default codec (`sink` absent) is unchanged: it returns `{ event, data }` and a `null` return is a decode miss that drops the frame. The flag is optional and decode-side only - the server `publishWire` / `sendWire` encode path is untouched - so existing codecs (cursor, presence) keep working byte-for-byte.

## [0.6.0-next.5] - 2026-05-30

### Added

- **`createCursorWireCodec(options)` and `createPresenceWireCodec(options)`, exported from `svelte-adapter-uws/plugins/cursor` and `svelte-adapter-uws/plugins/presence`.** Each builds the plugin's binary wire codec - the `cursor.protocol:2` full-string / `cursor.protocol:3` short-id dictionary codec, and the stateless `presence.protocol:1` roster codec - without creating a tracker, returning `null` when `binary: false`. The bundled `createCursor` / `createPresence` now build their codec through these factories, so a single codec definition is the source of truth for the wire. A cluster-backed cursor or presence backend (the Redis extensions in `svelte-adapter-uws-extensions`) imports the same factory and hands the result straight to `platform.publishWire` / `platform.sendWire`, so the clustered backend speaks a byte-for-byte identical wire to the in-memory plugin instead of carrying a parallel copy that could drift. The per-connection short-id dictionary state lives in the framework (`publishWire` runs the per-subscriber encode against it), so a caller never manages it. Pure refactor for in-process apps: the in-memory wire is unchanged and the full suite stays green.

### Changed

- **`websocket.compression` now reaches the last three send paths that previously always bypassed it: `sendTo`, `publishBatched`, and the cross-worker relay hop.** `0.6.0-next.4` made `compression` a real per-frame option for `publish` / `send` / `publishWire` / `sendWire` but left these three hardwired to uncompressed (called out as a known limitation in that release). They now resolve a per-frame `compress` flag like the rest: `sendTo(filter, topic, event, data, { compress: true })` and `publishBatched(messages, { compress: true })` are opt-in (a `sendTo` frame targets a filtered subset and a batched frame mixes event types, so uncompressed stays the safe default), and a relayed `publish` / `publishBatched` now carries the originating worker's compress intent across the worker boundary, re-gated by the receiving worker's own compression setting so a worker with compression off never deflates a relayed frame. Default behavior is byte-identical to before: with `compression: false` (the default) every flag resolves to false and nothing is compressed. The `options` argument was added to `publishBatched` and `sendTo` in the platform types.

## [0.6.0-next.4] - 2026-05-29

### Fixed

- **`websocket.compression` now actually compresses outbound frames.** It was inert: every `publish` / `send` / `publishWire` / `sendWire` passed `compress: false` to uWS, so setting `compression` (e.g. `SHARED_COMPRESSOR`) compressed nothing the server sent - it only affected the handshake / inbound-decompression negotiation. The four platform methods now resolve a per-frame `compress` flag and pass it through. The default (`compression: false`) is unchanged and byte-identical to before; this only changes behavior for deployments that had explicitly enabled a compressor.

### Changed

- **Per-frame compression policy (only when a compressor is configured).** Compression is applied per frame, not blanket, because permessage-deflate CPU scales **per subscriber** - a live uWS bench (`bench/ws-compression-cpu.mjs`, real server + permessage-deflate client) shows uWS does not compress-once-and-fan-out even for `SHARED_COMPRESSOR`, so a coalesced cursor frame fanned to 1000 subscribers at 60 Hz costs more than a full CPU core per topic when compressed. Policy: text `publish` / `send` compress by default (opt out per call with `{ compress: false }` for a hot, high-fan-out text topic); binary `publishWire` / `sendWire` are opt-in (`{ compress: true }`); the **cursor** plugin stays uncompressed on both its binary and JSON paths (the 60 Hz hot path); the **presence** plugin opts in (low-frequency, a cheap bandwidth win). `publish` / `send` and `publishWire` / `sendWire` gained an optional `compress` field on their options. For a many-connection server prefer `SHARED_COMPRESSOR` over `DEDICATED_COMPRESSOR_*` (a `DEDICATED_*` window is per socket, so memory grows with connection count for a small extra compression gain). Known limitation: the cross-worker relay hop and `publishBatched` / `sendTo` always send uncompressed; the Redis-backed cursor extension does not yet opt its hot path out (a clustered deployment that enables compression should pass `{ compress: false }` there - tracked as an extensions follow-up).

## [0.6.0-next.3] - 2026-05-29

### Added

- **Binary presence frames (`presence.protocol:1`), on by default.** The presence plugin declares a binary wire codec, so `presence()` gets the binary path transparently - no API change, no flag. Presence `state` / `diff` / `heartbeat` frames ride a compact `0x03` codec (a `[key][JSON value]` roster, length-prefixed) instead of JSON envelopes: the server sends the binary frame to clients that advertised `presence.protocol:1` and the identical JSON envelope to everyone else, from one publish. The codec is **stateless** - a roster frame is encoded once and fanned out to every subscriber (encode-once-send-many), which fits presence's infrequent-but-full-roster broadcasts (the opposite trade from the per-connection cursor dictionary; a presence dictionary was measured and rejected because the roster value JSON, not the short keys, dominates the frame). A presence value is arbitrary user data, so it is carried as a length-prefixed JSON string (the only lossless form); the win over JSON is the `0x03` framing plus the per-connection topic id, not the value bytes. Measured against the **real** uWebSockets.js compressors (`bench/ws-compression-ab.mjs` - live server, permessage-deflate client, bytes counted off the socket): a modest but durable reduction that survives compression - roughly **4-13% smaller for a 50-user roster and ~2-3% for a 500-user roster** across `DISABLED` / `SHARED_COMPRESSOR` / `DEDICATED_COMPRESSOR_*` (the `DEDICATED_*` window sizes are byte-identical on the wire: permessage-deflate caps the negotiated window at 32 KB). Fully transparent: the `presence()` store decodes binary frames back to the same `{ event, data }` the JSON path produced, so the store and the wire shape are unchanged. `createPresence({ binary: false })` forces JSON for every client; a frame the codec cannot represent (a non-serializable value) falls back to JSON for that one frame. JSON-only deployments and the unit-test mock platform send the byte-identical JSON frames - the existing presence wire is unchanged. The same client bundle decodes both the in-process and the Redis-backed presence backends (the extensions backend's binary codec is a follow-up; until then a Redis-backed deployment sends JSON to all clients, which the binary-capable client decodes unchanged).

- **`presence.hooks.message`: reconnect / late-join snapshot for the in-memory presence plugin.** The presence client sends `{type:'presence-snapshot', topic}` on every `status === 'open'` (initial connect and every reconnect); the in-memory plugin now handles it and re-emits the current `state` to the requesting connection via `sync`. Previously the in-memory plugin had no `message` hook, so a reconnecting board-scoped client kept whatever roster it last knew until the next `diff` - the same self-healing-on-reconnect gap the Redis-backed variant already closed. The hook resolves the envelope whether it arrives pre-parsed (the adapter's `ctx.msg`, or a parsed object passed as `ctx.data` by an `onJsonMessage` / `onUnhandled` wiring) or as raw frame bytes, and returns `true` when it owns the frame so it chains with the cursor hook through one message handler. Wire it in alongside the others: `export const { subscribe, unsubscribe, message, close } = presence.hooks;`. Like `subscribe`, it does not gate topic access (the roster carries only `select`-stripped public fields); wrap it if a topic needs per-user authorization.

## [0.6.0-next.2] - 2026-05-29

### Added

- **Short-id cursor dictionary (`cursor.protocol:3`, schema 2), on by default.** Builds on the binary cursor wire: instead of carrying each cursor's full key string on every frame, a key is announced inline once per connection (a KEY-ASSIGN), then referenced by a 1-2 byte per-connection short id. The key bytes leave the wire after the first frame, and the client resolves the id from a cached `id -> key` map - so cursor decode no longer allocates a string per entry. For realistic clustered keys (`<instanceId>:<counter>`) a warm coalesced `bulk` measures **~88-89% smaller than JSON** (vs ~83% / ~67% for the full-string binary wire) and decodes **~16-18x faster than `JSON.parse` - about 4.4x faster than the full-string wire** (`bench/micro-wire-decode.mjs`). Fully transparent: `cursor()` / `move()` are unchanged and the store still yields `Map<key, { user, data }>`. The client advertises both `cursor.protocol:2` and `cursor.protocol:3`; the server sends the dictionary form to clients that advertised it and the full-string form to older binary clients, with the frame's 1-byte schema version selecting the decoder - so a client on the previous binary codec keeps working unchanged. Ids are a 16-bit space with least-recently-used eviction at the cap; a frame that exhausts the id space falls back to inline full-string keys; a frame the codec cannot represent still falls back to JSON without mutating the dictionary. The dictionary resets on reconnect.

- **`createCursor({ dictionary: false })`.** Keeps the binary wire but uses the full-string form (schema 1) for every client, encoded once and fanned out to all subscribers. The short-id dictionary is per-connection stateful, so each capable subscriber's frame is encoded independently - this is a net win (a warm dictionary encode is far cheaper than a full-string encode, and the frames are smaller) for typical per-process fan-out, with the crossover where per-subscriber encode overtakes the single shared encode at roughly ten capable subscribers on one worker (`bench/micro-wire-fanout.mjs`). Use `dictionary: false` on a single process serving very high per-topic subscriber counts (hundreds-plus on one worker), where the per-subscriber encode would cost more CPU than the bandwidth saving is worth.

- **`wire.state` on the plugin-author wire-codec contract: optional per-connection codec state.** `platform.publishWire` / `platform.sendWire` accept a `wire.state = { onAttach(ws), onDetach(ws, state) }` factory; the framework creates one state object per connection on the first binary frame and disposes it on close, passing it to `wire.encode(event, data, state)`. The per-connection state may carry a `schemaVersion` the framework stamps on the frame, so one codec can serve multiple schema revisions and negotiate per connection. Stateless codecs (no `wire.state`) keep the single encode-once-send-many fan-out unchanged. On the client, `registerWireCodec(prefix, codec)` gains an optional `capabilities` array (advertise more than one token) and an optional `state` factory whose object is passed to `decode(payload, state, schemaVersion)` and reset on every reconnect. The JSON fast path and the stateless binary path are byte-for-byte unchanged (`bench/micro-publish-codec-overhead.mjs`: the JSON-no-regression gate stays within noise).

## [0.6.0-next.1] - 2026-05-29

### Added

- **Binary wire mode: the `0x03` topic-frame multiplex + the plugin-author wire-codec contract.** A new optional binary transport for high-throughput topics, gated behind the existing capability handshake. JSON stays the default wire for everything; a plugin opts its own topic family in, and app code never changes. New platform methods `platform.publishWire(topic, event, data, wire, options)` and `platform.sendWire(ws, topic, event, data, wire)` send a compact binary frame to subscribers that advertised `wire.capability` in their `hello` frame and the identical JSON envelope to everyone else - from one call. The framework owns the `[0x03][schemaVersion][topicId][seq][payload]` envelope; the plugin's `wire.encode(event, data)` produces only the payload (and may return `null` to fall back to JSON for any single frame). A per-connection topic-id (`WS_TOPIC_IDS` slot) replaces the topic string on the wire and is announced to the client in a `{type:'wire-id'}` control frame. The client side adds `registerWireCodec(prefix, { capability, decode })` (exported from the client), sets `ws.binaryType='arraybuffer'`, and demuxes inbound `0x03` frames through the registered decoder into the same store dispatch the JSON path uses - so the reactive surface is byte-for-byte identical. The wire format is the server's decision (a plugin codec, or `binary: false`); the client never opts out via a URL parameter, and the library reads none. Zero-cost for JSON-only deployments: when no connected client advertises a codec's capability, `publishWire` takes the exact single `app.publish` fan-out `publish()` uses - `platform.publish` itself is unchanged. Old client <-> new server and new client <-> old server both keep working on JSON.

- **Binary cursor frames (`cursor.protocol:2`), on by default.** The cursor plugin declares its built-in binary codec, so `cursor()` / `move()` get the binary win transparently - no API change, no flag. Cursor positions and roster ride a compact codec (length-prefixed string key, big-endian float32 `x`/`y`, JSON `user` for join/catalog) instead of JSON envelopes: a 221-entry coalesced BULK measures **~83% smaller on the wire** and decodes ~4-5x faster than `JSON.parse` (no `JSON.parse` on the cursor receive path at all). Non-`{x, y}`-numeric cursor data (extra fields, non-numeric positions) transparently falls back to JSON per frame, so richer cursor payloads keep working. `createCursor({ binary: false })` forces JSON for every client. The same client bundle decodes correctly against both the in-process and the Redis-backed (extensions) cursor backends.

## [0.5.8] - 2026-05-23

### Fixed

- **`plugins/presence/server.js` mass-join fragmentation: `bufferDiff` deferred via `setTimeout(0)` instead of `queueMicrotask`.** Mirror surface to the same bug class the 0.5.6 cursor always-tick rewrite fixed for `broadcast` / `enqueueInbound`. The `queueMicrotask`-deferred flush assumed co-arriving `join` / `leave` ops share a JS task so they would all collapse into one diff per topic per iteration. They don't share a task: uWS dispatches each WS message as its own JS task and N-API drains microtasks at the C++/JS boundary between tasks, so the deferred flush ran BEFORE the next socket's handler and every per-message `bufferDiff` produced its own one-entry diff. Triangulated cross-repo via the extensions-side `redis/presence.js` cap probe; the in-memory presence plugin shares the wire shape and the structural bug, so the same fix applies. Post-fix, `bufferDiff` arms a tracker-wide `setTimeout(() => flushDiffs(platform), 0)` on the first dirty entry; subsequent entries in the same iteration accumulate into `pendingDiffs` until the timer fires. `setTimeout(0)` lands in libuv's timers phase, which fires only after the poll phase has dispatched every ready socket message in the current iteration. `diffFlushTimer` handle stored so `clear()` can cancel a pending flush. New cross-task-boundary regression test drives 50 unique joiners across `await Promise.resolve()` boundaries (the exact dispatch shape uWS produces) and asserts they all coalesce into one diff per topic. `flushDiffs()` accessor is unchanged in shape - tests still drain synchronously.

- **`files/handler.js batchRelay`: same `queueMicrotask` -> `setTimeout(0)` swap for the cross-worker postMessage batching.** Each WS-dispatched publish in a multi-process deployment relays through this batch into one structured-clone postMessage to the parent process. Under per-WS dispatch the microtask-deferred flush fired between handlers, so N publishes from N socket handlers became N structured-clones instead of one batched message. Same structural fix: timer handle in `relayTimer`, armed on first entry, drains at the next tick.

## [0.5.7] - 2026-05-23

### Changed

- **Presence wire events renamed: `presence_state` -> `state`, `presence_diff` -> `diff`.** Breaking for hand-rolled clients that decode the `__presence:{topic}` channel directly; the bundled `presence()` Svelte store is updated in lockstep and unaffected. Every other plugin already uses bare single-word event names scoped to their own `__plugin:` topic (cursor's `catalog`/`join`/`update`/`bulk`/`remove`, groups' `join`/`leave`/`close`, replay's `truncated`), so the rename brings presence in line. Topic prefix already namespaces the channel; event names don't need a second prefix. Tests, JSDoc, `.d.ts` types, README wire-format section, and 0.4-to-0.5 MIGRATION decoder snippet all updated. Cross-repo follow-up in `svelte-adapter-uws-extensions/redis/presence.js` applies the same rename so cluster and single-instance backends still speak one wire shape; Prometheus metric names (`presence_diff_frames_total`, `presence_diff_coalesced_total`) are unchanged - those are Prometheus-side identifiers, not wire events.

## [0.5.6] - 2026-05-23

### Fixed

- **`plugins/cursor/server.js`: leading-edge synchronous fire path removed; every broadcast now goes through the scheduler tick. Supersedes the 0.5.5 `queueMicrotask` defer, which didn't fix the production fragmentation.** The 0.5.5 fix assumed co-arriving cursors share a single JS task (so a microtask-deferred flush could batch them). In production they don't: uWS dispatches each WS message as its own JS task and N-API drains microtasks at the C++ <-> JS boundary between tasks. A `queueMicrotask`-deferred flush therefore runs BEFORE the next socket's message handler - cross-socket coalescing window is zero. Demo-side smoothness probe on 0.5.5 against the same 1000-cursor load profile still showed ~99% single-cursor UPDATE / ~1% BULK (essentially the pre-fix shape: 3356 UPDATEs vs 12 BULKs in 30 s). The bench shipped with 0.5.5 (`bench/micro-cursor-microtask-defer.mjs`) was misleading because its driver ran all broadcasts in one synchronous loop - the input shape that the microtask defer happens to handle correctly, not the input shape production has.

  **The real fix: always-tick.** Drop the leading-edge fire entirely. Every broadcast appends to `state.dirty`, adds the topic to `dirtyTopics`, and arms the tracker-wide tick timer at `delay = elapsed >= topicThrottleMs ? 0 : topicThrottleMs - elapsed`. `setTimeout(0)` is a libuv timers-phase callback that fires only after the poll phase processes every ready message on every socket - so all broadcasts dispatched in the same loop iteration end up in one flush, regardless of how many task boundaries separate them. The `pendingMicroflush` flag is gone; the `queueMicrotask` call is gone; the leading-edge branch in `broadcast()` is gone. One code path, one timing model.

  **Latency cost.** The first cursor on an idle topic now waits up to `topicThrottleMs` (default 16 ms / one frame budget) before its frame leaves. Below the perceptual floor for cursor at any reasonable cadence target. The cost buys cross-socket coalescing, which is what the demo's 1000-cursor stress profile actually needs.

  **Tests.** New regression test in `test/cursor.test.js` drives broadcasts across `await Promise.resolve()` boundaries (the cross-task shape that would have caught 0.5.5): 50 cursors each in their own microtask-separated task, fire the tick, expect 1 bulk of 50 entries / 0 single-cursor UPDATEs. Multi-cycle saturation regression test (10 cycles x 50 cursors, each cursor its own task) pins the same property across cadence boundaries. Five existing tests updated for the always-tick timing (sync assertions immediately after `c.update(...)` become `vi.advanceTimersByTime(topicThrottleMs); expect(...)` because the tick is now the only flush path).

  **Bench rewrite.** `bench/micro-cursor-microtask-defer.mjs` rewritten to drive cross-task. Now compares all three variants (sync leading-edge / `queueMicrotask` defer / always-tick) under `await Promise.resolve()` separation between every broadcast. Variants A and B leak single-cursor UPDATEs out; variant C does not, and produces bulks at the full per-cycle population.

  **Cross-repo follow-up.** Same correction applies to `svelte-adapter-uws-extensions/redis/cursor.js`: both `broadcast()` and `enqueueInbound()` carry the same shape. Same always-tick rewrite + same `pendingMicroflush` flag removal applies verbatim.

## [0.5.5] - 2026-05-22

### Fixed

- **`plugins/cursor/server.js`: leading-edge fire deferred by one microtask so co-arriving cursors batch into a single frame instead of fragmenting into per-cursor UPDATEs.** Pre-fix, `broadcast()` flushed synchronously when the cadence window was open. Under steady incoming load with event-loop pauses > `topicThrottleMs` (V8 GC, uWS internal work, outbound drain from prior flush) every post-pause first cursor leaked out alone as a single-cursor `update` while the rest of the burst queued for the trailing tick. Reported at 1000-cursor stress on Hetzner CCX13 (4 replicas, `WORKERS=8`, `topicThrottle: 8`): a 30s steady-state probe saw **1794 single-cursor UPDATEs vs 38 BULKs (86% fragmentation)**, and per-cursor effective update rate at the subscriber collapsed to 0.14 Hz vs the ~125 Hz cadence target. Root cause: `if (now - lastFlush >= topicThrottleMs) { lastFlush = now; flushDirty(...); state.dirty.clear(); }` fires before any subsequent broadcast in the same JS pass has a chance to add itself to `dirty`. Fix: claim the cadence slot synchronously (`lastFlush = now`) but defer the actual flush via `queueMicrotask` - microtasks run after the current sync code completes but before the next event-loop tick / I/O / setTimeout, so every broadcast in the same uWS message-handler batch lands in `dirty` before the flush fires. A new `pendingMicroflush` flag on each topic's state prevents double-scheduling when multiple cursors enter the same window. Expected effect at the demo's load profile: single-cursor UPDATE rate collapses toward zero, BULK rate rises to the cycle rate, and per-cursor effective update rate at the subscriber returns to the cadence target. New regression test in `test/cursor.test.js` pins the contract: 10 simulated bursts of 50 cursors each (pause > `topicThrottleMs` between bursts) produce 0 single-cursor UPDATEs and 10 BULKs of 50 entries each. Pre-fix this test failed with N UPDATEs + N BULKs. Three existing tests updated for the microtask-deferred timing (sync `expect(...).toHaveLength(1)` immediately after `c.update(...)` becomes `await Promise.resolve(); expect(...).toHaveLength(1)` to let the leading microtask drain). Microbench `bench/micro-cursor-microtask-defer.mjs` confirms the shape across 100 bursts x 250 cursors: pre-fix 1 UPDATE + 99 BULKs of mixed cursor count vs post-fix 0 UPDATEs + 100 BULKs of 250 cursors each. Same pattern lives in `svelte-adapter-uws-extensions@^0.5.5` (`redis/cursor.js` `broadcast()` and `enqueueInbound()`); cross-repo follow-up applies the same `queueMicrotask` defer there.

- **`platform.subscribe(ws, topic)` no longer crashes the worker when the WebSocket closes during the awaited subscribe-hook gate.** Pre-fix, server-side callers (RPC handlers, plugin attach paths, framework integration layers) routinely reached the post-`await` `ws.subscribe(topic)` call with a freed native handle - typical at mass-connect / backpressure churn where 10-15% of WS connections close mid-setup. uWS threw `Invalid access of closed uWS.WebSocket`, the exception bubbled out as an uncaught error, the worker process exited, and every other subscriber on that worker was dropped. Repro is reliable under "many WS opens, async setup, some close during setup" (e.g. a `joinBoard` RPC that runs `auth -> presence.join -> cursor.attach` at 1000+ concurrent cursors). With this change, every ws-targeted public platform method swallows uWS's closed-WS exception, returns a success-shaped no-op sentinel, and bumps a new counter (see below). Affected methods: `subscribe`, `unsubscribe`, `send`, `sendCoalesced`, `sendTo`, `request`. The wire-level `subscribe` / `subscribe-batch` message-handler paths and the internal `sendSubscribed` / `sendSubscribeDenied` / `bumpIn` / `bumpOut` helpers are hardened the same way - they sit behind every `await` in the message router. Plugin direct `ws.subscribe` sites (presence join + sync, groups join, cursor user-data read) gain local try/catch guards since they bypass the platform layer. Microbench (`bench/micro-subscribe-trycatch.mjs`, V8 turbofan, 50M iterations across 10 alternating rounds): the new `try/catch` wrappers are within noise floor (delta `-0.26%` to `+0.35%` vs. `+/-0.38%` baseline stddev). Six regression tests in `test/closed-ws-abort.test.js` cover the deterministic case (close, wait, call) and the production-shaped race case (subscribe-hook awaits, client closes during await, platform.subscribe returns null instead of throwing). Mirrored in `testing.js` so `createTestServer` exposes the same closed-WS-safe contract.

### Added

- **`platform.closedWsAborts`: read-only int counter of best-effort uWS operations that aborted because the WebSocket had already closed.** Monotonic, per-worker. Bumped by every closed-WS swallow described above. A non-zero value is normal under client churn; a rapidly-growing value under steady load indicates either pathological client behaviour or that the server's async setup path is too long for its connect rate. Sum across workers in clustered mode for cluster-total visibility. Type added to the `Platform` interface; mirrored on the vite (dev) platform as a constant `0` and on the `testing.js` platform as a live counter so test code can assert on the abort path.

## [0.5.4] - 2026-05-22

### Added

- **`plugins/cursor/server.js`: single-timer scheduler replaces per-topic setTimeout.** Pre-fix, every active topic with a pending coalesce window held its own `setTimeout` - N active topics = N pending timers in Node's timer queue, scheduling overhead scales with topic count. With this change, the entire tracker holds at most one `tickTimer` aimed at the next earliest topic deadline; on fire, the tick walks a bounded `dirtyTopics` Set (sized by mover count, not active-topic count) and re-arms for the next pending deadline. Drift is also fixed structurally: the previous code anchored `lastFlush = Date.now()` on the ACTUAL fire time, so a single late fire pushed every subsequent cycle's deadline (compounding under sustained event-loop saturation). New code anchors `lastFlush += topicThrottleMs` (target-relative), so a late fire affects exactly one cycle - the next deadline still aims for the original cadence edge. Multi-cycle backlog (event-loop saturation > `topicThrottleMs`) collapses to `now` to avoid queueing phantom catch-up fires.

  Visible to operators via the new `stats()` accessor (below). Existing per-topic timer cleanup paths in `clear()` and `clearTopicFlush()` updated to also clear the tracker-wide `tickTimer` and `dirtyTopics` Set. No public API change; same behavior contract (leading-edge synchronous flush + trailing-edge coalesce). Mirrors the matching change in `svelte-adapter-uws-extensions@^0.5.4` (`redis/cursor.js`).

- **`plugins/cursor/server.js`: `stats()` accessor on the tracker for scheduler health observability.** Returns `{ flushes, driftMeanMs, driftMaxMs, dirtyTopicsCurrent, activeTopicsTotal }`. Leading-edge synchronous flushes count in `flushes` but not in drift stats (they fire on the call thread, not via the scheduler; their drift is structurally zero). Always-on, near-zero cost. Operators can spot sustained event-loop saturation (`driftMeanMs > topicThrottle`) or one-off GC pauses (`driftMaxMs` spikes vs. mean) from the same accessor. Type added to the `CursorTracker` typedef. Five new tests in `test/cursor.test.js`.

## [0.5.3] - 2026-05-22

### Added

- **`plugins/presence/client.js` now sends a `{type:'presence-snapshot', topic}` text frame on every `status === 'open'` (initial connect + reconnect), symmetric to the existing cursor `cursor-snapshot` send.** Pre-fix, presence had no reconnect-snapshot path: a client whose connection dropped (deploy / network blip / tab resume) missed any `presence_diff` frames during the disconnect window and its in-memory map stayed at whatever it last knew. Global presence accidentally self-healed because most apps call `presence.join('global')` from the `open` hook (which fires on every reconnect); per-board presence did not have an equivalent auto-rejoin. The new frame routes to a server-side handler in `svelte-adapter-uws-extensions@^0.5.3` (`presence.hooks.message`) which re-emits a `presence_state` to the requesting ws via `tracker.sync()`. Without the extensions update the server ignores the frame (no-op), so the client send is safe to ship independently.

### Changed

- **`plugins/presence/client.js` heartbeat handler accepts both `{userKey: data}` map (new) and `[key, ...]` array (legacy) shapes.** Pre-fix, the handler only knew the array branch and could only refresh `existing` entries' timestamps; an entry the client had already swept could never be recovered from a heartbeat alone. The new branch refreshes existing AND re-adds missing entries from the per-user data carried in the map. Triggered by the matching server change in `svelte-adapter-uws-extensions@^0.5.3` (`redis/presence.js` heartbeat tick). Pairs with the new `presence-snapshot` send above so presence is fully self-healing across reconnects and missed heartbeats.

- **`MessageContext` (the second argument to the `message` hook in `hooks.ws.js`) gains an optional `msg` field carrying the JSON-parsed envelope when the adapter already parsed the frame for control-message routing (subscribe / unsubscribe / hello / resume / reply / subscribe-batch) but no control type matched.** Pre-change, the adapter did `TextDecoder + JSON.parse` on every text frame whose 4th byte was `y` (i.e. matching `{"ty`) to check for control envelopes, then threw the parsed value away when none of the known types matched, forwarding only the raw `ArrayBuffer` to the user handler. Plugin-layer dispatchers (`svelte-realtime`'s `onJsonMessage` callback, `cursor.hooks.message` wired through `createMessage({ onUnhandled })`) then re-ran the same parse a second time on the raw bytes. With this change, the parsed value is kept in scope and forwarded as `ctx.msg` on the fall-through delegation, halving the parse cost on the dispatch path. The field is also set to `undefined` (not absent) when the frame is binary, prefix-miss, parse-failure, or parses to a non-object (null / primitive / array), so the context object has a stable hidden-class shape across all message paths. Existing handlers that destructure `{ data, isBinary, platform }` are unaffected (the new field is ignored by destructuring). Same change applied to both production (`files/handler.js`) and dev (`vite.js`) entry points so behaviour matches across modes. Type added to `MessageContext` in `index.d.ts`.

- **In-memory presence server (`plugins/presence/server.js`) heartbeat wire shape changed from a keys-only array to a `{userKey: data}` map.** Pre-change, the in-memory server emitted `[key1, key2, ...]`; the client's new heartbeat handler (above) could only refresh entries already in the local map from that shape, so an entry the client had already swept could not be re-added until the next `presence_diff` / `presence_state` arrived. The new shape carries each active user's current data, so heartbeats both refresh existing entries AND re-add any entry the local sweep had removed - matching the Redis-backed variant in `svelte-adapter-uws-extensions/redis/presence`. With this change, a single browser bundle now sees the same wire from both backends without per-protocol branches. Existing array-shape back-compat is kept on the client side for older servers; this repo's server now emits only the new map shape. Two tests in `test/presence.test.js` adjusted assertions on the heartbeat payload; one new test pins the `{userKey: data}` shape with two users.

- **In-memory presence server `heartbeat` option default changed from `0` (disabled) to `30000` ms.** Pre-change, the in-memory server emitted no heartbeats out of the box, so any client passing `maxAge` would have entries permanently sweep out (no refresh path other than `presence_diff`). With heartbeats default-on, the `maxAge` self-healing path actually works without per-app configuration: a still-present user is refreshed (or re-added) every 30 s, and ghost entries left over by silent server-side cleanup (cluster mass-disconnect, ungraceful client close, transient JS-thread saturation that drops a `presence_diff`) clear within one sweep window. Apps that prefer zero wire traffic between events (no `maxAge` consumers, out-of-band liveness) opt out with `heartbeat: 0` explicitly. `heartbeat` is now validated as a non-negative finite number at construction (`NaN` / `Infinity` / negative throw). Two new tests in `test/presence.test.js`: one pins the 30 s default firing, one pins the validation; the existing "does not publish when heartbeat is 0 or omitted" tightened to require `heartbeat: 0` explicit (omitted now defaults to on).

- **Presence client `maxAge` default changed from `0` (disabled) to `90000` ms.** Pre-change, `presence(topic)` with no options never expired entries client-side, so a silent server-side TTL expiry left a ghost user in the UI until a full page reload. Made safe by the heartbeat changes above: still-present users refresh on every 30 s heartbeat (3x safety margin against the 90 s sweep window), and genuinely-gone users clear within 90 s of disconnect. Admin / audit views that want unbounded retention ("show every user who ever touched this topic") opt out with `maxAge: 0`. The default matches the cluster-aware Redis variant's `ttl: 90` server-side TTL default, so a user customizing one side has a natural pairing for the other. The client-side `cacheKey` is now uniform (`topic + '\0' + maxAge`) since there is no longer a "no-sweep" default branch.

### Fixed

- **Default `presence(topic)` usage stops leaving stale "X here" badges after ungraceful disconnects.** Pre-fix, callers like `BoardCard` that called `presence(topic)` with no options defaulted to `maxAge: 0`, so when a user disconnected ungracefully their `presence_diff` leave never fired and the badge stuck at 1 until full page reload. The combination of the three presence changes above (heartbeat map shape, server heartbeat default on, client maxAge default on) means every default-`presence(topic)` call now self-heals within 90 s of an ungraceful disconnect, without per-call configuration. Apps that explicitly relied on entries-never-expire (admin / audit views) opt out with `maxAge: 0`.

## [0.5.2] - 2026-05-22

### Changed

- **Cursor plugin: wire format split into a roster channel (`catalog` / `join`) and a positions channel (`update` / `bulk` / `remove`), so user metadata flows once per (ws, topic) instead of on every position frame.** Pre-change, the in-memory plugin emitted `update {key, user, data}` on every move and `snapshot [{key, user, data}]` on attach; user metadata (avatar, name, color, etc.) rode on every frame. The Redis-backed cursor in the extensions package had already moved to the split-channel format (catalog separate from positions) for bandwidth reasons, leaving the shared client (`plugins/cursor/client.js`) speaking two protocols. The in-memory variant now matches: `join {key, user}` fires once per (ws, topic) the first time that ws moves on the topic, `update {key, data}` and `bulk [{key, data}]` carry positions only, `snapshot()` sends `catalog [{key, user}]` followed by `bulk [{key, data}]` (two `platform.send` calls instead of one). The client merges the two streams locally and yields the same public shape (`Readable<Map<string, {user, data}>>`). Positions whose user is not yet known are withheld until the matching join arrives - they appear on the next render once the catalog catches up. With this change the single browser bundle now works against either backend without per-protocol branches, and per-frame wire bytes drop from ~100 bytes per cursor to ~16 bytes per cursor at peak. Tests in `test/cursor.test.js` and `test/client-real.test.js` rewritten for the split shape; new tests cover the join-before-update ordering and the catalog roster-replacement semantics.

- **Cursor plugin: new `topicThrottle` option (default 16 ms = 60 Hz) coalesces all dirty movers on a topic into a single frame per window.** Pre-change, every accepted `update()` produced one `platform.publish`, so an N-mover topic broadcasting at 60 Hz issued N publishes per tick to every subscriber. With `topicThrottle` enabled, the per-cursor throttle still bounds each user's send rate, but a per-topic leading + trailing edge timer collects every dirty mover that lands in a single window and flushes them as a single `update` (one mover) or `bulk` array (multiple movers). At N=1 the leading edge fires immediately so latency is unchanged; at N=many the wire-byte and subscriber-callback count drop by roughly the mover count. Default 16 ms matches the per-cursor `throttle` (also defaulted to 16 ms now) for symmetry; raise to 33 (~30 Hz) for high-density rooms, lower to 8 (~120 Hz) for high-refresh demos, set to 0 to disable coalescing. The per-cursor `throttle` default also moves from 50 ms to 16 ms so out-of-the-box cursor feel matches a typical 60 Hz display; apps that explicitly set `throttle` are unaffected. Three new test groups in `test/cursor.test.js` cover single-mover leading-edge (no-bulk), two-mover trailing flush, multi-mover bulk shape, and the `topicThrottle: 0` disable path. Bench `bench/29-cursor-coalesce-ab.mjs` pins both halves of the contract: at N=1 with `topicThrottle: 0` (the old code path) there is no regression; at N=100 movers/60 Hz the coalesced variant reduces `platform.publish` ops by 37x (6000 -> 162) and wire bytes by 2.34x (523 KB -> 224 KB).

- **Cursor plugin client: new `move(topic, data)` helper coalesces sends via `requestAnimationFrame`, capping cursor wire traffic at the display refresh rate without user code.** Pre-change, the documented client-side pattern was for callers to send their own `{type: 'cursor', topic, data}` frame via `connect().send(...)` on every `mousemove` event. A high-DPI mouse fires `mousemove` at up to 1000 Hz; without manual throttling, callers paid the wire cost of 1000 sends per second per active topic - the server-side `throttle` would discard most of them, but only after each one crossed the wire. `move()` keeps a per-topic latest-wins map in module state and flushes it on the next animation frame, so on a 60 Hz display the rate naturally caps at 60 Hz and on a 120 Hz display at 120 Hz. Multi-topic callers do not clobber each other (the pending map keyed by topic). Resolves `requestAnimationFrame` at call time so a polyfill installed after import (or a test substitution) is honored; falls back to `setTimeout(_, 16)` when rAF is unavailable; no-op outside a browser (SSR-safe). README example switches to the recommended `move()` path; raw `connect().send(...)` still works for power users. Three new test cases in `test/client-real.test.js` cover within-frame coalescing, cross-topic isolation, and cross-frame scheduling.

### Fixed

- **`test/vite.test.js`: tests realigned with the Vite 7 environment-API plugin shape.** Pre-fix, eight tests under `vite plugin > plugin shape` / `configureServer` / `config hook (SSR build)` failed because they exercised the removed `plugin.config()` hook (now `configResolved` + `buildStart`) and passed `httpServer` mocks without `.once()` (the dev plugin registers a `close` listener via `server.httpServer?.once('close', ...)` to fire the user's `shutdown` hook on dev-server restart). Plugin behavior is unchanged; this is a test-only fix. The new SSR-build tests drive the `configResolved` -> `buildStart` flow with a mocked `emitFile` and assert the `ws-handler.js` chunk is emitted exactly when the build resolves as SSR; the new client-environment test pins the "do not emit on the client environment of a multi-env SSR build" branch added in 0.5.0-next.24. `configureServer` mocks now carry `once: vi.fn()` alongside the existing `on:` mock so the close-listener registration does not throw.

- **README, MIGRATION, JSDoc, and inline source comments around `websocket.maxPayloadLength` corrected: uWS's own default is 16 KB, not 16 MB.** Four places stated the false "uWS itself defaults to 16 MB" framing (`README.md` "Backpressure and connection limits" section, `MIGRATION.md` "Default `maxPayloadLength` raised from 16 KB to 1 MB" section, `index.d.ts` JSDoc on the `maxPayloadLength` config option, and the inline comment in `index.js` above the `wsOpts.maxPayloadLength` default). The actual uWS default per `node_modules/uWebSockets.js/index.d.ts` is `16 * 1024`. The adapter previously matched uWS's 16 KB default and raised to 1 MB in 0.5 because 16 KB was excessively conservative for typical app payloads (forced chunked-upload frameworks to use ~12 KB chunks). The corrected framing preserves the 0.5 change narrative without the false uWS-baseline claim. Docs-only change; no runtime behaviour change.

## [0.5.1] - 2026-05-17

### Fixed

- **`WS_*` userData slot symbols in `files/utils.js` switched from `Symbol(...)` to `Symbol.for(...)` so handler.js, vite.js, testing.js, and downstream extensions (e.g. `svelte-adapter-uws-extensions/redis/registry`) resolve to the same global symbol regardless of how `utils.js` was loaded.** Pre-fix, each `Symbol('adapter-uws.ws.subscriptions')` call returned a fresh unique value. In a single-module-instance setup (everything imports the same `files/utils.js`) this was fine. But the adapter's build step bundles `handler.js` + `utils.js` into the SvelteKit build artifact (`build/handler.js`), so the bundled `utils.js` is a _different module instance_ from the one a runtime extension loads via `node_modules/svelte-adapter-uws/files/utils.js`. Two instances meant two distinct symbols for each slot - the handler stamped subscriptions / session-id / stats under one symbol and a runtime-loaded extension (the cluster registry walks every `ws.getUserData()[WS_SUBSCRIPTIONS]` to rebuild routing tables) read under the other, silently dropping every cross-module lookup. The failure was invisible in single-process dev (only one instance ever loaded) and surfaced only in clustered + extension production where subscription rebuilds returned empty sets. Fix is one-character per export (`Symbol(x)` -> `Symbol.for(x)`) which routes via the V8 global symbol registry and gives identity-by-key across every module instance in the process. Trade-off: user code that calls `Symbol.for('adapter-uws.ws.subscriptions')` can now reach these slots; documented at the top of the symbol block as a deliberate accept since the alternative was a silent cluster-routing break.

## [0.5.0-next.24] - 2026-05-16

### Security

- **README: new `### Authorization model` subsection in `## Plugins` + per-plugin callouts on every in-memory primitive.** Pre-fix, the README described each plugin's mechanics but never said in one place that the plugins are authorization-free primitives - identity-blind helpers whose only auth contract is "the caller has already decided". The plugin sections individually used phrasing that could mislead a casual reader (`Broadcast groups: "Like topics but with access control"` reads like the plugin itself authorizes; `Presence: select(userData)` reads like an identity check). The fix adds a single canonical `### Authorization model` section at the top of `## Plugins` that names the contract (handler is the gate, `upgrade()` provides identity, derive plugin keys from trusted identity prefixes) with a concrete `withLock` + `ws.getUserData()` example, then adds a 1-3 line `> **Authorization:** ...` callout to each of the 11 named plugin sections (Replay, Dedup, Presence, Typed channels, Throttle/debounce, Rate limiting, Cursor, Queue, Lock, Session, Broadcast groups). Each callout explains the specific failure mode (e.g. dedup key collision across users, lock key DoS via wire-supplied key, presence subscribe gate, rate-limit-vs-auth distinction) and links back to the canonical section. Middleware is intentionally excluded - it is the gate, not a primitive. No code change; docs only.

- **Cursor plugin: `update()` caps topic length at 256 chars and JSON-encoded data at 8 KB by default.** Pre-fix, `cursor.update(ws, topic, data)` accepted any topic / data shape from the message hook. A misbehaving (or hostile) client could send a multi-MB cursor frame and the plugin would broadcast it via `platform.publish` to every subscriber - amplifying the abuse. Cursor positions are by definition small (~30 bytes for `{x, y}`); legitimate use never hits the new caps. Updates whose topic or payload exceeds the cap are silently dropped (cursor is best-effort fire-and-forget; throwing into the message hook would be the wrong shape). The 8 KB data check also rejects unserializable payloads (BigInt, circular references) early instead of letting them throw later in `platform.publish`. Empty / non-string topic is also rejected (was silently a no-op via the `topic !== ''` check; now explicit at the top of `update()`). Configurable via `maxTopicLength` and `maxDataBytes` options. 9 new regression tests in `test/cursor.test.js`.

- **Middleware plugin: `ctx.locals` is now `Object.create(null)` (prototype-less).** Pre-fix, `ctx.locals = {}` had `Object.prototype` in its chain. A middleware that copied in attacker-influenced data (`ctx.locals[msg.field] = value`) could mutate `Object.prototype` when `msg.field === '__proto__'` (or `'constructor'` / `'prototype'`), polluting every plain object in the realm. With `Object.create(null)`, the same assignment writes a normal own property and the prototype chain stays clean. One-character change in default; removes one foot-shooting class. 1 new regression test in `test/middleware.test.js` writes `ctx.locals['__proto__'] = { polluted: true }` and asserts `({}).polluted` is undefined.

- **`createLock()` gains `maxWaitersPerKey` option (default 1000) capping the per-key waiter queue.** Pre-fix, `createLock()` had `maxKeys` (cap on total tracked keys) but no cap on the queue length per single key. A hot key (e.g. every authenticated client racing for `lock-${roomId}` at once) could grow the waiter queue without bound, anchoring memory per pending caller until the contention chain drained. The new cap turns this failure mode from "OOM" into a typed synchronous rejection: when `state.queue.length >= maxWaitersPerKey`, the new arrival is rejected with `LockQueueFullError` (`code: 'LOCK_QUEUE_FULL'`, `.key`, `.maxWaitersPerKey`) and the caller can shed the request (503, retry-later) without blocking the chain further. The currently-holding caller and any waiters already queued continue normally; only new arrivals are shed. Default 1000 fits the operational shape of every realistic app (1000 simultaneous waiters on one key is already a sign of misbehavior); apps with legitimate fan-in can opt up. 5 new regression tests in `test/lock.test.js` cover the cap at 3, default 1000, per-key independence, and the initial-acquirer path (which doesn't create a waiter).

- **SSR responses default-fill `x-content-type-options: nosniff` when the response did not already set one.** Pre-fix, the adapter only injected `nosniff` for static-asset responses ([runtime handler](./src/runtime/handler.js#L207)); SSR responses produced by SvelteKit's response handler did not get the default. An SSR endpoint that returned an unexpected content-type (a JSON endpoint returning text, an image endpoint with a non-image mimetype, etc.) was vulnerable to MIME-sniffing by older browsers and a small class of polyglot file attacks. Fix: the SSR `writeHeaders` path now checks every response's headers for an existing `x-content-type-options` entry and adds `nosniff` only when one is absent. Apps that set their own value (via `+server.js` / `+page.server.js` headers, hooks, or middleware) see no change. Defense-in-depth - no live exploit on the demo or docs since both serve correct content-types - but closes the gap so a future SSR handler that forgets the header still gets MIME-sniffing protection. Other security-header defaults (CSP, X-Frame-Options, Referrer-Policy) intentionally NOT defaulted here because CSP needs app-specific care for inline-hydration / iframe shapes, X-Frame-Options breaks legitimate embeds, and Referrer-Policy choices vary by app. Those belong in `hooks.server.js`.

- **`dedup`, `lock`, `throttle`/`debounce`, and `queue` plugins cap user-supplied keys at 256 characters by default.** Pre-fix, all four plugins accepted arbitrarily long string keys at their main entry points (`dedup.claim/has/delete(id)`, `lock.withLock(key, ...)`, `throttle.publish(_, topic, ...)`, `queue.push(key, ...)`). With each plugin's default `maxEntries`/`maxKeys`/`maxTopics`/`maxSize` = 10k-1M, an attacker (or a buggy upstream that took client-controlled input straight into a plugin call) could anchor a 1 MB key per slot, pinning gigabytes of heap until the entry expired. The plugins are documented as in-process primitives, but their primary use sits one async layer above an authenticated WebSocket - that is exactly the trust boundary where a bounded cap belongs.

  Fix: each plugin now exposes a `maxIdLength` / `maxKeyLength` / `maxTopicLength` option (defaulting to 256 characters) and validates user-supplied identifiers at the entry boundary. Overflow throws synchronously for `dedup` / `throttle` / `debounce` and rejects the returned promise for `lock` / `queue`. The error names the actual key length so callers can log the offender. Validation is a single `.length` comparison per call (negligible on hot paths). 256 is generous for typical id shapes (UUIDs 36, ulids 26, base64 nonces under 64); apps with legitimately longer composite keys can opt up via the new option.

  Apps that already used short identifiers (effectively all production usage) see no behavior change. Apps that route client-controlled strings directly into one of these primitives without sanitization now fail loudly at the boundary instead of silently anchoring memory. JSDoc + `.d.ts` updated for all four plugins.

- **`createPresence()` default `select` now strips sensitive-looking userData keys before broadcast (was `(ud) => ud`, pass-through).** The in-memory presence plugin's pre-this-change default broadcast the entire userData object to every presence subscriber of a topic, including any fields the host app stashed there for server-side use (session token, IP, server-only flags). The documented warning said "use the select option to strip private fields" but the default itself did the opposite of strip - it passed everything through. A zero-config `createPresence()` call that the developer expected to be safe was the most likely failure mode: the dev returns an object from `upgrade()` for server-side authorization, never thinks about presence, and the same shape lands in every connected client's `presence_state` snapshot.

  Fix: the default extractor is now a recursive denylist mirroring the cluster-aware Redis presence plugin (`svelte-adapter-uws-extensions/redis/presence`). It drops `__`-prefixed, `constructor`, `prototype`, and any key matching `/token|secret|password|auth|session|cookie|jwt|credential/i`. Binary views (Buffer / TypedArray / DataView / ArrayBuffer) become the placeholder string `'[bytes: <len>]'` so raw bytes do not land in presence frames. Every other field passes through unchanged, so the default keeps working with arbitrary application field names (avatar, color, role, org, etc.) and apps that did not configure `select` see most of their userData broadcast unchanged - only the known-credential shapes are dropped. The cycle-safe walk uses a per-call WeakSet so a userData object that holds a back-reference to itself does not blow the stack.

  Apps that need tighter control can pass an explicit allowlist: `createPresence({ select: (ud) => ({ id: ud.id, name: ud.name }) })`. Apps that relied on full passthrough (and have audited their userData) can restate it explicitly: `createPresence({ select: (ud) => ud })`. The demo (`select: (u) => ({ id: u.id, name: u.name, color: u.color })`) and docs (`select: (userData) => ({ id: userData.id })`) both supply explicit select functions, so neither is affected.

  Operator action: none for apps that supply `select`. Apps without `select` that stash credentials directly in userData (the previously-leaky pattern) silently stop broadcasting those fields - this is the intended fix, not a regression. Performance: O(N) deep walk per `presence.join` instead of O(1) reference pass; the join call site fires once per topic-per-connection, not per message, so the cost is amortized across the connection lifetime and unmeasurable on the data plane.

### Changed

- **`nextReconnectDelay()` JSDoc clarifies that the default `Math.random()` randFactor is reconnect-backoff jitter and not security-relevant.** The helper accepts an optional `randFactor` parameter so tests can pin it; the default `Math.random()` is the correct primitive for thundering-herd avoidance. A future contributor reading the code should not mistake the random factor for a value that crosses a trust boundary and "fix" it by swapping in `crypto.randomBytes` (which would be wasted entropy plus a different API shape). Comments-only change.

### Fixed

- **HTTP request body pre-allocation uses `Buffer.alloc` (zero-fill) instead of `Buffer.allocUnsafe`.** The pre-allocated body buffer (used when `Content-Length` is present and the body is at most 64 KB) is sized by the declared `Content-Length` but only filled up to the actual bytes received. The consumer of the buffer today reads only `subarray(0, offset)`, so any uninitialized tail bytes from prior heap allocations were not directly reachable through normal handler paths - the previous code was not actively leaking. The change is defense-in-depth: zero-fill closes the pattern so a future refactor that widens what gets enqueued (or any downstream read that reaches past the consumer-visible length into `buf.buffer`) cannot expose heap residue from prior requests. Cost: one memset of up to 64 KB per pre-allocated body, negligible against the network I/O the same request already absorbs.

- **Replay plugin `since(topic, since)` and `replay(ws, topic, sinceSeq, ...)` now reject malformed `sinceSeq` values.** Pre-fix, a negative `sinceSeq` (e.g. `-1`) satisfied `entry.seq > -1` for every buffered entry, so the in-memory `readSince` returned the entire ring buffer instead of "messages strictly after seq N". The plugin is documented as a building block (host app authorizes the caller before invoking it), but a buggy host that forwards client input unchecked would degrade an authorized "resume from N" into "dump everything." Same risk shape for NaN, Infinity, fractional, and non-number inputs. Fix: gate both entry points with `Number.isInteger(value) && value >= 0` and treat invalid as "no data" (`since()` returns `[]`; `replay()` emits the `end` marker only, preserving the wire protocol shape). `+8 new test cases` in `test/replay.test.js` covering negative / NaN / Infinity / fractional / non-number sinceSeq for both `since()` and `replay()`, plus regression coverage for the still-accepted `0` (resume-from-start).

### Removed

- **`websocket.workerRelayHmacSecret` option removed.** The cross-worker relay HMAC defense (added in next.20) was functionally broken: the sender attached `mac` to batched relay entries, but the primary's `publish-batch -> publish` rewrite at `index.js` destructured only `{ topic, envelope }` and dropped the mac before forwarding to receiver workers. Receivers expected the mac when the secret was set, so enabling the option caused every legitimate batched relay to fail with `relay.mac-fail` rather than only forged ones - the defense rejected all traffic instead of just attackers. No reports surfaced this in production, suggesting no live consumers. Beyond the bug, the underlying threat model does not justify the feature: worker threads share heap with the primary, so a worker capable of forging `parentPort.postMessage` envelopes is already running attacker code in the same memory space as the verifier - HMAC adds no real defense in that scenario. Cross-process scaling (multi-replica deployments) does not use this path at all; its integrity story lives in the bus/Redis layer. Removed the option, the `RELAY_HMAC_SECRET` / `computeRelayMac` / `verifyRelayMac` helpers in `files/handler.js`, the `createHmac` / `timingSafeEqual` imports they were the sole consumers of, and the `mac` parameter on `relayPublish`. Apps that never set the option see no behavior change. Apps that set it were already broken and need to drop the option.

## [0.5.0-next.23] - 2026-05-14

### Fixed

- **Client `on()` no longer sends a wire `subscribe` for `__`-prefixed topics.** Next.21's wire-block landed correctly on the server but the bundled plugin clients (`plugins/presence/client.js`, `plugins/replay/client.js`, `plugins/cursor/client.js`, `plugins/groups/client.js`) plus any caller of `on('__realtime')` / `on('__rpc')` were still emitting the wire frame the server now rejects. Every page mount logged one `[ws] subscribe denied topic=__presence:<room> reason=INVALID_TOPIC` per active plugin topic, plus another batch on every reconnect. The denials also landed in the `denials` Readable, polluting any banner UI wired off it.

  Root cause was a conceptual mismatch, not a missed callsite. `__`-prefixed topics are broadcast taps owned by the framework or the plugin that publishes on them: the server-side trust path (`ws.subscribe` direct, or `platform.subscribe`) manages subscriber-set membership, and the client only needs the local `topicStores` entry for inbound dispatch. The wire subscribe was always redundant - pre-next.21 it was a no-op round-trip; post-next.21 it was a guaranteed denial.

  Fix: `subscribe(topic)` and `doUnsubscribe(topic)` in `client.js` skip the wire frame when the topic's first 2 bytes are `__`. The topic is also excluded from `subscribedTopics`, so the reconnect resubscribe-batch path does not re-emit it. Local `topicStores` / `topicRefCounts` / ref-counted cleanup are unchanged - inbound dispatch via `dispatchEvent` continues to route by `topicStores.get(msg.topic)` exactly as before. Server-side wire denial of `__` topics is kept as defense in depth; a hostile or modified client that still tries to send the frame is still rejected. All four bundled plugin clients, the realtime health subscription, and any user code calling `on('__realtime').subscribe(...)` per the documented escape hatch now work without warnings or denial spam.

  Two new tests in `test/client-real.test.js` pin the contract: (a) `on('__presence:room')` followed by `subscribe()` sends zero `subscribe` / `subscribe-batch` frames yet still receives inbound presence frames via dispatch, and (b) a disconnect-reconnect cycle resubscribes user topics in the resubscribe-batch frame but excludes `__realtime`. Apps using only user-space topics see no behavior change.

  **Not fixed by this change**: the `__realtime` health channel published by `svelte-adapter-uws-extensions`'s `redis/pubsub.js` reaches zero clients on releases next.21 / next.22 because nothing server-side ever called `ws.subscribe('__realtime')`. The client-side fix above silences the warning and registers the local store entry, but the publisher-side per-connection subscribe must land in the extensions package for `$health === 'degraded'` to actually flip. Tracked separately.

## [0.5.0-next.22] - 2026-05-13

### Fixed

- **Adapter `index.js` parses cleanly on Node ESM (CRITICAL).** Pre-fix, the `wsOpts` object literal was missing a trailing comma after `workerRelayHmacSecret` (added in next.20). Node's parser walked through the intervening JSDoc comment block and threw `SyntaxError: Unexpected identifier 'authPathRequireOrigin'` at module load time, making `import adapter from 'svelte-adapter-uws'` fail to resolve in any production consumer. The adapter's own test suite did not surface this because tests import `testing.js` (a parallel options-merging path that builds the object differently); `index.js` only runs at `vite build` time in a consuming app. Apps stuck on next.21 hit this on first `npm run build` after install. Fix: one-character comma. Apps that did not bump past next.19 are unaffected.

## [0.5.0-next.21] - 2026-05-10

### Fixed

- **`platform.subscribe` and `platform.checkSubscribe` typed correctly as `Promise<string | null>` (was `string | null`).** Runtime has been `async` since the subscribe-hook async-safety fix; the type declaration drifted. TypeScript users who didn't `await` the call were getting back a `Promise` typed as a denial-reason string, leading to silent misbehavior (every truthy Promise read as a denial). The JSDoc text claiming "Synchronous and fail-closed" was also stale; updated to reflect that the framework awaits the hook before inspecting its return.

## [0.5.0-next.20] - 2026-05-10

### Changed

- **Bumped `engines.node` to `>=22.0.0` (was `>=20.0.0`); pinned `uWebSockets.js` to v20.67.0 (was v20.60.0).** uWS v20.67.0 dropped Node 20 support upstream; the adapter follows. Node 22 LTS, Node 24 current, and Node 26 are supported. Picks up real upstream wins from v20.60 to v20.67: backpressure fix (v20.64), Latin-1 string handling (v20.65), faster String args via V8 ValueView (v20.63), zero-cost `getRemoteAddress` / `getRemoteAddressAsText` (v20.66), `getRemotePort` / `getProxiedRemotePort` (v20.61), DeclarativeResponse improvements, and symbol-keyed userData support. See `MIGRATION.md` for the runtime-bump checklist.

### Security

- **`subscribe` / `subscribeBatch` hooks no longer fail open when async (CRITICAL).** Pre-fix, a hook written as `async (ws, topic) => false` returned a `Promise<false>` from the handler runtime; `result === false` is false (a Promise is not strictly equal to `false`), `typeof result === 'string'` is false, so the framework treated the return as ALLOWED. Every app using async subscribe hooks (the idiomatic style for hooks that touch a session store or DB) silently let every subscribe through, bypassing the developer's intended access control. Fix: the wire-level message handler is `async`; `runSubscribeHook` and `runSubscribeBatchHook` await the user's hook before inspecting the return value. `platform.subscribe` and `platform.checkSubscribe` are also `async` (breaking: callers must `await`); the JSdoc and example block show the new shape. Belt-and-suspenders re-checks after the await catch concurrent-subscribe races so `totalSubscriptions` cannot double-count and the cap cannot be raced past. Mirrored in the dev plugin (`vite.js`) and the test harness (`testing.js`) so a regression test against `createTestServer` exercises the same code path. The `platform.sendTo(filter, ...)` filter sees a different fix shape: an async filter cannot be awaited per-connection without changing the broadcast API, so a Promise return is detected, the connection is treated as not-matching (fail-closed), and a one-time `console.error` directs the developer to resolve filter inputs into userData from the upgrade hook.
- **Wire subscribes to `__`-prefixed system topics blocked by default (HIGH).** Pre-fix, `isValidWireTopic` accepted any topic with a `__` prefix; a normal authenticated client could send `{"type":"subscribe","topic":"__signal:victim-userId"}` and intercept every `live.signal()` to that user, plus plugin presence / group / replay broadcasts on `__presence:*`, `__group:*`, `__replay:*`. Fix: the wire single-subscribe and subscribe-batch branches now reject topics whose first 2 bytes are `__` with `INVALID_TOPIC` UNLESS the new `websocket.allowSystemTopicSubscribe: true` opt-in is set. The block is at the wire layer only; server-side `platform.subscribe(ws, '__signal:userId')` (the legitimate pattern that `enableSignals` uses) still works.
- **Wire `resume` hook is awaited before the `resumed` ack frame (HIGH).** Pre-fix, the user's resume hook fired fire-and-forget and `{type:'resumed'}` went out immediately; the client switched to live mode while replay frames were still in flight, producing out-of-order events. Fix: `await wsModule.resume(ws, ctx)` before the ack. The matching extensions-side fix (replay backends now consult `platform.checkSubscribe(ws, topic)` before reading any topic's buffer) emits a `denied` event on `__replay:{topic}` for topics the wire-subscribe gate would deny; the client treats this similarly to `truncated` (gap-fill stops for that topic, the rest of the resume completes).

### Added

- **`websocket.allowSystemTopicSubscribe: boolean` opt-in flag (default `false`).** When `true`, wire-level subscribes to `__`-prefixed topics are allowed. Use only for advanced apps that intentionally route public topics through the `__` prefix.

### Security

- **`isValidWireTopic` defaults to printable-ASCII-only (LOW).** The wire-topic accept set is tightened from "anything except control bytes / quote / backslash" to "printable ASCII (0x20-0x7E) except quote / backslash". Pre-fix, a hostile client could subscribe to a topic containing U+2028 / U+2029 line separators, U+202E right-to-left override (BiDi spoofing), U+FEFF byte-order mark, or arbitrary non-ASCII characters. These survive the wire and surprise log dashboards, admin UIs, and grep-based incident-response tools that render topic names back to a human. The check is applied at the wire-subscribe and subscribe-batch boundary; server-side `platform.subscribe(ws, topic)` and `platform.checkSubscribe(ws, topic)` keep their previous (looser) accept set so apps using non-ASCII topic names from server code (e.g. `__signal:Jose`, presence rooms with localized labels) are unaffected. Apps that legitimately accept non-ASCII topics from clients can opt in via `websocket.allowNonAsciiTopics: true`. Mirrored in the dev plugin and test harness via `allowNonAsciiTopics` on each respective options surface.
- **`parse_as_bytes` rejects negative and non-finite values (LOW).** Pre-fix, `BODY_SIZE_LIMIT=-100K` resolved to a negative number that read like "no limit" downstream; `BODY_SIZE_LIMIT=Infinity` similarly bypassed every byte-budget check. Both now resolve to NaN, which the existing `if (isNaN(body_size_limit)) throw` guard already routes to a clean startup error. Strict positive-finite numbers (`512K`, `2M`, `0`) keep working unchanged.
- **`parseCookies` returns a null-prototype object (LOW).** Pre-fix, the returned bag had `Object.prototype` as its prototype chain; a request with a `__proto__=evil` Cookie could leak attacker-controlled values through downstream `cookies.toString` / `cookies.constructor` lookups. Fix: `Object.create(null)` removes the prototype chain entirely while preserving every documented `cookies[name]` access pattern. The same null-proto guarantee holds on empty input and on `parseCookies(undefined)`.
- **Expanded `SENSITIVE_KEY_PATTERNS` warning list (LOW).** The userData warning fires when an `upgrade()` hook stores fields whose names suggest sensitive data (`token`, `secret`, `password`, etc.). Added `email`, `phone`, `ssn`, `dob`, `iban`, `creditcard`, `cc`, `pin` so a user upgrade hook that stuffs PII into `userData` (then ships it via `platform.publish` fanout) is flagged once at first connect. The userData object is accessible to every server-side handler and ships out with publishes that include it - catching the antipattern at first connect tells the developer at the call site rather than relying on a code review they may never get.
- **`x-no-dedup` header is no longer consulted (LOW).** Pre-fix, any anonymous client could stamp `x-no-dedup: 1` on every request to defeat the SSR shared-leader fan-in and amplify server-side render cost. Since legitimate debug callers can always send a `Cookie` or `Authorization` header to skip dedup naturally, the bypass header serves no purpose and is now ignored.
- **Dev plugin enforces `allowedOrigins` on the WSS upgrade (LOW).** Pre-fix, the dev plugin printed a warning that "Dev mode does not enforce allowedOrigins" and accepted every WS upgrade. The dev port is reachable from any other process on the dev machine; a hostile page in another browser tab can connect just like it can to the production endpoint. Fix: the dev upgrade handler now runs the same `isOriginAllowed` check the production handler runs, with the same `allowedOrigins` resolution. Apps that need to accept dev connections from arbitrary origins can pass `devSkipOriginCheck: true` to the plugin.
- **Cross-worker relay HMAC defense (opt-in) (LOW).** New `websocket.workerRelayHmacSecret: string` option. When set (must be at least 16 characters), every relay envelope leaving the worker carries an HMAC-SHA256 tag computed over the (topic, envelope) pair; the receiving worker re-computes the tag and refuses the envelope on mismatch. Defends against an adjacent process injecting forged messages into the worker_threads relay (typically reachable only post-compromise). The shared secret must reach every worker via env var or `workerData` - the framework cannot auto-generate a value that is shared across workers. Without the option, behavior is unchanged.

### Added

- **`websocket.allowNonAsciiTopics: boolean` (default `false`).** Relaxes the wire-topic accept set to allow non-ASCII characters. Always-illegal control bytes / quote / backslash remain rejected.
- **`websocket.workerRelayHmacSecret: string`.** Opt-in HMAC over the cross-worker relay envelope. Must be at least 16 characters and must be the same value across every worker that relays to / from this one.
- **`devSkipOriginCheck: boolean` plugin option.** Disables the dev plugin's `allowedOrigins` enforcement on WSS upgrades. Use only for local dev scenarios where the WSS must accept arbitrary origins.

### Security

- **Dev plugin (`vite.js`) and test harness (`testing.js`) hard-assert `WS_SUBSCRIPTIONS` shape on subscribe (MED).** Pre-fix, both surfaces used optional chaining (`subs?.[WS_SUBSCRIPTIONS]`) when reading the per-connection subscription Set out of `ws.getUserData()`. If the Set was missing or wrong-shaped (a framework regression in userData initialization, or a hostile harness manipulation in tests), every subscribe silently bypassed the per-connection cap (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) and registered without ever incrementing accounting. Fix: both surfaces now run the same `assert(subs instanceof Set, 'subs.shape', null)` the production handler runs at the equivalent site. In test mode the assert throws so vitest surfaces the regression; in dev it logs a structured `console.error`. Brings dev / test / prod to parity on the cap-presence invariant so a regression that breaks userData initialization fails the CI lane that always runs first.

### Security

- **`/__ws/auth` POST now requires Origin / `x-requested-with` / `Sec-Fetch-Site` (MED, CSRF).** Pre-fix, the authenticate POST endpoint accepted any credentialed cross-origin POST: an attacker page from a third-party origin could fire `fetch(..., { credentials: 'include' })` and the victim's cookie rode along, executing the user's `authenticate()` hook on the victim's behalf (cookie refresh, audit-log write, per-user counter bump). Fix: a request must now satisfy at least one of `x-requested-with: XMLHttpRequest` (the adapter client always stamps this on its preflight POST), `Sec-Fetch-Site: same-origin` (modern browsers stamp this automatically; cannot be forged from script), or an `Origin` header matching the configured `allowedOrigins` policy. Apps that need to accept this endpoint from native (non-browser) clients without those headers can opt out via `websocket.authPathRequireOrigin: false` in `svelte.config.js`. The check is mirrored in the dev plugin (`vite.js`) so dev and production share one defense. Implementation lives in a new exported helper `isAuthOriginAccepted(headers, originCtx)` in `files/utils.js`; the helper forces `hasUpgradeHook: false` on the underlying `isOriginAllowed` check so the upgrade hook (which authenticates the WS connection) cannot accidentally relax the auth-endpoint defense.
- **Dynamic compression skipped for credentialed responses (MED, BREACH).** Pre-fix, the dynamic brotli/gzip branch fired on every response above 1 KB regardless of credentials; combined with attacker-influenced reflected input alongside a secret in the page body (CSRF token, session ID, API key), the compressed length leaked the secret one byte at a time via the [BREACH attack](https://en.wikipedia.org/wiki/BREACH). Fix: requests carrying `Cookie` or `Authorization` now skip dynamic compression; the SSR body is sent uncompressed. Apps that have audited their pages for BREACH defenses (random per-response masking, prefix randomization, no secrets reflected with attacker input) can opt back in via `websocket.compressCredentialedResponses: true`. Anonymous responses continue to compress as before. Build-time precompressed static files are unaffected - they ship at their original compressed size regardless of the request's credential state, which is safe because their content does not depend on attacker input.
- **Refuse to start on `same-origin` policy without host pin (MED).** Pre-fix, the bare default `allowedOrigins: 'same-origin'` running without ORIGIN env, HOST_HEADER env, native TLS (SSL_CERT/SSL_KEY), or an `upgrade()` hook silently accepted any non-browser scripted client because the same-origin check compares two attacker-controlled headers (Origin vs Host). Fix: the runtime now throws at startup with a human-readable resolution list (set ORIGIN env / set HOST_HEADER env / use native TLS / export an upgrade hook / use an allowlist). Apps that have audited the deployment and want the previous warn-only behavior can opt out via `websocket.unsafeSameOriginWithoutHostPin: true`. Detection lives in a new exported helper `describeUnsafeSameOriginConfig(input)` in `files/utils.js` that returns `null` when safe and the error string when the misconfig is present.

### Added

- **`websocket.authPathRequireOrigin: boolean` (default `true`).** Toggles the CSRF defense for the `/__ws/auth` POST endpoint. Set to `false` to accept native (non-browser) clients without `x-requested-with`, `Sec-Fetch-Site`, or matching `Origin` headers.
- **`websocket.compressCredentialedResponses: boolean` (default `false`).** Toggles dynamic compression of responses to credentialed requests. Set to `true` only after auditing the page surface for BREACH defenses.
- **`websocket.unsafeSameOriginWithoutHostPin: boolean` (default `false`).** Restores the previous warn-only behavior when `allowedOrigins: 'same-origin'` is paired with no fronting trust. Set only when the deployment context has been independently audited.

### Security

- **`isValidWireTopic` rejects `"` (charCode 34) and `\\` (charCode 92) (HIGH).** The wire-accept set now matches `esc()`'s rejection set. Pre-fix, a client could subscribe to topic `"` (passes wire), and any later `platform.publish('"', ...)` crashed because `envelopePrefix` calls `esc(topic)` which throws on those characters. Worse, the `envelopePrefix` LRU cache could be partially populated with hostile keys. Aligning the two rejection sets keeps wire-accept and envelope-build invariants in lockstep.
- **Cookie `path` / `domain` attribute injection blocked in `serializeCookie` (HIGH).** Pre-fix, attacker-influenced strings flowed into `Path=` / `Domain=` concatenations verbatim, allowing CRLF response-splitting (`/foo\r\nX-Evil:`), attribute smuggling (`/a; HttpOnly; Domain=victim.com`), and `Set-Cookie` line-splitting via `,`. Both attributes are now validated against the same CHAR class as cookie values (no CTLs, no `;`, no `,`, no whitespace, no DEL) before concatenation; non-strings throw the same way as malformed names/values.
- **SSR dedup cache key includes `base_origin` (HIGH).** Pre-fix, the dedup key was `method + '\0' + url`. In virtual-hosting deployments (one uWS instance behind multiple Host aliases, common in SaaS), two concurrent anonymous GETs to `/` from `tenantA.example` and `tenantB.example` shared one SSR call - the second waiter received the leader's host-rendered response. SvelteKit's `request.url.host` flows into rendered HTML, so the bug was a real cross-tenant leak. Key is now `method + '\0' + base_origin + '\0' + url`.

### Documentation

- **Multi-tenant guidance added to plugin module headers (`plugins/presence`, `plugins/groups`, `plugins/replay`, `plugins/cursor`).** Plugin in-memory state is keyed by topic name verbatim; in single-process multi-tenant deployments, two tenants sharing a room name collide on the same map entry. The fix is at the call site - prefix room/topic names with a tenant scope (`'org-' + ctx.user.tenantId + ':lobby'`). The plugin internals are correct under that pattern; a full plugin-level scope API is deferred (would require breaking changes to `list` / `count` signatures across all four plugins).

## [0.5.0-next.19] - 2026-05-08

### Changed

- **Default `maxPayloadLength` raised from 16 KB to 1 MB.** The previous default matched the underlying uWebSockets.js cap, which is sized for high-density infrastructure deployments where a tight per-connection cap is load bearing. This adapter targets SvelteKit app developers whose realistic inbound payloads include CRDT sync updates, WebRTC signaling exchanges, large JSON RPC requests, batched state submissions, and occasional binary transfers, all of which routinely sit in the 10 to 200 KB range with outliers higher. The 16 KB cap kills the connection with `ERR_TOO_BIG_MESSAGE` (close code 1009) the moment any of these legitimately exceeds it, surfacing as a closed socket with no application-level error event for the developer to catch. 1 MB clears the realistic inbound traffic profile with comfortable headroom at negligible cost: idle per-connection allocation is zero (the fragment buffer grows to the actual incoming message size, not to the cap), and the per-worker zlib inflation buffer (only when compression is enabled) adds roughly 1 MB after the first compressed inbound frame on each worker. DoS exposure at the new cap is still bounded: `upgradeAdmission.maxConcurrent` controls concurrent connection count, `maxBackpressure` (also 1 MB) controls per-connection outbound queue size, and uWS handles inbound frames synchronously so per-frame buffer cost is freed quickly. Apps that want a stricter cap can pin via `websocket.maxPayloadLength: 16 * 1024` (or any other value) in `svelte.config.js`. Behavior change in the `next.*` prerelease line; users on the `latest` dist-tag (0.4.x) are unaffected.

  **Other related caps unchanged.** The 8192-byte control-message JSON.parse ceiling (`files/handler.js`), the 256-topic `subscribe-batch` cap, and the matching client-side `SUBSCRIBE_BATCH_MAX_BYTES` (8000) / `SUBSCRIBE_BATCH_MAX_TOPICS` (200) are all about control-message framing, not payload size - subscribe / unsubscribe / hello frames are inherently small JSON. Raising them would just make the JSON.parse-on-every-message scan more expensive without benefit. The `BATCH_FRAME_WARN_BYTES` (256 KB) outbound `publishBatched` warning threshold is about uWS's permessage-deflate compression cost, also independent of inbound frame size. The 1 MB raise is isolated to one axis (incoming frame size); the other caps protect against different things.

### Added

- **`platform.maxPayloadLength: number` and `platform.bufferedAmount(ws): number` for backpressure-aware framework code.** Two new platform members designed for downstream RPC / upload / streaming primitives that need to reason about frame sizing and per-connection send-queue depth without piggybacking the values on the wire or wrapping `ws.getBufferedAmount()` defensively. `maxPayloadLength` is a numeric snapshot of the configured cap (1 MB by default after the raise above) - read once at framework init, no per-message cost. `bufferedAmount(ws)` is a constant-time pass-through to `ws.getBufferedAmount()` wrapped in a `try/catch` that returns 0 for closed connections, so callers can use it on every send without defending against teardown races. Mirrored on the dev plugin (`vite.js`) and the `createTestServer` test platform (`testing.js`); the parity test enforces drift-free triple-mirror going forward. Five new tests in `test/platform-payload-bufferedamount.test.js` pin the contracts: `maxPayloadLength` is a number and snapshot-stable, `bufferedAmount` returns 0 for fresh connections, returns a finite non-negative number under load, and never throws on closed connections.

- **`conn.bufferedAmount` getter on the client `WSConnection` returned by `connect()`.** Mirrors the native browser `WebSocket.bufferedAmount` property, returning 0 when the underlying socket does not exist (pre-connect or post-close). Use for client-side paced sending: chunked-upload pumps that previously called `sendQueued()` blindly can now check `conn.bufferedAmount` against high-water / low-water marks and back off until the queue drains, keeping the browser send queue bounded regardless of payload size. Pairs with the next.16 fix that made `sendQueued` actually preserve binary frames - together they turn the client-side primitive into a backpressure-aware paced sender. Three-line passthrough on the connection object; zero overhead.

  Use case context: `svelte-realtime`'s `live.upload` server primitive (just shipped) builds chunked upload streams. With the four members above in place, the client pump can size chunks against `platform.maxPayloadLength`, pace sends against `conn.bufferedAmount`, and the server can monitor per-recipient pressure via `platform.bufferedAmount(ws)` - all without piggybacking metadata on the wire or implementing per-framework workarounds. Three of the four asks are pure additions (no behavior change for current callers); the `maxPayloadLength` raise is the one behavior change in this batch and is opt-out via the existing config knob.

  **Not addressed:** uWS does not expose a per-connection receive-side pause/resume primitive at the JS layer (uWS's design philosophy is "TCP backpressure handles it" - they rely on the kernel socket buffer slowing the sender when reads are not consumed). Frameworks that need true server-side receive flow control (e.g. when a slow disk write blocks the consumer of an async-iterable upload stream) should keep the existing pattern of capping the buffered-chunk queue and aborting with a typed error if the consumer cannot keep up. If uWS adds the primitive in a future release, we can expose it via `platform.pauseReceive(ws)` / `platform.resumeReceive(ws)` then.

## [0.5.0-next.18] - 2026-05-08

### Fixed

- **`$env/dynamic/private` (and `$env/dynamic/public`) returned empty values in modules reached via the ws-handler import graph after next.17.** Concrete pain point: `import { env } from '$env/dynamic/private'` followed by a top-level `env.DATABASE_URL` read in `src/lib/server/db.js` / `src/lib/server/redis.js` / `src/lib/server/tasks.js` / `src/hooks.ws.js` saw an empty proxy. The same variables were correctly visible via `process.env` at the same call site, which is the workaround users discovered (and which the demo's source comments cite). Failure mode was invisible: `createPgClient({ connectionString: env.DATABASE_URL })` silently became `createPgClient({ connectionString: undefined })` and `createRedisClient({ url: env.REDIS_URL })` silently fell through to the library default `redis://localhost:6379` - if a different Redis happened to be running on that port, the app silently wrote presence keys / cluster registry to a foreign database.

  Root cause: SvelteKit's Vite plugin resolves `$env/dynamic/private` to `export { private_env as env } from '<runtime>/shared-server.js'` - a module-level mutable `private_env = {}` populated lazily by `Server.init({ env })` (`@sveltejs/kit/src/runtime/shared-server.js`). The pre-next.17 esbuild fallback path used a custom virtual-module resolver that substituted `export const env = process.env;` directly, sidestepping the runtime indirection entirely. Once next.17 made the Vite-plugin path actually work (modules now flow through SvelteKit's normal resolution), the runtime indirection became load-bearing: until `Server.init` runs, `private_env` is empty. handler.js's `await server.init({ env: process.env })` was at module-body level, AFTER the `import * as wsModule from 'WS_HANDLER'` had already evaluated - so the user's `src/lib/server/*` modules read env at module-load time, before init populated the proxy. ESM evaluates imported modules' bodies fully (including TLA) before the importer's body runs, which means _the server.init call literally cannot run before the user's env reads_ if init is in handler.js's body.

  Fix moves Server instantiation + `await server.init({ env: process.env })` into a new `files/_init.js` module imported in `files/handler.js` IMMEDIATELY BEFORE the `WS_HANDLER` import. ESM evaluates imports in source order, depth-first; each imported module's body fully completes (including TLA) before the next import is processed. So `_init.js`'s top-level `await server.init(...)` blocks until SvelteKit's `private_env` and `public_env` are populated, and only then does the next import (`WS_HANDLER`) start evaluating. The user's `src/lib/server/*` modules now see populated env at module load. handler.js's body still uses `server.respond(...)` for SSR rendering - the only thing that moved is the construction + init. A multi-line comment in `handler.js` above the two imports spells out the load-order rationale and explicitly forbids reordering them; a similarly long block at the top of `_init.js` documents why this module exists at all so a future refactor doesn't accidentally inline it back. Behavior change in `handler.js`'s body is null: `server` is the same instance the previous code constructed, just imported from `_init.js` instead of declared inline.

  Build pipeline: `_init.js` is one of the runtime template files copied via `builder.copy(files, out, ...)` in `index.js`, so it inherits the same SHIMS / SERVER / MANIFEST placeholder substitution as `handler.js`. No changes to the second-pass Rollup bundling at `index.js:239` (the template files are not bundled, they reference the bundled `./server/index.js` and `./server/manifest.js` chunks at runtime). Verified end-to-end against `svelte-realtime-demo`'s production build: `build/_init.js` correctly holds `await server.init({ env: process.env })`; `build/handler.js`'s import block has `import { server } from './_init.js'` on line 22 directly above `import * as wsModule from './server/ws-handler.js'` on line 23, in that exact order.

  No runtime behavior change for users without the Vite plugin (esbuild fallback path's custom `$env/dynamic/private` substitution is unchanged). No hot-path impact (one-time module evaluation cost; identical work to before, just moved earlier in the import chain). The reporter's process.env workaround still works as a belt-and-suspenders fallback but is no longer required after this fix lands - callers can return to the canonical `import { env } from '$env/dynamic/private'` pattern in `src/lib/server/*` modules.

## [0.5.0-next.17] - 2026-05-08

### Fixed

- **Vite plugin's `ws-handler` entry was silently dropped under SvelteKit + Vite 7's environment API, causing every shared module imported by both `hooks.ws` and SvelteKit routes to be DUPLICATED in the build output (each with its own singleton state).** The plugin's `config()` hook returned `{ build: { rollupOptions: { input: { 'ws-handler': handlerPath } } } }`. SvelteKit's own Vite plugin sets the SSR build input wholesale during a later phase via the Vite 7 environment API (`client` and `ssr` environments), which silently wiped our entry from the merged config. The adapter then found no `tmp/ws-handler.js` after `writeServer(tmp)` and silently fell through to the `esbuild` fallback path - which bundles `ws-handler.js` as a fully standalone module with `packages: 'external'`, inlining ALL local code (everything from `src/lib/server/`) into the ws-handler bundle. SvelteKit's parallel build pass inlined or chunked the same modules into its own routes. Result: two physical copies of every shared module. Concrete user impact: a Prometheus metrics registry exported from `src/lib/server/metrics.js` and imported by both `hooks.ws` (writes counters from `wirePublishRateMetrics`, `connectionMetricsHook`, `createLeader`) and the `/metrics` route (serializes via `metrics.export()`) became two disjoint registries - the `/metrics` scrape returned `# HELP`/`# TYPE` headers but no labelled counter values, because the registry it serialized had been DEFINED but never INCREMENTED. Same shape for any in-memory cache, leader-election state, custom rate limiter, or other singleton shared between hooks.ws and routes. The user sees correct runtime behavior with mysteriously empty observability.

  Fix replaces the `config()`-hook input merge with `configResolved()` + `buildStart()` + `this.emitFile`. The new flow: `configResolved()` detects the SSR build via `resolved.build.ssr` (`env.isSsrBuild` in `config()` is `false` even during SSR builds under the Vite 7 environment API, so the old detection was wrong on a second axis) and captures the `hooks.ws` handler path; `buildStart()` runs late enough that SvelteKit's input has been finalized, gates on `this.environment.name === 'ssr'` so the client build does not also emit the entry, and calls `this.emitFile({ type: 'chunk', id: handlerPath, fileName: 'ws-handler.js' })` to inject the entry directly into the active Rollup pipeline. `fileName: 'ws-handler.js'` (instead of `name: 'ws-handler'`) forces the output to the top level of the SSR output dir, matching the location the adapter's second-pass Rollup checks at `${tmp}/ws-handler.js`. The emitted entry now participates in Vite's chunking strategy: shared modules between hooks.ws and SvelteKit routes land in `chunks/<name>-<hash>.js` and both sides import the SAME chunk file - one physical module, one singleton.

  Verified end-to-end against `svelte-realtime-demo`: pre-fix, `build/server/ws-handler.js` had the metrics module's source inlined and `build/server/chunks/metrics-Di2jejzk.js` had a separate copy (two `class MetricsRegistry` definitions across the build). Post-fix, `build/server/ws-handler.js` and `build/server/index.js` both contain ZERO copies of the source; `build/server/chunks/metrics-Di2jejzk.js` is the singular copy; `ws-handler.js`, the `/metrics` route's `_server-*.js`, the `cluster-cron` page chunk, and every other importer all reference the same chunk path. Counters incremented from the WS handler now reach the `/metrics` scrape correctly. The previously-loosened test in `svelte-realtime-demo`'s `cluster-cron` test #4 (relaxed from `expect(body).toContain('leader_acquired_total{key_class=')` to the looser `expect(body).toContain('leader_acquired_total')`) can be restored to the strict form.

  No new runtime dependencies, zero hot-path impact (build-time only), no behavior change for users without the Vite plugin (esbuild fallback path is unchanged and still warns appropriately). The `config()` hook is removed entirely from the plugin since `configResolved` now owns all SSR-detection logic.

## [0.5.0-next.16] - 2026-05-08

### Fixed

- **`client.send` and `client.sendQueued` mangled `ArrayBuffer` and typed-array payloads into the literal text `'{}'`, blocking binary RPCs end-to-end.** Both methods (and the queue-flush path on reconnect) called `JSON.stringify(data)` unconditionally before handing the payload to `ws.send`. `JSON.stringify(new ArrayBuffer(N))` returns the 2-byte text `'{}'` because `ArrayBuffer` has no own enumerable properties, regardless of `N`. Every binary frame from a `live.binary` RPC (svelte-realtime: `0x00` marker + uint16 BE header length + JSON header + raw payload bytes) reached the wire as the literal text `'{}'`; the server's `handleRpc` failed its `data instanceof ArrayBuffer && bytes[0] === 0x00` check and silently dropped the frame as a malformed RPC envelope; the client-side promise hung to its 30-second timeout. Visible end-to-end as `[ws->] string len=2 {}` in Playwright `framesent` traces and as "0/N chunks" stalls on file-upload demos. The pre-binary handshake (hello, subscribe-batch, the JSON RPC envelope) all worked because they ARE plain JSON; only `ArrayBuffer` / `ArrayBufferView` payloads got mangled.

  Both `send` and `sendQueued` now route through a shared `serializeForSend(data)` helper that branches on `data instanceof ArrayBuffer || ArrayBuffer.isView(data)` and passes binary inputs through to `ws.send` unchanged. JSON-serializable inputs continue to pass through `JSON.stringify` exactly as before - this is a pure unblock for the binary path with zero behavior change for current text callers. The internal `sendQueue` now stores already-decided values (`string | ArrayBuffer | ArrayBufferView`) so the reconnect-flush path is trivially correct: each entry was serialized at enqueue time and reaches the wire verbatim, no per-flush type branching needed. Covers `Uint8Array`, `DataView`, and every other `ArrayBufferView`; deliberately does not introduce a `Blob` branch (YAGNI - `live.binary` builds an `ArrayBuffer` directly, no current consumer asks for `Blob`).

  JSDoc on `send` and `sendQueued` (in both `client.js` and `client.d.ts`) now spells out the contract: _"Strings and JSON-serializable objects are sent as text frames after `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array, DataView, etc) are sent as binary frames unchanged."_ The same wording on `sendQueued` adds: _"Queued binary payloads are kept as-is in the in-memory queue and flushed verbatim on reconnect."_ Closes the same class of "I called this with X and got mystery behavior" bug for whatever the next binary use case is.

  No wire-format change for receivers - server-side `handleRpc` already accepted both binary and text frames; uWS hands binary frames as `ArrayBuffer` to the user's `message` hook with `isBinary: true`. Test coverage in new `test/client-binary.test.js` (7 tests): `send` + `ArrayBuffer` reaches the wire by reference (no `JSON.stringify`), `send` + `Uint8Array` and `DataView` likewise (covers all `ArrayBufferView` shapes), `send` still `JSON.stringify`s plain objects, `sendQueued` mirrors `send` for both shapes, and the load-bearing regression test that explicitly asserts a 200 KB `ArrayBuffer` no longer reaches the wire as the literal text `'{}'` (with the right `byteLength` preserved). The full 146-test client-real suite continues to pass under the refactor, confirming no behavior change for the JSON path.

## [0.5.0-next.15] - 2026-05-06

### Added

- **`hooks.ws.init({ platform })` and `hooks.ws.shutdown({ platform })` lifecycle hooks for boot-time and teardown-time app code.** Two new optional exports alongside `upgrade` / `open` / `close`. `init` fires once per worker process after the listen socket is bound and before the first `upgrade` / `open` / `message` hook can run; `shutdown` fires once per worker before the listen socket closes and before existing connections are kicked. Both hooks receive `{ platform }` as a single context argument (extensible later without a breaking change), are async-allowed (the adapter awaits the returned promise), and target the recurring "I need `platform` at boot, not on first connect" pattern that previously forced library code to capture `platform` lazily inside an `open` hook - which meant per-second cron warnings and brittle wakeup races during the boot-to-first-connect window. Concrete pain point: `svelte-realtime`'s `live.cron(...)` registers at module load, but its tick cannot call `platform.publish` until something triggers `setCronPlatform(platform)` from inside an `open` hook; with `init` exported, the realtime layer captures `platform` at the deterministic moment the server is ready. Same shape works for warmup tasks, scheduled metrics dumps, external pubsub bridge setup, and any other "needs platform on boot" flow. Whitelist (`knownWsExports` in `files/handler.js`) updated to include both names, mirrored on dev (`vite.js`) and the test harness (`testing.js`); `init` runs to completion before `createTestServer()` resolves so test setup is fully ready when callers `await` it.

  **Async semantics.** `start()` (production) and `createTestServer()` (test harness) return promises that resolve only after `init` completes. A throwing `init` rejects the promise - boot failure should be loud, the index.js entrypoint surfaces it as an unhandled rejection, the process crashes. `shutdown` is best-effort: throws are logged with `console.error('[ws] shutdown hook threw:', err)` and ignored, since the adapter cannot refuse to stop. The dev plugin (`vite.js`) wires `init` into the existing `handlerReady` chain so a slow async init does not race with the `/__ws/auth` middleware setup, and `shutdown` into `server.httpServer` 'close' so it fires on Ctrl-C / programmatic close. The production handler's `start(host, port)` is now `async` and awaitable; `files/index.js` now `await`s both `start()` and `shutdown()` so per-worker init failures crash the worker and per-worker shutdown teardown completes before drain.

  **Per-worker firing in clustered mode is documented LOUDLY.** Each worker process calls `start()` and fires `init` independently. An app running with N workers will see N `init` calls, one per worker. JSDoc on the `init` hook in `index.d.ts` explicitly notes this: "Do not assume singleton semantics; if you need a singleton (e.g. a single cron publisher across the cluster), layer leader election on top." The `shutdown` hook fires per-worker for the same reason. svelte-realtime's `live.cron` will need its own leader election for "1 Hz cron" semantics in clustered mode, but that is downstream concern; the adapter's job is the deterministic boot/teardown signal.

  **Open-race caveat documented.** If `init` is slow async, kernel-queued WebSocket connections may fire `open` hooks concurrently with the tail of init's execution. The hard guarantee "init fires before any open" only holds for synchronous init OR if the user installs an app-level ready-gate that 503s upgrades during init. For most "capture platform" cases (the canonical use), the race is harmless because writes are idempotent. JSDoc spells this out so apps that need strict ordering know to keep init synchronous or layer their own gate.

  Test coverage in new `test/init-shutdown-hooks.test.js` (11 tests): fire-once with `{ platform }` context, no-op when not exported, async awaiting, throwing-init rejection, init can call `platform.publish` (platform fully wired before init runs), init fires before open for kernel-queued connections, shutdown fire-once with platform context, async shutdown awaiting, throwing shutdown logged-and-ignored (server still closes), shutdown sees connections still registered before they are kicked, init-then-shutdown ordering. All 355 existing tests across `utils`, `platform-parity`, `platform-subscribe`, `upgrade-admission-wiring`, `connection-stats`, and `testing` continue to pass under the async lifecycle refactor.

## [0.5.0-next.14] - 2026-05-05

### Added

- **`platform.subscribe(ws, topic)` and `platform.unsubscribe(ws, topic)` for server-side subscribe-with-authorization.** New first-class platform methods that route a server-initiated subscribe through the user's `hooks.ws.subscribe` authorization hook before the actual `ws.subscribe` runs. Returns `null` on success or a denial reason string on failure (`'INVALID_TOPIC'`, `'RATE_LIMITED'`, `'FORBIDDEN'`, or any custom string returned from the hook). Idempotent on repeat subscribe of the same `(ws, topic)`: hook does not re-fire, `totalSubscriptions` is not double-charged. Updates `WS_SUBSCRIPTIONS` and the per-worker counter so observability (`platform.subscribers(topic)`, `platform.pressure`, the close-hook `subscriptions` set) matches client-initiated subscribe frames. Does not emit a `{type:'subscribed', topic, ref}` ack frame - there is no client `ref` for a server-initiated subscribe; that is an application-level concern handled by the caller's RPC response.

  Closes a real authorization-bypass class of bug for downstream frameworks that subscribe a connection on the user's behalf inside an RPC handler (e.g. svelte-realtime's stream-RPC `_executeStreamRpc` calling `ws.subscribe(topic)` directly). Direct `ws.subscribe()` calls go to uWS's C++ TopicTree without firing the wire-level subscribe hook - the hook only fires for `{type:'subscribe'}` and `{type:'subscribe-batch'}` wire frames. With direct calls, the loader runs and the initial-data response (and any `'join'` broadcasts) reach the wire before the client's eventual wire-level subscribe is denied with `FORBIDDEN`. Routing through `platform.subscribe` puts the gate where it belongs: before any data fans out. JSDoc on `hooks.ws.subscribe` and `subscribeBatch` now explicitly notes the wire-level scope and points downstream library authors at `platform.subscribe` as the correct path. Mirrored on the dev plugin (`vite.js`) and the `createTestServer` test platform (`testing.js`) so behavior is identical across surfaces; the parity test in `test/platform-parity.test.js` enforces this for dev/prod going forward. New `test/platform-subscribe.test.js` covers six contract points: hook gates the actual subscribe (denial flows through unchanged), idempotency (hook fires once per `(ws, topic)`, no double-charge), `INVALID_TOPIC` short-circuits before the hook, the subscription wires the connection into the publish broadcast path, `unsubscribe` removes the subscription and fires the unsubscribe hook (also idempotent), and a documented contract test that `ws.subscribe()` direct intentionally bypasses the hook (the bypass we are guarding against).

- **`platform.checkSubscribe(ws, topic)` for pure-gate authorization without subscribing.** Companion to `platform.subscribe` for callers that need to make the authorization decision in one step and perform the actual `ws.subscribe` later as part of a different orchestration. The shipped use case: an RPC framework whose stream-handler runs a loader between authorization and subscribe so the loader can fail cleanly without leaving a half-subscribed connection or a spurious `'join'` broadcast (svelte-realtime's `_executeStreamRpc` is the canonical example). Returns `null` to allow or a string denial reason. Pure - does not modify subscription state, does not call `ws.subscribe`, does not increment counters; the cap (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) is intentionally not consulted because no subscription is being created. Callers who plan to subscribe immediately after a clean check should prefer `platform.subscribe` for the atomic gate + subscribe + cap + state update flow. Mirrored on dev (`vite.js`) and on the `createTestServer` test platform (`testing.js`); the parity test enforces both sides ship the method.

### Fixed

- **Subscribe-hook chain now fails closed when a user hook throws (security default, was silent allow / handler crash).** `runSubscribeHook` and `runSubscribeBatchHook` (`files/handler.js`) now wrap the user-supplied callback in a `try/catch`. A throwing `subscribe` hook denies that subscribe with a canonical `'INTERNAL_ERROR'` reason; a throwing `subscribeBatch` hook denies every topic in the batch with the same reason. Before this change, a throwing hook propagated through the uWS message handler - behavior depended on uWS's frame-handler error path and could either crash the connection or fall through to allow (path-dependent on subscribe vs subscribe-batch + which surface invoked the hook). Logging the error to `console.error` keeps the cause visible without requiring callers to wrap their own hooks defensively. Affects every entry point uniformly: wire-level subscribe / subscribe-batch frames, `platform.subscribe`, and the new `platform.checkSubscribe`. Same fail-closed semantics mirrored on `vite.js` and `testing.js`.

- **Wire-level single-subscribe frames now consult `subscribeBatch` when only `subscribeBatch` is exported.** Previously the wire-level handler at `files/handler.js:2670` consulted only `runSubscribeHook` - a user who exported only `subscribeBatch` for centralized authorization had their hook fire for batch frames but **silently bypassed for single subscribes**. Same gap was present in the just-shipped `platform.subscribe` (called only the per-topic hook). Both paths now route through a shared internal helper `runUserSubscribeGate(ws, topic)` that mirrors the wire-level subscribe-batch precedence (subscribeBatch first, treating the single subscribe as a 1-element batch; falls back to per-topic `subscribe` if the batch hook is not exported). A user who exports only `subscribeBatch` now has their hook gate fired consistently across single and batch frames AND for both `platform.subscribe` and `platform.checkSubscribe`. Behavioral note: a `subscribeBatch` hook authored before this fix may receive 1-element `topics` arrays where it previously did not see single frames at all; this is consistent with the documented "set of pre-validated topics" contract (a 1-element set is still a set) and any reasonable hook handles it correctly. The wire-level subscribe-batch frame path is unchanged - it already consulted `subscribeBatch` when exported. Behavior cross-checked by a new test that fires the same `(ws, topic)` decisions through both `platform.checkSubscribe` and the wire-level subscribe-batch frame and asserts they agree topic-by-topic.

## [0.5.0-next.13] - 2026-05-05

### Fixed

- **Dev-mode platform missing six methods exposed by production - broke any downstream wrapper that captured those method references via `.bind`.** The dev platform constructed in `vite.js` had quietly drifted from the production platform across multiple releases as new primitives landed: `batch` (multi-publish helper), `sendCoalesced` (next.1), `pressure` and `onPressure` (next.1, refined through next.8), `onPublishRate` (next.4), and the `assertions` getter (next.8) were all missing from the dev base platform. Downstream consumers that wrap `platform` at construction time - e.g. the cluster pubsub bus in `svelte-adapter-uws-extensions/redis/pubsub` doing `sendCoalesced: platform.sendCoalesced.bind(platform)` - crashed on the first WebSocket message in `npm run dev` with `TypeError: Cannot read properties of undefined (reading 'bind')`. Production was unaffected; only dev had the parity gap. The fix adds shims for all six: `batch(messages)` runs the same `for`-loop over `publish()` that production does (returning the per-message `boolean[]`), `sendCoalesced` degrades to immediate `send` (dev runs over the `ws` library and has no real C++ outbound queue, so there is no backpressure to coalesce against - the production happy-path observable behavior is preserved), `pressure` returns a zero-valued `PressureSnapshot` (`active: false`, `reason: 'NONE'`, all numeric fields `0`, `topPublishers: []`) rather than `null` so destructuring `pressure.active` / `.reason` / `.topPublishers` in downstream code does not crash on field access, `onPressure(cb)` and `onPublishRate(cb)` accept the callback and return the documented unsubscribe stub, and the `assertions` getter returns a fresh empty `Map` per read (dev never tracks invariant violations - production exposes a live shared Map of category counts). Per-WebSocket and per-request `requestId` mechanics in dev (`Object.create(platform)` clones with `wsPlatform.requestId = ...` / `authPlatform.requestId = ...`) are unchanged - production also has no base-platform `requestId` getter, both dev and prod set it per-clone, so this was correctly already at parity. A comment block above the dev platform definition spells out the parity contract so the next time a primitive lands on production, the reviewer is reminded to mirror it here.

- **Mechanical regression guard against future dev/prod platform drift.** New `test/platform-parity.test.js` parses both `files/handler.js` and `vite.js` with acorn (already a transitive dev dep via Vite, no new install), locates the `const platform = { ... }` ObjectExpression in each, extracts the top-level keys (methods, properties, getters), and asserts every key on the production base platform also exists on the dev base platform. The check is one-directional (prod is a subset of dev) so dev-only debugging hooks remain allowed; the failure mode names the missing keys explicitly so a reviewer can mirror them at a glance. The test caught the `batch` gap above that an eyes-on audit had missed.

### Documentation

- **Throttle plugin docstrings rewritten to stop pointing readers at the multi-publisher trap.** The module-level docstring previously cited "mouse position, typing indicators" as canonical use cases, and the `@example` for `throttle()` showed N users emitting cursor moves into one shared topic - exactly the multi-publisher pattern the plugin's single shared pending slot handles wrong (fast publishers overwrite slow publishers' pending payloads, slow publishers' updates almost never reach subscribers; measured at `bench/28-throttle-per-key-ab.mjs`). Module docstring now describes the plugin as "per-topic publish rate limiting for single-publisher streams" and lists actually-safe use cases (server-aggregated metrics, live counters, world-state snapshots, job-progress feeds), with an explicit "not suitable for multi-publisher streams that share a topic" line. Function-level docstring gains a Caveat block linking to the bench and pointing at the world-state-tick aggregation pattern as the fix. The `@example` is rewritten to demonstrate that pattern (server maintains `Map<userId, latestPos>`, publishes one snapshot per tick), so the canonical example reading teaches the right architecture instead of the broken one. No runtime change.

## [0.5.0-next.12] - 2026-05-04

### Fixed

- **`sendCoalesced` silently dropped messages over `maxBackpressure`.** The flush callback in `flushCoalescedFor` (`files/handler.js`) was refactored to a block-bodied arrow when assertions and per-connection byte accounting landed in next.8, and the explicit `return` of `ws.send`'s status code was lost in that refactor. `drainCoalesced` therefore saw `undefined` instead of the documented 0/1/2 contract, treating every send - including ones uWS reported as DROPPED (return code 2, sent over the configurable `maxBackpressure` cap) - as a clean success. The pending Map entry was deleted, the message never reached the wire, and the resume-on-drain path at the `drain` hook had nothing to retry. In healthy conditions the bug was invisible because `ws.send` returned 0; under sustained backpressure on a slow client (the exact workload `sendCoalesced` exists to handle), messages exceeding `maxBackpressure` were silently lost. The callback now propagates `ws.send`'s return code so DROPPED retains the entry for retry and BACKPRESSURE halts the loop as the algorithm intended. As a small companion correction, the per-connection `bytesOut` counter exposed on the `close` hook (next.4) no longer counts payloads that were DROPPED - the byte count now reflects what actually reached the kernel buffer rather than what was attempted. The `drainCoalesced` algorithm itself in `files/utils.js` was correct all along and unit-tested in `test/utils.test.js`; the regression lived purely at the production caller's wiring.

## [0.5.0-next.11] - 2026-05-04

### Fixed

- **False-positive boot warning when `hooks.ws` exports `subscribeBatch` or `resume`.** The `knownWsExports` whitelist in `files/handler.js` was not updated when those two hooks shipped, so any app exporting either got a `Warning: WebSocket handler exports unknown "subscribeBatch"` (or `"resume"`) line at startup, with a `Did you mean one of: open, message, upgrade, close, drain, subscribe, unsubscribe, authenticate?` suggestion that pointedly omitted the hook the user had just written. The hook itself was always picked up and called correctly - the runtime reads `wsModule.subscribeBatch` directly in the bulk-subscribe path and `wsModule.resume` directly in the resume-protocol path - but the warning text actively misled downstream users into deleting the export to silence it, which silently disabled the documented bulk-auth and gap-fill paths. Whitelist now includes `subscribeBatch` and `resume` alongside the rest of the supported hook surface.

## [0.5.0-next.10] - 2026-05-04

### Changed

- **`package-lock.json` refreshed via `npm audit fix` to clear all four high-severity advisories in transitive dev / peer dependencies** (`@sveltejs/kit`, `picomatch`, `socket.io-parser`, `vite`) plus two moderates (`postcss`, `devalue`). No `package.json` range changes; no runtime dependency added or removed; the published package's `dependencies` (the four `@rollup/plugin-*` + `rollup`) remain clean and audit-free as they have always been. This is a dev-tree cleanup - npm consumers of `svelte-adapter-uws` are unaffected because `package-lock.json` does not ship in the npm tarball and peer-dep versions are resolved against the consumer's own tree. Five low-severity advisories remain (`cookie` transitive of `@sveltejs/kit`; `uuid` / `hyperid` / `autocannon` chain pulled in by the bench scripts), all fix-by-`--force` only and would either require a kit major bump or downgrade `autocannon` to an unusable 6-year-old version.

## [0.5.0-next.9] - 2026-05-04

### Added

- **Two new chaos / fault-injection scenarios on the test harness's `__chaos` setter.** `ipc-reorder` is a continuous scenario like `slow-drain` but defers each outbound frame by an independently-random delay in `[0, maxJitterMs)` so adjacent frames can arrive out of order; useful for exercising seq-gap detection, idempotency-key handling, and any protocol code that assumes ordered delivery. `maxJitterMs` is capped at `60_000`. `worker-flap` is a one-shot trigger that closes every currently-live WebSocket connection with a clean close frame (default `code: 1012`, default `reason: 'worker restart'`, both configurable); the server stays up and any active continuous chaos scenario (e.g. `drop-outbound`) survives the flap. Use `worker-flap` to verify clients reconnect, present their resume token, and the user's `resume` hook fills the gap correctly. Both ship alongside the existing `drop-outbound` and `slow-drain`; the API shape (`__chaos({ scenario, ... })`) is unchanged. README chaos section updated with examples + the continuous-vs-one-shot distinction; `ChaosScenario` discriminated union in `testing.d.ts` extended with both new variants.

- **`maxWaitMs` option on `lock.withLock`.** Third argument now accepts `{ maxWaitMs: number }`. When set, the caller is rejected with a typed `LOCK_TIMEOUT` error (with `.code`, `.key`, and `.maxWaitMs` fields) if it does not acquire the lock within `maxWaitMs` milliseconds. The current holder's `fn` is not interrupted; only the waiting caller gives up. Subsequent waiters on the same key are unaffected and continue in their original order, so a timeout never blocks the queue for later callers. `maxWaitMs: 0` fails immediately if any other caller holds or is queued ahead of you (try-lock pattern). Negative or non-finite values are rejected with a validation error. Unblocks bounded-wait surfaces in downstream consumers (e.g. `live.lock` in `svelte-realtime`) without forcing each consumer to reimplement the queueing algorithm.

### Changed

- **`lock` plugin internals refactored from chain-of-promises to per-key waiter queue.** No-op for users of `withLock(key, fn)` - the contract (FIFO ordering, error-isolation between callers, per-key independence, the `maxKeys` cap) is unchanged. The new representation is what makes `maxWaitMs` implementable correctly: the chain-of-promises pattern could not support timeouts without race conditions because cancelling B mid-wait would leave C chained off B's promise but C's `await prev` would resolve immediately when B's rejection settled, letting C run while A still held the lock. The waiter-queue makes "skip cancelled entries on advance" a one-line check in the dispatch loop.
- **`lock.clear()` now rejects pending waiters with a typed `LOCK_CLEARED` error**, instead of orphaning them. Soft semantic change from the prior chain-of-promises implementation, where `clear()` only cleared the lookup Map and pending callers continued to resolve as the chain unfolded (each promise was independent of the Map, held only by its caller). The waiter-queue owns the only reference to pending callers, so without an explicit rejection in `clear()` they would hang forever - which is worse than the documented teardown use case. If you relied on pending calls completing across a `clear()` in a teardown path, catch `LOCK_CLEARED` and treat it as success.

### Documentation

- **README catch-up pass.** Three plugins shipped without README sections (`lock`, `session`, `dedup`); each now has a full Setup / Usage / API / Options / Limitations entry. Plugin sections that already existed but were stale gained the new cap options inline (`cursor.maxConnections` / `maxTopics`, `presence.maxConnections` / `maxTopics`, `throttle` / `debounce` second-arg `maxTopics`, `ratelimit.maxBuckets` row in Options table); `queue.maxSize` default updated to `1_000_000` in the Options table. The test harness section gained `upgradeAdmission` configuration documentation (shipped in next.6 but undocumented) and a curated-re-exports note pointing at the helpers and userData slot constants that downstream test code can import from `svelte-adapter-uws/testing` (shipped in next.5 but undocumented). Client-store automatic-behaviours section gained a "Microtask-batched initial subscribes" entry covering the next.7 wire-shape change. Table of contents updated for the three new plugin sections.

- **README `Lock` section updated for `maxWaitMs`.** New "Bounded wait with `maxWaitMs`" subsection covers the third-argument shape, the `LOCK_TIMEOUT` error code + fields, the `maxWaitMs: 0` try-lock pattern, and the "subsequent waiters unaffected" guarantee. API table entry for `withLock` mentions the new options arg. `clear()` row updated to call out the `LOCK_CLEARED` rejection semantic. Limitations section clarifies that `maxWaitMs` caps wait time, not hold time - a hung `fn` still holds the lock indefinitely.

## [0.5.0-next.8] - 2026-05-03

### Added

- **Framework invariant assertions + `platform.assertions` observability.** A two-tier `assert(cond, category, context)` / `devAssert(cond, message, context)` helper pair lands in `files/utils.js` and is installed at ~27 invariant sites in the production handler covering envelope build, WebSocket lifecycle (open / message / drain / close / resume hook entries), subscription bookkeeping (`subs.shape`, `subs.total-negative`), server-initiated request entry shape, sendCoalesced state, cross-worker IPC payload types, and per-topic publish stats shape. On violation the counter for the category increments on the live module-level Map exposed via the new `platform.assertions` getter, and a structured `[adapter-uws/assert] {"category":"...","context":...}` line is logged. In production a violation does NOT throw - a thrown exception inside a uWS C++ callback frame can corrupt the binding state, and the metric + structured log are sufficient observability. In test mode (`process.env.VITEST` set, or `NODE_ENV === 'test'`) `assert` additionally throws so vitest surfaces the failure as a test error. `devAssert` is dev-time only - a complete no-op when `NODE_ENV === 'production'`. New README "platform.assertions" section under Platform API documents the shape and the report-an-issue workflow when a counter goes non-zero. The `platform.assertions` getter is also exposed on `TestPlatform` (createTestServer) for symmetry, so test code can read counts during integration runs.

- **Bounded-by-default capacity caps across the adapter and bundled plugins.** Every `Map` / `Set` whose growth is driven by client behaviour or topic cardinality now declares an explicit upper bound and a documented saturation behaviour, so an unbounded subscribe loop, a runaway server-initiated request stream, or a `chat-${userId}` topic-cardinality leak can no longer exhaust process memory silently. Defaults are deliberately generous (1,000,000 across the board) to avoid biting any healthy app at uWS scale; aggregate-memory protection still belongs to `upgradeAdmission.maxConcurrent`.
  - **Adapter core** (handler.js, vite.js, testing.js):
    - `WS_SUBSCRIPTIONS` per-connection set: cap 1,000,000. New subscribes past the cap respond with `subscribe-denied` reason `'RATE_LIMITED'`. Applies to both the single-subscribe and `subscribe-batch` paths in production, dev, and the test harness.
    - `WS_PENDING_REQUESTS` per-connection map: cap 1,000,000. New `platform.request()` calls past the cap reject synchronously with "pending requests exceeded".
    - `WS_COALESCED` per-connection map: cap 1,000,000. New keys past the cap drop the oldest insertion-order entry on insert (latest-value-wins contract is preserved by definition).
    - `topicSeqs` module-level seq registry: warn-only at 1,000,000 distinct topics. The resume protocol depends on each entry persisting for the process lifetime, so eviction would corrupt reconnecting clients - instead, a single structured `console.warn` with the topN recent publishers fires when the threshold is first crossed, surfacing the leak shape before OOM.
    - `lastPublishWarnAt` runaway-publisher dedup: cap 1,000,000 with FIFO eviction; pure dedup state, dropping oldest just resets the warn cooldown for that topic.
  - **Plugins**:
    - `ratelimit`: new `maxBuckets` option (default 1,000,000). Hard-evicts oldest insertion-order bucket on insert at cap, protecting against sustained DDoS where the lazy expired-entry sweep cannot free slots.
    - `throttle` and `debounce`: new `maxTopics` option (default 1,000,000). When the topic registry is at cap, the oldest insertion-order entry is flushed (its pending value publishes immediately) and dropped before the new topic is inserted.
    - `cursor`: new `maxConnections` and `maxTopics` options (each default 1,000,000). Drop oldest insertion-order entry on insert at cap; pending throttle timers on the dropped topic are cleared first.
    - `presence`: new `maxConnections` and `maxTopics` options (each default 1,000,000).
    - `lock`: new `maxKeys` option (default 1,000,000). New-key `withLock` synchronously rejects with "active key count exceeded" when the chain is at cap; existing keys can still be re-entered.
- **README "Capacity model" section** under Backpressure & connection limits. Single tabular reference for every internal cap, its default, its saturation behaviour, and whether it is overridable. Documents the per-conn-cap-multiplier reasoning (per-conn caps catch single-connection bugs; aggregate memory bounds come from `upgradeAdmission.maxConcurrent`) and the `topicSeqs` warn-only rationale.

### Changed

- **`queue` plugin `maxSize` default changed from `Infinity` to `1,000,000`.** Soft API change: existing users who relied on unbounded queues see their queue start dropping tasks via `onDrop` once 1M waiting tasks accumulate per key. Pass `{ maxSize: Infinity }` explicitly to opt back into the previous behaviour. The new default brings the plugin in line with the rest of the bounded-by-default audit; no real workload should reach 1M waiting tasks per key without a leak.

## [0.5.0-next.7] - 2026-05-02

### Changed

- **Initial-mount subscribe frames are now microtask-batched.** Multiple `subscribe(topic)` calls landing in the same microtask coalesce into one `{type:'subscribe-batch', topics, ref}` wire frame instead of N individual `{type:'subscribe', topic, ref}` frames. A page mounting many topic stores (a typical multi-stream dashboard, an `svelte-realtime` page that initializes 5 stream RPCs in a tight loop, etc.) now triggers the server's `subscribeBatch` hook ONCE instead of the per-topic `subscribe` hook N times - which is the whole reason `subscribeBatch` exists. Single-topic case stays as a plain `subscribe` frame for the minimal-change wire shape. Same chunking limits the reconnect path uses (8000 byte / 200 topic per batch); the limits live in a shared `chunkTopicsForBatch` helper so the two call sites cannot drift. Topics are still added to `subscribedTopics` synchronously, so a disconnect between the call and the microtask flush loses nothing - the reopen's resubscribe-batch path picks them up. **Behaviour change**: any test code asserting on the exact wire shape of two same-microtask subscribes seeing two `subscribe` frames now sees one `subscribe-batch` frame. Use `.find(m => m.type === 'subscribe-batch' && m.topics.includes(...))` instead.

### Documentation

- **Chaos harness scope explicitly documented** in the `ChaosScenario` JSDoc (`testing.d.ts`) and the README chaos section. `__chaos` is a WebSocket-frame outbound chokepoint inside the test harness; it covers what the bundled WS protocol does (subscribe acks, session resume, sendCoalesced under backpressure, request/reply timeouts) and does NOT cover transport-level traffic outside the harness (ioredis, pg, NATS, custom HTTP backends). Prevents the misunderstanding that chaos covers cross-wire testing for distributed primitives - that responsibility lives in the layer that owns each wire.
- **README "Wrap your own transport for cross-wire chaos" pattern.** Shows downstream extension authors and app-side test code how to compose the `createChaosState` factory (already re-exported from `svelte-adapter-uws/testing`) with any transport client (ioredis, pg, NATS, fetch) to get the same `__chaos({ scenario, dropRate, delayMs })` ergonomic scoped to that client. Zero new adapter surface; the pattern transfers across transports without anyone needing to invent a new API. ~30 LOC sketch in the README, anchor-stable for downstream docs to link to.

## [0.5.0-next.6] - 2026-05-02

### Added

- **`upgradeAdmission` option on `createTestServer`.** Mirror of the production handler's `wsOptions.upgradeAdmission` setting (`maxConcurrent`, `perTickBudget`). Lets adapter-side and downstream test code drive a real connection storm against the harness and assert the admission shed-shape (503 with the documented status text) without booting a full SvelteKit app. Off by default; production users continue to configure the same thing via `adapter({ websocket: { upgradeAdmission: { ... } } })`. New `test/upgrade-admission-wiring.test.js` covers the wiring end-to-end (default-disabled accepts everyone, in-flight cap sheds the surplus with 503, slow user upgrade hooks hold the slot, in-flight slots are released after the upgrade completes). Closes the coverage gap between "the `createUpgradeAdmission` factory works in isolation" and "the wiring inside the upgrade hook actually triggers the shed."
- **README "Layered admission" section** under Backpressure & connection limits. Documents that `upgradeAdmission` sheds at the handshake layer (before TLS work), and points readers at the extensions package's `createAdmissionControl` for the message-dispatch layer that sheds RPC traffic on already-accepted connections. Includes a wiring snippet showing both factories side-by-side. Covers the structural ordering (uWS lifecycle enforces "no message handler dispatch before upgrade", so the two layers cannot drift apart).

## [0.5.0-next.5] - 2026-05-02

### Added

- **Curated pure helpers and userData slot constants re-exported from `svelte-adapter-uws/testing`.** Downstream test code (extensions, app-side integration tests, custom transport bridges) can now `import { wrapBatchEnvelope, completeEnvelope, WS_CAPS, ... } from 'svelte-adapter-uws/testing'` to assert on the same wire shapes and userData state the production runtime produces, without redeclaring helpers that would drift over time. Curated set: five wire-protocol helpers (`esc`, `completeEnvelope`, `wrapBatchEnvelope`, `isValidWireTopic`, `createScopedTopic`), three behavior helpers (`collapseByCoalesceKey`, `resolveRequestId`, `createChaosState`), and all eight per-connection userData slot constants (`WS_SUBSCRIPTIONS`, `WS_COALESCED`, `WS_SESSION_ID`, `WS_PENDING_REQUESTS`, `WS_STATS`, `WS_PLATFORM`, `WS_CAPS`, `WS_REQUEST_ID_KEY`). Production-internal plumbing (mime lookup, byte parsing, cookie split, write-chunk backpressure, sampler internals, upgrade admission factory, origin allowlist matcher) is deliberately NOT re-exported so the test surface can stay semver-stable while production hot paths remain free to refactor. Type declarations land alongside the re-exports in `testing.d.ts`. The same names continue to live in `files/utils.js`; the re-export is purely an additive public surface, not a relocation.
- **`failure` Readable on the client store, sibling to `status`.** Carries the cause of the most recent non-open status transition so consumers can render targeted UI per failure type: `'TERMINAL'` (server permanently rejected: 1008/4401/4403), `'EXHAUSTED'` (`maxReconnectAttempts` hit), `'THROTTLE'` (server signalled rate-limit via 4429), `'RETRY'` (normal transient drop), `'AUTH'` (auth preflight failed before the WebSocket was opened). Discriminated union by `kind` (`'ws-close'` carries `code`, `'auth-preflight'` carries `status`) plus a `reason` string label. Stays `null` while connected, set on the failing transition, cleared on the next successful `'open'`. NOT set on an intentional `close()` call; `status === 'failed'` paired with `failure === null` is the deliberately-ended state. Available as a top-level `failure` export and on the `WSConnection` returned by `connect()`. The information was previously computed (`classifyCloseCode` + auth-preflight outcome) and discarded immediately into a less-specific `status` value; this surface preserves it for app-layer rendering without forcing apps to re-derive close-code semantics.

## [0.5.0-next.4] - 2026-05-02

### Added

- **`platform.publishBatched(messages)` for wire-level batched fan-out.** Publish a list of `{topic, event, data}` events as a single `{type:'batch', events:[...]}` WebSocket frame per affected subscriber, instead of one frame per event. The bundled `svelte-adapter-uws/client` decodes the batch frame and dispatches each contained event through the same per-topic store ladder a single-event frame would take. Capability gating: clients opt in via a `{type:'hello', caps:['batch']}` frame after open (the bundled client does this automatically); the server only emits batch frames when every interested subscriber has advertised the capability. When the fast path does not apply (mixed subscriber views, mixed-cap subs, or disjoint single-topic-per-event shapes), `publishBatched` falls back to a per-event `publish()` loop so the call is at least as fast as the loop the user would have written by hand. Bench-gated at land time: 50x500 same-topic bulk-fan-out 3.8x faster than a `publish()` loop (`+285%`), 5x500 overlapping topics `+22%` faster, 3x50 disjoint topics within noise. Per-event seq stamping preserved, per-event `{relay: false}` / `{seq: false}` options supported. **Cross-worker relay carries the batch as a single IPC frame**; each receiving worker re-runs the fast-path detection against its local subscriber set and dispatches via batch or per-event according to its own profile, so wire batching is preserved cluster-wide. **Per-event `coalesceKey?: string`** collapses same-key duplicates before framing - latest value wins at the latest occurrence's position - for streams of cursor / presence / price-tick events where intermediate values are noise. Frame-size soft cap at 256 KB triggers a throttled `console.warn` (uWS per-message-deflate may kick in over large frames). The existing `platform.batch(messages)` is unchanged but now documents that it is NOT wire-level batching; the JSDoc points users at `publishBatched` for that.
- **Chaos / fault-injection harness on `createTestServer`.** The test platform now carries `__chaos(cfg)` for simulating broken-network conditions while exercising protocol code (subscribe acks, session resume, `sendCoalesced` under backpressure, request/reply timeouts, etc). Two scenarios in this revision: `'drop-outbound'` discards outbound frames before they reach the wire with the configured `dropRate` (a probability in `[0, 1]`), and `'slow-drain'` defers each outbound frame by `delayMs` milliseconds via `setTimeout`. Affects every server-to-client frame the harness emits: `platform.publish`, `platform.send`, `platform.sendTo`, `platform.request`, the welcome envelope, subscribe acks, and the resumed ack. While a scenario is active, `platform.publish` switches from uWS's C++ TopicTree fan-out to a JS-side fanout so the chaos state can intercept per recipient; reset with `platform.__chaos(null)` to return to the zero-overhead fast path. The harness lives only on the test platform - production does not ship `__chaos`. Tests under `test/chaos.test.js` cover drop, delay, reset, and unknown-scenario rejection; the underlying `createChaosState()` pure helper (in `files/utils.js`) is unit-tested with deterministic RNG injection.
- **`platform.requestId` for cross-layer log correlation.** Every HTTP request and every WebSocket connection now carries a string `requestId` on `event.platform`. HTTP requests get a fresh UUID per request; WebSocket connections stamp once at upgrade time and the same id flows through every hook on that connection (`open`, `subscribe`, `subscribeBatch`, `unsubscribe`, `message`, `drain`, `resume`, `close`). Inbound `X-Request-ID` overrides the generated value when present (sanitized: printable ASCII, max 128 chars; whitespace / control / non-ASCII values are rejected and the adapter falls back to a UUID). The adapter never emits `X-Request-ID` on the response automatically - returning it is an app-layer concern (`new Response(body, { headers: { 'x-request-id': platform.requestId } })`). The upgrade hook also receives `requestId` directly on its context so auth-decision logging can include it before the connection opens. Per-connection cost: one `Object.create` clone allocated in `open` (gives every hook a live-getter view of the shared platform plus a stable `requestId` field); per-HTTP-request cost: one clone per `server.respond` call. Caveat: dev mode (`vite dev`) generates a fresh UUID per HTTP request but does not honour `X-Request-ID` for HTTP - SvelteKit's `emulate.platform()` runs without access to request headers. WebSocket upgrades in dev honour the header normally, matching production. Caveat: the SSR dedup path (anonymous GET / HEAD coalescing) means waiters reuse the leader's response body - their own `X-Request-ID` reaches the adapter but never enters `server.respond`; for strictly per-request tracing on those routes opt out with `x-no-dedup: 1`.
- **Per-topic publish-rate detection on the pressure sampler.** Every `platform.publish()` call bumps two integer counters on a per-topic stats slot (one Map entry allocated the first time a topic is published to, then zero allocations on the steady state). The 1 Hz sampler reads the counters into per-second message-rate and byte-rate per topic, surfaces the top 5 by message rate on `platform.pressure.topPublishers`, and flags any topic that crossed the configurable `topicPublishRatePerSec` (default 5000) or `topicPublishBytesPerSec` (default 10 MB/s) thresholds. Default response is a throttled `console.warn` once per topic per minute. Register `platform.onPublishRate(cb)` to take ownership of the surface (suppresses the default warning); the callback receives an array of `{ topic, messagesPerSec, bytesPerSec }` for any topics over threshold in the last window. Set either threshold to `false` to disable that signal. Aggregate `publishRatePerSec` is unchanged - this layer names the offender, the aggregate signal flags overall load.
- **Per-connection traffic stats on the `close` hook.** When you export `close` from `hooks.ws`, the context now carries `id` (the session id from the welcome envelope), `duration` (lifetime in ms), `messagesIn`, `messagesOut`, `bytesIn`, and `bytesOut` alongside the existing `code` / `message` / `subscriptions`. Useful for per-session logging, quota accounting, and connection-quality dashboards. Counters are only populated when the close hook is registered - the adapter skips the bookkeeping otherwise to keep the hot path zero-cost for stats-uninterested apps. Caveat: `messagesOut` / `bytesOut` count direct sends to the specific connection (welcome, subscribe acks, replies, `platform.send`, `platform.sendCoalesced`, matched `platform.sendTo`). Topic-broadcast `platform.publish()` fan-out is **not** counted because uWS does the dispatch in C++ and per-recipient byte accounting would defeat the fast path - use `platform.pressure.publishRate` for aggregate publish-rate signals instead.

### Changed

- **Client `status` store expanded to a five-state machine.** Was `'connecting' | 'open' | 'closed'`; now `'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'`. The previous catch-all `'closed'` is split into three distinct states so apps can drive different UI affordances:
  - `'disconnected'` - lost connection, will retry automatically (show "Reconnecting...").
  - `'failed'` - terminal: auth denied (close codes 1008 / 4401 / 4403), max reconnect attempts exhausted, or `close()` was called. Stays in this state; user action required to recover.
  - `'suspended'` - WS is technically open but the tab is in the background. Driven by `visibilitychange`; flips back to `'open'` automatically when the tab returns. Browsers may kill idle backgrounded sockets, so live data is best-effort while suspended.

  `ready()` now resolves on either `'open'` or `'suspended'` (both indicate an established WS). Apps that previously matched `$status === 'closed'` need to map to `'disconnected'` (transient) or `'failed'` (terminal) - or use `_permaClosed` if the only thing they cared about was the terminal case. Tests in `client-real.test.js` cover all five transitions.

- **Presence plugin wire format switched to a compact diff protocol.** The five-event format (`list` / `join` / `updated` / `leave` / `heartbeat`) collapses to two diff-shaped events plus the existing heartbeat:
  - `{event: 'presence_state', data: {[key]: meta}}` - full snapshot, sent to a single connection on join or sync. Replaces the array-shaped `list`.
  - `{event: 'presence_diff', data: {joins: {[key]: meta}, leaves: {[key]: meta}}}` - changes, broadcast to topic subscribers. Replaces individual `join` / `updated` / `leave` frames.

  Diffs are now microtask-batched: multiple joins / leaves in the same tick collapse into one frame. Within a diff, leaves apply first then joins, so an update (same key in both) ends with the user present using the new data; if a key cycles join then leave in the same tick, the diff carries only the latest op (leave wins). `heartbeat` is unchanged. The `presence()` Svelte store API on the client is unchanged - the wire change is internal to the plugin's server <-> client round-trip. Hand-rolled clients that consume the wire directly need to switch decoders. Bundle ships server + client together so single-package upgrades are seamless; stale browser tabs from a previous deploy will see a blank presence list until refresh.

- **`tracker.flushDiffs()` exposed on the presence tracker** for callers that need the buffered diff to land synchronously - tests are the primary user, but production code that needs presence state visible to other workers before its own block returns can call it explicitly. No-op when nothing is buffered.

### Added

- **`platform.request(ws, event, data, options?)` for server-initiated request/reply over the same WebSocket.** The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`, and the returned Promise resolves with whatever the client's `onRequest` handler returned. Rejects with `Error('request timed out')` after `timeoutMs` (default `5000`) and with `Error('connection closed')` if the WebSocket closes before a reply arrives. Pending requests are tracked per-connection on `userData[WS_PENDING_REQUESTS]`, so close cleanup is automatic; refs scoped per-connection so a stray reply on one socket cannot resolve a request on another. Use this for server-driven confirmations, capability challenges, or push-driven state queries that today require user code to maintain its own correlation state.
- **`onRequest(handler)` on the client store** for handling server-initiated requests. Sync or async; return a value to reply with it, throw / reject to send an error reply that surfaces on the server as a Promise rejection. Only one handler may be installed at a time; calling `onRequest` again replaces the previous handler. Returns an unsubscribe function that clears the handler if it is still active. With no handler, request frames are dropped silently and the server's call times out. Available both as a top-level export from `svelte-adapter-uws/client` and as a method on the `WSConnection` returned by `connect()`.
- **`testing.TestServer` now exposes `wsConnections`** (the live Set of connected uWS WebSocket instances) so tests that drive `platform.request(ws, ...)` can target a specific connection without a roundtrip through `waitForConnection`.
- **New optional `subscribeBatch` hook on `hooks.ws`** for bulk-authorising the topic list a client resubscribes to on reconnect. Receives `(ws, topics, { platform })` where `topics` is the pre-validated topic list (already filtered for `INVALID_TOPIC`); returns a record mapping the topics you want to deny to a reason (`false` -> `'FORBIDDEN'`, any string -> that reason verbatim). Omit a topic / return `true` / return `undefined` for it -> allow. Returning `undefined` or `{}` from the hook means "allow everything". Designed for the "one DB query for N topics" pattern - users who would otherwise issue N round-trips per reconnect can collapse to one. If `subscribeBatch` is not exported, the per-topic `subscribe` hook is called once per topic in the batch (unchanged behaviour). Sync only in v1; for async lookups, pre-cache grants on `userData` during `upgrade`.
- **Subscribe acknowledgements with structured denial reasons.** Every client subscribe / subscribe-batch frame now carries a numeric `ref` and the server replies per topic with `{type:'subscribed', topic, ref}` on accept or `{type:'subscribe-denied', topic, ref, reason}` on deny. The `subscribe` hook return value drives the reason: `false` denies with `'FORBIDDEN'`; any string return is forwarded verbatim as the reason (canonical codes are `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`, `'RATE_LIMITED'`, but custom strings work too). The framework also emits `'INVALID_TOPIC'` automatically when a client sends a malformed topic. Backward compatible: old clients that send subscribe without a `ref` get no ack frame, exactly like before.
- **`denials` Svelte store on the client.** Mirrors `status` - import it, subscribe, react. Each subscribe-denied frame becomes the latest `{topic, reason, ref}` value. Pair with a banner / toast / route guard to show users why a subscription was rejected. Available both as a top-level export from `svelte-adapter-uws/client` and as a property on the `WSConnection` returned by `connect()`.
- **`SubscribeDenialReason` type exported from `svelte-adapter-uws` and `svelte-adapter-uws/client`** for users who want to discriminate on canonical reason codes in TypeScript.
- **`websocket.upgradeAdmission` option for two-layer admission control on the WebSocket upgrade path.** Both layers opt-in (zero or unset = disabled), independent of each other. `maxConcurrent` caps how many upgrades may be in flight at once - crossed requests get a fast `503 Service Unavailable` before any per-request work (no TLS, no header parsing, no cookie decoding), so a connection storm can be shed without burning CPU. `perTickBudget` caps how many `res.upgrade()` calls run per event-loop tick - once the budget is spent, subsequent calls are deferred via `setImmediate` so the loop is not starved by 10K synchronous handshakes from one I/O batch. Pre-upgrade work (rate limit, origin check, hook dispatch) still runs in the original tick; only the hand-off to the C++ upgrade path is paced. Deferred upgrades preserve submission order and recheck `aborted`/`timedOut` on resume so a closed connection does not call `res.upgrade()`. The admission state lives in a per-instance closure (`createUpgradeAdmission()` in `files/utils.js`), so multiple uWS apps in one process do not interfere.
- **Session resume protocol on WebSocket reconnect.** On every WS open the server now stamps a per-connection session id and announces it to the client (`{"type":"welcome","sessionId":"..."}`). The client stores the id in `sessionStorage` (keyed per ws path) and tracks the highest `seq` it has seen for each topic. When the connection drops and the client reconnects, it presents the previous session id plus the per-topic last-seen seqs in a `{"type":"resume", sessionId, lastSeenSeqs}` frame, sent before `subscribe-batch`. The server acks with `{"type":"resumed"}`.
- **New optional `resume` hook on `hooks.ws`** receiving `(ws, { sessionId, lastSeenSeqs, platform })`. Use this to fill the disconnect gap, typically by calling the replay plugin's `replay.replay(ws, topic, sinceSeq, platform)` for each topic. Without the hook, the server still acks the resume frame and the client falls through to live mode (same behavior as a cold connect). Old clients ignore the welcome envelope; old servers ignore the resume frame; both directions stay backward compatible. The dev Vite plugin and the test harness (`createTestServer`) carry the same protocol so dev mode, tests, and prod behave identically.
- **`WS_SESSION_ID` Symbol slot on `ws.getUserData()`** stamped before the user's `open` hook runs, so handlers can read the session id from `userData[WS_SESSION_ID]` (export from `svelte-adapter-uws/files/utils.js`) without parsing the wire envelope.

## [0.5.0-next.3] - 2026-04-29

### Fixed

- **Throttle plugin no longer leaks topic state.** The trailing-edge tick in `throttle()` now removes the topic entry from its internal map when the trailing window closes with no pending value (matching the existing `debounce()` cleanup). Previously, every topic ever published through `throttle.publish()` left one map entry behind for the lifetime of the limiter; with high-cardinality patterns like `throttle.publish(platform, 'cursor:' + userId, ...)` this grew without bound. External behavior (leading edge, trailing edge, idle restart) is unchanged.
- **Test harness now applies the same wire-protocol topic validation as production.** `createTestServer()` (`svelte-adapter-uws/testing`) was previously checking only the 256-character length cap on `subscribe` / `subscribe-batch` topics; the production handler also rejects topics that contain control characters. Tests written against the harness now reject the same inputs production rejects.

### Changed

- **Internal: shared the JSON-identifier escape, wire-topic validator, and scoped-topic factory across the production handler, the dev Vite plugin, and the test harness.** The production `files/handler.js`, `vite.js`, and `testing.js` previously held byte-identical copies of `esc(s)`, the topic validation loop, and the `platform.topic(name)` shape (publish / created / updated / deleted / set / increment / decrement). All three now import `esc`, `isValidWireTopic`, and `createScopedTopic` from `files/utils.js`, which is the single source of truth for wire-protocol shape. A/B microbench (5M iterations x 10 alternating rounds): cross-module cost was within baseline noise (esc -0.03%, isValidWireTopic +0.41%, createScopedTopic -0.07%; baseline stddev 1.3-4.2%).
- **Internal: shared the `mockWs` / `mockPlatform` test factories across the seven plugin test files** that previously declared their own copies (`channels`, `cursor`, `groups`, `middleware`, `presence`, `ratelimit`, `throttle`). They now live in `test/_helpers.js`. No behavior change.
- **Removed an unused local in `plugins/middleware/server.js`** (`calledIndex`).
- **Internal: each plugin now declares its wire-protocol topic prefix as a `TOPIC_PREFIX` constant** instead of repeating the literal across the file. Affects `cursor`, `groups`, `presence`, `replay` (server + client). Eliminates a class of refactor-rot bugs - notably `plugins/presence/server.js` previously had `topic.slice(11)` for the length of `'__presence:'`, which would silently misbehave if anyone ever changed the prefix string. Now `topic.slice(TOPIC_PREFIX.length)`. No external behavior change.
- **Internal: `client.js` `crud()` and `lookup()` now share a single CRUD reducer ladder** parameterized by storage adapter (`arrayCrudStorage` for `crud`, `recordCrudStorage` for `lookup`) and a `keyOf(item)` extractor. Previously the four code paths (crud no-maxAge, crud maxAge, lookup no-maxAge, lookup maxAge) hand-rolled the `event === 'created' / 'updated' / 'deleted'` ladder against their respective collection shapes. The dispatcher (`applyCrudReducer`) lives once; the four sites call it with their own storage + `keyOf`. The maxAge variants still own their timestamp tracking and sweep timer; only the per-event reducer body collapsed. Behavior preserved exactly: `keyOf` is `(x) => String(x[key])` for the maxAge variants (matching their previous use of `String()` for timestamp Map keys) and `(x) => x[key]` for the no-maxAge variants. 105 `client-real` tests cover the full surface end-to-end.
- **Internal: WebSocket Origin validation in `files/handler.js` now goes through `isOriginAllowed(reqOrigin, headers, ctx)` in `files/utils.js`** instead of a 4-level-nested ladder inline in the upgrade handler. Pure helper, no module-state capture: PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER overrides, `isTls`, and `hasUpgradeHook` are passed via `ctx`. Same policy as before (`'*'`, `'same-origin'`, or string-array allowlist; default-port stripping; malformed Origin rejected). 21 unit tests in `test/utils.test.js` cover the matrix. A/B microbench (`bench/micro-origin.mjs`, 5M iterations x 10 alternating rounds, 10-input mix): -6.01% median runtime for the extracted form, within the harness's noise floor (steady-state rounds 1-7 showed it consistently ~5-7% faster - V8 specializes the early-return function form better than the long `let allowed = false` ladder).
- **e2e suite now allocates ports dynamically.** `test/e2e/` previously hardcoded `49321` (dev) and `49322` (prod), which fall inside the Hyper-V dynamic exclusion range on Windows (auto-assigned per boot somewhere within 49152-65535). On a typical Windows box `npm run test:e2e` failed instantly with `EACCES: permission denied ::1:49321`. A new `test/e2e/ports.js` picks two free OS-assigned ports at module-load time via `net.createServer().listen(0)`, caches them into `E2E_DEV_PORT` / `E2E_PROD_PORT` env vars, and is imported by `playwright.config.js`, `global-setup.js`, `dev.spec.js`, and `prod.spec.js`. The `dev-server.js` / `prod-server.js` fallbacks were updated to read the same env vars when run standalone. No CI/Linux behavior change; Windows users can now actually run the suite (verified: 25/25 e2e tests passing locally on Windows).
- **Internal: per-connection adapter scratch state moved off user-visible dunder strings to Symbol-keyed slots.** The adapter previously stored its `__subscriptions` (Set of subscribed topics, used to populate `CloseContext.subscriptions`) and `__coalesced` (sendCoalesced buffer) directly on user-visible `getUserData()`. A user `upgrade()` hook returning `{ __subscriptions: ... }` would clobber the adapter's tracking; `Object.keys(getUserData())` and JSON-serialize would expose them. Both slots now live under `WS_SUBSCRIPTIONS` and `WS_COALESCED` symbols exported from `files/utils.js`. The user-facing close-handler `CloseContext.subscriptions` shape is unchanged; this is purely internal isolation. Affects `handler.js` (8 sites), `vite.js` (5), `testing.js` (5). A/B microbench (`bench/micro-symbol-vs-dunder.mjs`, 5M iterations x 10 rounds): +1.08% median runtime for Symbol-keyed access on the subscribe hot path, within baseline stddev +/- 1.62%; verdict noise.

## [0.5.0-next.2] - 2026-04-28

### Added

- **`createLock()` plugin at `svelte-adapter-uws/plugins/lock`.** Per-key serialization for critical sections that must not interleave - atomic read-modify-write on user state, "only one in-flight upgrade per resource," anywhere two requests racing the same record would corrupt it. Concurrent `withLock(key, fn)` calls on the same key queue FIFO; calls on different keys run in parallel. Errors from `fn` propagate to the caller and do not block subsequent waiters on the same key. Backed by a single `Map<string, Promise>` chain - no timers, no allocations on the steady-state path. The plugin also exposes `held(key)`, `size()`, and `clear()` for inspection and test teardown. The contract is shaped to map cleanly onto a future Redis-backed swap (`SET NX PX`) in the extensions package, so user code written against the in-process plugin moves to a distributed lock without an API change.
- **`createSession()` plugin at `svelte-adapter-uws/plugins/session`.** In-process session store with sliding TTL: every `get` or `touch` extends an entry's expiry by another full ttl window. Designed for the "load on WS upgrade, refresh on activity" pattern. The plugin exposes `get(token)`, `set(token, data)`, `delete(token)`, `touch(token)`, `size()`, and `clear()`. Expired entries are pruned lazily on access. A soft `maxEntries` cap (default 10000) triggers pruning of expired entries when exceeded; if the map is still over cap after pruning (i.e. all entries are live), the oldest insertion-order entries are evicted to keep memory bounded. The contract is shaped to map cleanly onto a future Redis-hash swap in the extensions package.
- **`createDedup()` plugin at `svelte-adapter-uws/plugins/dedup`.** In-process "have I seen this id before?" cache with **fixed-window** TTL (unlike Session, the window does NOT slide on duplicate claims - the semantics match Redis `SET NX EX`, the eventual distributed swap target). The natural use is wrapping a side-effecting handler so client retries after a flaky disconnect do not double-execute: `if (!dedup.claim(messageId)) return;`. Exposes `claim(id)` (atomic check-and-mark, returns `true` on first sight / after expiry, `false` inside the window), `has(id)`, `delete(id)`, `size()`, and `clear()`. Same `maxEntries` eviction semantics as the Session plugin. This is the in-memory zero-config default for idempotent message delivery.

## [0.5.0-next.1] - 2026-04-28

### Added

- **`platform.sendCoalesced(ws, { key, topic, event, data })`** - new per-connection send primitive with coalesce-by-key semantics. Each `(connection, key)` pair holds at most one pending message; if a newer call for the same key arrives before the previous frame drains, the older value is replaced in place. Latest value wins, original insertion order across keys is preserved. Use for latest-value streams where intermediate values are noise (price ticks, cursor positions, presence state, typing indicators, scroll position). Serialization is deferred to flush time, so a stream that overwrites the same key 1000 times before a drain pays one `JSON.stringify`, not 1000. Pumping resumes automatically on the connection's next drain event - `send()` and `publish()` are unchanged.
- **`platform.pressure`** and **`platform.onPressure(cb)`** - worker-local backpressure signal. The adapter samples once per second (configurable) and exposes `{ active, subscriberRatio, publishRate, memoryMB, reason }` where `reason` is one of `'NONE'`, `'PUBLISH_RATE'`, `'SUBSCRIBERS'`, `'MEMORY'` with fixed precedence (memory wins over publish rate wins over subscribers). `onPressure(cb)` fires on `reason` transitions and returns an unsubscribe function. Use this to drive targeted degradation (shed background streams, return 503 for non-critical writes) instead of generic panic on slow consumers. Thresholds are configurable via `WebSocketOptions.pressure`; each individual signal can be set to `false` to disable. Defaults are conservative and a healthy small app should not trip them in steady state.
- **Per-topic monotonic `seq` on every broadcast envelope** - `platform.publish()` now stamps a monotonic per-topic sequence number into the envelope (`{ topic, event, data, seq }`). The first publish to a topic sends `seq: 1`, the next `seq: 2`, and so on; each topic has its own counter. Reconnecting clients can use the seq to detect dropped frames and resume from where they left off. The wire change is purely additive - clients that don't care about seq simply ignore the extra field. Pass `{ seq: false }` to opt out for ephemeral or high-cardinality topics where the counter map would grow unbounded. The `WSEvent<T>` client type gains an optional `seq?: number` field for downstream consumers. In clustered mode the seq is worker-local; the originating worker's seq propagates verbatim through the relay to other workers, so concurrent publishers on the same topic across multiple workers can produce colliding seqs. The testing harness (`createTestServer`) is brought to wire-format parity, so user tests against the harness see the same envelope shape as production.
- **`classifyCloseCode(code)` - explicit close-code classification on the client.** The reconnect dispatch now goes through a named primitive that maps every WebSocket close code into one of three buckets: `'TERMINAL'` (1008/4401/4403 - permanent rejection, no further reconnect), `'THROTTLE'` (4429 - server-side rate-limit, jump ahead in the backoff curve), or `'RETRY'` (everything else, including normal closes 1000/1001 and abnormal 1006/1011/1012). Behavior is unchanged: terminal codes still stop the retry loop, throttle codes still bump the attempt counter to 5, retry codes still go through the standard backoff. The lift from implicit-third-branch to named primitive makes the contract testable in isolation and gives callers a single place to reason about close semantics.

### Changed

- **Reconnect curve: `2.2^attempt` with a 5 minute cap.** The exponential factor moves from `1.5^attempt` to `2.2^attempt` and the default `maxReconnectInterval` cap moves from `30000` (30 seconds) to `300000` (5 minutes). The proportional +/- 25% jitter is unchanged. The new curve hits the cap by attempt 6 with the default 3 second base, vs the old curve which capped at 30 seconds and stayed there from attempt 6 onward. Net effect: brief restarts feel the same (first few attempts are short), but a sustained outage backs off harder, which is kinder to a server that is genuinely struggling. The `'THROTTLE'` close-code response (4429) inherits the new curve; jumping to attempt 5 now lands at ~155 seconds instead of ~22 seconds. Users who want the old behavior can pass `{ maxReconnectInterval: 30000 }` explicitly. The delay calculation is now a pure helper (`nextReconnectDelay`) on `client.js`, with unit tests covering attempt-zero base case, exponential growth, cap-saturation, multiplicative jitter at the cap (so 10K clients hitting the cap simultaneously don't reconnect in lockstep), and custom base/cap overrides.

---

## [0.4.14] - 2026-04-17

### Fixed

- **`res.upgrade()` fires uWS "writes must be made from within a corked callback" warning**: restored `res.cork()` around the WebSocket upgrade in both the sync (no-upgrade-handler) path and the async (user-upgrade-handler) path, and in the same-signature path in `testing.js`. One warning per upgrade is now gone.
- **Revisited the 0.4.11 "Windows upgrade" fix**: 0.4.11 removed the cork wrapper around `res.upgrade()` based on a 1006 reproducer that turned out to be the same root cause 0.4.12 then fixed with the `authenticate` hook - Cloudflare Tunnel (and similar edge proxies) silently closing WebSocket connections whose 101 response carries `Set-Cookie`. The cork was never the problem: 0.2.9 shipped the same `res.cork(() => res.upgrade(...))` pattern and has been running on Windows native (NSSM service, no proxy) in production for months without a single 1006. Same uWS version (v20.60.0) in both. With `authenticate` now owning the session-refresh-over-WS contract, `upgradeResponse()` with `Set-Cookie` is already discouraged and emits a build-time + runtime warning, so the proxy-strip scenario no longer rides on the cork site.

### Verification

- Full unit suite: 839/839 pass.
- Playwright e2e suite (dev + prod, browser + raw `ws` client, 25 tests): pass on Windows native against a real uWS server with the restored cork.
- Raw upgrade smoke test against the prod fixture: 3 consecutive WS upgrades, all clean close 1005, no uWS warnings, no 1006.

### Note on the prior diagnosis

The 0.4.11 CHANGELOG entry is kept as-is for historical accuracy. The real fix for the symptom it described landed one commit later in 0.4.12 (`authenticate` hook). If you were relying on `upgradeResponse({ 'set-cookie': ... })` through Cloudflare Tunnel, migrate to `authenticate`.

---

## [0.4.13] - 2026-04-17

### Fixed

- **Streaming SSR `res.write()` warning**: the multi-chunk streaming branch of `writeResponse()` wrote chunks 3+ via a bare `res.write(value)` outside of any cork, which tripped uWS's `writes must be made from within a corked callback` warning once per streamed chunk. The original comment assumed that corking each chunk would hide the backpressure signal, but `res.cork()` invokes its callback synchronously, so the boolean return value of `res.write()` inside cork still reflects the live socket state. Fixed by extracting a `writeChunkWithBackpressure()` helper that corks the write and, if backpressure builds, registers the `onWritable` drain handler inside the same cork. The backpressure semantics, 30s drain timeout, and per-chunk syscall batching are all preserved.
- **Streaming timeout `res.close()` cork**: when the 30s drain timeout fires and the adapter abruptly closes the connection to avoid sending a truncated clean EOF, the close now runs inside `res.cork()` to stay consistent with the rest of the response path and suppress any future uWS state-mutation warnings.

---

## [0.4.12] - 2026-04-16

### Added

- **`authenticate` hook**: new optional export in `hooks.ws.js`/`hooks.ws.ts` that runs as a normal HTTP POST before the WebSocket upgrade. Refreshing session cookies via `cookies.set()` here rides on a standard response and works behind every proxy - including Cloudflare Tunnel, which silently closes WebSocket connections whose 101 response carries `Set-Cookie` (symptom: `open` fires server-side, then close code 1006 before any frames). The hook receives the SvelteKit-shaped event `{ request, headers, cookies, url, remoteAddress, getClientAddress, platform }`. Return `undefined` for an implicit 204 (recommended), `false` for 401, or a `Response` for full control. Only mounted when exported - zero runtime cost otherwise.
- **`connect({ auth })` client option**: opt-in preflight that POSTs to the adapter's `authenticate` endpoint (`/__ws/auth` by default) before opening every WebSocket, including reconnects. Concurrent connects share a single in-flight fetch. 4xx responses are terminal (user is not authenticated); 5xx and network errors fall back to normal reconnect backoff. Accepts `true` (default path) or a custom string. Off by default.
- **`websocket.authPath` adapter option**: override the default `/__ws/auth` endpoint path for deployments where the default collides (e.g. Cloudflare Access allowlisting). Must differ from `websocket.path`.
- **Build-time Cloudflare footgun warning**: the adapter now statically scans the bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })` usage and emits a loud `builder.log.warn` at build time pointing at the `authenticate` hook migration. No false positives for non-cookie headers. Safe to ignore if you do not deploy behind strict edge proxies.
- **Runtime warning**: the production handler also logs a one-shot `console.warn` the first time `upgradeResponse()` is invoked with a `Set-Cookie` header, covering cases where the header name is built dynamically and static analysis cannot see it.

### Changed

- `upgradeResponse()` JSDoc now documents the Cloudflare/proxy incompatibility and points at `authenticate`. The helper remains fully supported for non-cookie response headers on the 101.

### Compatibility

Fully backwards compatible. No existing user code changes behavior:

- The new `authenticate` export is opt-in and only mounts an endpoint when present.
- `connect({ auth })` defaults to `false`. Existing `connect()` calls are unchanged.
- `upgradeResponse(..., { 'set-cookie': ... })` keeps working on infrastructure that accepts it; users see a build log + one-time runtime log nudging them toward `authenticate`.

---

## [0.4.11] - 2026-04-16

### Fixed

- **WebSocket upgrade on Windows**: `res.cork()` wrapping `res.upgrade()` produced a malformed 101 Switching Protocols response on Windows, causing the browser to never receive the upgrade response (TCP FIN, close code 1006). The server-side `open` handler fired normally, but the 101 bytes were never flushed to the client. Removed the cork wrapper from both the synchronous (no upgrade handler) and asynchronous (user upgrade handler) paths in the production runtime and the test harness. No performance impact - `res.writeHeader()` accumulates headers on the response object and `res.upgrade()` flushes them in a single syscall regardless of cork.

---

## [0.4.10] - 2026-04-11

### Added

- **Upgrade response headers**: the `upgrade()` hook can now return response headers on the 101 Switching Protocols response (e.g. `Set-Cookie` for session refresh) via the new `upgradeResponse()` helper from `svelte-adapter-uws/upgrade-response`. Fully backward-compatible with existing handlers. Dev mode logs a warning since the `ws` library does not support custom 101 headers.
- **Dynamic SSR compression**: single-chunk SSR responses are now compressed on the fly with brotli (quality 4) or gzip (level 6). Only applied to text content types above 1 KB when the client supports it. Static files continue to use build-time precompression. Multi-chunk streaming responses are uncompressed.
- **Test harness**: new `svelte-adapter-uws/testing` entry point with `createTestServer()` for integration-testing WebSocket handlers against a real uWS server on a random port. Supports the full subscribe/unsubscribe protocol, upgrade/open/message/close hooks, and Platform API. 17 tests included.
- **Startup timing**: the server now logs timing for static file indexing, SvelteKit server initialization, and total startup time.

---

## [0.4.9] - 2026-04-10

### Documentation

- **Clustering**: documented health monitoring behavior (10s heartbeat, 30s timeout, exponential backoff restart policy with 50-attempt cap) and the microtask-batched IPC relay used by `platform.publish()` across workers. Clarified that `platform.sendTo()` is local-only with no cross-worker relay.
- **WebSocket handler**: new "Message protocol" section explaining the byte-prefix discriminator that skips `JSON.parse` for user messages. New "Topic validation" section documenting enforcement rules (1-256 chars, no control characters, 256-topic batch cap) and the `__` prefix reservation for plugins.
- **WebSocket options**: new "Backpressure and connection limits" section explaining `maxPayloadLength` (connection closed on exceed), `maxBackpressure` (silent drop on overflow), and upgrade rate limiting (sliding window, 10K IP map cap with LRU eviction).
- **Performance**: new "Internal optimizations" section documenting request state object pooling (256 items) and the envelope prefix LRU cache (256 entries, 60s trim cycle).

---

## [0.4.7] - 2026-04-08

### Added

#### Client API

- `url` option in `ConnectOptions` - connect to a remote WebSocket server by full URL instead of deriving from `window.location`. Enables cross-origin usage from mobile apps (Svelte Native, React Native), standalone clients, and any environment where the backend lives on a different origin. When `url` is set, `path` is ignored and the `window` guard is bypassed.

#### Testing

- Playwright e2e test suite (`npm run test:e2e`) - 25 tests against a real SvelteKit fixture app. Covers SSR, static files, WebSocket pub/sub, upgrade authentication, subscribe-batch, platform API (sendTo, subscribers, topic helpers, cork), and the browser client with V8 coverage collection in both dev and production modes.
- Coverage pipeline (`npm run test:coverage`) - collects V8 coverage from vitest unit tests, Playwright server processes, and the browser via Chrome DevTools Protocol.
- 62 new unit tests bringing client.js to 96% lines. Covers: once() with timeout, onDerived() lifecycle, debug mode logging, visibility reconnect, zombie detection, sendQueued overflow, maxReconnectAttempts exhaustion, throttle close codes, oversized message rejection, crud/lookup maxAge with initial data and stop/restart, cursor bulk/remove/maxAge/snapshot, groups join/leave/close lifecycle, presence join/leave/heartbeat/maxAge sweep, replay scan() lifecycle, ratelimit unban/keyBy fallbacks, throttle cancel/debounce timer paths, presence deepEqual for Set/Map/Array/circular references, cursor throttle leading-edge timer clearing.

### Fixed

- **Security**: esbuild fallback for `$env/dynamic/public` no longer leaks private environment variables. Previously the fallback mapped all dynamic `$env` imports to `process.env` regardless of public/private distinction. Now `$env/dynamic/public` is filtered to only include variables matching the configured `publicPrefix`.
- **Vite plugin**: `unsubscribe` hook is now wired into the dev WebSocket handler and HMR comparison. Previously, changing or adding an `unsubscribe` export in `hooks.ws` had no effect in dev mode.
- **Client**: `ready()` resolves immediately during SSR regardless of singleton state. Previously it could hang forever if `on()` or `connect()` had already created a singleton on the server. In native app environments (no `window` but an explicit `url`), `ready()` correctly waits for the connection to open instead of short-circuiting.
- **Adapter**: esbuild fallback now passes the full `kit.alias` map (not just `$lib`) so custom alias imports in `hooks.ws` resolve correctly.
- **Handler**: WebSocket upgrade rate limiter resets both windows after a long idle gap (>= 2x window duration), preventing stale counts from producing false 429 rejections.
- **Presence plugin**: `select()` return value is validated - throws a clear `TypeError` if it returns a non-object (string, number, null, undefined) instead of crashing later with an unhelpful `in` operator error.
- **Security**: same-origin WebSocket check now rejects when no host header is present. Previously a missing host header was treated as "allowed", which meant a misconfigured reverse proxy that strips Host would silently bypass origin validation.
- **Handler**: `publish()`, `send()`, and `sendTo()` now normalize `undefined` data to `null` in the JSON envelope. Previously omitting data produced invalid JSON that the client silently dropped.
- **Adapter**: esbuild fallback for `$env/dynamic/public` now uses a runtime proxy over `process.env` instead of a build-time snapshot. Environment variables set after build are visible to `hooks.ws` code.
- **Replay plugin**: buffered payloads are now snapshot on publish via `structuredClone`. Previously payloads were stored by reference, so mutating the original object after publish would corrupt replayed messages.
- **Startup**: `PORT`, `SHUTDOWN_TIMEOUT`, and `SHUTDOWN_DELAY_MS` are validated at startup. Invalid values (non-numeric strings, negative numbers) now fail fast with a clear error instead of silently degrading to `NaN` or `0`.
- **Vite plugin**: `getRemoteAddress()` now returns correct 16-byte binary format for IPv6 addresses in dev mode, matching uWS production behavior.

---

## [0.4.6] - 2026-04-03

### Added

- Re-export `WebSocket` type from `index.d.ts` so downstream libraries can reference it without importing `uWebSockets.js` directly.

---

## [0.4.5] - 2026-04-01

### Fixed

- Vite plugin no longer crashes when the `ws` package is not installed. The top-level `import { WebSocketServer } from 'ws'` is replaced with a lazy `await import('ws')` inside `configureServer()`. When `ws` is missing, a warning is logged and WebSocket features are disabled in dev mode.

---

## [0.4.4] - 2026-03-20

### Removed

- Cursor client interpolation (added in 0.4.2, fixed in 0.4.3) - removed entirely because lerp-based smoothing adds visible latency without benefit when cursor updates already arrive near display refresh rate.

---

## [0.4.3] - 2026-03-20

### Fixed

- Cursor interpolation freeze during rapid movement. Each server update now immediately moves the cursor 50% toward the target instead of deferring all movement to the rAF loop. Lerp factor bumped from 0.3 to 0.5.

---

## [0.4.2] - 2026-03-20

### Added

#### Cursor Plugin

- `interpolate` option in `cursor()` - enables smooth rAF-driven lerp rendering (30% per frame). Numeric `x`/`y` data is interpolated; non-numeric data falls back to direct assignment. Snapshot, bulk, and remove events snap immediately.

---

## [0.4.1] - 2026-03-20

### Fixed

- `unsubscribe` added to `knownWsExports` in the server handler, suppressing a false "unknown export" warning when WebSocket hooks include an `unsubscribe` function.

---

## [0.4.0] - 2025-03-18

### Breaking Changes

#### Client

- **`ready()` now rejects on permanent close.** Previously returned a `Promise<void>` that only resolved (could hang forever). Now rejects with an error on terminal close codes (1008, 4401, 4403), retries exhausted, or `close()` called. Resolves immediately during SSR. **Action:** add try/catch around any `await ready()` call.
- **Resubscription on reconnect uses `subscribe-batch`.** Previously sent individual `{ type: 'subscribe', topic }` messages per topic. Now sends `{ type: 'subscribe-batch', topics: [...] }` batched to <8KB / 256 topics. **Action:** server must be updated to 0.4.0+ to handle batch resubscribes.
- **Reconnect jitter algorithm changed.** Old: additive `base + random(0-1000ms)`. New: proportional `base +/- 25%`. Observable timing difference but not an API change.

#### Server Runtime

- **`remoteAddress` auto-injected into `userData`.** Previously `userData` was exactly what `upgrade()` returned (or `{}`). Now `remoteAddress` is always present. Code iterating `userData` keys or checking for emptiness will see this.
- **`__subscriptions` Set injected into `userData`.** Used internally to track per-connection subscriptions. If your code uses a `__subscriptions` key in userData, it will be overwritten.
- **`publish()` return value changed in clustered mode.** Returns `true` when the cross-worker relay fires, even if the local worker has no subscribers.
- **Upgrade rate limiter changed.** Fixed-window -> sliding-window estimator. Threshold comparison changed from `> limit` to `>= limit` (triggers one request sooner). Now keyed on resolved client IP instead of raw socket IP.
- **ETag generation changed.** From `W/"<sha256>"` (crypto-based) to `W/"<mtimeMs>-<size>"` (filesystem metadata). All client-cached ETags are invalidated on upgrade.
- **Graceful shutdown sends close code 1001** to WebSocket connections so clients know to reconnect.

#### Replay Plugin

- **`replay()` wire format changed.** The `end` event data changed from `null` to `{ reqId }` or `{ reqId, truncated: true }`.
- **`onReplay()` return type changed.** Now `TopicStore<WSEvent<T> | TruncatedEvent>`. Store can emit `{ event: 'truncated', data: null }`.

### Added

#### Client API

- `onDerived(topicFn, store)` - reactive derived topic subscription that auto-switches when the source store changes.
- Terminal close code handling - codes 1008, 4401, 4403 stop reconnection. Code 4429 jumps ahead in backoff.
- Page visibility reconnect - instant reconnect when a tab resumes from background.
- Zombie connection detection - 30s interval force-closes connections silent for 150s.
- `crud()` / `lookup()` data validation - guards against `null`/non-object payloads.

#### Platform API

- `platform.batch(messages)` - publish multiple messages in one call, returns `boolean[]`.
- `unsubscribe` hook - called when a client's topic ref count reaches zero.
- `subscribe-batch` server support - handles batched subscriptions (up to 256 topics).

#### Static File Serving

- HTTP Range requests - `Accept-Ranges: bytes`, 206 Partial Content, 416 Range Not Satisfiable.
- `Content-Disposition: attachment` for binary download types (.zip, .exe, .dmg, .iso, etc.).
- `x-content-type-options: nosniff` header on all static files.
- `Date` header on all static file responses (cached, refreshed every 1s).
- `Vary: Accept-Encoding` on all static files.
- Precompressed variants (.br/.gz) only served if actually smaller than the original.

#### SSR

- Request deduplication - concurrent anonymous GET/HEAD requests for the same URL share one SvelteKit render. Skipped for authenticated requests, mutations, and `x-no-dedup: 1`.

#### Server Entry

- `SHUTDOWN_DELAY_MS` env var - configurable delay before stopping new connections during shutdown (for Kubernetes rolling updates).
- Worker heartbeat monitoring - primary sends heartbeat every 10s, terminates unresponsive workers after 30s.
- `WS_DEBUG` env var - set to `1` for per-event WebSocket logging.
- Windows path safety - rejects paths containing `:` (ADS) or `~` (8.3 short names) with 400.

#### Vite Dev Plugin

- Middleware mode warning when `server.httpServer` is null.
- HMR path collision warning when WS path collides with Vite's HMR WebSocket.
- `unsubscribe` hook now called in dev mode.

#### Plugins

- **Cursor:** `snapshot()` method, `hooks` helper (ready-made `message` + `close`), client handles bulk snapshot events.
- **Groups:** `hooks` helper (ready-made `subscribe` + `unsubscribe` + `close`).
- **Presence:** `unsubscribe` hook for single-topic leave, `updated` event with deep equality check, client handles `updated`.
- **Replay:** `reqId` support for correlating responses, `TruncatedEvent` when ring buffer was overwritten, true LRU eviction (FIFO -> LRU).
- **Queue:** proper `drain()` implementation using dedicated callback array.

### Changed (Under the Hood)

#### Performance

- Object pool for per-request `{ aborted }` state (256 slots).
- Envelope prefix cache for topic+event strings (256 entries).
- Method lookup table replaces `toUpperCase()` per request.
- Removed `node:crypto` dependency (no longer used for ETags).
- Pre-allocated body buffer for small bodies (<64KB) with known Content-Length.
- `Buffer.from(new Uint8Array(chunk))` replaces `Buffer.from(chunk.slice(0))`.
- Cached `Date.now()` and Date header (shared 1s timer).
- `decodePath()` LRU cache (256 entries).
- AbortController eliminated - replaced with `{ aborted }` flag (saves ~4-5 allocs/request).
- Conditional `getClientAddress` closure for simpler V8 inlining without proxy headers.
- Consolidated error response helpers (`send400`, `send413`, `send500`).
- Unified 60s maintenance interval (rate limiter + decode cache + envelope cache).
- Backpressure timeout calls `res.close()` instead of `res.end()`.
- Cross-worker relay batching via microtask.
- Removed duplicate `Content-Length` headers. uWS internally sets `Content-Length` on `res.end(body)`; the adapter no longer writes it manually, eliminating doubled values (e.g. `Content-Length: 11111, 11111`). HEAD responses use `endWithoutBody(size)` to report the correct entity size. SSR responses also filter `content-length` from SvelteKit headers for the same reason.

#### Client Internals

- Store entries deleted after last subscriber leaves (memory leak fix).
- Microtask cleanup for stores created but never subscribed to.
- `close()` clears activity timer, removes visibility listener.

#### Plugin Internals

- Singleton store caching with microtask cleanup across cursor, groups, presence clients.
- Groups server wraps `ws.unsubscribe()` in try/catch for already-closed connections.
- Presence server extracts `leaveTopic()` for single-topic removal, adds `deepEqual()`.
- Replay client adds `cancelled` flag, swallows `ready()` rejection.
- Queue server uses dedicated `drains` array instead of sentinel tasks.
- JSDoc fixes across middleware, queue, and ratelimit plugins.

---

## [0.3.9] and earlier

See [git history](https://github.com/lanteanio/svelte-adapter-uws/commits/main) for changes prior to 0.4.0.
