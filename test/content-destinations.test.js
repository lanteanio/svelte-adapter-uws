import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentationFiles, packageFiles } from '../scripts/check-links.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const README = read('README.md');
const PROTOCOL = read('PROTOCOL.md');
const VECTORS = read('test-vectors/README.md');
const CONFORMANCE = read('docs/protocol-conformance.md');
const BENCH = read('bench/README.md');
const PACKAGE = JSON.parse(read('package.json'));

describe('the protocol conformance destination', () => {
	it('is reachable from each parent and routes back to the normative surface', () => {
		expect(README).toContain('[protocol conformance](./docs/protocol-conformance.md)');
		expect(PROTOCOL).toContain('[conformance index](./docs/protocol-conformance.md)');
		expect(VECTORS).toContain('[conformance index](../docs/protocol-conformance.md)');
		expect(CONFORMANCE).toContain('[wire protocol](../PROTOCOL.md)');
		expect(CONFORMANCE).toContain('[Test-vector index](../test-vectors/README.md)');
	});

	it('makes every promised implementation artifact navigable', () => {
		for (const target of [
			'../protocol.schema.json',
			'../test-vectors/README.md',
			'../examples/minimal-client.mjs',
			'../src/client.js',
			'../src/runtime/wire.js',
			'../src/runtime/handler.js',
			'../src/vite.js',
			'../src/testing.js'
		]) {
			expect(CONFORMANCE, target).toContain('](' + target + ')');
		}
		for (const route of [
			'test/protocol-schema.test.js',
			'test/minimal-client.test.js',
			'test/relay-oracle.test.js',
			'.github/workflows/test.yml'
		]) {
			expect(CONFORMANCE, route).toContain(route);
		}
	});

	it('ships the index and every relative destination it promises', () => {
		const files = new Set(packageFiles());
		expect(files.has('docs/protocol-conformance.md')).toBe(true);
		for (const target of [
			'protocol.schema.json',
			'test-vectors/README.md',
			'examples/minimal-client.mjs',
			'src/client.js',
			'src/runtime/wire.js',
			'src/runtime/handler.js',
			'src/vite.js',
			'src/testing.js'
		]) {
			expect(files.has(target), target).toBe(true);
		}
	});

	it('pins the exact focused proof and its native-runtime caveat', () => {
		expect(CONFORMANCE).toContain('npm run doctor -- --require-uws');
		expect(CONFORMANCE).toContain('npm exec vitest -- run test/protocol-schema.test.js test/minimal-client.test.js test/relay-oracle.test.js');
		expect(CONFORMANCE).toContain('missing native addon otherwise turns real-runtime suites into skips');
		expect(CONFORMANCE).toContain('schema proves structural validity');
	});
});

describe('the benchmark reproduction destination', () => {
	it('maps the README claims to commands, outputs, and interpretation limits', () => {
		for (const command of [
			'node bench/run.mjs',
			'node bench/run-compare.mjs',
			'node bench/run-ws-only.mjs',
			'node bench/run-ws-compare.mjs',
			'node bench/run-dedup.mjs',
			'node bench/micro-wire-decode.mjs',
			'node bench/ws-compression-ab.mjs',
			'node bench/35-smooth-replay-ab.mjs',
			'node bench/micro-crdt-apply.mjs'
		]) {
			expect(BENCH, command).toContain('`' + command + '`');
		}
		expect(BENCH).toContain('| Claim or question | Exact command | Output | Interpretation limit |');
		expect(BENCH).toContain('Record this beside any number you cite:');
		expect(BENCH).toContain('Throughput without delivery, fan-out, error, backpressure, or recovery checks');
	});

	it('orients every benchmark script and cannot silently omit a new profile', () => {
		const scripts = readdirSync(new URL('../bench/', import.meta.url))
			.filter((name) => name.endsWith('.mjs')).sort();
		expect(scripts.length).toBeGreaterThan(50);
		for (const script of scripts) {
			const command = 'bench/' + script;
			const link = '](./' + script + ')';
			expect(BENCH.includes(command) || BENCH.includes(link), script).toBe(true);
		}
	});

	it('keeps development tooling repository-only and links it through a stable source route', () => {
		expect(PACKAGE.files).not.toContain('bench');
		expect(packageFiles().some((relative) => relative.startsWith('bench/'))).toBe(false);
		expect(README).toContain('https://github.com/lanteanio/svelte-adapter-uws/blob/main/bench/README.md');
		expect(README).not.toContain('](./bench/README.md)');
		expect(documentationFiles()).toContain('bench/README.md');
	});
});
