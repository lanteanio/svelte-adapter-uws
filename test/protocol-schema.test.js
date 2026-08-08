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
// Where a pin spans a line, match against collapsed whitespace: a reflow is not
// a wire change, and a pin that breaks on rewrapping trains people to loosen it.
// Paragraph breaks survive as breaks, so a pin can never span two paragraphs and
// report a sentence the document does not actually carry in one place.
const flatProtocol = protocol
	.split(/\n\s*\n/)
	.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
	.join('\n\n');
// The Meta block alone: an assertion about what Meta says must not be satisfied
// by the same words appearing in a section 800 lines away.
const metaBlock = protocol.slice(protocol.indexOf('## Meta'), protocol.indexOf('## 1. Framing'));
const expectedJsTransportDecision = [
	'**Reference-runtime transport decision (`js-transport-v1`):**',
	'WebSocket/WSS remains the permanent default and complete transport for the',
	'JavaScript adapter. No post-0.6 WebTransport client lane is scheduled for this',
	'package: a negotiate-WebTransport/fall-back-to-WebSocket ladder remains parked',
	'with no release target. Reopening it requires independent OSS demand, an',
	'available QUIC-terminating server surface, and conformance against sections 14',
	'and 15. A native runtime may implement those bindings independently - section 14',
	'as frozen, section 15 at its own wire status (see Meta) - and that does not',
	'create a JavaScript server or client deliverable.'
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

	const kindNames = Object.fromEntries(
		Object.entries(root['x-webtransport'].reliableStream.recordKinds)
			.map(([name, value]) => [value, name])
	);

	// A conformant record read, parameterized by the one thing section 15.1 lets
	// a receiver choose: how large a record it accepts. Returns null while bytes
	// are missing, {error} on a rejection, and {kind, payload, consumed} on a
	// complete record. The kind byte is judged only after both prefix verdicts,
	// and a text record must decode as UTF-8 (RFC 6455 parity, section 15.6).
	function readRecord(pending, receiverLimit) {
		const { recordKindBytes, unknownRecordKindError, invalidTextUtf8Error } =
			root['x-webtransport'].reliableStream;
		const head = prefix(pending, receiverLimit);
		if (head === null || head.error) return head;
		if (pending.length < head.bytes + recordKindBytes) return null;
		const kind = kindNames[pending[head.bytes]];
		if (kind === undefined) return { error: unknownRecordKindError };
		const framing = head.bytes + recordKindBytes;
		if (pending.length < framing + head.value) return null;
		const payload = pending.subarray(framing, framing + head.value);
		if (kind === 'text') {
			try {
				new TextDecoder('utf-8', { fatal: true }).decode(payload);
			} catch {
				return { error: invalidTextUtf8Error };
			}
		}
		return { kind, payload, consumed: framing + head.value };
	}

	function prefix(bytes, receiverLimit = root['x-webtransport'].reliableStream.defaultReceiverMessageBytes) {
		const { minimumMessageBytes, maximumLengthPrefixBytes } = root['x-webtransport'].reliableStream;
		let value = 0;
		let mul = 1;
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i];
			// Structural, and decided before any length is known: a prefix that runs
			// past the cap is refused at the byte after it, never read further.
			if (i >= maximumLengthPrefixBytes) return { error: 'PROTOCOL_ERROR' };
			value += (byte & 0x7f) * mul;
			if ((byte & 0x80) === 0) {
				const consumed = bytes.subarray(0, i + 1);
				if (!consumed.equals(encodeVarint(value))) {
					return { error: 'PROTOCOL_ERROR' };
				}
				if (value < minimumMessageBytes) {
					return { error: 'PROTOCOL_ERROR' };
				}
				if (value > receiverLimit) {
					return { error: 'RECORD_TOO_LARGE' };
				}
				return { value, bytes: i + 1 };
			}
			mul *= 128;
		}
		return null;
	}

	it('pins the CONNECT, topology, size, and error constants in the schema', () => {
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
			recordKindBytes: 1,
			recordKinds: { text: 0, binary: 1 },
			unknownRecordKindError: 'PROTOCOL_ERROR',
			invalidTextUtf8Error: 'PROTOCOL_ERROR',
			minimumMessageBytes: 1,
			maximumLengthPrefixBytes: 5,
			maximumSenderMessageBytes: 1_048_576,
			defaultReceiverMessageBytes: 1_048_576,
			receiverMessageBytesConfigurable: true,
			minimumPendingBytes: 1_048_576,
			pendingByteAccounting: 'message-bytes-excluding-length-prefix-and-kind',
			innerControlFrameCeilingBytes: 8192,
			firstServerFrame: 'welcome',
			innerMessage: 'websocket-message-bytes'
		});
		// The rejection mappings must name registered stream errors, not prose.
		expect(Object.keys(wt.streamErrors)).toContain(wt.reliableStream.unknownRecordKindError);
		expect(Object.keys(wt.streamErrors)).toContain(wt.reliableStream.invalidTextUtf8Error);
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
		expect(protocol).toContain('[messageLength:varint][kind:u8][messageBytes:messageLength]');
		// The kindless layout discarded the WebSocket opcode, leaving a
		// reliable stream that could not say text-vs-binary. It must never
		// reappear, not even as a stale second copy.
		expect(protocol).not.toContain('[messageLength:varint][messageBytes:messageLength]');
		expect(protocol).toContain('**`lantean-cap`**, repeated once per token');
		for (const token of Object.keys(root['x-webtransport'].connectCapabilities)) {
			expect(protocol).toContain(`\`${token}\``);
		}
		for (const [name, code] of Object.entries(root['x-webtransport'].streamErrors)) {
			expect(protocol).toContain(`\`0x0${code}\` | \`${name}\``);
		}
		expect(flatProtocol).toContain('**1,048,576 bytes per session**');
		expect(flatProtocol).toContain('the length prefix (at most 5 bytes, 15.1) and the `kind` byte are fixed framing overhead');
		expect(protocol).not.toContain('a future revision may bind reliable lanes');
	});

	// The kind byte restates the WebSocket opcode. Its registered values, its
	// reject-unknown posture, and the text UTF-8 rule must agree between the
	// schema constants and the normative prose, in both directions.
	it('binds the record-kind constants to the prose', () => {
		const { recordKinds } = root['x-webtransport'].reliableStream;
		expect(flatProtocol).toContain(
			`\`0x0${recordKinds.text}\` is a text message, \`0x0${recordKinds.binary}\` is a binary message`
		);
		expect(flatProtocol).toContain('A receiver MUST reject any other value with `PROTOCOL_ERROR`');
		// The pass-through rule must be carved out for the discriminator: a record
		// whose type is unknown cannot be delivered anywhere.
		expect(flatProtocol).toContain('deliberately does NOT apply to this byte');
		expect(flatProtocol).toContain('MUST be valid UTF-8 in whole');
		// 15.6 must carry both structural additions on its error path.
		expect(flatProtocol).toContain('an unknown `kind` (anything but `0x00`/`0x01`, 15.1), a text record that is not valid UTF-8');
		// The check order is what keeps the two codes non-overlapping.
		expect(flatProtocol).toContain('a record refused for its length is answered for its length and its `kind` byte is never inspected');
	});

	// A sender permitted to emit a large record must be able to QUEUE it: a flat
	// pending bound would make the permitted emission reset the sender's own lane.
	it('scales the pending bound with what this endpoint may emit', () => {
		expect(protocol).toMatch(/That bound MUST be\s+at least \*\*1,048,576 bytes per session\*\*, and at least the largest record this\s+endpoint may itself emit/);
		expect(protocol).not.toMatch(/send stream to \*\*1,048,576 bytes\s+per session\*\*\./);
	});

	// Nothing on this carriage negotiates a size, so each side gets a rule it can
	// evaluate alone: the sender a constant, the receiver its own configuration.
	it('splits the record size into a sender constant and a receiver floor', () => {
		const { maximumSenderMessageBytes, defaultReceiverMessageBytes } =
			root['x-webtransport'].reliableStream;
		const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		expect(protocol).toContain(`MUST NOT emit a record whose \`messageBytes\` exceed ${grouped(maximumSenderMessageBytes)}`);
		expect(flatProtocol).toContain(`and **${grouped(defaultReceiverMessageBytes)} bytes** absent configuration`);
		// The parity rule must bind BOTH directions: a lowered limit that applied
		// only to WebSocket would split the carriages exactly as a raised one did.
		expect(flatProtocol).toContain('whether it raises that limit or lowers it');
		// The old justification was false: section 1.3 states a configurable
		// default, never a ceiling, so a raised limit split the two carriages.
		expect(protocol).not.toContain('the section 1.3 frame ceiling made transport-independent');
		expect(protocol).toMatch(/`maxPayloadLength` \(default 1 MiB,\s+deployment-configurable\)/);
		// Section 12 reads 1.3 for its DoS bound and must not restate it as a cap.
		expect(protocol).not.toContain('1 MiB payload cap');
	});

	// Both halves: the document must GRANT the raised receiver, and the vector
	// must stay replayable by one - a helper agreeing with itself proves neither.
	it('lets a raised receiver accept what a floor receiver refuses', () => {
		const { defaultReceiverMessageBytes } = root['x-webtransport'].reliableStream;
		expect(flatProtocol).toContain('deployment-configurable');
		expect(root['x-webtransport'].reliableStream.receiverMessageBytesConfigurable).toBe(true);
		// The vector states the receiver it assumes, so a differently-configured
		// implementer knows which entry is conditional and why.
		expect(streamVector.assumedReceiverMessageBytes).toBe(defaultReceiverMessageBytes);
		const conditional = streamVector.invalidPrefixes.filter((entry) => entry.dependsOnReceiverLimit);
		expect(conditional).toHaveLength(1);
		const overFloor = Buffer.from(conditional[0].hex, 'hex');
		expect(prefix(overFloor)).toEqual({ error: conditional[0].error });
		expect(prefix(overFloor, defaultReceiverMessageBytes * 4))
			.toEqual({ value: defaultReceiverMessageBytes + 1, bytes: overFloor.byteLength });
		// Every unconditional entry must hold at ANY conformant receiver limit.
		for (const entry of streamVector.invalidPrefixes.filter((e) => !e.dependsOnReceiverLimit)) {
			expect(prefix(Buffer.from(entry.hex, 'hex'), defaultReceiverMessageBytes * 4), entry.reason)
				.toEqual({ error: entry.error });
		}
	});

	// Structure is decided on the COMPLETE prefix. A receiver judging a partial
	// value could answer the same bytes with either code - hand-checked below.
	it('forbids deciding on a partial prefix value', () => {
		expect(flatProtocol).toContain('The LENGTH VALUE is judged only once the prefix is complete, never on a partial accumulation');
		// 1 + 64*16384 = 1048577 after three bytes, but the 4-byte encoding is
		// non-canonical (canonical is 81 80 40), so structure wins: PROTOCOL_ERROR.
		expect(prefix(Buffer.from('8180c000', 'hex'))).toEqual({ error: 'PROTOCOL_ERROR' });
		// Partial exceeds the floor at byte 3, yet the prefix runs past the cap.
		expect(prefix(Buffer.from('ffffffffff01', 'hex'))).toEqual({ error: 'PROTOCOL_ERROR' });
	});

	// Section 1.2's ceiling is client-to-server; a server-to-client `batch` may
	// legitimately exceed it on WebSocket, so it must not be rejected here.
	it('keeps the control-frame ceiling client-to-server only', () => {
		expect(protocol).toMatch(/it bounds CLIENT-TO-SERVER control records only, and a server-to-client/);
		expect(protocol).toMatch(/That\s+ceiling does not apply server-to-client, so a large `batch` record is bounded\s+only by the record limit/);
	});

	// An over-wide prefix is refused structurally, before any length is known -
	// the bound the fixed ceiling used to imply and no longer does.
	it('refuses a prefix past the cap at every receiver limit', () => {
		const { maximumLengthPrefixBytes } = root['x-webtransport'].reliableStream;
		// Pinned in prose too: a derived-only check cannot notice the cap moving.
		expect(protocol).toContain(`The prefix MUST NOT exceed **${maximumLengthPrefixBytes} bytes**`);
		const overWide = Buffer.alloc(maximumLengthPrefixBytes + 1, 0x80);
		overWide[maximumLengthPrefixBytes] = 0x01;
		expect(prefix(overWide)).toEqual({ error: 'PROTOCOL_ERROR' });
		// The largest limit the carriage can express - not MAX_SAFE_INTEGER, which
		// would quantify over receivers the document forbids.
		expect(prefix(overWide, 2 ** (7 * maximumLengthPrefixBytes) - 1)).toEqual({ error: 'PROTOCOL_ERROR' });
		// The cap is what makes the length space finite, so the document must say
		// how large a length is expressible and cap any configured limit by it.
		const expressible = 2 ** (7 * maximumLengthPrefixBytes) - 1;
		expect(protocol).toContain(`**${String(expressible).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}**`);
	});

	// A control record is bounded twice: by the carriage, and by section 1.2
	// after deframing. The two breaches answer differently.
	it('carries the control-frame ceiling across the deframe boundary', () => {
		const { innerControlFrameCeilingBytes } = root['x-webtransport'].reliableStream;
		expect(protocol).toContain(`**under ${innerControlFrameCeilingBytes} bytes**`);
		expect(protocol).toContain(`the ${innerControlFrameCeilingBytes}-byte control-frame ceiling`);
		expect(flatProtocol).toContain('answered with the ordinary `error` control frame (section 3.7) on the same stream and leaves the lane open');
		// 15.6 is where an implementer builds the error path, so the one breach
		// that must NOT reset the lane has to be visible there too.
		expect(flatProtocol).toContain('One inner breach is deliberately NOT a lane reset');
	});

	// The reliable lane carries WebSocket bytes, so it carries the WebSocket
	// form of the capability - not the datagram lane's one-room shorthand.
	it('resolves compact fan-out on the reliable lane to the announced wire-id form', () => {
		expect(flatProtocol).toContain("section 6.7's WebSocket form: the ordinary `wire-id` binding of section 6.2");
		expect(flatProtocol).toContain("NOT section 14.6's reserved id `0`");
		// A freeze candidate may not restate a frozen section more broadly than the
		// frozen section states itself, so 15.7 quotes 6.7 instead of widening it.
		expect(protocol).not.toContain('per-connection or shared-cohort');
	});

	// Every place that states section 15's status must agree, in both directions,
	// and deleting the status line entirely may not read as a silent promotion.
	it('states section 15 status consistently everywhere it is claimed', () => {
		const sectionIsCandidate = protocol.includes('**Wire status: freeze candidate.**');
		const metaCarvesItOut = /Provisional today[\s\S]{0,600}?\*\*section 15\*\* in whole/.test(protocol);
		// Non-vacuous: the section must carry SOME status line either way.
		expect(protocol).toMatch(/\*\*Wire status:[^*]*\*\*[\s\S]{0,200}?additive within revision 1/);
		expect(metaCarvesItOut).toBe(sectionIsCandidate);
		// The header block calls section 14 frozen; it must not sweep 15 in with it.
		expect(protocol).not.toContain('A native runtime may implement those frozen bindings');
		// Promotion has to move the schema's description too, or a machine consumer
		// keeps reading "provisional" after the wire froze.
		expect(root.description.includes('freeze candidate')).toBe(sectionIsCandidate);
		// Scoped to Meta itself: these strings all occur elsewhere in the document,
		// so an unscoped search passes with the whole enumeration deleted.
		for (const reference of ['section 13', '14.1', '14.2', '14.5', 'appendices D, E']) {
			expect(metaBlock, `Meta must name ${reference} as carrying provisional references`)
				.toContain(reference);
		}
		// It is a RULE, not a closed list - the list can never enumerate every site.
		expect(metaBlock).toContain('This is a rule, not a list');
		expect(metaBlock).not.toContain('it is exhaustive');
	});

	it('decodes the repeated CONNECT capability carrier exactly once', () => {
		const params = new URLSearchParams(streamVector.connectQuery);
		expect(params.getAll(root['x-webtransport'].connectCapabilityQueryKey))
			.toEqual(streamVector.decodedConnectCapabilities);
		expect(params.getAll('cap')).toEqual([]);
	});

	it('each record is a canonical length plus kind plus byte-identical inner message', () => {
		const { recordKinds } = root['x-webtransport'].reliableStream;
		for (const record of streamVector.records) {
			const payload = Buffer.from(record.payloadHex, 'hex');
			expect(payload.byteLength).toBe(record.length);
			expect(recordKinds[record.kind], `unregistered kind ${record.kind}`).toBeTypeOf('number');
			expect(
				Buffer.concat([encodeVarint(record.length), Buffer.from([recordKinds[record.kind]]), payload]).toString('hex')
			).toBe(record.recordHex);
			if (record.kind === 'text') {
				// RFC 6455 parity carried across the carriage: every text record in
				// the canonical transcript must be valid UTF-8.
				expect(() => new TextDecoder('utf-8', { fatal: true }).decode(payload)).not.toThrow();
				expect(JSON.parse(payload.toString('utf8'))).toEqual(record.frame);
				expect(validate(root, record.frame)).toEqual([]);
			} else if (record.decoded) {
				expect(record.payloadHex).toBe(binaryVector.hexFrame);
				expect(record.decoded).toEqual(binaryVector.decoded);
			} else {
				// An opaque binary payload must say why it is in the vector.
				expect(record.note).toBeTypeOf('string');
			}
		}
		expect(streamVector.records[0].frame.type).toBe(
			root['x-webtransport'].reliableStream.firstServerFrame
		);
	});

	// The SAME bytes as a text message and as a binary message are two distinct
	// WebSocket inputs (section 1.4, MessageContext.isBinary), so they must be
	// two distinct stream records. The pair is chosen to be valid UTF-8 JSON
	// beginning `{` so no demux other than the kind byte - first byte, UTF-8
	// sniffing, JSON parsing - can separate it.
	it('carries the ambiguous pair only the kind byte can separate', () => {
		const byPayload = new Map();
		for (const record of streamVector.records) {
			byPayload.set(record.payloadHex, [...(byPayload.get(record.payloadHex) ?? []), record]);
		}
		const pairs = [...byPayload.values()].filter((records) => records.length > 1);
		expect(pairs).toHaveLength(1);
		const [pair] = pairs;
		expect(pair.map((record) => record.kind).sort()).toEqual(['binary', 'text']);
		const payload = Buffer.from(pair[0].payloadHex, 'hex');
		expect(payload[0]).toBe(0x7b);
		expect(() => new TextDecoder('utf-8', { fatal: true }).decode(payload)).not.toThrow();
		expect(() => JSON.parse(payload.toString('utf8'))).not.toThrow();
		const [a, b] = pair.map((record) => Buffer.from(record.recordHex, 'hex'));
		expect(a.byteLength).toBe(b.byteLength);
		const differing = [...a].map((v, i) => (v === b[i] ? -1 : i)).filter((i) => i >= 0);
		// The records differ at EXACTLY the kind byte - the position right after
		// the length prefix - which is the proof the discriminator is load-bearing.
		expect(differing).toEqual([encodeVarint(payload.byteLength).byteLength]);
		const decodedA = readRecord(a);
		const decodedB = readRecord(b);
		expect(decodedA.payload.equals(decodedB.payload)).toBe(true);
		expect(decodedA.kind).not.toBe(decodedB.kind);
	});

	it('reassembles typed records across arbitrary read boundaries', () => {
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
				const record = readRecord(pending);
				if (record === null) break;
				expect(record.error).toBeUndefined();
				decoded.push({ kind: record.kind, payloadHex: record.payload.toString('hex') });
				pending = pending.subarray(record.consumed);
			}
		}
		expect(pending.byteLength).toBe(0);
		// kind AND payload: a decoder that discards the kind byte reproduces the
		// payloads but not the tuples, so it fails on the ambiguous pair.
		expect(decoded).toEqual(streamVector.records.map((record) => ({
			kind: record.kind,
			payloadHex: record.payloadHex
		})));
	});

	it('rejects zero, non-canonical, and over-limit prefixes with the frozen errors', () => {
		for (const vector of streamVector.invalidPrefixes) {
			expect(prefix(Buffer.from(vector.hex, 'hex')), vector.reason)
				.toEqual({ error: vector.error });
			expect(root['x-webtransport'].streamErrors[vector.error], vector.reason)
				.toBeTypeOf('number');
		}
	});

	// Structural rejections past the prefix: an unregistered kind byte and a
	// text record whose bytes are not UTF-8. Both are lane resets (15.6), and
	// both must be decided without delivering anything to the application.
	it('rejects unknown kinds and invalid-UTF-8 text records with the registered error', () => {
		for (const vector of streamVector.invalidRecords) {
			expect(readRecord(Buffer.from(vector.recordHex, 'hex')), vector.reason)
				.toEqual({ error: vector.error });
			expect(root['x-webtransport'].streamErrors[vector.error], vector.reason)
				.toBeTypeOf('number');
		}
		// The rejections must cover both structural checks, not three copies of one.
		const reasons = streamVector.invalidRecords.map((vector) => vector.reason).join(' ');
		expect(reasons).toContain('kind');
		expect(reasons).toContain('UTF-8');
	});
});

// Two errata against frozen demux text, pinned so the clarifications cannot
// silently regress to the ambiguous wording they replaced. Both document
// shipped behaviour: the game fan-out allocates through the per-connection
// wire-id counter (never the shared-cohort acquire), and the runtime delivers
// unknown-leading-byte client binary to the application untouched.
describe('frozen demux errata', () => {
	it('pins the reserved-byte rule to the unknown-frame rule it defers to', () => {
		expect(flatProtocol).toContain('A Reserved value is not an open slot');
		expect(flatProtocol).toContain('assignable only behind a future negotiated capability token (sections 5, 10)');
		// The deferral must quote 1.4's actual behavior, both directions.
		expect(flatProtocol).toContain('client to server it reaches the application message handler untouched, server to client the reference client drops it');
		expect(flatProtocol).toContain('untagged application binary is, and remains, legal');
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
