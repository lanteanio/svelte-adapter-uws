// Smooth command-ingest decision bench.
//
// It compares the complete decode + consumer-read boundary for three shapes:
//   current   generic wire-value objects ({ keys, commandId, aim: { x, y } })
//   accessor  one verified fixed byte record read in place, with no command objects
//   flat-int  [keys, commandId, x100, y100] through the current generic codec
//
// The third arm answers the product question: when record shape and fixed-point
// integers close most of the gap to an app-specific accessor, the app record
// diet owns the win and a second adapter wire/schema is not justified.

import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmoothCommandBatch, decodeSmoothCommandBatch } from '../src/plugins/smooth/codec.js';

const FIXED_HEADER_BYTES = 4;
const FIXED_RECORD_BYTES = 18;
const DEFAULT_COUNTS = [32, 256];
const DEFAULT_ITERATIONS = 1000;
const DEFAULT_SAMPLES = 9;
const MOST_OF_GAP = 0.70;
let blackhole = 0;

function positiveInteger(value, fallback) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Build semantically identical current, flat-int, and fixed-byte payloads. */
export function makeSmoothIngestCorpus(count) {
	const current = new Array(count);
	const flat = new Array(count);
	for (let index = 0; index < count; index++) {
		const id = index + 1;
		const keys = (id * 73) & 0x0fff;
		const x100 = ((id * 7919) % 200001) - 100000;
		const y100 = ((id * 1543) % 200001) - 100000;
		current[index] = { id, cmd: { keys, commandId: id, aim: { x: x100 / 100, y: y100 / 100 } } };
		flat[index] = { id, cmd: [keys, id, x100, y100] };
	}
	const fixed = new Uint8Array(FIXED_HEADER_BYTES + count * FIXED_RECORD_BYTES);
	const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
	view.setUint32(0, count, true);
	let offset = FIXED_HEADER_BYTES;
	for (const entry of flat) {
		view.setUint32(offset, entry.id, true);
		view.setUint16(offset + 4, entry.cmd[0], true);
		view.setUint32(offset + 6, entry.cmd[1], true);
		view.setInt32(offset + 10, entry.cmd[2], true);
		view.setInt32(offset + 14, entry.cmd[3], true);
		offset += FIXED_RECORD_BYTES;
	}
	return {
		count,
		current: encodeSmoothCommandBatch(current),
		flat: encodeSmoothCommandBatch(flat),
		fixed
	};
}

export function consumeCurrentSmoothPayload(payload) {
	const batch = decodeSmoothCommandBatch(payload);
	if (batch === null) throw new Error('current smooth payload did not decode');
	let checksum = 0;
	for (let index = 0; index < batch.length; index++) {
		const entry = batch[index];
		const command = entry.cmd;
		checksum = (checksum + entry.id + command.keys + command.commandId +
			Math.round(command.aim.x * 100) + Math.round(command.aim.y * 100)) >>> 0;
	}
	return checksum;
}

export function consumeFlatIntSmoothPayload(payload) {
	const batch = decodeSmoothCommandBatch(payload);
	if (batch === null) throw new Error('flat-int smooth payload did not decode');
	let checksum = 0;
	for (let index = 0; index < batch.length; index++) {
		const entry = batch[index];
		const command = entry.cmd;
		checksum = (checksum + entry.id + command[0] + command[1] + command[2] + command[3]) >>> 0;
	}
	return checksum;
}

export function consumeFixedSmoothAccessor(payload) {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const count = view.getUint32(0, true);
	if (payload.byteLength !== FIXED_HEADER_BYTES + count * FIXED_RECORD_BYTES) {
		throw new RangeError('fixed smooth payload length mismatch');
	}
	let checksum = 0;
	let offset = FIXED_HEADER_BYTES;
	for (let index = 0; index < count; index++) {
		checksum = (checksum + view.getUint32(offset, true) + view.getUint16(offset + 4, true) +
			view.getUint32(offset + 6, true) + view.getInt32(offset + 10, true) +
			view.getInt32(offset + 14, true)) >>> 0;
		offset += FIXED_RECORD_BYTES;
	}
	return checksum;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

function measure(run, iterations, commands) {
	let checksum = 0;
	const started = performance.now();
	for (let index = 0; index < iterations; index++) checksum = (checksum + run()) >>> 0;
	const elapsed = performance.now() - started;
	blackhole = (blackhole ^ checksum) >>> 0;
	return elapsed * 1e6 / (iterations * commands);
}

export function smoothIngestDecision(currentNs, accessorNs, flatIntNs) {
	const gap = currentNs - accessorNs;
	const closure = gap > 0 ? (currentNs - flatIntNs) / gap : 0;
	return {
		gapClosure: closure,
		decision: closure >= MOST_OF_GAP ? 'record-diet' : 'standalone-accessor'
	};
}

export function runSmoothIngestDecisionBench(options = {}) {
	const counts = options.counts || DEFAULT_COUNTS;
	const iterations = positiveInteger(options.iterations, DEFAULT_ITERATIONS);
	const samples = positiveInteger(options.samples, DEFAULT_SAMPLES);
	const rows = [];
	for (const count of counts) {
		const corpus = makeSmoothIngestCorpus(count);
		const arms = [
			['current', () => consumeCurrentSmoothPayload(corpus.current)],
			['accessor', () => consumeFixedSmoothAccessor(corpus.fixed)],
			['flatInt', () => consumeFlatIntSmoothPayload(corpus.flat)]
		];
		const expected = arms[0][1]();
		for (const [, run] of arms) {
			if (run() !== expected) throw new Error(`smooth ingest checksum mismatch at ${count} commands`);
			measure(run, Math.min(iterations, 100), count);
		}
		const timings = { current: [], accessor: [], flatInt: [] };
		for (let sample = 0; sample < samples; sample++) {
			for (let step = 0; step < arms.length; step++) {
				const [name, run] = arms[(sample + step) % arms.length];
				timings[name].push(measure(run, iterations, count));
			}
		}
		const medians = {
			current: median(timings.current),
			accessor: median(timings.accessor),
			flatInt: median(timings.flatInt)
		};
		rows.push({
			count,
			bytes: { current: corpus.current.byteLength, accessor: corpus.fixed.byteLength, flatInt: corpus.flat.byteLength },
			nsPerCommand: medians,
			...smoothIngestDecision(medians.current, medians.accessor, medians.flatInt)
		});
	}
	return { iterations, samples, threshold: MOST_OF_GAP, rows, blackhole };
}

function print(result) {
	console.log('smooth ingest record decision (median ns/command, lower is better)');
	console.log('commands  current  accessor  flat-int  gap closed  bytes current/accessor/flat');
	for (const row of result.rows) {
		console.log(
			String(row.count).padStart(8),
			row.nsPerCommand.current.toFixed(1).padStart(8),
			row.nsPerCommand.accessor.toFixed(1).padStart(9),
			row.nsPerCommand.flatInt.toFixed(1).padStart(9),
			`${(row.gapClosure * 100).toFixed(1)}%`.padStart(11),
			`${row.bytes.current}/${row.bytes.accessor}/${row.bytes.flatInt}`
		);
	}
	const decision = result.rows[result.rows.length - 1];
	console.log(`decision: ${decision.decision} (flat-int closes ${(decision.gapClosure * 100).toFixed(1)}% of the current-to-accessor gap; threshold ${(result.threshold * 100).toFixed(0)}%)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	print(runSmoothIngestDecisionBench({
		iterations: positiveInteger(process.env.BENCH_ITERATIONS, DEFAULT_ITERATIONS),
		samples: positiveInteger(process.env.BENCH_SAMPLES, DEFAULT_SAMPLES)
	}));
}
