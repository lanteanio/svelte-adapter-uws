import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const README = read('README.md');
const REGISTER = read('docs/claim-register.md');

// The id lists are derived from the register's own chapter structure, so a new
// registered claim is governed without editing this file and a section that
// leaves the register cannot linger here as a stale expectation.
function chapterIds(heading) {
	const start = REGISTER.indexOf('\n## ' + heading + '\n');
	expect(start, heading).toBeGreaterThanOrEqual(0);
	const end = REGISTER.indexOf('\n## ', start + 1);
	const chapter = REGISTER.slice(start, end < 0 ? undefined : end);
	return [...chapter.matchAll(/^### (ADAPTER-[A-Z0-9-]+)$/gm)].map((match) => match[1]);
}

const measured = chapterIds('Retained measured claims');
const guarantees = chapterIds('Retained behavioral guarantees');
const faultEvidence = new Map([
	['ADAPTER-CORRECT-SEQUENCE', [
		'test/cluster-sequence-policy.test.js',
		'test/cluster-sequence-policy-real.test.js'
	]],
	['ADAPTER-CORRECT-GAME', [
		'test/game-cluster-policy.test.js',
		'test/game-cluster-policy-real.test.js'
	]],
	['ADAPTER-CORRECT-CURSOR-WIRE', [
		'test/wire-mode.test.js',
		'test/wire-dict.test.js',
		'test/wire-codec.test.js'
	]]
]);

function section(id) {
	const start = REGISTER.indexOf('### ' + id);
	const end = REGISTER.indexOf('\n### ', start + 4);
	return REGISTER.slice(start, end < 0 ? undefined : end);
}

// Numeric stems only: surfaces may phrase units differently (register
// "1.861M/s" versus README "1.861M events/s"), but the numeral itself must be
// byte-identical on both surfaces.
function figureTokens(text) {
	return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => match[0]);
}

// Register-owned figures must appear, unchanged, in the README block that sits
// beside the register anchor. Editing a number on either surface alone fails:
// the register-side value disappears from the README block either way.
function measuredFigureDrift(readmeText) {
	const failures = [];
	for (const id of measured) {
		const registered = section(id);
		const measuredStart = registered.indexOf('**Measured:**');
		const measuredEnd = registered.indexOf('**Conditions:**');
		if (measuredStart < 0 || measuredEnd <= measuredStart) {
			failures.push(`${id}: register section is missing the Measured/Conditions pattern`);
			continue;
		}
		const registerFigures = figureTokens(registered.slice(measuredStart, measuredEnd));
		if (registerFigures.length === 0) {
			failures.push(`${id}: register Measured paragraph carries no figure`);
			continue;
		}
		const anchor = `](./docs/claim-register.md#${id.toLowerCase()})`;
		const anchorAt = readmeText.indexOf(anchor);
		if (anchorAt < 0) {
			failures.push(`${id}: README is missing the register anchor`);
			continue;
		}
		const blockStart = readmeText.lastIndexOf('**Measured:**', anchorAt);
		if (blockStart < 0) {
			failures.push(`${id}: README anchor has no adjacent Measured block`);
			continue;
		}
		const readmeFigures = figureTokens(readmeText.slice(blockStart, anchorAt));
		for (const figure of registerFigures) {
			if (!readmeFigures.includes(figure)) {
				failures.push(`${id}: register figure ${figure} is absent from the adjacent README block`);
			}
		}
	}
	return failures;
}

describe('adapter claim register', () => {
	it('derives non-empty, disjoint id sets from the register structure', () => {
		expect(measured.length).toBeGreaterThanOrEqual(6);
		expect(guarantees.length).toBeGreaterThanOrEqual(7);
		expect(new Set([...measured, ...guarantees]).size).toBe(measured.length + guarantees.length);
		const allIds = [...REGISTER.matchAll(/^### (ADAPTER-[A-Z0-9-]+)$/gm)].map((match) => match[1]);
		expect(allIds.sort()).toEqual([...measured, ...guarantees].sort());
		for (const id of faultEvidence.keys()) expect(guarantees).toContain(id);
	});

	it('keeps every registered measured figure present in the adjacent README block', () => {
		expect(measuredFigureDrift(README)).toEqual([]);
	});

	it('fails when a shared figure changes on only one surface', () => {
		const readmeOnlyDrift = README.replaceAll('14.6x', '14.7x');
		expect(readmeOnlyDrift).not.toBe(README);
		expect(measuredFigureDrift(readmeOnlyDrift).join(' ')).toContain('14.6');

		const registerFigures = figureTokens(section('ADAPTER-PERF-CURSOR'));
		expect(registerFigures).toContain('14.6');
		expect(registerFigures).not.toContain('14.7');
	});

	it('gives every measurement the complete visible evidence pattern', () => {
		for (const id of measured) {
			const value = section(id);
			expect(value, id).toContain('**Measured:**');
			expect(value, id).toContain('**Conditions:**');
			expect(value, id).toContain('**Reproduce:**');
		}
	});

	it('bounds every behavioral promise by prerequisites and executable proof', () => {
		for (const id of guarantees) {
			const value = section(id);
			expect(value, id).toContain('**Guarantee:**');
			expect(value, id).toContain('**Requires:**');
			expect(value, id).toContain('**Verified:**');
			for (const file of faultEvidence.get(id) || []) {
				expect(value, id + ' evidence').toContain(file);
				expect(read(file).length, file).toBeGreaterThan(0);
			}
		}
	});

	it('keeps the public README adjacent patterns and register route visible', () => {
		const adjacentGuaranteeFloor = 4 + faultEvidence.size;
		expect(README).toContain('[claim register](./docs/claim-register.md)');
		for (const id of measured) {
			expect(README).toContain(`](./docs/claim-register.md#${id.toLowerCase()})`);
		}
		for (const id of faultEvidence.keys()) {
			expect(README).toContain(`](./docs/claim-register.md#${id.toLowerCase()})`);
		}
		expect(README.match(/\*\*Measured:\*\*/g)).toHaveLength(measured.length);
		expect(README.match(/\*\*Conditions:\*\*/g)).toHaveLength(measured.length);
		expect(README.match(/\*\*Reproduce:\*\*/g)).toHaveLength(measured.length);
		expect(README.match(/\*\*Guarantee:\*\*/g).length).toBeGreaterThanOrEqual(adjacentGuaranteeFloor);
		expect(README.match(/\*\*Requires:\*\*/g).length).toBeGreaterThanOrEqual(adjacentGuaranteeFloor);
		expect(README.match(/\*\*Verified:\*\*/g).length).toBeGreaterThanOrEqual(adjacentGuaranteeFloor);
	});

	it('does not let the adjudicated unsupported claims return', () => {
		for (const stale of [
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
			expect(README.toLowerCase(), stale).not.toContain(stale.toLowerCase());
		}
	});

	it('records the absence of any adoption or popularity claim', () => {
		expect(REGISTER).toContain('No adoption count, popularity rank, or ecosystem-usage claim is active');
	});
});
