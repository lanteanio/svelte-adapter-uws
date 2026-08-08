# Contributing to svelte-adapter-uws

This is a small MIT project with one maintainer. There is no review board, no
sign-off ceremony and no response-time promise - issues and pull requests go to
the [issue tracker](https://github.com/lanteanio/svelte-adapter-uws/issues) and
one person reads them.

Choose the bug, feature, or usage-question form in that tracker so the report
arrives with the evidence needed to answer it. Security findings use the
private advisory route linked by the chooser, never a public form.

What this file is for is the part you cannot get by reading the README: how to
get from a clone to a run that actually proves something, which commands the
project treats as required, which directories own what, and the conventions a
patch gets bounced for. The README documents what the adapter does for an app;
this documents how to change it.

## Table of contents

- [Clone to green](#clone-to-green)
- [The native dependency, and how a green run can prove nothing](#the-native-dependency-and-how-a-green-run-can-prove-nothing)
- [What each command runs](#what-each-command-runs)
- [Documentation contributions](#documentation-contributions)
- [What to run before you propose a change](#what-to-run-before-you-propose-a-change)
- [Where things live](#where-things-live)
- [What moves together](#what-moves-together)
- [Review routing](#review-routing)
- [Issue lifecycle and backlog contract](#issue-lifecycle-and-backlog-contract)
- [House conventions](#house-conventions)
- [Proposing the change](#proposing-the-change)

## Clone to green

```bash
git clone https://github.com/lanteanio/svelte-adapter-uws.git
cd svelte-adapter-uws

npm run bootstrap   # root deps, the fixture's own deps, then the doctor
npm run smoke       # real HTTP health + WebSocket subscribe/publish checkpoint
npm run verify:fast # seconds - the static gates
npm run verify:pr   # the strongest local signal, but not the whole hosted gate
```

`npm run bootstrap` exists because a root install is not enough: the e2e
fixture (`test/fixture/`) is a separate SvelteKit app with its own lockfile and
its own `node_modules`, several suites build it, and without it they used to
fail minutes later inside a `vite build` whose output never named the missing
install. Doing it by hand is still `npm ci` here and `npm ci` in `test/fixture`.

`npm install` works too; `npm ci` is what CI runs and is reproducible.

**There is no build step.** The package ships source: every `exports` target in
`package.json` points at a `./src/*.js` file and there is no `build` script, so
the file you edit is the file that gets published. Nothing to compile, nothing
to watch, no `dist/` to keep in step. The one thing that IS built is the test
fixture (`test/fixture/`), which is a real SvelteKit app that installs the
working-tree adapter through `file:../..`.

Node 22 or newer (`engines.node` is `>=22.0.0`). `.nvmrc` pins the exact patch
release the hosted gate runs, and both workflows read their Node version from
that file, so `nvm use` and CI resolve one line. That is the version a native
ABI question should be reproduced on; a different major is allowed, and the
doctor says so rather than blocking it. There is deliberately no second pin for
npm: a Node release bundles one, so `.nvmrc` decides it, and two baselines that
can disagree are worse than one.

## The native dependency, and how a green run can prove nothing

`uWebSockets.js` is a native C++ addon acquired from an exact **GitHub HTTPS tag
archive, not the npm registry**, and it is an **optional** dependency. npm can
omit a failed optional dependency, so this package's postinstall check imports
the addon immediately and turns a missing archive or incompatible native binary
into a failed installation with the original loader cause. That check requires
lifecycle scripts: an `ignore-scripts` package-manager setting or
`SVELTE_ADAPTER_UWS_SKIP_NATIVE_CHECK=1` leaves a client-only installation
explicitly unverified.

Check whether you actually have it, and everything else a run depends on:

```bash
npm run doctor
```

That answers whether a green run on this machine proves anything: the Node
version against `engines` and against the pinned baseline, whether the running
npm can write the committed lockfile format, whether your Node ABI, OS, CPU and
libc have a prebuilt binary at all, the root and fixture installs, whether a
loopback listener can bind, and whether Playwright's browser is present. `npm
run doctor -- --require-uws` makes a missing addon a failure instead of a
warning.

Force the honest result - absence becomes a hard failure instead of a skip:

```bash
REQUIRE_UWS=1 npm test
```

`CI=true` implies the same thing, which is why the hosted gate cannot go green
without the addon. If you are contributing anything that touches the runtime,
run with `REQUIRE_UWS=1` at least once before you propose it.

If it will not load:

- Linux requires x64 or arm64 and glibc >= 2.38. Alpine/musl and
  Bookworm-based images are unsupported. There is no source build fallback, so
  `build-essential` does not repair an unsupported binary target.
- Windows requires x64; no Windows arm64 binary is published. Installing the
  Visual C++ Build Tools does not create one.
- The supported Node majors are the ABIs with published binaries in the pinned
  archive, currently Node 22, 24 and 26. `engines` alone cannot guarantee an ABI
  binary exists.
- The exact HTTPS archive lives in `optionalDependencies` in `package.json`.
  Every generated install command and runtime recovery hint is derived from
  that pin, so no Git client or SSH credential is required.

Without the addon you can still work on the client, the plugins' pure logic,
the simulator and anything in `src/runtime/utils/**` - the pure suites run
normally. Set `SVELTE_ADAPTER_UWS_SKIP_NATIVE_CHECK=1` only for that intentional
client-only case. You cannot verify a runtime behaviour claim.

## What each command runs

| Command | What it actually does |
|---|---|
| `npm run bootstrap` | Root dependencies, the fixture's own dependencies, then the doctor. What a fresh clone needs. |
| `npm run doctor` | Whether this machine can prove anything. `-- --require-uws` makes a missing native addon fatal. |
| `npm run smoke` | Starts a real uWS loopback server, checks `/healthz`, completes a WebSocket subscribe/publish exchange, prints resolved adapter/native/Node versions, and tears down. The hosted suite runs this same command. |
| `npm run check:publish` | Packs the package through `publint` and `attw --profile esm-only` so export-map and type-resolution failures are caught before release. The hosted suite runs this command. |
| `npm run check` | Dependency-free static and generated-parity gates, described below. Seconds, no network, no fixture. |
| `npm run check:links` | Every `](#anchor)` in the shipped docs names a heading that exists, and every relative file link names a file that exists. External links are not fetched. |
| `npm test` | `pretest` runs `npm run check`, then `vitest run` over `test/**/*.test.js`. Excludes `test/e2e/**` and `test/fixture/**`. |
| `npm run verify:fast` | `npm run check`, named as a lane. |
| `npm run verify:suite` | The doctor with `--require-uws`, real HTTP/WebSocket smoke, packed publishing checks, then `npm test` under `REQUIRE_UWS=1`. What the suite job runs, verbatim. |
| `npm run verify:sim` | The seed swarm and the golden corpus. No workflow runs this, so you are the only person who will. |
| `npm run verify:pr` | `verify:suite` and `verify:sim`. The strongest single local signal, but not the hosted gate - see the job list below for the four jobs it does not cover. |
| `npm run verify:docs` | The documentation gates plus the eleven suites that execute and route documented examples. Use this for a docs-only change. |
| `npm run drill:respawner` | The external-respawner drill. What the respawner-drill job runs, verbatim. |
| `npm run drill:operations` | The operations-pack gate, as a named lane. |
| `npm run verify:full` | `verify:pr` plus the Playwright run, which no workflow runs. |
| `npm run test:watch` | The same vitest run, watching. |
| `npm run test:e2e` | Playwright, two projects: `dev` (`vite dev` plus the Vite plugin) and `prod` (`vite build` plus the built server through real uWS). Needs extra setup, see below. |
| `npm run test:coverage` | vitest with coverage, then Playwright under `NODE_V8_COVERAGE`, then a `c8` report over the server and browser sources. A superset of the two above, so it needs their setup too. |
| `npm run sim:swarm` | Deterministic simulation: many seeded interleavings of the in-memory server under the fault engine. Exits non-zero on any invariant violation, fatal, or determinism regression. |
| `npm run sim:golden` | Re-runs the committed golden corpus (`test/dst-goldens/`) and fails when a fingerprint drifted from its blessed baseline. |
| `node bench/<file>.mjs` | The benchmark harness. Files ending `-ab.mjs` are before/after comparisons for a single hot path. |
| `node scripts/generate-api-docs.js` | Rebuild bounded README API-reference regions from their canonical declaration JSDoc. Edit `src/index.d.ts`, never the generated README body. |

The gates in `npm run check`, each of which answers exactly one question
and has no config:

- **check-compatibility** - the versioned compatibility manifest owns install
  commands and the adapter/extensions/realtime version matrix; generated README
  and migration blocks must match it exactly.
- **check-formatting** - every tracked file matches what `.editorconfig`
  declares for it: indent style, final newline, trailing whitespace, and the
  committed line ending. It reports and refuses; it never rewrites.
- **check-contributor-map** - this file's three inventories are derived from
  their real sources: every gate below runs in `npm run check`, every hosted
  job is named, and every `npm run` lane it sends you to exists. It is why the
  map can be relied on rather than merely written carefully.
- **check-svelte-support** - the published Svelte support row is generated from
  the locked Svelte 4 fixture's own metadata, so the claim and the tested tuple
  cannot disagree.
- **generate-error-reference --check** - every emitted diagnostic has a stable
  id and a `docs/errors.md` entry naming cause, consequence, recovery and next
  action, generated from the owning registry.
- **check-migration-freshness** - the migration guide carries a digest of the
  public surface it describes. Change a declaration, review what moved, then
  re-pin with `npm run check:migration -- --write`.
- **check-release-notes** - the newest changelog entry is action-first and
  bounded, and its release page and routes exist.
- **check-release-workflow** - the tag-only trusted-publishing path is
  structurally closed: closed key inventories at workflow, job and step level,
  full-commit action pins, and exact command bodies.
- **check-doc-code** - every README fence is classified, and every fence
  claiming to be runnable is executed against the packed tarball.
- **check-documentation-contract** - reader paths, ownership and the README
  line budget hold.
- **check-operations-pack** - the versioned operations corpus is complete and
  its local links resolve.
- **check-capacity-kit** - the capacity kit's phases and launch gates are
  present and internally consistent.
- **generate-privacy-integration --check** - the documented processing
  activities match the generated privacy docs.
- **check-entry-points** - every public export has an owned README route.
- **check-diagnostic-attribution** - every diagnostic is attributed to a
  canonical area rather than an ad-hoc string.
- **check-related-projects** - the related-projects snapshot and its import
  path are valid.
- **generate-api-docs --check** - every bounded public API block in README is
  byte-generated from the matching `API_DOC` JSDoc in the public declaration.
  Change the declaration, then run `node scripts/generate-api-docs.js`; a manual
  README edit is overwritten and fails the ordinary gate.
- **generate-observability --check** - public observability prose, reference
  queries, and literal declaration types match the runtime signal manifest.
- **check-types** - every `exports` target exists, every `types` condition is a
  real `.d.ts`, every target is covered by the `files` publish allowlist, and
  every named runtime export has a matching declaration. This is what catches
  "resolves locally, 404s after publish" and "silently degraded to `any`".
- **check-determinism** - framework source under `src/` reads the clock, RNG and
  timers through `src/runtime/runtime.js` rather than the native primitives. A
  raw call under `src/` fails. The two runtime seam modules are the binding
  point and are exempt by name; `src/vite.js` is the one exempted file, because
  the dev server is never replayed.
- **check-slugs** - every `svti.me/<slug>` short link referenced from `src/`,
  `README.md` or `MIGRATION.md` is registered in `scripts/known-slugs.txt`.
- **check-uws-pin** - every copy-pasteable uWebSockets.js HTTPS tag archive in
  a tracked file names the tag `optionalDependencies` pins, so no document hands
  a reader a version the tree is not tested against. Legacy Git specs remain
  detectable during migration. Prose about a past version is not matched,
  `CHANGELOG.md` is skipped, and a lockfile is reported rather than enforced.
- **check-uws-binaries** - the installed native addon is the tree this
  repository accepted: the exact archive URL, npm lockfile integrity, upstream
  source commit, and a SHA-256 per shipped file. A retagged archive has different
  integrity even when its version string is unchanged. Without the addon
  installed it prints a visible SKIP and passes; under `REQUIRE_UWS=1` or `CI`
  the skip is a failure. Re-accept a deliberate pin bump with
  `node scripts/check-uws-binaries.js --update` and review the diff - it is the
  record of which binaries changed.
- **check-links** - every owned Markdown link and anchor resolves, a link in
  a packaged document cannot point at a repository-only file missing from the
  npm tarball, and a same-repo GitHub source URL is validated against the
  tree its ref names: `blob/main` against the checked-in published-main file
  list (`docs/main-source-tree.v1.json`, regenerated after a stable
  promotion with `node scripts/check-links.js --write-main-tree`),
  `blob/dev` against the staged git index - so a link that 404s on GitHub
  today cannot report green from a file that only exists locally.
- **check-scope** - every identifier a tracked source file reads resolves to
  something: a declaration, an import, or a declared global. Catches the name
  that parses fine and throws only when the line runs.
- **check-syntax** - every tracked `.js`/`.mjs` parses as a native ES module,
  not merely under vitest's transform pipeline.

Consequential copy is gated too. `test/copy-prerequisites.test.js` inspects the
onboarding, transport-security, and dedup decision surfaces for absolute words.
Put the prerequisite in the same bullet or paragraph as the assurance: WSS is
TLS transport, not authentication or topic authorization; retry suppression is
bounded by process, window, capacity, and caller-supplied identity. Moving the
condition to a later limitations section does not satisfy the gate.

## Documentation contributions

The package repository and the documentation site have different canonical
jobs. This README owns package identity, installation, support status, and
versioned companion routes. Versioned migration guides, `PROTOCOL.md`, the
schema/vectors, and `CHANGELOG.md` remain normative in this repository. The
[svelte-realtime-docs source](https://github.com/lanteanio/svelte-realtime-docs)
owns the long-form ecosystem tutorial, how-to, reference, explanation, and
operations quadrants rendered at `svelte-realtime.dev`.

Do not repair drift by maintaining the same fact twice. Change the canonical
package declaration, manifest, vector, or guide first; regenerate bounded
README regions from that source. A site page should link or import the owned
fact where its build supports that, and otherwise its pull request must name
the package source and exact package head it synchronized from. Runnable
snippets live in fixtures/tests; prose fences that are fragments must not be
presented as copy-paste programs.

The README reader-path table is generated from `docs/documentation.v1.json`.
Edit that manifest when a package or site route changes, then run
`node scripts/check-documentation-contract.js --write` and
`npm run check:documentation`. The normal check also rejects an entry surface
that exceeds its line budget or a native-version fact copied outside the
generated compatibility block.

Every README fence is classified in `docs/code-blocks.v1.json`. Standalone
JavaScript, TypeScript, Svelte, JSON, and YAML blocks compile in the normal
check; intentional fragments, manual commands, configuration, and output have
separate visible coverage channels. After changing a fence, review its role and
run `node scripts/check-doc-code.js --write`, then run `npm run check:docs-code`.
The writer updates only the manifest under `docs/`; it does not create scratch
files in the repository root.

For an adapter documentation change:

1. Edit the canonical source and any generated output named by its marker.
2. Run `npm run verify:docs`. It checks GitHub-compatible anchors and paths,
   packaged destinations, entry-point/API generation (each catalog entry's
   stability drawn from supported | experimental | deprecated, its guide anchor
   resolving to the README section that documents that entry's specifier, and a
   README home for every public `svelte-adapter-uws/sim` export), classified
   and compiled README fences, runnable packed README snippets, versioned
   migration routes/rehearsal, and compatibility imports.
3. If the site mirrors or explains the changed fact, make the sibling
   `svelte-realtime-docs` change from its own checkout. Use `npm run dev` for
   preview and `npm run verify` for its acceptance gate.
4. Report both repository heads and every command run. An adapter-only green
   result is not evidence that the site copy is current.

The external URL crawl is deliberately not part of the pull-request lane:
`.github/workflows/docs-links.yml` runs it weekly and on demand so remote
uptime cannot make local documentation nondeterministic.

Notes on the slow parts:

- With the native addon installed, `npm test` builds the fixture variants
  declared in `test/fixture/variants.js` once, serially, before any worker
  starts. On a cold tree that is one `vite build` per variant and it dominates
  the wall time. A filtered run (`npx vitest run test/utils.test.js`) pre-builds
  only the variants those files need, so single-file iteration stays fast.
- First-time e2e setup, on top of the fixture install:
  ```bash
  npx playwright install chromium
  ```
- The `prod` e2e project boots the built server through uWS, so it needs the
  native addon. The `dev` project does not.

## What to run before you propose a change

The hosted gate is five jobs. `npm run verify:suite` is the only one you can
reproduce verbatim: it runs on Ubuntu **and** Windows as that same command, not
a re-spelling of it, so for that lane "it passed locally" and "CI is green"
cannot drift into meaning different things. `npm run verify:pr` adds
`npm run verify:sim` on top of it, which makes it the strongest single local
signal - but it is not the hosted gate, because `verify:sim` is not hosted at
all and four of the five hosted jobs are absent from it. The full inventory is
below, and it is worth reading before you treat a green `verify:pr` as a green
pull request.

### Lane duration and exception map

These duration classes are planning guidance, not benchmark claims: dependency
download, native compilation, fixture cache state, browser installation, and
machine load dominate wall time. Record the actual commands and gaps in the
pull request instead of treating a duration as proof.

| Lane | Typical duration | Required setup | Scope and exception |
|---|---|---|---|
| `npm run bootstrap` | First-run minutes; warm installs are shorter | Network, plus the root and fixture lockfiles. No compiler: the native addon is a pinned prebuilt archive with no source-build fallback | Run once per clone or dependency change; it prepares proof but is not itself a test result. |
| `npm run verify:fast` | Seconds | Installed root dependencies | Static/generated/document gates only; appropriate for iteration, never a substitute for a runtime lane. |
| `npm run verify:suite` | Minutes; cold fixture builds dominate | Native uWS must load; fixture dependencies installed | Required for source/runtime changes. A missing addon is a failure, not an accepted skip. |
| `npm run verify:sim` | Minutes | Root dependencies; no browser | Required when behavior can change scheduling, delivery, recovery, or invariants; deterministic seeds are the reproducer. |
| `npm run verify:pr` | Sum of suite and simulation lanes | Everything required by both lanes | Normal pre-PR default and the strongest single local signal, but NOT the hosted gate: `verify:sim` is not hosted and four hosted jobs are absent from it. A platform you cannot run must be named as a gap. |
| `npm run test:e2e` | Minutes after browser setup | Chromium, fixture dependencies, and native uWS for production | Required for socket-reachable or browser-client behavior; not hosted, so omission must be explicit. |
| `npm run test:coverage` | Longest local lane | Unit, browser, fixture, and native prerequisites | Coverage work only; it does not replace the change-specific real-runtime, simulation, or benchmark evidence. |

The test workflow runs five jobs, and only one of them has an exact local
equivalent:

- **suite** runs `npm run verify:suite`, verbatim. This is the lane you can
  reproduce exactly.
- **respawner-drill** runs `npm run drill:respawner`, the external-respawner
  drill. It has a local lane, but it is not part of `verify:pr`.
- **observability-rules** runs `promtool` over
  `examples/observability/rule-tests.v1.yml` inside a digest-pinned container.
  It has no local lane because it asks a question about the alert rules, not
  about your machine, and it needs Docker rather than your source tree.
- **audit** reads both lockfiles and fails on a high advisory in the SHIPPED
  dependency tree, while reporting the development tree without blocking.
- **floor** installs `svelte@4.0.0` and `ws@8.0.0` exactly - the floor of the
  published peer range, which every other lane resolves past - and runs the
  suites that load the browser client. It then installs the locked Svelte 4
  application under `test/fixtures/svelte4` with `npm ci --install-links` and
  runs its preflight, `check`, `build` and `smoke`, so a break in the oldest
  supported profile or in the published bin surfaces here.

**`npm run verify:pr` is not the hosted gate.** It is `verify:suite` plus
`verify:sim`, which makes it the strongest single local signal - but
`verify:sim` is not hosted at all, and the respawner drill, the promtool rules,
the advisory audit and the support-floor job are not in it. A green
`verify:pr` followed by a red CI is therefore a normal outcome rather than a
surprise; the failing job name tells you which of the five above to run.

**`npm run test:e2e` and `npm run test:coverage` are not hosted either**, so if
your change is covered by them you are the only person who will ever run them.
`npm run verify:full` is the only command that includes the e2e run.

| You changed | Run |
|---|---|
| Anything under `src/`, `test/`, `scripts/`, `examples/`, or the manifests | `npm test` (with `REQUIRE_UWS=1`), `npm run sim:swarm`, `npm run sim:golden` |
| Runtime behaviour reachable over a socket (`src/runtime/**`, `src/vite.js`, `src/testing.js`) | the above, plus `npm run test:e2e` |
| The browser client (`src/client.js`, a plugin's `client.js`) | the above, plus `npm run test:e2e` (it drives the real client in Chromium) |
| The wire format | the above, plus `test/protocol-schema.test.js`, and see [What moves together](#what-moves-together) |
| A per-request, per-message or per-render hot path | the above, plus the matching `bench/*-ab.mjs`, before and after. Quote the numbers. |
| Only Markdown | `npm run verify:docs` - the documentation gates plus the suites that execute and route documented examples. It is a superset of what `check:links` and `check` would tell you here. Every `**/*.md` path triggers the test workflow, so a docs-only change is gated like any other |

If you cannot run one of these - no native addon, no browser, no Windows box -
say so in the pull request. An unstated gap reads as a pass.

A failing simulation seed is the whole reproducer: `runSim({ seed: '<n>' })`
replays that exact interleaving bit-for-bit.

## Where things live

| Path | What it owns |
|---|---|
| `src/index.js` | The build-time adapter: option validation, the SvelteKit `adapt()` hook, the Rollup bundling of the app's WebSocket handler, and the placeholder replace map that bakes build-time options into the copied runtime. |
| `src/runtime/**` | Everything copied into the app's build output and executed under uWS in production. `handler.js` plus `handler/**` (request path, WebSocket path, platform API, config), `utils/**` (shared pure helpers), `wire*.js` (the frame codec), `runtime.js` (the clock/RNG/timer seam), `sim-*.js` (the in-memory app the simulator drives). |
| `src/vite.js` | The dev-server surface. Speaks the same wire over the `ws` library. |
| `src/testing.js` | The published in-process test server (`svelte-adapter-uws/testing`). |
| `src/sim.js` | The deterministic simulator (`svelte-adapter-uws/sim`) and the leak harness. |
| `src/client.js`, `src/client-runtime.js` | The browser client and its own injectable runtime seam. |
| `src/plugins/<name>/` | One opt-in plugin: `server.js` plus, where it has a browser half, `client.js`, each with its `.d.ts`. `_shared/` holds what more than one plugin needs. |
| `test/` | Unit and integration suites, one file per subject. |
| `test/helpers/real-runtime.js` | Boots the REAL built runtime out of the fixture and drives it over real sockets. Anything asserting a runtime security decision belongs here. |
| `test/fixture/` | The SvelteKit app the real-runtime and e2e suites build. `variants.js` declares each build-time configuration and its output directory. |
| `test/e2e/` | Playwright specs and the dev/prod server launchers. |
| `test/dst-goldens/` | The blessed simulation fingerprint corpus. Generated, committed, and reviewed as a diff. |
| `test-vectors/` | Machine-checkable protocol vectors, validated against `protocol.schema.json`. |
| `scripts/` | The static gates, the two simulation runners, the doctor, the bootstrap and the verify lanes. Deliberately outside the determinism seam, so they may read the clock and the environment. |
| `bench/` | Benchmarks. `run.mjs` and `run-compare.mjs` are the suites; `*-ab.mjs` files are single-question before/after comparisons. |

## What moves together

These are the propagation rules that are not obvious from the tree, and they are
where a small patch turns into a bounced one.

**Four surfaces speak one wire.** The uWS production runtime, the Vite dev
server, the published test server and the simulator all implement the same
protocol, and they are supposed to make the *same* decision in every
configuration. A behaviour added to one and not the others is the most common
defect class this project has had. So: put the decision in the shared module -
`src/runtime/utils/subscribe-policy.js` and `src/runtime/utils/ws-symbols.js`
are where those predicates live - and call it from each surface rather than
re-spelling it. Two suites exist purely to catch divergence:
`test/surface-policy-parity.test.js` resolves each surface's calls through the
AST and the import binding, and `test/surface-differential.test.js` runs the
same scenarios on every surface and compares the answers to each other.

**A new or changed adapter option.** Validate and normalize it in
`src/index.js`, add it to the placeholder replace map there if the runtime needs
it at module-eval time, read it in `src/runtime/handler/config.js`, declare it
in `src/index.d.ts`, and - if dev is supposed to honour it - wire it in
`src/vite.js` (it keeps an explicit `KNOWN_PLUGIN_OPTION_KEYS` set on purpose,
so an unwired option is rejected rather than silently ignored) and declare it in
`src/vite.d.ts`. A default that gets more permissive is a breaking change; say
so in the changelog entry.

**A new export.** Implementation, a `.d.ts` beside it, an `exports` entry in
`package.json`, and coverage by the `files` allowlist. `check-types` enforces
all four legs, including "the runtime exports this name but the declaration does
not", so this one fails loudly rather than needing archaeology.

**A wire change.** `PROTOCOL.md` is the canonical document and revision 1 is
frozen: within 0.6.x the frame shapes, the envelope, the binary layout and the
capability-token mechanics evolve **additively** only. A wire change means
`PROTOCOL.md`, `protocol.schema.json`, a vector in `test-vectors/`, and the
codec on every surface that encodes or decodes it. `test/protocol-schema.test.js`
validates the vectors against the schema with a dependency-free validator, so
the spec cannot drift from the shipped wire.

**A simulation behaviour change.** The swarm only proves each seed reproduces
*itself*, so a deterministic behaviour change sails through it. The golden gate
is what catches it. If the change is intended, re-bless and commit the diff -
that diff is the reviewable record of exactly what moved:

```bash
npm run sim:golden -- --update
```

**A new plugin.** A directory under `src/plugins/`, `server.js` plus its
`.d.ts`, a `client.js` pair if it has a browser half, an `exports` entry per
published subpath, and `test/<name>.test.js`. Plugins are opt-in and must cost
nothing when unused. Their internal topics are `__`-prefixed, which the wire
system-topic guard refuses outright unless the namespace is registered as
plugin-owned - and a registered namespace is only safe because the subscribe
landing re-tests real membership behind it. Do not copy that carve-out into a
lane that has no landing re-check.

## Review routing

`.github/CODEOWNERS` requests the maintainer on every path and keeps the
highest-risk families explicit. This table says what a review of each family
looks *for*; ownership is not permission to omit a leg.

It deliberately does not repeat which companion surfaces move with a change -
[What moves together](#what-moves-together) above owns that, in the detail a
contributor actually needs, and this file's own rule is not to maintain the
same fact twice.

| Change family | Primary paths | Review focus |
|---|---|---|
| Adapter/build option | `src/index.js`, `src/vite.js` | Production/dev parity, placeholder propagation, default compatibility |
| Runtime behavior | `src/runtime/**` | Authorization, lifecycle, backpressure, deterministic seams |
| Wire or protocol | `src/runtime/wire*.js`, client/plugin codecs | Additive revision-1 compatibility and byte-exact evidence |
| Public export/type | implementation and adjacent `.d.ts` | Packed resolution, runtime/type parity, environment boundary |
| Plugin | `src/plugins/<name>/**` | Opt-in cost, namespace authorization, mixed-client fallback |
| Documentation/generator | canonical declaration, manifest, or Markdown owner | One source of truth, packed destinations, durable routes |
| CI, dependency, release, or security | `.github/**`, lockfiles, release/security documents | Least privilege, provenance, reproducibility, disclosure safety |

## Issue lifecycle and backlog contract

The issue forms collect the evidence a first review needs. The labels below are
the public state machine; a maintainer may apply them manually until repository
automation exists.

### Definition of Ready

An issue is `status:ready` only when:

- the observed problem and desired outcome are stated in user-visible terms;
- the owning repository and affected surfaces are known, with sibling work and
  external dependencies linked;
- acceptance criteria and a verification plan name the real test level needed;
- severity, confidence, compatibility risk, and cost of delay are recorded;
- the work is not waiting on a product decision or inaccessible evidence; and
- security-sensitive evidence has moved to the private route in
  `SECURITY.md`.

Needs-information issues stay `status:needs-info`; they are not counted as
ready work.

### Priority and work in progress

Order ready work by risk and cost of delay: exploitable security or data-loss
defects first, then release blockers and regressions, then confirmed correctness
bugs, then compatibility and operational work, then documentation and
convenience. Within one class, prefer high-confidence fixes and the smallest
change that retires the most risk; record the rationale when an item jumps the
queue.

Own one implementation issue at a time unless a maintainer has coordinated
non-overlapping files with you. Review-only work does not count. This is
advice about how to get a change merged rather than a quota anyone polices.

### Blocked and stale work

Use `status:blocked` only for a concrete dependency, decision, permission, or
external-state wait. The latest comment names the blocker, who or what can clear
it, useful work already exhausted, and the next review date. A difficult task
with an available next step is not blocked.

A backlog review revalidates old facts, merges duplicates, closes work whose
premise disappeared, refreshes blocked items, and promotes only items that meet
Ready. An item that receives no new evidence across two such reviews may be
closed as stale with a reopening condition. There is no promised interval: this
file opens by saying the project makes no response-time promise, and a public
cadence with nothing automating it would be one.

### Merge criteria

Work is `status:in-review` after implementation and verification. It merges
only when:

- every acceptance criterion is met and no material known delta is hidden;
- a regression test was observed failing without the fix and passing with it;
- the required static, unit, real-runtime, simulation, browser, platform, and
  benchmark lanes are green or an explicit reviewer accepts a named gap;
- public docs, declarations, schema, vectors, generated files and lockfiles
  agree with the implementation;
- user-visible behavior has a SemVer-appropriate version and changelog entry;
- someone other than the author has checked the evidence and risk - on a
  project this size that is normally the maintainer, not a separate reviewer
  you need to find; and
- the maintainer has accepted the change for merge.

### Good first issues

The `good first issue` label is curated, not a synonym for low priority. Use
it only when the reproduction is complete, the expected files and test command
are named, no security/wire/concurrency design decision remains, and the change
fits one small review. Remove the label if investigation expands the scope.
An empty label is a valid state, not a backlog gap: the maintainer applies it
only when such an issue genuinely exists, and the project does not maintain a
standing starter queue. A newcomer who finds none labeled should start from
the issue forms above instead of waiting for one.

## House conventions

**Formatting.** Tabs. Match the surrounding file - its comment density, its
naming idiom, its bracket style. There is no repo formatter and there will not
be one: the tree is hand-laid and a whole-tree reflow would destroy `git blame`
on files whose comments are load-bearing.

What does exist is a non-destructive conformance check. `.editorconfig` is the
source of truth for indent style, final newline, trailing whitespace and
committed line endings, and `npm run check` runs `check-formatting`, which
parses that file and holds every tracked file to what it declares. It never
rewrites anything - it reports and fails. So an editor honouring `.editorconfig`
and the gate agree by construction, which is the part that was missing: the
declaration previously said two-space JSON while `package.json` and both
`--write` generators used tabs, and nothing could see the contradiction.

**Typography in source and docs.** ASCII hyphens, straight quotes, three dots
for an ellipsis. No em dashes, no en dashes, no curly quotes, no ellipsis
character. This is about typographic characters only - real umlauts and accented
letters in human-language content are correct and must be preserved.

**Comments state the constraint, not the code.** The dense comment blocks in
this tree record why something is the way it is, usually because the obvious
alternative shipped a bug once. Do not delete one you have not understood, and
if you invalidate the reasoning, say in the comment why it no longer holds. Do
not address a reviewer in a comment, and do not reference an issue number, a
plan, or a release in one - a future reader has neither.

**Nondeterminism goes through the seam.** No `Date.now`, `Math.random`,
`setTimeout` or `randomUUID` directly in `src/**`. Import from
`src/runtime/runtime.js` (or `src/client-runtime.js` on the browser side) so a
seeded harness can replay behaviour exactly. `check-determinism` enforces it. A
genuinely cosmetic call can opt out with a trailing
`// determinism-allow: <reason>` comment.

**Build-time placeholder identifiers are reserved.** The adapter's `builder.copy`
step does a plain string replacement of `ENV`, `HANDLER`, `MANIFEST`, `SERVER`,
`SHIMS`, `WS_HANDLER`, `ENV_PREFIX`, `PRECOMPRESS`, `WS_ENABLED`, `WS_PATH`,
`WS_OPTIONS`, `HEALTH_CHECK_PATH` and their siblings over every file it copies,
so those exact identifiers must never be used for anything else under
`src/runtime/**`. They appear there as free identifiers declared with a
`/* global NAME */` comment, which is also what keeps `check-scope` happy.

**Tests assert what the client received.** A helper's return value, a source
string, or a mock platform's recorded call can all stay true while the
production wiring is dead - that has shipped here more than once. Assert on the
frame the client receives or on the bytes on the wire. A suite that drives
`src/testing.js` proves nothing about `src/runtime/**`, so anything asserting a
runtime security decision goes through `test/helpers/real-runtime.js`. One
fixture variant per test file: the built handler reads its environment at module
eval, so a second boot in the same file gets the first module instance back.

**A regression test must fail without the fix.** Verify that by reverting the
fix and watching it go red, and say in the pull request that you did.

**Generated and blessed files.** `package-lock.json` and
`test/fixture/package-lock.json` are tracked; commit them when a dependency
moves. `test/dst-goldens/**` is a blessed corpus with a documented re-bless
command - never hand-edit it.

**Contribution license and sign-off.** No CLA or DCO sign-off is required, and
a missing `Signed-off-by` line is not a review failure. By submitting a
contribution, you represent that you have the right to provide it under this
repository's MIT license.

**Commits.** Conventional Commits, as `git log` shows:
`fix(cluster): ...`, `feat(game): ...`, `docs(readme): ...`. Describe the defect
and the behaviour it now has. A reader a year from now has no access to
whatever tracker the change was routed through, so the message has to stand on
its own.

**Changelog.** `CHANGELOG.md` follows Keep a Changelog and the project follows
SemVer. Every shipped change gets an entry, written for someone who will read it
a year from now with no other context: what was wrong, what it now does, and what
they have to do about it. Publication, promotion, hotfix and rollback follow
[`releasing.md`](./docs/releasing.md), with immutable identities in
[`release-manifest.md`](./docs/release-manifest.md).

## Proposing the change

Open an issue first if the change is large or changes a default; for a bug fix
with a test, a pull request is fine on its own. In the description, say:

- what the defect was, in terms of observable behaviour;
- which commands you ran and on which operating system;
- whether the native addon was installed (`REQUIRE_UWS=1` or not);
- for a hot-path change, the before/after benchmark numbers;
- anything you could not run.

For a security-sensitive report, follow [`SECURITY.md`](SECURITY.md) and use
the private advisory form it names. Do not open a public issue with the
vulnerability details, exploit, secrets, or affected deployment data.
