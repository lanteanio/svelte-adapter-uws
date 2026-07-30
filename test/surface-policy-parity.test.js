// The oracle that stops the socket surfaces diverging again.
//
// WHY A SOURCE SCAN. `src/runtime/handler.js` (production), `src/testing.js`
// (the published `svelte-adapter-uws/testing` server) and `src/vite.js` (the
// dev server) each own their own plumbing, so no behavioural test can cheaply
// prove they make the SAME decision in every configuration - and behavioural
// tests are exactly what missed this class repeatedly. Every divergence found
// in this area was found by reading the files side by side:
//
//   - the plugin-owned carve-out reached the batch path on all three surfaces
//     and the single path on one, so a documented group join worked or failed
//     depending on microtask coalescing;
//   - the recover guard reached two surfaces of three, so the test server
//     served a revoked topic's replay history and denied the subscribe after;
//   - the gap-fill fall-through reached one surface, so a regression test
//     written against the documented harness passed against the old behaviour;
//   - the same decision was spelled `isNew` in one file and `!subs.has(topic)`
//     in another, which is how it drifted unnoticed in the first place.
//
// WHY EVERYTHING HERE RESOLVES THROUGH THE AST AND THE IMPORT BINDING. This
// file has been defeated twice by adversarial review, and the second time was
// worse than the first:
//
//   v1 asserted a surface merely CONTAINED a call to each predicate. One call
//   in the single lane satisfied it while three other lanes had none.
//
//   v2 scanned lines for a list of known inline spellings. Wrapping any
//   expression across two lines evaded every pattern at once - and these call
//   sites sit at eight tabs of indentation, so wrapping is the NATURAL
//   formatting, not a contrivance. One pattern could never fire at any of the
//   three sites it was written for.
//
//   v3 (AST rules, but text everywhere else) was defeated in minutes: the
//   import check was `src.includes('subscribe-policy.js')`, which a COMMENT
//   satisfies, and the call counts were `src.split(fn).length - 1`, which
//   comments and dead code satisfy. A reviewer deleted the import from
//   `src/vite.js`, gave the dev surface its own local copies of all five
//   predicates, left one comment mentioning the path, and every oracle in the
//   project stayed green. That is the pre-extraction state exactly.
//
// So: a call counts only when the callee RESOLVES TO THE IMPORT. A surface must
// import the policy through a real ImportDeclaration, unaliased, and may not
// shadow any policy name with a local binding. Text appearing in a comment
// cannot satisfy any rule here, because comments are not in the tree.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

// ONE list. `SURFACES` and a separate file list used to sit side by side here,
// and they drifted: production's `platform.js` was counted but never scanned,
// so its `platform.subscribe` lane sat with two raw cap comparisons while the
// same lane on the other two surfaces asked the policy.
const SURFACES = [
	{
		label: 'production',
		// Production splits its platform helpers out; the other two keep theirs inline.
		files: ['src/runtime/handler.js', 'src/runtime/handler/platform.js']
	},
	{ label: 'the in-process test server', files: ['src/testing.js'] },
	{ label: 'the dev plugin', files: ['src/vite.js'] }
];

// Files that decide subscribes without being a surface. `ws-symbols.js` holds
// the plugin lane (`trackedSubscribe`) and carried its own copy of the cap;
// `state.js` and `subscribe-hooks.js` hold the two AXES every gate reads
// (`subscribeAuth` and `hasUserSubscribeHook`), so a re-derivation hidden there
// would be invisible while looking exactly like the shared decision; `caps.js`
// is where the cap value itself lives.
const SHARED = [
	'src/runtime/utils/ws-symbols.js',
	'src/runtime/handler/state.js',
	'src/runtime/handler/subscribe-hooks.js',
	'src/runtime/utils/caps.js'
];

const POLICY = 'src/runtime/utils/subscribe-policy.js';
const POLICY_NAMES = [
	'deniesWireSystemTopicSubscribe',
	'deniesWireSubscribePreHook',
	'deniesWireSubscribeLanding',
	'wantsRecover',
	'recoverIsRevoked',
	'exceedsSubscriptionCap'
];

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/**
 * Every node paired with its ancestor chain, nearest first.
 *
 * Hand-rolled because acorn-walk is not a dependency. Note the thing that must
 * NOT be hand-rolled: a JS SCANNER. One previously read `/['"]/` as a string
 * opening and ate 42,000 characters of a source file. Parsing is acorn's job.
 * @param {string} src
 */
function nodesWithAncestors(src) {
	const out = [];
	const root = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	const visit = (node, ancestors) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, ancestors);
			return;
		}
		if (typeof node.type !== 'string') return;
		out.push({ node, ancestors });
		const next = [node, ...ancestors];
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
			visit(node[key], next);
		}
	};
	visit(root, []);
	return out;
}

/** Names this file imports from the policy module, as {local -> imported}. */
function policyImports(nodes) {
	/** @type {Map<string, string>} */
	const found = new Map();
	for (const { node } of nodes) {
		if (node.type !== 'ImportDeclaration') continue;
		if (typeof node.source?.value !== 'string' || !node.source.value.includes('subscribe-policy.js')) continue;
		for (const spec of node.specifiers) {
			if (spec.type === 'ImportSpecifier') found.set(spec.local.name, spec.imported.name);
		}
	}
	return found;
}

/** Every local binding name declared in this file (function, const/let/var, class). */
function localBindings(nodes) {
	const names = new Set();
	for (const { node } of nodes) {
		if (node.type === 'FunctionDeclaration' && node.id) names.add(node.id.name);
		else if (node.type === 'ClassDeclaration' && node.id) names.add(node.id.name);
		else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') names.add(node.id.name);
	}
	return names;
}

/**
 * Calls to `fnName` whose callee resolves to the policy import.
 *
 * A bare identifier that is NOT the imported local name does not count, so a
 * local shadow scores zero rather than satisfying the minimum. Text in a
 * comment scores zero because comments are not nodes.
 */
function realCallCount(nodes, imports, fnName) {
	let local = null;
	for (const [localName, imported] of imports) if (imported === fnName) local = localName;
	if (local === null) return 0;
	let n = 0;
	for (const { node } of nodes) {
		if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === local) n++;
	}
	return n;
}

const parsed = new Map();
/** @param {string} f */
function ast(f) {
	if (!parsed.has(f)) {
		const nodes = nodesWithAncestors(read(f));
		parsed.set(f, { nodes, imports: policyImports(nodes), locals: localBindings(nodes) });
	}
	return parsed.get(f);
}

describe('every socket surface routes its subscribe decisions through the shared policy', () => {
	for (const { label, files } of SURFACES) {
		it(`${label} imports the policy through a real import, unaliased`, () => {
			const importing = files.filter((f) => ast(f).imports.size > 0);
			expect(
				importing.length,
				`${label} must have an ImportDeclaration from subscribe-policy.js in one of ${files.join(', ')} - ` +
				'a mention in a comment is not an import, and that is exactly how this check was defeated before'
			).toBeGreaterThan(0);

			// Aliasing would put every name-keyed rule below out of reach.
			for (const f of files) {
				const aliased = [...ast(f).imports.entries()].filter(([localName, imported]) => localName !== imported);
				expect(aliased, `${f} aliases a policy import: ${aliased.map(([l, i]) => `${i} as ${l}`).join(', ')}`).toEqual([]);
			}
		});

		it(`${label} does not shadow a policy name with its own binding`, () => {
			// A local `function exceedsSubscriptionCap(...)` would satisfy every
			// call count while the real decision never runs. This is the shape a
			// reviewer used to give the dev surface private copies of all five.
			for (const f of files) {
				const { imports, locals } = ast(f);
				const shadowed = POLICY_NAMES.filter((n) => locals.has(n) && !imports.has(n));
				expect(
					shadowed,
					`${f} declares its own ${shadowed.join(', ')} - the surface would be asking itself, not the policy`
				).toEqual([]);
			}
		});
	}

	// COUNTS, not presence - and REAL calls, not text. v1 asserted only that a
	// surface contained a call to each predicate, and one call in the single
	// lane satisfied it while three other lanes had none.
	//
	// The numbers are the counts the lanes actually have. Raise them when a
	// surface gains a lane; NEVER lower one to clear a red - a red here means a
	// lane stopped asking, which is the whole point of the file.
	const PREDICATE_MINIMUMS = [
		{ fn: 'deniesWireSystemTopicSubscribe', min: 2 }, // single + batch
		{ fn: 'deniesWireSubscribePreHook', min: 2 },   // single + batch
		{ fn: 'deniesWireSubscribeLanding', min: 2 },
		{ fn: 'wantsRecover', min: 2 },
		{ fn: 'recoverIsRevoked', min: 2 },
		{ fn: 'exceedsSubscriptionCap', min: 5 }        // 2 wire + 1 batch + 2 platform.subscribe
	];

	for (const { label, files } of SURFACES) {
		for (const { fn, min } of PREDICATE_MINIMUMS) {
			it(`${label} really calls ${fn} at least ${min}x`, () => {
				const n = files.reduce((acc, f) => {
					const { nodes, imports } = ast(f);
					return acc + realCallCount(nodes, imports, fn);
				}, 0);
				expect(
					n,
					`${label} has ${n} RESOLVED call(s) to ${fn} across ${files.join(', ')}, expected >= ${min}. ` +
					'Only a call whose callee is the imported binding counts - a comment, a dead call or a local ' +
					'shadow does not.'
				).toBeGreaterThanOrEqual(min);
			});
		}
	}

	// A resolved call with an omitted axis is still a private re-definition of
	// the policy: `topic` omitted from the plugin landing makes its membership
	// proof vanish, while all call-count checks remain green. Pin the complete
	// object contract at every call site, not merely the callee name.
	const REQUIRED_POLICY_FIELDS = [
		{ fn: 'deniesWireSystemTopicSubscribe', fields: ['allowSystem', 'topic'] },
		{ fn: 'deniesWireSubscribeLanding', fields: ['armed', 'hasUserHook', 'held', 'topic'] },
		{ fn: 'recoverIsRevoked', fields: ['held', 'wireAuthz', 'cancelled', 'topic'] }
	];
	for (const { label, files } of SURFACES) {
		for (const { fn, fields } of REQUIRED_POLICY_FIELDS) {
			it(`${label} passes every ${fn} policy axis`, () => {
				const offenders = [];
				for (const file of files) {
					const { nodes, imports } = ast(file);
					for (const { node } of nodes) {
						if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') continue;
						if (imports.get(node.callee.name) !== fn) continue;
						const arg = node.arguments[0];
						const present = new Set(
							arg?.type === 'ObjectExpression'
								? arg.properties.map((p) => p.key?.name ?? p.key?.value)
								: []
						);
						const missing = fields.filter((field) => !present.has(field));
						if (missing.length) offenders.push(`${file}:${node.loc.start.line} missing ${missing.join(', ')}`);
					}
				}
				expect(
					offenders,
					`${fn} calls must pass the full shared-policy contract: ${offenders.join('; ')}`
				).toEqual([]);
			});
		}
	}

	// The enrolment machinery is the revocation guard rather than a policy
	// decision, so it is counted by name across the surface's files. These are
	// the REAL counts, asserted as EQUALITY: the previous global minimum of 11
	// carried two of slack on production and testing, and a reviewer deleted the
	// batch lane's revocation guard outright while this file stayed green; a
	// floor also stays green when a NEW enroller appears without its own
	// settle discipline, which is precisely how the observer lane in
	// ws-symbols.js shipped without the held seed or a denial-exit reading. An
	// exact count forces every added or removed call site through this table.
	// The held-at-landing branches settle through settleHeldSubscribe - the
	// plain settle cannot read the membership's provenance there - and the
	// hook-DENIAL exits settle through settleDeniedSubscribe, which answers
	// whether a membership the denied attempt installed mid-window must be
	// unwound. All three spellings are pinned, because a lane that reverts to
	// the plain settle at either branch loses its provenance reading silently
	// and stays green otherwise.
	//
	// The shared row is the enrolment that lives OUTSIDE the surfaces: the
	// observer lane (authorizeDerivedSubscribe) begins, settles and reads its
	// denial provenance in ws-symbols.js itself, and trackedUnsubscribe
	// tombstones there. The per-surface rows cannot see it, so it is counted
	// where it lives.
	const ENROLMENT = [
		{ fn: 'beginPendingSubscribe', production: 3, testing: 3, dev: 3, shared: 1 },
		{ fn: 'settlePendingSubscribe', production: 7, testing: 6, dev: 6, shared: 1 },
		{ fn: 'settleHeldSubscribe', production: 4, testing: 4, dev: 4, shared: 1 },
		{ fn: 'settleDeniedSubscribe', production: 3, testing: 3, dev: 3, shared: 1 },
		{ fn: 'tombstonePendingSubscribe', production: 2, testing: 2, dev: 2, shared: 1 }
	];
	const KEY = {
		production: 'production',
		'the in-process test server': 'testing',
		'the dev plugin': 'dev',
		'the shared enrolment primitive': 'shared'
	};
	const ENROLMENT_GROUPS = [
		...SURFACES,
		{ label: 'the shared enrolment primitive', files: ['src/runtime/utils/ws-symbols.js'] }
	];

	for (const { label, files } of ENROLMENT_GROUPS) {
		for (const entry of ENROLMENT) {
			const want = entry[KEY[label]];
			it(`${label} really calls ${entry.fn} exactly ${want}x`, () => {
				const n = files.reduce((acc, f) => {
					const { nodes } = ast(f);
					let c = 0;
					for (const { node } of nodes) {
						if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === entry.fn) c++;
					}
					return acc + c;
				}, 0);
				expect(
					n,
					`${label} has ${n} resolved call(s) to ${entry.fn}, expected exactly ${want} - either a lane ` +
					'lost its enrolment/settle, or an enroller was added without updating this table (and a new ' +
					'enroller must seed held at creation and read settleDeniedSubscribe at its denial exit)'
				).toBe(want);
			});
		}
	}
});

describe('every observer lane revalidates its grant after the async hook', () => {
	const observerSurfaces = [
		{ label: 'production', file: 'src/runtime/handler/platform.js' },
		{ label: 'the in-process test server', file: 'src/testing.js' },
		{ label: 'the dev plugin', file: 'src/vite.js' }
	];

	for (const { label, file } of observerSurfaces) {
		it(`${label} asks deniesUngrantedObserve before and after its await`, () => {
			const { nodes } = ast(file);
			const imports = [];
			for (const { node } of nodes) {
				if (node.type !== 'ImportDeclaration') continue;
				for (const spec of node.specifiers || []) {
					if (spec.type === 'ImportSpecifier' && spec.imported?.name === 'deniesUngrantedObserve') {
						imports.push(spec);
					}
				}
			}
			expect(imports, `${file} must import the shared observer decision exactly once`).toHaveLength(1);
			expect(
				imports[0].local.name,
				`${file} must not alias the shared observer decision`
			).toBe('deniesUngrantedObserve');

			const methods = nodes
				.map(({ node }) => node)
				.filter((node) => node.type === 'Property' &&
					(node.key?.name ?? node.key?.value) === 'checkSubscribe' &&
					node.value?.type === 'FunctionExpression');
			expect(methods, `${file} must expose exactly one checkSubscribe method`).toHaveLength(1);
			const method = methods[0].value;
			const calls = nodes
				.filter(({ node, ancestors }) =>
					node.type === 'CallExpression' &&
					node.callee?.type === 'Identifier' &&
					node.callee.name === 'deniesUngrantedObserve' &&
					ancestors.includes(method))
				.map(({ node }) => node);
			const awaits = nodes
				.filter(({ node, ancestors }) => node.type === 'AwaitExpression' && ancestors.includes(method))
				.map(({ node }) => node);

			expect(
				calls,
				`${file} must check the observer grant once before and once after the hook await`
			).toHaveLength(2);
			expect(awaits, `${file} checkSubscribe should have one authorization await`).toHaveLength(1);
			expect(calls[0].start).toBeLessThan(awaits[0].start);
			expect(calls[1].start).toBeGreaterThan(awaits[0].end);
		});
	}
});

describe('no surface re-derives a decision the policy owns', () => {
	const SCANNED = [...SURFACES.flatMap((s) => s.files), ...SHARED];

	// THE CAP. The constant may be imported, and READ only as the `max` property
	// of an `exceedsSubscriptionCap` argument. Anything else is a surface
	// computing the answer itself, whatever the spelling - `>=`, `> max - 1`,
	// operands swapped, a hoisted local, or wrapped across lines.
	//
	// Note `max:` specifically, not "anywhere inside the call": the previous
	// version exempted any node nested in an argument, which let a reviewer
	// smuggle the whole comparison in as a different property -
	// `exceedsSubscriptionCap({ held: subs.size >= MAX_..., size: 0, max: 1 })`.
	for (const file of SCANNED) {
		it(`${file} reads the subscription cap only as exceedsSubscriptionCap's max`, () => {
			const { nodes, imports } = ast(file);
			let capLocal = 'MAX_SUBSCRIPTIONS_PER_CONNECTION';
			const offenders = [];
			for (const { node, ancestors } of nodes) {
				if (node.type === 'ImportSpecifier' && node.imported?.name === capLocal && node.local?.name !== capLocal) {
					offenders.push(`${file}:${node.loc.start.line} (aliased import)`);
					continue;
				}
				if (node.type !== 'Identifier' || node.name !== capLocal) continue;
				if (ancestors.some((a) => a.type === 'ImportDeclaration' || a.type === 'ExportNamedDeclaration')) continue;
				// caps.js is where it is declared.
				if (ancestors.some((a) => a.type === 'VariableDeclarator' && a.id === node)) continue;
				const prop = ancestors[0];
				const isMaxValue = prop?.type === 'Property' && prop.value === node && prop.key?.name === 'max';
				const call = ancestors.find((a) => a.type === 'CallExpression');
				const inPolicyCall = isMaxValue && call?.callee?.type === 'Identifier' &&
					imports.get(call.callee.name) === 'exceedsSubscriptionCap';
				if (!inPolicyCall) offenders.push(`${file}:${node.loc.start.line}`);
			}
			expect(
				offenders,
				`the per-connection cap belongs to exceedsSubscriptionCap, which scopes it to a topic the socket ` +
				`does not already hold - these references re-derive it: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	it('the cap constant is a real finite number, declared once', () => {
		// The cap rule above is the ONLY defence this decision has: the cap is
		// 1,000,000, so no behavioural test can reach it. Editing caps.js is
		// therefore a way to disable it that every other rule would miss.
		const src = read('src/runtime/utils/caps.js');
		const m = src.match(/export const MAX_SUBSCRIPTIONS_PER_CONNECTION\s*=\s*([0-9_]+);/);
		expect(m, 'caps.js must declare MAX_SUBSCRIPTIONS_PER_CONNECTION as a numeric literal').not.toBeNull();
		const value = Number(m[1].replace(/_/g, ''));
		expect(Number.isFinite(value), `the cap must be finite, got ${m[1]}`).toBe(true);
		expect(value, 'a cap of 0 or below would refuse every subscribe').toBeGreaterThan(0);
	});

	// THE PLUGIN CARVE-OUT. It stands the wire gate aside, and is safe only
	// because deniesWireSubscribeLanding re-tests real membership behind it. A
	// surface applying it builds its own exemption with nothing guaranteed to
	// re-check - which, on the observer gate and the client-named resume filter,
	// served a private group's buffered history to any client that named it.
	for (const file of SCANNED) {
		it(`${file} does not apply the plugin-owned carve-out itself`, () => {
			const { nodes } = ast(file);
			const offenders = [];
			for (const { node, ancestors } of nodes) {
				// Same aliased-import ban the cap rule has: `import
				// { isPluginOwnedTopic as _owned }` reintroduced the historical
				// hole at the batch landing while every rule stayed green.
				if (node.type === 'ImportSpecifier' && node.imported?.name === 'isPluginOwnedTopic') {
					if (node.local?.name !== 'isPluginOwnedTopic') offenders.push(`${file}:${node.loc.start.line} (aliased import)`);
					continue;
				}
				if (node.type !== 'Identifier' || node.name !== 'isPluginOwnedTopic') continue;
				if (ancestors.some((a) => a.type === 'ImportDeclaration' || a.type === 'ExportNamedDeclaration')) continue;
				offenders.push(`${file}:${node.loc.start.line}`);
			}
			expect(
				offenders,
				`the plugin-owned carve-out belongs to deniesWireSubscribePreHook and must not be applied in a lane ` +
				`with no landing re-check behind it: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	it('the policy module still spells the decisions out', () => {
		// A guard for the guard: if the policy module stopped containing the
		// decisions, every rule above would pass vacuously against three surfaces
		// asking an empty module.
		const src = read(POLICY);
		for (const fn of POLICY_NAMES) {
			expect(src, `${POLICY} must still export ${fn}`).toContain(`export function ${fn}(`);
		}
		expect(src, 'the cap decision must live here').toContain('size >= max');
		expect(src, 'the carve-out must live here').toContain('isPluginOwnedTopic(topic)');
	});
});
