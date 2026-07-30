// Header injection on the 101 handshake, driven against the REAL built runtime.
//
// Why a second suite: every existing case builds its headers through
// upgradeResponse(), which validates at CONSTRUCTION time and throws inside the
// hook, so the request never reaches the handshake write loop. The runtime's own
// pre-write check is therefore never executed by those tests - delete it and
// they all stay green. This suite hands the runtime the duck-typed shape
// instead (what an app produces by mutating a helper result after
// construction), which is the only way to reach that check.
//
// The client only NAMES a vector; the bytes are minted server-side in the
// fixture handler. Carrying them in a request header does not work - uWS's
// request parser consumes or rejects CR, LF, obs-fold and NUL before any hook
// runs, so the hook would receive an already-clean value and the test would
// pass while proving nothing.
//
// Assertions are on the RAW RESPONSE BYTES: the defect is defined as bytes
// appearing on the wire, so that is what gets asserted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade } from './helpers/real-runtime.js';
import { SAFE_VECTOR, SAFE_VECTORS, UNSAFE_VECTORS, SHAPE_VECTORS } from './helpers/handshake-vectors.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('101 handshake header injection (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'crlf',
			env: { ORIGIN: undefined, TRUSTED_PROXIES: undefined, CLUSTER_WORKERS: undefined }
		});
	}, 400000);

	afterAll(async () => { await server?.stop(); });

	for (const { name, value, why } of SAFE_VECTORS) {
		it(`completes the handshake for the ${name} vector (${why})`, async () => {
			// Control: proves the response-header path is actually reached, so a
			// refusal below is the guard acting and not the fixture failing to wire up.
			const { status, raw } = await rawUpgrade(server.port, { 'x-fixture-vector': name });
			expect(status).toBe('101');
			expect(raw.toLowerCase()).toContain('set-cookie:');
			// rawUpgrade decodes bytes as Latin-1; uWS encodes JS strings as UTF-8.
			const wireValue = Buffer.from(value, 'utf8').toString('latin1');
			expect(raw).toContain(wireValue);
		});
	}

	it('writes the validated snapshot, not a value the app rewrote after validation', async () => {
		// The app's headers object stays the app's own, so reading it once to
		// validate and again to write is two reads of mutable state. This vector
		// makes the second read differ: a getter on a LATER key rewrites an
		// EARLIER key after its value has already been read, within one pass of
		// Object.entries. No admission tuning is needed - the write runs
		// synchronously in the default configuration, so the window is intra-tick
		// and the outcome is deterministic.
		const { status, raw } = await rawUpgrade(server.port, { 'x-fixture-vector': SHAPE_VECTORS.mutateAfterRead });
		expect(status, 'the clean value is safe, so the upgrade must succeed').toBe('101');
		expect(raw.toLowerCase()).toContain(`set-cookie: ${SAFE_VECTOR.value}`);
		expect(raw, 'the post-validation rewrite must not reach the wire').not.toContain('Injected');
	});

	it('copies an array-valued header when read, before a later getter can mutate it', async () => {
		const { status, raw } = await rawUpgrade(server.port, { 'x-fixture-vector': SHAPE_VECTORS.mutateArrayAfterRead });
		expect(status).toBe('101');
		expect(raw.toLowerCase()).toContain(`set-cookie: ${SAFE_VECTOR.value}`);
		expect(raw).not.toContain('Injected');
	});

	for (const name of [
		SHAPE_VECTORS.arraySliceIterator, SHAPE_VECTORS.arrayHooksThrow, SHAPE_VECTORS.arraySpeciesThrow
	]) {
		it(`ignores app-controlled ${name} hooks and writes the indexed value`, async () => {
			// The slice/iterator vector changes bytes between validation and write;
			// the other two throw if snapshotting executes app-controlled hooks.
			const { status, raw } = await rawUpgrade(server.port, {
				'x-fixture-vector': name
			});
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
			const { status, raw } = await rawUpgrade(server.port, { 'x-fixture-vector': name });
			expect(status, 'an unsafe header shape must not yield a 101').not.toBe('101');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
			expect(raw).not.toContain('Injected');
		});
	}

	// Driven from the shared vector table, which the fixture handler reads too, so
	// a vector added or edited there reaches every surface at once.
	for (const { name, why } of UNSAFE_VECTORS) {
		it(`refuses the upgrade rather than writing the ${name} vector into the 101 (${why})`, async () => {
			const { status, raw } = await rawUpgrade(server.port, { 'x-fixture-vector': name });

			expect(status, 'a header value that cannot be written safely must not yield a 101').not.toBe('101');
			expect(raw).not.toContain('Injected');
			expect(raw.toLowerCase()).not.toContain('switching protocols');
			// Bites for every vector, including the ones whose payload contains no
			// 'Injected' text (nul, trailing): a refused upgrade writes no header at
			// all, so the value cannot have reached the wire in any form.
			expect(raw.toLowerCase()).not.toContain('set-cookie');
		});
	}
});
