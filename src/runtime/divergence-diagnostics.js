import { createHmac } from 'node:crypto';

// The aggregate state hash remains the hot-path detector. This module owns the
// deliberately cold, bounded second stage that runs only after that detector
// proves workers disagree. Topic names never leave the worker: every worker in
// one primary lifetime receives the same random key and reports a keyed,
// process-lifetime identifier instead.

export const DIVERGENCE_TOPIC_LIMIT = 64;
export const DIVERGENCE_DIAGNOSTIC_LIMIT = 8;

/** @param {{ streamId: string }} a @param {{ streamId: string }} b */
function compareStreamRows(a, b) {
	return a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0;
}

/** @param {number} value @param {number} fallback @param {number} max */
function boundedPositiveInteger(value, fallback, max) {
	return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/**
 * A process-lifetime pseudonymous stream identifier. The 128-bit truncation is
 * ample for a bounded diagnostic while keeping the admin record compact. The
 * key is random per primary lifetime, so identifiers cannot be joined across
 * restarts or guessed with an offline topic-name dictionary.
 *
 * @param {string | Uint8Array | Buffer} key
 * @param {string} topic
 */
export function divergenceStreamId(key, topic) {
	return 'h1:' + createHmac('sha256', key)
		.update(String(topic), 'utf8')
		.digest('base64url')
		.slice(0, 22);
}

/**
 * Snapshot a worker's per-topic high-water marks without ever retaining an
 * unbounded array. The lexicographically-smallest keyed ids are kept so every
 * worker selects the same bounded subset when their topic sets mostly overlap.
 *
 * @param {Map<string, number>} seen
 * @param {string | Uint8Array | Buffer} key
 * @param {number} [requestedLimit]
 */
export function summarizeTopicSequences(seen, key, requestedLimit = DIVERGENCE_TOPIC_LIMIT) {
	const limit = boundedPositiveInteger(requestedLimit, DIVERGENCE_TOPIC_LIMIT, DIVERGENCE_TOPIC_LIMIT);
	/** @type {{ streamId: string, sequence: number }[]} */
	const streams = [];
	let totalStreams = 0;
	for (const [topic, sequence] of seen) {
		if (!Number.isSafeInteger(sequence) || sequence < 0) continue;
		totalStreams++;
		const row = { streamId: divergenceStreamId(key, topic), sequence };
		if (streams.length < limit) {
			streams.push(row);
			streams.sort(compareStreamRows);
		} else if (row.streamId < streams[streams.length - 1].streamId) {
			streams[streams.length - 1] = row;
			streams.sort(compareStreamRows);
		}
	}
	return { streams, totalStreams, truncated: totalStreams > streams.length };
}

/** @param {any} value */
function safeReport(value) {
	if (!value || !Number.isInteger(value.threadId) || !value.summary) return null;
	const rows = Array.isArray(value.summary.streams) ? value.summary.streams : [];
	/** @type {Map<string, number>} */
	const streams = new Map();
	for (const row of rows.slice(0, DIVERGENCE_TOPIC_LIMIT)) {
		if (
			typeof row?.streamId === 'string' && /^h1:[A-Za-z0-9_-]{22}$/.test(row.streamId) &&
			Number.isSafeInteger(row.sequence) && row.sequence >= 0
		) streams.set(row.streamId, row.sequence);
	}
	const totalStreams = Number.isSafeInteger(value.summary.totalStreams) && value.summary.totalStreams >= streams.size
		? value.summary.totalStreams
		: streams.size;
	return {
		threadId: value.threadId,
		role: value.role === 'minority' ? 'minority' : 'majority',
		streams,
		totalStreams,
		truncated: value.summary.truncated === true || totalStreams > streams.size
	};
}

/**
 * Turn worker snapshots into one bounded operator record. A differing numeric
 * high-water mark identifies a tail sequence gap and gives a lower bound. A
 * missing keyed stream is classified separately; incomplete/truncated evidence
 * stays explicit instead of being over-claimed as frame loss.
 *
 * @param {{ diagnosticId: string, epoch: number, observedAt: number, expectedThreadIds: number[], minorityThreadIds: number[], reports: any[] }} input
 */
export function buildDivergenceDiagnostic(input) {
	const expected = [...new Set(input.expectedThreadIds.filter(Number.isInteger))].sort((a, b) => a - b);
	const minority = new Set(input.minorityThreadIds.filter(Number.isInteger));
	const byThread = new Map();
	for (const raw of input.reports) {
		const report = safeReport(raw);
		if (report && expected.includes(report.threadId)) {
			report.role = minority.has(report.threadId) ? 'minority' : 'majority';
			byThread.set(report.threadId, report);
		}
	}
	const reports = [...byThread.values()].sort((a, b) => a.threadId - b.threadId);
	const streamIds = new Set();
	for (const report of reports) for (const id of report.streams.keys()) streamIds.add(id);

	/** @type {any[]} */
	const affectedStreams = [];
	let affectedTruncated = false;
	for (const streamId of [...streamIds].sort()) {
		const samples = reports.map((report) => ({
			threadId: report.threadId,
			role: report.role,
			sequence: report.streams.has(streamId) ? report.streams.get(streamId) : null
		}));
		const present = samples.filter((sample) => sample.sequence !== null);
		const values = [...new Set(present.map((sample) => sample.sequence))];
		const missing = present.length !== reports.length;
		if (!missing && values.length <= 1) continue;
		if (affectedStreams.length >= DIVERGENCE_TOPIC_LIMIT) {
			affectedTruncated = true;
			continue;
		}
		let classification = 'stream-presence-mismatch';
		let gapLowerBound = null;
		if (!missing && values.length > 1) {
			classification = 'tail-sequence-gap';
			gapLowerBound = Math.max(...values) - Math.min(...values);
		}
		affectedStreams.push({ streamId, classification, gapLowerBound, workers: samples });
	}

	const complete = reports.length === expected.length;
	const evidenceTruncated = affectedTruncated || reports.some((report) => report.truncated);
	return {
		diagnosticId: input.diagnosticId,
		kind: 'state-divergence',
		epoch: input.epoch,
		observedAt: input.observedAt,
		complete,
		evidenceTruncated,
		explainedBySequenceSummary: complete && !evidenceTruncated && affectedStreams.length > 0,
		expectedWorkers: expected.length,
		reportingWorkers: reports.length,
		workers: reports.map((report) => ({
			threadId: report.threadId,
			role: report.role,
			totalStreams: report.totalStreams,
			sampledStreams: report.streams.size,
			truncated: report.truncated
		})),
		affectedStreams
	};
}

/** @param {any} value */
function clone(value) {
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** A bounded worker-local replica of primary-completed diagnostic records. */
export function createDivergenceDiagnosticStore(limit = DIVERGENCE_DIAGNOSTIC_LIMIT) {
	const cap = boundedPositiveInteger(limit, DIVERGENCE_DIAGNOSTIC_LIMIT, DIVERGENCE_DIAGNOSTIC_LIMIT);
	/** @type {Map<string, any>} */
	const records = new Map();
	return {
		set(record) {
			if (!record || typeof record.diagnosticId !== 'string' || record.diagnosticId.length > 128) return false;
			records.delete(record.diagnosticId);
			records.set(record.diagnosticId, clone(record));
			while (records.size > cap) records.delete(records.keys().next().value);
			return true;
		},
		get(id) {
			if (typeof id !== 'string' || id.length > 128) return null;
			return clone(records.get(id) ?? null);
		},
		list() {
			return [...records.values()].reverse().map((record) => ({
				diagnosticId: record.diagnosticId,
				kind: record.kind,
				observedAt: record.observedAt,
				complete: record.complete,
				affectedStreamCount: Array.isArray(record.affectedStreams) ? record.affectedStreams.length : 0,
				evidenceTruncated: record.evidenceTruncated === true
			}));
		},
		get size() { return records.size; }
	};
}
