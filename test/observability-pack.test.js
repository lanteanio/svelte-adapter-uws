// Contract: the shipped observability pack must stay true to the signal
// manifest, and every metric must have had a DECISION made about it.
//
// Reference queries for a set of metrics with non-obvious aggregation laws are
// only worth shipping if they cannot rot. Two failure modes are guarded here:
//
//   - queries.md drifting from the manifest. It is generated, and regenerated
//     here, so a new metric cannot ship without an entry.
//   - a metric arriving with no operational decision attached. Every signal must
//     either be referenced by a rule or be named in the runbook's explicit
//     no-alert list. "Nobody thought about it" and "we decided not to alert on
//     it" look identical in a rules file; this forces them apart.
//
// The alerts' thresholds are deliberately NOT asserted - those are judgement and
// a test that pinned them would only ever be updated to match whatever the code
// said. What is asserted is that every alert can be acted on: it must name a
// runbook section that exists.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNALS } from '../src/runtime/observability-manifest.js';
import { render } from '../scripts/generate-observability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const RULES = read('examples/observability/rules.yml');
const RUNBOOK = read('examples/observability/runbook.md');

/** GitHub's heading-anchor slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading) {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-');
}

const runbookAnchors = new Set(
	[...RUNBOOK.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => slug(m[1]))
);

/** The bullet list under the no-alert heading. */
function noAlertList() {
	const start = RUNBOOK.indexOf('## Metrics with no alert, by design');
	expect(start, 'the runbook must carry an explicit no-alert list').toBeGreaterThan(-1);
	const section = RUNBOOK.slice(start);
	return new Set([...section.matchAll(/^- `([a-z_0-9]+)`/gm)].map((m) => m[1]));
}

describe('shipped observability pack', () => {
	it('queries.md is exactly what the manifest generates', () => {
		expect(
			read('examples/observability/queries.md'),
			'examples/observability/queries.md is stale - run `node scripts/generate-observability.js`'
		).toBe(render());
	});

	it('every alert names a runbook section that exists', () => {
		const alerts = [...RULES.matchAll(/^\s*- alert:\s*(\S+)/gm)].map((m) => m[1]);
		expect(alerts.length, 'no alerts parsed - the rules file or this parser changed shape').toBeGreaterThan(10);

		const links = [...RULES.matchAll(/runbook_url:\s*\.\/runbook\.md#(\S+)/g)].map((m) => m[1]);
		expect(links.length, 'every alert must carry a runbook_url').toBe(alerts.length);

		const dangling = [...new Set(links)].filter((a) => !runbookAnchors.has(a)).sort();
		expect(
			dangling,
			'these alerts point at runbook sections that do not exist: ' + JSON.stringify(dangling)
		).toEqual([]);
	});

	it('every alert name is unique', () => {
		const alerts = [...RULES.matchAll(/^\s*- alert:\s*(\S+)/gm)].map((m) => m[1]);
		expect(alerts).toEqual([...new Set(alerts)]);
	});

	it('every metric is either covered by a rule or explicitly excluded', () => {
		const excluded = noAlertList();
		const undecided = SIGNALS
			.map((s) => s.name)
			.filter((name) => !RULES.includes(name) && !excluded.has(name))
			.sort();
		expect(
			undecided,
			'these metrics ship with no rule and no entry in the runbook\'s no-alert list, so nobody has ' +
			'decided whether they need a response: ' + JSON.stringify(undecided)
		).toEqual([]);
	});

	it('the no-alert list names only metrics that exist', () => {
		const known = new Set(SIGNALS.map((s) => s.name));
		const phantom = [...noAlertList()].filter((n) => !known.has(n)).sort();
		expect(phantom, 'the no-alert list names metrics the manifest does not declare: ' + JSON.stringify(phantom)).toEqual([]);
	});

	it('does not tell operators to re-aggregate an already-merged document', () => {
		// The document platform.metricsSnapshot() returns has already applied each
		// metric's cross-worker law. A sum() over a whole-process reading in a
		// shipped query would re-introduce the exact defect the merge removes -
		// multiplying one truth by the worker count.
		const processScoped = SIGNALS.filter((s) => s.scope === 'process').map((s) => s.name);
		const offenders = [];
		for (const name of processScoped) {
			for (const doc of [RULES, read('examples/observability/queries.md')]) {
				if (new RegExp('sum\\s*(by\\s*\\([^)]*\\)\\s*)?\\(\\s*(rate\\()?' + name).test(doc)) offenders.push(name);
			}
		}
		expect(
			[...new Set(offenders)],
			'a shipped query sums a whole-process metric across workers: ' + JSON.stringify(offenders)
		).toEqual([]);
	});
});
