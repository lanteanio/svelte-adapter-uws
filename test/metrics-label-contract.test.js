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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
