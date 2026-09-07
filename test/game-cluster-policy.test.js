import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { expectStatement } from './helpers/source-pins.js';
import {
	GAME_LANE_CLUSTER_ERROR,
	assertGameLaneClusterSafe,
	gameLaneClusterSafe,
	routeGameFrame
} from '../src/runtime/handler/game-ingress.js';
import { WS_PUBLISH_GRANT } from '../src/runtime/utils.js';

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
		const ud = { [WS_PUBLISH_GRANT]: 'arena:1' };
		const ws = {
			getUserData: () => ud,
			// A denial that reached the socket directly would be an uncharged
			// control frame; the route must hand it to the surface's sender.
			send: () => { throw new Error('the denial bypassed the control sender'); }
		};
		const sendControl = (target, frame) => { expect(target).toBe(ws); sent.push(JSON.parse(frame)); };

		routeGameFrame(ws, undefined, { event: 'move', data: { x: 1 }, id: 9 }, { publishGame }, 1, sendControl, { ioWorkers: 2 });

		expect(publishGame).not.toHaveBeenCalled();
		expect(sent).toEqual([{ type: 'game-denied', reason: 'FORBIDDEN', id: 9 }]);
	});

	it('threads the resolved I/O count to workers and guards every production entry point', () => {
		// Line endings normalized on read: the publishGame anchor below spans a
		// line break, and a newline anywhere but position 0 needs the `\r` the
		// needle does not carry. (A leading-only newline is safe - CRLF ENDS
		// with `\n` - which is why the grantPublish anchor never had to care.)
		const read = (relative) =>
			readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
		const indexSource = read('../src/runtime/index.js');
		const platformSource = read('../src/runtime/handler/platform.js');
		const handlerSource = read('../src/runtime/handler.js');

		expect(indexSource).toContain('ioWorkers: io_count');
		// Each lane asserts its anchors were FOUND. Without this a missed
		// closing anchor slices to one-before-the-end, and both pins below pass
		// VACUOUSLY against the widened body - `assertGameLaneClusterSafe()`
		// appears somewhere later in the file whatever these two lanes do, so
		// the case would keep reporting a guard that had been deleted from the
		// lane it names.
		const carve = (label, from, to) => {
			const start = platformSource.indexOf(from);
			expect(start, `${label}: opening anchor ${JSON.stringify(from)} not found`).toBeGreaterThan(-1);
			const end = platformSource.indexOf(to, start);
			expect(end, `${label}: closing anchor ${JSON.stringify(to)} not found after it`).toBeGreaterThan(start);
			return platformSource.slice(start, end);
		};
		const grant = carve('grantPublish', '\tgrantPublish(', '\n\trevokePublish(');
		const publish = carve('publishGame', '\tpublishGame(', '\n\t/**\n\t * Unsubscribe');
		expectStatement(grant, 'assertGameLaneClusterSafe();', 'grantPublish refuses a forked game lane');
		expectStatement(publish, 'assertGameLaneClusterSafe();', 'publishGame refuses a forked game lane');
		expectStatement(handlerSource, 'const clusterSafe = gameLaneClusterSafe(workerData);', 'the handler resolves game-lane cluster safety once');
	});
});
