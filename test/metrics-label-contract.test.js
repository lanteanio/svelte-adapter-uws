// Contract: every label key EMITTED into a metrics instrument must be
// DECLARED at that instrument's registration.
//
// The adapter documents a Prometheus-shaped registry for `websocket.metrics`:
// counter(name, help, labelNames). A strict registry (the extensions
// createMetrics(), prom-client) THROWS when inc() carries a label that was
// never declared - and containMetricInstrument swallows that throw after one
// console.error, so on the documented registry the counter silently never
// increments. This shipped once: upgrade_rate_map_evicted_total emitted
// { door: 'upgrade' | 'auth' } from both rate limiters while the registration
// declared no labels, so the door split (and the whole counter) was dead
// everywhere except the fixture's aggregating registry, which deliberately
// ignores labels and therefore cannot see the class.
//
// What this pins: for every instrument registered in the runtime sources,
// every label key any emit site passes is a subset of the declared
// labelNames. Scanned statically (the only complete view - no test boots
// every emit path), then replayed against a strict registry so the failure
// mode itself is exercised.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { SIGNALS } from '../src/runtime/observability-manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Metric names in the README's metrics table. Anchored on the header row
 * rather than a heading, so the table can move. Only the FIRST cell is read:
 * the description cells backtick plenty of things that are not metric names
 * (reject reasons, `max()`, option names), and harvesting the whole row would
 * invent metrics that do not exist.
 *
 * @returns {Set<string>}
 */
function readmeTableMetrics() {
	const lines = readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n');
	const header = lines.findIndex((l) => l.trim().startsWith('| Metric | Type | Across workers |'));
	expect(header, 'the README metrics table header row was not found - if the table moved or its columns changed, update this parser').toBeGreaterThan(-1);
	const names = new Set();
	// Skip the header and the |---| separator beneath it.
	for (let i = header + 2; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith('|')) break;
		const cell = line.split('|')[1] ?? '';
		const m = /`([a-z][a-z0-9_]*)(\{[^}]*\})?`/.exec(cell);
		if (m) names.add(m[1]);
	}
	return names;
}

/**
 * Metric names in the `metrics` option's JSDoc bullet list in src/index.d.ts.
 *
 * Only names at the HEAD of a bullet count - the text between `- ` and the
 * ` - ` that introduces the description. The surrounding block backticks
 * option names, `platform.assertions`, reject reasons and a whole `@example`,
 * and it also names metrics belonging to OTHER options further down the file,
 * so both a block boundary and a bullet-head anchor are needed.
 *
 * @returns {Set<string>}
 */
function dtsListedMetrics() {
	const lines = readFileSync(path.join(ROOT, 'src/index.d.ts'), 'utf8').split('\n');
	const start = lines.findIndex((l) => l.includes('the adapter registers and emits:'));
	expect(start, 'the metrics option JSDoc preamble was not found in src/index.d.ts').toBeGreaterThan(-1);
	const end = lines.findIndex((l, i) => i > start && l.includes('metrics?: string;'));
	expect(end, 'the metrics option declaration was not found after its JSDoc').toBeGreaterThan(start);
	const names = new Set();
	for (const line of lines.slice(start, end)) {
		const bullet = /^\s*\*\s+-\s+(.+)$/.exec(line);
		if (!bullet) continue;
		const head = bullet[1].split(' - ')[0];
		for (const m of head.matchAll(/`([a-z][a-z0-9_]*)(\{[^}]*\})?`/g)) names.add(m[1]);
	}
	return names;
}

// Every file that registers instruments on the operator-supplied registry
// (the `websocket.metrics` contract). wireAssertionMetrics receives that same
// registry from the handler, so its registration and emit are in scope too.
const FILES = [
	'src/runtime/handler.js',
	'src/testing.js',
	'src/runtime/utils/assertions.js'
];

const FACTORY_METHODS = new Set(['counter', 'gauge', 'histogram']);
const EMIT_METHODS = new Set(['inc', 'dec', 'set', 'observe']);

/** Flatten an acorn tree into an array of nodes (same idiom as the option contract). */
function nodes(root) {
	const out = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) { for (const item of node) visit(item); return; }
		if (typeof node.type !== 'string') return;
		out.push(node);
		for (const [key, value] of Object.entries(node)) {
			if (key === 'type' || key === 'start' || key === 'end') continue;
			visit(value);
		}
	};
	visit(root);
	return out;
}

/** Property name of a member/optional-member expression, else null. */
function memberName(expr) {
	if (!expr || (expr.type !== 'MemberExpression' && expr.type !== 'OptionalMemberExpression')) return null;
	return !expr.computed && expr.property?.type === 'Identifier' ? expr.property.name : null;
}

/** The counter/gauge/histogram factory call inside an expression, if any. */
function findFactoryCall(expr) {
	if (!expr) return null;
	// METRICS?.counter(...) parses as a ChainExpression wrapping the call.
	if (expr.type === 'ChainExpression') return findFactoryCall(expr.expression);
	if (expr.type !== 'CallExpression') return null;
	if (FACTORY_METHODS.has(memberName(expr.callee))) return expr;
	// containMetricInstrument(<factory>) - the emit wrapper used everywhere.
	if (expr.callee?.type === 'Identifier' && expr.callee.name === 'containMetricInstrument') {
		return expr.arguments.length > 0 ? findFactoryCall(expr.arguments[0]) : null;
	}
	return null;
}

/**
 * Unwrap the shapes an instrument binding takes in these sources:
 *   containMetricInstrument(METRICS?.counter(...))
 *   cond ? containMetricInstrument(METRICS?.gauge(...)) : undefined
 *   metrics.counter(...)                       (wireAssertionMetrics)
 */
function unwrapFactory(expr) {
	if (!expr) return null;
	const direct = findFactoryCall(expr);
	if (direct) return direct;
	if (expr.type === 'ConditionalExpression') {
		return unwrapFactory(expr.consequent) ?? unwrapFactory(expr.alternate);
	}
	return null;
}

/**
 * Scan one source file. Returns:
 *   registrations: Map<varName, { metric, labels: Set<string>, file }>
 *   emits: [{ varName, method, keys: string[], file }]
 */
function scan(file) {
	const src = readFileSync(path.join(ROOT, file), 'utf8');
	const tree = nodes(parse(src, { ecmaVersion: 'latest', sourceType: 'module' }));
	const registrations = new Map();
	const emits = [];

	for (const node of tree) {
		// const mX = <wrapped factory>   |   boundCounter = metrics.counter(...)
		let varName = null;
		let init = null;
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
			varName = node.id.name;
			init = node.init;
		} else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
			varName = node.left.name;
			init = node.right;
		}
		if (varName && init) {
			const factory = unwrapFactory(init);
			if (factory && factory.arguments[0]?.type === 'Literal' && typeof factory.arguments[0].value === 'string') {
				const labelsArg = factory.arguments[2];
				const labels = new Set();
				if (labelsArg) {
					// Declared labelNames must be a literal array of strings - anything
					// dynamic defeats this scan and is itself a failure below.
					expect(
						labelsArg.type === 'ArrayExpression' &&
						labelsArg.elements.every((el) => el?.type === 'Literal' && typeof el.value === 'string'),
						`${file}: ${factory.arguments[0].value} labelNames must be a literal string array`
					).toBe(true);
					for (const el of labelsArg.elements) labels.add(el.value);
				}
				registrations.set(varName, { metric: factory.arguments[0].value, labels, file });
			}
		}

		// mX?.inc({ ... }) / mX.inc({ ... }) / gX?.set(n) / boundCounter.inc({ ... })
		if (node.type === 'CallExpression') {
			const method = memberName(node.callee);
			if (!method || !EMIT_METHODS.has(method)) continue;
			const object = node.callee.object;
			if (object?.type !== 'Identifier') continue;
			const labelsArg = node.arguments[0];
			if (!labelsArg || labelsArg.type !== 'ObjectExpression') continue;
			const keys = [];
			for (const prop of labelsArg.properties) {
				// A spread or computed key cannot be checked statically; fail loudly
				// rather than letting an unchecked label through.
				expect(
					prop.type === 'Property' && !prop.computed &&
					((prop.key.type === 'Identifier') || (prop.key.type === 'Literal' && typeof prop.key.value === 'string')),
					`${file}: ${object.name}.${method}() labels must be literal keys`
				).toBe(true);
				keys.push(prop.key.type === 'Identifier' ? prop.key.name : prop.key.value);
			}
			emits.push({ varName: object.name, method, keys, file });
		}
	}
	return { registrations, emits };
}

describe('metrics label contract', () => {
	const scanned = FILES.map(scan);
	const registrations = new Map();
	const emits = [];
	for (const { registrations: r, emits: e } of scanned) {
		for (const [k, v] of r) registrations.set(k, v);
		emits.push(...e);
	}

	it('every emitted label key is declared at the instrument registration', () => {
		const violations = [];
		for (const emit of emits) {
			const reg = registrations.get(emit.varName);
			if (!reg) continue; // not an instrument variable (no factory binding found)
			for (const key of emit.keys) {
				if (!reg.labels.has(key)) {
					violations.push(
						`${emit.file}: ${emit.varName}.${emit.method}() emits label "${key}" ` +
						`not declared on "${reg.metric}" (declared: ${[...reg.labels].join(', ') || '(none)'})`
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it('the scan is not vacuous and pins the shipped door-label regression', () => {
		// Self-check: if the scan silently stops finding registrations or emits,
		// the contract above is proving nothing.
		expect(registrations.size).toBeGreaterThanOrEqual(12);
		expect(emits.length).toBeGreaterThanOrEqual(12);
		const door = [...registrations.values()].find((r) => r.metric === 'upgrade_rate_map_evicted_total');
		expect(door, 'upgrade_rate_map_evicted_total registration not found').toBeTruthy();
		expect([...door.labels]).toEqual(['door']);
		const doorEmit = emits.find((e) => e.varName === 'mUpgradeRateEvicted');
		expect(doorEmit?.keys).toEqual(['door']);
	});

	// The scan above proves what the code DOES. These prove that the manifest
	// and the two hand-written inventories agree with it. The scan cannot know
	// a metric's unit or how it combines across workers, and the manifest
	// cannot know whether the code actually registers what it declares, so the
	// two are complementary and each catches what the other cannot see.
	describe('signal manifest and documentation parity', () => {
		/** Metric name -> declared labels, as the code actually registers them. */
		const registered = new Map();
		for (const reg of registrations.values()) {
			const existing = registered.get(reg.metric);
			// The same metric is registered by both the production handler and the
			// test harness; the declarations must not disagree.
			if (existing !== undefined) {
				expect([...reg.labels].sort(), `"${reg.metric}" is registered twice with different labels`).toEqual([...existing].sort());
			}
			registered.set(reg.metric, reg.labels);
		}
		const manifest = new Map(SIGNALS.map((s) => [s.name, s]));
		const fromRegistry = SIGNALS.filter((s) => s.merged !== true).map((s) => s.name);

		it('every registered metric is declared in the manifest, with matching labels', () => {
			const undeclared = [...registered.keys()].filter((n) => !manifest.has(n)).sort();
			expect(
				undeclared,
				'registered in code but absent from src/runtime/observability-manifest.js: ' + JSON.stringify(undeclared) +
				'. A metric with no manifest entry has no declared aggregation law, so platform.metricsSnapshot() cannot merge it across workers and will pass it through per-worker as if it were the app\'s own.'
			).toEqual([]);

			const mismatched = [];
			for (const [name, labels] of registered) {
				const signal = manifest.get(name);
				if (signal === undefined) continue;
				const declared = [...labels].sort();
				const claimed = [...signal.labels].sort();
				if (JSON.stringify(declared) !== JSON.stringify(claimed)) {
					mismatched.push(`${name}: code ${JSON.stringify(declared)} vs manifest ${JSON.stringify(claimed)}`);
				}
			}
			expect(mismatched).toEqual([]);
		});

		it('every manifest signal that a worker registers is registered in code', () => {
			const phantom = fromRegistry.filter((n) => !registered.has(n)).sort();
			expect(
				phantom,
				'declared in the manifest but never registered in code: ' + JSON.stringify(phantom) +
				'. Either the registration was removed and the manifest entry is stale, or the entry needs `merged: true` because the cluster merge writes it rather than a worker registering it.'
			).toEqual([]);
		});

		it('every signal appears in the README metrics table', () => {
			const table = readmeTableMetrics();
			const missing = SIGNALS.map((s) => s.name).filter((n) => !table.has(n)).sort();
			expect(missing, 'missing from the README metrics table: ' + JSON.stringify(missing)).toEqual([]);
			const phantom = [...table].filter((n) => !manifest.has(n)).sort();
			expect(phantom, 'the README metrics table lists names no code registers: ' + JSON.stringify(phantom)).toEqual([]);
		});

		it('every registry-registered signal appears in the metrics option JSDoc', () => {
			const listed = dtsListedMetrics();
			const missing = fromRegistry.filter((n) => !listed.has(n)).sort();
			expect(missing, 'missing from the `metrics` option list in src/index.d.ts: ' + JSON.stringify(missing)).toEqual([]);
			const phantom = [...listed].filter((n) => !manifest.has(n)).sort();
			expect(phantom, 'the `metrics` option list names metrics no code registers: ' + JSON.stringify(phantom)).toEqual([]);
		});

		it('the manifest is internally coherent', () => {
			const problems = [];
			for (const s of SIGNALS) {
				if (!['counter', 'gauge'].includes(s.type)) problems.push(`${s.name}: unknown type ${s.type}`);
				if (!['sum', 'max', 'min'].includes(s.aggregate)) problems.push(`${s.name}: unknown aggregation ${s.aggregate}`);
				if (!['worker', 'process'].includes(s.scope)) problems.push(`${s.name}: unknown scope ${s.scope}`);
				// A process-wide reading is the same number on every worker, so
				// adding them up multiplies one truth by the worker count.
				if (s.scope === 'process' && s.aggregate === 'sum') {
					problems.push(`${s.name}: process-scoped values must not sum across workers`);
				}
				// A counter only ever accumulates, so summing is the only law that
				// preserves what it counted.
				if (s.type === 'counter' && s.aggregate !== 'sum') {
					problems.push(`${s.name}: counters must sum across workers, not ${s.aggregate}`);
				}
				if (s.name.endsWith('_total') !== (s.type === 'counter')) {
					problems.push(`${s.name}: the _total suffix and the counter type must agree`);
				}
				if (s.unit === 'bytes' && !s.name.endsWith('_bytes')) problems.push(`${s.name}: byte-valued metrics end in _bytes`);
				if (s.unit === 'seconds' && !s.name.endsWith('_seconds')) problems.push(`${s.name}: second-valued metrics end in _seconds`);
				// The house convention is no millisecond-valued metric at all -
				// a mixed-unit metric set is how a dashboard silently reads 1000x.
				if (/_ms$|_milliseconds$/.test(s.name)) problems.push(`${s.name}: durations are seconds, never milliseconds`);
			}
			expect(problems).toEqual([]);
		});

		it('no label can carry client identity', () => {
			// The privacy fence the runtime already keeps by hand: no topic
			// string, IP, session or user identifier is ever a label value, so no
			// label NAME may suggest one either. Cardinality follows from the same
			// rule - every declared label is a bounded, source-declared vocabulary.
			const forbidden = /ip|addr|user|session|client|topic|token|email|account|tenant|key/i;
			const offenders = [];
			for (const s of SIGNALS) {
				for (const label of s.labels) {
					if (forbidden.test(label)) offenders.push(`${s.name}{${label}}`);
				}
			}
			expect(
				offenders,
				'these labels read as client identity, which must never reach a metric: ' + JSON.stringify(offenders)
			).toEqual([]);
		});
	});

	it('replay against a strict registry: no emit throws on an undeclared label', () => {
		// Mirrors the extensions createMetrics()/prom-client failure mode:
		// inc() with an undeclared label throws; containMetricInstrument would
		// swallow it in production, which is exactly why this is a test and not
		// a log line.
		const strict = {
			counter: (name, help, labelNames = []) => ({
				inc(labels = {}) {
					for (const key of Object.keys(labels)) {
						if (!labelNames.includes(key)) {
							throw new Error(`unexpected label "${key}" for metric "${name}" (no labels declared)`);
						}
					}
				}
			})
		};
		strict.gauge = strict.counter;
		strict.histogram = strict.counter;
		for (const reg of registrations.values()) {
			const instrument = strict.counter(reg.metric, '', [...reg.labels]);
			for (const emit of emits.filter((e) => registrations.get(e.varName) === reg)) {
				const labels = Object.fromEntries(emit.keys.map((k) => [k, 'x']));
				expect(() => instrument.inc(labels), `${reg.metric} emit threw`).not.toThrow();
			}
		}
	});
});
