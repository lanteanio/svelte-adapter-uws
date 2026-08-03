import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	checklistPath,
	guidePath,
	loadManifest,
	renderChecklist,
	renderGuide,
	validateManifest
} from '../scripts/generate-privacy-integration.js';

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

describe('ecosystem privacy integration contract', () => {
	it('covers all packages with retention, erasure limits, host actions, and evidence', () => {
		const manifest = loadManifest();
		expect(validateManifest(manifest)).toEqual([]);
		expect(manifest.packages.map((item) => item.name).sort()).toEqual([
			'svelte-adapter-uws',
			'svelte-adapter-uws-extensions',
			'svelte-realtime'
		]);
		expect(manifest.activities.length).toBeGreaterThanOrEqual(12);
		for (const activity of manifest.activities) {
			expect(activity.defaultRetention.limit.length).toBeGreaterThan(10);
			expect(activity.erasure.limitations.length).toBeGreaterThan(10);
			expect(activity.hostActions.length).toBeGreaterThan(0);
			expect(activity.sources.length).toBeGreaterThan(0);
		}
	});

	it('keeps the human guide and host worksheet deterministic', () => {
		const manifest = loadManifest();
		expect(readFileSync(guidePath, 'utf8').replace(/\r\n/g, '\n')).toBe(renderGuide(manifest));
		expect(readFileSync(checklistPath, 'utf8').replace(/\r\n/g, '\n')).toBe(renderChecklist(manifest));
	});

	it('rejects a missing deletion limitation or action for an indefinite default', () => {
		const missingLimitation = clone(loadManifest());
		delete missingLimitation.activities[0].erasure.limitations;
		expect(validateManifest(missingLimitation)).toContain('activities[0].erasure.limitations is required');

		const passive = clone(loadManifest());
		const indefinite = passive.activities.find((activity) => activity.defaultRetention.automatic === false);
		indefinite.hostActions = ['Review this feature.'];
		const index = passive.activities.indexOf(indefinite);
		expect(validateManifest(passive)).toContain(
			`activities[${index}] has no automatic time boundary and needs an actionable host retention/deletion step`
		);
	});

	it('rejects a package omission and premature erasure-completion wording', () => {
		const manifest = clone(loadManifest());
		manifest.packages.pop();
		manifest.erasureBoundary.completionRule = 'The coordinator reports completion.';
		const errors = validateManifest(manifest);
		expect(errors.some((error) => error.startsWith('packages must contain exactly:'))).toBe(true);
		expect(errors).toContain('erasureBoundary.completionRule must prohibit premature completion');
	});

	it('rejects removal of a named processing surface even when the row count remains high', () => {
		const manifest = clone(loadManifest());
		manifest.activities = manifest.activities.filter((activity) => activity.id !== 'durable-dead-letters');
		expect(validateManifest(manifest)).toContain('activities must include durable-dead-letters');
	});
});
