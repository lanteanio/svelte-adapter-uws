# Release manifest

Append-only candidate events, published identities and routing events. See
[`releasing.md`](./releasing.md) for the publication, hotfix, abort and dist-tag
procedures.

Historical entries were verified from primary npm metadata on 2026-08-01. They
did not have Git tags; `legacy-none` records that fact without inventing
history. New published rows must use the immutable
`svelte-adapter-uws@<version>` tag.

## Candidate event log

Candidate events contain only facts known at the time of the event. They never
carry npm integrity, npm shasum or Published UTC. Append `proposed`, then either
`aborted` or `tagged`; after `tagged`, append exactly one terminal event:
`aborted` when the version does not exist, or `published` when it does. A
`published` event and its complete published row are appended together only
after exact-version registry metadata exists. Never edit an earlier event.
Every event for one candidate must repeat the proposed full Git head, planned
tag and target channel exactly. Event times must not go backwards. The final
published row must bind that same candidate to the same Git head, Git tag and
target channel. Stable versions target `latest`; versions with a prerelease
suffix target `next`. The `published` event UTC cannot predate npm's Published
UTC, while `proposed` and `tagged` cannot follow it. Versions must be canonical
npm SemVer without build metadata, which prevents multiple immutable
identities from sharing one SemVer precedence. Every timestamp is a full canonical UTC instant in
`YYYY-MM-DDTHH:mm:ss.sssZ` form.

| Candidate | Event | Event UTC | Git head | Planned tag | Target channel | Evidence |
| --------- | ----- | --------- | -------- | ----------- | -------------- | -------- |

## Published releases

This table is the immutable registry identity log, not a planning surface. Add
a row only after npm returns the exact version's actual `gitHead`, integrity,
shasum and publication time. The target channel records the intended stable or
prerelease route; publication initially uses the quarantine `candidate`
dist-tag and does not move that target channel.
Every non-legacy row must have one complete candidate lifecycle and exactly one
candidate-opening route in the same checked manifest state. That immutable
identity cannot open a second quarantine transaction.

| Package            | Version       | Target channel | Git head                                 | Git tag     | npm integrity                                                                                   | npm shasum                               | Published UTC            | Notes                                                   |
| ------------------ | ------------- | -------------- | ---------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------ | ------------------------------------------------------- |
| svelte-adapter-uws | 0.5.8         | latest         | d34d72a5fa7e64b4df36eee5db8d31844086533d | legacy-none | sha512-XG1DLduJDO+p6cK49NFd0ItJTuRXRVXhtukBNGS3ikW7NwUV2OIF+qhG0piNBP+vAVyvMfLvWM7sPVttFfBMjg== | d1362cadfee549cf2b031ce907d33ccdb8753e37 | 2026-05-23T00:42:45.631Z | Initial stable rollback row reconstructed from npm.     |
| svelte-adapter-uws | 0.6.0-next.90 | next           | 7b9ba000056b7cb198cd83605355302ecec3853c | legacy-none | sha512-oUjPvTJH49I+r2NfN+VW1WktNchvq34wCJTICb3Jdj6BSYBD3BqyIhvYH3lq8xEbaMiYJNZDOT8Td8l/EFCxWw== | 42bf4268f79745ac7b2310af3c2effa8e017ce1a | 2026-07-31T23:31:37.019Z | Initial prerelease rollback row reconstructed from npm. |

## Routing, corrections and rollback events

The verified legacy rows establish the initial `latest` and `next` pointers
for this log. The `candidate` pointer was absent at that baseline. Every later
pointer mutation is a continuous from-to event:

- `routed` records a successful pointer mutation, including the quarantine
  pointer created by `npm publish --tag candidate`, a target-channel move, and
  quarantine cleanup.
- `routing-aborted` records restoring or removing the `candidate` pointer
  after a published candidate is rejected before target routing. It must
  restore the exact quarantine pointer captured before publication.
- `rollback` restores `latest` or `next` from one immutable release to
  another immutable release intended for that channel which previously
  occupied that channel. An immutable row alone is not rollback history.
- `correction` names the earlier event it supersedes and repeats the complete
  corrected routing fact, including its event type and effective UTC. The
  correction row's Event UTC records when the correction was appended. A later
  correction must name the latest correction in that chain. Corrections do not
  move a pointer themselves.

Non-correction rows use `none` in both corrected columns. A correction keeps
`correction` as its Event, puts the replacement routing kind in Corrected event,
and puts that replacement fact's UTC in Corrected UTC.

Event IDs are unique. Versions must resolve to published rows; only the
`candidate` channel may use `none`. Routing records and their effective events
are chronological. Every effective `routed` transition on `latest` or `next`
must strictly advance npm SemVer precedence. A lower public version is valid
only as `rollback` to an immutable identity that previously occupied the same
channel; a rollback cannot move forward. Corrections are subject to these same
checks after their replacement facts are resolved. A quarantine route cannot predate the immutable row's npm
Published UTC or the candidate's `published` event. Target routing follows its
quarantine route. `routing-aborted` is valid only before target routing;
successful quarantine cleanup after target routing is `routed`. Evidence and
notes are mandatory. A rollback permanently prevents the same transaction from
routing that immutable identity forward again: the rollback from-identity stays
rejected for every later public-channel event, including reverse rollback, even
after quarantine cleanup. Only quarantine restoration or cleanup may follow;
fix forward with a distinct immutable version. A correction can replace a
mistaken rollback fact without rewriting it, and rejection is derived from the
corrected effective history. Never edit a published row or earlier event to
make later history look cleaner.

| Event ID | Event UTC | Event | Corrected event | Corrected UTC | Package | Channel | From version | To version | Corrects event | Evidence | Notes |
| -------- | --------- | ----- | --------------- | ------------- | ------- | ------- | ------------ | ---------- | -------------- | -------- | ----- |
