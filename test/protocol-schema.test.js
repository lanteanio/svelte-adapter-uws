import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const expectedTransportStatus = [
	'**Transport status (reference runtime):**',
	'WebSocket/WSS is the permanent default and complete transport for the',
	'JavaScript adapter; no capability of this protocol requires sections 14 or 15',
	'to be available. Those sections define how this same wire binds to',
	'WebTransport for a runtime that implements them. Whether and when any package',
	"ships such a lane is that package's own decision, not a statement of this",
	'contract. A native runtime may implement those bindings independently -',
	'section 14 as frozen, section 15 at its own wire status (see Meta) - and that',
	'does not create a JavaScript server or client deliverable.'
].join('\n');
// Every shipped source, not just the entry file: a WebTransport lane could
// land in client-runtime.js, a plugin client, or a new module the entry
// imports, and a one-file scan would miss exactly the likely shape.
function walkSources(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkSources(path));
		else if (entry.name.endsWith('.js')) files.push(path);
	}
	return files;
}
const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
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
	// The preamble states transport FACTS; package scheduling belongs to each
	// package, and normative wire text must not freeze a product decision.
	it('pins the transport status once and keeps scheduling policy off the wire text', () => {
		expect(protocol.indexOf(expectedTransportStatus)).toBeGreaterThan(-1);
		expect(protocol.indexOf(expectedTransportStatus))
			.toBe(protocol.lastIndexOf(expectedTransportStatus));
		// The removed decision register must not resurface anywhere in the
		// contract: no schedule claims, no release targets, no invented
		// reopening preconditions. Case-insensitive, so a mid-sentence
		// respelling cannot slip past the phrase-initial capital.
		for (const scheduling of [/js-transport-v1/i, /no post-0\.6/i, /remains parked/i, /release target/i, /independent OSS demand/i]) {
			expect(protocol, String(scheduling)).not.toMatch(scheduling);
		}
	});

	// The status paragraph is falsifiable against the implementation it
	// describes: the moment ANY shipped source grows a WebTransport lane -
	// entry file, client runtime, plugin client, or a new module - this fails
	// and forces the preamble to be rewritten, which the old prose-duplicating
	// pin could never do. The WebTransport global constructor must appear
	// somewhere in the sources for a lane to exist.
	it('matches the transport status against the actual shipped sources', () => {
		const files = walkSources(sourceRoot);
		expect(files.length).toBeGreaterThan(100);
		for (const file of files) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(/WebTransport|createBidirectionalStream/i);
		}
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

	const isUtf8Text = (bytes) => {
		try {
			new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			return true;
		} catch {
			return false;
		}
	};

	// A conformant record read, parameterized by the one thing section 15.1 lets
	// a receiver choose: how large a record it accepts. Returns null while bytes
	// are missing, {error, check} on a rejection - `check` names the rule that
	// refused it, so a vector refused for some other reason cannot pass - and
	// {kind, payload, consumed} on a complete record. The kind byte is judged
	// only after both prefix verdicts, a text record must decode as UTF-8 (RFC
	// 6455 parity, section 15.6), and a close record must carry a close payload
	// a WebSocket endpoint could send (15.4).
	// `options.refuseOversizeCloseAtKind` is the MAY of 15.4: refuse a close
	// record declaring more than any close payload holds at its kind byte.
	function readRecord(pending, receiverLimit, options = {}) {
		const { recordKindBytes, unknownRecordKindError, invalidTextUtf8Error, closeRecord } =
			root['x-webtransport'].reliableStream;
		const head = prefix(pending, receiverLimit);
		if (head === null || head.error) return head;
		if (pending.length < head.bytes + recordKindBytes) return null;
		const kind = kindNames[pending[head.bytes]];
		if (kind === undefined) return { error: unknownRecordKindError, check: 'unknown-kind' };
		if (options.refuseOversizeCloseAtKind && kind === 'close' &&
			head.value > closeRecord.codeBytes + closeRecord.maximumReasonBytes) {
			return { error: closeRecord.malformedError, check: 'close-reason-length' };
		}
		const framing = head.bytes + recordKindBytes;
		if (pending.length < framing + head.value) return null;
		const payload = pending.subarray(framing, framing + head.value);
		if (kind === 'text' && !isUtf8Text(payload)) return { error: invalidTextUtf8Error, check: 'invalid-text' };
		if (kind === 'close') {
			const check = closePayloadCheck(payload);
			if (check) return { error: closeRecord.malformedError, check };
		}
		return { kind, payload, consumed: framing + head.value };
	}

	// An empty close payload carries no code; otherwise a code and its reason.
	function decodeClose(payload) {
		const { codeBytes } = root['x-webtransport'].reliableStream.closeRecord;
		if (payload.length === 0) return undefined;
		return { code: payload.readUIntBE(0, codeBytes), reason: payload.subarray(codeBytes).toString('utf8') };
	}

	// One record's payload, unjudged: for looking inside a vector that is refused.
	function readRecordPayload(recordHex) {
		const bytes = Buffer.from(recordHex, 'hex');
		const head = prefix(bytes);
		const start = head.bytes + root['x-webtransport'].reliableStream.recordKindBytes;
		return bytes.subarray(start, start + head.value);
	}

	// Null for a close payload a WebSocket endpoint could send, else the rule it breaks.
	function closePayloadCheck(payload) {
		const { codeBytes, allowedCodes, maximumReasonBytes } = root['x-webtransport'].reliableStream.closeRecord;
		if (payload.length === 0) return null;
		if (payload.length < codeBytes) return 'close-payload-length';
		const code = payload.readUIntBE(0, codeBytes);
		if (!allowedCodes.some(([low, high]) => code >= low && code <= high)) return 'close-code';
		const reason = payload.subarray(codeBytes);
		if (reason.length > maximumReasonBytes) return 'close-reason-length';
		return isUtf8Text(reason) ? null : 'close-reason-utf8';
	}

	// One direction of a lane that has ended in FIN: every record complete, and
	// nothing after a close record. Returns {records} or the first {error, check}.
	// `options.stopAfterClose` is the other MAY of 15.4: stop reading a
	// direction once its close record is in hand.
	function readStream(bytes, receiverLimit, options = {}) {
		const { bytesAfterError } = root['x-webtransport'].reliableStream.closeRecord;
		const records = [];
		let rest = bytes;
		while (rest.length > 0) {
			if (records.at(-1)?.kind === 'close') {
				if (options.stopAfterClose) break;
				return { error: bytesAfterError, check: 'after-close' };
			}
			const record = readRecord(rest, receiverLimit, options);
			if (record === null) return { error: 'PROTOCOL_ERROR', check: 'fin-inside-record' };
			if (record.error) return record;
			records.push(record);
			rest = rest.subarray(record.consumed);
		}
		return { records };
	}

	function prefix(bytes, receiverLimit = root['x-webtransport'].reliableStream.defaultReceiverMessageBytes) {
		const { maximumLengthPrefixBytes } = root['x-webtransport'].reliableStream;
		let value = 0;
		let mul = 1;
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i];
			// Structural, and decided before any length is known: a prefix that runs
			// past the cap is refused at the byte after it, never read further.
			if (i >= maximumLengthPrefixBytes) return { error: 'PROTOCOL_ERROR', check: 'over-cap' };
			value += (byte & 0x7f) * mul;
			if ((byte & 0x80) === 0) {
				const consumed = bytes.subarray(0, i + 1);
				if (!consumed.equals(encodeVarint(value))) {
					return { error: 'PROTOCOL_ERROR', check: 'non-canonical' };
				}
				if (value > receiverLimit) {
					return { error: 'RECORD_TOO_LARGE', check: 'over-limit' };
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
			recordKinds: { text: 0, binary: 1, close: 2 },
			unknownRecordKindError: 'PROTOCOL_ERROR',
			invalidTextUtf8Error: 'PROTOCOL_ERROR',
			minimumMessageBytes: 0,
			maximumLengthPrefixBytes: 5,
			maximumSenderMessageBytes: 1_048_576,
			senderOverBoundError: 'RECORD_TOO_LARGE',
			defaultReceiverMessageBytes: 1_048_576,
			minimumReceiverMessageBytes: 125,
			receiverMessageBytesConfigurable: true,
			minimumPendingBytes: 1_048_576,
			pendingByteAccounting: 'unsent-message-bytes-excluding-length-prefix-and-kind',
			minimumPendingRecords: 65_536,
			minimumServerUnacknowledgedBytes: 1_048_576,
			minimumAcknowledgementOnlyPendingBytes: 2_097_152,
			innerControlFrameCeilingBytes: 8192,
			firstServerFrame: 'welcome',
			innerMessage: 'websocket-message-bytes',
			closeRecord: {
				payload: 'websocket-close-frame-payload',
				codeBytes: 2,
				codeByteOrder: 'big-endian',
				allowedCodes: [[1000, 1003], [1007, 1014], [3000, 4999]],
				maximumReasonBytes: 123,
				emptyPayloadReportsCode: 1005,
				laneEndedWithoutCloseReportsCode: 1006,
				mayReplaceFirstServerFrame: true,
				malformedError: 'PROTOCOL_ERROR',
				bytesAfterError: 'PROTOCOL_ERROR'
			}
		});
		// The rejection mappings must name registered stream errors, not prose.
		const { reliableStream } = wt;
		for (const error of [
			reliableStream.unknownRecordKindError,
			reliableStream.invalidTextUtf8Error,
			reliableStream.senderOverBoundError,
			reliableStream.closeRecord.malformedError,
			reliableStream.closeRecord.bytesAfterError
		]) {
			expect(Object.keys(wt.streamErrors)).toContain(error);
		}
		expect(wt.streamErrors).toEqual({
			NO_ERROR: 0,
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
			`\`0x0${recordKinds.text}\` is a text message, \`0x0${recordKinds.binary}\` is a binary message, and ` +
			`\`0x0${recordKinds.close}\` is a close record`
		);
		expect(flatProtocol).toContain('A receiver MUST reject any other value with `PROTOCOL_ERROR`');
		// The reserved range starts right after the last registered kind, in
		// 15.1 and on 15.6's error path alike.
		const lastKind = Math.max(...Object.values(recordKinds));
		const hexByte = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
		expect(flatProtocol).toContain(`values \`${hexByte(lastKind + 1)}\`-\`0xFF\` are reserved`);
		// The pass-through rule must be carved out for the discriminator: a record
		// whose type is unknown cannot be delivered anywhere.
		expect(flatProtocol).toContain('deliberately does NOT apply to this byte');
		expect(flatProtocol).toContain('MUST be valid UTF-8 in whole');
		// 15.6 must carry every structural addition on its error path.
		expect(flatProtocol).toContain(
			`an unknown \`kind\` (anything but \`0x00\`-\`${hexByte(lastKind)}\`, 15.1), a text record that is not valid UTF-8, a malformed close record or any byte after one`
		);
		// The check order is what keeps the two codes non-overlapping.
		expect(flatProtocol).toContain('a record refused for its length is answered for its length and its `kind` byte is never inspected');
	});

	// A sender permitted to emit a large record must be able to QUEUE it: a flat
	// pending bound would make the permitted emission reset the sender's own lane.
	it('scales the pending bound with what this endpoint may emit', () => {
		expect(flatProtocol).toContain('The unsent-byte bound MUST be at least **1,048,576 bytes per session**, and at least the largest record this endpoint may itself emit');
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

	// The C.6 meaning column must judge each limit exactly as its section does.
	// The receiver record limit (15.1) is configurable in BOTH directions, so the
	// registry must not restate its default as a minimum: an implementer reading
	// only C.6 would otherwise accept a stream record its hardened WebSocket
	// refuses, or call a 256 KiB receiver nonconforming. The pending bound (15.6)
	// IS a floor ("MUST be at least"), and its row keeps saying so.
	it('keeps the C.6 registry meanings on the same limit semantics as 15.1 and 15.6', () => {
		const meaningOf = (name) => {
			const match = flatProtocol.match(new RegExp('\\| `' + name + '` \\|([^|\\n]*)\\|'));
			expect(match, name + ' row present in C.6').not.toBeNull();
			return match[1];
		};
		const { receiverMessageBytesConfigurable, defaultReceiverMessageBytes, minimumPendingBytes } =
			root['x-webtransport'].reliableStream;
		expect(receiverMessageBytesConfigurable).toBe(true);
		expect(defaultReceiverMessageBytes).toBe(1_048_576);
		const recordRow = meaningOf('RECORD_TOO_LARGE');
		expect(recordRow).toContain('deployment-configurable');
		expect(recordRow).toContain('1 MiB absent configuration');
		expect(recordRow).toContain('may still exceed a lowered limit, and refusing it is conforming');
		expect(recordRow).not.toContain('at least');
		// 15.6's floor has TWO conjuncts; a row carrying only the constant invites
		// an endpoint with a raised emission permission to violate the MUST.
		expect(minimumPendingBytes).toBe(1_048_576);
		const slowRow = meaningOf('SLOW_CONSUMER');
		expect(slowRow).toContain('at least 1 MiB');
		expect(slowRow).toContain('at least the largest record this endpoint may itself emit');
		// Every reset trigger 15.6 names has to be readable from the row too.
		const { minimumPendingRecords } = root['x-webtransport'].reliableStream;
		expect(slowRow).toContain(`or pending records would exceed its optional record bound (at least ${minimumPendingRecords.toLocaleString('en-US')})`);
		// The sender's own refusal (15.1) uses the receiver's code, so the row
		// must say so or an implementer reading C.6 alone invents a fifth code.
		expect(recordRow).toContain('or a sender held a message larger than it may emit (15.1)');
		expect(meaningOf('STREAM_LIMIT')).toContain('or a stream arrived before the server sent its successful response, where the server can tell (15.2)');
		expect(meaningOf('PROTOCOL_ERROR')).toContain('a malformed close record or bytes after one');
		expect(meaningOf('PROTOCOL_ERROR')).toContain('A malformed inner message is handled as on WebSocket instead');
		const noErrorRow = meaningOf('NO_ERROR');
		expect(noErrorRow).toContain('answering the peer\'s reset before it has received any STOP_SENDING from the peer');
		expect(noErrorRow).toContain('It reports no error.');
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
		expect(prefix(overFloor)).toEqual({ error: conditional[0].error, check: conditional[0].check });
		expect(prefix(overFloor, defaultReceiverMessageBytes * 4))
			.toEqual({ value: defaultReceiverMessageBytes + 1, bytes: overFloor.byteLength });
		// Replay everything at the lowest limit a receiver may have and at a
		// raised one: an entry not marked dependsOnReceiverLimit must answer the
		// same at both, and a marked one must answer differently at one of them.
		const { minimumReceiverMessageBytes } = root['x-webtransport'].reliableStream;
		const limits = [minimumReceiverMessageBytes, defaultReceiverMessageBytes * 4];
		const verdict = (hex, limit) => {
			const result = readStream(Buffer.from(hex, 'hex'), limit);
			return result.error ? result : { records: result.records.map((r) => [r.kind, r.payload.toString('hex')]) };
		};
		const prefixVerdict = (hex, limit) => prefix(Buffer.from(hex, 'hex'), limit);
		let conditionalCount = 0;
		for (const [list, key, judge] of [
			[streamVector.invalidPrefixes, 'hex', prefixVerdict],
			[streamVector.invalidRecords, 'recordHex', verdict],
			[streamVector.validRecords, 'recordHex', verdict]
		]) {
			for (const entry of list) {
				const atDefault = judge(entry[key], defaultReceiverMessageBytes);
				const elsewhere = limits.map((limit) => judge(entry[key], limit));
				if (entry.dependsOnReceiverLimit) {
					conditionalCount++;
					expect(elsewhere.some((other) => JSON.stringify(other) !== JSON.stringify(atDefault)), entry.reason).toBe(true);
				} else {
					for (const other of elsewhere) expect(other, entry.reason).toEqual(atDefault);
				}
			}
		}
		// One prefix, two records refused only for size, and two long close
		// reasons a floor receiver refuses for their length instead.
		expect(conditionalCount).toBe(5);
		// The transcript itself fits even the floor receiver.
		expect(Math.max(...streamVector.records.map((record) => record.length))).toBeLessThanOrEqual(minimumReceiverMessageBytes);
		// At a raised limit the size-only entries reach the kind byte: an unknown
		// kind is refused for its kind, which a reader judging kind first would
		// also answer at the floor. A close record declaring more than any close
		// payload holds is unfinished at FIN, unless the receiver refuses its
		// declared length as too long a close at once; either is conforming.
		const raised = (hex) => readStream(Buffer.from(hex, 'hex'), defaultReceiverMessageBytes * 4);
		const sizeBeforeKind = streamVector.invalidRecords.filter((entry) =>
			entry.dependsOnReceiverLimit && raised(entry.recordHex).check === 'unknown-kind');
		expect(sizeBeforeKind.length).toBeGreaterThan(0);
		for (const entry of sizeBeforeKind) expect(readStream(Buffer.from(entry.recordHex, 'hex'))).toEqual({ error: 'RECORD_TOO_LARGE', check: 'over-limit' });
		// The close record declaring more than any close payload holds: the
		// reference reader finds it unfinished, a reader using 15.4's MAY refuses
		// it at its kind byte, and both are conforming.
		const oversizeClose = streamVector.invalidRecords.filter((entry) => {
			const bytes = Buffer.from(entry.recordHex, 'hex');
			const head = prefix(bytes, defaultReceiverMessageBytes * 4);
			return entry.dependsOnReceiverLimit && head && !head.error && kindNames[bytes[head.bytes]] === 'close' &&
				head.value > bytes.length;
		});
		expect(oversizeClose.length).toBeGreaterThan(0);
		for (const entry of oversizeClose) {
			const bytes = Buffer.from(entry.recordHex, 'hex');
			expect(raised(entry.recordHex).check).toBe('fin-inside-record');
			expect(readStream(bytes, defaultReceiverMessageBytes * 4, { refuseOversizeCloseAtKind: true }).check).toBe('close-reason-length');
		}
	});

	// The two optional receiver behaviours of 15.4 change nothing a vector
	// promises at the assumed limit, except where an entry says so.
	it('holds every vector for a receiver that uses either option of 15.4', () => {
		const plain = (hex) => readStream(Buffer.from(hex, 'hex'));
		const summary = (result) => result.error ? result : result.records.map((r) => [r.kind, r.payload.toString('hex')]);
		let readOnEntries = 0;
		for (const entry of [...streamVector.invalidRecords, ...streamVector.validRecords]) {
			const atKind = readStream(Buffer.from(entry.recordHex, 'hex'), undefined, { refuseOversizeCloseAtKind: true });
			expect(summary(atKind), entry.reason).toEqual(summary(plain(entry.recordHex)));
			const stopped = readStream(Buffer.from(entry.recordHex, 'hex'), undefined, { stopAfterClose: true });
			if (entry.assumesReceiverReadsOn) {
				// A receiver that stops at the close has the close and no error, and
				// reports the code the entry gives.
				readOnEntries++;
				expect(stopped.error, entry.reason).toBeUndefined();
				const close = stopped.records.at(-1);
				expect(close.kind, entry.reason).toBe('close');
				const decoded = decodeClose(close.payload);
				expect(entry.reportsCode, entry.reason).toBe(decoded ? decoded.code : root['x-webtransport'].reliableStream.closeRecord.emptyPayloadReportsCode);
			} else {
				expect(summary(stopped), entry.reason).toEqual(summary(plain(entry.recordHex)));
			}
		}
		expect(readOnEntries).toBeGreaterThan(0);
	});

	// Structure is decided on the COMPLETE prefix. A receiver judging a partial
	// value could answer the same bytes with either code - hand-checked below.
	it('forbids deciding on a partial prefix value', () => {
		expect(flatProtocol).toContain('The LENGTH VALUE is judged only once the prefix is complete, never on a partial accumulation');
		// 1 + 64*16384 = 1048577 after three bytes, but the 4-byte encoding is
		// non-canonical (canonical is 81 80 40), so structure wins: PROTOCOL_ERROR.
		expect(prefix(Buffer.from('8180c000', 'hex'))).toEqual({ error: 'PROTOCOL_ERROR', check: 'non-canonical' });
		// Partial exceeds the floor at byte 3, yet the prefix runs past the cap.
		expect(prefix(Buffer.from('ffffffffff01', 'hex'))).toEqual({ error: 'PROTOCOL_ERROR', check: 'over-cap' });
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
		expect(prefix(overWide)).toEqual({ error: 'PROTOCOL_ERROR', check: 'over-cap' });
		// The largest limit the carriage can express - not MAX_SAFE_INTEGER, which
		// would quantify over receivers the document forbids.
		expect(prefix(overWide, 2 ** (7 * maximumLengthPrefixBytes) - 1)).toEqual({ error: 'PROTOCOL_ERROR', check: 'over-cap' });
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
		expect(flatProtocol).toContain('8192-byte ceiling is deliberately NOT a lane reset');
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
				expect(isUtf8Text(payload)).toBe(true);
				if (record.frame === undefined) {
					// Only the empty message carries no frame, and it says why it is here.
					expect(payload.byteLength).toBe(0);
					expect(record.note).toBeTypeOf('string');
					continue;
				}
				expect(JSON.parse(payload.toString('utf8'))).toEqual(record.frame);
				expect(validate(root, record.frame)).toEqual([]);
			} else if (record.kind === 'close') {
				expect(closePayloadCheck(payload)).toBeNull();
				expect(decodeClose(payload)).toEqual(record.decoded);
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
		// Where each record ends in the stream: a record is delivered in the read
		// that completes it, never later - a zero-length record included, which a
		// decoder waiting for a first body byte would hold back.
		const ends = [];
		let offset = 0;
		for (const record of streamVector.records) ends.push(offset += record.recordHex.length / 2);
		let pending = Buffer.alloc(0);
		let at = 0;
		const decoded = [];
		const boundaries = new Set();
		for (const size of streamVector.fragmentLengths) {
			pending = Buffer.concat([pending, stream.subarray(at, at + size)]);
			at += size;
			boundaries.add(at);
			for (;;) {
				const record = readRecord(pending);
				if (record === null) break;
				expect(record.error).toBeUndefined();
				decoded.push({ kind: record.kind, payloadHex: record.payload.toString('hex') });
				pending = pending.subarray(record.consumed);
			}
			expect(decoded.length, `records complete after ${at} bytes`).toBe(ends.filter((end) => end <= at).length);
		}
		expect(pending.byteLength).toBe(0);
		// kind AND payload: a decoder that discards the kind byte reproduces the
		// payloads but not the tuples, so it fails on the ambiguous pair.
		expect(decoded).toEqual(streamVector.records.map((record) => ({
			kind: record.kind,
			payloadHex: record.payloadHex
		})));
		// The splits the description promises: the first record's prefix, kind
		// and body arrive apart, a read ends one byte before that record does,
		// some read completes several records at once, one read ends on the empty
		// record's prefix and the next exactly where it ends, and one falls inside
		// the close record's code.
		const { recordKindBytes } = root['x-webtransport'].reliableStream;
		const firstPrefix = encodeVarint(streamVector.records[0].length).byteLength;
		expect(boundaries.has(firstPrefix)).toBe(true);
		expect(boundaries.has(firstPrefix + recordKindBytes)).toBe(true);
		expect(boundaries.has(ends[0] - 1)).toBe(true);
		let previous = 0;
		const perRead = [...boundaries].map((boundary) => {
			const count = ends.filter((end) => end > previous && end <= boundary).length;
			previous = boundary;
			return count;
		});
		expect(Math.max(...perRead)).toBeGreaterThanOrEqual(2);
		const emptyIndex = streamVector.records.findIndex((record) => record.length === 0);
		expect(boundaries.has(ends[emptyIndex])).toBe(true);
		expect(boundaries.has(ends[emptyIndex] - recordKindBytes)).toBe(true);
		const closeIndex = streamVector.records.findIndex((record) => record.kind === 'close');
		expect(closeIndex).toBeGreaterThan(0);
		const codeStart = ends[closeIndex - 1] + encodeVarint(streamVector.records[closeIndex].length).byteLength + recordKindBytes;
		expect(boundaries.has(codeStart + 1)).toBe(true);
		// The close follows the advisory it closes behind, on the same direction.
		const advisory = streamVector.records[closeIndex - 1];
		expect(advisory.frame?.type).toBe('reconnect');
		expect(advisory.direction).toBe(streamVector.records[closeIndex].direction);
		// ...and carries the 1001 section 3.9 pairs with the advisory.
		const closeCode = decodeClose(Buffer.from(streamVector.records[closeIndex].payloadHex, 'hex')).code;
		expect(closeCode).toBe(1001);
		const drain = protocol.slice(protocol.indexOf('### 3.9 '), protocol.indexOf('### 3.10 '));
		expect(drain).toContain(`\`${closeCode}\``);
		// Each direction, read as a finished stream, is legal: its close record,
		// if it has one, is the last thing it carries.
		for (const record of streamVector.records) expect(['c->s', 's->c']).toContain(record.direction);
		for (const direction of ['c->s', 's->c']) {
			const records = streamVector.records.filter((record) => record.direction === direction);
			expect(records.length, direction).toBeGreaterThan(0);
			const result = readStream(Buffer.from(records.map((record) => record.recordHex).join(''), 'hex'));
			expect(result.records, direction).toHaveLength(records.length);
		}
	});

	// Single-record streams for edges one transcript cannot hold: each must be
	// read as exactly the record it claims, and a close as the code it carries.
	it('accepts every valid edge record as the record it claims to be', () => {
		const { closeRecord } = root['x-webtransport'].reliableStream;
		const kinds = new Set();
		for (const vector of streamVector.validRecords) {
			const result = readStream(Buffer.from(vector.recordHex, 'hex'));
			expect(result.records, vector.reason).toHaveLength(1);
			const [record] = result.records;
			expect(record.kind, vector.reason).toBe(vector.kind);
			if (record.kind === 'close') {
				expect(decodeClose(record.payload), vector.reason).toEqual(vector.decoded);
				// What an endpoint reports for it: its code, or 1005 when it has none.
				expect(vector.reportsCode, vector.reason).toBe(
					record.payload.length ? vector.decoded.code : closeRecord.emptyPayloadReportsCode
				);
			} else {
				expect(vector.reportsCode, vector.reason).toBeUndefined();
			}
			kinds.add(record.kind + (record.payload.length === 0 ? ':empty' : ''));
		}
		// An empty message of each non-text kind (the transcript has the text one),
		// a code with no reason, and a reason at the limit in multi-byte characters.
		expect([...kinds].sort()).toEqual(['binary:empty', 'close', 'close:empty']);
		const atLimit = streamVector.validRecords.filter((vector) =>
			vector.decoded && Buffer.byteLength(vector.decoded.reason) === closeRecord.maximumReasonBytes &&
			vector.decoded.reason.length < closeRecord.maximumReasonBytes);
		expect(atLimit).toHaveLength(1);
		expect(streamVector.validRecords.some((vector) => vector.decoded?.reason === '')).toBe(true);
	});

	it('rejects non-canonical, over-limit, and over-wide prefixes with the registered errors', () => {
		for (const vector of streamVector.invalidPrefixes) {
			expect(prefix(Buffer.from(vector.hex, 'hex')), vector.reason)
				.toEqual({ error: vector.error, check: vector.check });
			expect(root['x-webtransport'].streamErrors[vector.error], vector.reason)
				.toBeTypeOf('number');
		}
		expect(new Set(streamVector.invalidPrefixes.map((vector) => vector.check)))
			.toEqual(new Set(['non-canonical', 'over-limit', 'over-cap']));
		// Zero is legal only as the one-byte canonical encoding.
		expect(streamVector.invalidPrefixes.some((vector) => vector.check === 'non-canonical' &&
			Buffer.from(vector.hex, 'hex').every((byte) => (byte & 0x7f) === 0))).toBe(true);
	});

	// An empty WebSocket message exists, so the lossless carriage must carry it:
	// zero is a complete length, and the kind byte still follows it.
	it('carries an empty message of every kind as a zero-length record', () => {
		expect(root['x-webtransport'].reliableStream.minimumMessageBytes).toBe(0);
		expect(flatProtocol).toContain('A length of zero is legal: the `kind` byte still follows');
		// No sentence of the binding may still refuse a zero length, however spelled.
		const slice = (from, to) => {
			const start = flatProtocol.indexOf(from);
			const end = flatProtocol.indexOf(to);
			expect(start, from).toBeGreaterThan(-1);
			expect(end, to).toBeGreaterThan(start);
			return flatProtocol.slice(start, end);
		};
		let zeroSentences = 0;
		for (const text of [slice('## 15. ', '## Appendix A.'), slice('### C.6 ', '## Appendix D.')]) {
			for (const sentence of text.split(/(?<=\.)\s/)) {
				if (/zero.?length|\bzero\b/i.test(sentence)) {
					zeroSentences++;
					expect(sentence).not.toMatch(/reject|refuse|PROTOCOL_ERROR|protocol error|MUST NOT accept|non-canonical\/zero/i);
				}
			}
		}
		expect(zeroSentences).toBeGreaterThan(0);
		expect(streamVector.invalidPrefixes.map((vector) => vector.hex)).not.toContain('00');
		expect(prefix(Buffer.from('00', 'hex'))).toEqual({ value: 0, bytes: 1 });
		// The prefix alone is not a record: a decoder that delivers on a zero
		// length without waiting for the kind byte loses the message type, and a
		// FIN there leaves a record unfinished.
		expect(readRecord(Buffer.from('00', 'hex'))).toBeNull();
		expect(readStream(Buffer.from('00', 'hex'))).toEqual({ error: 'PROTOCOL_ERROR', check: 'fin-inside-record' });
		for (const [kind, value] of Object.entries(root['x-webtransport'].reliableStream.recordKinds)) {
			const record = readRecord(Buffer.from([0, value]));
			expect(record, kind).toMatchObject({ kind, consumed: 2 });
			expect(record.payload.byteLength, kind).toBe(0);
			// An empty record right before FIN is a whole record, not a truncated one.
			expect(readStream(Buffer.from([0, value])).records, kind).toHaveLength(1);
		}
		expect(streamVector.records.some((record) => record.length === 0)).toBe(true);
	});

	// Structural rejections past the prefix: an unregistered kind byte, a text
	// record whose bytes are not UTF-8, a close payload no WebSocket endpoint
	// could send, and bytes after a close record. All are lane resets (15.6);
	// the offending record never reaches the application, though a close read
	// before a stray byte stands (15.4). Each entry is a whole stream that has
	// ended in FIN, read by a receiver that reads on.
	it('rejects unknown kinds, invalid text, malformed closes, and bytes after a close', () => {
		// Matching the check, not only the code: every entry is refused by the
		// rule it names, so a truncated or mis-lengthed vector cannot pass as a
		// different PROTOCOL_ERROR.
		for (const vector of streamVector.invalidRecords) {
			expect(readStream(Buffer.from(vector.recordHex, 'hex')), vector.reason)
				.toEqual({ error: vector.error, check: vector.check });
			expect(root['x-webtransport'].streamErrors[vector.error], vector.reason)
				.toBeTypeOf('number');
		}
		// The rejections cover every rule past the prefix, the size verdict a
		// kind byte must not pre-empt, and a record FIN cut short - a zero length
		// with no kind byte after it included.
		const checks = new Set(streamVector.invalidRecords.map((vector) => vector.check));
		expect(checks).toEqual(new Set([
			'unknown-kind', 'invalid-text', 'close-payload-length', 'close-code',
			'close-reason-length', 'close-reason-utf8', 'after-close', 'over-limit',
			'fin-inside-record'
		]));
		expect(streamVector.invalidRecords.some((vector) => vector.check === 'fin-inside-record' && vector.recordHex === '00')).toBe(true);
		// A record cut short is unfinished and nothing else: a text body so far
		// must still be a valid UTF-8 prefix, or a reader validating as bytes
		// arrive would refuse it as invalid text before FIN.
		let cutTextBodies = 0;
		for (const vector of streamVector.invalidRecords.filter((v) => v.check === 'fin-inside-record')) {
			const bytes = Buffer.from(vector.recordHex, 'hex');
			const head = prefix(bytes);
			if (head === null || bytes.length <= head.bytes) continue;
			if (kindNames[bytes[head.bytes]] !== 'text') continue;
			cutTextBodies++;
			const sofar = bytes.subarray(head.bytes + root['x-webtransport'].reliableStream.recordKindBytes);
			expect(() => new TextDecoder('utf-8', { fatal: true }).decode(sofar, { stream: true }), vector.reason).not.toThrow();
		}
		expect(cutTextBodies).toBeGreaterThan(0);
		// Every check a vector names is defined for third parties, and only those,
		// and each definition states the constants it rests on.
		const named = new Set([...streamVector.invalidPrefixes, ...streamVector.invalidRecords].map((vector) => vector.check));
		expect(new Set(Object.keys(streamVector.checks))).toEqual(named);
		const stream = root['x-webtransport'].reliableStream;
		for (const kind of Object.values(stream.recordKinds)) {
			expect(streamVector.checks['unknown-kind']).toContain('0x' + kind.toString(16).padStart(2, '0'));
		}
		for (const [low, high] of stream.closeRecord.allowedCodes) expect(streamVector.checks['close-code']).toContain(`${low}-${high}`);
		expect(streamVector.checks['close-reason-length']).toContain(`${stream.closeRecord.maximumReasonBytes} bytes`);
		expect(streamVector.checks['over-cap']).toContain(`${stream.maximumLengthPrefixBytes} bytes`);
		// The after-close entries hold for a receiver that reads on, and the close
		// each opens with stands: every one says so, and what it reports.
		const afterClose = streamVector.invalidRecords.filter((vector) => vector.check === 'after-close');
		expect(afterClose.length).toBeGreaterThan(0);
		expect(streamVector.invalidRecords.filter((vector) => vector.assumesReceiverReadsOn)).toEqual(afterClose);
		expect(streamVector.checks['after-close']).toContain('by a receiver that reads on');
		for (const vector of afterClose) {
			const first = readRecord(Buffer.from(vector.recordHex, 'hex'));
			expect(first.kind, vector.reason).toBe('close');
			const decoded = decodeClose(first.payload);
			expect(vector.reportsCode, vector.reason).toBe(decoded ? decoded.code : stream.closeRecord.emptyPayloadReportsCode);
		}
		// A close after the first one cannot be the one reported.
		expect(afterClose.some((vector) => {
			const result = readStream(Buffer.from(vector.recordHex, 'hex'), undefined, { stopAfterClose: true });
			const rest = Buffer.from(vector.recordHex, 'hex').subarray(result.records[0].consumed);
			const second = readRecord(rest);
			return second?.kind === 'close' && decodeClose(second.payload)?.code !== vector.reportsCode;
		})).toBe(true);
		expect(afterClose.some((vector) => vector.reportsCode === stream.closeRecord.emptyPayloadReportsCode)).toBe(true);
		// A close record refused as malformed was never read: the lane ended
		// without one, and that is what the entry reports.
		for (const vector of streamVector.invalidRecords.filter((v) => v.check.startsWith('close-'))) {
			expect(vector.reportsCode, vector.reason).toBe(stream.closeRecord.laneEndedWithoutCloseReportsCode);
		}
		// Every entry that opens with a close kind byte says what it reports.
		for (const vector of streamVector.invalidRecords) {
			const bytes = Buffer.from(vector.recordHex, 'hex');
			const head = prefix(bytes, stream.defaultReceiverMessageBytes * 4);
			if (!head || head.error || bytes.length <= head.bytes) continue;
			if (kindNames[bytes[head.bytes]] === 'close') expect(vector.reportsCode, vector.reason).toBeTypeOf('number');
		}
		// Each sendable range has a vector accepting both its edges and one
		// refusing the code just outside each edge, so an off-by-one reader fails.
		const { closeRecord, recordKinds } = root['x-webtransport'].reliableStream;
		const ranges = closeRecord.allowedCodes;
		const refusedCodes = new Set(streamVector.invalidRecords
			.filter((vector) => vector.check === 'close-code')
			.map((vector) => decodeClose(readRecordPayload(vector.recordHex)).code));
		const acceptedCodes = new Set([...streamVector.records, ...streamVector.validRecords]
			.filter((record) => record.kind === 'close' && record.decoded)
			.map((record) => record.decoded.code));
		const inRange = (code) => ranges.some(([low, high]) => code >= low && code <= high);
		for (const [low, high] of ranges) {
			for (const edge of [low, high]) expect(acceptedCodes.has(edge), `accepts ${edge}`).toBe(true);
			for (const outside of [low - 1, high + 1]) {
				if (!inRange(outside)) expect(refusedCodes.has(outside), `refuses ${outside}`).toBe(true);
			}
		}
		// A code a receiver only ever reports locally (15.4) must be refused on the wire.
		expect(refusedCodes.has(closeRecord.laneEndedWithoutCloseReportsCode)).toBe(true);
		expect(refusedCodes.has(closeRecord.emptyPayloadReportsCode)).toBe(true);
		// A reason refused for its BYTES, though its characters fit.
		expect(streamVector.invalidRecords.some((vector) => {
			if (vector.check !== 'close-reason-length') return false;
			const reason = decodeClose(readRecordPayload(vector.recordHex)).reason;
			return reason.length <= closeRecord.maximumReasonBytes;
		})).toBe(true);
		// No unknown-kind example uses a registered kind.
		const kindVectors = streamVector.invalidRecords.filter((vector) => vector.check === 'unknown-kind');
		expect(kindVectors.length).toBeGreaterThan(0);
		for (const vector of kindVectors) {
			const bytes = Buffer.from(vector.recordHex, 'hex');
			expect(Object.values(recordKinds), vector.reason).not.toContain(bytes[prefix(bytes).bytes]);
		}
	});

	// Sections 3.7 and 3.9 give close codes meanings a client acts on, so the
	// carriage has to carry them, and only codes a WebSocket close could carry.
	it('carries a close code with the meaning the WebSocket carriage gives it', async () => {
		const { closeRecord, recordKinds } = root['x-webtransport'].reliableStream;
		// Bound to the runtime's own close rule rather than restated, so the two
		// carriages can never disagree about which codes exist.
		const { isSendableCloseCode, MAX_CLOSE_REASON_BYTES } = await import('../src/runtime/utils/close-frame.js');
		const allowed = (code) => closeRecord.allowedCodes.some(([low, high]) => code >= low && code <= high);
		const disagreements = [];
		for (let code = 0; code <= 0xffff; code++) {
			if (allowed(code) !== isSendableCloseCode(code)) disagreements.push(code);
		}
		expect(disagreements).toEqual([]);
		expect(closeRecord.maximumReasonBytes).toBe(MAX_CLOSE_REASON_BYTES);

		const ranges = closeRecord.allowedCodes.map(([low, high]) => `${low}-${high}`);
		expect(flatProtocol).toContain(
			`The code is one of ${ranges.slice(0, -1).join(', ')}, or ${ranges.at(-1)}, the set a WebSocket endpoint may put in a close frame today`
		);
		expect(flatProtocol).toContain(`a ${closeRecord.codeBytes}-byte big-endian status code followed by a UTF-8 reason of at most **${closeRecord.maximumReasonBytes} bytes**`);

		// Every code the frozen sections give a meaning is one the record can
		// carry, and 15.4 names it. The whole frozen body is scanned, so a close
		// code given a meaning anywhere before the WebTransport bindings is seen.
		const frozenEnd = protocol.indexOf('\n## 14. ');
		expect(frozenEnd).toBeGreaterThan(protocol.indexOf('\n## 13. '));
		const meaningful = new Set();
		for (const match of protocol.slice(0, frozenEnd).matchAll(/`(\d{4})`/g)) meaningful.add(Number(match[1]));
		expect([...meaningful].sort((a, b) => a - b)).toEqual([1001, 1008, 4401, 4429]);
		// A code written without backticks in a sentence about closing is caught
		// too: every such number must be one of the codes found above.
		const frozenFlat = flatProtocol.slice(0, flatProtocol.indexOf('## 14. '));
		let numbersSeen = 0;
		for (const sentence of frozenFlat.split(/(?<=\.)\s/)) {
			if (!/\bclos/i.test(sentence)) continue;
			for (const match of sentence.matchAll(/\b([1-4]\d{3})\b/g)) {
				numbersSeen++;
				expect(meaningful.has(Number(match[1])), `${match[1]} in: ${sentence.slice(0, 120)}`).toBe(true);
			}
		}
		expect(numbersSeen).toBeGreaterThanOrEqual(meaningful.size);
		// The adapter's own close rule cuts a long reason the same way: whole code
		// points only, never inside one.
		const { closeFrameReason } = await import('../src/runtime/utils/close-frame.js');
		// 62 two-byte characters are 124 bytes; a cut at byte 123 would split the
		// last one, so the rule keeps 61 of them.
		const longReason = 'é'.repeat(62);
		const clamped = Buffer.from(closeFrameReason(1000, longReason));
		expect(clamped.equals(Buffer.from(longReason).subarray(0, closeRecord.maximumReasonBytes - 1))).toBe(true);
		expect(isUtf8Text(clamped)).toBe(true);
		const closure = flatProtocol.slice(flatProtocol.indexOf('### 15.4'), flatProtocol.indexOf('### 15.5'));
		for (const code of meaningful) {
			expect(allowed(code), String(code)).toBe(true);
			expect(closure, String(code)).toContain(`\`${code}\``);
		}
		// Every WebSocket close frame, a codeless one included, becomes a close
		// record, and a reason is shortened the way WebSocket shortens it.
		expect(closure).toContain('Wherever an endpoint would send a WebSocket close frame - empty, or carrying');
		expect(closure).toContain('it MUST instead write a close record carrying that payload as the last record on its direction, then FIN, cutting a longer reason to the longest run of whole UTF-8 code points that fits in 123 bytes');
		expect(closure).toContain('the receiver acts on the code exactly as it would on WebSocket');
		expect(closure).toContain('this revision fixes that set, so a code outside it, including one registered later, is refused here');
		// A record-layer error is a reset, never a close record with 1002/1007/1009.
		expect(closure).toContain('An error in the records themselves is not such a close: it resets the lane (15.6)');
		expect(closure).toContain('and so is any byte its sender writes on that direction after a close record - a verdict reached on arrival, before any prefix is judged');
		expect(closure).toContain('one that reads on and finds such a byte MUST reset with `PROTOCOL_ERROR`, and the close it already read stands');
		expect(closure).toContain('A receiver MAY refuse a close record that declares more than 125 bytes as soon as it has read its `kind` byte');
		// What each side reports, bound to the schema's report codes: the first
		// well-formed close record read, 1005 if empty, else 1006.
		expect(closure).toContain(`What an endpoint reports is RFC 6455's close code: the code of the first well-formed close record it read, or \`${closeRecord.emptyPayloadReportsCode}\` for an empty one, and \`${closeRecord.laneEndedWithoutCloseReportsCode}\` when it read none`);
		expect(closure).toContain('Because a close record is answered with one, each side normally reports the code the other sent, as on WebSocket, and a client and a server report the same way');
		expect(closure).toContain(`A browser that unloads a page ends its session without one, so the server reports \`${closeRecord.laneEndedWithoutCloseReportsCode}\` where WebSocket would report \`1001\``);
		expect(closure).toContain('A close record refused as malformed is not read');
		// A server refusing a lane before admitting it closes instead of welcoming.
		expect(closeRecord.mayReplaceFirstServerFrame).toBe(true);
		expect(flatProtocol).toContain('unless the server closes the lane before admitting it: then its first and only record is a close record (15.4). A close record is carriage, not one of the frames whose order section 11 promises');
		// The receiver limit always admits the largest legal close record.
		const { minimumReceiverMessageBytes } = root['x-webtransport'].reliableStream;
		expect(minimumReceiverMessageBytes).toBe(closeRecord.codeBytes + closeRecord.maximumReasonBytes);
		expect(flatProtocol).toContain(`except that it is never below ${minimumReceiverMessageBytes} bytes, so that every legal close record (15.4) fits`);
		expect(flatProtocol).toContain(`a configured limit under ${minimumReceiverMessageBytes} bytes is the one case in which the stream accepts what the WebSocket refuses`);

		// The payload edges: empty is a close without a code, one byte is not a
		// code, and the reason stops at the WebSocket limit.
		const closeOf = (code, reasonBytes) => {
			const body = Buffer.alloc(closeRecord.codeBytes + reasonBytes, 0x61);
			body.writeUIntBE(code, 0, closeRecord.codeBytes);
			return Buffer.concat([encodeVarint(body.byteLength), Buffer.from([recordKinds.close]), body]);
		};
		expect(readRecord(Buffer.from([0, recordKinds.close]))).toMatchObject({ kind: 'close', consumed: 2 });
		expect(readRecord(Buffer.from([1, recordKinds.close, 0x03]))).toEqual({ error: closeRecord.malformedError, check: 'close-payload-length' });
		expect(readRecord(closeOf(4999, closeRecord.maximumReasonBytes))).toMatchObject({ kind: 'close' });
		expect(readRecord(closeOf(4999, closeRecord.maximumReasonBytes + 1))).toEqual({ error: closeRecord.malformedError, check: 'close-reason-length' });
		expect(readRecord(closeOf(5000, 0))).toEqual({ error: closeRecord.malformedError, check: 'close-code' });
		expect(readRecord(closeOf(999, 0))).toEqual({ error: closeRecord.malformedError, check: 'close-code' });
	});

	it('closes a lane in record order, and closes a direction without an error when the lane is already closing', () => {
		const closure = flatProtocol.slice(flatProtocol.indexOf('### 15.4'), flatProtocol.indexOf('### 15.5'));
		// The closing handshake: the peer ends its direction, never mid-record,
		// and the closer keeps the session long enough for the close to land.
		expect(closure).toContain('An endpoint that reads the peer\'s close record and has not written its own MUST write one in reply, normally echoing the code it read, and FIN within a bounded time');
		expect(closure).toContain('A close record, a FIN, or a reset in either direction closes the whole logical reliable lane');
		expect(closure).toContain('Closing the lane does **not** close the surrounding WebTransport session or its datagram membership');
		expect(closure).toContain('discards stream data still in flight, a close record included');
		expect(closure).toContain('carry no meaning in this binding: only a close record carries a close code');
		expect(closure).toContain('MAY first finish writing complete records it had already queued');
		expect(closure).toContain('it MUST NOT FIN inside a record');
		expect(closure).toContain('resets with `NO_ERROR` when it cannot finish one in time');
		expect(closure).toContain('and MAY stop reading it with `NO_ERROR` (appendix C.6)');
		expect(closure).toContain('Once an endpoint has written its own close record or ended its own direction, or read the peer\'s close record, FIN, or reset, it MUST NOT act on any further text or binary record it reads: it neither delivers one to the application nor processes it as a control, relay, ingress, or plugin frame; a close record it reads still decides what it reports');
		// The report cannot depend on how far a receiver parses past a refusal.
		expect(closure).toContain('An endpoint reads no record on a receiving direction past one it refused with a lane error (15.6), or after it has ended that direction; a close record there is not read');
		const behindRefusal = streamVector.invalidRecords.filter((vector) => {
			const first = readRecord(Buffer.from(vector.recordHex, 'hex'));
			return first?.error && vector.reportsCode !== undefined && vector.check !== 'after-close' && !vector.check.startsWith('close-') && vector.check !== 'over-limit';
		});
		expect(behindRefusal.length).toBeGreaterThan(0);
		for (const vector of behindRefusal) expect(vector.reportsCode, vector.reason).toBe(root['x-webtransport'].reliableStream.closeRecord.laneEndedWithoutCloseReportsCode);
		expect(closure).toContain('An endpoint that has written its own close record keeps reading the lane until it has read the peer\'s close record, FIN, or RESET_STREAM, or its bounded wait runs out, and until then sends STOP_SENDING only for a lane error');
		expect(closure).toContain('Unless it has received the peer\'s STOP_SENDING, which it answers per 15.6');
		expect(closure).toContain('A sending direction has ended once the endpoint has asked its stack to send its FIN or RESET_STREAM; a receiving direction has ended once the endpoint has read its FIN, received its RESET_STREAM, or asked its stack to send STOP_SENDING for it');
		expect(closure).toContain('An endpoint that has ended its own direction SHOULD therefore keep the session open until it has read the peer\'s FIN or received its RESET_STREAM, or a bounded wait has run out');
		expect(closure).toContain('write a close record (`1001` when the server is going away, as on WebSocket), send FIN');
		expect(protocol).not.toContain('both endpoints stop writing it');
		// Which frame carries a found error, and what NO_ERROR means.
		const { streamErrors } = root['x-webtransport'];
		expect(streamErrors.NO_ERROR).toBe(0);
		expect(flatProtocol).toContain('An endpoint that finds a lane error MUST close both directions with its code, except a direction that has already ended (15.4): RESET_STREAM on the direction it sends and STOP_SENDING on the one it receives');
		expect(flatProtocol).toContain('It MUST NOT reset a direction it finished with FIN except in answer to the peer\'s STOP_SENDING');
		expect(flatProtocol).toContain('An endpoint answering the peer\'s STOP_SENDING SHOULD copy its code into its own RESET_STREAM, as QUIC recommends; one that has already reset that direction sends nothing more. A code alone therefore does not say which side found the error');
		expect(flatProtocol).toContain('answering the peer\'s RESET_STREAM before it has received any STOP_SENDING from the peer');
		expect(flatProtocol).toContain('the code the W3C WebTransport API sends when an application aborts a stream without one');
		expect(flatProtocol).toContain('A reset carries no close code, whatever its code: what an endpoint reports is still decided by 15.4, and an unlisted code means no more than that');
		// Only record-layer checks reset; an inner message is handled as on WebSocket.
		expect(flatProtocol).toContain('Of the checks on received bytes, only these record-layer checks reset the lane: a well-formed record whose inner message is malformed is handled exactly as the same message would be on WebSocket - dropped, denied, passed through, or closed with a close record (15.4)');
		expect(protocol).not.toContain('an invalid registered binary shape');
		// The check order starts with the after-close verdict, or 15.6 and 15.4
		// would answer the same bytes with two codes.
		expect(flatProtocol).toContain('ordered: a byte after a close record on its direction is refused before anything else (15.4); otherwise the prefix is decided first and COMPLETE');
	});

	// Neither emitting nor dropping is open to a sender whose message is over
	// the bound it may emit; it has to say so, with the receiver's own code, and
	// recovery must not bring the same message back.
	it('refuses its own over-bound message with the receiver code, and never replays it', () => {
		const { senderOverBoundError } = root['x-webtransport'].reliableStream;
		expect(senderOverBoundError).toBe('RECORD_TOO_LARGE');
		expect(flatProtocol).toContain('MUST NOT emit it, drop it, or split it across records');
		expect(flatProtocol).toContain(`so it MUST reset the reliable lane with \`${senderOverBoundError}\` instead`);
		expect(flatProtocol).toContain('a sender holding a message larger than it may emit resets its lane with the same code (15.1)');
		// Recovery answers with section 8.1's truncation - a signal every client
		// already handles - and 15.3 and 15.5 name the exception they now carry.
		expect(flatProtocol).toContain('Recovery over this carriage - section 7\'s resume by either mechanism, and section 8\'s `replay` - MUST NOT replay such a message and MUST NOT gap-fill past it: the server MUST answer that topic\'s recovery with section 8.1\'s truncation, at or before that message');
		expect(flatProtocol).toContain('On this carriage truncation therefore also covers history the server holds but cannot carry; 8.1\'s client action is unchanged');
		expect(flatProtocol).toContain('except where this section says otherwise - 15.1\'s rules on a message larger than its sender may emit among them: recovery never replays one, and a relayed `game` event too large for the lane is not delivered live');
		expect(flatProtocol).toContain('only the gap-fill differs, by 15.1\'s rule for a message larger than its sender may emit');
		// A relayed game event too large for the lane is loss, as the datagram
		// carriage of the same lane already treats it - never a reset, and never a
		// frozen denial reason a WebSocket sender would see.
		expect(flatProtocol).toContain('the server MUST NOT deliver a relayed event whose fan-out to a stream subscriber is larger than it may emit, and MUST NOT reset that subscriber\'s lane for it, as section 14.3 handles an over-size datagram');
		expect(flatProtocol).toContain('The room `seq` advances regardless, so the gap is visible. Recovery of such an event follows the truncation rule above');
		expect(flatProtocol).toContain('An envelope that exceeds the session\'s maximum datagram size is not delivered to that session');
		const binding = flatProtocol.slice(flatProtocol.indexOf('## 15. '), flatProtocol.indexOf('## Appendix A.'));
		expect(binding).not.toContain('game-denied');
	});

	it('counts a byte until it is sent, and bounds records and unacknowledged bytes', () => {
		const { minimumPendingRecords, minimumPendingBytes } = root['x-webtransport'].reliableStream;
		expect(flatProtocol).toContain('A byte counts until the transport has sent it, whether or not the peer has acknowledged it');
		expect(flatProtocol).toContain(
			`an endpoint MAY also bound the number of pending records per session; that bound MUST be at least **${minimumPendingRecords.toLocaleString('en-US')} records**`
		);
		// The count floor is the byte floor over 16, as appendix D says.
		expect(minimumPendingRecords).toBe(minimumPendingBytes / 16);
		expect(flatProtocol).toContain(`Its floor of ${minimumPendingRecords.toLocaleString('en-US')} is the byte floor divided by 16`);
		expect(flatProtocol).toContain('A close record (15.4) counts against neither bound');
		expect(flatProtocol).toContain('If adding the next complete record would cross either bound, it MUST reset the reliable lane with `SLOW_CONSUMER`');
		expect(flatProtocol).toContain('While the lane is open it MUST NOT drop that record or any queued record, skip a `seq`, or spill into a second stream; section 6.4\'s drop under backpressure does not apply on this carriage');
		expect(flatProtocol).toContain('a byte a stack holds only because the peer\'s flow control has not admitted it is still pending, and a byte in flight is not');
		expect(flatProtocol).toContain('counts a byte until the write carrying it settles (the W3C WebTransport API\'s `write()` promise), accepting that such a stack may settle a write flow control still holds');
		expect(flatProtocol).toContain('a stack whose write settles only on acknowledgement reports only acknowledgement');
		const { minimumAcknowledgementOnlyPendingBytes } = root['x-webtransport'].reliableStream;
		expect(minimumAcknowledgementOnlyPendingBytes).toBe(minimumPendingBytes + root['x-webtransport'].reliableStream.minimumServerUnacknowledgedBytes);
		expect(flatProtocol).toContain(`counts unsent and unacknowledged bytes together against one bound of at least the unsent-byte floor plus 1,048,576 bytes - **${minimumAcknowledgementOnlyPendingBytes.toLocaleString('en-US')} bytes** unless out-of-band knowledge raised that floor`);
		// The floor is one maximum-size record in flight whole.
		const { minimumServerUnacknowledgedBytes, maximumSenderMessageBytes } = root['x-webtransport'].reliableStream;
		expect(minimumServerUnacknowledgedBytes).toBe(maximumSenderMessageBytes);
		expect(minimumPendingBytes).toBe(maximumSenderMessageBytes);
		expect(flatProtocol).toContain(
			`A server MUST bound them, at no less than **${minimumServerUnacknowledgedBytes.toLocaleString('en-US')} bytes** so a maximum-size record can be in flight whole, and a client SHOULD`
		);
		expect(flatProtocol).toContain('At that bound the endpoint MUST stop sending');
		// An empty message is a message to every per-message limit; a close is not.
		expect(flatProtocol).toContain('An empty text or binary record is a message to section 3.11\'s admission and to every other per-message limit, exactly as an empty WebSocket message is; a close record is not a message');
	});

	it('takes the first stream after the response as the lane, and lets a server refuse an early one', () => {
		expect(flatProtocol).toContain('The reliable lane is the first client-initiated bidirectional stream of the session that the server\'s WebTransport stack hands it, unless the server refuses that stream as early (below)');
		expect(flatProtocol).toContain('The client MUST NOT open the stream before the response');
		expect(flatProtocol).toContain('MAY refuse that stream the same way; the session then has no lane, and every later stream is refused with `STREAM_LIMIT`');
		expect(flatProtocol).toContain('A stack that buffers early streams and hands them over afterwards gives the server nothing to judge');
	});

	// The rest of the binding's rules, pinned so none can be dropped unseen.
	it('keeps the remaining framing rules and registry rows in place', () => {
		expect(flatProtocol).toContain('Ping and pong have no kind, because QUIC liveness replaces them (15.4)');
		expect(flatProtocol).toContain('a receiver MUST NOT hold a complete record back waiting for bytes after it');
		expect(flatProtocol).toContain('so a `reconnect` advisory is never overtaken by its close, which a reset could not promise');
		expect(flatProtocol).toContain('An endpoint that reads the peer\'s FIN or receives its RESET_STREAM likewise ends its own direction within a bounded time');
		expect(flatProtocol).toContain('The sum is over the unsent message bytes of each queued record');
		expect(flatProtocol).toContain('so with both bounds at their floors it binds first only on records averaging under 16 bytes');
		expect(flatProtocol).toContain('what each side reports depends only on which close records reach it before its wait ends');
		expect(flatProtocol).toContain('a close record\'s `messageBytes` are the close frame\'s payload, read by 15.4 and never handed to demux');
		expect(flatProtocol).toContain('**Close is a record, not a reset code.**');
		expect(protocol).toContain('| close record (`kind` `0x02`; the WebSocket close frame\'s payload) | both | 15.4 |');
	});
});

// Two errata against frozen demux text, pinned so the clarifications cannot
// silently regress to the ambiguous wording they replaced. Both document
// shipped behaviour: the game fan-out allocates through the per-connection
// wire-id counter (never the shared-cohort acquire), and the runtime delivers
// unknown-leading-byte client binary to the application untouched.
describe('frozen demux errata', () => {
	it('pins the fan-out id range narrowing and its decoder invisibility', () => {
		expect(flatProtocol).toContain('Per-connection is exact, not shorthand');
		expect(flatProtocol).toContain('never announces a shared-cohort id for its frames');
		// The narrowing must not leak into what a decoder is told to accept: the
		// resolution stays the recorded `wire-id` mappings, range-uninspected.
		expect(flatProtocol).toContain('resolves any `topicId` through the `wire-id` mappings it has recorded (6.2) without inspecting the range');
	});

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

// Every protocol `error` code the runtime can put on the wire must be declared
// in PROTOCOL.md - both in section 3.7's prose and in the C.4 registry.
//
// This exists because a code shipped without either. Section 3.7 went on
// saying "Revision 1 defines one code" while the runtime emitted a second one,
// so a third-party client implementer reading the spec had no way to learn it
// existed - and the client-side rule for an unknown code is to IGNORE it,
// which means the refusal would have been silently dropped by exactly the
// hand-rolled clients it was written for. The codes are discovered from the
// source rather than listed here, so a new one cannot be added without either
// registering it or failing this.
describe('protocol error code registry', () => {
	const EMITTERS = ['src/runtime/utils/subscribe-policy.js', 'src/runtime/wire.js'];

	function emittedCodes() {
		const codes = new Set();
		for (const rel of EMITTERS) {
			const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
			for (const match of source.matchAll(/"type":"error","code":"([A-Z_]+)"/g)) codes.add(match[1]);
		}
		return codes;
	}

	it('finds the emitters it claims to scan', () => {
		// A scan that silently matched nothing would pass every assertion below
		// while checking nothing at all.
		const codes = emittedCodes();
		expect(codes.size, 'no error codes found - the emitter list or the frame shape moved').toBeGreaterThanOrEqual(2);
		expect([...codes]).toContain('CONTROL_FRAME_TOO_LARGE');
	});

	it('declares every emitted code in section 3.7 and the C.4 registry', () => {
		const registry = protocol.slice(protocol.indexOf('### C.4 Protocol `error` code registry'));
		expect(registry.length, 'the C.4 registry heading moved').toBeGreaterThan(0);
		for (const code of emittedCodes()) {
			expect(protocol, `${code} is emitted but not described in PROTOCOL.md`).toContain(`\`${code}\``);
			expect(registry, `${code} is emitted but missing from the C.4 registry`).toContain(`| \`${code}\` |`);
		}
	});

	it('does not register a code nothing emits', () => {
		// The reverse drift: a code removed from the runtime but left in the
		// spec tells an implementer to handle a frame that can never arrive.
		const registry = protocol.slice(protocol.indexOf('### C.4 Protocol `error` code registry'));
		const table = registry.slice(0, registry.indexOf('### C.5'));
		const declared = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
		expect(declared.length, 'the C.4 table shape moved').toBeGreaterThanOrEqual(2);
		const emitted = emittedCodes();
		for (const code of declared) {
			expect(emitted.has(code), `${code} is registered in C.4 but nothing emits it`).toBe(true);
		}
	});
});
