import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentationFiles, packageFiles } from '../scripts/check-links.js';

// Line endings normalized on read: one needle below spans a line break, and on
// a CRLF working tree it would not match a document that is otherwise correct.
// `.gitattributes` normalizes the tree, so this is a guard against a single
// file arriving with CRLF rather than a fault seen today.
const read = (relative) =>
	readFileSync(new URL('../' + relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const architecture = read('docs/architecture.md');
const prose = architecture.replace(/\s+/g, ' ');
const readme = read('README.md');
const officialLinks = '**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](https://svelte-realtime.dev/) | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.';

describe('ecosystem architecture documentation', () => {
	it('declares the official domain trust boundary at both public entry points', () => {
		expect(readme).toContain(officialLinks);
		expect(architecture).toContain(officialLinks);
		expect(architecture).toContain('Existing runtime\nslugs are preserved indefinitely');
		expect(architecture).toContain('is an identity and security migration');
		expect(prose).toContain(
			'Runtime `https://svti.me/<slug>` URLs are permanent compatibility surfaces that redirect to reviewed pages on the documentation site'
		);
		expect(prose).toContain(
			'Redirect destinations must carry the svelte-realtime family breadcrumb and routes back to the official owner, documentation, and demo.'
		);
	});

	it('ships the architecture contract', () => {
		expect(new Set(packageFiles())).toContain('docs/architecture.md');
		expect(new Set(documentationFiles())).toContain('docs/architecture.md');
	});

	it('keeps the complete contract reachable from both README routes', () => {
		const rows = readme.split('\n').map((line) =>
			line.split('|').map((cell) => cell.trim()).join('|')
		);
		expect(readme).toContain('[Architecture](./docs/architecture.md)');
		expect(readme).toContain('[ecosystem architecture](./docs/architecture.md)');
		expect(readme).toContain('[privacy integration contract](./docs/privacy-integration.md)');
		expect(rows).toContain(
			'|`ecosystem-contract`|Versioned package boundaries and accepted architecture decisions|`docs/architecture.md`|'
		);
		expect(rows).toContain(
			'|`ecosystem-privacy`|Processing inventory, retention/erasure defaults, and host compliance worksheet|`docs/privacy-integration.md`|'
		);
	});

	it('names every package boundary, required flow, authority, and failure owner', () => {
		for (const packageName of [
			'svelte-adapter-uws',
			'svelte-realtime',
			'svelte-adapter-uws-extensions'
		]) {
			expect(architecture).toContain('`' + packageName + '`');
		}
		for (const heading of [
			'## Context and package boundaries',
			'## Request and event flow',
			'## Replay and recovery flow',
			'## Observability flow',
			'## Contract authorities',
			'## Deployment topologies',
			'## Persistence boundary',
			'## Memory-pressure signal',
			'## Failure ownership',
			'## Release coupling'
		]) {
			expect(architecture).toContain(heading);
		}
		for (const authority of [
			'[`PROTOCOL.md`](../PROTOCOL.md)',
			'[`protocol.schema.json`](../protocol.schema.json)',
			'[`docs/compatibility.v1.csv`](./compatibility.v1.csv)',
			'[`release-manifest.md`](./release-manifest.md)',
			'[`observability.md`](./observability.md)'
		]) {
			expect(architecture).toContain(authority);
		}
	});

	it('keeps conditional auth, warn-only state, and optional breakers explicit', () => {
		expect(architecture).toMatch(
			/With\s+no hook, the default is an anonymous accepted connection/
		);
		expect(architecture).toContain('Client-named subscriptions are open by default');
		expect(architecture).toContain('`TOPIC_WS_COUNTS_WARN_THRESHOLD` warns at its threshold');
		expect(architecture).toContain('Without a configured breaker');
		expect(prose).toContain('A warn-only threshold is not a memory bound');
		expect(prose).toContain('A circuit breaker is optional');
	});

	it('rejects inverse responsibility and guarantee claims', () => {
		for (const contradiction of [
			/authenticated by default/i,
			/subscriptions are closed by default/i,
			/all (?:registries|maps|state) (?:are|is) bounded/i,
			/every publish (?:has|receives) (?:a )?global order/i,
			/(?:automatically|always) fall(?:s)? back to local state/i,
			/compatibility\.v1\.csv owns exact (?:git|artifact|digest|registry)/i
		]) {
			expect(architecture).not.toMatch(contradiction);
		}
	});

	it('routes exact release evidence to the release procedure and manifest', () => {
		expect(architecture).toContain('[`releasing.md`](./releasing.md)');
		expect(architecture).toContain('[release manifest](./release-manifest.md)');
		expect(prose).toContain('Use the [compatibility manifest](./compatibility.v1.csv) for supported release lines and the native tuple');
		expect(architecture).toContain('[coordinated release runbook](./operations/v1/coordinated-release.md)');
	});

	it('states the family memory-pressure contract', () => {
		expect(prose).toContain('the distance to the nearest memory wall: the worse of two arms');
		expect(prose).toContain('An engine that reports no ceiling contributes nothing on this arm.');
		expect(prose).toContain('The container arm compares the resident set with the cgroup memory limit (v2 `memory.max`, v1 `memory.limit_in_bytes`)');
		expect(prose).toContain('A known wall yields a 0..1 saturation');
		expect(prose).toContain('No discoverable wall means an unavailable measurement, not measured zero.');
		expect(prose).toContain('A known reading feeds the `MEMORY` reason, which outranks every other pressure reason, the `value` fold, the gauge and send-gate window sizing');
		expect(prose).toContain('The `heap_used_ratio` metric is absent when neither wall is available.');
		expect(prose).toContain('`memoryHeapUsedRatio` option name and its 0.85 default are shared across the family');
		expect(prose).toContain('Arena fullness (`heapUsed/heapTotal`) is not part of the contract on any engine.');
	});

	it('routes wire rationale to the protocol', () => {
		expect(prose).toContain('Wire-level rationale stays with the wire: [`PROTOCOL.md`](../PROTOCOL.md)');
		expect(read('PROTOCOL.md')).toContain('## Appendix D. Design rationale');
	});
});
