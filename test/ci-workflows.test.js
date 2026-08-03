// The checked-in workflows, asserted as a contract rather than read as prose.
//
// Every claim here is one a CI file can silently stop honouring: a path filter
// that no longer covers an artifact the workflow promises to validate skips the
// job rather than failing it, and a floating action tag or a floating Node major
// changes what ran without changing this repository. None of that is visible in
// a green check mark, which is why it is pinned here.
//
// Dependency-free: the assertions read the workflow text directly rather than
// pulling a YAML parser into the tree for it, the same way the scripts/check-*
// gates read what they check.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANES } from '../scripts/verify.js';

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8');

const testWorkflow = read('.github/workflows/test.yml');
const simWorkflow = read('.github/workflows/sim-swarm.yml');
const nvmrc = read('.nvmrc').trim();
const pkg = JSON.parse(read('package.json'));
const svelte4Lock = JSON.parse(read('test/fixtures/svelte4/package-lock.json'));

/**
 * The quoted entries of one `paths:` list, identified by the trigger block it
 * sits under. Indentation is the block boundary, which is what YAML means by it.
 */
function pathsUnder(workflow, trigger) {
	const lines = workflow.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === trigger + ':');
	expect(start, `${trigger}: not found`).toBeGreaterThan(-1);
	const pathsAt = lines.findIndex((l, i) => i > start && l.trim() === 'paths:');
	expect(pathsAt, `paths: not found under ${trigger}`).toBeGreaterThan(-1);
	const out = [];
	for (let i = pathsAt + 1; i < lines.length; i++) {
		const m = /^\s+- '([^']+)'\s*$/.exec(lines[i]);
		if (m) { out.push(m[1]); continue; }
		// A comment or a blank line is inside the block, not the end of it.
		if (lines[i].trim() === '' || lines[i].trim().startsWith('#')) continue;
		break;
	}
	return out;
}

/** Every `uses:` reference in a workflow, as written. */
function actionRefs(workflow) {
	return [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
}

describe('the Node baseline is one pinned version', () => {
	it('.nvmrc names a concrete patch release', () => {
		expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('the baseline satisfies the published engines floor', () => {
		const floor = pkg.engines.node.replace(/[^0-9.]/g, '').split('.').map(Number);
		const baseline = nvmrc.split('.').map(Number);
		expect(baseline[0]).toBeGreaterThanOrEqual(floor[0]);
	});

	it('both workflows resolve their Node version from that file, not a literal', () => {
		for (const [name, workflow] of [['test', testWorkflow], ['sim-swarm', simWorkflow]]) {
			expect(workflow, `${name} pins a literal node-version`).not.toMatch(/node-version:\s*'/);
			expect(workflow, `${name} does not read .nvmrc`).toContain("node-version-file: '.nvmrc'");
		}
	});

	it('a baseline change re-runs the suite', () => {
		expect(pathsUnder(testWorkflow, 'pull_request')).toContain('.nvmrc');
	});
});

describe('the suite lane demands the real runtime', () => {
	// The addon is optional and npm skips it silently, so a lane that merely
	// runs the suite can be green having run none of the suites that matter.
	// This is asserted on the lane rather than on the workflow because the lane
	// is what both the workflow and a contributor run.
	const suite = LANES.suite;

	it('diagnoses the machine before spending the suite on it', () => {
		const doctor = suite.find((step) => step.script === 'doctor');
		expect(doctor).toBeTruthy();
		expect(doctor.args).toContain('--require-uws');
		expect(suite.indexOf(doctor)).toBe(0);
	});

	it('runs the test step with REQUIRE_UWS set', () => {
		const test = suite.find((step) => step.script === 'test');
		expect(test.env.REQUIRE_UWS).toBe('1');
	});

	it('runs the product smoke exactly once, inside the test run', () => {
		// The smoke checkpoint boots the real built runtime, which the test
		// run already does; spawning it as its own lane step ran the same
		// build and the same exchange a second time. It lives in
		// test/smoke-command.test.js, so the lane must NOT repeat it.
		expect(suite.some((step) => step.script === 'smoke')).toBe(false);
		expect(
			existsSync(new URL('./smoke-command.test.js', import.meta.url)),
			'the smoke checkpoint must still be covered by the suite it moved into'
		).toBe(true);
		const doctor = suite.find((step) => step.script === 'doctor');
		const test = suite.find((step) => step.script === 'test');
		expect(suite.indexOf(doctor)).toBeLessThan(suite.indexOf(test));
	});

	it('runs both packed publishing analyzers before the test suite', () => {
		const publish = suite.find((step) => step.script === 'check:publish');
		const test = suite.find((step) => step.script === 'test');
		expect(publish).toBeTruthy();
		expect(suite.indexOf(publish)).toBeLessThan(suite.indexOf(test));
		expect(pkg.scripts['check:publish']).toBe('publint && attw --pack . --profile esm-only');
		expect(pkg.devDependencies.publint).toBeTruthy();
		expect(pkg.devDependencies['@arethetypeswrong/cli']).toBeTruthy();
	});
});

describe('third-party actions are pinned to an immutable commit', () => {
	// A tag is a moving pointer: `@v4` re-resolves on every run, so the code that
	// checks out the tree and runs it can change without a commit here.
	it('every uses: names a full 40-character commit SHA', () => {
		for (const [name, workflow] of [['test', testWorkflow], ['sim-swarm', simWorkflow]]) {
			for (const ref of actionRefs(workflow)) {
				expect(ref, `${name}: ${ref} is not pinned to a commit`).toMatch(/@[0-9a-f]{40}$/);
			}
		}
	});
});

describe('the workflows cannot be bypassed by editing what they validate', () => {
	const testPaths = pathsUnder(testWorkflow, 'pull_request');
	const simPaths = pathsUnder(simWorkflow, 'pull_request');

	it('covers the protocol artifacts whose CI validation is a published promise', () => {
		for (const artifact of ['PROTOCOL.md', 'protocol.schema.json', 'test-vectors/**', 'examples/**']) {
			expect(testPaths, `${artifact} triggers no job`).toContain(artifact);
		}
	});

	it('covers every Markdown-only change read by the link gate', () => {
		expect(testPaths).toContain('**/*.md');
	});

	it('covers a lock-only change in both workflows', () => {
		expect(testPaths).toContain('package-lock.json');
		expect(simPaths).toContain('package-lock.json');
	});

	it('re-runs each workflow when that workflow itself changes', () => {
		expect(testPaths).toContain('.github/workflows/test.yml');
		expect(simPaths).toContain('.github/workflows/sim-swarm.yml');
	});
});

describe('the hosted gate and the local command are the same command', () => {
	// "It passed locally" and "CI is green" have to mean the same thing, so the
	// workflows invoke the published verify lanes verbatim instead of spelling
	// out steps that can drift from what a contributor is told to run.
	it('publishes the lanes as scripts', () => {
		for (const lane of ['verify:fast', 'verify:suite', 'verify:sim', 'verify:pr', 'verify:full']) {
			expect(pkg.scripts[lane], `${lane} is not a script`).toBeTruthy();
		}
	});

	it('the suite job runs the suite lane and the sim job runs the sim lane', () => {
		expect(testWorkflow).toMatch(/run: npm run verify:suite/);
		expect(simWorkflow).toMatch(/run: npm run verify:sim/);
	});

	it('verify:pr is exactly the union of the hosted lanes', () => {
		expect(pkg.scripts['verify:pr']).toBe('npm run verify:suite && npm run verify:sim');
	});
});

describe('the protocol-conformance promise is what CI actually runs', () => {
	// The spec says the schema, the vectors and the minimal client are validated
	// in CI against the reference implementation. Two things had to hold for
	// that to be true and neither did: a change to those artifacts had to
	// trigger a job (the path filters above), and the suites had to fail rather
	// than skip when the reference server cannot be started. Both suites rolled
	// their own `describe.skip` gate around a local import, which REQUIRE_UWS
	// cannot reach - only the shared helper's flag carries the hard failure.
	it.each(['test/protocol-schema.test.js', 'test/minimal-client.test.js'])(
		'%s gates on the shared native-runtime flag',
		(file) => {
			const source = read(file);
			expect(source).toMatch(/import \{ hasUWS \} from '\.\/helpers\/real-runtime\.js'/);
			expect(source).toMatch(/const describeUWS = hasUWS \? describe : describe\.skip/);
			// The local try/import it replaced could only ever resolve to a skip.
			expect(source).not.toMatch(/catch \{\s*uWS = null/);
		}
	);
});

describe('the locked tree is checked for advisories', () => {
	// The locks were swept clean once and nothing keeps them that way; an
	// advisory published afterwards arrives through a plain `npm ci`.
	it('audits both lockfiles at a level that fails the job', () => {
		expect(testWorkflow).toMatch(/npm audit --audit-level=high --package-lock-only/);
		expect(testWorkflow).toMatch(/working-directory: test\/fixture/);
	});
});

describe('the declared support floor is executed, not just declared', () => {
	const filters = (pkg.scripts['test:floor'] || '').replace(/^vitest run\s*/, '').split(/\s+/).filter(Boolean);

	it('installs the exact floor of every peer range it can run', () => {
		expect(testWorkflow).toMatch(/npm install --no-save svelte@4\.0\.0 ws@8\.0\.0/);
		expect(testWorkflow).toMatch(/run: npm run test:floor/);
	});

	it('runs the public prerequisite preflight from the freshly installed minimum-profile app', () => {
		expect(testWorkflow).toMatch(
			/name: Run the published newcomer preflight[\s\S]*working-directory: test\/fixtures\/svelte4[\s\S]*run: npm exec -- svelte-adapter-uws-preflight/
		);
		expect(read('README.md')).toContain('npm exec -- svelte-adapter-uws-preflight');
		expect(pkg.bin?.['svelte-adapter-uws-preflight']).toBe('./scripts/preflight.js');
		expect(
			svelte4Lock.packages?.['node_modules/svelte-adapter-uws']?.bin?.[
				'svelte-adapter-uws-preflight'
			]
		).toBe('scripts/preflight.js');
	});

	// The client is the only thing in this package that imports a peer at
	// runtime, so a suite that loads it is a suite the floor lane has to run. A
	// new one landing outside the filters would leave the lane quietly proving
	// less than it did, which is the failure mode a scoped lane has.
	// The lane installs no fixture, because nothing it selects needs one. A
	// filter widened until it selects a suite that boots the built runtime would
	// fail the job in a `vite build` rather than on the floor question it was
	// added to ask. Booting is what costs a build - taking the helper's `hasUWS`
	// flag alone does not, which is the same distinction the vitest global setup
	// draws when it decides which variants to pre-build.
	it('selects nothing that boots the built fixture', () => {
		const testDir = new URL('./', import.meta.url);
		for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
			if (!filters.some((f) => ('test/' + file).includes(f))) continue;
			const source = readFileSync(new URL(file, testDir), 'utf8');
			expect(source.includes('startRealRuntime('), `test/${file} boots the fixture`).toBe(false);
		}
	});

	it('covers every suite that loads the browser client', () => {
		const testDir = new URL('./', import.meta.url);
		const loadsClient = readdirSync(testDir)
			.filter((f) => f.endsWith('.test.js'))
			.filter((f) => {
				const source = readFileSync(new URL(f, testDir), 'utf8');
				return /import\(\s*'\.\.\/src\/(client\.js|plugins\/[a-z]+\/client\.js)'/.test(source)
					|| /^import .*from 'svelte\/store'/m.test(source);
			})
			.map((f) => 'test/' + f);

		expect(loadsClient.length).toBeGreaterThan(0);
		for (const file of loadsClient) {
			expect(filters.some((f) => file.includes(f)), `${file} is outside the floor lane`).toBe(true);
		}
	});
});
