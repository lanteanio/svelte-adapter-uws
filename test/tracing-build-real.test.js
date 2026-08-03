import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describe('generated tracing runtime', () => {
	beforeAll(() => {
		expect(buildFixtureOnce('grant'), 'grant fixture failed to build').toBe(true);
	}, 400000);

	it('loads the copied W3C helpers from the generated server root', async () => {
		const tracingUrl = pathToFileURL(join(fixtureDir, 'build-grant', 'tracing.js'));
		tracingUrl.searchParams.set('test', String(Date.now()));
		const runtime = await import(tracingUrl.href);

		expect(runtime.tracingEnabled).toBe(false);
		expect(runtime.extractTraceContext({
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
		})).toEqual({
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
		});
	});

	it('fails generated-server startup for a configured provider with no startSpan', async () => {
		expect(buildFixtureOnce('badtracing'), 'badtracing fixture failed to build').toBe(true);
		const tracingUrl = pathToFileURL(join(fixtureDir, 'build-bad-tracing', 'tracing.js'));
		tracingUrl.searchParams.set('test', String(Date.now()));

		await expect(import(tracingUrl.href)).rejects.toThrow(
			'configured tracing module must export a provider with startSpan(name, options)'
		);
	}, 400000);
});
