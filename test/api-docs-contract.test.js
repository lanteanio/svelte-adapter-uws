import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { extractApiDocs, readmeEnd, readmeStart, renderReadme } from '../scripts/generate-api-docs.js';
import { hasUWS } from './helpers/real-runtime.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8')
	.replace(/\r\n/g, '\n');
const SOURCE = read('src/index.d.ts');
const README = read('README.md');
const RUNTIME = read('src/runtime/handler/platform.js');
const PRIMARY = read('src/runtime/index.js');
const PACKAGE = JSON.parse(read('package.json'));
const ID = 'platform.publishBatched';

describe('declaration-owned API documentation', () => {
	it('renders the README block byte-for-byte from the public declaration', () => {
		const docs = extractApiDocs(SOURCE);
		expect([...docs.keys()]).toEqual([ID]);
		expect(renderReadme(README, docs)).toBe(README);
		expect(README.split(readmeStart(ID))).toHaveLength(2);
		expect(README.split(readmeEnd(ID))).toHaveLength(2);
	});

	it('makes a declaration edit authoritative and repairs a hand-edited README copy', () => {
		const sourceMutant = SOURCE.replace('mirrors the origin\'s own path', 'follows the origin\'s own path');
		const fromMutant = renderReadme(README, extractApiDocs(sourceMutant));
		expect(fromMutant).not.toBe(README);
		expect(fromMutant).toContain('follows the origin\'s own path');

		const readmeMutant = README.replace('mirrors the origin\'s own path', 'ignores the origin\'s own path');
		expect(renderReadme(readmeMutant, extractApiDocs(SOURCE))).toBe(README);
	});

	it('fails closed on incomplete, nested, missing, or duplicate ownership markers', () => {
		const noSourceEnd = SOURCE.replace(' * <!-- API_DOC:' + ID + ':END -->', '');
		expect(() => extractApiDocs(noSourceEnd)).toThrow(/has no end marker|outside its JSDoc block/);

		const nested = SOURCE.replace(
			' * <!-- API_DOC:' + ID + ':START -->',
			' * <!-- API_DOC:' + ID + ':START -->\n * <!-- API_DOC:other:START -->'
		);
		expect(() => extractApiDocs(nested)).toThrow('starts inside');

		const missingReadmeEnd = README.replace(readmeEnd(ID), '');
		expect(() => renderReadme(missingReadmeEnd, extractApiDocs(SOURCE))).toThrow('missing or reversed');
		const duplicateReadmeStart = README.replace(readmeStart(ID), readmeStart(ID) + '\n' + readmeStart(ID));
		expect(() => renderReadme(duplicateReadmeStart, extractApiDocs(SOURCE))).toThrow('duplicated');
	});

	it('pins the high-risk batching facts in the one editable source', () => {
		const canonical = extractApiDocs(SOURCE).get(ID);
		const canonicalWords = canonical.replace(/\s+/g, ' ');
		const readmeWords = README.replace(/\s+/g, ' ');
		for (const fact of [
			'mirrors the origin\'s own path selection',
			'one `publish-batched` IPC frame',
			'every receiving worker reruns capability and subscriber-slice detection',
			'each surviving event relays individually',
			'only the latest survives at its latest occurrence',
			'the entire surviving batch is validated before any counter or delivery',
			'`platform.batch(messages)`',
			'Compression defaults to false'
		]) {
			expect(canonicalWords, fact).toContain(fact);
			expect(readmeWords, fact).toContain(fact);
		}
		expect(RUNTIME).not.toMatch(/events are relayed individually|no coalesce filtering/i);
		expect(RUNTIME).toContain('The editable public contract lives on');
	});

	it('keeps generation blocking in the ordinary and publication gates', () => {
		const stages = PACKAGE.scripts.check.split(' && ');
		expect(stages[0]).toBe('node scripts/check-compatibility.js');
		expect(stages.filter((stage) => stage === 'node scripts/generate-api-docs.js --check')).toHaveLength(1);
		expect(PACKAGE.scripts.pretest).toBe('npm run check');
		expect(PACKAGE.scripts.prepublishOnly).toContain('npm run check');
	});

	it('keeps the production primary forwarding the whole publish-batched message', () => {
		const start = PRIMARY.indexOf("} else if (msg.type === 'publish-batched')");
		const end = PRIMARY.indexOf("} else if (msg.type === 'state-hash')", start);
		const branch = PRIMARY.slice(start, end);
		expect(branch).toContain('w.postMessage(msg)');
		expect(branch).not.toContain("type: 'publish'");
		expect(PRIMARY).toContain('relayPublishBatched(msg.events, msg.compress)');
	});
});

const describeUWS = hasUWS ? describe : describe.skip;
let origin;
let receiver;
let client;

async function until(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for runtime parity evidence');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describeUWS('publishBatched documentation/runtime parity', () => {
	afterEach(async () => {
		try { client?.close(); } catch {}
		await origin?.close();
		await receiver?.close();
		origin = null;
		receiver = null;
		client = null;
	});

	it('relays one coalesced list and the receiving worker emits one local batch frame', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { WebSocket } = await import('ws');
		const received = [];
		receiver = await createTestServer();
		client = new WebSocket(receiver.wsUrl);
		client.on('message', (data) => {
			try { received.push(JSON.parse(data.toString())); } catch {}
		});
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		client.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		await until(() => received.some((frame) => frame.type === 'subscribed'));

		const relayed = [];
		origin = await createTestServer({
			__onPublish(frame) {
				relayed.push(frame);
				receiver.platform.__relayReceive(frame);
			}
		});
		const before = received.length;
		origin.platform.publishBatched([
			{ topic: 'room', event: 'move', data: 'old', coalesceKey: 'cursor:1', options: { seq: false } },
			{ topic: 'room', event: 'local', data: 'origin-only', options: { relay: false, seq: false } },
			{ topic: 'room', event: 'move', data: 'new', coalesceKey: 'cursor:1', options: { seq: false } },
			{ topic: 'room', event: 'tail', data: 'tail', options: { seq: false } }
		]);
		await until(() => received.length > before);

		expect(relayed).toHaveLength(1);
		expect(relayed[0]).toMatchObject({ kind: 'publishBatched', compress: false });
		expect(relayed[0].events).toHaveLength(2);
		const frames = received.slice(before);
		expect(frames).toHaveLength(1);
		expect(frames[0].type).toBe('batch');
		expect(frames[0].events.map((event) => [event.event, event.data])).toEqual([
			['move', 'new'],
			['tail', 'tail']
		]);
	});

	it('relays each event individually when the origin itself falls back', async () => {
		// The contract's other half: a subscriber without the `batch`
		// capability puts the ORIGIN on the fallback path, so the relay
		// carries N individual messages and peers deliver individual event
		// envelopes. This is the branch the documentation once claimed did
		// not exist.
		const { createTestServer } = await import('../src/testing.js');
		const { WebSocket } = await import('ws');
		const received = [];
		receiver = await createTestServer();
		client = new WebSocket(receiver.wsUrl);
		client.on('message', (data) => {
			try { received.push(JSON.parse(data.toString())); } catch {}
		});
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		// No `batch` capability advertised: everyoneCapable is false on any
		// worker holding this subscriber.
		client.send(JSON.stringify({ type: 'hello', caps: [] }));
		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		await until(() => received.some((frame) => frame.type === 'subscribed'));

		const relayed = [];
		origin = await createTestServer({
			__onPublish(frame) {
				relayed.push(frame);
				receiver.platform.__relayReceive(frame);
			}
		});
		// The origin worker itself holds a non-capable subscriber, so ITS
		// path selection - the thing the relay mirrors - is the fallback.
		const originClient = new WebSocket(origin.wsUrl);
		await new Promise((resolve, reject) => {
			originClient.on('open', resolve);
			originClient.on('error', reject);
		});
		originClient.send(JSON.stringify({ type: 'hello', caps: [] }));
		originClient.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		const originFrames = [];
		originClient.on('message', (data) => {
			try { originFrames.push(JSON.parse(data.toString())); } catch {}
		});
		await until(() => originFrames.some((frame) => frame.type === 'subscribed'));

		const before = received.length;
		origin.platform.publishBatched([
			{ topic: 'room', event: 'first', data: 1, options: { seq: false } },
			{ topic: 'room', event: 'second', data: 2, options: { seq: false } }
		]);
		await until(() => received.filter((frame) => frame.topic === 'room').length >= 2);

		expect(relayed.length).toBeGreaterThanOrEqual(2);
		for (const frame of relayed) expect(frame.kind).toBe('publish');
		const delivered = received.slice(before).filter((frame) => frame.topic === 'room');
		expect(delivered.map((frame) => frame.event)).toEqual(['first', 'second']);
		expect(delivered.every((frame) => frame.type !== 'batch')).toBe(true);
		try { originClient.terminate(); } catch { /* closed */ }
	});
});
