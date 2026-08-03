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
import { parser as promqlParser } from '@prometheus-io/lezer-promql';
import { parse as parseYaml } from 'yaml';
import { SIGNALS } from '../src/runtime/observability-manifest.js';
import { render } from '../scripts/generate-observability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const RULES = read('examples/observability/rules.yml');
const RUNBOOK = read('examples/observability/runbook.md');
const DASHBOARD = JSON.parse(read('examples/observability/dashboard.v1.json'));
const RULE_DOCUMENT = parseYaml(RULES);
const PROMTOOL_DRILLS = parseYaml(read('examples/observability/rule-tests.v1.yml'));
const CI_WORKFLOW = read('.github/workflows/test.yml');

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

function vectorSelectors(expression) {
	const tree = promqlParser.parse(expression);
	const errors = [];
	const selectors = [];
	tree.iterate({
		enter(node) {
			if (node.type.isError) errors.push(expression.slice(node.from, node.to));
			if (node.type.name === 'VectorSelector') {
				selectors.push(expression.slice(node.from, node.to));
			}
		}
	});
	expect(errors, `invalid PromQL: ${expression}`).toEqual([]);
	return selectors;
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

		const links = [...RULES.matchAll(
			/runbook_url:\s*'\{\{ \$externalLabels\.adapter_runbook_url \}\}#([^']+)'/g
		)].map((m) => m[1]);
		expect(links.length, 'every alert must carry a runbook_url').toBe(alerts.length);

		const dangling = [...new Set(links)].filter((a) => !runbookAnchors.has(a)).sort();
		expect(
			dangling,
			'these alerts point at runbook sections that do not exist: ' + JSON.stringify(dangling)
		).toEqual([]);
	});

	it('uses a configurable absolute runbook URL contract for every alert', () => {
		expect(RULES).not.toContain('runbook_url: ./');
		expect(RUNBOOK).toContain('adapter_runbook_url: https://ops.example.com/');
		const templated = RULES.match(/\$externalLabels\.adapter_runbook_url/g) || [];
		const alerts = RULES.match(/^\s*- alert:/gm) || [];
		expect(templated).toHaveLength(alerts.length);
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

	it('keeps low-rate reject math exact and preserves external target labels', () => {
		expect(RULES).toContain('sum without (reason) (rate(upgrade_rejected_total{adapter="svelte-adapter-uws"}[5m]))');
		expect(RULES).toContain('or (0 * rate(upgrade_admitted_total{adapter="svelte-adapter-uws"}[5m]))');
		expect(RULES).not.toMatch(/clamp_min\([^\n]*upgrade_/);
		expect(RULES).not.toContain('sum(rate(upgrade_rejected_total');
		expect(RULES).not.toContain('sum(rate(upgrade_rate_map_evicted_total');
		expect(read('examples/observability/queries.md')).not.toContain('sum by (reason)');
	});

	it('parses every rule with the official grammar and scopes every vector selector', () => {
		const rules = RULE_DOCUMENT.groups.flatMap((group) => group.rules);
		expect(rules).toHaveLength(25);
		for (const rule of rules) {
			const selectors = vectorSelectors(rule.expr);
			for (const selector of selectors) {
				const adapterMatchers = selector.match(/\badapter\s*(?:=|!=|=~|!~)/g) || [];
				expect(adapterMatchers, `${rule.alert || rule.record}: ${selector}`).toHaveLength(1);
				expect(selector, `${rule.alert || rule.record}: ${selector}`).toMatch(
					/\badapter\s*=\s*"svelte-adapter-uws"\s*(?:,|})/
				);
			}
		}
	});

	it('correlates every pipeline failure with each marked target up series', () => {
		const pipeline = RULES.slice(
			RULES.indexOf('- name: svelte-adapter-uws.pipeline'),
			RULES.indexOf('- name: svelte-adapter-uws.capacity')
		);
		expect(pipeline).not.toContain('absent(');
		expect(pipeline).toContain('(metrics_snapshot_degraded{adapter="svelte-adapter-uws"} > 0)');
		expect(pipeline).toContain('unless metrics_snapshot_degraded{adapter="svelte-adapter-uws"}');
		expect(pipeline).toContain('unless metrics_snapshot_workers_expected{adapter="svelte-adapter-uws"}');
		expect(pipeline).toContain('unless metrics_snapshot_workers_reporting{adapter="svelte-adapter-uws"}');
		expect(pipeline).toContain('unless pressure_sample_timestamp_seconds{adapter="svelte-adapter-uws"}');
		expect(pipeline.match(/up\{adapter="svelte-adapter-uws"\} == 1/g)).toHaveLength(7);
	});

	it('ships a compact versioned dashboard with target-bearing queries and legends', () => {
		expect(DASHBOARD.schemaVersion).toBeGreaterThanOrEqual(39);
		expect(DASHBOARD.version).toBe(1);
		expect(DASHBOARD.uid).toBe('svelte-adapter-uws-v1');
		expect(DASHBOARD.panels.length).toBeGreaterThanOrEqual(6);
		expect(DASHBOARD.panels.length).toBeLessThanOrEqual(8);

		const variables = new Set(DASHBOARD.templating.list.map((entry) => entry.name));
		expect(variables).toEqual(new Set(['job', 'instance', 'runbook_url']));
		expect(DASHBOARD.links[0].url).toBe('${runbook_url}');
		for (const panel of DASHBOARD.panels) {
			for (const target of panel.targets) {
				expect(target.expr, `${panel.title} must select only adapter targets`).toContain('adapter="svelte-adapter-uws"');
				expect(target.expr, `${panel.title} must retain the job filter`).toContain('${job:regex}');
				expect(target.expr, `${panel.title} must retain the instance filter`).toContain('${instance:regex}');
				expect(target.legendFormat, `${panel.title} must expose target identity`).toContain('{{job}}');
				expect(target.legendFormat, `${panel.title} must expose target identity`).toContain('{{instance}}');
			}
		}
	});

	it('wires a non-vacuous promtool corpus into a digest-pinned CI evaluator', () => {
		expect(PROMTOOL_DRILLS.rule_files).toEqual(['rules.yml']);
		expect(PROMTOOL_DRILLS.tests.map((test) => test.name)).toEqual([
			'low-rate rejection math and target isolation',
			'pipeline completeness absence freshness and up correlation',
			'unrelated targets cannot page adapter alerts'
		]);
		const [ratio, pipeline, unrelated] = PROMTOOL_DRILLS.tests;
		expect(ratio.promql_expr_test[0].exp_samples.map((sample) => sample.value)).toEqual([0.4, 0.2]);
		expect(ratio.alert_rule_test[0].exp_alerts[0].exp_labels.instance).toBe('high');
		expect(ratio.alert_rule_test[1].exp_alerts[0].exp_labels.instance).toBe('lagging');
		expect(pipeline.alert_rule_test.map((test) => test.exp_alerts[0].exp_labels.instance)).toEqual([
			'degraded',
			'incomplete',
			'stalled',
			'missing'
		]);
		expect(unrelated.alert_rule_test).toHaveLength(16);
		expect(unrelated.alert_rule_test.every((test) => test.exp_alerts.length === 0)).toBe(true);
		expect(CI_WORKFLOW).toContain(
			'prom/prometheus@sha256:c6b27ea434f8389bfe233fbc7be381cf50587c286e871bc842008f5a1b1908a7'
		);
		expect(CI_WORKFLOW).toContain('test rules /rules/rule-tests.v1.yml');
	});

	it('keeps adapter and sibling-extension artifact ownership explicit', () => {
		expect(RUNBOOK).toContain('This repository\'s pack covers adapter-owned metrics only.');
		expect(RUNBOOK).toContain('sibling extension repositories');
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
