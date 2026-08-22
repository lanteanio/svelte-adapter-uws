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
// The rules file carries a deliberately commented-out burn-rate group; scans
// that count alerts or runbook links must not read the disabled text.
const ACTIVE_RULES = RULES.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
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
		const alerts = [...ACTIVE_RULES.matchAll(/^\s*- alert:\s*(\S+)/gm)].map((m) => m[1]);
		expect(alerts.length, 'no alerts parsed - the rules file or this parser changed shape').toBeGreaterThan(10);

		const links = [...ACTIVE_RULES.matchAll(
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
		const templated = ACTIVE_RULES.match(/\$externalLabels\.adapter_runbook_url/g) || [];
		const alerts = ACTIVE_RULES.match(/^\s*- alert:/gm) || [];
		expect(templated).toHaveLength(alerts.length);
	});

	it('every alert name is unique', () => {
		const alerts = [...ACTIVE_RULES.matchAll(/^\s*- alert:\s*(\S+)/gm)].map((m) => m[1]);
		expect(alerts).toEqual([...new Set(alerts)]);
	});

	it('every metric is either covered by a rule or explicitly excluded', () => {
		const excluded = noAlertList();
		const undecided = SIGNALS
			.map((s) => s.name)
			.filter((name) => !ACTIVE_RULES.includes(name) && !excluded.has(name))
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
		expect(rules).toHaveLength(34);
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
		expect(DASHBOARD.panels.length).toBeGreaterThanOrEqual(8);
		expect(DASHBOARD.panels.length).toBeLessThanOrEqual(12);

		// Every shipped recording rule with a charted meaning is consumed here,
		// so none of the recorded series is write-only.
		const expressions = DASHBOARD.panels.flatMap((panel) => panel.targets.map((target) => target.expr));
		for (const series of [
			'adapter:subscriber_ratio',
			'adapter:pressure_sample_age_seconds',
			'adapter:fd_headroom_ratio',
			'adapter:upgrade_reject_ratio:rate5m',
			'adapter:http_error_ratio:rate5m',
			'adapter:http_request_duration_seconds:p95_5m',
			'adapter:http_request_duration_seconds:p95_by_method_5m',
			'adapter:ws_message_error_ratio:rate5m',
			'adapter:ws_message_duration_seconds:p95_5m',
			'rate(http_requests_total',
			'rate(ws_messages_total'
		]) {
			expect(
				expressions.some((expr) => expr.includes(series)),
				`no dashboard panel consumes ${series}`
			).toBe(true);
		}

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
			'capacity alerts fire for marked adapter targets',
			'integrity alerts fire for marked adapter targets',
			'recorded ratios freshness and quantiles evaluate to exact values',
			'a fleet with no adapter-labelled target pages the meta alert',
			'unrelated targets cannot page adapter alerts'
		]);
		const [ratio, pipeline, , , recorded, , unrelated] = PROMTOOL_DRILLS.tests;
		expect(ratio.promql_expr_test[0].exp_samples.map((sample) => sample.value)).toEqual([0.4, 0.2]);
		expect(ratio.alert_rule_test[0].exp_alerts[0].exp_labels.instance).toBe('high');
		expect(ratio.alert_rule_test[1].exp_alerts[0].exp_labels.instance).toBe('lagging');
		expect(pipeline.alert_rule_test
			.filter((test) => test.exp_alerts.length > 0)
			.map((test) => test.exp_alerts[0].exp_labels.instance)
		).toEqual(['degraded', 'incomplete', 'stalled', 'missing']);
		expect(
			pipeline.alert_rule_test.some(
				(test) => test.alertname === 'AdapterTargetMissing' && test.exp_alerts.length === 0
			),
			'a present marked up series must keep the meta alert silent'
		).toBe(true);
		// The recorded series are consumed, so the corpus must prove they
		// evaluate - subscriber ratio, freshness age, both error ratios, and
		// all three p95 quantiles, each to an exact expected value.
		const recordedNames = recorded.promql_expr_test.map((test) => test.expr).sort();
		expect(recordedNames).toEqual([
			'adapter:http_error_ratio:rate5m',
			'adapter:http_request_duration_seconds:p95_5m',
			'adapter:http_request_duration_seconds:p95_by_method_5m',
			'adapter:pressure_sample_age_seconds',
			'adapter:subscriber_ratio',
			'adapter:ws_message_duration_seconds:p95_5m',
			'adapter:ws_message_error_ratio:rate5m'
		]);
		for (const test of recorded.promql_expr_test) {
			expect(test.exp_samples.length, `${test.expr} must assert at least one exact sample`).toBeGreaterThan(0);
		}
		expect(unrelated.alert_rule_test.every((test) => test.exp_alerts.length === 0)).toBe(true);
		expect(
			unrelated.promql_expr_test.every((test) => test.exp_samples.length === 0),
			'foreign traffic must not materialise recorded adapter series'
		).toBe(true);
		expect(CI_WORKFLOW).toContain(
			'prom/prometheus@sha256:c6b27ea434f8389bfe233fbc7be381cf50587c286e871bc842008f5a1b1908a7'
		);
		expect(CI_WORKFLOW).toContain('test rules /rules/rule-tests.v1.yml');
	});

	it('every alert has a positive firing case, so a rule that can never fire fails the corpus', () => {
		const alerts = RULE_DOCUMENT.groups
			.flatMap((group) => group.rules)
			.filter((rule) => rule.alert)
			.map((rule) => rule.alert);
		expect(alerts.length).toBeGreaterThan(10);
		const entries = PROMTOOL_DRILLS.tests.flatMap((test) => test.alert_rule_test ?? []);
		const unfired = alerts
			.filter((alert) => !entries.some(
				(entry) => entry.alertname === alert && entry.exp_alerts.length > 0
			))
			.sort();
		expect(
			unfired,
			'these alerts have no corpus case that proves they can fire - a broken expression would pass ' +
			'every silence assertion identically: ' + JSON.stringify(unfired)
		).toEqual([]);
		// Positive cases must pin the full contract, not just existence.
		for (const entry of entries) {
			for (const alert of entry.exp_alerts) {
				expect(alert.exp_labels.adapter, `${entry.alertname} must carry the target label`).toBe('svelte-adapter-uws');
				expect(alert.exp_labels.severity, `${entry.alertname} must pin its severity`).toMatch(/^(warning|critical)$/);
				expect(alert.exp_annotations.runbook_url, `${entry.alertname} must pin its runbook link`)
					.toMatch(/^https:\/\/ops\.example\.com\/adapter#[a-z]+$/);
				expect(alert.exp_annotations.summary, `${entry.alertname} must pin its summary`).toBeTruthy();
			}
		}
	});

	it('every alert keeps a negative case proving foreign targets stay silent', () => {
		const alerts = RULE_DOCUMENT.groups
			.flatMap((group) => group.rules)
			.filter((rule) => rule.alert)
			.map((rule) => rule.alert);
		const unrelated = PROMTOOL_DRILLS.tests.find(
			(test) => test.name === 'unrelated targets cannot page adapter alerts'
		);
		const silenced = new Set(
			unrelated.alert_rule_test
				.filter((entry) => entry.exp_alerts.length === 0)
				.map((entry) => entry.alertname)
		);
		// The meta alert is the one deliberate exception: with no marked target
		// in the isolation corpus it SHOULD fire, so its negative case lives in
		// the pipeline test where marked up series exist.
		const missing = alerts
			.filter((alert) => alert !== 'AdapterTargetMissing' && !silenced.has(alert))
			.sort();
		expect(
			missing,
			'these alerts have no isolation case: ' + JSON.stringify(missing)
		).toEqual([]);
		const phantom = [...silenced].filter((alert) => !alerts.includes(alert)).sort();
		expect(phantom, 'the isolation test names alerts the rules file does not declare: ' + JSON.stringify(phantom)).toEqual([]);
	});

	it('isolation series carry values that would fire each rule without its matcher', () => {
		const unrelated = PROMTOOL_DRILLS.tests.find(
			(test) => test.name === 'unrelated targets cannot page adapter alerts'
		);
		/** metric name -> [{ labels, start, step }] for the foreign constant/linear series. */
		const foreign = new Map();
		for (const entry of unrelated.input_series) {
			const parsedSeries = /^([a-zA-Z_:][\w:]*)\{([^}]*)\}$/.exec(entry.series);
			const parsedValues = /^(-?[\d.]+)\+(-?[\d.]+)x\d+$/.exec(entry.values);
			expect(parsedSeries, entry.series).toBeTruthy();
			expect(parsedValues, `${entry.series} values must stay linear so the property below is checkable`).toBeTruthy();
			expect(parsedSeries[2]).toContain('adapter="another-service"');
			const list = foreign.get(parsedSeries[1]) ?? [];
			list.push({
				labels: parsedSeries[2],
				start: Number(parsedValues[1]),
				step: Number(parsedValues[2])
			});
			foreign.set(parsedSeries[1], list);
		}

		// Simple gauge-threshold alerts: at least one foreign series of the
		// same metric must satisfy the comparison, so removing the adapter
		// matcher would page. This is what makes the silence meaningful.
		const signalNames = new Set(SIGNALS.map((signal) => signal.name));
		const simple = [...ACTIVE_RULES.matchAll(
			/^\s*expr:\s*([a-z_][\w]*)\{adapter="svelte-adapter-uws"\}\s*(>=|>|==)\s*([\d.]+)\s*$/gm
		)];
		expect(simple.length, 'the simple-threshold parser found nothing - the rules file changed shape').toBeGreaterThanOrEqual(4);
		for (const [, metric, comparator, thresholdRaw] of simple) {
			if (!signalNames.has(metric)) continue;
			const threshold = Number(thresholdRaw);
			const satisfied = (foreign.get(metric) ?? []).some(({ start }) =>
				comparator === '>' ? start > threshold
				: comparator === '>=' ? start >= threshold
				: start === threshold
			);
			expect(
				satisfied,
				`no foreign ${metric} series satisfies "${comparator} ${threshold}" - the isolation case cannot ` +
				'distinguish the matcher from the threshold'
			).toBe(true);
		}
		// Both posture rules must be constrained: == 1 needs a foreign 1, >= 2
		// a foreign 2. The generic walk above proves each, but pin the pair so
		// neither alert can lose its counterpart silently.
		const postures = (foreign.get('protection_posture_state') ?? []).map(({ start }) => start).sort();
		expect(postures).toEqual([1, 2]);

		// Ratio rules: the foreign numerator/denominator pairs must cross the
		// shipped thresholds.
		const value = (metric) => foreign.get(metric)?.[0]?.start;
		expect(value('open_fds') / value('fd_soft_limit'), 'foreign descriptor pair must exceed the critical ratio')
			.toBeGreaterThan(0.92);
		expect(
			value('ws_backpressure_connections') / Math.max(value('ws_connections'), 1),
			'foreign backpressure pair must exceed the sustained share'
		).toBeGreaterThan(0.01);

		// Rate/increase rules: each referenced counter needs a foreign series
		// that actually increases; churn must exceed one eviction per second.
		for (const metric of [
			'upgrade_rejected_total', 'upgrade_rate_map_evicted_total', 'state_divergence_total',
			'relay_gap_frames_total', 'relay_spill_quarantines_total',
			'relay_frame_refused_total', 'relay_frame_oversized_total',
			'framework_assertion_violations_total', 'framework_resource_growth_suspected_total'
		]) {
			expect(
				(foreign.get(metric) ?? []).some(({ step }) => step > 0),
				`no increasing foreign ${metric} series - its rate rule is not constrained`
			).toBe(true);
		}
		expect(
			(foreign.get('upgrade_rate_map_evicted_total') ?? []).some(({ step }) => step > 60),
			'foreign eviction churn must exceed one per second at the 1m sample interval'
		).toBe(true);
		// The pipeline rules are up-correlated, so their isolation needs a
		// foreign target that is up while degraded, incomplete and stale, plus
		// a bare foreign up series for the absence rule.
		const ups = foreign.get('up') ?? [];
		expect(ups.length).toBeGreaterThanOrEqual(2);
		expect(ups.every(({ start }) => start === 1)).toBe(true);
		expect(value('metrics_snapshot_degraded')).toBeGreaterThan(0);
		expect(value('metrics_snapshot_workers_reporting')).toBeLessThan(value('metrics_snapshot_workers_expected'));
	});

	it('ships the transport SLO half: live recording rules, disabled burn-rate alerts, meta alert', () => {
		const rules = RULE_DOCUMENT.groups.flatMap((group) => group.rules);
		const recorded = rules.filter((rule) => rule.record).map((rule) => rule.record);
		for (const name of [
			'adapter:http_error_ratio:rate5m',
			'adapter:ws_message_error_ratio:rate5m',
			'adapter:http_request_duration_seconds:p95_5m',
			'adapter:http_request_duration_seconds:p95_by_method_5m',
			'adapter:ws_message_duration_seconds:p95_5m'
		]) {
			expect(recorded, 'missing transport SLO recording rule').toContain(name);
		}
		// The burn-rate pair ships disabled: present as commented rule text an
		// operator can uncomment, absent from the parsed document, and backed
		// by real runbook sections.
		for (const alert of ['AdapterHttpErrorBudgetBurn', 'AdapterWsMessageErrorBudgetBurn']) {
			expect(RULES, `${alert} must ship as commented-out rule text`).toContain(`- alert: ${alert}`);
			expect(ACTIVE_RULES, `${alert} must not be enabled by default`).not.toContain(`- alert: ${alert}`);
			expect(runbookAnchors.has(alert.toLowerCase()), `${alert} needs a runbook section`).toBe(true);
			expect(RUNBOOK).toContain(`## ${alert}`);
		}
		expect(RULES).toContain('SHIPPED DISABLED');
		// The meta alert is the single legitimate non-per-target expression.
		const meta = rules.find((rule) => rule.alert === 'AdapterTargetMissing');
		expect(meta.expr.trim()).toBe('absent(up{adapter="svelte-adapter-uws"})');
		const absentUsers = rules.filter((rule) => rule.expr.includes('absent('));
		expect(absentUsers.map((rule) => rule.alert)).toEqual(['AdapterTargetMissing']);
		expect(runbookAnchors.has('adaptertargetmissing')).toBe(true);
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
