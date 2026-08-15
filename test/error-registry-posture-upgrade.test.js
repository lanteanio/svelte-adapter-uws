// ADAPTER-ERR-POSTURE-EXPORT-DISABLED and ADAPTER-ERR-UPGRADE-DEFERRED,
// driven from the conditions they claim.
//
// The posture-export entry names what actually reaches its line: a stale
// socket file is removed automatically before every listen, so the listen
// shape means a permission problem, a missing parent directory, or a taken
// Windows pipe - and the absorbed stale-file case must come up with no line
// at all. The upgrade entry's next action says the printed error cannot be
// the upgrade hook, because the hook resolved before the completion was
// deferred; the case drives a deferred completion that throws and holds the
// line to one emission with the queue draining on.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostureExport } from '../src/runtime/utils/posture-export.js';
import { createUpgradeAdmission } from '../src/runtime/utils/upgrade-admission.js';

afterEach(() => {
	vi.restoreAllMocks();
});

const isWindows = process.platform === 'win32';
const describeUnix = isWindows ? describe.skip : describe;
const describeWin = isWindows ? describe : describe.skip;

function flushTicks(n = 3) {
	let p = Promise.resolve();
	for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
	return p;
}

describe('ADAPTER-ERR-POSTURE-EXPORT-DISABLED', () => {
	it('a missing parent directory reaches the line, and broadcast stays silent', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const dir = mkdtempSync(join(tmpdir(), 'posture-'));
		const gone = join(dir, 'not-there', 'posture.sock');
		const exporter = startPostureExport(gone, () => ({ v: 1, posture: 'normal' }));
		await flushTicks();
		try {
			const lines = warn.mock.calls.map((c) => String(c[0]));
			expect(lines.some((l) => l.includes('[ADAPTER-ERR-POSTURE-EXPORT-DISABLED]') && l.includes('listen on')),
				`expected the indexed listen line, got: ${lines.join(' | ')}`).toBe(true);
			// Disabled means inert, not broken: the sampler keeps calling this.
			expect(() => exporter.broadcast()).not.toThrow();
			expect(exporter.clientCount()).toBe(0);
		} finally {
			exporter.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describeUnix('ADAPTER-ERR-POSTURE-EXPORT-DISABLED: the absorbed stale file', () => {
	it('a stale socket file is repaired silently and the export comes up', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const dir = mkdtempSync(join(tmpdir(), 'posture-stale-'));
		const stale = join(dir, 'posture.sock');
		// A dead process's leftover: a plain file at the socket path.
		closeSync(openSync(stale, 'w'));
		const exporter = startPostureExport(stale, () => ({ v: 1, posture: 'normal' }));
		await flushTicks();
		try {
			const indexed = warn.mock.calls.map((c) => String(c[0]))
				.filter((l) => l.includes('[ADAPTER-ERR-POSTURE-EXPORT-DISABLED]'));
			expect(indexed, 'the documented typical repair must not print the failure line').toEqual([]);
		} finally {
			exporter.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describeWin('ADAPTER-ERR-POSTURE-EXPORT-DISABLED: a taken pipe', () => {
	it('a named pipe already in use reaches the line', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const pipe = '\\\\.\\pipe\\svelte-adapter-uws-posture-claims-' + process.pid;
		const holder = createServer(() => {});
		await new Promise((resolve, reject) => {
			holder.listen(pipe, resolve);
			holder.on('error', reject);
		});
		const exporter = startPostureExport(pipe, () => ({ v: 1, posture: 'normal' }));
		await flushTicks();
		try {
			const lines = warn.mock.calls.map((c) => String(c[0]));
			// The entry routes the repair by the shape on the line: a taken pipe
			// is a LISTEN failure, and must say so.
			expect(lines.some((l) => l.includes('[ADAPTER-ERR-POSTURE-EXPORT-DISABLED]') && l.includes('listen on')),
				`expected the indexed listen line, got: ${lines.join(' | ')}`).toBe(true);
		} finally {
			exporter.close();
			await new Promise((resolve) => holder.close(resolve));
		}
	});
});

describe('ADAPTER-ERR-UPGRADE-DEFERRED', () => {
	it('a deferred completion that throws prints once and the queue drains on', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const admission = createUpgradeAdmission({ maxConcurrent: 8, perTickBudget: 1 });
		const ran = [];
		// First admit consumes this tick's budget; the next two defer.
		expect(admission.admit(() => ran.push('first'))).toBe(true);
		expect(admission.admit(() => { throw new Error('completion refused'); })).toBe(false);
		expect(admission.admit(() => ran.push('after'))).toBe(false);
		await flushTicks();
		const indexed = error.mock.calls.map((c) => String(c[0]))
			.filter((l) => l.includes('[ADAPTER-ERR-UPGRADE-DEFERRED]'));
		expect(indexed, 'exactly one indexed line for the one throwing completion').toHaveLength(1);
		// The other upgrades in the same drain still ran - the throw cost only
		// its own client.
		expect(ran).toEqual(['first', 'after']);
	});
});
