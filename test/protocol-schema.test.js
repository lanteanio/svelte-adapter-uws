import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The shared gate, not a local try/import: the published spec says these
// artifacts are validated in CI against the reference implementation, and a
// skipped suite reports PASSED with zero assertions. Taking the helper's flag
// is what makes REQUIRE_UWS / CI turn a missing addon into a failure here too.
import { hasUWS } from './helpers/real-runtime.js';

const root = JSON.parse(readFileSync(new URL('../protocol.schema.json', import.meta.url), 'utf8'));
// Line endings are a checkout property, not a contract property: git may hand
// a Windows working tree CRLF for the same committed bytes, and a multi-line
// prose pin joined with \n would then never match. Normalize on read so the
// assertion tests the wording it claims to test.
const protocol = readFileSync(new URL('../PROTOCOL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const expectedJsTransportDecision = [
	'**Reference-runtime transport decision (`js-transport-v1`):**',
	'WebSocket/WSS remains the permanent default and complete transport for the',
	'JavaScript adapter. No post-0.6 WebTransport client lane is scheduled for this',
	'package: a negotiate-WebTransport/fall-back-to-WebSocket ladder remains parked',
	'with no release target. Reopening it requires independent OSS demand, an',
	'available QUIC-terminating server surface, and conformance against sections 14',
	'and 15. A native runtime may implement those frozen bindings independently;',
	'that does not create a JavaScript server or client deliverable.'
].join('\n');
const vectors = JSON.parse(readFileSync(new URL('../test-vectors/frames.json', import.meta.url), 'utf8'));
const binaryVector = JSON.parse(readFileSync(new URL('../test-vectors/binary.json', import.meta.url), 'utf8'));
const streamVector = JSON.parse(readFileSync(new URL('../test-vectors/webtransport-stream.json', import.meta.url), 'utf8'));

// A minimal JSON Schema validator covering exactly the subset protocol.schema.json
// uses: $ref (local), type (string or array), const, enum, minimum, exclusiveMinimum, required, properties,
// items, oneOf, and the empty schema {} (matches anything). Kept dependency-free
// so the schema is enforced in CI without pulling a validator into the tree; a
// third party validates the same schema with any standard tool.
function resolveRef(ref) {
	if (!ref.startsWith('#/')) throw new Error('only local refs supported: ' + ref);
	let node = root;
	for (const seg of ref.slice(2).split('/')) node = node[seg];
	return node;
}

function typeOf(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	if (Number.isInteger(v)) return 'integer';
	return typeof v; // string | number | boolean | object
}

function matchesType(want, v) {
	const t = typeOf(v);
	const list = Array.isArray(want) ? want : [want];
	return list.some((w) => {
		if (w === 'number') return t === 'number' || t === 'integer';
		if (w === 'integer') return t === 'integer';
		return t === w;
	});
}

function validate(schema, value, path = '$') {
	if (schema.$ref) return validate(resolveRef(schema.$ref), value, path);
	const errors = [];
	// Empty schema {} matches anything.
	if (schema.type && !matchesType(schema.type, value)) {
		errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${typeOf(value)}`);
		return errors; // no point checking further shape
	}
	if ('const' in schema && value !== schema.const) {
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
	}
	if ('minimum' in schema && typeof value === 'number' && value < schema.minimum) {
		errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
	}
	if ('exclusiveMinimum' in schema && typeof value === 'number' && value <= schema.exclusiveMinimum) {
		errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
	}
	if (schema.required) {
		for (const key of schema.required) {
			if (value == null || typeof value !== 'object' || !(key in value)) {
				errors.push(`${path}: missing required "${key}"`);
			}
		}
	}
	if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
		}
	}
	if (schema.items && Array.isArray(value)) {
		value.forEach((el, i) => errors.push(...validate(schema.items, el, `${path}[${i}]`)));
	}
	if (schema.oneOf) {
		const matches = schema.oneOf.filter((sub) => validate(sub, value, path).length === 0);
		if (matches.length !== 1) {
			errors.push(`${path}: matched ${matches.length} of oneOf (expected exactly 1)`);
		}
	}
	return errors;
}

const isValid = (schema, value) => validate(schema, value).length === 0;

describe('protocol.schema.json (the Lantean protocol, revision 1)', () => {
	it('the schema is a draft 2020-12 document with a oneOf frame union', () => {
		expect(root.$schema).toContain('2020-12');
		expect(Array.isArray(root.oneOf)).toBe(true);
		expect(root.$defs).toBeTypeOf('object');
	});

	it('every canonical vector validates against the top-level schema and its named def', () => {
		for (const { def, frame } of vectors.frames) {
			const topErrs = validate(root, frame);
			expect(topErrs, `${def} vs top-level: ${topErrs.join('; ')}`).toEqual([]);
			const defErrs = validate(root.$defs[def], frame);
			expect(defErrs, `${def} vs $defs.${def}: ${defErrs.join('; ')}`).toEqual([]);
		}
	});

	it('rejects every deliberately-invalid vector', () => {
		for (const { reason, frame } of vectors.invalid) {
			expect(isValid(root, frame), `should reject: ${reason}`).toBe(false);
		}
	});

	it('the validator itself discriminates (a valid frame is not accepted as the wrong def)', () => {
		const welcome = { type: 'welcome', sessionId: 'x' };
		expect(isValid(root.$defs.welcome, welcome)).toBe(true);
		expect(isValid(root.$defs.subscribed, welcome)).toBe(false);
	});

	it('accepts the typed established-message overload response', () => {
		expect(isValid(root.$defs['message-overloaded'], {
			type: 'message-overloaded',
			reason: 'rate_limit',
			scope: 'connection',
			retryAfterMs: 25
		})).toBe(true);
		expect(isValid(root.$defs['message-overloaded'], {
			type: 'message-overloaded',
			reason: 'unbounded',
			scope: 'connection'
		})).toBe(false);
	});
});

describe('binary 0x03 vector decodes to the documented layout', () => {
	// Decode an unsigned LEB128 varint with division (not 32-bit shifts), per
	// PROTOCOL.md section 6.3, so a topicId above 2^32 round-trips exactly.
	function readVarint(bytes, pos) {
		let result = 0, mul = 1, byte;
		do {
			byte = bytes[pos++];
			result += (byte & 0x7f) * mul;
			mul *= 128;
		} while (byte & 0x80);
		return [result, pos];
	}

	it('matches the decoded fields in binary.json', () => {
		const bytes = Buffer.from(binaryVector.hexFrame, 'hex');
		expect(bytes[0]).toBe(binaryVector.decoded.tag); // 0x03
		let pos = 1;
		const schemaVersion = bytes[pos++];
		let topicId, seq;
		[topicId, pos] = readVarint(bytes, pos);
		[seq, pos] = readVarint(bytes, pos);
		const payloadHex = bytes.subarray(pos).toString('hex');
		expect(schemaVersion).toBe(binaryVector.decoded.schemaVersion);
		expect(topicId).toBe(binaryVector.decoded.topicId);
		expect(topicId).toBeGreaterThan(2 ** 32); // shared-cohort id
		expect(seq).toBe(binaryVector.decoded.seq);
		expect(payloadHex).toBe(binaryVector.decoded.payloadHex);
	});
});

describe('WebTransport reliable-stream carriage', () => {
	it('pins the JavaScript reference-runtime adoption decision once', () => {
		expect(protocol.indexOf(expectedJsTransportDecision)).toBeGreaterThan(-1);
		expect(protocol.indexOf(expectedJsTransportDecision))
			.toBe(protocol.lastIndexOf(expectedJsTransportDecision));
	});

	function encodeVarint(value) {
		const out = [];
		do {
			let byte = value % 128;
			value = Math.floor(value / 128);
			if (value > 0) byte |= 0x80;
			out.push(byte);
		} while (value > 0);
		return Buffer.from(out);
	}

	function prefix(bytes) {
		let value = 0;
		let mul = 1;
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i];
			value += (byte & 0x7f) * mul;
			if ((byte & 0x80) === 0) {
				const consumed = bytes.subarray(0, i + 1);
				if (!consumed.equals(encodeVarint(value))) {
					return { error: 'PROTOCOL_ERROR' };
				}
				if (value < root['x-webtransport'].reliableStream.minimumMessageBytes) {
					return { error: 'PROTOCOL_ERROR' };
				}
				if (value > root['x-webtransport'].reliableStream.maximumMessageBytes) {
					return { error: 'RECORD_TOO_LARGE' };
				}
				return { value, bytes: i + 1 };
			}
			mul *= 128;
		}
		return null;
	}

	it('freezes the CONNECT, topology, size, and error constants in the schema', () => {
		const wt = root['x-webtransport'];
		expect(wt.connectCapabilityQueryKey).toBe('lantean-cap');
		expect(wt.connectCapabilities).toEqual({
			'game.fanout:1': 'compact-datagram-fanout',
			'lantean.reliable:1': 'reliable-bidirectional-stream'
		});
		expect(wt.reliableStream).toEqual({
			opener: 'client',
			bidirectionalStreamCount: 1,
			unidirectionalStreamCount: 0,
			lengthPrefix: 'canonical-unsigned-leb128',
			minimumMessageBytes: 1,
			maximumMessageBytes: 1_048_576,
			maximumPendingBytes: 1_048_576,
			pendingByteAccounting: 'message-bytes-excluding-length-prefix',
			firstServerFrame: 'welcome',
			innerMessage: 'websocket-message-bytes'
		});
		expect(wt.streamErrors).toEqual({
			STREAM_LIMIT: 1,
			RECORD_TOO_LARGE: 2,
			PROTOCOL_ERROR: 3,
			SLOW_CONSUMER: 4
		});
	});

	it('keeps the normative prose and registries on the same constants', () => {
		expect(protocol).toContain('### 14.7 CONNECT capability declarations');
		expect(protocol).toContain('## 15. The WebTransport reliable-stream binding');
		expect(protocol).toContain('[messageLength:varint][messageBytes:messageLength]');
		expect(protocol).toContain('**`lantean-cap`**, repeated once per token');
		for (const token of Object.keys(root['x-webtransport'].connectCapabilities)) {
			expect(protocol).toContain(`\`${token}\``);
		}
		for (const [name, code] of Object.entries(root['x-webtransport'].streamErrors)) {
			expect(protocol).toContain(`\`0x0${code}\` | \`${name}\``);
		}
		expect(protocol).toMatch(/\*\*1,048,576 bytes\s+per session\*\*/);
		expect(protocol).toMatch(/the\s+1-3-byte length prefixes are fixed framing overhead and do not count/);
		expect(protocol).not.toContain('a future revision may bind reliable lanes');
	});

	it('decodes the repeated CONNECT capability carrier exactly once', () => {
		const params = new URLSearchParams(streamVector.connectQuery);
		expect(params.getAll(root['x-webtransport'].connectCapabilityQueryKey))
			.toEqual(streamVector.decodedConnectCapabilities);
		expect(params.getAll('cap')).toEqual([]);
	});

	it('each record is a canonical length plus byte-identical inner message', () => {
		for (const record of streamVector.records) {
			const payload = Buffer.from(record.payloadHex, 'hex');
			expect(payload.byteLength).toBe(record.length);
			expect(Buffer.concat([encodeVarint(record.length), payload]).toString('hex'))
				.toBe(record.recordHex);
			if (record.kind === 'text') {
				expect(JSON.parse(payload.toString('utf8'))).toEqual(record.frame);
				expect(validate(root, record.frame)).toEqual([]);
			} else {
				expect(record.payloadHex).toBe(binaryVector.hexFrame);
				expect(record.decoded).toEqual(binaryVector.decoded);
			}
		}
		expect(streamVector.records[0].frame.type).toBe(
			root['x-webtransport'].reliableStream.firstServerFrame
		);
	});

	it('reassembles records across arbitrary read boundaries', () => {
		const stream = Buffer.from(streamVector.concatenatedHex, 'hex');
		expect(streamVector.fragmentLengths.reduce((sum, n) => sum + n, 0))
			.toBe(stream.byteLength);
		let pending = Buffer.alloc(0);
		let at = 0;
		const decoded = [];
		for (const size of streamVector.fragmentLengths) {
			pending = Buffer.concat([pending, stream.subarray(at, at + size)]);
			at += size;
			for (;;) {
				const head = prefix(pending);
				if (head === null || head.error || pending.length < head.bytes + head.value) break;
				decoded.push(pending.subarray(head.bytes, head.bytes + head.value).toString('hex'));
				pending = pending.subarray(head.bytes + head.value);
			}
		}
		expect(pending.byteLength).toBe(0);
		expect(decoded).toEqual(streamVector.records.map((record) => record.payloadHex));
	});

	it('rejects zero, non-canonical, and over-limit prefixes with the frozen errors', () => {
		for (const vector of streamVector.invalidPrefixes) {
			expect(prefix(Buffer.from(vector.hex, 'hex')), vector.reason)
				.toEqual({ error: vector.error });
			expect(root['x-webtransport'].streamErrors[vector.error], vector.reason)
				.toBeTypeOf('number');
		}
	});
});

// Anti-drift: frames the real server emits must conform to the published schema.
const uWS = hasUWS ? (await import('uWebSockets.js')).default : null;
const describeUWS = hasUWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const messages = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		messages.push(JSON.parse(data.toString()));
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, messages };
}

const tick = () => new Promise((r) => setTimeout(r, 40));

describeUWS('reference server frames conform to the schema', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('welcome, subscribed, subscribe-denied, lease/lease-ok, and error all validate', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({});

		const { ws, messages } = await connectClient(server.wsUrl);
		await tick();
		ws.send(JSON.stringify({ type: 'hello', caps: ['lease'] }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat', ref: 1 }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: '__system', ref: 2 }));
		// Oversized control-shaped frame -> error CONTROL_FRAME_TOO_LARGE.
		ws.send('{"type":"subscribe","topic":"chat","ref":3,"pad":"' + 'x'.repeat(9000) + '"}');
		await tick();

		const seen = {};
		for (const m of messages) {
			const errs = validate(root, m);
			expect(errs, `${m.type || 'data-event'}: ${errs.join('; ')}`).toEqual([]);
			if (m.type) seen[m.type] = m;
		}
		// Confirm we actually exercised the interesting frames.
		expect(seen.welcome).toBeDefined();
		expect(seen['lease-ok']).toBeDefined();
		expect(seen.lease).toBeDefined();
		expect(seen.subscribed).toBeDefined();
		expect(seen.subscribed.epoch).toBeTypeOf('number');
		expect(seen['subscribe-denied']).toBeDefined();
		expect(seen['subscribe-denied'].reason).toBe('INVALID_TOPIC');
		expect(seen.error).toBeDefined();
		expect(seen.error.code).toBe('CONTROL_FRAME_TOO_LARGE');

		ws.close();
	});
});
