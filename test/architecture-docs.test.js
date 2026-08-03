import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentationFiles, packageFiles } from '../scripts/check-links.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const architecture = read('docs/architecture.md');
const index = read('docs/decisions/README.md');
const readme = read('README.md');
const officialLinks = '**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](https://svelte-realtime.dev/) | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.';
const decisions = [
	'protocol-compatibility',
	'native-runtime-baseline',
	'cluster-fanout-boundaries',
	'persistence-boundary',
	'release-coupling',
	'documentation-canonicality'
];

describe('ecosystem architecture documentation', () => {
	it('declares the official domain trust boundary at both public entry points', () => {
		const policy = architecture.replace(/\s+/g, ' ');
		expect(readme).toContain(officialLinks);
		expect(architecture).toContain(officialLinks);
		expect(architecture).toContain('Existing runtime\nslugs are preserved indefinitely');
		expect(architecture).toContain('is an identity and security migration');
		expect(policy).toContain(
			'Runtime `https://svti.me/<slug>` URLs are permanent compatibility surfaces that redirect to reviewed pages on the documentation site'
		);
		expect(policy).toContain(
			'Redirect destinations must carry the svelte-realtime family breadcrumb and routes back to the official owner, documentation, and demo.'
		);
	});

	it('ships the architecture contract and every indexed decision', () => {
		const shipped = new Set(packageFiles());
		const checked = new Set(documentationFiles());
		const decisionFiles = readdirSync(new URL('../docs/decisions/', import.meta.url))
			.filter((file) => file.endsWith('.md') && file !== 'README.md')
			.sort();
		expect(decisionFiles).toEqual(decisions.map((decision) => decision + '.md').sort());
		expect(shipped).toContain('docs/architecture.md');
		expect(checked).toContain('docs/architecture.md');
		for (const decision of decisions) {
			const relative = 'docs/decisions/' + decision + '.md';
			expect(shipped).toContain(relative);
			expect(checked).toContain(relative);
			expect(index).toContain('](./' + decision + '.md)');
			expect(architecture).toContain('](./decisions/' + decision + '.md)');
		}
	});

	it('keeps the complete contract reachable from both README routes', () => {
		const rows = readme.split('\n').map((line) =>
			line.split('|').map((cell) => cell.trim()).join('|')
		);
		expect(readme).toContain('[Architecture](./docs/architecture.md)');
		expect(readme).toContain('[ecosystem architecture](./docs/architecture.md)');
		expect(readme).toContain('[decision index](./docs/decisions/README.md)');
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
			'## Failure ownership',
			'## Release coupling',
			'## Accepted decisions'
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
		const persistence = read('docs/decisions/persistence-boundary.md');
		expect(persistence).toContain('A warn-only threshold is not a memory bound');
		expect(persistence).toContain('A circuit breaker is optional');
	});

	it('rejects inverse responsibility and guarantee claims', () => {
		const corpus = [architecture, ...decisions.map((decision) => read('docs/decisions/' + decision + '.md'))].join('\n');
		for (const contradiction of [
			/authenticated by default/i,
			/subscriptions are closed by default/i,
			/all (?:registries|maps|state) (?:are|is) bounded/i,
			/every publish (?:has|receives) (?:a )?global order/i,
			/(?:automatically|always) fall(?:s)? back to local state/i,
			/compatibility\.v1\.csv owns exact (?:git|artifact|digest|registry)/i
		]) {
			expect(corpus).not.toMatch(contradiction);
		}
	});

	it('routes exact release evidence to the release procedure and manifest', () => {
		const release = read('docs/decisions/release-coupling.md');
		expect(release).toContain('[`releasing.md`](../releasing.md)');
		expect(release).toContain('[release manifest](../release-manifest.md)');
		expect(release).toContain('records supported package release lines and the adapter/native tuple');
	});

	it('routes wire rationale through the protocol-owned decision', () => {
		const protocol = read('PROTOCOL.md');
		expect(protocol).toContain('](./docs/decisions/protocol-compatibility.md)');
		expect(read('docs/decisions/protocol-compatibility.md')).toContain(
			'[`PROTOCOL.md`](../../PROTOCOL.md)'
		);
	});
});
