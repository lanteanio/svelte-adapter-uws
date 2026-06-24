import { describe, it, expect } from 'vitest';
import { renderWaitingRoomTemplate, resolveWaitingRoom } from '../src/runtime/utils.js';

describe('renderWaitingRoomTemplate', () => {
	const ctx = {
		queueDepth: 7,
		estimatedSeconds: 12,
		pollIntervalMs: 3000,
		retryAfterSeconds: 4,
		admitCheckPath: '/__admit-check'
	};

	it('substitutes every supported token', () => {
		const out = renderWaitingRoomTemplate(
			'q={{queueDepth}} eta={{estimatedSeconds}} poll={{pollIntervalMs}} ' +
			'retry={{retryAfterSeconds}} check={{admitCheckPath}}',
			ctx
		);
		expect(out).toBe('q=7 eta=12 poll=3000 retry=4 check=/__admit-check');
	});

	it('leaves unknown tokens intact', () => {
		expect(renderWaitingRoomTemplate('{{nope}} {{queueDepth}}', ctx)).toBe('{{nope}} 7');
	});

	it('coerces numeric tokens to safe integers and clamps', () => {
		const out = renderWaitingRoomTemplate('{{queueDepth}}|{{pollIntervalMs}}', {
			queueDepth: -5,
			pollIntervalMs: 10, // below the 250 floor
			estimatedSeconds: 0,
			retryAfterSeconds: 0,
			admitCheckPath: '/x'
		});
		expect(out).toBe('0|250');
	});

	it('HTML-escapes the admitCheckPath token (no injection)', () => {
		const out = renderWaitingRoomTemplate('{{admitCheckPath}}', {
			...ctx,
			admitCheckPath: '/x"><script>alert(1)</script>'
		});
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
		expect(out).toContain('&quot;');
	});

	it('replaces repeated occurrences of a token', () => {
		expect(renderWaitingRoomTemplate('{{queueDepth}}-{{queueDepth}}', ctx)).toBe('7-7');
	});
});

describe('resolveWaitingRoom with a string template', () => {
	function resolved(template) {
		return resolveWaitingRoom({ maxConcurrent: 10, waitingRoom: { template } });
	}

	it('renders the operator string template via token substitution', () => {
		const wr = resolved('<p>ahead: {{queueDepth}}</p>');
		const page = wr.renderPage(3);
		expect(page).toBe('<p>ahead: 3</p>');
	});

	it('falls back to the built-in page when no template is set', () => {
		const wr = resolveWaitingRoom({ maxConcurrent: 10 });
		const page = wr.renderPage(2);
		expect(page).toContain('<!doctype html>');
		expect(page).toContain('You are in line');
	});

	it('still honours a function template passed programmatically', () => {
		const wr = resolveWaitingRoom({
			maxConcurrent: 10,
			waitingRoom: { template: (c) => `fn:${c.queueDepth}` }
		});
		expect(wr.renderPage(5)).toBe('fn:5');
	});
});
