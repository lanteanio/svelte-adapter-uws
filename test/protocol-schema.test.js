import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The shared gate, not a local try/import: the published spec says these
// artifacts are validated in CI against the reference implementation, and a
// skipped suite reports PASSED with zero assertions. Taking the helper's flag
// is what makes REQUIRE_UWS / CI turn a missing addon into a failure here too.
import { hasUWS } from './helpers/real-runtime.js';
import { decodeValue } from '../src/runtime/wire-value.js';

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
// The whole of a list item, collapsed: a pin of every sentence in it also
// catches a sentence added anywhere in it.
function bulletAt(opening) {
	const lines = protocol.split('\n');
	const start = lines.findIndex((l) => l.startsWith(opening));
	let end = start + 1;
	// The item runs to the next item or heading, or to a blank line that no
	// indented line follows: a Markdown lazy continuation line (unindented text
	// right after the item's text) is still the item's paragraph.
	while (end < lines.length) {
		const line = lines[end];
		if (line.trim() === '') {
			if ((lines[end + 1] ?? '').startsWith('  ')) { end++; continue; }
			break;
		}
		if (/^(- |#|```)/.test(line)) break;
		end++;
	}
	return lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
}
// A whole paragraph, collapsed, found by its opening: a pin of every sentence
// in it also catches a sentence added between two pinned ones.
function paragraphAt(opening) {
	const paragraph = flatProtocol.split('\n\n').find((p) => p.startsWith(opening));
	if (paragraph === undefined) throw new Error('no paragraph starts with ' + opening);
	return paragraph;
}
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
		expect(flatProtocol).toContain(`Except in the two cases below, a sender holding a message larger than it may emit MUST NOT emit it, drop it, or split it across records - a drop loses a reliable message without a word, and a split hands the receiver messages nobody sent - so it MUST reset the reliable lane with \`${senderOverBoundError}\` instead.`);
		expect(flatProtocol).toContain(`so it MUST reset the reliable lane with \`${senderOverBoundError}\` instead. The first exception is recovery.`);
		// Which events share a batch is the server's own choice, so a batch
		// never has to be the over-bound record: an event too large to share
		// one goes out bare.
		expect(flatProtocol).toContain('A `batch` record (section 3.3) is one message on the wire, but which events share one is the server\'s own choice, so a server MUST NOT form one larger than it may emit: an event larger than the sender may emit goes out as a bare data-event in its place and is judged as above, so no event queued after it goes out in an earlier record.');
		expect(flatProtocol).toContain('a sender holding a message larger than it may emit resets its lane with the same code (15.1)');
		// Recovery answers with section 8.1's truncation - a signal every client
		// already handles - and 15.3, 15.5 and the schema name the exceptions
		// they carry.
		expect(flatProtocol).toContain('Recovery over this carriage - section 7\'s resume by either mechanism, and section 8\'s `replay` - MUST NOT replay such a message and MUST NOT gap-fill past it: the server MUST answer that topic\'s recovery with section 8.1\'s truncation instead, placed as the next bullet says, so the client re-snapshots instead of replaying a message the sender cannot emit; only a gap-fill for which the next bullet leaves no place to put a truncation resets the lane instead.');
		expect(flatProtocol).toContain('On this carriage truncation therefore also covers history the server holds but cannot carry; 8.1\'s client action applies as written.');
		expect(flatProtocol).toContain('While a recovery window for a topic is open (next bullet), that answer also covers a live sequenced frame for the topic, which the wire cannot tell from the gap-fill.');
		expect(flatProtocol).toContain('A `game.fanout:1` record left undelivered this way is a dropped frame for section 6.7.');
		expect(flatProtocol).toContain('except where this section says otherwise - 15.1\'s rules on a message larger than its sender may emit among them: recovery never replays one, the sequenced frames for a topic with an open recovery window are withheld from the first over-bound one until no window for it remains open, and a relayed `game` event too large for the lane is otherwise not delivered live.');
		expect(flatProtocol).toContain('only the gap-fill, and what the server writes for a topic while a recovery window for it is open, differ, by 15.1\'s rule for a message larger than its sender may emit.');
		expect(flatProtocol).toContain('a signalled `RECORD_TOO_LARGE` here (15.1\'s two exceptions aside)');
		expect(root.description).toContain('rather than emitting, dropping, or splitting it, except that a recovery answers with truncation and withholds a topic\'s sequenced frames from the first over-bound one while a recovery window for it is open (PROTOCOL.md 15.1), and a live relayed game event outside a recovery window for its room is not delivered');
		expect(flatProtocol).toContain('15.1\'s truncation signals the gaps that withheld frames and cut messages leave, the room `seq` shows the gap an undelivered `game` event leaves, and a withheld or undelivered `0x03` record degrades a capability or a room only as 15.1 says.');
		expect(flatProtocol).toContain('`truncated:true` means the history from the requested point could not be delivered whole: the buffer was trimmed past it (the in-memory backend inlines truncation here), or on section 15\'s stream a message was too large to carry. |');
		// A relayed game event too large for the lane is loss, as the datagram
		// carriage of the same lane already treats it - never a reset, and never a
		// frozen denial reason a WebSocket sender would see.
		expect(flatProtocol).toContain('The second exception is live delivery on the relayed `game` lane (section 3.10) while no recovery window for its room is open, because its WebTransport carriage already treats an over-size event as loss: the server MUST NOT deliver a relayed event whose fan-out to a stream subscriber is larger than it may emit, and MUST NOT reset that subscriber\'s lane for it, as section 14.3 handles an over-size datagram.');
		// What 15.1 withholds or does not deliver is never queued, so 15.6's
		// no-drop rule and 15.1 agree.
		expect(flatProtocol).toContain('This binding leaves out a message the server would otherwise write only where 15.1 withholds it (a `batch` record that would have carried only withheld events included), cuts it from a `__replay:{topic}` recovery, drops the `end` of a cut gap-fill whose standalone `truncated` came first, or does not deliver it, and such a message never enters the send queue');
		expect(flatProtocol).toContain('resets its lane with the same code (15.1), as does a server whose recovery hold outlasts its bound (15.1).');
		expect(flatProtocol).toContain('the server MUST NOT deliver a relayed event whose fan-out to a stream subscriber is larger than it may emit, and MUST NOT reset that subscriber\'s lane for it, as section 14.3 handles an over-size datagram');
		expect(flatProtocol).toContain('The room `seq` advances regardless, so the gap is visible. Recovery of such an event follows the truncation rule above');
		expect(flatProtocol).toContain('An envelope that exceeds the session\'s maximum datagram size is not delivered to that session');
		// Every sentence of the bullet that states the sender rule and its two exceptions.
		expect(bulletAt('- **A sender MUST NOT emit a record whose'), '15.1 sender bullet').toBe([
			'- **A sender MUST NOT emit a record whose `messageBytes` exceed 1,048,576 bytes**, unless it knows out of band that its peer accepts more.',
			'Nothing on this carriage negotiates a size, so this bound is fixed and every sender can evaluate it against the record in hand.',
			'Except in the two cases below, a sender holding a message larger than it may emit MUST NOT emit it, drop it, or split it across records - a drop loses a reliable message without a word, and a split hands the receiver messages nobody sent - so it MUST reset the reliable lane with `RECORD_TOO_LARGE` instead.',
			'The first exception is recovery.',
			'Recovery over this carriage - section 7\'s resume by either mechanism, and section 8\'s `replay` - MUST NOT replay such a message and MUST NOT gap-fill past it: the server MUST answer that topic\'s recovery with section 8.1\'s truncation instead, placed as the next bullet says, so the client re-snapshots instead of replaying a message the sender cannot emit; only a gap-fill for which the next bullet leaves no place to put a truncation resets the lane instead.',
			'While a recovery window for a topic is open (next bullet), that answer also covers a live sequenced frame for the topic, which the wire cannot tell from the gap-fill.',
			'On this carriage truncation therefore also covers history the server holds but cannot carry; 8.1\'s client action applies as written.',
			'The second exception is live delivery on the relayed `game` lane (section 3.10) while no recovery window for its room is open, because its WebTransport carriage already treats an over-size event as loss: the server MUST NOT deliver a relayed event whose fan-out to a stream subscriber is larger than it may emit, and MUST NOT reset that subscriber\'s lane for it, as section 14.3 handles an over-size datagram.',
			'A `game.fanout:1` record left undelivered this way is a dropped frame for section 6.7.',
			'The room `seq` advances regardless, so the gap is visible.',
			'Recovery of such an event follows the truncation rule above.',
			'A `batch` record (section 3.3) is one message on the wire, but which events share one is the server\'s own choice, so a server MUST NOT form one larger than it may emit: an event larger than the sender may emit goes out as a bare data-event in its place and is judged as above, so no event queued after it goes out in an earlier record.'
		].join(' '));
		const binding = flatProtocol.slice(flatProtocol.indexOf('## 15. '), flatProtocol.indexOf('## Appendix A.'));
		expect(binding).not.toContain('game-denied');
	});

	// Section 15.1's placement of a recovery's truncation, as a model of the
	// spec text: every case's `written` sequence has to equal what it produces.
	const replayPrefix = '__replay:';
	const truncatedEvent = (topic) => ({ kind: 'text', frame: { topic: replayPrefix + topic, event: 'truncated', data: null } });
	/** The first `count` varints after a 0x03 record's demux and schema bytes (section 6.1). */
	function binaryVarints(m, count) {
		return binaryHeader(m, count).values;
	}
	function binaryHeader(m, count) {
		const bytes = Buffer.from(m.hex ?? m.headHex, 'hex');
		const values = [];
		let i = 2;
		while (values.length < count) {
			let value = 0;
			for (let scale = 1; ; i++, scale *= 128) {
				if (i >= bytes.length) throw new Error('a varint runs past the end of the record');
				value += (bytes[i] & 0x7f) * scale;
				if ((bytes[i] & 0x80) === 0) { i++; break; }
			}
			values.push(value);
		}
		return { values, payload: bytes.subarray(i) };
	}
	function carryRecovery(transcript, bound) {
		// Per topic, the requests whose recovery window for it is open, by
		// their index in the transcript.
		const windows = new Map();
		const held = new Set();
		const cutReplays = new Set();
		// Cut gap-fills already signalled by a standalone event at their own
		// request's answer; they write no `end` after it.
		const signalledReplays = new Set();
		// A recovery on __replay:T is keyed by the request it fills when it is a
		// resume's own gap-fill, with or without a reqId, and otherwise by its reqId.
		const recoveryKey = (entry) => entry.frame.topic + '\0' + (entry.fills !== undefined ? '#' + entry.fills : entry.frame.data?.reqId);
		const boundIds = new Map();
		// A dropped stateful record degrades its capability (6.4); a dropped
		// game.fanout:1 record sends its room back to JSON (6.7).
		let statefulDegraded = false;
		const fanoutJson = new Set();
		const dropRecord = (entry, topic) => {
			if (entry.capability === 'stateful') statefulDegraded = true;
			if (entry.capability === 'game.fanout:1') fanoutJson.add(topic);
		};
		const written = [];
		const resetLane = () => ({ written, resets: root['x-webtransport'].reliableStream.senderOverBoundError, open: 0 });
		const closeWindow = (topic, request) => {
			const open = windows.get(topic) ?? [];
			const i = open.indexOf(request);
			if (i === -1) return;
			open.splice(i, 1);
			// Every answer that closes a window during a hold gets the event, and
			// so does this request's own gap-fill on __replay:T if it was cut and
			// has not ended; one event serves both.
			const own = replayPrefix + topic + '\0#' + request;
			const unended = cutReplays.has(own) && !signalledReplays.has(own);
			if (held.has(topic) || unended) written.push(truncatedEvent(topic));
			if (unended) signalledReplays.add(own);
			// The hold ends with the last window.
			if (open.length === 0) held.delete(topic);
		};
		for (let index = 0; index < transcript.length; index++) {
			const entry = transcript[index];
			if (entry.client) {
				for (const topic of entry.recovers) windows.set(topic, [...(windows.get(topic) ?? []), index]);
				continue;
			}
			if (entry.holdExpires !== undefined) {
				if (held.has(entry.holdExpires)) return resetLane();
				continue;
			}
			const f = entry.frame;
			const size = entry.length ?? (entry.kind === 'binary' ? entry.hex.length / 2 : Buffer.byteLength(JSON.stringify(f)));
			const over = size > bound;
			if (f?.type === 'wire-id') {
				boundIds.set(f.id, f.topic);
				// A stateful capability back on JSON never allocates an id (6.2, 6.4). A
				// room sent back to JSON keeps the one binding 6.2 gave it.
				if (entry.capability === 'stateful' && statefulDegraded) continue;
			}
			// An answer closes its own request's window: for its topic, or for
			// every topic a resume frame recovers. A refusal opened none.
			if (entry.answers !== undefined && f.type !== 'error') {
				for (const topic of f.type === 'resumed' ? [...windows.keys()] : [f.topic]) closeWindow(topic, entry.answers);
			}
			if (typeof f?.topic === 'string' && f.topic.startsWith(replayPrefix)) {
				const recovery = recoveryKey(entry);
				if (f.event === 'msg' && (cutReplays.has(recovery) || over)) { cutReplays.add(recovery); continue; }
				if (f.event === 'end' && cutReplays.delete(recovery)) {
					const signalled = signalledReplays.delete(recovery);
					if (!signalled) written.push({ ...entry, frame: { ...f, data: { ...f.data, truncated: true } } });
					continue;
				}
				written.push(entry);
				continue;
			}
			if (f?.type === 'batch') {
				const kept = f.events.filter((e) => !(held.has(e.topic) && typeof e.seq === 'number'));
				if (kept.length === f.events.length) written.push(entry);
				else if (kept.length > 0) written.push({ kind: 'text', frame: { ...f, events: kept } });
				continue;
			}
			let topic;
			let sequenced = false;
			if (entry.kind === 'binary') {
				const [id, seq] = binaryVarints(entry, 2);
				topic = boundIds.get(id);
				sequenced = seq !== 0;
			} else if (f?.type === undefined) {
				topic = f?.topic;
				sequenced = typeof f?.seq === 'number';
			}
			if (topic !== undefined && sequenced && (windows.get(topic)?.length ?? 0) > 0) {
				if (held.has(topic)) { dropRecord(entry, topic); continue; }
				if (over) { held.add(topic); dropRecord(entry, topic); continue; }
			}
			// Outside a window, an over-bound relayed game event is not delivered.
			if (over && entry.relayedGame === true) { dropRecord(entry, topic); continue; }
			if (over) return resetLane();
			if ((entry.capability === 'stateful' && statefulDegraded) || (entry.capability === 'game.fanout:1' && fanoutJson.has(topic))) {
				written.push(entry.relayedGame ? { kind: 'text', frame: entry.json, relayedGame: true } : { kind: 'text', frame: entry.json });
				continue;
			}
			written.push(entry);
		}
		return { written, resets: undefined, open: [...windows.values()].reduce((n, open) => n + open.length, 0) };
	}
	// Each run of consecutive standalone truncated events, sorted by topic.
	function byTopicWithinEventRuns(written) {
		const out = [];
		let run = [];
		const flush = () => { out.push(...run.sort((a, b) => (a.frame.topic < b.frame.topic ? -1 : a.frame.topic > b.frame.topic ? 1 : 0))); run = []; };
		for (const m of written) {
			if (m.frame?.event === 'truncated' && m.frame.topic.startsWith(replayPrefix)) run.push(m);
			else { flush(); out.push(m); }
		}
		flush();
		return out;
	}
	// The topics a request recovers can only be ones it asks to recover.
	function askedToRecover(frame) {
		if (frame.type === 'subscribe') return Number.isInteger(frame.recover?.offset) && frame.recover.offset >= 0 ? [frame.topic] : [];
		if (frame.type === 'subscribe-batch') return [...new Set(frame.topics)].filter((t) => Number.isInteger(frame.recover?.[t]?.offset) && frame.recover[t].offset >= 0);
		if (frame.type === 'resume') return Object.keys(frame.lastSeenSeqs);
		return [];
	}
	const isRef = (ref) => typeof ref === 'number' || typeof ref === 'string';

	it('places a recovery truncation after every frame it withholds', () => {
		const bound = root['x-webtransport'].reliableStream.maximumSenderMessageBytes;
		const cases = streamVector.recoveryTruncation;
		for (const c of cases) {
			const label = c.reason;
			for (const e of c.transcript.filter((x) => x.client)) {
				// `replay` is a plugin ingress frame (section 8), outside the core schema.
				if (e.client.type === 'replay') {
					// A replay request always carries a reqId here, so a __replay
					// event without one belongs to a resume's own gap-fill.
					expect(typeof e.client.topic === 'string' && Number.isInteger(e.client.since) && typeof e.client.reqId === 'string', label).toBe(true);
				} else {
					expect(validate(root, e.client), label).toEqual([]);
				}
				for (const t of e.recovers) expect(askedToRecover(e.client), label).toContain(t);
				const answered = c.transcript.some((m) => m.answers === c.transcript.indexOf(e) && ['subscribed', 'subscribe-denied', 'resumed'].includes(m.frame.type));
				if (answered) expect([...e.recovers].sort(), label + ': windows of an answered request').toEqual([...askedToRecover(e.client)].sort());
				// Only a request the server answers can open a window (section 3.2).
				if (e.recovers.length > 0 && e.client.type !== 'resume') expect(isRef(e.client.ref), label).toBe(true);
			}
			// A hold's expiry is a transcript marker for a topic, never a message.
			for (const m of c.transcript.filter((x) => x.holdExpires !== undefined)) expect(typeof m.holdExpires, label).toBe('string');
			expect(c.written.some((m) => m.holdExpires !== undefined), label).toBe(false);
			const wireTopics = new Map(c.transcript.filter((m) => m.frame?.type === 'wire-id').map((m) => [m.frame.id, m.frame.topic]));
			// One binding per topic per connection (section 6.2).
			expect(new Set(wireTopics.values()).size, label + ': one binding per topic').toBe(wireTopics.size);
			expect(c.transcript.filter((m) => m.frame?.type === 'wire-id').length, label + ': one topic per id').toBe(wireTopics.size);
			// Only a `msg` carries history, so only a `msg` can be over the bound there.
			for (const m of c.transcript) if (typeof m.frame?.topic === 'string' && m.frame.topic.startsWith(replayPrefix) && m.frame.event !== 'msg') expect(m.overBound, label + ': only a msg can be over the bound on __replay').toBeUndefined();
			// A server never forms a `batch` record larger than it may emit (15.1), so
			// no transcript carries one.
			for (const m of c.transcript.filter((x) => x.frame?.type === 'batch')) expect(m.length === undefined && m.overBound === undefined, label + ': a batch record is never over the bound').toBe(true);
			// A __replay event of a resume's own gap-fill names the earlier request
			// it belongs to, which recovers that topic; every one without a reqId
			// does, and nothing off that channel does.
			c.transcript.forEach((m, at) => {
				const replayTopic = typeof m.frame?.topic === 'string' && m.frame.topic.startsWith(replayPrefix) ? m.frame.topic.slice(replayPrefix.length) : undefined;
				if (replayTopic === undefined || (m.frame.data?.reqId !== undefined && m.fills === undefined)) {
					expect(m.fills, label).toBeUndefined();
					return;
				}
				expect(Number.isInteger(m.fills) && m.fills < at, label).toBe(true);
				expect(c.transcript[m.fills].recovers, label).toContain(replayTopic);
				// Section 11: a gap-fill's msg events precede the answer; only its end may follow.
				const answerIx = c.transcript.findIndex((x) => x.answers === m.fills && (x.frame.type === 'resumed' || x.frame.topic === replayTopic));
				if (m.frame.event === 'msg' && answerIx !== -1) expect(at, label + ': a gap-fill msg precedes its answer').toBeLessThan(answerIx);
			});
			// One history: every message for a topic and seq, on any channel, is the
			// same event, so it is over the bound everywhere or nowhere and carries the
			// same data; and a replay from `since` S starts at S+1 with no gaps.
			const events = new Map();
			const note = (topic, seq, over, data) => {
				if (topic === undefined || typeof seq !== 'number' || seq === 0) return;
				const key = topic + '#' + seq;
				const seen = events.get(key);
				if (!seen) { events.set(key, { over, data }); return; }
				expect(seen.over, label + ': over-bound verdict for ' + key).toBe(over);
				if (seen.data !== undefined && data !== undefined) expect(data, label + ': data for ' + key).toEqual(seen.data);
				if (seen.data === undefined) seen.data = data;
			};
			for (const m of c.transcript) {
				const f = m.frame;
				if (m.kind === 'binary') {
					const [id, seq] = binaryVarints(m, 2);
					note(wireTopics.get(id), seq, m.overBound === true, m.json?.data);
				} else if (f?.type === 'batch') {
					for (const e of f.events) note(e.topic, e.seq, false, e.data);
				} else if (typeof f?.topic === 'string' && f.topic.startsWith(replayPrefix) && f.event === 'msg') {
					note(f.topic.slice(replayPrefix.length), f.data.seq, m.overBound === true, f.data.data);
				} else if (f?.type === undefined && typeof f?.topic === 'string') {
					note(f.topic, f.seq, m.overBound === true, f.data);
				}
			}
			const offsetOf = (request, topic) => (request.type === 'resume' ? request.lastSeenSeqs[topic] : request.type === 'subscribe' ? request.recover?.offset : request.recover?.[topic]?.offset);
			// An ack to a recovering request carries the epoch the request reported,
			// unless the server answered a mismatch with `rehydrate`, whose epoch the
			// ack then carries (section 7).
			const askedEpoch = (request, topic) => (request.type === 'subscribe' ? request.recover?.epoch : request.type === 'resume' ? request.lastSeenEpochs?.[topic] : request.recover?.[topic]?.epoch);
			for (const m of c.transcript) {
				if (m.frame?.type !== 'subscribed' || !c.transcript[m.answers]?.recovers?.includes(m.frame.topic)) continue;
				const asked = askedEpoch(c.transcript[m.answers].client, m.frame.topic);
				const rehydrate = c.transcript.find((r) => r.frame?.event === 'rehydrate' && r.fills === m.answers && r.frame.topic === replayPrefix + m.frame.topic);
				if (rehydrate) expect(asked !== undefined && rehydrate.frame.data.epoch !== asked, label + ': rehydrate for a matching or absent epoch').toBe(true);
				const expected = rehydrate ? rehydrate.frame.data.epoch : asked;
				if (expected !== undefined) expect(m.frame.epoch, label + ': ack epoch for ' + m.frame.topic).toBe(expected);
			}
			const epochOf = new Map();
			const agree = (topic, epoch, what) => {
				if (epoch === undefined) return;
				if (!epochOf.has(topic)) epochOf.set(topic, epoch);
				expect(epoch, label + ': ' + what + ' epoch for ' + topic).toBe(epochOf.get(topic));
			};
			for (const m of c.transcript) {
				if (m.client) for (const t of m.recovers) agree(t, askedEpoch(m.client, t), 'reported');
				else if (m.frame?.event === 'rehydrate') epochOf.set(m.frame.topic.slice(replayPrefix.length), m.frame.data.epoch);
				else if (m.frame?.type === 'subscribed') agree(m.frame.topic, m.frame.epoch, 'ack');
			}
			// An epoch that does not match starts a new sequence space, so that
			// request's offset says nothing about the seqs that follow.
			const rehydrated = new Set(c.transcript.filter((m) => m.frame?.event === 'rehydrate').map((m) => m.fills + '#' + m.frame.topic.slice(replayPrefix.length)));
			c.transcript.forEach((e, at) => {
				if (e.client?.type === 'replay') {
					const end = c.transcript.findIndex((m, i) => i > at && m.frame?.topic === replayPrefix + e.client.topic && m.frame.event === 'end' && m.frame.data?.reqId === e.client.reqId);
					const seqs = c.transcript.slice(at + 1, end === -1 ? undefined : end).filter((m) => m.frame?.topic === replayPrefix + e.client.topic && m.frame.event === 'msg' && m.frame.data?.reqId === e.client.reqId).map((m) => m.frame.data.seq);
					expect(seqs, label + ': replay ' + e.client.reqId + ' since ' + e.client.since).toEqual(seqs.map((_, i) => e.client.since + 1 + i));
				}
				// A resume's own gap-fill on __replay also runs on from its offset.
				for (const topic of e.recovers ?? []) {
					const seqs = c.transcript.filter((m) => m.fills === at && m.frame.topic === replayPrefix + topic && m.frame.event === 'msg').map((m) => m.frame.data.seq);
					expect(seqs, label + ': gap-fill of request ' + at + ' for ' + topic).toEqual(seqs.map((_, i) => offsetOf(e.client, topic) + 1 + i));
				}
			});
			// Per topic, the seqs a case shows on any channel, with the offsets its
			// windows and replays start from, leave no hole; ordinary frames run on
			// consecutively, since section 11 keeps a topic's seq monotonic on a
			// connection; and the first frame for a topic after a request that
			// recovers it, ordinary or of that request's own gap-fill, continues
			// from the request's offset.
			const seqsOf = (m) => {
				const f = m.frame;
				if (m.kind === 'binary') {
					const [id, seq] = binaryVarints(m, 2);
					return seq === 0 ? [] : [{ topic: wireTopics.get(id), seq, ordinary: true }];
				}
				if (f?.type === 'batch') return f.events.filter((e) => typeof e.seq === 'number').map((e) => ({ topic: e.topic, seq: e.seq, ordinary: true }));
				if (typeof f?.topic !== 'string') return [];
				if (f.topic.startsWith(replayPrefix)) return f.event === 'msg' ? [{ topic: f.topic.slice(replayPrefix.length), seq: f.data.seq, ordinary: false, fills: m.fills }] : [];
				return f.type === undefined && typeof f.seq === 'number' ? [{ topic: f.topic, seq: f.seq, ordinary: true }] : [];
			};
			const framed = new Map();
			const starts = new Map();
			const add = (map, topic, seq) => map.set(topic, [...(map.get(topic) ?? []), seq]);
			const lastOrdinary = new Map();
			c.transcript.forEach((m, at) => {
				if (m.client) {
					if (m.client.type === 'replay') add(starts, m.client.topic, m.client.since);
					for (const topic of m.recovers) {
						if (rehydrated.has(at + '#' + topic)) continue;
						const offset = offsetOf(m.client, topic);
						add(starts, topic, offset);
						const next = c.transcript.slice(at + 1).flatMap(seqsOf).find((s) => s.topic === topic && (s.ordinary || s.fills === at));
						if (next) expect(next.seq, label + ': recovery of request ' + at + ' for ' + topic).toBe(offset + 1);
					}
					return;
				}
				for (const s of seqsOf(m)) {
					add(framed, s.topic, s.seq);
					if (!s.ordinary) continue;
					const prev = lastOrdinary.get(s.topic);
					expect(prev === undefined || s.seq === prev + 1, label + ': ' + s.topic + ' seq ' + s.seq + ' after ' + prev).toBe(true);
					lastOrdinary.set(s.topic, s.seq);
				}
			});
			for (const [topic, seqs] of framed) {
				const all = new Set([...seqs, ...(starts.get(topic) ?? [])]);
				expect(all.size, label + ': a hole in ' + topic).toBe(Math.max(...all) - Math.min(...all) + 1);
			}
			// What the server writes keeps each topic's seq rising (section 11).
			const lastWritten = new Map();
			for (const s of c.written.flatMap(seqsOf).filter((x) => x.ordinary)) {
				expect(s.seq, label + ': written ' + s.topic).toBeGreaterThan(lastWritten.get(s.topic) ?? -Infinity);
				lastWritten.set(s.topic, s.seq);
			}
			// A __replay event with a reqId belongs to an earlier replay request
			// for that topic with that reqId.
			c.transcript.forEach((m, at) => {
				const reqId = m.frame?.data?.reqId;
				if (reqId === undefined || m.fills !== undefined || !m.frame.topic?.startsWith(replayPrefix)) return;
				expect(c.transcript.slice(0, at).some((e) => e.client?.type === 'replay' && e.client.reqId === reqId && replayPrefix + e.client.topic === m.frame.topic), label).toBe(true);
			});
			for (const m of [...c.transcript.filter((x) => !x.client && x.holdExpires === undefined), ...c.written]) {
				// A record of a degrading capability carries the data-event it stands for.
				if (m.capability !== undefined) {
					expect(['stateful', 'game.fanout:1'], label).toContain(m.capability);
					if (m.frame?.type === 'wire-id') {
						// A tagged binding names the capability of the records that use it.
						const users = c.transcript.filter((r) => r.kind === 'binary' && binaryVarints(r, 1)[0] === m.frame.id);
						expect(users.length > 0 && users.every((r) => r.capability === m.capability), label).toBe(true);
					} else {
						expect(m.kind, label).toBe('binary');
						if (!m.overBound) {
							const { values: [id, seq], payload } = binaryHeader(m, 2);
							expect(validate(root, m.json), label).toEqual([]);
							expect([m.json.topic, m.json.seq], label).toEqual([wireTopics.get(id), seq]);
							// A game.fanout:1 payload is the value-codec [event, data] (6.7).
							if (m.capability === 'game.fanout:1') expect(decodeValue(payload), label).toEqual([m.json.event, m.json.data]);
						}
					}
				}
				if (m.length !== undefined) {
					// Shown without the event data that makes it this large.
					expect(m.overBound === true, label).toBe(m.length > bound);
					if (m.kind === 'text') expect((m.frame.topic.startsWith(replayPrefix) ? m.frame.data : m.frame).data, label).toBeUndefined();
					else expect(m.headHex.startsWith('03'), label).toBe(true);
				} else if (m.kind === 'binary') {
					expect(m.hex.startsWith('03') && m.hex.length / 2 <= bound, label).toBe(true);
				} else {
					expect(m.kind, label).toBe('text');
					expect(m.overBound, label).toBeUndefined();
					expect(validate(root, m.frame), label).toEqual([]);
				}
				if (m.relayedGame) {
					if (m.kind === 'binary') expect(m.capability, label).toBe('game.fanout:1');
					else expect(m.frame.type === undefined && typeof m.frame.seq === 'number', label).toBe(true);
				}
				// An answer answers an earlier request of the matching kind.
				if (m.answers !== undefined) {
					const request = c.transcript[m.answers]?.client;
					expect(request, label).toBeDefined();
					if (!c.written.includes(m)) expect(m.answers, label).toBeLessThan(c.transcript.indexOf(m));
					if (m.frame.type === 'subscribed' || m.frame.type === 'subscribe-denied') {
						expect(request.ref, label).toBe(m.frame.ref);
						expect(request.type === 'subscribe' ? [request.topic] : request.topics ?? [], label).toContain(m.frame.topic);
					} else if (m.frame.type === 'resumed') {
						expect(request.type, label).toBe('resume');
					} else {
						expect(m.frame.type, label).toBe('error');
					}
				} else {
					expect(['subscribed', 'subscribe-denied', 'resumed', 'error'], label).not.toContain(m.frame?.type);
				}
			}
			const carried = carryRecovery(c.transcript, bound);
			// Events that go before the same answer may come in any order; the
			// file lists them by topic, and so does the comparison.
			expect(byTopicWithinEventRuns(c.written), label).toEqual(c.written);
			expect(byTopicWithinEventRuns(carried.written), label).toEqual(c.written);
			expect(carried.resets, label).toBe(c.thenResets);
			// A case that does not reset answers every window it opened.
			expect(carried.open, label).toBe(0);
		}
		// What each case is there for. Each check matches exactly one case, no two
		// checks match the same case, and the count is pinned, so an edited file
		// can neither drop a case nor swap it for one that leaves its rule
		// unchecked.
		const requests = (c) => c.transcript.filter((e) => e.client).map((e) => e.client);
		const recovering = (c) => c.transcript.filter((e) => e.client && e.recovers.length > 0);
		const indexOfWritten = (c, test) => c.written.findIndex(test);
		const truncatedAt = (c, topic) => indexOfWritten(c, (m) => m.frame?.event === 'truncated' && (topic === undefined || m.frame.topic === replayPrefix + topic));
		const truncatedCount = (c) => c.written.filter((m) => m.frame?.event === 'truncated').length;
		const overBound = (c) => c.transcript.filter((m) => m.overBound);
		const firstOver = (c) => c.transcript.findIndex((m) => m.overBound);
		const answerAt = (c, request, topic) => c.transcript.findIndex((m) => m.answers === c.transcript.indexOf(request) && (topic === undefined || m.frame.topic === topic));
		const topicOf = (c, m) => {
			if (m.kind !== 'binary') return m.frame?.topic;
			const id = binaryVarints(m, 2)[0];
			return c.transcript.slice(0, c.transcript.indexOf(m)).find((e) => e.frame?.type === 'wire-id' && e.frame.id === id)?.frame.topic;
		};
		const insideWindow = (c, m) => {
			const request = recovering(c)[0];
			const topic = topicOf(c, m);
			const answer = answerAt(c, request, request.client.type === 'resume' ? undefined : topic);
			const at = c.transcript.indexOf(m);
			return request.recovers.includes(topic) && at > c.transcript.indexOf(request) && at < answer;
		};
		const oneOverInsideWindow = (c) => overBound(c).length === 1 && insideWindow(c, c.transcript[firstOver(c)]);
		const replays = (c) => requests(c).filter((r) => r.type === 'replay');
		const afterFirstOver = (c, test) => firstOver(c) !== -1 && c.transcript.slice(firstOver(c) + 1).some(test);
		// Transcript and written entries are separate objects: compare by value.
		const writes = (c, m, before = c.written.length) => c.written.slice(0, before).some((w) => JSON.stringify(w) === JSON.stringify(m));
		const truncatedEnds = (c) => c.written.filter((m) => m.frame?.event === 'end' && m.frame.data?.truncated === true).length;
		// A plain subscribe answered before the event, with its ack inside the hold
		// or before the hold starts: each case pins one of the two shapes.
		const plainSubscribeAnsweredBeforeEvent = (c, duringHold) => c.transcript.some((e, i) => e.client?.type === 'subscribe' && e.recovers.length === 0 && isRef(e.client.ref) &&
			indexOfWritten(c, (m) => m.answers === i) !== -1 && indexOfWritten(c, (m) => m.answers === i) < truncatedAt(c) &&
			(duringHold ? firstOver(c) < c.transcript.findIndex((m) => m.answers === i) : c.transcript.findIndex((m) => m.answers === i) < firstOver(c)));
		// The entry at which the model resets the lane: the shortest prefix of the
		// transcript that resets ends with it. A reset predicate names that entry,
		// so an earlier reset for another reason cannot stand in for the one the
		// case exists for.
		const resetsAt = (c) => { for (let i = 0; i < c.transcript.length; i++) if (carryRecovery(c.transcript.slice(0, i + 1), bound).resets) return i; return -1; };
		// A frame for T as 15.1 defines it: a sequenced data-event, or a 0x03 record
		// whose seq is not 0. A reset predicate names one, so an unsequenced
		// over-bound frame (which resets in or out of a window) cannot stand in.
		const frameFor = (m) => (m.kind === 'binary' && binaryVarints(m, 2)[1] !== 0) || (m.kind === 'text' && m.frame?.type === undefined && Number.isInteger(m.frame?.seq));
		const purposes = {
			'duplicate batch topics close their window at the first ack': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'subscribe-batch' &&
				recovering(c)[0].client.topics.length === 2 && new Set(recovering(c)[0].client.topics).size === 1 && recovering(c)[0].recovers.length === 1 && oneOverInsideWindow(c) && truncatedCount(c) === 1 &&
				truncatedAt(c) + 1 === indexOfWritten(c, (m) => m.answers === c.transcript.indexOf(recovering(c)[0])) &&
				c.transcript.filter((m) => m.answers === c.transcript.indexOf(recovering(c)[0])).length === 2 &&
				c.transcript.some((m, i) => m.frame?.topic === recovering(c)[0].recovers[0] && frameFor(m) && writes(c, m) &&
					i > answerAt(c, recovering(c)[0]) && c.transcript.slice(i + 1).some((a) => a.answers === c.transcript.indexOf(recovering(c)[0]) && a.frame.topic === m.frame.topic)),
			'a subscribe window that writes an unsequenced frame during the hold': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'subscribe' &&
				overBound(c).length === 2 && overBound(c).every((m) => c.transcript.indexOf(m) < answerAt(c, recovering(c)[0])) &&
				afterFirstOver(c, (m) => m.kind === 'text' && m.frame.type === undefined && m.frame.event === 'note' && recovering(c)[0].recovers.includes(m.frame.topic) && writes(c, m, truncatedAt(c))) &&
				c.transcript.some((m, i) => i > firstOver(c) && i < answerAt(c, recovering(c)[0]) && !m.overBound && m.frame?.topic === recovering(c)[0].recovers[0] && typeof m.frame.seq === 'number' && !writes(c, m)),
			'two windows of one subscribe-batch truncated apart': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'subscribe-batch' && truncatedCount(c) === 2 &&
				c.transcript.some((m, i) => m.holdExpires === recovering(c)[0].recovers[1] && i > firstOver(c) &&
					i < c.transcript.findIndex((t) => t.overBound && t.frame?.topic === recovering(c)[0].recovers[1])) && !c.thenResets &&
				overBound(c).some((m) => m.frame?.topic === recovering(c)[0].recovers[1] && c.transcript.indexOf(m) > answerAt(c, recovering(c)[0], recovering(c)[0].recovers[0])) &&
				c.transcript.some((m, i) => i > firstOver(c) && i < answerAt(c, recovering(c)[0], recovering(c)[0].recovers[0]) && !m.overBound &&
					m.frame?.topic === recovering(c)[0].recovers[1] && typeof m.frame.seq === 'number' && writes(c, m)),
			'a resume window that filters batch records': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'resume' &&
				c.written.filter((m) => m.frame?.type === 'batch').length < c.transcript.filter((m) => m.frame?.type === 'batch').length &&
				c.written.some((m) => m.frame?.type === 'batch' && m.frame.events.some((e) => recovering(c)[0].recovers.includes(e.topic) && e.seq === undefined)) &&
				c.transcript.some((t) => t.frame?.type === 'batch' && c.written.some((w) => w.frame?.type === 'batch' && w.frame.events.length > 0 && w.frame.events.length < t.frame.events.length &&
					w.frame.events.every((e) => t.frame.events.some((x) => JSON.stringify(x) === JSON.stringify(e))) && t.frame.events.some((x) => recovering(c)[0].recovers.includes(x.topic) && typeof x.seq === 'number'))),
			'a withheld 0x03 record beside a seq-0 record written during the hold': (c) => overBound(c).some((m) => m.kind === 'binary') && truncatedAt(c) !== -1 &&
				afterFirstOver(c, (m) => m.kind === 'binary' && !m.overBound && binaryVarints(m, 2)[1] === 0 && writes(c, m, truncatedAt(c))),
			'a wire-id inside a hold': (c) => recovering(c).length === 1 && firstOver(c) !== -1 && afterFirstOver(c, (m) => m.frame?.type === 'wire-id' && m.frame.topic === recovering(c)[0].recovers[0] && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0]) && writes(c, m) &&
				afterFirstOver(c, (b) => b.kind === 'binary' && binaryVarints(b, 1)[0] === m.frame.id && c.transcript.indexOf(b) < answerAt(c, recovering(c)[0]) && !writes(c, b))) && c.written.some((m) => m.kind === 'binary'),
			'a window answered with subscribe-denied': (c) => truncatedCount(c) === 1 && c.written[truncatedAt(c) + 1]?.frame?.type === 'subscribe-denied' &&
				c.written[truncatedAt(c) + 1].answers === c.transcript.indexOf(recovering(c)[0]),
			'a replay request with a live frame written past its cut': (c) => replays(c).length === 1 && recovering(c).length === 0 && truncatedEnds(c) === 1 &&
				afterFirstOver(c, (m) => m.frame?.topic === replays(c)[0].topic && typeof m.frame.seq === 'number' && writes(c, m)),
			'two replays of one topic cut apart': (c) => replays(c).length === 2 && replays(c)[0].topic === replays(c)[1].topic && replays(c)[0].reqId !== replays(c)[1].reqId && truncatedEnds(c) === 1 &&
				afterFirstOver(c, (m) => m.frame?.event === 'msg' && m.frame.data?.reqId !== c.transcript[firstOver(c)].frame.data.reqId && writes(c, m)),
			'a replay reusing a truncated replay\'s reqId': (c) => replays(c).length === 2 && replays(c)[0].topic === replays(c)[1].topic && replays(c)[0].reqId === replays(c)[1].reqId &&
				c.transcript.findIndex((e) => e.client === replays(c)[1]) > c.transcript.findIndex((m) => m.frame?.event === 'end') &&
				JSON.stringify(c.written.filter((m) => m.frame?.event === 'end').map((m) => m.frame.data?.truncated === true)) === '[true,false]',
			'two replays of two topics sharing a reqId': (c) => replays(c).length === 2 && replays(c)[0].topic !== replays(c)[1].topic && replays(c)[0].reqId === replays(c)[1].reqId && truncatedEnds(c) === 1 &&
				afterFirstOver(c, (m) => m.frame?.event === 'msg' && m.frame.topic !== c.transcript[firstOver(c)].frame.topic && writes(c, m)),
			'a replay-channel gap-fill inside a window': (c) => recovering(c).length === 1 && truncatedEnds(c) === 1 && truncatedCount(c) === 0 &&
				overBound(c).some((m) => m.frame?.topic?.startsWith(replayPrefix) && m.frame.data?.reqId === undefined),
			'a cut gap-fill with a reqId signalled before its answer': (c) => recovering(c).length === 1 && truncatedCount(c) === 1 && !c.written.some((m) => m.frame?.event === 'end') &&
				overBound(c).some((m) => m.fills !== undefined && m.frame.data?.reqId !== undefined) &&
				c.written[truncatedAt(c) + 1]?.answers === c.transcript.indexOf(recovering(c)[0]) && afterFirstOver(c, (m) => m.kind === 'text' && m.frame.type === undefined && typeof m.frame.seq === 'number' && writes(c, m, truncatedAt(c))),
			'a replay request cut inside another request\'s window and ended after its answer': (c) => recovering(c).length === 1 && replays(c).length === 1 && truncatedCount(c) === 0 &&
				recovering(c)[0].recovers.includes(replays(c)[0].topic) &&
				overBound(c).some((m) => m.frame?.topic?.startsWith(replayPrefix) && m.frame.data?.reqId !== undefined) && truncatedEnds(c) === 1 &&
				answerAt(c, recovering(c)[0]) < c.transcript.findIndex((m) => m.frame?.event === 'end'),
			'a cut gap-fill on the replay channel whose end comes after its answer': (c) => recovering(c).length === 1 && overBound(c).some((m) => m.fills !== undefined && m.frame.data?.reqId === undefined) &&
				truncatedCount(c) === 1 && truncatedEnds(c) === 0 && !c.written.some((m) => m.frame?.event === 'end') &&
				c.transcript.some((m, i) => m.fills !== undefined && m.frame.event === 'end' && i > answerAt(c, recovering(c)[0])),
			'two cut gap-fills on the replay channel, each signalled before its own answer': (c) => recovering(c).length === 2 && truncatedCount(c) === 2 &&
				new Set(overBound(c).map((m) => m.fills)).size === 2 && overBound(c).every((m) => m.fills !== undefined) &&
				c.transcript.indexOf(recovering(c)[1]) > firstOver(c) && !c.transcript.some((m) => m.frame?.event === 'end') &&
				c.written.every((m, i) => m.frame?.event !== 'truncated' || overBound(c).some((o) => o.fills === c.written[i + 1]?.answers)),
			'one event for a hold and a cut gap-fill that end at one answer': (c) => recovering(c).length === 1 && truncatedCount(c) === 1 &&
				overBound(c).some((m) => m.fills !== undefined) && !c.thenResets && !c.transcript.some((m) => m.frame?.event === 'end') &&
				overBound(c).some((m) => m.kind === 'text' && m.frame.type === undefined && typeof m.frame.seq === 'number' && !m.frame.topic.startsWith(replayPrefix) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0])),
			'an epoch that does not match opens a window': (c) => recovering(c).length === 1 && truncatedCount(c) === 1 &&
				indexOfWritten(c, (m) => m.frame?.event === 'rehydrate') !== -1 && indexOfWritten(c, (m) => m.frame?.event === 'rehydrate') < truncatedAt(c) &&
				c.written[truncatedAt(c) + 1]?.answers === c.transcript.indexOf(recovering(c)[0]),
			'a second window opened during the hold': (c) => recovering(c).length === 2 && recovering(c)[0].recovers[0] === recovering(c)[1].recovers[0] && truncatedCount(c) === 2 &&
				firstOver(c) !== -1 && !(c.transcript[firstOver(c)].frame?.topic ?? '').startsWith(replayPrefix) &&
				firstOver(c) < c.transcript.indexOf(recovering(c)[1]) && c.transcript.indexOf(recovering(c)[1]) < answerAt(c, recovering(c)[0]),
			'a later window after the hold ended': (c) => recovering(c).length === 2 && recovering(c)[0].recovers[0] === recovering(c)[1].recovers[0] &&
				firstOver(c) !== -1 && firstOver(c) < answerAt(c, recovering(c)[0]) && truncatedCount(c) === 1 &&
				c.transcript.indexOf(recovering(c)[1]) > answerAt(c, recovering(c)[0]),
			'an answer to a plain subscribe inside a subscribe-batch window': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'subscribe-batch' && plainSubscribeAnsweredBeforeEvent(c, false),
			'a resume answered while a subscribe window stays open': (c) => recovering(c).length === 2 && recovering(c).some((e) => e.client.type === 'resume') && recovering(c).some((e) => e.client.type === 'subscribe') &&
				indexOfWritten(c, (m) => m.frame?.type === 'resumed') < truncatedAt(c) && truncatedAt(c) !== -1 && firstOver(c) < c.transcript.findIndex((m) => m.frame?.type === 'resumed'),
			'a plain subscribe answered inside a resume window': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'resume' && plainSubscribeAnsweredBeforeEvent(c, true),
			'two resume frames answered out of order': (c) => recovering(c).length === 2 && recovering(c).every((e) => e.client.type === 'resume') &&
				c.written.find((m) => m.frame?.type === 'resumed')?.answers === c.transcript.indexOf(recovering(c)[1]) &&
				overBound(c).some((m) => recovering(c)[0].recovers.includes(m.frame?.topic) && !recovering(c)[1].recovers.includes(m.frame?.topic) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[1])) &&
				c.written[truncatedAt(c) + 1]?.answers === c.transcript.indexOf(recovering(c)[0]),
			'a replay request running beside a window whose hold is on': (c) => recovering(c).length === 1 && replays(c).length === 1 && truncatedCount(c) === 1 &&
				overBound(c).every((m) => !(m.frame?.topic ?? '').startsWith(replayPrefix)) &&
				afterFirstOver(c, (m) => m.frame?.topic?.startsWith(replayPrefix) && m.frame.event === 'msg' && writes(c, m)),
			'a game.fanout record withheld in a hold a data-event started': (c) => recovering(c).length === 1 && oneOverInsideWindow(c) && c.transcript[firstOver(c)]?.kind === 'text' &&
				afterFirstOver(c, (m) => m.capability === 'game.fanout:1' && m.kind === 'binary' && !m.overBound && !writes(c, m) && insideWindow(c, m) && topicOf(c, m) === topicOf(c, c.transcript[firstOver(c)])) &&
				c.written.some((m) => m.kind === 'text' && c.transcript.some((t) => t.capability === 'game.fanout:1' && t.json && JSON.stringify(t.json) === JSON.stringify(m.frame))),
			'an over-bound game.fanout record that starts a hold': (c) => recovering(c).length === 1 && oneOverInsideWindow(c) && truncatedCount(c) === 1 && c.transcript[firstOver(c)]?.relayedGame === true && c.transcript[firstOver(c)].kind === 'binary' &&
				overBound(c).some((m) => m.capability === 'game.fanout:1') &&
				c.written.some((m) => m.kind === 'text' && c.transcript.some((t) => t.capability === 'game.fanout:1' && t.json && JSON.stringify(t.json) === JSON.stringify(m.frame))),
			'a stateful record withheld in a hold a data-event started': (c) => recovering(c).length === 1 && oneOverInsideWindow(c) && c.transcript[firstOver(c)]?.kind === 'text' &&
				afterFirstOver(c, (m) => m.capability === 'stateful' && m.kind === 'binary' && !m.overBound && !writes(c, m) && insideWindow(c, m) && topicOf(c, m) === topicOf(c, c.transcript[firstOver(c)])) &&
				c.written.some((m) => m.kind === 'text' && c.transcript.some((t) => t.capability === 'stateful' && t.json && JSON.stringify(t.json) === JSON.stringify(m.frame))),
			'a relayed game event dropped for a room with no window while another room has one': (c) => recovering(c).length === 1 && !c.thenResets &&
				overBound(c).some((m) => m.relayedGame && m.kind === 'text' && !recovering(c)[0].recovers.includes(m.frame.topic) && c.transcript.indexOf(m) > c.transcript.indexOf(recovering(c)[0]) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0])),
			'a relayed game event dropped with no request in flight': (c) => requests(c).length === 0 && overBound(c).some((m) => m.relayedGame && m.kind === 'text') && !c.thenResets,
			'a relayed game event withheld inside a window': (c) => recovering(c).length === 1 && oneOverInsideWindow(c) && c.transcript[firstOver(c)]?.relayedGame === true && c.transcript[firstOver(c)].kind === 'text' && truncatedCount(c) === 1,
			'a relayed game event dropped during a replay': (c) => replays(c).length === 1 && !c.thenResets &&
				overBound(c).some((m) => m.relayedGame && m.frame?.topic === replays(c)[0].topic && c.transcript.indexOf(m) > c.transcript.findIndex((e) => e.client === replays(c)[0]) &&
					c.transcript.indexOf(m) < c.transcript.findIndex((e) => e.frame?.topic === replayPrefix + replays(c)[0].topic && e.frame.event === 'end' && e.frame.data?.reqId === replays(c)[0].reqId)),
			'a live over-bound frame during a replay resets': (c) => replays(c).length === 1 && Boolean(c.thenResets) &&
				overBound(c).some((m) => frameFor(m) && !m.relayedGame && m.frame?.topic === replays(c)[0].topic && c.transcript.indexOf(m) > c.transcript.findIndex((e) => e.client === replays(c)[0]) && c.transcript.indexOf(m) === resetsAt(c)),
			'an over-bound unsequenced frame in a window resets': (c) => recovering(c).length === 1 && Boolean(c.thenResets) && firstOver(c) > c.transcript.indexOf(recovering(c)[0]) &&
				overBound(c).some((m) => m.kind === 'text' && m.frame.seq === undefined && recovering(c)[0].recovers.includes(m.frame.topic) && c.transcript.indexOf(m) === firstOver(c) && c.transcript.indexOf(m) === resetsAt(c) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0])),
			'an over-bound unsequenced frame during a hold resets': (c) => recovering(c).length === 1 && Boolean(c.thenResets) && firstOver(c) > c.transcript.indexOf(recovering(c)[0]) &&
				overBound(c).some((m) => m.kind === 'text' && m.frame.seq === undefined && recovering(c)[0].recovers.includes(m.frame.topic) &&
					c.transcript.indexOf(m) > firstOver(c) && c.transcript.indexOf(m) === resetsAt(c) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0]) && typeof c.transcript[firstOver(c)].frame?.seq === 'number' && c.transcript[firstOver(c)].frame.topic === m.frame.topic),
			'an over-bound seq-0 record in a window resets': (c) => recovering(c).length === 1 && Boolean(c.thenResets) &&
				overBound(c).some((m) => m.kind === 'binary' && binaryVarints(m, 2)[1] === 0 && c.transcript.indexOf(m) > c.transcript.indexOf(recovering(c)[0]) && c.transcript.indexOf(m) === resetsAt(c) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0]) &&
					c.transcript.some((w) => w.frame?.type === 'wire-id' && w.frame.id === binaryVarints(m, 1)[0] && recovering(c)[0].recovers.includes(w.frame.topic))),
			'a hold that outlasts its bound resets': (c) => Boolean(c.thenResets) && recovering(c).length === 1 && firstOver(c) > c.transcript.indexOf(recovering(c)[0]) &&
				c.transcript.some((m, i) => m.holdExpires === recovering(c)[0].recovers[0] && i > firstOver(c) && i === resetsAt(c) && i < answerAt(c, recovering(c)[0]) &&
					!c.transcript.slice(i + 1).some((t) => t.overBound)),
			// The capability degrades, not the topic: records for another topic go
			// out as JSON too, and a binding for them is never written.
			'a stateful capability degraded to JSON': (c) => overBound(c).some((m) => m.capability === 'stateful') &&
				new Set(c.written.filter((m) => m.kind === 'text' && c.transcript.some((t) => t.capability === 'stateful' && t.json && JSON.stringify(t.json) === JSON.stringify(m.frame))).map((m) => m.frame.topic)).size === 2 &&
				c.transcript.some((m, i) => m.frame?.type === 'wire-id' && m.capability === 'stateful' && i > firstOver(c) && !writes(c, m)),
			// A room falls back, not the capability: another room's records stay binary.
			'a game.fanout room sent back to JSON': (c) => requests(c).length === 0 && overBound(c).some((m) => m.capability === 'game.fanout:1') &&
				c.written.some((m) => m.kind === 'text' && c.transcript.some((t) => t.capability === 'game.fanout:1' && t.json && JSON.stringify(t.json) === JSON.stringify(m.frame))) &&
				c.written.some((m) => m.kind === 'binary' && m.capability === 'game.fanout:1' && afterFirstOver(c, (t) => JSON.stringify(t) === JSON.stringify(m)) &&
					!c.written.some((j) => j.kind === 'text' && j.frame.type === undefined && j.frame.topic === m.json.topic)),
			'a cut gap-fill answered during a hold that outlives the answer': (c) => recovering(c).length === 2 && truncatedCount(c) === 2 &&
				overBound(c).some((m) => m.fills === c.transcript.indexOf(recovering(c)[0])) && recovering(c)[1].recovers.includes(recovering(c)[0].recovers[0]) &&
				overBound(c).some((m) => m.fills === undefined && m.frame?.topic === recovering(c)[0].recovers[0] && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0])) &&
				answerAt(c, recovering(c)[1]) > answerAt(c, recovering(c)[0]) &&
				c.transcript.some((m, i) => m.fills !== undefined && m.frame.event === 'end' && i > answerAt(c, recovering(c)[0])) && !c.written.some((m) => m.frame?.event === 'end'),
			'one answer that closes windows for two topics': (c) => recovering(c).length === 1 && recovering(c)[0].recovers.length === 2 && recovering(c)[0].client.type === 'resume' &&
				truncatedCount(c) === 2 && c.written[truncatedAt(c) + 1]?.frame?.event === 'truncated' && c.written[truncatedAt(c) + 2]?.frame?.type === 'resumed' &&
				overBound(c).some((m) => m.fills !== undefined) && overBound(c).some((m) => m.fills === undefined),
			'a refused request opens no window': (c) => Boolean(c.thenResets) && requests(c).length === 1 && recovering(c).length === 0 && c.written.some((m) => m.frame?.type === 'error' && m.answers === 0) &&
				overBound(c).some((m) => frameFor(m) && m.frame?.topic === requests(c)[0].topic && c.transcript.indexOf(m) === resetsAt(c)),
			'a recover key outside topics opens no window': (c) => Boolean(c.thenResets) &&
				requests(c).some((r) => r.type === 'subscribe-batch' && overBound(c).some((m) => frameFor(m) && Object.keys(r.recover ?? {}).includes(m.frame?.topic) && !r.topics.includes(m.frame.topic) && c.transcript.indexOf(m) > c.transcript.findIndex((e) => e.client === r) && c.transcript.indexOf(m) === resetsAt(c))),
			'a topic of the batch without recover resets beside an open window': (c) => recovering(c).length === 1 && recovering(c)[0].client.type === 'subscribe-batch' && Boolean(c.thenResets) &&
				overBound(c).every((m) => frameFor(m) && recovering(c)[0].client.topics.includes(m.frame?.topic) && !recovering(c)[0].recovers.includes(m.frame?.topic) &&
					c.transcript.indexOf(m) > c.transcript.indexOf(recovering(c)[0]) && c.transcript.indexOf(m) < answerAt(c, recovering(c)[0]) && c.transcript.indexOf(m) === resetsAt(c)),
			'a message exactly at the bound': (c) => c.written.some((m) => m.length === bound) && c.transcript.some((m) => m.holdExpires !== undefined) && !c.thenResets,
			'a reset after the window closed': (c) => recovering(c).length === 1 && Boolean(c.thenResets) &&
				overBound(c).every((m) => frameFor(m) && recovering(c)[0].recovers.includes(m.frame?.topic) && answerAt(c, recovering(c)[0], m.frame?.topic) < c.transcript.indexOf(m) && c.transcript.indexOf(m) === resetsAt(c))
		};
		const covered = new Set();
		for (const [purpose, test] of Object.entries(purposes)) {
			expect(cases.filter((c) => test(c)).map((c) => c.reason), purpose).toHaveLength(1);
			covered.add(cases.findIndex((c) => test(c)));
		}
		// No two checks share a case, so every case has its own.
		expect(covered.size).toBe(cases.length);
		expect(cases).toHaveLength(Object.keys(purposes).length);
		// The sender bullet points at "the next bullet" three times, so nothing may
		// come between the two.
		expect(flatProtocol).toContain('so no event queued after it goes out in an earlier record. - **Where a recovery\'s truncation goes** depends on how the recovery reaches the client.');
		// Nothing may follow the placement bullet either: the sender bullet speaks of
		// "the two cases below".
		expect(flatProtocol).toContain('a frame withheld for a window that remains open is followed by another event. - **A receiver\'s limit is its section 1.3 inbound message limit applied to this carriage**');
		expect(bulletAt('- `ref` is a client-allocated')).toBe('- `ref` is a client-allocated correlation id (a per-connection incrementing integer in the reference client; a string is also accepted). The server echoes it on the matching ack and never mints its own. **Silent mode:** a request whose `ref` is absent, or is not a number or string (null, boolean, object), is performed but NOT acked - the server sends no `subscribed` and no `subscribe-denied`. An emitted ack therefore always carries a number or string `ref`, never `null`. One exception, and it is not an ack: a `subscribe` carrying a `recover` of the shape below against a server with a resume hook is REFUSED rather than performed silently, with `{"type":"error","code":"RECOVER_REQUIRES_REF"}` (section 3.7). Silent mode trades away hearing the outcome; it cannot trade away history the client asked to be sent, because a client that never learns the gap-fill did not happen resumes over a hole in its own stream.');
		expect(bulletAt('- `subscribe-batch` caps')).toBe('- `subscribe-batch` caps at **256 topics per frame** and emits one `subscribed` / `subscribe-denied` ack per entry of `topics`, all sharing the one `ref`; a topic named twice is acked twice. The second entry is a duplicate if the first installed the subscription, and is judged on its own otherwise. Topics past the cap are NOT subscribed and are each answered `subscribe-denied` with reason `BATCH_OVERFLOW` (under the silent-mode rule above: a ref-less batch stays silent) - never dropped without a signal. A client MUST NOT exceed the cap; it SHOULD chunk instead. (The reference client chunks well below this, at 8000 bytes and 200 topics, to respect the control-frame ceiling of section 1.2.)');
		expect(bulletAt('- `recover` is resume-on-subscribe')).toBe('- `recover` is resume-on-subscribe (section 7). On `subscribe` it is a single `{offset, epoch?}`; on `subscribe-batch` it is a map keyed by topic, so recovery for many topics rides the same already-chunked batch instead of a separate whole-session `resume` frame that would overflow the control-frame ceiling. For each recover-tagged topic the server gap-fills the missed tail ahead of the first live frame, exactly as the `resume` frame does, and omits it for a topic the auth gate denied. A client that omits `recover` (or a server that does not implement it) is byte-identical to a plain subscribe. A `recover` outside that shape - not an object, or an `offset` that is not a non-negative integer - is treated as absent: the server performs the request as a plain subscribe, sends no history and acks it as one, and a server MUST NOT gap-fill for a `subscribe` or `subscribe-batch` that asks in any other way than the shape above; a client that wants its offset honoured sends that shape, with a number or string `ref`.');
		expect(bulletAt('- On resume, a topic\'s gap-fill')).toBe('- On resume, a topic\'s gap-fill frames precede its `subscribed` ack (or the whole-session `resumed`); on section 15\'s carriage a gap-fill\'s `__replay:` `end` may follow that ack (15.1).');
		expect(bulletAt('- `RECOVER_REQUIRES_REF` -')).toBe('- `RECOVER_REQUIRES_REF` - a `subscribe` carrying a `recover` of section 3.2\'s shape arrived without a `ref` while the server has a resume hook. `topic` names the topic, or is `null` when a whole `subscribe-batch` frame is refused. History is the one reply a client must correlate, so the silent-mode rule of section 3.2 cannot apply to it: staying silent would leave the client believing it had subscribed AND been gap-filled, and resuming over a hole in its history. The subscription is NOT installed. The client MUST send a `ref` on any subscribe that asks for recovery.');
		expect(paragraphAt('Resume-on-subscribe is acked')).toBe('Resume-on-subscribe is acked per topic by the ordinary `subscribed` frame (the gap-fill precedes it; on section 15\'s carriage its `__replay:` `end` may follow it, 15.1); the whole-session `resume` frame is acked once with `resumed`. The epoch is optional in both: a client that has no epoch for a topic omits it, and the server treats an absent epoch as a match (single-generation legacy behaviour). Epochs and recovery are additive - a new client against an old server, or an old client against a new server, degrade to offset-only recovery (or, for resume-on-subscribe against a server that predates it, to a plain resubscribe) without breaking.');
		expect(paragraphAt('The bundled collaborative plugins receive')).toBe('The bundled collaborative plugins receive a few plain-JSON control frames from the client. These are plugin contracts layered on the core protocol, listed here for completeness; an application that does not use a plugin never sees its frames. Plugin server-to-client output is not a distinct control type - it rides the data-event envelope (section 4) under reserved `__`-prefixed topics (appendix C.2), or the `0x03` binary frame when a binary token is negotiated. The `__replay:{topic}` events of section 8.1 can also carry a resume\'s gap-fill and its truncation (sections 7 and 15.7), so a client that recovers topics sees them whether or not it uses a plugin.');
		expect(paragraphAt('`replay` results arrive')).toBe('`replay` results arrive as data-event frames on the reserved topic `__replay:{topic}`. Six events can appear; the client dispatches them by `event`. The `reqId` field echoes the request\'s `reqId` and is OMITTED when the request omitted it (a client that always sends `reqId` always sees it back).');
		expect(paragraphAt('`gap` is the only unsolicited event')).toBe('`gap` is the only unsolicited event: a multi-worker server that detects it lost cluster-relayed frames (section 9\'s fan-out is otherwise invisible to a client) MAY push it, at any time, to the subscribers of the affected topic that opted in - it never carries `reqId`. The distinction from `truncated`/`rehydrate` matters for the offset: by the time a relay loss is confirmed, the delivered sequences have already stepped PAST the lost frames, so a resume from the current offset would silently skip them forever - which is exactly why the marker exists. The frame MAY carry the `j` de-herd window of section 4, and a client SHOULD honor it before re-snapshotting so one gap does not turn a large room into a synchronized stampede. A connection that did not advertise `relay.resync:1` never receives `gap` (section 5) and keeps the revision\'s original silence.');
		expect(protocol.split('\n').find((line) => line.startsWith('| `end` |'))).toBe('| `end` | `{reqId?}` (or `null` with no `reqId`), or `{reqId?, truncated:true}` | Terminal: recovery complete. `truncated:true` means the history from the requested point could not be delivered whole: the buffer was trimmed past it (the in-memory backend inlines truncation here), or on section 15\'s stream a message was too large to carry. |');
		expect(protocol.split('\n').find((line) => line.startsWith('| `truncated` |'))).toBe('| `truncated` | `null` | Standalone form of the same signal: the history from the requested point cannot be delivered whole (for example a trimmed buffer, or on section 15\'s stream a message too large to carry). Some backends emit it before `end`; it can also arrive on its own (below). |');
		expect(protocol.split('\n').find((line) => line.startsWith('| `denied` |'))).toBe('| `denied` | `{code, reqId?}` | Terminal: the resume-time subscribe was denied; `code` is the denial reason (section 3.2.2). |');
		expect(protocol.split('\n').find((line) => line.startsWith('| `rehydrate` |'))).toBe('| `rehydrate` | `{epoch}` | Terminal: the reported epoch did not match the topic\'s current epoch (section 7); the topic must cold-rehydrate. `epoch` is the current generation. |');
		expect(paragraphAt('1. The server\'s first stream record MUST')).toBe('1. The server\'s first stream record MUST be the unchanged `welcome` frame, unless the server closes the lane before admitting it: then its first and only record is a close record (15.4). A close record is carriage, not one of the frames whose order section 11 promises. 2. The client MAY send the unchanged `hello` frame. Inner capabilities are negotiated solely by `hello.caps`, not copied from CONNECT declarations. 3. Subscribe, batch, lease/request-n, resume, data-event, and `0x03` records then behave as sections 2-11 specify, except where this section says otherwise - 15.1\'s rules on a message larger than its sender may emit among them: recovery never replays one, the sequenced frames for a topic with an open recovery window are withheld from the first over-bound one until no window for it remains open, and a relayed `game` event too large for the lane is otherwise not delivered live.');
		expect(paragraphAt('Recovery applies only after a different WebTransport')).toBe('Recovery applies only after a different WebTransport CONNECT session is created. The client declares `lantean.reliable:1`, opens its new reliable stream, receives the new `welcome`, re-sends `hello`, and uses the unchanged resume-on-subscribe `recover` fields (or compatibility `resume` frame) from section 7. Offset and epoch comparison is identical to WebSocket; only the gap-fill, and what the server writes for a topic while a recovery window for it is open, differ, by 15.1\'s rule for a message larger than its sender may emit. Datagram `game` membership is re-authorized independently at CONNECT and has no gap-fill.');
		// Section 3.2 binds the server's gap-fill to the window shape and acks a
		// batch per entry, which the 15.7 count relies on.
		expect(flatProtocol).toContain('A `recover` outside that shape - not an object, or an `offset` that is not a non-negative integer - is treated as absent: the server performs the request as a plain subscribe, sends no history and acks it as one, and a server MUST NOT gap-fill for a `subscribe` or `subscribe-batch` that asks in any other way than the shape above; a client that wants its offset honoured sends that shape, with a number or string `ref`.');
		expect(flatProtocol).toContain('emits one `subscribed` / `subscribe-denied` ack per entry of `topics`, all sharing the one `ref`; a topic named twice is acked twice. The second entry is a duplicate if the first installed the subscription, and is judged on its own otherwise.');
		// The core sections carry the stream carriage's one exception to "gap-fill
		// precedes the ack", so a reader of section 7 or 11 alone meets it.
		expect(flatProtocol).toContain('On resume, a topic\'s gap-fill frames precede its `subscribed` ack (or the whole-session `resumed`); on section 15\'s carriage a gap-fill\'s `__replay:` `end` may follow that ack (15.1).');
		expect(flatProtocol).toContain('Resume-on-subscribe is acked per topic by the ordinary `subscribed` frame (the gap-fill precedes it; on section 15\'s carriage its `__replay:` `end` may follow it, 15.1); the whole-session `resume` frame is acked once with `resumed`.');
		// Every sentence of the placement bullet, so none is added unseen.
		expect(bulletAt('- **Where a recovery\'s truncation goes**'), '15.1 placement bullet').toBe([
			'- **Where a recovery\'s truncation goes** depends on how the recovery reaches the client.',
			'A frame for T, in this section, is a data-event for T that carries a `seq`, alone in its record or inside a `batch` record, or a `0x03` record bound to T whose `seq` is not `0`; a message on `__replay:T` is not one.',
			'The standalone truncations an answer gets, one per topic it is owed for, go out as an unbroken run immediately before that answer, in any order, each in its own record or in a `batch` record that carries no event after the run\'s: nothing but the run\'s events goes between the run\'s first event and the answer, and a `wire-id` the server would write there goes before the run. In this bullet, writing means admitting to the lane\'s send queue, not waiting for transport delivery. The server MUST admit the complete run and its answer and close the windows that answer covers as one operation serialized with the handling of every frame for those topics. That operation MUST finish before any record in the run or its answer can be transmitted, and MUST NOT await transport progress between them. If admitting the group would cross a section 15.6 bound, the server resets with `SLOW_CONSUMER` without admitting any part of the group. A frame handled after that operation is ordered after the answer and sees the remaining windows, if any.',
			'A recovery of topic T on `__replay:T` - a `replay` request, or a resume whose gap-fill uses that channel - is truncated at the message: the server writes neither that `msg` nor any later `msg` of the same recovery, and still ends the recovery with its `end`, which then carries `truncated:true`, section 8.1\'s inline form; a cut `replay` request\'s `end` always does, and a cut on that channel never resets the lane.',
			'If a resume\'s own gap-fill on that channel, with or without a `reqId` (one there echoes no request of the client\'s), is cut and has written no `end` when the server answers its request for T, the server writes the standalone `truncated` for T in that answer\'s run and writes no `end` for that gap-fill afterwards; section 11\'s promise covers the gap-fill\'s `msg` events, and its `end` may follow the answer, which is how a cut gap-fill reaches the answer without one.',
			'A gap-fill written as frames for T has no `end` to carry a truncation, so it is truncated by its recovery window.',
			'A recovery window for T belongs to one request that asks the server to recover T: a `subscribe` for T whose `recover` is an object with a non-negative integer `offset`, a `subscribe-batch` that names T in `topics` and whose `recover` entry for T is such an object (section 3.2), or a `resume` frame of section 3.5\'s shape whose `lastSeenSeqs` names T.',
			'It opens when the server takes up that request for T, before it awaits any authorization or resume hook, unless the server will answer that request with none of `subscribed`, `subscribe-denied` and `resumed`: it refuses the request (section 3.7), or it performs the request silently (section 3.2), which it decides when it takes the request up.',
			'For a `subscribe-batch` or a `resume` frame, every window the frame opens opens when the server takes up the frame, before it awaits a hook for any topic the frame names.',
			'Whether the server can recover T does not matter: a topic it does not recover, an epoch that does not match and history it no longer holds all open a window, so whether a window opens never depends on what the server knows about T.',
			'Nothing the server learns later changes that; the window closes only when the server answers that request for T, with the first of the request\'s `subscribed` or `subscribe-denied` acks for T or with its `resumed`, and, unless the lane ends first, the server MUST give that answer.',
			'A server MUST NOT gap-fill for a request that opens no window for T (section 3.2 performs such a request plain), so a frame for T written as gap-fill while no window for T is open is the server\'s own defect: it has nowhere to place a truncation, and one larger than its sender may emit resets the lane.',
			'A data-event for T without a `seq`, or a `0x03` record bound to T whose `seq` is `0`, is never gap-fill, which section 7 addresses by `seq`, so the hold never covers it, and an over-bound one resets the lane as the bullet above says.',
			'From the first frame for T larger than its sender may emit that the server comes to while a recovery window for T is open, whether gap-fill, live, or a relayed `game` event, until no recovery window for T remains open, the server withholds every frame for T: it never writes one, and a `batch` record goes out without them, or not at all if they were all it carried.',
			'The hold is bounded: while a hold for T is on, a server that has not answered a window for T within a bounded time of the later of the hold\'s start and that window\'s opening MUST reset the lane with `RECORD_TOO_LARGE` rather than withhold T any longer, and the client then gives that recovery up (15.7) instead of repeating it.',
			'The bound is the server\'s own; it SHOULD be no shorter than the longest a request\'s authorization and resume hooks may take together, and a server that does not bound its hooks chooses it itself.',
			'A withheld `0x03` record counts for sections 6.4 and 6.7 as a frame dropped under backpressure would: a stateful capability degrades to JSON, and a `game.fanout:1` topic falls back to its JSON envelope.',
			'A `wire-id` frame is never withheld: the server allocates a binding and writes its `wire-id` where it would without the hold, so a binding arrives before the first `0x03` record that uses it, as section 11 promises, though not always immediately before it as section 6.2 describes, and a binding whose first `0x03` record is withheld, which degrades a stateful capability to JSON (6.4) or sends a `game.fanout:1` room back to its envelope (6.7), is then never used.',
			'Every answer that closes a window for T while the hold is on gets one standalone truncation for T, `{"topic":"__replay:T","event":"truncated","data":null}`, in its run, after every frame the server has withheld so far, so each such answer\'s gap-fill, its truncation included, precedes it, as section 11 promises for `subscribed` and `resumed`.',
			'One event serves both the hold and a cut gap-fill when they meet at the same answer.',
			'The hold ends with the answer that closes the last window for T.',
			'Live frames for T look the same as the gap-fill on the wire, which is why they are withheld too and why each event follows every frame withheld before it: a client that re-snapshots T as soon as it reads an event, as section 8.1 asks, does so after every frame covered by that event was withheld. The atomic queue operation prevents a frame from being withheld between the final event and its answer; a frame withheld for a window that remains open is followed by another event.'
		].join(' '));

		expect(flatProtocol).toContain('`truncated:true`, section 8.1\'s inline form; a cut `replay` request\'s `end` always does, and a cut on that channel never resets the lane. If a resume\'s own gap-fill on that channel, with or without a `reqId` (one there echoes no request of the client\'s), is cut and has written no `end` when the server answers its request for T, the server writes the standalone `truncated` for T in that answer\'s run and writes no `end` for that gap-fill afterwards; section 11\'s promise covers the gap-fill\'s `msg` events, and its `end` may follow the answer, which is how a cut gap-fill reaches the answer without one.');
		expect(flatProtocol).toContain('The standalone truncations an answer gets, one per topic it is owed for, go out as an unbroken run immediately before that answer, in any order, each in its own record or in a `batch` record that carries no event after the run\'s: nothing but the run\'s events goes between the run\'s first event and the answer, and a `wire-id` the server would write there goes before the run. In this bullet, writing means admitting to the lane\'s send queue, not waiting for transport delivery. The server MUST admit the complete run and its answer and close the windows that answer covers as one operation serialized with the handling of every frame for those topics. That operation MUST finish before any record in the run or its answer can be transmitted, and MUST NOT await transport progress between them. If admitting the group would cross a section 15.6 bound, the server resets with `SLOW_CONSUMER` without admitting any part of the group. A frame handled after that operation is ordered after the answer and sees the remaining windows, if any.');
		expect(flatProtocol).toContain('A gap-fill written as frames for T has no `end` to carry a truncation, so it is truncated by its recovery window.');
		expect(flatProtocol).toContain('One event serves both the hold and a cut gap-fill when they meet at the same answer. The hold ends with the answer that closes the last window for T.');
		expect(flatProtocol).toContain('A stream client MUST take a topic\'s resume offset only from frames for that topic, as 15.1 defines them, that a reliable lane or a WebSocket carries, never from `__replay:{topic}` events, which can keep flowing while the topic is withheld, and never from the datagram lane.');
		expect(flatProtocol).toContain('A recovery of topic T on `__replay:T` - a `replay` request, or a resume whose gap-fill uses that channel - is truncated at the message: the server writes neither that `msg` nor any later `msg` of the same recovery, and still ends the recovery with its `end`, which then carries `truncated:true`, section 8.1\'s inline form');
		expect(flatProtocol).toContain('A recovery window for T belongs to one request that asks the server to recover T: a `subscribe` for T whose `recover` is an object with a non-negative integer `offset`, a `subscribe-batch` that names T in `topics` and whose `recover` entry for T is such an object (section 3.2), or a `resume` frame of section 3.5\'s shape whose `lastSeenSeqs` names T. It opens when the server takes up that request for T, before it awaits any authorization or resume hook, unless the server will answer that request with none of `subscribed`, `subscribe-denied` and `resumed`: it refuses the request (section 3.7), or it performs the request silently (section 3.2), which it decides when it takes the request up. For a `subscribe-batch` or a `resume` frame, every window the frame opens opens when the server takes up the frame, before it awaits a hook for any topic the frame names. Whether the server can recover T does not matter: a topic it does not recover, an epoch that does not match and history it no longer holds all open a window, so whether a window opens never depends on what the server knows about T. Nothing the server learns later changes that; the window closes only when the server answers that request for T, with the first of the request\'s `subscribed` or `subscribe-denied` acks for T or with its `resumed`, and, unless the lane ends first, the server MUST give that answer.');
		expect(flatProtocol).toContain('A server MUST NOT gap-fill for a request that opens no window for T (section 3.2 performs such a request plain), so a frame for T written as gap-fill while no window for T is open is the server\'s own defect: it has nowhere to place a truncation, and one larger than its sender may emit resets the lane.');
		expect(flatProtocol).toContain('A frame for T, in this section, is a data-event for T that carries a `seq`, alone in its record or inside a `batch` record, or a `0x03` record bound to T whose `seq` is not `0`; a message on `__replay:T` is not one.');
		expect(flatProtocol).toContain('A data-event for T without a `seq`, or a `0x03` record bound to T whose `seq` is `0`, is never gap-fill, which section 7 addresses by `seq`, so the hold never covers it, and an over-bound one resets the lane as the bullet above says.');
		expect(flatProtocol).toContain('From the first frame for T larger than its sender may emit that the server comes to while a recovery window for T is open, whether gap-fill, live, or a relayed `game` event, until no recovery window for T remains open, the server withholds every frame for T: it never writes one, and a `batch` record goes out without them, or not at all if they were all it carried.');
		expect(flatProtocol).toContain('The hold is bounded: while a hold for T is on, a server that has not answered a window for T within a bounded time of the later of the hold\'s start and that window\'s opening MUST reset the lane with `RECORD_TOO_LARGE` rather than withhold T any longer, and the client then gives that recovery up (15.7) instead of repeating it.');
		expect(flatProtocol).toContain('A withheld `0x03` record counts for sections 6.4 and 6.7 as a frame dropped under backpressure would: a stateful capability degrades to JSON, and a `game.fanout:1` topic falls back to its JSON envelope.');
		expect(flatProtocol).toContain('A `wire-id` frame is never withheld: the server allocates a binding and writes its `wire-id` where it would without the hold, so a binding arrives before the first `0x03` record that uses it, as section 11 promises, though not always immediately before it as section 6.2 describes, and a binding whose first `0x03` record is withheld, which degrades a stateful capability to JSON (6.4) or sends a `game.fanout:1` room back to its envelope (6.7), is then never used.');
		expect(flatProtocol).toContain('The bound is the server\'s own; it SHOULD be no shorter than the longest a request\'s authorization and resume hooks may take together, and a server that does not bound its hooks chooses it itself.');
		expect(flatProtocol).toContain('Every answer that closes a window for T while the hold is on gets one standalone truncation for T, `{"topic":"__replay:T","event":"truncated","data":null}`, in its run, after every frame the server has withheld so far, so each such answer\'s gap-fill, its truncation included, precedes it, as section 11 promises for `subscribed` and `resumed`.');
		expect(flatProtocol).toContain('a client that re-snapshots T as soon as it reads an event, as section 8.1 asks, does so after every frame covered by that event was withheld. The atomic queue operation prevents a frame from being withheld between the final event and its answer; a frame withheld for a window that remains open is followed by another event.');
		expect(flatProtocol).toContain('A standalone `truncated` can also arrive with no `end` after it, ahead of the frame that answers a topic\'s resume - its `subscribed`, `subscribe-denied` or `resumed` - when the server could not deliver everything the topic was owed while its recovery was open (section 15.1 is one such case); a client acts on it the same way.');
		expect(flatProtocol).toContain('A client SHOULD treat `truncated` in either form - the event, or an `end` that carries `truncated:true` - and `denied`, `rehydrate`, and `gap` alike: delivery or recovery did not complete cleanly, so drop the topic\'s resume offset and re-snapshot the topic rather than trusting a gap-fill. Each truncation needs a snapshot requested after the client read it; one already in flight does not satisfy a later event, because what was lost after it was taken is signalled only by that later event. That holds for a `replay` request\'s own `end` too: the offset is the cheap thing to drop, and a client cannot always tell a resume\'s gap-fill from a replay.');
		expect(flatProtocol).toContain('| `truncated` | `null` | Standalone form of the same signal: the history from the requested point cannot be delivered whole (for example a trimmed buffer, or on section 15\'s stream a message too large to carry). Some backends emit it before `end`; it can also arrive on its own (below). |');
		expect(paragraphAt('For recognition as a `resume` frame, `sessionId` is a string and `lastSeenSeqs` is a non-null object (arrays also satisfy this recognition rule)')).toBe('For recognition as a `resume` frame, `sessionId` is a string and `lastSeenSeqs` is a non-null object (arrays also satisfy this recognition rule). A frame outside that shape is not acted on as a resume, follows section 1.4, and names no topic for sections 15.1 and 15.7. Unless the lane ends or the server refuses the frame under section 3.7, it MUST answer every recognized `resume` with `resumed`, even without a resume hook. The schema describes the canonical topic map clients send; array recognition is permissive input handling only.');
		expect(paragraphAt('A terminal event below ends only that recovery\'s `msg` stream')).toBe('A terminal event below ends only that recovery\'s `msg` stream. While the topic\'s resume is unanswered, a standalone `truncated` can still follow `end` (with or without `truncated:true`), `denied` or `rehydrate`. A client MUST process that truncation even after a terminal event, until it has read the request\'s `subscribed`, `subscribe-denied` or `resumed`; it acts on each truncation as described below.');
		// A reqId-less end is `null` from the reference backend and `{}` from others.
		expect(flatProtocol).toContain('| `end` | `{reqId?}` (or `null` with no `reqId`), or `{reqId?, truncated:true}` | Terminal: recovery complete.');
		expect(flatProtocol).toContain('The `__replay:{topic}` events of section 8.1 can also carry a resume\'s gap-fill and its truncation (sections 7 and 15.7), so a client that recovers topics sees them whether or not it uses a plugin.');
		expect(flatProtocol).toContain('A client that recovers topics over this carriage MUST also act on the truncation that section 15.1 answers such a recovery with - a `truncated` event on `__replay:{topic}`, or an `end` there that carries `truncated:true`, with or without a `reqId` - even if it implements no section 8 plugin: it drops the topic\'s resume offset and surfaces the truncation to the application, which re-snapshots the topic as section 8.1 describes, once per truncation: a snapshot already in flight does not satisfy a later event, since frames withheld after it was taken are signalled only by that event.');
		expect(flatProtocol).toContain('A client whose lane ends with `RECORD_TOO_LARGE`, whichever side reset it, MUST likewise drop the resume offset of every topic it asked that lane to recover and has not read every answer for, and surface a truncation for each such topic to the application, as for a `truncated` event, so its next session re-snapshots those topics instead of replaying that recovery. If a client\'s own receiver limit is lower than the sender\'s, a frame within the sender\'s bound can reset live delivery first and recovery on the next session; that second reset drops the unanswered recovery offset, so the following session re-snapshots. The requests that count are those 15.1\'s recovery windows belong to, in the shapes 15.1 defines: a `subscribe` or `subscribe-batch` that names the topic in `topic` or `topics` and carries a number or string `ref` and a `recover` entry for the topic that is an object with a non-negative integer `offset`, whose topic counts as answered only once the client has read as many `subscribed` or `subscribe-denied` frames for it as the times the client has named it in `topic` or `topics` of any `subscribe` or `subscribe-batch` on that lane that carries a number or string `ref`, with or without `recover`, since a `ref` can be reused (a request without one is never acked and does not count, section 3.2), and a `resume` frame of section 3.5\'s shape, answered by a `resumed`: since `resumed` names no frame, the client counts as unanswered the topics of every `resume` frame it sent after the last time it had read as many `resumed` frames as it had sent `resume` frames. A `replay` request does not count.');
		expect(flatProtocol).toContain('The reset names no topic, so every unanswered recovery counts as truncated; the cost is a re-snapshot of each.');
		expect(flatProtocol).toContain('A request the server refuses with an `error` (section 3.7) gets none of these answers, so its topics stay unanswered for the rest of the lane; for a `resume` frame that reaches the topics of every later `resume` frame too, since the two counts never meet again; that is the intended outcome, a re-snapshot of those topics at each later reset, and a client that resends a refused frame in smaller pieces names its topics again, which counts like any other request.');
		expect(flatProtocol).toContain('or a server\'s recovery hold outlasted its bound (15.1). |');
		// The whole 15.7 client paragraph and the whole 15.6 bound paragraph, so a
		// sentence added between two pinned ones is caught.
		expect(paragraphAt('A client SHOULD treat `truncated` in either form'), '8.1 client paragraph').toBe([
			'A client SHOULD treat `truncated` in either form - the event, or an `end` that carries `truncated:true` - and `denied`, `rehydrate`, and `gap` alike: delivery or recovery did not complete cleanly, so drop the topic\'s resume offset and re-snapshot the topic rather than trusting a gap-fill.',
			'Each truncation needs a snapshot requested after the client read it; one already in flight does not satisfy a later event, because what was lost after it was taken is signalled only by that later event.',
			'That holds for a `replay` request\'s own `end` too: the offset is the cheap thing to drop, and a client cannot always tell a resume\'s gap-fill from a replay.',
			'Not every backend emits every event: the in-memory backend signals truncation inline on `end` and never emits `denied` or `rehydrate`; clustered backends emit the standalone `truncated`, `denied`, and `rehydrate` forms.',
			'A standalone `truncated` can also arrive with no `end` after it, ahead of the frame that answers a topic\'s resume - its `subscribed`, `subscribe-denied` or `resumed` - when the server could not deliver everything the topic was owed while its recovery was open (section 15.1 is one such case); a client acts on it the same way.'
		].join(' '));
		expect(paragraphAt('A client or server claiming the reliable-stream binding'), '15.7 client paragraph').toBe([
			'A client or server claiming the reliable-stream binding MUST implement Core conformance from section 13 over this carriage, the framing/topology/lifecycle rules of section 15, and every optional inner capability it advertises or emits.',
			'Binary conformance continues to require JSON fallback.',
			'The unanswered-recovery offset rule in section 7 applies to every lane ending, including network loss and slow-consumer resets.',
			'A client that recovers topics over this carriage MUST also act on the truncation that section 15.1 answers such a recovery with - a `truncated` event on `__replay:{topic}`, or an `end` there that carries `truncated:true`, with or without a `reqId` - even if it implements no section 8 plugin: it drops the topic\'s resume offset and surfaces the truncation to the application, which re-snapshots the topic as section 8.1 describes, once per truncation: a snapshot already in flight does not satisfy a later event, since frames withheld after it was taken are signalled only by that event.',
			'A client whose lane ends with `RECORD_TOO_LARGE`, whichever side reset it, MUST likewise drop the resume offset of every topic it asked that lane to recover and has not read every answer for, and surface a truncation for each such topic to the application, as for a `truncated` event, so its next session re-snapshots those topics instead of replaying that recovery. If a client\'s own receiver limit is lower than the sender\'s, a frame within the sender\'s bound can reset live delivery first and recovery on the next session; that second reset drops the unanswered recovery offset, so the following session re-snapshots.',
			'The requests that count are those 15.1\'s recovery windows belong to, in the shapes 15.1 defines: a `subscribe` or `subscribe-batch` that names the topic in `topic` or `topics` and carries a number or string `ref` and a `recover` entry for the topic that is an object with a non-negative integer `offset`, whose topic counts as answered only once the client has read as many `subscribed` or `subscribe-denied` frames for it as the times the client has named it in `topic` or `topics` of any `subscribe` or `subscribe-batch` on that lane that carries a number or string `ref`, with or without `recover`, since a `ref` can be reused (a request without one is never acked and does not count, section 3.2), and a `resume` frame of section 3.5\'s shape, answered by a `resumed`: since `resumed` names no frame, the client counts as unanswered the topics of every `resume` frame it sent after the last time it had read as many `resumed` frames as it had sent `resume` frames.',
			'A `replay` request does not count.',
			'A request the server refuses with an `error` (section 3.7) gets none of these answers, so its topics stay unanswered for the rest of the lane; for a `resume` frame that reaches the topics of every later `resume` frame too, since the two counts never meet again; that is the intended outcome, a re-snapshot of those topics at each later reset, and a client that resends a refused frame in smaller pieces names its topics again, which counts like any other request.',
			'The reset names no topic, so every unanswered recovery counts as truncated; the cost is a re-snapshot of each.',
			'A stream client MUST take a topic\'s resume offset only from frames for that topic, as 15.1 defines them, that a reliable lane or a WebSocket carries, never from `__replay:{topic}` events, which can keep flowing while the topic is withheld, and never from the datagram lane.',
			'A datagram-only implementation claims section 14, not section 15.'
		].join(' '));
		expect(paragraphAt('An endpoint MUST bound, per session, the message bytes'), '15.6 bound paragraph').toBe([
			'An endpoint MUST bound, per session, the message bytes of complete records framed for this lane but not yet sent.',
			'A byte counts until the transport has sent it, whether or not the peer has acknowledged it: a byte a stack holds only because the peer\'s flow control has not admitted it is still pending, and a byte in flight is not, so acknowledgement delay cannot eat into the floor.',
			'An endpoint whose stack does not show what it has sent counts a byte until the write carrying it settles (the W3C WebTransport API\'s `write()` promise), accepting that such a stack may settle a write flow control still holds; a stack whose write settles only on acknowledgement reports only acknowledgement.',
			'An endpoint whose stack reports only acknowledgement counts unsent and unacknowledged bytes together against one bound of at least the unsent-byte floor plus 1,048,576 bytes - **2,097,152 bytes** unless out-of-band knowledge raised that floor.',
			'The unsent-byte bound MUST be at least **1,048,576 bytes per session**, and at least the largest record this endpoint may itself emit (15.1) where out-of-band knowledge raised that above the unnegotiated maximum - otherwise emitting a record the sender is permitted to emit would force it to reset its own lane.',
			'The sum is over the unsent message bytes of each queued record; the length prefix (at most 5 bytes, 15.1) and the `kind` byte are fixed framing overhead and do not count.',
			'One maximum-size message therefore always fits.',
			'Because an empty message adds nothing to that sum, an endpoint MAY also bound the number of pending records per session; that bound MUST be at least **65,536 records**.',
			'A close record (15.4) counts against neither bound.',
			'The endpoint MUST stop pulling or producing optional work while the stream is blocked.',
			'If adding the next complete record would cross either bound, it MUST reset the reliable lane with `SLOW_CONSUMER`.',
			'Recoverable topics then resume on a new connection by section 15.5; non-recoverable topics re-snapshot as section 7 already requires.',
			'The datagram lane may continue after the reset.',
			'While the lane is open it MUST NOT drop that record or any queued record, or spill into a second stream; section 6.4\'s drop under backpressure does not apply on this carriage.',
			'This binding leaves out a message the server would otherwise write only where 15.1 withholds it (a `batch` record that would have carried only withheld events included), cuts it from a `__replay:{topic}` recovery, drops the `end` of a cut gap-fill whose standalone `truncated` came first, or does not deliver it, and such a message never enters the send queue: 15.1\'s truncation signals the gaps that withheld frames and cut messages leave, the room `seq` shows the gap an undelivered `game` event leaves, and a withheld or undelivered `0x03` record degrades a capability or a room only as 15.1 says.'
		].join(' '));
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
		expect(flatProtocol).toContain('While the lane is open it MUST NOT drop that record or any queued record, or spill into a second stream; section 6.4\'s drop under backpressure does not apply on this carriage.');
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
