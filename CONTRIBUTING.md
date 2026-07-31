# Contributing to svelte-adapter-uws

This is a small MIT project with one maintainer. There is no review board, no
sign-off ceremony and no response-time promise - issues and pull requests go to
the [issue tracker](https://github.com/lanteanio/svelte-adapter-uws/issues) and
one person reads them.

What this file is for is the part you cannot get by reading the README: how to
get from a clone to a run that actually proves something, which commands the
project treats as required, which directories own what, and the conventions a
patch gets bounced for. The README documents what the adapter does for an app;
this documents how to change it.

## Table of contents

- [Clone to green](#clone-to-green)
- [The native dependency, and how a green run can prove nothing](#the-native-dependency-and-how-a-green-run-can-prove-nothing)
- [What each command runs](#what-each-command-runs)
- [What to run before you propose a change](#what-to-run-before-you-propose-a-change)
- [Where things live](#where-things-live)
- [What moves together](#what-moves-together)
- [House conventions](#house-conventions)
- [Proposing the change](#proposing-the-change)

## Clone to green

```bash
git clone https://github.com/lanteanio/svelte-adapter-uws.git
cd svelte-adapter-uws

npm run bootstrap   # root deps, the fixture's own deps, then the doctor
npm run verify:fast # seconds - the static gates
npm run verify:pr   # exactly what the hosted gate runs
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

`uWebSockets.js` is a native C++ addon fetched from **GitHub, not npm**, and it
is an **optional** dependency. Read that as: `npm install` skips it silently
when the fetch or the compile fails. Your install succeeds, your test run goes
green, and every suite that boots the real built runtime over real sockets
reported as skipped - which in a summary looks exactly like a suite that ran and
proved something. Those are the suites standing behind the authorization,
revocation and handshake claims.

Check whether you actually have it, and everything else a run depends on:

```bash
npm run doctor
```

That answers whether a green run on this machine proves anything: the Node
version against `engines` and against the pinned baseline, whether the running
npm can write the committed lockfile format, whether your platform/arch/libc
has a prebuilt binary at all, `git` on PATH (the addon is fetched with it), the
root and fixture installs, whether a loopback listener can bind, and whether
Playwright's browser is present. `npm run doctor -- --require-uws` makes a
missing addon a failure instead of a warning.

Force the honest result - absence becomes a hard failure instead of a skip:

```bash
REQUIRE_UWS=1 npm test
```

`CI=true` implies the same thing, which is why the hosted gate cannot go green
without the addon. If you are contributing anything that touches the runtime,
run with `REQUIRE_UWS=1` at least once before you propose it.

If it will not install:

- It needs `git` on your PATH.
- Linux: `build-essential`, and a glibc >= 2.38 distribution. Alpine/musl is
  not supported, and neither are Bookworm-based images (the README's Docker
  section has the working base image).
- Windows: the Visual C++ Build Tools ("Desktop development with C++").
- The pinned version lives in `optionalDependencies` in `package.json` and
  every install hint the adapter prints is derived from that pin, so
  `npm install uNetworking/uWebSockets.js#<the pinned tag>` is always what the
  error message tells you.

Without the addon you can still work on the client, the plugins' pure logic,
the simulator and anything in `src/runtime/utils/**` - the pure suites run
normally. You cannot verify a runtime behaviour claim.

## What each command runs

| Command | What it actually does |
|---|---|
| `npm run bootstrap` | Root dependencies, the fixture's own dependencies, then the doctor. What a fresh clone needs. |
| `npm run doctor` | Whether this machine can prove anything. `-- --require-uws` makes a missing native addon fatal. |
| `npm run check` | Eight dependency-free static gates, described below. Seconds, no network, no fixture. |
| `npm run check:links` | Every `](#anchor)` in the shipped docs names a heading that exists, and every relative file link names a file that exists. External links are not fetched. |
| `npm test` | `pretest` runs `npm run check`, then `vitest run` over `test/**/*.test.js`. Excludes `test/e2e/**` and `test/fixture/**`. |
| `npm run verify:fast` | `npm run check`, named as a lane. |
| `npm run verify:suite` | The doctor with `--require-uws`, then `npm test` under `REQUIRE_UWS=1`. What the suite job runs, verbatim. |
| `npm run verify:sim` | The seed swarm and the golden corpus. What the simulation job runs, verbatim. |
| `npm run verify:pr` | `verify:suite` and `verify:sim`. Exactly the hosted lanes, and nothing they do not run. |
| `npm run verify:full` | `verify:pr` plus the Playwright run, which no workflow runs. |
| `npm run test:watch` | The same vitest run, watching. |
| `npm run test:e2e` | Playwright, two projects: `dev` (`vite dev` plus the Vite plugin) and `prod` (`vite build` plus the built server through real uWS). Needs extra setup, see below. |
| `npm run test:coverage` | vitest with coverage, then Playwright under `NODE_V8_COVERAGE`, then a `c8` report over the server and browser sources. A superset of the two above, so it needs their setup too. |
| `npm run sim:swarm` | Deterministic simulation: many seeded interleavings of the in-memory server under the fault engine. Exits non-zero on any invariant violation, fatal, or determinism regression. |
| `npm run sim:golden` | Re-runs the committed golden corpus (`test/dst-goldens/`) and fails when a fingerprint drifted from its blessed baseline. |
| `node bench/<file>.mjs` | The benchmark harness. Files ending `-ab.mjs` are before/after comparisons for a single hot path. |

The eight gates in `npm run check`, each of which answers exactly one question
and has no config:

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
- **check-uws-pin** - every copy-pasteable `uWebSockets.js#<ref>` install spec in
  a tracked file names the tag `optionalDependencies` pins, so no document hands
  a reader a version the tree is not tested against. Prose about a past version
  is not matched, `CHANGELOG.md` is skipped, and a lockfile is reported rather
  than enforced.
- **check-uws-binaries** - the installed native addon is the tree this
  repository accepted: the resolved commit, the upstream source commit, and a
  SHA-256 per shipped file. The pin is a mutable Git TAG on a package with no
  registry integrity hash, so a retag serves different bytes under an identical
  version string. Without the addon installed it prints a visible SKIP and
  passes; under `REQUIRE_UWS=1` or `CI` the skip is a failure. Re-accept a
  deliberate pin bump with `node scripts/check-uws-binaries.js --update` and
  review the diff - it is the record of which binaries changed.
- **check-scope** - every identifier a tracked source file reads resolves to
  something: a declaration, an import, or a declared global. Catches the name
  that parses fine and throws only when the line runs.
- **check-syntax** - every tracked `.js`/`.mjs` parses as a native ES module,
  not merely under vitest's transform pipeline.

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

The hosted gate runs `npm run verify:suite` on Ubuntu **and** Windows, and
`npm run verify:sim` on Ubuntu - the same commands, not a re-spelling of them,
so "it passed locally" and "CI is green" cannot drift into meaning different
things. `npm run verify:pr` is exactly those two lanes and is the local
equivalent of an accepted pull request.

Two more jobs run on the test workflow and have no local lane, because neither
asks a question about your machine: an **advisory** job, which reads both
lockfiles and fails on a high advisory in the SHIPPED dependency tree while
reporting the development tree without blocking; and a **support-floor** job,
which installs `svelte@4.0.0` and `ws@8.0.0` exactly - the floor of the
published peer range, which every other lane resolves past - and runs the
suites that load the browser client.

Still nothing else runs in CI: **`npm run test:e2e` and `npm run test:coverage`
are not hosted**, so if your change is covered by them you are the only person
who will ever run them. `npm run verify:full` is the only command that includes
the e2e run.

| You changed | Run |
|---|---|
| Anything under `src/`, `test/`, `scripts/`, `examples/`, or the manifests | `npm test` (with `REQUIRE_UWS=1`), `npm run sim:swarm`, `npm run sim:golden` |
| Runtime behaviour reachable over a socket (`src/runtime/**`, `src/vite.js`, `src/testing.js`) | the above, plus `npm run test:e2e` |
| The browser client (`src/client.js`, a plugin's `client.js`) | the above, plus `npm run test:e2e` (it drives the real client in Chromium) |
| The wire format | the above, plus `test/protocol-schema.test.js`, and see [What moves together](#what-moves-together) |
| A per-request, per-message or per-render hot path | the above, plus the matching `bench/*-ab.mjs`, before and after. Quote the numbers. |
| Only `README.md` / `MIGRATION.md` / `PROTOCOL.md` / `CONTRIBUTING.md` | `npm run check:links` and `npm run check` - check-slugs and check-links both read these files. All four now trigger the test workflow, so a docs-only change is gated like any other |

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
| `scripts/` | The eight static gates, the two simulation runners, the doctor, the bootstrap and the verify lanes. Deliberately outside the determinism seam, so they may read the clock and the environment. |
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

## House conventions

**Formatting.** Tabs. Match the surrounding file - its comment density, its
naming idiom, its bracket style. There is no repo formatter and there will not
be one: the tree is hand-laid and a whole-tree reflow would destroy `git blame`
on files whose comments are load-bearing.

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

**Commits.** Conventional Commits, as `git log` shows:
`fix(cluster): ...`, `feat(game): ...`, `docs(readme): ...`. Describe the defect
and the behaviour it now has. A reader a year from now has no access to
whatever tracker the change was routed through, so the message has to stand on
its own.

**Changelog.** `CHANGELOG.md` follows Keep a Changelog and the project follows
SemVer. Every shipped change gets an entry, written for someone who will read it
a year from now with no other context: what was wrong, what it now does, and what
they have to do about it.

## Proposing the change

Open an issue first if the change is large or changes a default; for a bug fix
with a test, a pull request is fine on its own. In the description, say:

- what the defect was, in terms of observable behaviour;
- which commands you ran and on which operating system;
- whether the native addon was installed (`REQUIRE_UWS=1` or not);
- for a hot-path change, the before/after benchmark numbers;
- anything you could not run.

For a security-sensitive report, keep the initial message short: enough to
establish the class of problem and how to reach it, without a working exploit.
If the repository carries a `SECURITY.md`, follow the route it names; otherwise
open a tracker issue in that shortened form and expect the details to be asked
for privately.
