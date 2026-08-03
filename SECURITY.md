# Security Policy

## Supported versions

Security fixes target the current stable release published under npm's
`latest` tag and the current prerelease published under the `next` tag. At the
time this policy was added, those release lines are `0.5.x` and
`0.6.0-next.x`, respectively. The npm dist-tags are the source of truth for
the exact supported releases.

Older releases are not supported. Before reporting a vulnerability, reproduce
it with the current release from the applicable channel when possible.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting form:

https://github.com/lanteanio/svelte-adapter-uws/security/advisories/new

A GitHub account is required. Do not open a public issue containing
vulnerability details, exploit code, secrets, or affected deployment data. If
the private form is unavailable, open a public issue containing no vulnerability
details and ask the maintainer to establish a private channel.

Include enough information to reproduce and assess the report:

- the affected package version and npm channel;
- the security impact and attacker prerequisites;
- minimal reproduction steps or a proof of concept;
- relevant operating-system, Node.js, uWebSockets.js, proxy, and deployment
  details;
- any known workarounds or mitigations; and
- whether any details have already been disclosed publicly.

Remove unrelated secrets and personal data from logs, traces, and examples.

The maintainer will use the private advisory to review the report, request any
missing evidence, and coordinate a fix, release, and public disclosure when
appropriate. Response and remediation timing depends on the report's scope and
complexity; this project does not publish a response-time SLA. Keep the report
private until the advisory is published or disclosure is otherwise agreed in
the advisory discussion.
