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
import {
	SIGNALS,
	validateObservabilityContract
} from '../src/runtime/observability-manifest.js';

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

/** Exact, bidirectional signal contract from the README's canonical table. */
function readmeSignalContract() {
	const lines = readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\r?\n/);
	const header = lines.findIndex((l) => l.trim().startsWith('| Metric | Factory/type | Labels | Unit | Scope | Aggregate | Origin | Formula | Help |'));
	expect(header, 'the README canonical signal contract table was not found').toBeGreaterThan(-1);
	const contract = new Map();
	for (let i = header + 2; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith('|')) break;
		const cells = line.split('|').map((cell) => cell.trim());
		const metric = /^`([a-z][a-z0-9_]*)`$/.exec(cells[1] ?? '');
		if (!metric) continue;
		expect(contract.has(metric[1]), `the canonical README table lists ${metric[1]} twice`).toBe(false);
		contract.set(metric[1], {
			type: cells[2],
			labels: cells[3] === '-' ? [] : cells[3].split(','),
			unit: cells[4] === 'count' ? null : cells[4],
			scope: cells[5],
			aggregate: cells[6],
			merged: cells[7] === 'merge',
			formula: cells[8] === '-' ? undefined : cells[8].replace(/^`|`$/g, ''),
			help: cells[9]
		});
	}
	return contract;
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

/**
 * The text between a matching delimiter pair, starting at the first `open` at
 * or after `from`. Depth-counted rather than line-matched: an interface member
 * spans lines, and the nearest closing brace at column zero is not reliably the
 * one that closes the declaration.
 *
 * @param {string} text
 * @param {number} from
 * @param {string} open
 * @param {string} close
 * @returns {string}
 */
function balanced(text, from, open, close) {
	const start = text.indexOf(open, from);
	if (start === -1) throw new Error(`no ${open} at or after index ${from}`);
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return text.slice(start + 1, i);
	}
	throw new Error(`unbalanced ${open}${close} from index ${from}`);
}

/**
 * Split on a separator appearing at nesting depth zero, so a `;` inside a
 * returned instrument type or a `,` inside an options object does not split a
 * declaration. `>` is only a closer when it is not the tail of an arrow, or
 * every function-typed property would unbalance the count.
 *
 * @param {string} text
 * @param {string} sep
 * @returns {string[]}
 */
function splitTopLevel(text, sep) {
	const out = [];
	let depth = 0;
	let last = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
		else if (c === '}' || c === ')' || c === ']') depth--;
		else if (c === '>' && text[i - 1] !== '=') depth--;
		else if (c === sep && depth === 0) {
			out.push(text.slice(last, i));
			last = i + 1;
		}
	}
	out.push(text.slice(last));
	return out.filter((s) => s.trim() !== '');
}

/**
 * The `MetricsRegistry` interface in src/index.d.ts: each member's name,
 * whether it is optional, and its parameter names rebuilt in the shape the
 * README documents them (`counter(name, help, labelNames?)`).
 *
 * SIGNATURES, not just names. The drift this exists to catch is a method still
 * documented in the positional form after the type moved to an options object,
 * which is invisible to a comparison of names alone.
 *
 * @returns {Map<string, { optional: boolean, signature: string }>}
 */
function dtsRegistryContract() {
	const text = readFileSync(path.join(ROOT, 'src/index.d.ts'), 'utf8').replace(/\r\n/g, '\n');
	const marker = 'export interface MetricsRegistry {';
	const first = text.indexOf(marker);
	expect(first, 'the MetricsRegistry interface was not found in src/index.d.ts').toBeGreaterThan(-1);
	expect(
		text.indexOf(marker, first + 1),
		'MetricsRegistry is declared more than once; TypeScript merges those declarations and this parser reads only the first'
	).toBe(-1);

	// Comments carry `@example` blocks with their own braces and semicolons,
	// which would otherwise parse as members.
	const body = balanced(text, first + marker.length - 1, '{', '}')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');

	/** @type {Map<string, { optional: boolean, signature: string }>} */
	const members = new Map();
	for (const chunk of splitTopLevel(body, ';')) {
		// `counter(` is method syntax; `counter: (` is a property holding a
		// function type. Both declare the same contract, so both must be seen -
		// the property form is the prevailing style elsewhere in this file.
		const head = /^\s*([A-Za-z_$][\w$]*)\s*(\??)\s*(?::\s*)?\(/.exec(chunk);
		if (!head) continue;
		const params = balanced(chunk, chunk.indexOf('('), '(', ')');
		const names = splitTopLevel(params, ',')
			.map((p) => /^\s*(\.\.\.)?([A-Za-z_$][\w$]*)\s*(\??)/.exec(p))
			.filter((m) => m !== null)
			.map((m) => `${m[1] ?? ''}${m[2]}${m[3]}`);
		expect(
			members.has(head[1]),
			`MetricsRegistry declares ${head[1]} twice; the README can only document one of them`
		).toBe(false);
		members.set(head[1], { optional: head[2] === '?', signature: `${head[1]}(${names.join(', ')})` });
	}
	return members;
}

/**
 * The README's registry contract table: the same three facts, read out of the
 * documented signature and the Required column. Anchored on the header row
 * rather than a heading, in the same idiom as the metrics table above.
 *
 * @returns {Map<string, { optional: boolean, signature: string }>}
 */
function readmeRegistryContract() {
	const lines = readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\r?\n/);
	const header = lines.findIndex((l) => l.trim().startsWith('| Method | Required |'));
	expect(header, 'the README registry contract table header row was not found - if the table moved or its columns changed, update this parser').toBeGreaterThan(-1);
	/** @type {Map<string, { optional: boolean, signature: string }>} */
	const methods = new Map();
	// Skip the header and the |---| separator beneath it.
	for (let i = header + 2; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith('|')) break;
		const cells = line.split('|').map((c) => c.trim());
		const m = /^`([A-Za-z_$][\w$]*)(\([^`]*\))`/.exec(cells[1] ?? '');
		if (!m) continue;
		// Exactly `yes` or `no`. Reading "anything that is not yes" as optional
		// makes an empty or misspelled cell agree with whatever the types say,
		// so the column would be unverifiable for the optional methods - the
		// only ones whose optionality is worth stating.
		const required = (cells[2] ?? '').toLowerCase();
		expect(
			['yes', 'no'],
			`the Required cell for ${m[1]} reads ${JSON.stringify(cells[2] ?? '')}; it must be exactly yes or no`
		).toContain(required);
		expect(
			methods.has(m[1]),
			`the README registry contract table lists ${m[1]} twice, so it can state two different contracts`
		).toBe(false);
		methods.set(m[1], { optional: required === 'no', signature: m[1] + m[2] });
	}
	return methods;
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
				const factoryType = memberName(factory.callee);
				let labelsArg = factory.arguments[2];
				if (factoryType === 'histogram') {
					const options = factory.arguments[2];
					expect(
						options?.type === 'ObjectExpression',
						`${file}: ${factory.arguments[0].value} histogram options must be a literal object`
					).toBe(true);
					const optionProperty = (name) => options.properties.find((property) =>
						property.type === 'Property' && !property.computed &&
						((property.key.type === 'Identifier' && property.key.name === name) ||
						(property.key.type === 'Literal' && property.key.value === name))
					);
					labelsArg = optionProperty('labelNames')?.value;
					const bucketsArg = optionProperty('buckets')?.value;
					expect(
						bucketsArg?.type === 'Identifier' || bucketsArg?.type === 'ArrayExpression',
						`${file}: ${factory.arguments[0].value} must pass explicit buckets`
					).toBe(true);
				}
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
				const helpArg = factory.arguments[1];
				expect(
					helpArg?.type === 'Literal' && typeof helpArg.value === 'string',
					`${file}: ${factory.arguments[0].value} help must be a literal string so parity is auditable`
				).toBe(true);
				registrations.set(varName, {
					metric: factory.arguments[0].value,
					type: factoryType,
					help: helpArg.value,
					labels,
					file
				});
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
		it('the shared observability schema is complete', () => {
			expect(validateObservabilityContract()).toEqual([]);
		});

		/** Metric name -> exact factory contract, as the code registers it. */
		const registered = new Map();
		for (const reg of registrations.values()) {
			const existing = registered.get(reg.metric);
			// The same metric is registered by both the production handler and the
			// test harness; the declarations must not disagree.
			if (existing !== undefined) {
				expect(
					{ type: reg.type, help: reg.help, labels: [...reg.labels] },
					`"${reg.metric}" is registered twice with different factory contracts`
				).toEqual({ type: existing.type, help: existing.help, labels: [...existing.labels] });
			}
			registered.set(reg.metric, reg);
		}
		const manifest = new Map(SIGNALS.map((s) => [s.name, s]));
		const fromRegistry = SIGNALS.filter((s) => s.merged !== true).map((s) => s.name);

		it('every registered metric exactly matches manifest factory type, labels, and help', () => {
			const undeclared = [...registered.keys()].filter((n) => !manifest.has(n)).sort();
			expect(
				undeclared,
				'registered in code but absent from src/runtime/observability-manifest.js: ' + JSON.stringify(undeclared) +
				'. A metric with no manifest entry has no declared aggregation law, so platform.metricsSnapshot() cannot merge it across workers and will pass it through per-worker as if it were the app\'s own.'
			).toEqual([]);

			const mismatched = [];
			for (const [name, reg] of registered) {
				const signal = manifest.get(name);
				if (signal === undefined) continue;
				const code = { type: reg.type, labels: [...reg.labels], help: reg.help };
				const claimed = { type: signal.type, labels: [...signal.labels], help: signal.help };
				if (JSON.stringify(code) !== JSON.stringify(claimed)) mismatched.push(`${name}: code ${JSON.stringify(code)} vs manifest ${JSON.stringify(claimed)}`);
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

		it('the canonical README table exactly matches every manifest field and formula, bidirectionally', () => {
			const documented = readmeSignalContract();
			const missing = SIGNALS.map((s) => s.name).filter((name) => !documented.has(name));
			const phantom = [...documented.keys()].filter((name) => !manifest.has(name));
			expect(missing, 'manifest signals missing from the canonical README contract: ' + JSON.stringify(missing)).toEqual([]);
			expect(phantom, 'canonical README contract rows absent from the manifest: ' + JSON.stringify(phantom)).toEqual([]);
			const mismatched = [];
			for (const signal of SIGNALS) {
				const docs = documented.get(signal.name);
				if (docs === undefined) continue;
				const expected = {
					type: signal.type,
					labels: [...signal.labels],
					unit: signal.unit,
					scope: signal.scope,
					aggregate: signal.aggregate,
					merged: signal.merged === true,
					formula: signal.formula,
					help: signal.help
				};
				if (JSON.stringify(docs) !== JSON.stringify(expected)) {
					mismatched.push(`${signal.name}: README ${JSON.stringify(docs)} vs manifest ${JSON.stringify(expected)}`);
				}
			}
			expect(mismatched).toEqual([]);
		});

		it('every registry-registered signal appears in the metrics option JSDoc', () => {
			const listed = dtsListedMetrics();
			const missing = fromRegistry.filter((n) => !listed.has(n)).sort();
			expect(missing, 'missing from the `metrics` option list in src/index.d.ts: ' + JSON.stringify(missing)).toEqual([]);
			const phantom = [...listed].filter((n) => !manifest.has(n)).sort();
			expect(phantom, 'the `metrics` option list names metrics no code registers: ' + JSON.stringify(phantom)).toEqual([]);
		});

		it('the testing declaration names every harness metric and distinguishes event-driven headroom', () => {
			const text = readFileSync(path.join(ROOT, 'src/testing.d.ts'), 'utf8');
			const declaration = text.indexOf('metrics?: MetricsRegistry;');
			expect(declaration, 'the testing metrics option declaration was not found').toBeGreaterThan(-1);
			const start = text.lastIndexOf('/**', declaration);
			const docs = text.slice(start, declaration);
			const harnessMetrics = new Set(
				[...scanned.find((entry) => [...entry.registrations.values()].some((reg) => reg.file === 'src/testing.js')).registrations.values()]
					.filter((reg) => reg.file === 'src/testing.js')
					.map((reg) => reg.metric)
			);
			for (const metric of harnessMetrics) {
				expect(
					new RegExp('`' + metric + '(?:\\{[^}]*\\})?`').test(docs),
					`src/testing.d.ts does not name the harness metric ${metric}`
				).toBe(true);
			}
			expect(harnessMetrics).toContain('ws_connection_headroom');
			expect(docs).toMatch(/event-driven `ws_connection_headroom` gauge/);
			expect(docs).toMatch(/pressure-sampled gauges[\s\S]*production-only/);
		});

		it('the manifest is internally coherent', () => {
			const problems = [];
			for (const s of SIGNALS) {
				if (!['counter', 'gauge', 'histogram'].includes(s.type)) problems.push(`${s.name}: unknown type ${s.type}`);
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
				if (s.type === 'histogram' && s.aggregate !== 'sum') {
					problems.push(`${s.name}: histograms must sum across workers, not ${s.aggregate}`);
				}
				if (s.name.endsWith('_total') !== (s.type === 'counter')) {
					problems.push(`${s.name}: the _total suffix and the counter type must agree`);
				}
				if (s.unit === 'bytes' && !(s.type === 'counter'
					? s.name.endsWith('_bytes_total')
					: s.name.endsWith('_bytes'))) {
					problems.push(`${s.name}: byte-valued metrics end in _bytes (before _total for counters)`);
				}
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

		it('the registry contract is documented method for method, signature included', () => {
			// `metrics` takes a registry the OPERATOR supplies, so every member of
			// the interface is a thing somebody has to implement against the README.
			// A method declared in the types and absent from the README ships a
			// contract nobody can discover, and a method documented in the wrong
			// SHAPE is worse: `histogram` takes an options object, and a registry
			// told to expect a positional `labelNames` never receives buckets. Its
			// samples land in whatever the registry defaults to, and samples already
			// recorded into the wrong buckets cannot be repaired afterwards.
			const declared = dtsRegistryContract();
			const documented = readmeRegistryContract();

			// Non-vacuity: a named probe that only matches if the walk reached the
			// LAST member, plus a floor. `declared.size > 0` would not fire on a
			// parser that stops halfway, and a member the parser never sees is
			// exactly the one that can go undocumented.
			expect([...declared.keys()], 'the MetricsRegistry walk did not reach `serialize`, so it stopped early and proves nothing about what follows').toContain('serialize');
			expect(declared.size, 'the MetricsRegistry walk found fewer members than the interface has').toBeGreaterThanOrEqual(4);

			const missing = [...declared.keys()].filter((m) => !documented.has(m));
			expect(missing, 'declared in the MetricsRegistry interface but missing from the README registry contract table: ' + JSON.stringify(missing)).toEqual([]);

			const phantom = [...documented.keys()].filter((m) => !declared.has(m));
			expect(phantom, 'the README registry contract table documents methods the interface does not declare: ' + JSON.stringify(phantom)).toEqual([]);

			/** @type {string[]} */
			const disagree = [];
			for (const [name, dts] of declared) {
				const readme = documented.get(name);
				if (!readme) continue;
				// Optionality is part of the contract: a registry author reads
				// "Required: yes" and implements it.
				if (readme.optional !== dts.optional) {
					disagree.push(`${name}: index.d.ts says ${dts.optional ? 'optional' : 'required'}, the README says ${readme.optional ? 'optional' : 'required'}`);
				}
				if (readme.signature !== dts.signature) {
					disagree.push(`${name}: index.d.ts declares ${dts.signature}, the README documents ${readme.signature}`);
				}
			}
			expect(disagree, 'the types and the README disagree: ' + JSON.stringify(disagree)).toEqual([]);

			// The runtime's own view of the contract, so the types and the README
			// cannot agree with each other while both drift from the code that
			// actually calls the registry.
			const unknownToTypes = [...FACTORY_METHODS].filter((m) => !declared.has(m));
			expect(unknownToTypes, 'the runtime registers instruments through factories the MetricsRegistry interface does not declare: ' + JSON.stringify(unknownToTypes)).toEqual([]);
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
