# Releasing

This is the release and rollback contract for `svelte-adapter-uws`. The
extensions and realtime repositories must carry the same lifecycle before an
ecosystem promotion is treated as coordinated.

The immutable publication identity is the tuple of package name, version, Git
commit, Git tag, npm integrity, npm shasum and publication time recorded in the
published-release table in [`release-manifest.md`](./release-manifest.md). The
same row records the target dist-tag as routing intent, not immutable identity.
The publication identity cannot exist until the registry has accepted the
version. Before publication, an append-only candidate event records only facts
that are already knowable. A version and its Git tag are immutable. npm
dist-tags are routing pointers and may move during promotion or rollback.
Versions in every log use canonical npm SemVer without build metadata, so one
SemVer precedence has exactly one immutable registry identity in the ledger.
All log timestamps use the full canonical UTC instant form
`YYYY-MM-DDTHH:mm:ss.sssZ`; date-only values, offsets and
normalized-but-noncanonical dates are invalid.

## Branch roles

- `dev` is the integration branch and the source of `next` prereleases.
- `main` is the stable branch and the source of `latest` releases.
- `hotfix/<stable-version>/<slug>` starts from the exact stable release
  identity in the manifest. It never starts from the current tip by habit.
- Release preparation happens on the relevant branch. Do not create a
  long-lived release branch that can acquire an unreviewed history of its own.

Both `dev` and `main` are protected by review and the required checks. A
promotion uses a normal reviewed commit; it is never assembled by editing the
registry or branch directly.

## Consumer release notes

Every newest release block starts with one bounded consumer summary before its
engineering detail. Historical releases are records and are not rewritten to
fit a later template. Each current summary entry uses this exact shape:

```markdown
- **Added: capability.** One outcome sentence whose complete lead is 40-60 words.
  - **Affects:** The consumers or operators whose behavior can change.
  - **Action:** A concrete next step, or an explicit statement that none is needed.
  - **Requires:** Runtime, configuration, dependency, or evidence prerequisites.
  - **Compatibility:** Breaking, additive, or unchanged behavior at the boundary.
  - **Detail:** [Added engineering detail](#added).
```

Use `Added`, `Changed`, or `Fixed` to match the linked engineering section.
Keep failure history, implementation mechanics, test transcripts, and benchmark
conditions in that detail section; the lead states one consumer outcome. The
summary must cover exactly the `### Added`, `### Changed`, and `### Fixed`
sections the newest release actually contains: a Fixed-only release passes with
Fixed-only coverage, a release with a `### Changed` section fails without
Changed coverage, and an entry may not point at a section the release does not
have. Engineering bullets in releases after `0.6.0-next.91` are bounded to
2000 characters each; earlier history is frozen as written, and an oversized
bullet is split into focused bullets rather than raising the bound.

The generated `docs/releases/<version>.md` page links engineering detail to the
release's own version-heading anchor in `CHANGELOG.md` (for example
`## [0.6.0-next.91] - 2026-08-10` produces `#060-next91---2026-08-10`), never
to the file-first `#added` style anchors, which always resolve to the newest
release and would silently misroute archived pages. Every page in
`docs/releases/`, not only the newest, must pin its own version anchor, and
`README.md` and `MIGRATION.md` must both carry the current
`./docs/releases/<version>.md` link. `node scripts/check-release-notes.js` is
the preflight gate for marker placement, field order, lead length, one-sentence
outcomes, per-section coverage, the bullet bound, version-pinned detail anchors
across the whole archive, and the current-release links; regenerate the page
with `node scripts/check-release-notes.js --write`.

## Release identity and immutable tags

Every new publication gets an annotated Git tag:

```text
svelte-adapter-uws@<version>
```

The tag must point at the `gitHead` embedded in the npm version metadata and
at the commit recorded in the manifest. Never delete, reuse, or retarget a
pushed release tag. If a release is wrong, publish a new version or move the
dist-tag back to a known-good immutable version.

Historical releases without Git tags are recorded as `legacy-none`; the npm
`gitHead`, integrity and shasum remain their rollback identity. Do not invent a
tag after the fact and imply that it existed at publication.

## Trusted publication workflow

The adapter publishes only through .github/workflows/release.yml. Configure the
package on npm with an npm trusted publisher for repository
lanteanio/svelte-adapter-uws, workflow filename release.yml, environment
npm-release, and permission to run npm publish. Configure the matching GitHub
npm-release environment with required reviewers and a deployment rule limited
to tags matching svelte-adapter-uws@*. Protect the same tag pattern against
unreviewed creation.

The workflow has no manual or branch trigger and no token fallback. It runs as
two jobs on GitHub-hosted runners, because id-token: write is granted per job
and would otherwise cover every dependency install and test in the same job.

The verify job holds only contents: read, so it can mint no publication
identity at all. It rejects any tag that is not the exact annotated
svelte-adapter-uws@<package version> tag on its clean commit or is outside the
required dev prerelease / main stable lineage, runs the complete pull-request
verification contract and prepublishOnly, packs exactly one npm-pack tarball,
and retains it as a build artifact.

The pack itself is kept inert. npm pack runs the prepack, prepare, and
postpack lifecycle scripts around tarball creation - after every explicit
verification step - and npm run executes the pre/post companions of every
script it runs, so any unexpected script name can put code between the checks
and the bytes that are hashed, leaving the digest authenticating an artifact
nothing tested. check-release-workflow therefore holds the manifest's scripts
object to a closed inventory of names AND bodies - additions, removals, and
edits all refuse - and the refusal runs inside the same checked-in gate the
workflow body is pinned by. The body pins are what couple the workflow to the
verification it claims to run: without them, one edit could reduce a check
the release path runs by name to a no-op while every name stayed green, so
changing what a script does means moving its pin in the same commit, where
the gate's own diff shows what the release path will now run. The publish
job is outside this window entirely: npm runs lifecycle scripts only when
publishing a directory, and it is handed a prebuilt tarball, which packs
nothing and executes nothing.

The publish job receives contents: read and id-token: write. It never installs
a dependency tree and never executes repository code: it installs the pinned
OIDC-capable npm CLI, downloads the artifact the verify job retained, and
publishes that exact file to the quarantine candidate dist-tag. Trusted
publishing supplies short-lived OIDC authentication and automatic provenance;
never add NODE_AUTH_TOKEN or a long-lived npm secret as fallback.

The npm trusted publisher and protected environment are external controls. Set
them before the first tag; without them the job must fail closed. Once the OIDC
path is proven, revoke legacy automation tokens and disable token publication
for this package. Extensions and realtime require their own repository-local
workflow and trusted-publisher identity; this adapter workflow cannot attest
their source.

## Preflight and freeze

1. Select explicit adapter, extensions and realtime commits. Record all three
   full SHAs in the release pull request.
2. Freeze those commits for release-only changes. New product work waits; a
   required fix restarts preflight from the new SHAs.
3. Require clean working trees and reconciled changelogs, versions, declarations,
   generated files, protocol artifacts and lockfiles. Run
   `node scripts/check-release-notes.js` and resolve every consumer-summary
   failure before freeze.
4. Run each repository's required static, unit, real-runtime, simulation,
   browser, database and platform lanes. The cross-repository heads workflow
   must pack and install the selected commits together; a skipped rung is not a
   pass.
5. Run `npm pack --json` in each clean checkout and retain the tarball, file
   list and pack output as release artifacts. Install those exact tarballs into
   the disposable cross-repository consumer.
6. Confirm that the target version does not exist and the target Git tag does
   not exist locally or remotely. Record the current `latest`, `next` and
   quarantine `candidate` dist-tags for rollback before moving any pointer.
7. Append a `proposed` candidate event per package. It records the candidate
   package and version, event UTC, full Git head, planned tag, target channel,
   and retained-artifact evidence. It has no npm integrity, npm shasum or
   Published UTC because no registry identity exists yet. The reviewed release
   commit includes this proposed event; the release tag points at that commit.

Abort before tagging if any input changes or any required rung is incomplete.

## Prerelease publication

Prerelease versions come from `dev` and use the `next` channel.

1. Create and push the immutable annotated Git tag only after preflight passes.
2. Append a `tagged` candidate event after the remote tag is visible. The tag
   remains on the reviewed proposal commit; the later event does not retarget
   it.
3. Publish the exact retained tarball under the quarantine `candidate` dist-tag
   with provenance when the trusted publication workflow supports it. Use the
   equivalent of `npm publish <tarball> --tag candidate`; never let publication
   move `next` or `latest` before verification, and never rebuild between
   review and publish.
4. Query the exact version until npm returns its actual `gitHead`,
   `dist.integrity`, `dist.shasum` and publication time. Compare those values
   with the tagged commit and retained artifact. An ambiguous publish response
   is resolved by this registry query, not by publishing again.
5. In one manifest-only commit, append the complete immutable published row
   from that registry metadata, append the candidate's `published` event, and
   append exactly one opening `routed` event for the quarantine pointer mutation
   caused by publication. Its from-version is the `candidate` value captured at
   preflight and its to-version is the new immutable version. This commit is
   necessarily after the release tag and does not claim that the unknowable
   registry metadata existed inside the tagged commit. Give the `published`
   event and quarantine route observation UTCs no earlier than npm's Published
   UTC, with the route no earlier than the `published` event. A non-legacy
   published identity is invalid without this route in the same manifest state,
   and that immutable identity can never open another quarantine transaction.
6. Install the registry versions by exact version together and rerun the packed
   consumer smoke/type rung.
7. Move `next` only after verification. Confirm
   `npm view <package> dist-tags --json`, then append a `routed` event with
   the exact old and new pointer. Remove the quarantine `candidate` pointer or
   restore the pointer recorded at preflight, verify that mutation, and append
   its own `routed` event.

For a coordinated ecosystem prerelease, publish immutable versions in dependency
order: adapter, extensions, then realtime. Keep the prior `next` map recorded.
Do not move any package's `next` pointer until all candidate versions exist and
the exact-version consumer passes.

## Stable promotion

Stable versions come from `main` and use `latest`.

1. Start from the reviewed prerelease lineage. Reconcile the final changelog and
   migration guidance; remove prerelease-only version suffixes in a dedicated
   promotion commit.
2. On a local `main` checkout, merge the reviewed promotion without squashing
   away the commit recorded by the manifest, and flip the documentation's
   same-repo `blob/dev` source links to `blob/main` in that commit: the
   content they name is now on `main`'s lineage, and `scripts/check-links.js`
   validates each link against the tree its ref names - on the `main` branch
   that is the very tree being built, so the full verify runs green BEFORE
   the push. (A `dev` checkout cannot green those links, deliberately: a
   `blob/main` link is a claim about `main`.) Flipping the links also turns
   the two tests that pin them verbatim red -
   `test/content-destinations.test.js` and
   `test/cursor-accessibility.test.js` - so update those pins in the same
   commit; they exist to make the flip a conscious edit.
3. Push, then repeat the complete preflight against `main`; prior prerelease
   evidence is useful context, not a substitute. Re-verifying an OLD stable
   tag after a later promotion fails the link gate's snapshot staleness check
   by design - the tag's snapshot records the published `main` of its own era
   - so rollback uses the retained artifact, never a re-verify of a
   superseded tag.
4. Follow the same proposed -> tagged -> quarantine publication -> immutable
   published-row transaction as a prerelease, using `latest` as the target
   channel. Verify exact-version installation before moving any `latest`
   pointer.
5. Move `latest` in dependency order. After each confirmed pointer move, append
   its `routed` event immediately. Then remove or restore each quarantine
   `candidate` pointer, verify the resulting three-package install, and record
   the previous and new channel map in the release handoff.
6. Back on `dev`, regenerate the published-main file list so the next
   prerelease cycle validates `blob/main` links against the tree that now
   exists: `node scripts/check-links.js --write-main-tree` (the gate fails
   with this exact instruction until it is done).

There is no partial-success fiction. If one package cannot publish or the final
consumer fails, stop and use the abort or rollback procedure.

## Abort

- After a `proposed` event but before tagging: append an `aborted` candidate
  event, stop and unfreeze. No published row and no registry mutation exist.
- After a `tagged` event but before publication: keep the pushed tag immutable,
  append an `aborted` candidate event, and use a new version for a replacement.
  There is still no published row.
- If publication returns ambiguously, query the exact version. If it does not
  exist, append `aborted`. If it exists, publication is an immutable fact:
  append the published row, `published` event and one opening quarantine route
  from registry metadata and observed dist-tags. Never append `aborted` for a
  version that exists.
- After publication but before a target-channel move: leave the immutable
  published row intact, remove or restore the quarantine `candidate` pointer,
  verify the resulting dist-tags, append a `routing-aborted` event from the
  published version to the restored prior pointer or `none`, and publish a
  corrected version. The destination must be the exact `candidate` pointer
  captured at preflight.
- After any target dist-tag moved: run rollback immediately for every pointer
  already changed, then verify the restored exact-version consumer and append
  the rollback event. Record later quarantine restoration as `routed`, not
  `routing-aborted`, because target routing already occurred. The rolled-back
  transaction may only restore or clear its quarantine pointer; it can never
  route that immutable version forward again. Fix forward with a new version.

Never use `npm unpublish` as rollback and never overwrite a version.

## Stable hotfix

1. Resolve the current stable manifest row and create
   `hotfix/<stable-version>/<slug>` from its exact Git commit or immutable tag.
2. Make the smallest fix, add a regression test, bump the patch version, and
   add a changelog entry that states the affected stable line.
3. Run the full stable and cross-repository preflight. Follow the same proposed
   -> tagged -> quarantine publication -> immutable published-row transaction,
   then move `latest` only after verification and append its `routed` event.
4. Merge the hotfix into `main`, then merge or cherry-pick the same logical
   fix into `dev`. Resolve version/changelog differences explicitly; do not
   silently leave the integration line vulnerable.

## Dist-tag rollback

Rollback changes what new installs receive; it does not remove deployed code.

1. Pick a known-good immutable published row that previously occupied the
   affected channel according to the validated routing ledger. Never use a
   merely published but never-routed identity, or a proposed, tagged or aborted
   candidate event, as rollback identity. Verify its npm integrity, shasum and
   `gitHead` again.
2. Restore the pointer with
   `npm dist-tag add <package>@<known-good-version> <latest-or-next>`.
3. Verify the complete channel map and install all three exact routed versions
   into a clean consumer.
4. Append a rollback event whose from-version is the bad immutable version and
   whose to-version is the restored immutable version. Include a unique event
   ID, UTC time, incident and operator evidence, and the follow-up version in
   notes. Update public incident communication where appropriate.
5. Fix forward with a new version. Never move an immutable Git tag.

Rollback the smallest affected set only when compatibility is proven. If the
bad version changed a peer floor or wire contract, restore a tested three-package
set rather than one package in isolation.

## Manifest maintenance

All three logs in `release-manifest.md` are append-only. State changes append a
candidate event; they never edit the proposed event. A candidate follows one of
these paths:

```text
proposed -> aborted
proposed -> tagged -> aborted
proposed -> tagged -> published
```

Only the last path has an immutable published row, appended in the same commit
as the `published` event and exactly one candidate-opening route after actual
registry metadata exists. Every non-legacy published identity must have all
three facts in the checked manifest state. An immutable identity can open the
quarantine route only once, even after abort or cleanup. A published
version never becomes aborted; a later routing failure is a `routing-aborted`
or rollback event. Every candidate event repeats one immutable Git head,
planned tag and target channel, and the published row must match all three.
Stable versions can target only `latest`; prerelease versions can target only
`next`.

Routing events form a continuous per-channel ledger from the verified legacy
baseline. Each from-version must equal that channel's preceding to-version,
and every non-`none` endpoint must resolve to an immutable published row.
Every effective `routed` transition on `latest` or `next`, including one
produced by a correction, must strictly increase npm SemVer precedence from
its from-version to its to-version. A public pointer may move to a lower
version only through `rollback`, whose destination must have previously
occupied that same channel; a forward move cannot be labelled as rollback.
The quarantine route must follow registry publication and the candidate's
`published` event. A target route must consume the active quarantine identity.
Before target routing, `routing-aborted` restores its exact captured prior
pointer; after target routing, successful cleanup is `routed`. Rollback can
select only an identity that previously occupied that public channel. Each
rollback permanently rejects its from-identity for later public routing in the
effective ledger, even after quarantine cleanup and whether a later transition
is labelled `routed` or `rollback`. Only candidate-pointer restoration or
cleanup may remain for that transaction; fix forward with a distinct immutable
version. Append-only corrections may replace a mistaken rollback fact, in which
case validation derives rejection from the corrected effective history.

Correct a mistaken routing fact by appending a `correction` row that names the
event it supersedes and carries the complete replacement event type, effective
UTC, pointer fields, evidence and notes. The correction row's own Event UTC is
the append time. A further correction names the latest correction in that
chain. Do not rewrite the original row. The manifest test checks schemas,
candidate transitions, identity continuity, duplicate identities, routing
continuity and time, quarantine state, rollback history, complete correction
chains, full Git heads and registry digests without contacting npm.
