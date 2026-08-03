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
import {
	DATA_CLASSES,
	NO_DATA_POLICIES,
	OBSERVABILITY_SCHEMA_VERSION,
	SIGNALS,
	TELEMETRY_CONTRACT,
	TELEMETRY_LEVELS
} from '../src/runtime/observability-manifest.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const queryTarget = resolve(root, 'examples/observability/queries.md');
const contractTarget = resolve(root, 'docs/observability.md');
const typeTarget = resolve(root, 'src/observability.generated.d.ts');
const targetMatcher = 'adapter="svelte-adapter-uws"';

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
		// metricsSnapshot() is already one merged series per signal-label set.
		// A sum by only the signal labels would erase job/instance/cluster labels
		// and combine unrelated scrape targets.
		return `rate(${signal.name}{${targetMatcher}}[5m])`;
	}
	if (signal.type === 'histogram') {
		// Canonical quantile form: aggregate the bucket rates before
		// histogram_quantile. Removing only the metric's own bounded labels is
		// the target-preserving equivalent of the textbook `sum by (le)` - `le`
		// and every job/instance/cluster label survive, so independent
		// deployments are never merged.
		// A histogram with no bounded labels needs no aggregation at all: the
		// bucket series already carry le plus every job/instance/cluster label,
		// and a `sum by (le)` here would erase the target labels and merge
		// independent deployments - the exact failure the without-form avoids.
		const aggregated = signal.labels.length > 0
			? `sum without (${signal.labels.join(', ')}) (rate(${signal.name}_bucket{${targetMatcher}}[5m]))`
			: `rate(${signal.name}_bucket{${targetMatcher}}[5m])`;
		return `histogram_quantile(0.95, ${aggregated})`;
	}
	return `${signal.name}{${targetMatcher}}`;
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
	out.push('which returns one already-merged document for one deployment target. Add the scrape target');
	out.push('label `adapter="svelte-adapter-uws"`; the rules correlate each adapter target with its own');
	out.push('`up` series. Preserve job, instance, cluster and other external labels. A global `sum()`');
	out.push('would combine independent deployments. If you scrape `platform.metrics.serialize()` you read');
	out.push('one randomly chosen worker and none of these queries mean what they say.');
	out.push('Import `dashboard.v1.json` for a compact Grafana view of these target-preserving queries.');
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
	out.push(`ws_subscriptions{${targetMatcher}} / clamp_min(ws_connections{${targetMatcher}}, 1)`);
	out.push('');
	out.push('# Descriptor headroom. Both sides are whole-process maxima, so this is already');
	out.push('# the process-wide truth - summing either side would multiply it by the worker count.');
	out.push(`open_fds{${targetMatcher}} / clamp_min(fd_soft_limit{${targetMatcher}}, 1)`);
	out.push('');
	out.push('# Share of upgrade attempts refused. Attempts the adapter never saw (a client that');
	out.push('# disconnects mid-handshake) are in neither term, so this can read below a load');
	out.push('# balancer\'s own refusal rate.');
	out.push('(');
	out.push(`  sum without (reason) (rate(upgrade_rejected_total{${targetMatcher}}[5m]))`);
	out.push(`    or (0 * rate(upgrade_admitted_total{${targetMatcher}}[5m]))`);
	out.push(')');
	out.push('  /');
	out.push('(');
	out.push(`  rate(upgrade_admitted_total{${targetMatcher}}[5m])`);
	out.push('    +');
	out.push('    (');
	out.push(`      sum without (reason) (rate(upgrade_rejected_total{${targetMatcher}}[5m]))`);
	out.push(`        or (0 * rate(upgrade_admitted_total{${targetMatcher}}[5m]))`);
	out.push('    )');
	out.push(')');
	out.push('');
	out.push('# Age of the pressure sample every gauge above was written from. The sampling timer');
	out.push('# is unref\'d; if it stops, those gauges keep serving their last value while the');
	out.push('# target still reports up. This is the only thing that tells you.');
	out.push(`time() - pressure_sample_timestamp_seconds{${targetMatcher}}`);
	out.push('```');
	out.push('');
	out.push('All four ship as recording rules in `rules.yml` - `adapter:subscriber_ratio`,');
	out.push('`adapter:fd_headroom_ratio`, `adapter:upgrade_reject_ratio:rate5m` and');
	out.push('`adapter:pressure_sample_age_seconds` - alongside the transport SLO series');
	out.push('`adapter:http_error_ratio:rate5m`, `adapter:ws_message_error_ratio:rate5m`,');
	out.push('`adapter:http_request_duration_seconds:p95_5m`,');
	out.push('`adapter:http_request_duration_seconds:p95_by_method_5m` and');
	out.push('`adapter:ws_message_duration_seconds:p95_5m`. Chart and alert on the recorded');
	out.push('names; the dashboard already does.');
	out.push('');
	return out.join('\n') + '\n';
}

function tableCell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function labelDomainNote(signal) {
	if (signal.labels.length === 0) return '-';
	return signal.labels.map((label) => {
		const domain = signal.labelDomains[label];
		if (domain.kind === 'enum') return `${label}=${domain.values.join('/')}`;
		return `${label}=/${domain.pattern}/ (max ${domain.maxDistinct})`;
	}).join('; ');
}

function valueDomainNote(signal) {
	if (signal.valueDomain === null) return '-';
	return Object.entries(signal.valueDomain).map(([name, value]) => `${name}=${value}`).join('; ');
}

function bucketNote(signal) {
	if (signal.buckets === null) return '-';
	return signal.buckets.map((value) => String(value)).join(', ');
}

export function renderContract() {
	const out = [];
	out.push('# Observability contract');
	out.push('');
	out.push('<!-- GENERATED by scripts/generate-observability.js from src/runtime/observability-manifest.js. -->');
	out.push('');
	out.push(`Schema version: **${OBSERVABILITY_SCHEMA_VERSION}**.`);
	out.push('');
	out.push('This is the adapter-owned machine-readable contract exposed as');
	out.push('`svelte-adapter-uws/observability`. It defines the fields a conforming');
	out.push('structured event or log may use and the complete adapter metric inventory.');
	out.push('Sibling packages can consume and validate this schema; they retain ownership of');
	out.push('their own signal inventories. See the [package README](../README.md#cluster-wide-metrics)');
	out.push('for runtime setup and the [reference queries](../examples/observability/queries.md).');
	out.push('');
	out.push('A schema-version change is required before removing a field, changing a unit,');
	out.push('widening a label domain, changing a data class, or changing a no-data law.');
	out.push('Additive signals within the same schema version still require generated-doc and');
	out.push('contract-test updates.');
	out.push('');
	out.push('## Event and log envelope');
	out.push('');
	out.push(`Allowed levels: ${TELEMETRY_LEVELS.map((level) => '`' + level + '`').join(', ')}.`);
	out.push('');
	out.push('| Field | Required | Type | Data class | Domain |');
	out.push('| --- | --- | --- | --- | --- |');
	for (const [name, field] of Object.entries(TELEMETRY_CONTRACT.eventEnvelope.fields)) {
		out.push(`| \`${name}\` | ${field.required ? 'yes' : 'no'} | \`${field.type}\` | \`${field.dataClass}\` | ${field.values ? field.values.map((value) => '`' + value + '`').join(', ') : '-'} |`);
	}
	out.push('');
	out.push('The top-level `dataClass` is the most restrictive class carried anywhere in');
	out.push('the event. `event`, `component`, metric names, and metric labels are bounded');
	out.push('framework vocabulary: never copy a topic, user id, address, cookie, token,');
	out.push('payload, or arbitrary exception text into those fields. Application attributes');
	out.push('are omitted unless the deployer has classified and retained them deliberately.');
	out.push('');
	out.push('## Correlation and trace context');
	out.push('');
	out.push('| Field | Header | Adapter propagation | Data class |');
	out.push('| --- | --- | --- | --- |');
	for (const item of Object.values(TELEMETRY_CONTRACT.correlation)) {
		out.push(`| \`${item.field}\` | \`${item.header}\` | ${item.supported ? 'supported' : 'not currently propagated'} | \`${item.dataClass}\` |`);
	}
	out.push('');
	out.push('The adapter sanitizes `x-request-id` to printable ASCII at 128 characters and');
	out.push('generates a fresh id when it is absent or invalid. With the optional top-level');
	out.push('`tracing` provider configured, the adapter validates W3C `traceparent` and');
	out.push('`tracestate`, starts vendor-neutral spans for native HTTP and WebSocket work,');
	out.push('keeps context isolated across async operations, and exposes capture/injection on');
	out.push('`platform.trace`. The provider may return an OpenTelemetry Span directly.');
	out.push('Without a provider the tracing boundary is a no-op and allocates no spans.');
	out.push('');
	out.push('## Data classes and retention defaults');
	out.push('');
	out.push('| Class | Personal data | Default retention | Meaning |');
	out.push('| --- | --- | --- | --- |');
	for (const [name, item] of Object.entries(DATA_CLASSES)) {
		out.push(`| \`${name}\` | ${item.personalData ? 'yes' : 'no'} | \`${item.defaultRetention}\` | ${tableCell(item.description)} |`);
	}
	out.push('');
	out.push('## Metric no-data laws');
	out.push('');
	out.push('| Policy | Meaning |');
	out.push('| --- | --- |');
	for (const [name, meaning] of Object.entries(NO_DATA_POLICIES)) {
		out.push(`| \`${name}\` | ${tableCell(meaning)} |`);
	}
	out.push('');
	out.push('A zero is never substituted for an unavailable optional source. Required');
	out.push('registered counters may produce a real zero only when every reporting worker');
	out.push('attests the family; a required unsampled gauge makes the snapshot incomplete.');
	out.push('');
	out.push('## Adapter metric inventory');
	out.push('');
	out.push('| Metric | Type | Unit | Scope | Merge | Data class | Local no data | Snapshot no data | Label domains | Histogram buckets | Enum values |');
	out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const signal of SIGNALS) {
		out.push(`| \`${signal.name}\` | ${signal.type} | ${signal.unit ?? 'count'} | ${signal.scope} | ${signal.aggregate} | ${signal.dataClass} | \`${signal.noData.local}\` | \`${signal.noData.snapshot}\` | ${tableCell(labelDomainNote(signal))} | ${tableCell(bucketNote(signal))} | ${tableCell(valueDomainNote(signal))} |`);
	}
	out.push('');
	out.push('All metric labels are `operational`, bounded, and payload-free. The local');
	out.push('registry may apply an operator prefix when serializing; cluster snapshots and');
	out.push('this manifest always use the canonical unprefixed names.');
	out.push('');
	return out.join('\n') + '\n';
}

function union(values) {
	return values.map((value) => JSON.stringify(value)).join(' | ');
}

export function renderTypes() {
	const labels = [...new Set(SIGNALS.flatMap((signal) => signal.labels))].sort();
	const enumValues = [...new Set(SIGNALS.flatMap((signal) =>
		signal.valueDomain === null ? [] : Object.keys(signal.valueDomain)
	))].sort();
	return [
		'// Generated by scripts/generate-observability.js. Do not edit by hand.',
		`export type SignalName = ${union(SIGNALS.map((signal) => signal.name))};`,
		`export type MetricLabelName = ${union(labels)};`,
		`export type MetricEnumValue = ${union(enumValues)};`,
		`export type EventFieldName = ${union(Object.keys(TELEMETRY_CONTRACT.eventEnvelope.fields))};`,
		`export type DataClass = ${union(Object.keys(DATA_CLASSES))};`,
		`export type TelemetryLevel = ${union(TELEMETRY_LEVELS)};`,
		''
	].join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const nextQueries = render();
	const nextContract = renderContract();
	const nextTypes = renderTypes();
	if (process.argv.includes('--check')) {
		const currentQueries = readFileSync(queryTarget, 'utf8').replace(/\r\n/g, '\n');
		const currentContract = readFileSync(contractTarget, 'utf8').replace(/\r\n/g, '\n');
		const currentTypes = readFileSync(typeTarget, 'utf8').replace(/\r\n/g, '\n');
		if (currentQueries !== nextQueries || currentContract !== nextContract || currentTypes !== nextTypes) {
			if (currentQueries !== nextQueries) {
				console.error('generate-observability: examples/observability/queries.md is stale.');
			}
			if (currentContract !== nextContract) {
				console.error('generate-observability: observability.md is stale.');
			}
			if (currentTypes !== nextTypes) {
				console.error('generate-observability: src/observability.generated.d.ts is stale.');
			}
			console.error('  Run: node scripts/generate-observability.js');
			process.exit(1);
		}
		console.log('generate-observability: queries, contract docs, and public literal types match the signal manifest.');
	} else {
		writeFileSync(queryTarget, nextQueries);
		writeFileSync(contractTarget, nextContract);
		writeFileSync(typeTarget, nextTypes);
		console.log(`generate-observability: wrote ${queryTarget}`);
		console.log(`generate-observability: wrote ${contractTarget}`);
		console.log(`generate-observability: wrote ${typeTarget}`);
	}
}
