import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	GAME_LANE_CLUSTER_ERROR,
	assertGameLaneClusterSafe,
	gameLaneClusterSafe,
	routeGameFrame
} from '../src/runtime/handler/game-ingress.js';
import { WS_PUBLISH_GRANT, WS_STATS } from '../src/runtime/utils.js';

describe('game lane cluster topology guard', () => {
	it('accepts only the single socket-owning home, by role, not just by I/O count', () => {
		expect(gameLaneClusterSafe(null)).toBe(true);
		expect(gameLaneClusterSafe({ ioWorkers: 1 })).toBe(true);
		expect(gameLaneClusterSafe({ ioWorkers: 1, role: 'io' })).toBe(true);
		// A compute worker in the SUPPORTED 1-I/O topology has no sockets: a
		// publishGame there would run a second, silently-empty room sequencer
		// forked from the real one - the exact failure this guard exists for.
		expect(gameLaneClusterSafe({ ioWorkers: 1, role: 'compute' })).toBe(false);
		expect(gameLaneClusterSafe({ ioWorkers: 2 })).toBe(false);
		expect(gameLaneClusterSafe({ ioWorkers: 2, role: 'io' })).toBe(false);
		expect(() => assertGameLaneClusterSafe({ ioWorkers: 4 })).toThrow(GAME_LANE_CLUSTER_ERROR);
		expect(() => assertGameLaneClusterSafe({ ioWorkers: 1, role: 'compute' })).toThrow(GAME_LANE_CLUSTER_ERROR);
	});

	it('denies binary ingress before fan-out in an unsafe multi-I/O-worker topology', () => {
		const sent = [];
		const publishGame = vi.fn();
		const ud = {
			[WS_PUBLISH_GRANT]: 'arena:1',
			[WS_STATS]: { messagesOut: 0, bytesOut: 0 }
		};
		const ws = {
			getUserData: () => ud,
			send: (frame) => { sent.push(JSON.parse(frame)); return true; }
		};

		routeGameFrame(ws, undefined, { event: 'move', data: { x: 1 }, id: 9 }, { publishGame }, 1, { ioWorkers: 2 });

		expect(publishGame).not.toHaveBeenCalled();
		expect(sent).toEqual([{ type: 'game-denied', reason: 'FORBIDDEN', id: 9 }]);
		expect(ud[WS_STATS].messagesOut).toBe(1);
		expect(ud[WS_STATS].bytesOut).toBeGreaterThan(0);
	});

	it('threads the resolved I/O count to workers and guards every production entry point', () => {
		const indexSource = readFileSync(new URL('../src/runtime/index.js', import.meta.url), 'utf8');
		const platformSource = readFileSync(new URL('../src/runtime/handler/platform.js', import.meta.url), 'utf8');
		const handlerSource = readFileSync(new URL('../src/runtime/handler.js', import.meta.url), 'utf8');

		expect(indexSource).toContain('ioWorkers: io_count');
		const grant = platformSource.slice(platformSource.indexOf('\tgrantPublish('), platformSource.indexOf('\n\trevokePublish('));
		const publish = platformSource.slice(platformSource.indexOf('\tpublishGame('), platformSource.indexOf('\n\t/**\n\t * Unsubscribe', platformSource.indexOf('\tpublishGame(')));
		expect(grant).toContain('assertGameLaneClusterSafe()');
		expect(publish).toContain('assertGameLaneClusterSafe()');
		expect(handlerSource).toContain('const clusterSafe = gameLaneClusterSafe(workerData);');
	});
});
