#!/usr/bin/env node
/**
 * Generate the reference query sheet from the signal manifest.
 *
 * The adapter's metrics have non-obvious aggregation laws - `open_fds` is
 * whole-process and must never be summed across workers, freshness must be
 * taken from the STALEST worker, connections and subscriptions must be summed
 * separately rather than averaged as a ratio. Prose describing those laws is
 * something an adopter reads once and then writes the wrong query anyway.
 * Shipping the queries is how the laws become executable.
 *
 * Only the derivable half is generated: which metrics exist, what each is
 * measured in, and the canonical expression for it. Thresholds and incident
 * response are judgement and live hand-written in rules.yml and runbook.md,
 * which the metrics contract test holds to a coverage rule instead.
 *
 * Usage:
 *   node scripts/generate-observability.js          # write the file
 *   node scripts/generate-observability.js --check  # fail if it would change
 *
 * @module scripts/generate-observability
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNALS } from '../src/runtime/observability-manifest.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'examples/observability/queries.md');

/** Human sentence for a metric's cross-worker law, given the snapshot already applied it. */
function lawNote(signal) {
	if (signal.merged === true) return 'Written by the merge itself; no worker registers it.';
	if (signal.scope === 'process') {
		return 'Whole-process value - every worker reports the same number, so the snapshot takes the maximum. Never sum it.';
	}
	if (signal.aggregate === 'sum') return 'Per-worker quantity; the snapshot has already summed it across workers.';
	if (signal.aggregate === 'max') return 'The snapshot reports the worst worker.';
	return 'The snapshot reports the stalest worker, so this is the freshness of the whole cluster.';
}

/** The canonical expression an operator should chart or alert on. */
function expression(signal) {
	if (signal.type === 'counter') {
		return signal.labels.length > 0
			? `sum by (${signal.labels.join(', ')}) (rate(${signal.name}[5m]))`
			: `rate(${signal.name}[5m])`;
	}
	return signal.name;
}

function unitNote(signal) {
	if (signal.unit === null) return 'count';
	if (signal.unit === 'enum') return 'enumerated state (see the description)';
	return signal.unit;
}

export function render() {
	const out = [];
	out.push('# Reference queries');
	out.push('');
	out.push('Generated from the adapter\'s signal manifest by `scripts/generate-observability.js`.');
	out.push('Do not edit by hand - a test regenerates this file and fails if it differs, so a new');
	out.push('metric cannot ship without an entry here.');
	out.push('');
	out.push('These assume you scrape [`platform.metricsSnapshot()`](../../README.md#cluster-wide-metrics),');
	out.push('which returns ONE already-merged document for the whole cluster. Do not add another layer');
	out.push('of `sum()` over these: the cross-worker aggregation has already been applied, by the law');
	out.push('each metric declares. If you scrape `platform.metrics.serialize()` instead you are reading');
	out.push('one randomly chosen worker and none of these queries mean what they say.');
	out.push('');
	out.push('| Metric | Type | Unit | Query | Cross-worker law |');
	out.push('| --- | --- | --- | --- | --- |');
	for (const signal of SIGNALS) {
		const optional = signal.optional === true ? ' (not always registered)' : '';
		out.push(`| \`${signal.name}\` | ${signal.type} | ${unitNote(signal)} | \`${expression(signal)}\` | ${lawNote(signal)}${optional} |`);
	}
	out.push('');
	out.push('## Derived quantities');
	out.push('');
	out.push('These combine two metrics and are the ones most often written wrongly by hand.');
	out.push('');
	out.push('```promql');
	out.push('# Subscriber ratio. Exported as numerator and denominator on purpose: averaging');
	out.push('# per-worker ratios is NOT the cluster ratio.');
	out.push('ws_subscriptions / clamp_min(ws_connections, 1)');
	out.push('');
	out.push('# Descriptor headroom. Both sides are whole-process maxima, so this is already');
	out.push('# the process-wide truth - summing either side would multiply it by the worker count.');
	out.push('open_fds / clamp_min(fd_soft_limit, 1)');
	out.push('');
	out.push('# Share of upgrade attempts refused. Attempts the adapter never saw (a client that');
	out.push('# disconnects mid-handshake) are in neither term, so this can read below a load');
	out.push('# balancer\'s own refusal rate.');
	out.push('sum(rate(upgrade_rejected_total[5m]))');
	out.push('  / clamp_min(sum(rate(upgrade_admitted_total[5m])) + sum(rate(upgrade_rejected_total[5m])), 1)');
	out.push('');
	out.push('# Age of the pressure sample every gauge above was written from. The sampling timer');
	out.push('# is unref\'d; if it stops, those gauges keep serving their last value while the');
	out.push('# target still reports up. This is the only thing that tells you.');
	out.push('time() - pressure_sample_timestamp_seconds');
	out.push('```');
	out.push('');
	return out.join('\n') + '\n';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const next = render();
	if (process.argv.includes('--check')) {
		const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
		if (current !== next) {
			console.error('generate-observability: examples/observability/queries.md is stale.');
			console.error('  Run: node scripts/generate-observability.js');
			process.exit(1);
		}
		console.log('generate-observability: queries.md matches the signal manifest.');
	} else {
		writeFileSync(target, next);
		console.log(`generate-observability: wrote ${target}`);
	}
}
