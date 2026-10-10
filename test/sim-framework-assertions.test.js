import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSim, replaySim } from '../src/sim.js';
import { assert as frameworkAssert, fatal } from '../src/runtime/utils/assertions.js';

afterEach(() => vi.restoreAllMocks());

function swallow(fn) {
	try { fn(); } catch {}
}

describe.each([1, 2])('framework assertions with %i worker(s)', (workers) => {
	it('counts swallowed soft and fatal assertions in deterministic category order', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// Establish a process insertion order that differs from category order.
		swallow(() => frameworkAssert(false, 'sim.zulu'));
		swallow(() => frameworkAssert(false, 'sim.alpha'));
		const result = await runSim({
			workers,
			async scenario() {
				swallow(() => frameworkAssert(false, 'sim.zulu'));
				swallow(() => frameworkAssert(false, 'sim.zulu'));
				swallow(() => fatal(false, 'sim.alpha'));
			}
		});
		expect(result.invariantViolations).toEqual([
			{ category: 'sim.alpha', context: { assertions: 1 } },
			{ category: 'sim.zulu', context: { assertions: 2 } }
		]);
		expect(result.schedulerUncaught).toEqual([]);
		expect((await replaySim(result)).reproduced).toBe(true);
	});

	it('includes swallowed assertions during worker initialization', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await runSim({ workers, handler: {
			init() { swallow(() => frameworkAssert(false, 'sim.initialization')); }
		} });
		expect(result.invariantViolations).toEqual([
			{ category: 'sim.initialization', context: { assertions: workers } }
		]);
	});

	it('includes assertions in connection close hooks during teardown', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await runSim({
			workers,
			handler: { close() { swallow(() => frameworkAssert(false, 'sim.close')); } },
			async scenario(api) {
				if (workers === 1) api.connect();
				else for (let i = 0; i < workers; i++) api.worker(i).connect();
				await api.advance();
			}
		});
		expect(result.invariantViolations).toEqual([
			{ category: 'sim.close', context: { assertions: workers } }
		]);
	});

	it('excludes violations from earlier runs', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		swallow(() => frameworkAssert(false, 'sim.previous'));
		const result = await runSim({ workers });
		expect(result.invariantViolations).toEqual([]);
	});
});

it('includes swallowed assertions during server teardown', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const result = await runSim({
		async scenario({ server }) {
			const close = server.close.bind(server);
			server.close = async () => {
				await close();
				swallow(() => frameworkAssert(false, 'sim.teardown'));
			};
		}
	});
	expect(result.invariantViolations).toEqual([
		{ category: 'sim.teardown', context: { assertions: 1 } }
	]);
});
