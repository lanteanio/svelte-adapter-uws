import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DIAGNOSTIC_PREFIX,
	emitOperationalEvent,
	formatDiagnostic,
	parseDiagnostic,
	setOperationalEventSink
} from '../src/observability.js';

afterEach(() => {
	setOperationalEventSink(null);
	vi.restoreAllMocks();
});

describe('cross-package diagnostic contract', () => {
	it('routes structured operational records to an installed process sink', () => {
		const records = [];
		setOperationalEventSink((record) => records.push(record));
		const emitted = emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.failed',
			severity: 'fatal',
			message: 'listener failed'
		});
		expect(records).toEqual([emitted]);
		expect(emitted.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('uses canonical console JSON by default and fails over when a sink throws', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		setOperationalEventSink(() => { throw new Error('collector down'); });
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.failed',
			severity: 'error',
			message: 'listener failed'
		});
		expect(error).toHaveBeenCalledTimes(2);
		expect(parseDiagnostic(error.mock.calls[0][0])?.record.event).toBe('runtime.listen.failed');
		expect(parseDiagnostic(error.mock.calls[1][0])?.record.event).toBe('operational.sink.failed');
	});

	it('fails over to canonical console output when a sink rejects', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		setOperationalEventSink(async () => { throw new Error('collector rejected'); });
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.failed',
			severity: 'error',
			message: 'listener failed'
		});
		await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
		expect(parseDiagnostic(error.mock.calls[0][0])?.record.event).toBe('runtime.listen.failed');
		expect(parseDiagnostic(error.mock.calls[1][0])?.record.event).toBe('operational.sink.failed');
	});

	it('never resurrects a sink disposed out of order', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const seen = [];
		const disposeA = setOperationalEventSink((record) => seen.push('a:' + record.event));
		const disposeB = setOperationalEventSink((record) => seen.push('b:' + record.event));

		disposeA();
		disposeA();
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.started',
			severity: 'info',
			message: 'listener started'
		});
		disposeB();
		disposeB();
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.restored',
			severity: 'info',
			message: 'listener restored'
		});

		expect(seen).toEqual(['b:runtime.listen.started']);
		expect(info).toHaveBeenCalledTimes(1);
		expect(parseDiagnostic(info.mock.calls[0][0])?.record.event).toBe('runtime.listen.restored');
	});

	it('formats stable source, component, event, and severity fields', () => {
		const line = formatDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.failed',
			severity: 'fatal',
			message: 'listener failed',
			occurredAt: '2026-08-02T12:00:00.000Z',
			attributes: { port: 3000 }
		});
		expect(line).toMatch(/^\[lantean\/diagnostic source=svelte-adapter-uws component=runtime\.listener event=runtime\.listen\.failed severity=fatal\]/);
		expect(DIAGNOSTIC_PREFIX).toBe('lantean/diagnostic');
		expect(parseDiagnostic(line)).toMatchObject({
			format: 'canonical',
			record: { source: 'svelte-adapter-uws', component: 'runtime.listener', event: 'runtime.listen.failed', severity: 'fatal' }
		});
	});

	it.each([
		['[adapter-uws] startup warning', 'svelte-adapter-uws', 'runtime.adapter'],
		['[adapter-uws/assert] {"category":"ws.shape"}', 'svelte-adapter-uws', 'runtime.assertion'],
		['[adapter-uws/fatal] {"category":"ws.shape"}', 'svelte-adapter-uws', 'runtime.assertion'],
		['[adapter-uws/devAssert] shape mismatch', 'svelte-adapter-uws', 'runtime.assertion'],
		['[svelte-adapter-uws] authenticate failed', 'svelte-adapter-uws', 'runtime.adapter'],
		['[adapter-uws/testing] upgrade failed', 'svelte-adapter-uws', 'runtime.testing'],
		['[adapter-uws/relay-gap] lost frames', 'svelte-adapter-uws', 'runtime.relay-gap'],
		['[ws] protection posture normal -> elevated', 'svelte-adapter-uws', 'runtime.websocket'],
		['[tls] certificate reload failed', 'svelte-adapter-uws', 'runtime.tls'],
		['[primary] worker restart limit reached', 'svelte-adapter-uws', 'runtime.primary'],
		['[worker 3] shutdown hook failed', 'svelte-adapter-uws', 'runtime.worker'],
		['[pressure] listener failed', 'svelte-adapter-uws', 'runtime.pressure'],
		['[group lobby] onJoin failed', 'svelte-adapter-uws', 'plugins.groups'],
		['[extensions] postgres idle client error', 'svelte-adapter-uws-extensions', 'runtime.extensions'],
		['[extensions/assert] {"category":"redis.state"}', 'svelte-adapter-uws-extensions', 'runtime.assertion'],
		['[extensions/fatal] {"category":"redis.state"}', 'svelte-adapter-uws-extensions', 'runtime.assertion'],
		['[extensions/devAssert] schema mismatch', 'svelte-adapter-uws-extensions', 'runtime.assertion'],
		['[redis] degraded mode', 'svelte-adapter-uws-extensions', 'runtime.redis'],
		['[redis replay] cleanup failed', 'svelte-adapter-uws-extensions', 'runtime.redis.replay'],
		['[redis stream replay] cleanup failed', 'svelte-adapter-uws-extensions', 'runtime.redis.stream-replay'],
		['[redis/cursor] cleanup failed', 'svelte-adapter-uws-extensions', 'runtime.redis.cursor'],
		['[postgres] idle client error', 'svelte-adapter-uws-extensions', 'runtime.postgres'],
		['[postgres replay] cleanup failed', 'svelte-adapter-uws-extensions', 'runtime.postgres.replay'],
		['[postgres tasks] listener failed', 'svelte-adapter-uws-extensions', 'runtime.postgres.tasks'],
		['[postgres/notify] parse failed', 'svelte-adapter-uws-extensions', 'runtime.postgres.notify'],
		['[redis/smooth] owner unresolved', 'svelte-adapter-uws-extensions', 'runtime.redis.smooth'],
		['[publish-rate] listener failed', 'svelte-adapter-uws-extensions', 'runtime.redis.publish-rate'],
		['[svelte-realtime] reconnecting', 'svelte-realtime', 'runtime.realtime'],
		['[realtime/assert] {"category":"client.state"}', 'svelte-realtime', 'runtime.assertion'],
		['[realtime/fatal] {"category":"client.state"}', 'svelte-realtime', 'runtime.assertion']
	])('parses the legacy compatibility window: %s', (line, source, component) => {
		expect(parseDiagnostic(line)).toMatchObject({ format: 'legacy', record: { source, component } });
	});

	it('rejects unknown and prefix/record disagreement', () => {
		expect(parseDiagnostic('[other] nope')).toBeNull();
		const line = formatDiagnostic({
			source: 'svelte-realtime', component: 'runtime.client', event: 'socket.closed',
			severity: 'warn', message: 'closed'
		});
		expect(parseDiagnostic(line.replace('severity=warn', 'severity=error'))).toBeNull();
		expect(parseDiagnostic(line.replace('] closed {', '] different text {'))).toBeNull();
	});

	it.each([
		['overlong message', (line) => line.replace(/\] closed (\{"schemaVersion")/, '] ' + 'x'.repeat(513) + ' $1').replace('"message":"closed"', '"message":"' + 'x'.repeat(513) + '"')],
		['controlled message', (line) => line.replace(/\] closed (\{"schemaVersion")/, '] closed\nagain $1').replace('"message":"closed"', '"message":"closed\\nagain"')],
		['empty occurredAt', (line) => line.replace('"occurredAt":null', '"occurredAt":""')],
		['missing attributes', (line) => line.replace(',"attributes":null', '')]
	])('rejects malformed canonical records: %s', (_label, mutate) => {
		const line = formatDiagnostic({
			source: 'svelte-realtime', component: 'runtime.client', event: 'socket.closed',
			severity: 'warn', message: 'closed'
		});
		expect(parseDiagnostic(mutate(line))).toBeNull();
	});

	it('escapes JavaScript line separators in the JSON suffix', () => {
		const line = formatDiagnostic({
			source: 'svelte-realtime', component: 'runtime.client', event: 'socket.closed',
			severity: 'warn', message: 'closed', attributes: { value: 'a\u2028b\u2029c' }
		});
		expect(line).not.toContain('\u2028');
		expect(line).not.toContain('\u2029');
		expect(line).toContain('\\u2028');
		expect(line).toContain('\\u2029');
		expect(parseDiagnostic(line)?.record.attributes).toEqual({ value: 'a\u2028b\u2029c' });
	});

	it('keeps C0, C1, bidi controls, and right-to-left fields inert on the physical line', () => {
		const hostile = String.fromCodePoint(
			0,
			0x85,
			0x61c,
			0x202e,
			0x2066,
			0x5e9,
			0x5dc,
			0x5d5,
			0x5dd
		);
		const line = formatDiagnostic({
			source: 'svelte-realtime',
			component: 'runtime.client',
			event: 'socket.closed',
			severity: 'warn',
			message: 'external=' + hostile,
			attributes: { path: hostile }
		});
		expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
		expect(line).not.toContain(String.fromCodePoint(0x5e9));
		for (const escaped of ['\\u0000', '\\u0085', '\\u061c', '\\u202e', '\\u2066', '\\u05e9']) {
			expect(line).toContain(escaped);
		}
		expect(parseDiagnostic(line)?.record).toMatchObject({
			message: 'external=\\u0000\\u0085\\u061c\\u202e\\u2066\\u05e9\\u05dc\\u05d5\\u05dd',
			attributes: { path: hostile }
		});
		expect(parseDiagnostic(line.replace('\\u202e', String.fromCodePoint(0x202e)))).toBeNull();
	});
});
