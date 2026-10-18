# Stable releases

Stable releases come from `main`. The canonical append-only ledger remains on
[`dev`](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/release-manifest.md),
with its [publication and rollback contract](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/releasing.md).
Use a clean isolated `dev`-based bookkeeping worktree for subsequent ledger-only
commits. The release tag names the frozen main source, never the bookkeeping
commit. Do not duplicate the ledger onto stable or include unrelated integration
work in the stable source.

## Trusted publisher

Configure an npm trusted publisher for `lanteanio/svelte-adapter-uws`, workflow
`release.yml`, environment `npm-release`, with permission for `npm publish`.
Configure that GitHub environment with required reviewers, administrator bypass
turned off, and exactly one custom deployment rule: tag `svelte-adapter-uws@*`.
Protect creation of that tag pattern.
Verify these account settings before creating a tag. The workflow refuses a
missing, unreadable, unprotected or broadly routable environment through the
read-only GitHub API. npm rejects an absent or mismatched trusted publisher.
There is no token fallback and no manual workflow trigger.

The identity job runs the checked-in verifier before any dependency installation.
It binds the exact annotated tag and push event to a clean commit in
`origin/main` and reads its retained-artifact SHA256. The complete Windows and
Linux test workflow runs on the same caller SHA. Every job must succeed before
packing. Verification and packing have no publication identity.

The separate publish job has `id-token: write`, installs only npm 11.5.1 with
scripts disabled, checks out no repository, and runs no repository code or
dependency tree. Publication pins the public npm registry and requires provenance. It compares
the downloaded tarball directly to the identity job's tag-bound digest before
publishing to quarantine `candidate`. Neither `latest` nor `next` moves there.
`node scripts/check-release-workflow.js` pins the workflow, command bodies,
package script inventory and complete test workflow. Changing a gated command
or lane must update its pin in the same reviewed change.

## Freeze and retain

1. Complete stable and cross-repository preflight, independent review, all tests
   and exact-version consumer gates. Commit the version bump and dated changelog
   on `main`. Record its full SHA and require clean source.
2. Confirm the npm version and annotated tag do not already exist locally or
   remotely. Record existing `latest`, `next` and `candidate` pointers.
3. With Node 22.23.2 and npm 11.5.1, run in the clean source checkout. In
   PowerShell call `npm.cmd`, so that the `--` separator reaches npm; a shell
   uses `npm`:

   ```powershell
   npm.cmd run --ignore-scripts --silent pack:release -- --destination ../release-artifacts/0.5.11
   ```

   Use a new directory per candidate. Retain its JSON output and tarball. The
   tool refuses dirty or non-main source, unexpected scripts, untracked files
   and symlinks. It derives the npm file list from the complete frozen Git tree, including
   tracked selection rules. Ignored workspace files cannot affect it. It adds only
   `gitHead` to the packed manifest, and packs with scripts disabled. Every
   archive file is checked against the Git blob; `package.json` has exactly one
   semantic addition, `gitHead` equal to the source SHA. Publishing a prebuilt
   tarball cannot infer this metadata from the publisher's checkout.
4. Install the exact archive into locked consumers and run smoke/type gates.
   Reproduce it on Linux with the same tool and compare SHA256. A mismatch
   blocks the tag; never bless another digest after tagging.
5. In a clean isolated `dev` bookkeeping worktree append a `proposed` event to
   `docs/release-manifest.md`, naming the frozen main SHA, planned tag, `latest`
   and retained-artifact evidence. Commit only this ledger change after the
   source commit. It contains no registry integrity, shasum or publication
   time. Run canonical ledger/policy tests and review both commits.

## Tag and publish

Only the owner pushes, creates the tag and authorizes publication. The
annotation holds exactly one digest field:

```text
Release 0.5.11

Artifact-SHA256: <64 lowercase hexadecimal characters>
```

Run these commands in the clean main source checkout, not in the `dev`
bookkeeping worktree. Set `$source` to the frozen main SHA and `$tarball` to the
retained archive. Write the annotation outside the repository as UTF-8 without
a byte order mark; in Windows PowerShell 5.1, `Out-File` and `>` write UTF-16
and `Get-FileHash` returns uppercase hexadecimal, so use the commands below.
Windows PowerShell continues after a failed native command, so each line checks
its exit code. After verifying account protection and complete preflight:

```powershell
$tag = 'svelte-adapter-uws@0.5.11'
$annotation = Join-Path ([IO.Path]::GetTempPath()) 'svelte-adapter-uws-0.5.11.tag.txt'
$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarball).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($annotation, "Release 0.5.11`n`nArtifact-SHA256: $sha256`n")
git push origin main; if ($LASTEXITCODE -ne 0) { throw 'pushing main failed' }
git fetch origin main; if ($LASTEXITCODE -ne 0) { throw 'fetching main failed' }
git tag -a $tag $source -F $annotation; if ($LASTEXITCODE -ne 0) { throw 'tagging failed' }
node scripts/prepare-release.js --verify-tag $tag --artifact $tarball; if ($LASTEXITCODE -ne 0) { throw 'the local tag check failed; do not push the tag' }
```

The same steps in a POSIX shell, with `source` and `tarball` set:

```sh
set -eu
tag=svelte-adapter-uws@0.5.11
annotation=$(mktemp)
sha256=$(sha256sum -- "$tarball")
sha256=${sha256%% *}
printf 'Release 0.5.11\n\nArtifact-SHA256: %s\n' "$sha256" > "$annotation"
git push origin main
git fetch origin main
git tag -a "$tag" "$source" -F "$annotation"
node scripts/prepare-release.js --verify-tag "$tag" --artifact "$tarball"
```

The local check requires an annotated tag named for the package version at the
tagged commit, exactly one lowercase digest line equal to the retained tarball,
a tarball whose package name, version and `gitHead` match the tagged commit,
and a tagged commit contained in `refs/remotes/origin/main`. If it fails,
delete the local tag with `git tag -d $tag`, correct the cause and tag again.
Only after it prints `local tag ... binds ...`, push the tag as a separate
command:

```powershell
git push origin $tag
```

Never push a tag that has not passed the check.

Append `tagged` only after the remote tag is visible. The workflow reproduces
and retains the frozen archive only if its digest matches the annotation.
Before approving the protected environment, check the successful complete test
run, source SHA and retained digest. The publish job only uses those bytes.
Retry a failed run with "Re-run all jobs": the retained artifact is named for
the run attempt, so re-running only the publish job cannot find it and fails
closed.

After publication query the immutable version and the current pointer map:

```powershell
npm view svelte-adapter-uws@0.5.11 gitHead dist.integrity dist.shasum --json
npm view svelte-adapter-uws time --json
npm view svelte-adapter-uws dist-tags --json
```

Compare `gitHead` with the tag and integrity/shasum with the retained archive.
Resolve ambiguous publication through these reads, never by overwriting. In
one subsequent ledger-only commit append the immutable published row and its
verified identity pin, the `published` event and the opening `candidate` route.
Record its exact preflight from-pointer and observed new pointer. Event times
must follow registry publication; never invent these facts in advance.

Install the exact registry version with qualified siblings and rerun the
consumer smoke/type gates. Only after success may the owner move `latest`:

```powershell
npm dist-tag add svelte-adapter-uws@0.5.11 latest
npm view svelte-adapter-uws dist-tags --json
```

Immediately append the verified `latest` routing event. Restore the prior
`candidate` pointer, or remove it if none existed, verify the map and append
its routing event. Record stable compatibility, digest, release manifest,
README/migration pins and fixtures on `dev`; regenerate published-main files
with `node scripts/check-links.js --write-main-tree`. Forward-port the complete
logical fix with explicit version/changelog reconciliation.

Never retarget a pushed tag, overwrite a version or use `npm unpublish` as
rollback. Before publication append `aborted`; after publication retain the
immutable identity and follow the canonical quarantine-abort or dist-tag
rollback transaction. Observed facts are appended, never rewritten.
