// The contributor map gate derives its inventories from the tree. This drives
// the gate itself, because it shipped green over a contradiction it was written
// to catch: the preamble and the lane table both called `verify:pr` the
// hosted-gate equivalent while the inventory three paragraphs below correctly
// said it is not.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	findProblems,
	hostedLanes,
	verifyPrLanes
} from '../scripts/check-contributor-map.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const realInputs = () => ({
	contributing: read('CONTRIBUTING.md'),
	pkg: JSON.parse(read('package.json')),
	workflow: parse(read('.github/workflows/test.yml'))
});

const equivalenceProblems = (inputs) =>
	findProblems(inputs).problems.filter((problem) => /hosted[- ]gate|hosted gate/i.test(problem));

describe('contributor map', () => {
	it('describes the repository that exists', () => {
		expect(findProblems(realInputs()).problems).toEqual([]);
	});

	it('expands verify:pr and the hosted lanes from their real sources', () => {
		const { pkg, workflow } = realInputs();
		expect(verifyPrLanes(pkg.scripts).sort()).toEqual(['verify:sim', 'verify:suite']);
		// The support-floor job runs `npm run check`, `build` and `smoke` inside
		// the locked Svelte 4 application. Counting another package's scripts as
		// this one's lanes would invent a difference that does not exist.
		const hosted = hostedLanes(workflow);
		expect(hosted).toContain('verify:suite');
		expect(hosted).not.toContain('smoke');
		expect(hosted).not.toContain('build');
	});

	it('rejects the claim that verify:pr is the hosted-gate equivalent', () => {
		const inputs = realInputs();
		inputs.contributing = inputs.contributing.replace(
			'Normal pre-PR default and the strongest single local signal, but NOT the hosted gate',
			'Normal pre-PR default and the hosted-gate equivalent'
		);
		expect(equivalenceProblems(inputs).join('\n')).toContain('hosted-gate equivalent');
	});

	it('rejects a map that simply omits the disclaimer, not only the known wording', () => {
		const inputs = realInputs();
		inputs.contributing = inputs.contributing.replaceAll('is not the hosted gate', 'is a fine thing');
		const problems = equivalenceProblems(inputs);
		expect(problems.join('\n')).toContain('never states that verify:pr is not the hosted gate');
	});

	it('stays silent when verify:pr really does equal the hosted lanes', () => {
		// Without this, the gate would be asserting a permanent truth about this
		// repository rather than a relationship between two lists, and it would
		// keep firing after someone legitimately made them agree.
		const inputs = realInputs();
		inputs.pkg = {
			...inputs.pkg,
			scripts: { ...inputs.pkg.scripts, 'verify:pr': 'npm run verify:suite' }
		};
		inputs.workflow = { jobs: { suite: { steps: [{ run: 'npm run verify:suite' }] } } };
		inputs.contributing = inputs.contributing.replaceAll('is not the hosted gate', 'is a fine thing');
		expect(equivalenceProblems(inputs)).toEqual([]);
	});
});
