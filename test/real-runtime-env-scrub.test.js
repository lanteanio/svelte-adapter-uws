// The eval-time env list in the real-runtime helper must not fall behind the
// runtime it is protecting.
//
// `startRealRuntime` scrubs every environment variable the built runtime reads
// at module eval before importing it, so a suite cannot inherit one from the
// suite that ran before it or from the developer's shell. That scrub is only as
// complete as its list, and the list is hand-written: a new `env('SOMETHING')`
// in the runtime's config would silently reopen the hole, and the symptom would
// be the one that is hardest to read - a suite that passes while testing a
// server it did not ask for.
//
// This is the same class the sweep already paid for once: two suites were made
// to fail by an inherited ADDRESS_HEADER, and running them in the other order
// passed while testing the wrong configuration.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';
import {
	EVAL_TIME_ENV,
	OBSERVABLE,
	UNOBSERVABLE_EVAL_TIME_ENV,
	evalTimeEnvMismatches
} from './helpers/real-runtime.js';

const CONFIG = 'src/runtime/handler/config.js';

describe('the real-runtime env scrub covers every eval-time knob', () => {
	it(`names every env(...) read in ${CONFIG}`, () => {
		const src = readFileSync(new URL(`../${CONFIG}`, import.meta.url), 'utf8');
		const read = [...src.matchAll(/\benv\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
		expect(read.length, 'the matcher must find the config reads at all').toBeGreaterThan(5);

		const missing = [...new Set(read)].filter((k) => !EVAL_TIME_ENV.includes(k)).sort();
		expect(
			missing,
			`${CONFIG} reads these at module eval but startRealRuntime does not scrub them, so a suite ` +
			`can inherit them from whatever ran before it: ${missing.join(', ')}. Add them to EVAL_TIME_ENV ` +
			'in test/helpers/real-runtime.js.'
		).toEqual([]);
	});

	it('does not carry entries that no longer exist, which would be dead weight', () => {
		// The reverse direction is not an error, only rot: CLUSTER_WORKERS and
		// CLUSTER_MODE are deliberately listed without being config.js reads,
		// because they change the topology at boot.
		const DELIBERATE = ['CLUSTER_WORKERS', 'CLUSTER_MODE'];
		const src = readFileSync(new URL(`../${CONFIG}`, import.meta.url), 'utf8');
		const read = new Set([...src.matchAll(/\benv\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]));
		const orphans = EVAL_TIME_ENV.filter((k) => !read.has(k) && !DELIBERATE.includes(k));
		expect(orphans, `no longer read by ${CONFIG}: ${orphans.join(', ')}`).toEqual([]);
	});

	// config.js is not the only module evaluated by the built handler. Scanning
	// only that file left `src/runtime/handler.js`'s own top-level `env('XFF_DEPTH')`
	// and `env('BODY_SIZE_LIMIT')` unguarded: both happen to be in EVAL_TIME_ENV by
	// coincidence, so the test that exists to stop a knob going missing would not
	// have noticed a NEW one there.
	//
	// Top-level reads only, found with acorn rather than a regex: a read inside a
	// request handler runs per request and is not an eval-time knob, and a
	// hand-rolled scanner cannot tell the two apart (nor a regex literal from a
	// division, which is how an earlier one in this repo ate 42,000 characters).
	// SCOPED TO THE GRAPH THE HARNESS ACTUALLY IMPORTS, which is `handler.js` and
	// its transitive relative imports. Scanning the runtime directory instead
	// reports the eight knobs in `src/runtime/index.js` (HOST, PORT,
	// SHUTDOWN_TIMEOUT, the cluster ones), and every one is a false positive:
	// index.js is the server BOOT entry and nothing imports it from handler.js, so
	// no amount of scrubbing before the handler import could matter to it.
	it('names every MODULE-EVAL env(...) read in the handler import graph', () => {
		/** @type {Map<string, string[]>} */
		const found = new Map();

		for (const rel of importGraphFrom('src/runtime/handler.js')) {
			const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
			const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
			for (const key of topLevelEnvReads(ast)) {
				if (!found.has(key)) found.set(key, []);
				found.get(key).push(rel);
			}
		}

		expect(found.size, 'the scanner must find eval-time reads at all').toBeGreaterThan(5);
		// The reads that live OUTSIDE config.js are the reason this test exists at
		// all; if they ever stop being found, the scan has silently narrowed.
		expect(
			found.get('XFF_DEPTH'),
			'handler.js reads XFF_DEPTH at module eval - if this no longer shows up, the graph walk broke'
		).toContain('src/runtime/handler.js');
		const missing = [...found.keys()].filter((k) => !EVAL_TIME_ENV.includes(k)).sort();
		expect(
			missing,
			`read at module eval but not scrubbed by startRealRuntime: ${missing
				.map((k) => `${k} (${found.get(k).join(', ')})`)
				.join('; ')}. Add them to EVAL_TIME_ENV in test/helpers/real-runtime.js.`
		).toEqual([]);
	});

	// Every knob must be either comparable or declared uncomparable, so a new one
	// cannot land in a blind spot. OBSERVABLE previously covered 8 of the 18 and
	// nothing said which 10 were missing or why.
	it('classifies every scrubbed knob as observable or explicitly not', () => {
		const observable = OBSERVABLE.map((entry) => entry.env);
		const unclassified = EVAL_TIME_ENV.filter(
			(k) => !observable.includes(k) && !UNOBSERVABLE_EVAL_TIME_ENV.includes(k)
		);
		expect(
			unclassified,
			`these are scrubbed but the post-import guard cannot see them, and they are not ` +
			`declared unobservable either: ${unclassified.join(', ')}. Either read the value back ` +
			'off handler/config.js in OBSERVABLE, or add it to UNOBSERVABLE_EVAL_TIME_ENV with the reason.'
		).toEqual([]);

		// And the reverse: an entry claiming to be observable must name a knob that
		// is actually scrubbed, or it is checking something no boot controls.
		const stray = observable.filter((k) => !EVAL_TIME_ENV.includes(k));
		expect(stray, `observable but never scrubbed: ${stray.join(', ')}`).toEqual([]);
	});
});

describe('the post-import guard compares values, not merely presence', () => {
	// What `handler/config.js` exports when no eval-time env is set. The real
	// module always exports every one of these, so a partial object here would
	// test a shape production never produces.
	const BOOTED_WITH_NOTHING_SET = {
		ssl_cert: '', ssl_key: '', is_tls: false, ssl_watch: false,
		ssl_reload_debounce_ms: 500, ssl_sni_hosts: [], origin: undefined,
		address_header: '', protocol_header: '', host_header: '', port_header: '',
		body_size_limit: 524288, xff_depth: 1, proxy_protocol: false,
		reconnect_dispersal_ms: 5000, wsDebug: false,
		trusted_proxies: () => false
	};
	const booted = (overrides) => ({ ...BOOTED_WITH_NOTHING_SET, ...overrides });

	// THE EXACT FAILURE THE GUARD WAS WRITTEN FOR, one level down. Two suites both
	// set ADDRESS_HEADER, so presence agreed and the previous guard passed - while
	// the second suite drove a server configured by the first.
	it('catches two boots that disagree on the VALUE of one knob', () => {
		const mismatches = evalTimeEnvMismatches(
			booted({ address_header: 'x-forwarded-for' }),
			{ ADDRESS_HEADER: 'x-real-ip' }
		);
		expect(mismatches.join(' | ')).toContain('ADDRESS_HEADER');
		expect(mismatches.join(' | ')).toContain('x-real-ip');
		expect(mismatches.join(' | ')).toContain('x-forwarded-for');
	});

	it('stays silent when the booted value is the one that was asked for', () => {
		expect(
			evalTimeEnvMismatches(booted({ address_header: 'x-real-ip' }), { ADDRESS_HEADER: 'x-real-ip' })
		).toEqual([]);
	});

	// A knob left unset reads back as its DEFAULT. Comparing against absence
	// instead would make every ordinary boot look like a mismatch, which is the
	// trap that pushed the original version to presence-only in the first place.
	it('accepts a default-valued config when the caller named nothing', () => {
		expect(evalTimeEnvMismatches(booted({}), {})).toEqual([]);
	});

	// The original catch must keep working: nothing asked for TLS, module has it.
	it('still catches a cached TLS module when the caller asked for plaintext', () => {
		const mismatches = evalTimeEnvMismatches(
			booted({ ssl_cert: '/tmp/c.pem', ssl_key: '/tmp/k.pem', is_tls: true, ssl_watch: true }),
			{}
		);
		expect(mismatches.join(' | ')).toContain('SSL_CERT');
	});

	// Numbers and booleans are parsed values, so a naive string compare reports a
	// mismatch on a correct boot. Both directions pinned.
	it('compares parsed numbers and booleans through the production parsers', () => {
		expect(
			evalTimeEnvMismatches(
				booted({ body_size_limit: 1048576, xff_depth: 3, proxy_protocol: true }),
				{ BODY_SIZE_LIMIT: '1M', XFF_DEPTH: '3', PROXY_PROTOCOL: '1' }
			)
		).toEqual([]);

		const wrong = evalTimeEnvMismatches(
			booted({}),
			{ BODY_SIZE_LIMIT: '1M', XFF_DEPTH: '3', PROXY_PROTOCOL: '1' }
		);
		expect(wrong).toHaveLength(3);
	});

	// A list-valued knob, which normalizes to a joined string on both sides.
	it('compares the SNI host list element by element', () => {
		expect(
			evalTimeEnvMismatches(
				booted({ ssl_sni_hosts: ['a.example', 'b.example'] }),
				{ SSL_SNI_HOSTS: 'A.example, b.example' }
			)
		).toEqual([]);
		expect(
			evalTimeEnvMismatches(booted({ ssl_sni_hosts: ['a.example'] }), { SSL_SNI_HOSTS: 'b.example' })
		).toHaveLength(1);
	});
});

/**
 * Every repo-relative source file reachable from `entry` by static relative
 * imports, `entry` included.
 *
 * Follows imports rather than reading a directory because the question is what
 * the harness EVALUATES when it imports the built handler, and a sibling file
 * nothing imports contributes no eval-time read.
 *
 * @param {string} entry - repo-relative path
 * @returns {string[]}
 */
function importGraphFrom(entry) {
	const seen = new Set();
	const queue = [entry];

	while (queue.length > 0) {
		const rel = queue.pop();
		if (seen.has(rel)) continue;
		seen.add(rel);

		const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
		const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
		const dir = rel.slice(0, rel.lastIndexOf('/'));

		for (const node of ast.body) {
			const spec =
				(node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
					node.type === 'ExportAllDeclaration') && node.source
					? node.source.value
					: null;
			if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
			// Resolve against the importer's directory, collapsing `..` segments.
			const parts = `${dir}/${spec}`.split('/');
			/** @type {string[]} */
			const resolved = [];
			for (const part of parts) {
				if (part === '.' || part === '') continue;
				if (part === '..') resolved.pop();
				else resolved.push(part);
			}
			const target = resolved.join('/');
			// A build-time placeholder import (SERVER, MANIFEST) has no source file.
			try {
				readFileSync(new URL(`../${target}`, import.meta.url));
			} catch {
				continue;
			}
			queue.push(target);
		}
	}
	return [...seen];
}

/**
 * Env keys read by a top-level `env('X')` call - not one inside any function.
 *
 * @param {any} ast
 * @returns {string[]}
 */
function topLevelEnvReads(ast) {
	/** @type {string[]} */
	const keys = [];
	const FUNCTIONS = new Set([
		'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody'
	]);

	/** @param {any} node */
	const walk = (node) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.type !== 'string') return;
		// A read that only runs when something calls it is not an eval-time read.
		if (FUNCTIONS.has(node.type)) return;
		if (
			node.type === 'CallExpression' &&
			node.callee?.type === 'Identifier' &&
			node.callee.name === 'env' &&
			node.arguments?.[0]?.type === 'Literal' &&
			typeof node.arguments[0].value === 'string'
		) {
			keys.push(node.arguments[0].value);
		}
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
			walk(node[key]);
		}
	};

	walk(ast);
	return keys;
}
