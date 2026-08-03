# Documentation canonicality

Status: Accepted.

## Context

Package READMEs, protocol material, migration pages, and the documentation site
serve different readers. Copying normative version or behavior facts across
them without an owner creates contradictory instructions.

## Decision

Versioned package contracts live with their implementation:

- The adapter README owns identity, installation, support status, and routes
  to versioned companion contracts.
- `PROTOCOL.md` owns wire semantics and conformance.
- Package migration and compatibility files own version-specific upgrade
  facts.
- This architecture corpus owns versioned cross-package responsibility and
  accepted-decision contracts.

The documentation site owns tutorials, how-to guides, explanations, and
searchable reference across release lines. It links to package contracts for
normative version, wire, and ownership facts rather than silently redefining
them. A package source link is preferred when a statement changes with the
installed version.

## Placement

Topic ownership above says which document is authoritative. Placement says where
that document lives, so the repository root cannot accumulate contracts by
default.

The root carries only files a tool or platform reads from the root: `README.md`,
`CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and the two
package contracts a consumer is told to open by name, `MIGRATION.md` and
`PROTOCOL.md`.

Every other contract, guide, decision, and generated companion lives under
`docs/`, named in lowercase kebab-case. Directory indexes are `README.md`.
A generated document declares its output path under `docs/` in the generator.

`test/root-doc-placement.test.js` fails when a markdown file appears in the root
outside that list, so a new contract cannot silently land there.

## Consequences

- The installed package carries the contracts needed to operate that version.
- The site can improve navigation and teaching without becoming a second
  release ledger.
- A duplicated fact is either generated from its owner or covered by a drift
  check.
- Conflicts are corrected at the declared owner, then propagated outward.

Revisit when one generated source can safely publish both package-versioned
contracts and the site's long-form presentation.
