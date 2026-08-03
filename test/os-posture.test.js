// Kernel pressure sources (PSI + cgroup CPU quota), the posture push-export
// socket, and the systemd readiness/watchdog integration. Pure-unit style:
// nothing here imports uWebSockets.js - parsers get fixture strings, the
// sampler an injected read function, sd-notify an injected env/exec, and the
// export server a per-platform local socket path.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePsi, parseCpuStat, probeOsPressureSources, createOsPressureSampler, emitPressureMetricTelemetry } from '../src/runtime/utils/os-pressure.js';
import { computePressureReason } from '../src/runtime/utils/pressure.js';
import { samplePressureValue } from '../src/runtime/wire.js';
import { startPostureExport } from '../src/runtime/utils/posture-export.js';
import { createSdNotify } from '../src/runtime/utils/sd-notify.js';

const PSI_CPU = 'some avg10=12.34 avg60=8.00 avg300=2.00 total=123456\n';
const PSI_MEM = 'some avg10=1.50 avg60=0.80 avg300=0.10 total=999\nfull avg10=0.75 avg60=0.30 avg300=0.05 total=555\n';
const PSI_IO = 'some avg10=40.00 avg60=20.00 avg300=5.00 total=1\nfull avg10=22.50 avg60=10.00 avg300=1.00 total=1\n';
const CPU_STAT_V2 = 'usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\nnr_periods 100\nnr_throttled 4\nthrottled_usec 250000\n';
const CPU_STAT_V1 = 'nr_periods 100\nnr_throttled 4\nthrottled_time 250000000\n';

describe('os-pressure parsers', () => {
	it('parses PSI some/full avg10 lines and tolerates a missing full line', () => {
		expect(parsePsi(PSI_CPU)).toEqual({ some10: 12.34, full10: 0 });
		expect(parsePsi(PSI_MEM)).toEqual({ some10: 1.5, full10: 0.75 });
		expect(parsePsi('')).toEqual({ some10: 0, full10: 0 });
		expect(parsePsi('garbage\n')).toEqual({ some10: 0, full10: 0 });
	});

	it('parses cgroup v2 cpu.stat and normalizes v1 throttled_time (ns) to usec', () => {
		expect(parseCpuStat(CPU_STAT_V2)).toEqual({ nrThrottled: 4, throttledUsec: 250000 });
		expect(parseCpuStat(CPU_STAT_V1)).toEqual({ nrThrottled: 4, throttledUsec: 250000 });
		expect(parseCpuStat('usage_usec 5\n')).toBe(null);
	});
});

describe('os-pressure sampler', () => {
	function files(map) {
		return { readFile: (path) => { if (path in map) return map[path]; throw new Error('ENOENT ' + path); } };
	}

	it('reads PSI and reports throttle deltas over the window', () => {
		let throttledUsec = 250000;
		const sampler = createOsPressureSampler({
			readFile: (path) => {
				if (path === '/proc/pressure/cpu') return PSI_CPU;
				if (path === '/proc/pressure/memory') return PSI_MEM;
				if (path === '/proc/pressure/io') return PSI_IO;
				if (path === '/sys/fs/cgroup/cpu.stat') return `nr_throttled 4\nthrottled_usec ${throttledUsec}\n`;
				throw new Error('ENOENT');
			}
		});
		const first = sampler.sample(1000);
		expect(first.psi).toEqual({ cpuSome10: 12.34, memoryFull10: 0.75, ioFull10: 22.5 });
		expect(first.cpuThrottle).toEqual({ throttledRatio: 0, nrThrottledDelta: 0 }); // baseline sample

		throttledUsec += 500000; // half the next 1s window spent throttled
		const second = sampler.sample(1000);
		expect(second.cpuThrottle.throttledRatio).toBeCloseTo(0.5, 5);
	});

	it('disables a source permanently after a failed startup probe (zero-cost off-Linux)', () => {
		let reads = 0;
		const sampler = createOsPressureSampler({ readFile: () => { reads++; throw new Error('ENOENT'); } });
		expect(sampler.sample(1000)).toEqual({ psi: null, cpuThrottle: null });
		const after = reads;
		sampler.sample(1000);
		sampler.sample(1000);
		expect(reads).toBe(after); // no further reads once both probes failed
	});

	it('recovers when a successful startup probe is followed by one transient first-sample failure', () => {
		const sourceFiles = {
			'/proc/pressure/cpu': PSI_CPU,
			'/proc/pressure/memory': PSI_MEM,
			'/proc/pressure/io': PSI_IO,
			'/sys/fs/cgroup/cpu.stat': CPU_STAT_V2
		};
		const sources = probeOsPressureSources(files(sourceFiles));
		expect(sources).toEqual({ psi: true, cpuThrottle: true });

		let fail = true;
		let reads = 0;
		const sampler = createOsPressureSampler({
			sources,
			readFile: (path) => {
				reads++;
				if (fail) throw new Error('transient EIO');
				if (path in sourceFiles) return sourceFiles[path];
				throw new Error('ENOENT ' + path);
			}
		});
		expect(sampler.sample(1000)).toEqual({ psi: null, cpuThrottle: null });
		const afterFailure = reads;

		fail = false;
		expect(sampler.sample(1000)).toEqual({
			psi: { cpuSome10: 12.34, memoryFull10: 0.75, ioFull10: 22.5 },
			cpuThrottle: { throttledRatio: 0, nrThrottledDelta: 0 }
		});
		expect(reads).toBeGreaterThan(afterFailure);
	});

	it('keeps a transient registration probe unknown and recovers on the sampler tick', () => {
		const sourceFiles = {
			'/proc/pressure/cpu': PSI_CPU,
			'/proc/pressure/memory': PSI_MEM,
			'/proc/pressure/io': PSI_IO,
			'/sys/fs/cgroup/cpu.stat': CPU_STAT_V2
		};
		let fail = true;
		const readFile = (path) => {
			if (fail) {
				const error = new Error('transient EIO');
				error.code = 'EIO';
				throw error;
			}
			if (path in sourceFiles) return sourceFiles[path];
			const error = new Error('ENOENT ' + path);
			error.code = 'ENOENT';
			throw error;
		};
		const sources = probeOsPressureSources({ readFile });
		expect(sources).toEqual({ psi: null, cpuThrottle: null });

		fail = false;
		const sampler = createOsPressureSampler({ sources, readFile });
		expect(sampler.sample(1000)).toEqual({
			psi: { cpuSome10: 12.34, memoryFull10: 0.75, ioFull10: 22.5 },
			cpuThrottle: { throttledRatio: 0, nrThrottledDelta: 0 }
		});
	});

	it('retries a transient lazy first tick when metrics did not run a startup probe', () => {
		let fail = true;
		let reads = 0;
		const sampler = createOsPressureSampler({
			readFile: (path) => {
				reads++;
				if (fail) {
					const error = new Error('transient EIO');
					error.code = 'EIO';
					throw error;
				}
				if (path === '/proc/pressure/cpu') return PSI_CPU;
				if (path === '/proc/pressure/memory') return PSI_MEM;
				if (path === '/proc/pressure/io') return PSI_IO;
				if (path === '/sys/fs/cgroup/cpu.stat') return CPU_STAT_V2;
				const error = new Error('ENOENT ' + path);
				error.code = 'ENOENT';
				throw error;
			}
		});
		expect(sampler.sample(1000)).toEqual({ psi: null, cpuThrottle: null });
		const afterFailure = reads;

		fail = false;
		expect(sampler.sample(1000)).toEqual({
			psi: { cpuSome10: 12.34, memoryFull10: 0.75, ioFull10: 22.5 },
			cpuThrottle: { throttledRatio: 0, nrThrottledDelta: 0 }
		});
		expect(reads).toBeGreaterThan(afterFailure);
	});

	it('performs zero reads for sources whose startup probe confirmed absence', () => {
		let probeReads = 0;
		const sources = probeOsPressureSources({
			readFile: () => { probeReads++; throw new Error('ENOENT'); }
		});
		expect(sources).toEqual({ psi: false, cpuThrottle: false });
		expect(probeReads).toBeGreaterThan(0);

		let sampleReads = 0;
		const sampler = createOsPressureSampler({
			sources,
			readFile: () => { sampleReads++; throw new Error('must not read'); }
		});
		expect(sampler.sample(1000)).toEqual({ psi: null, cpuThrottle: null });
		expect(sampler.sample(1000)).toEqual({ psi: null, cpuThrottle: null });
		expect(sampleReads).toBe(0);
	});

	it('probes the v1 cgroup layouts when v2 is absent', () => {
		const sampler = createOsPressureSampler(files({
			'/sys/fs/cgroup/cpu,cpuacct/cpu.stat': CPU_STAT_V1
		}));
		const s = sampler.sample(1000);
		expect(s.psi).toBe(null);
		expect(s.cpuThrottle).toEqual({ throttledRatio: 0, nrThrottledDelta: 0 });
	});

	it('exports an incident timeline and clears optional readings on a transient source failure', () => {
		let phase = 'normal';
		let failed = false;
		let throttledUsec = 250000;
		const sampler = createOsPressureSampler({
			readFile: (path) => {
				if (failed) throw new Error('transient EIO');
				if (path === '/proc/pressure/cpu') {
					return phase === 'incident'
						? 'some avg10=90.00 avg60=0 avg300=0 total=1\n'
						: 'some avg10=1.00 avg60=0 avg300=0 total=1\n';
				}
				if (path === '/proc/pressure/memory' || path === '/proc/pressure/io') {
					return 'some avg10=0 avg60=0 avg300=0 total=1\nfull avg10=0 avg60=0 avg300=0 total=1\n';
				}
				if (path === '/sys/fs/cgroup/cpu.stat') {
					return `nr_throttled 4\nthrottled_usec ${throttledUsec}\n`;
				}
				throw new Error('ENOENT');
			}
		});

		const transitions = [];
		const psiCpu = [];
		const cpuThrottle = [];
		const instruments = {
			reasonTransitions: { inc: (labels) => transitions.push(labels) },
			psiCpuSome: { set: (v) => psiCpu.push(v) },
			psiMemoryFull: { set() {} },
			psiIoFull: { set() {} },
			cpuThrottled: { set: (v) => cpuThrottle.push(v) }
		};
		const thresholds = {
			memoryHeapUsedRatio: 0.85,
			publishRatePerSec: 10000,
			subscriberRatio: 50,
			psiCpuSome: 60,
			psiMemoryFull: 15,
			psiIoFull: 50,
			cpuThrottledRatio: 0.25
		};
		let previous = 'NONE';
		const sample = () => {
			const os = sampler.sample(1000);
			const readings = { heapUsedRatio: 0, publishRate: 0, subscriberRatio: 0 };
			if (os.psi !== null) {
				readings.psiCpuSome10 = os.psi.cpuSome10;
				readings.psiMemoryFull10 = os.psi.memoryFull10;
				readings.psiIoFull10 = os.psi.ioFull10;
			}
			if (os.cpuThrottle !== null) readings.cpuThrottledRatio = os.cpuThrottle.throttledRatio;
			const reason = computePressureReason(readings, thresholds);
			emitPressureMetricTelemetry({
				transition: reason === previous ? null : { from: previous, to: reason },
				os
			}, instruments);
			previous = reason;
			return os;
		};

		expect(sample().psi.cpuSome10).toBe(1); // normal + CPU baseline
		phase = 'incident';
		throttledUsec += 500000;
		expect(sample().cpuThrottle.throttledRatio).toBe(0.5);
		phase = 'recovery';
		expect(sample().psi.cpuSome10).toBe(1);
		failed = true;
		expect(sample()).toEqual({ psi: null, cpuThrottle: null });

		expect(transitions).toEqual([
			{ from: 'NONE', to: 'CPU_QUOTA' },
			{ from: 'CPU_QUOTA', to: 'NONE' }
		]);
		expect(Number.isNaN(psiCpu.at(-1))).toBe(true);
		expect(Number.isNaN(cpuThrottle.at(-1))).toBe(true);

		// The source remains armed after the transient failure, and cgroup delta
		// recovery establishes a new baseline rather than fabricating a multi-window
		// throttle spike divided by this one-second interval.
		failed = false;
		throttledUsec += 500000;
		expect(sample().cpuThrottle).toEqual({ throttledRatio: 0, nrThrottledDelta: 0 });
	});
});

describe('pressure reason + saturation with kernel signals', () => {
	const T = {
		memoryHeapUsedRatio: 0.85, publishRatePerSec: 10000, subscriberRatio: 50,
		psiCpuSome: 60, psiMemoryFull: 15, psiIoFull: 50, cpuThrottledRatio: 0.25
	};

	it('fires PSI on any stalled axis and CPU_QUOTA above throttle ratio, with fixed precedence', () => {
		const base = { heapUsedRatio: 0.1, publishRate: 0, subscriberRatio: 0 };
		expect(computePressureReason({ ...base, psiCpuSome10: 75 }, T)).toBe('PSI');
		expect(computePressureReason({ ...base, psiMemoryFull10: 20 }, T)).toBe('PSI');
		expect(computePressureReason({ ...base, psiIoFull10: 55 }, T)).toBe('PSI');
		expect(computePressureReason({ ...base, cpuThrottledRatio: 0.3 }, T)).toBe('CPU_QUOTA');
		// CPU_QUOTA outranks PSI; MEMORY outranks both.
		expect(computePressureReason({ ...base, psiCpuSome10: 99, cpuThrottledRatio: 0.9 }, T)).toBe('CPU_QUOTA');
		expect(computePressureReason({ heapUsedRatio: 0.9, publishRate: 0, subscriberRatio: 0, cpuThrottledRatio: 0.9 }, T)).toBe('MEMORY');
	});

	it('never fires on hosts without the source and honors false-disables', () => {
		const base = { heapUsedRatio: 0.1, publishRate: 0, subscriberRatio: 0 };
		expect(computePressureReason(base, T)).toBe('NONE'); // fields absent
		expect(computePressureReason(
			{ ...base, psiCpuSome10: 99, cpuThrottledRatio: 0.9 },
			{ ...T, psiCpuSome: false, cpuThrottledRatio: false }
		)).toBe('NONE');
	});

	it('folds the kernel readings into the 0..1 saturation scalar worst-of', () => {
		const base = { heapUsedRatio: 0, publishRate: 0, subscriberRatio: 0 };
		expect(samplePressureValue({ ...base, psiCpuSome10: 30 }, T, 0)).toBeCloseTo(0.5, 5);
		expect(samplePressureValue({ ...base, cpuThrottledRatio: 0.125 }, T, 0)).toBeCloseTo(0.5, 5);
		expect(samplePressureValue({ ...base, psiIoFull10: 100 }, T, 0)).toBe(1);
		expect(samplePressureValue(base, T, 0)).toBe(0);
	});
});

describe('posture export socket', () => {
	/** @type {ReturnType<typeof startPostureExport> | null} */
	let exporter = null;

	afterEach(() => {
		exporter?.close();
		exporter = null;
	});

	function exportPath() {
		const suffix = process.pid + '-' + Math.random().toString(36).slice(2, 8);
		return process.platform === 'win32'
			? '\\\\.\\pipe\\uws-posture-test-' + suffix
			: join(tmpdir(), 'uws-posture-test-' + suffix + '.sock');
	}

	function readLines(path, count) {
		return new Promise((resolve, reject) => {
			const socket = connect(path);
			let buffer = '';
			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8');
				const lines = buffer.split('\n').filter((l) => l.length > 0);
				if (lines.length >= count) {
					socket.destroy();
					resolve(lines.slice(0, count).map((l) => JSON.parse(l)));
				}
			});
			socket.on('error', reject);
		});
	}

	it('pushes the current line on connect and again on broadcast', async () => {
		let posture = 'normal';
		const p = exportPath();
		exporter = startPostureExport(p, () => ({ v: 1, posture, reason: 'NONE' }));
		// Give listen a beat before connecting.
		await new Promise((r) => setTimeout(r, 50));

		const linesPromise = readLines(p, 2);
		// Wait for the client to attach, then transition and broadcast.
		await vi.waitFor(() => { if (exporter.clientCount() === 0) throw new Error('no client yet'); });
		posture = 'siege';
		exporter.broadcast();
		const lines = await linesPromise;
		expect(lines[0]).toMatchObject({ v: 1, posture: 'normal' });
		expect(lines[1]).toMatchObject({ v: 1, posture: 'siege' });
	});

	it('broadcast with zero clients is a no-op and close cleans up', async () => {
		const p = exportPath();
		let built = 0;
		exporter = startPostureExport(p, () => { built++; return { v: 1 }; });
		await new Promise((r) => setTimeout(r, 50));
		exporter.broadcast();
		expect(built).toBe(0); // nothing serialized without a consumer
		exporter.close();
		exporter = null;
	});
});

describe('sd-notify', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is a complete no-op without NOTIFY_SOCKET', () => {
		const calls = [];
		const sdn = createSdNotify({ env: {}, exec: (cmd, args) => calls.push([cmd, ...args]) });
		expect(sdn.enabled).toBe(false);
		sdn.ready();
		sdn.armWatchdog();
		sdn.stopping();
		expect(calls).toEqual([]);
	});

	it('sends READY/STOPPING and paces WATCHDOG pings at half the timeout', () => {
		vi.useFakeTimers();
		const calls = [];
		const sdn = createSdNotify({
			env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '10000000' }, // 10s timeout
			exec: (cmd, args) => calls.push([cmd, ...args])
		});
		expect(sdn.enabled).toBe(true);
		sdn.ready();
		expect(calls).toEqual([['systemd-notify', '--ready']]);

		sdn.armWatchdog();
		vi.advanceTimersByTime(5000);
		vi.advanceTimersByTime(5000);
		expect(calls.filter((c) => c[1] === 'WATCHDOG=1')).toHaveLength(2);

		sdn.disarmWatchdog();
		vi.advanceTimersByTime(20000);
		expect(calls.filter((c) => c[1] === 'WATCHDOG=1')).toHaveLength(2);

		sdn.stopping();
		expect(calls.at(-1)).toEqual(['systemd-notify', 'STOPPING=1']);
	});

	it('sends READY without a watchdog when WATCHDOG_USEC is absent', () => {
		vi.useFakeTimers();
		const calls = [];
		const sdn = createSdNotify({
			env: { NOTIFY_SOCKET: '/run/systemd/notify' },
			exec: (cmd, args) => calls.push([cmd, ...args])
		});
		sdn.ready();
		sdn.armWatchdog();
		vi.advanceTimersByTime(60000);
		expect(calls).toEqual([['systemd-notify', '--ready']]);
	});
});
