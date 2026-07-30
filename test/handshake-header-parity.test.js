// Divergence gate: every surface that can write a 101 handshake header must
// reach the same verdict on the same VALUE.
//
// The two shape vectors are held to a per-surface expected verdict instead,
// because they are about WHEN a surface reads the caller's object rather than
// what it considers safe. upgradeResponse() validates the live object, so the
// mutate-after-read getter fires during validation and the helper refuses the
// value it just triggered; the runtime snapshots first and writes the clean
// value it validated. Both fail closed - they differ in what "the input" even
// is by the time each one looks at it.
//
// This exists because the guard was previously reimplemented per surface, so
// fixing production left the in-process test server exploitable - and the test
// server is a public export (`svelte-adapter-uws/testing`), which means an app
// could verify its own handshake against it, see a clean pass, and ship a
// splittable header. Any future surface, or any future divergence, fails here.
//
// The production runtime is held to the same vector table in
// upgrade-response-handshake-real.test.js, which boots the built artifact. It is
// a separate file only because it needs a fixture build; the vectors are shared.

import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { upgradeResponse } from '../src/upgrade-response.js';
import { rawUpgrade, hasUWS } from './helpers/real-runtime.js';
import {
	SAFE_VECTOR,
	SAFE_VECTORS,
	UNSAFE_VECTORS,
	VECTORS_BY_NAME,
	SHAPE_VECTORS,
	buildShapeHeaders
} from './helpers/handshake-vectors.js';

const describeUWS = hasUWS ? describe : describe.skip;

describe('upgradeResponse() helper refuses every unsafe handshake header', () => {
	for (const { name, value, why } of UNSAFE_VECTORS) {
		it(`rejects the ${name} vector at construction (${why})`, () => {
			expect(() => upgradeResponse({}, { 'set-cookie': value })).toThrow(TypeError);
		});
	}

	for (const { name, value, why } of SAFE_VECTORS) {
		it(`accepts the ${name} vector (${why})`, () => {
			expect(() => upgradeResponse({}, { 'set-cookie': value })).not.toThrow();
		});
	}

	it('refuses an own __proto__ key carrying a splitting value', () => {
		// Held here as well as at the two runtime surfaces. Applying the runtime's
		// own validate-what-you-write snapshot to this helper with a plain `{}`
		// would swallow the key through Object.prototype's setter, and the helper
		// would then accept exactly what the runtime refuses - the two-surface
		// divergence this file exists to catch, with every other test still green.
		expect(() => upgradeResponse({}, buildShapeHeaders(SHAPE_VECTORS.protoKey))).toThrow(TypeError);
	});

	for (const name of [SHAPE_VECTORS.stringBag, SHAPE_VECTORS.arrayBag]) {
		it(`refuses the malformed ${name} header container`, () => {
			expect(() => upgradeResponse({}, buildShapeHeaders(name))).toThrow(TypeError);
		});
	}

	for (const name of [SHAPE_VECTORS.invalidName, SHAPE_VECTORS.numberValue, SHAPE_VECTORS.coercionValue]) {
		it(`refuses the hostile ${name} header shape without coercing it`, () => {
			expect(() => upgradeResponse({}, buildShapeHeaders(name))).toThrow(TypeError);
		});
	}

	for (const name of [
		SHAPE_VECTORS.arraySliceIterator, SHAPE_VECTORS.arrayHooksThrow, SHAPE_VECTORS.arraySpeciesThrow
	]) {
		it(`accepts the real indexed value without executing ${name} hooks`, () => {
			expect(() => upgradeResponse({}, buildShapeHeaders(name))).not.toThrow();
		});
	}

	it('accepts a conditional no-header call instead of failing the upgrade', () => {
		// `upgradeResponse(ud, needsRefresh ? h : undefined)` is the natural way to
		// attach headers only sometimes. Validating an absent argument turned every
		// such upgrade into a 500; the runtime already skips the write when there
		// are no headers, so there is nothing to validate.
		expect(() => upgradeResponse({})).not.toThrow();
		expect(() => upgradeResponse({}, undefined)).not.toThrow();
		expect(() => upgradeResponse({}, /** @type {any} */ (null))).not.toThrow();
		expect(upgradeResponse({}, undefined).headers).toBeUndefined();
		expect(upgradeResponse({ id: 1 }, undefined).userData).toEqual({ id: 1 });
	});
});

describe('the Vite dev server validates the production handshake shape it cannot emit', () => {
	/** @type {import('node:http').Server | null} */
	let httpServer = null;
	let port = 0;

	afterAll(async () => {
		if (httpServer) await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
	});

	async function boot() {
		if (httpServer) return;
		const { default: uws } = await import('../src/vite.js');
		const handler = {
			upgrade({ headers }) {
				const shaped = buildShapeHeaders(headers['x-fixture-vector']);
				if (shaped) return { __upgradeResponse: true, userData: {}, headers: shaped };
				const value = VECTORS_BY_NAME.get(headers['x-fixture-vector']);
				if (value === undefined) return {};
				return { __upgradeResponse: true, userData: {}, headers: { 'set-cookie': value } };
			}
		};
		httpServer = createServer();
		await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
		port = /** @type {any} */ (httpServer.address()).port;
		const plugin = uws({ allowedOrigins: '*', handler: '/virtual-handshake-handler' });
		await plugin.configureServer({
			httpServer,
			middlewares: { use() {} },
			config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
			async ssrLoadModule() { return { default: handler, ...handler }; }
		});
	}

	for (const { name, why } of SAFE_VECTORS) {
		it(`accepts and discards the ${name} vector (${why})`, async () => {
			await boot();
			const { status } = await rawUpgrade(port, { 'x-fixture-vector': name });
			expect(status).toBe('101');
		});
	}

	for (const { name, why } of UNSAFE_VECTORS) {
		it(`refuses the ${name} vector just like production (${why})`, async () => {
			await boot();
			const { status, raw } = await rawUpgrade(port, { 'x-fixture-vector': name });
			expect(status).toBe('500');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
		});
	}

	it('copies an array-valued header when read, before a later getter can mutate it', async () => {
		await boot();
		const { status } = await rawUpgrade(port, { 'x-fixture-vector': SHAPE_VECTORS.mutateArrayAfterRead });
		expect(status).toBe('101');
	});

	for (const name of [
		SHAPE_VECTORS.arraySliceIterator, SHAPE_VECTORS.arrayHooksThrow, SHAPE_VECTORS.arraySpeciesThrow
	]) {
		it(`accepts the indexed array value without executing ${name} hooks`, async () => {
			await boot();
			const { status } = await rawUpgrade(port, { 'x-fixture-vector': name });
			expect(status).toBe('101');
		});
	}

	for (const name of [
		SHAPE_VECTORS.protoKey, SHAPE_VECTORS.stringBag, SHAPE_VECTORS.arrayBag,
		SHAPE_VECTORS.invalidName, SHAPE_VECTORS.numberValue, SHAPE_VECTORS.coercionValue
	]) {
		it(`refuses the hostile ${name} header shape just like production`, async () => {
			await boot();
			const { status, raw } = await rawUpgrade(port, { 'x-fixture-vector': name });
			expect(status).toBe('500');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
		});
	}
});

describeUWS('in-process test server matches production on every handshake header', () => {
	/** @type {any} */
	let server = null;

	afterAll(async () => { await server?.close(); });

	async function boot() {
		if (server) return server;
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				upgrade({ headers }) {
					const name = headers['x-fixture-vector'];
					// Same shared table and same shared builder the production fixture
					// uses, so both surfaces get identical bytes and identical shapes.
					const shaped = buildShapeHeaders(name);
					if (shaped) return { __upgradeResponse: true, userData: {}, headers: shaped };
					const value = VECTORS_BY_NAME.get(name);
					if (value === undefined) return {};
					// Duck-typed shape on purpose: it bypasses the helper's
					// construction-time validation, which is the only way to reach
					// the server's own pre-write check. An app reaches this by
					// mutating a helper result, or by building the shape by hand.
					return { __upgradeResponse: true, userData: {}, headers: { 'set-cookie': value } };
				}
			}
		});
		return server;
	}

	/** @param {any} s */
	const portOf = (s) => Number(new URL(s.url).port);

	for (const { name, value, why } of SAFE_VECTORS) {
		it(`completes the handshake for the ${name} vector (${why})`, async () => {
			const s = await boot();
			const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': name });
			expect(status).toBe('101');
			expect(raw.toLowerCase()).toContain('set-cookie:');
			// rawUpgrade decodes bytes as Latin-1; uWS encodes JS strings as UTF-8.
			const wireValue = Buffer.from(value, 'utf8').toString('latin1');
			expect(raw).toContain(wireValue);
		});
	}

	it('writes the validated snapshot, not a value the app rewrote after validation', async () => {
		// A getter on a LATER key rewrites an EARLIER key after its value has been
		// read, so validating the app's live object and reading it again at write
		// time would put the poisoned value on the wire. Deterministic and
		// intra-tick: no admission tuning involved.
		const s = await boot();
		const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': SHAPE_VECTORS.mutateAfterRead });
		expect(status, 'the clean value is safe, so the upgrade must succeed').toBe('101');
		expect(raw.toLowerCase()).toContain(`set-cookie: ${SAFE_VECTOR.value}`);
		expect(raw, 'the post-validation rewrite must not reach the wire').not.toContain('Injected');
	});

	it('copies an array-valued header when read, before a later getter can mutate it', async () => {
		const s = await boot();
		const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': SHAPE_VECTORS.mutateArrayAfterRead });
		expect(status).toBe('101');
		expect(raw.toLowerCase()).toContain(`set-cookie: ${SAFE_VECTOR.value}`);
		expect(raw).not.toContain('Injected');
	});

	for (const name of [
		SHAPE_VECTORS.arraySliceIterator, SHAPE_VECTORS.arrayHooksThrow, SHAPE_VECTORS.arraySpeciesThrow
	]) {
		it(`ignores ${name} hooks and writes the indexed value`, async () => {
			const s = await boot();
			const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': name });
			expect(status).toBe('101');
			expect(raw.toLowerCase()).toContain(`set-cookie: ${SAFE_VECTOR.value}`);
			expect(raw).not.toContain('Injected');
		});
	}

	for (const name of [
		SHAPE_VECTORS.protoKey, SHAPE_VECTORS.stringBag, SHAPE_VECTORS.arrayBag,
		SHAPE_VECTORS.invalidName, SHAPE_VECTORS.numberValue, SHAPE_VECTORS.coercionValue
	]) {
		it(`refuses the hostile ${name} header shape before writing a 101`, async () => {
			const s = await boot();
			const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': name });
			expect(status, 'an unsafe header shape must not yield a 101').not.toBe('101');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
			expect(raw).not.toContain('Injected');
		});
	}

	for (const { name, why } of UNSAFE_VECTORS) {
		it(`refuses the ${name} vector rather than writing it (${why})`, async () => {
			const s = await boot();
			const { status, raw } = await rawUpgrade(portOf(s), { 'x-fixture-vector': name });

			expect(status, 'a header that cannot be written safely must not yield a 101').not.toBe('101');
			expect(raw).not.toContain('Injected');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
			// Bites for every vector, including the ones whose payload contains no
			// 'Injected' text (nul, trailing): a refused upgrade writes no header at
			// all, so the value cannot have reached the wire in any form.
			expect(raw.toLowerCase()).not.toContain('set-cookie');
		});
	}
});
