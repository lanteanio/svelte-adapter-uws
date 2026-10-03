import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const README = read('README.md').replace(/\r\n/g, '\n');

// A README claim is either a measurement (Measured, Conditions, Reproduce) or a
// behavioral promise (Guarantee, Requires, Verified). Each block carries its
// labels in that order before the next block of its kind begins, and every
// label belongs to exactly one block.
const MEASUREMENT = ['Measured', 'Conditions', 'Reproduce'];
const PROMISE = ['Guarantee', 'Requires', 'Verified'];
const TEST_FILE = /\btest\/[\w./-]+\.test\.js\b/g;
const BENCH_FILE = /\bbench\/[\w./-]+\.mjs\b/g;

// Suites the clustered-delivery and cursor-wire promises must keep naming in
// their own Verified clause, so a promise cannot quietly swap its proof for a
// weaker suite. Each promise is found by the opening of its Guarantee text.
const PINNED_PROOF = [
	['An implicit topic sequence is monotonic', ['test/cluster-sequence-policy.test.js', 'test/cluster-sequence-policy-real.test.js']],
	['The built-in game lane either uses one socket-owning', ['test/game-cluster-policy.test.js', 'test/game-cluster-policy-real.test.js']],
	['From one publish, the server sends the dictionary form', ['test/wire-mode.test.js', 'test/wire-dict.test.js', 'test/wire-codec.test.js']]
];

function blocks(text, lead) {
	return text.split('**' + lead + ':**').slice(1);
}

function count(text, label) {
	return blocks(text, label).length;
}

function patternFailures(text, [lead, ...labels]) {
	const failures = [];
	for (const label of labels) {
		if (count(text, label) !== count(text, lead)) {
			failures.push(`${count(text, label)} ${label} labels for ${count(text, lead)} ${lead} blocks`);
		}
	}
	blocks(text, lead).forEach((block, index) => {
		let at = 0;
		for (const label of labels) {
			const next = block.indexOf('**' + label + ':**', at);
			if (next < 0) {
				failures.push(`${lead} block ${index + 1} has no ${label} after its earlier labels`);
				break;
			}
			at = next;
		}
	});
	return failures;
}

// The clause a label opens: up to the next claim label, blank line, list item,
// heading or fence, so a clause never borrows evidence from the text after it.
const CLAUSE_END = /\*\*(?:Measured|Conditions|Reproduce|Guarantee|Requires|Verified):\*\*|\n\s*(?:\n|[-*+] |\d+[.)] |#|```|~~~)/;

function clause(block) {
	return block.split(CLAUSE_END)[0];
}

function clauses(text, label) {
	return blocks(text, label).map(clause);
}

// The Verified clause of the promise whose Guarantee text opens with `opening`.
function proofOf(text, opening) {
	const block = blocks(text, 'Guarantee').find((candidate) => candidate.trimStart().startsWith(opening));
	if (block === undefined) return undefined;
	const verified = block.split('**Verified:**')[1];
	return verified === undefined ? undefined : clause(verified);
}

// Every Verified clause names at least one suite and every Reproduce clause at
// least one bench, and each named file exists.
function evidenceFailures(text) {
	const failures = [];
	for (const [label, pattern, kind] of [['Verified', TEST_FILE, 'suite'], ['Reproduce', BENCH_FILE, 'bench']]) {
		clauses(text, label).forEach((body, index) => {
			const named = [...body.matchAll(pattern)].map((match) => match[0]);
			if (named.length === 0) failures.push(`${label} clause ${index + 1} names no ${kind}`);
			for (const file of named) {
				if (!existsSync(new URL('../' + file, import.meta.url))) failures.push(`${label} clause ${index + 1} names missing ${file}`);
			}
		});
	}
	return failures;
}

describe('README claims', () => {
	it('gives every measurement its conditions and reproduction command', () => {
		expect(count(README, 'Measured')).toBeGreaterThanOrEqual(6);
		expect(patternFailures(README, MEASUREMENT)).toEqual([]);
	});

	it('bounds every behavioral promise by prerequisites and executable proof', () => {
		expect(count(README, 'Guarantee')).toBeGreaterThanOrEqual(7);
		expect(patternFailures(README, PROMISE)).toEqual([]);
	});

	it('names an existing suite or bench as the evidence for every claim', () => {
		expect(evidenceFailures(README)).toEqual([]);
	});

	it('keeps each pinned promise proved by its own suites', () => {
		for (const [opening, suites] of PINNED_PROOF) {
			const proof = proofOf(README, opening);
			expect(proof, opening).toBeTypeOf('string');
			for (const suite of suites) expect(proof, opening).toContain(suite);
		}
	});

	it('detects a claim that lost a label or its evidence', () => {
		const noConditions = README.replace('**Conditions:**', '**Notes:**');
		expect(patternFailures(noConditions, MEASUREMENT).join(' ')).toContain('no Conditions');

		const noVerified = README.replace('**Verified:**', '**Checked:**');
		expect(patternFailures(noVerified, PROMISE).join(' ')).toContain('Verified labels');

		const unproven = README.replace(
			'Run `npm exec vitest -- run test/game-cluster-policy.test.js test/game-cluster-policy-real.test.js`;\n',
			''
		);
		expect(unproven).not.toBe(README);
		expect(evidenceFailures(unproven).join(' ')).toContain('names no suite');

		const renamed = README.replace('test/game-cluster-policy-real.test.js', 'test/game-cluster-policy-gone.test.js');
		expect(evidenceFailures(renamed).join(' ')).toContain('names missing test/game-cluster-policy-gone.test.js');

		const noBench = README.replace('Run `node bench/run-dedup.mjs`;', 'Run the dedup runner;');
		expect(noBench).not.toBe(README);
		expect(evidenceFailures(noBench).join(' ')).toContain('names no bench');

		// The suite stays named inside the promise's own section, one paragraph
		// after its Verified clause, so only the clause boundary keeps it out.
		const moved = README.replace(
			'Run `npm exec vitest -- run test/game-cluster-policy.test.js test/game-cluster-policy-real.test.js`;\n',
			'Run `npm exec vitest -- run test/game-cluster-policy.test.js`;\n'
		).replace(
			'the allowed single-home topologies.\n',
			'the allowed single-home topologies.\n\nSee also test/game-cluster-policy-real.test.js.\n'
		);
		expect(moved).toContain('test/game-cluster-policy-real.test.js');
		expect(proofOf(moved, PINNED_PROOF[1][0])).toContain('test/game-cluster-policy.test.js');
		expect(proofOf(moved, PINNED_PROOF[1][0])).not.toContain('test/game-cluster-policy-real.test.js');
	});

	it('ends a clause before the next claim label, list item, heading or fence', () => {
		for (const follower of ['\n\nsee test/fd-limit.test.js', '\n- see test/fd-limit.test.js', '\n1. see test/fd-limit.test.js', '\n1) see test/fd-limit.test.js', '\n+ see test/fd-limit.test.js', '\n## test/fd-limit.test.js', '\n```\ntest/fd-limit.test.js', '\n~~~\ntest/fd-limit.test.js', ' **Guarantee:** c, see test/fd-limit.test.js. **Requires:** d. **Verified:** test/fd-limit.test.js']) {
			const text = '**Guarantee:** a. **Requires:** b. **Verified:** by hand.' + follower + '\n';
			expect(evidenceFailures(text)[0], follower).toBe('Verified clause 1 names no suite');
		}
	});

	it('keeps unsupported performance claims out of the README', () => {
		for (const unsupported of [
			'consistently outperforms',
			'every other JavaScript HTTP server',
			'matches uWS native WebSocket throughput',
			'near-zero overhead',
			'zero per-request cost',
			'costs nothing on topics',
			'JSON-only deployments pay nothing',
			'can handle hundreds of thousands of connections',
			'full CPU core per topic',
			'retains ~68%',
			'165,700 req/s',
			'3,583,000',
			'200x reduction in CPU and memory pressure'
		]) {
			expect(README.toLowerCase(), unsupported).not.toContain(unsupported.toLowerCase());
		}
	});

	it('makes no adoption or popularity claim', () => {
		for (const adoption of [
			/\b[\d.,]+\s*[km]?\+?\s+(?:weekly |monthly )?downloads\b/i,
			/\b(?:weekly|monthly) downloads\b/i,
			/\bgithub stars\b|\bstars on github\b/i,
			/\bused by (?:[\d.,]+|thousands|hundreds|millions|many|major|leading|companies|teams)\b/i,
			/\bused in production\b|\bin production at\b/i,
			/\btrusted by\b|\badopted by\b|\bmost popular\b|\bbattle[- ]tested\b|\bindustry[- ]standard\b/i
		]) {
			expect(README, String(adoption)).not.toMatch(adoption);
		}
	});
});
