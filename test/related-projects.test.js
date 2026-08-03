import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
	EXTENSIONS_DESCRIPTION,
	REALTIME_DESCRIPTION,
	renderRelatedProjects,
	validateRelatedProjects
} from '../scripts/check-related-projects.js';

const extensionPackage = {
	name: 'svelte-adapter-uws-extensions',
	description: EXTENSIONS_DESCRIPTION,
	exports: { './admission': './src/admission.js' }
};
const realtimePackage = {
	name: 'svelte-realtime',
	description: REALTIME_DESCRIPTION
};
const goodReadme = [
	'# Adapter',
	renderRelatedProjects(),
	'~~~js',
	"import { createAdmissionControl } from 'svelte-adapter-uws-extensions/admission';",
	'~~~'
].join('\n\n');

function errors(readme = goodReadme, extensions = extensionPackage, realtime = realtimePackage) {
	return validateRelatedProjects({
		readme,
		extensionsPackage: extensions,
		realtimePackage: realtime
	});
}

describe('related-project cards', () => {
	it('accepts cards rendered from current sibling manifests and the exported admission path', () => {
		expect(errors()).toEqual([]);
	});

	it('rejects stale positioning even when a correct description survives elsewhere', () => {
		const stale = goodReadme.replace(
			REALTIME_DESCRIPTION,
			'Opinionated full-stack starter built on this adapter.'
		) + '\n' + REALTIME_DESCRIPTION;
		expect(errors(stale)).toContain(
			'README related-projects block is stale; regenerate it from sibling manifest descriptions'
		);
		expect(errors(stale)).toContain('README contains the retired svelte-realtime positioning');
	});

	it('rejects manifest drift instead of blessing the local description snapshot', () => {
		const changed = { ...realtimePackage, description: 'A newly changed product description' };
		expect(errors(goodReadme, extensionPackage, changed)).toContain(
			'README related-projects block is stale; regenerate it from sibling manifest descriptions'
		);
	});

	it('rejects the nonexistent bare extensions import and a missing admission export', () => {
		const bare = goodReadme.replace(
			'svelte-adapter-uws-extensions/admission',
			'svelte-adapter-uws-extensions'
		);
		expect(errors(bare)).toContain('README imports the nonexistent extensions root export');
		expect(errors(bare)).toContain(
			'README must import createAdmissionControl from the ./admission export'
		);
		const noAdmission = { ...extensionPackage, exports: { './redis': './src/redis.js' } };
		expect(errors(goodReadme, noAdmission)).toContain(
			'svelte-adapter-uws-extensions must export ./admission'
		);
	});

	it('rejects duplicate or unbounded generated-card markers', () => {
		expect(errors(goodReadme + '\n' + renderRelatedProjects())).toContain(
			'README must contain exactly one bounded related-projects block'
		);
		expect(errors(goodReadme.replace('<!-- related-projects:end -->', ''))).toContain(
			'README must contain exactly one bounded related-projects block'
		);
	});
});

describe('related-project exact-head workflow', () => {
	const source = readFileSync(
		fileURLToPath(new URL('../.github/workflows/cross-repo-heads.yml', import.meta.url)),
		'utf8'
	);
	const workflow = parse(source);

	it('runs for README changes and checks one structurally exact command', () => {
		expect(workflow.on.pull_request.paths).toContain('README.md');
		const steps = workflow.jobs['packed-heads'].steps;
		const step = steps.find(
			(candidate) => candidate.name === 'Verify related-project cards against exact heads'
		);
		expect(step).toBeTruthy();
		expect(step.shell).toBe('pwsh');
		expect(step.run.trim().split(/\s+/)).toEqual([
			'node',
			'heads/svelte-adapter-uws/scripts/check-related-projects.js',
			'--extensions-package',
			'heads/svelte-adapter-uws-extensions/package.json',
			'--realtime-package',
			'heads/svelte-realtime/package.json'
		]);
	});
});
