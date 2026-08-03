import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rollup } from 'rollup';
import { writeAndCloseRollupBundle } from '../src/build/rollup-lifecycle.js';

const dirs = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outputDir() {
	const dir = mkdtempSync(path.join(tmpdir(), 'adapter-uws-rollup-close-'));
	dirs.push(dir);
	return dir;
}

async function buildWith(observer) {
	return rollup({
		input: 'virtual:entry',
		plugins: [
			{
				name: 'virtual-entry',
				resolveId(id) { return id === 'virtual:entry' ? id : null; },
				load(id) { return id === 'virtual:entry' ? 'export const value = 1;' : null; }
			},
			observer
		]
	});
}

describe('programmatic Rollup build lifecycle', () => {
	it('runs closeBundle after a successful write', async () => {
		const events = [];
		let releaseClose;
		let announceClose;
		const closeGate = new Promise((resolve) => { releaseClose = resolve; });
		const closeStarted = new Promise((resolve) => { announceClose = resolve; });
		const bundle = await buildWith({
			name: 'lifecycle-observer',
			writeBundle() { events.push('write'); },
			async closeBundle() {
				events.push('close-start');
				announceClose();
				await closeGate;
				events.push('close-end');
			}
		});

		let settled = false;
		const lifecycle = writeAndCloseRollupBundle(bundle, {
			dir: outputDir(), format: 'esm'
		}).then(() => { settled = true; });
		await closeStarted;
		expect(events).toEqual(['write', 'close-start']);
		expect(settled).toBe(false);
		releaseClose();
		await lifecycle;

		expect(events).toEqual(['write', 'close-start', 'close-end']);
	});

	it('runs closeBundle after write fails and preserves the write error', async () => {
		const events = [];
		const writeFailure = new Error('synthetic write failure');
		const bundle = await buildWith({
			name: 'failing-lifecycle-observer',
			writeBundle() {
				events.push('write');
				throw writeFailure;
			},
			closeBundle() { events.push('close'); }
		});

		await expect(writeAndCloseRollupBundle(bundle, {
			dir: outputDir(),
			format: 'esm'
		})).rejects.toBe(writeFailure);
		expect(events).toEqual(['write', 'close']);
	});
});
