import { describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';

const parent = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };

describe('testing trace boundary', () => {
	it('exposes active and cleared contexts on the real testing platform', async () => {
		const server = await createTestServer({ handler: {} });
		try {
			const { platform } = server;
			expect(platform.trace.enabled).toBe(false);
			await platform.trace.withContext(parent, async () => {
				expect(platform.traceContext).toEqual(parent);
				await platform.trace.withContext(null, async () => {
					await Promise.resolve();
					expect(platform.trace.current()).toBeNull();
					expect(platform.traceContext).toBeNull();
					platform.trace.run('publish', {}, (span) => {
						expect(span).toBeNull();
						expect(platform.trace.inject({})).toEqual({});
					});
				});
				expect(platform.traceContext).toEqual(parent);
			});
			expect(platform.traceContext).toBeNull();
		} finally { await server.close(); }
	});
});
