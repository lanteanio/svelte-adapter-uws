// CRDT replica microbench: the absolute costs of the document hot paths the
// authority and channel ride - merge of a single-character update, merge of a
// large offline-flush blob, the missing-structs diff at a populated document
// size, and the full-state compaction encode. These are new-feature absolute
// targets (the CRDT cost itself), not regressions: the gate is that a
// single-edit round trip stays far inside an interactive budget and that the
// compaction encode stays cheap enough for a debounce schedule.
//
// Also asserts the structural invariant the wire relies on: applying the same
// update twice changes nothing (idempotent merge), so replay and fallback
// overlap are free of special cases. Pure JS, no uWS, no real WS.
// Deterministic shape, < 2 s.

import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function captureUpdate(doc, fn) {
	let update = null;
	const grab = (u) => { update = u; };
	doc.on('update', grab);
	doc.transact(fn);
	doc.off('update', grab);
	return update;
}

/** A populated document: `editors` map entries + a text run, like a busy board. */
function makeDoc(editors) {
	const doc = new Y.Doc();
	doc.transact(() => {
		const m = doc.getMap('root');
		for (let i = 0; i < editors; i++) {
			m.set('card-' + i, { title: 'card ' + i, x: i * 7, y: i * 13, owner: 'user-' + (i % 17) });
		}
		doc.getText('notes').insert(0, 'lorem ipsum '.repeat(50));
	});
	return doc;
}

function bench(label, iters, fn) {
	const rounds = 7;
	const times = [];
	for (let r = 0; r < rounds; r++) {
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) fn(i);
		times.push(((performance.now() - t0) / iters) * 1e6); // ns/op
	}
	const ns = median(times);
	console.log(`  ${label}: ${Math.round(ns).toLocaleString()} ns/op`);
	return ns;
}

console.log('crdt apply/diff/compaction microbench (yjs)');

// --- single-character update merge (the steady-state editing path) ---------
{
	const base = makeDoc(100);
	const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(base));
	// Pre-capture a batch of distinct single-char updates from the peer.
	const updates = [];
	for (let i = 0; i < 2000; i++) {
		updates.push(captureUpdate(peer, () => peer.getText('notes').insert(0, 'x')));
	}
	let i = 0;
	const ns = bench('applyUpdate (1-char edit, 100-entry doc)', 2000, () => {
		Y.applyUpdate(base, updates[i++ % updates.length]);
	});
	if (ns > 1e6) {
		console.error('GATE FAIL: single-edit merge above 1ms');
		process.exit(1);
	}
}

// --- idempotent re-apply (the replay/fallback overlap invariant) -----------
{
	const doc = makeDoc(10);
	const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	const u = captureUpdate(peer, () => peer.getMap('root').set('probe', 1));
	Y.applyUpdate(doc, u);
	const before = JSON.stringify(doc.getMap('root').toJSON());
	Y.applyUpdate(doc, u);
	Y.applyUpdate(doc, u);
	if (JSON.stringify(doc.getMap('root').toJSON()) !== before) {
		console.error('INVARIANT FAIL: re-applying an update changed the document');
		process.exit(1);
	}
	bench('applyUpdate (idempotent re-apply)', 5000, () => {
		Y.applyUpdate(doc, u);
	});
}

// --- offline-flush blob: 500 edits merged into one update ------------------
{
	const server = makeDoc(100);
	const offline = new Y.Doc();
	Y.applyUpdate(offline, Y.encodeStateAsUpdate(server));
	const serverSv = Y.encodeStateVector(server);
	offline.transact(() => {
		const m = offline.getMap('root');
		for (let i = 0; i < 500; i++) m.set('offline-' + i, { v: i });
	});
	const blob = Y.encodeStateAsUpdate(offline, serverSv);
	console.log(`  offline-flush blob size (500 edits): ${blob.length.toLocaleString()} bytes`);
	bench('applyUpdate (500-edit flush blob)', 200, () => {
		const target = new Y.Doc();
		Y.applyUpdate(target, Y.encodeStateAsUpdate(server));
		Y.applyUpdate(target, blob);
	});
}

// --- the joiner diff and the compaction encode ------------------------------
{
	const server = makeDoc(100);
	const halfway = new Y.Doc();
	Y.applyUpdate(halfway, Y.encodeStateAsUpdate(server));
	const sv = Y.encodeStateVector(halfway);
	server.transact(() => {
		const m = server.getMap('root');
		for (let i = 0; i < 50; i++) m.set('late-' + i, i);
	});
	bench('encodeStateAsUpdate (joiner diff vs half-stale vector)', 2000, () => {
		Y.encodeStateAsUpdate(server, sv);
	});
	const ns = bench('encodeStateAsUpdate (full compaction, 100-entry doc)', 2000, () => {
		Y.encodeStateAsUpdate(server);
	});
	if (ns > 5e6) {
		console.error('GATE FAIL: compaction encode above 5ms at the 100-entry size');
		process.exit(1);
	}
	bench('encodeStateVector (100-entry doc)', 5000, () => {
		Y.encodeStateVector(server);
	});
}

console.log('OK - all gates passed');
