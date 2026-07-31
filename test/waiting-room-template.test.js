import { describe, it, expect } from 'vitest';
import {
	buildWaitingRoomPage,
	renderWaitingRoomTemplate,
	resolveWaitingRoom,
	waitingRoomStatusText
} from '../src/runtime/utils.js';

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
		expect(page).toContain('Server at capacity');
	});

	it('still honours a function template passed programmatically', () => {
		const wr = resolveWaitingRoom({
			maxConcurrent: 10,
			waitingRoom: { template: (c) => `fn:${c.queueDepth}` }
		});
		expect(wr.renderPage(5)).toBe('fn:5');
	});
});

describe('waitingRoomStatusText', () => {
	it('reads as a crowd size, never a position or a wait', () => {
		const line = waitingRoomStatusText(6);
		expect(line).toBe('About 6 people are waiting for a free slot.');
		expect(line).not.toMatch(/ahead|in line|position|estimated|second/i);
	});

	it('agrees the verb and the noun with the count', () => {
		expect(waitingRoomStatusText(1)).toBe('About 1 person is waiting for a free slot.');
		expect(waitingRoomStatusText(2)).toBe('About 2 people are waiting for a free slot.');
	});

	it('renders nothing countable for an empty or unknown room', () => {
		for (const n of [0, -4, NaN, undefined, null]) {
			expect(waitingRoomStatusText(n)).toBe('Waiting for a free slot.');
		}
	});

	it('buckets the estimate so it cannot chatter by ones', () => {
		expect(waitingRoomStatusText(9)).toContain('About 9 ');
		expect(waitingRoomStatusText(14)).toContain('About 10 ');
		expect(waitingRoomStatusText(15)).toContain('About 20 ');
		expect(waitingRoomStatusText(95)).toContain('About 100 ');
	});

	it('groups large counts with an explicit locale', () => {
		expect(waitingRoomStatusText(1234)).toBe('About 1,200 people are waiting for a free slot.');
	});

	it('is embeddable in a script element (no early close, self-contained)', () => {
		const src = String(waitingRoomStatusText);
		expect(src).not.toContain('</');
		// A module-scope read would resolve on the server and be undefined in the
		// browser copy, so the body must reference only its own argument.
		expect(src).not.toMatch(/\bANNOUNCE_FLOOR_MS\b|\brandomFloat\b|\bsetImmediateTimer\b/);
	});
});

/**
 * Read one element out of the emitted page: its tag, its attributes and its
 * first-paint text. The stub document below is built from this, so the script
 * is driven against the markup the server really sends rather than a
 * hand-written approximation of it.
 */
function parseElement(page, id) {
	const m = page.match(new RegExp('<([a-z0-9]+)([^>]*\\bid="' + id + '"[^>]*)>([^<]*)'));
	if (!m) throw new Error('no element with id "' + id + '" in the emitted page');
	/** @type {Record<string, string>} */
	const attrs = {};
	const attrRe = /([a-z-]+)(?:="([^"]*)")?/g;
	let a;
	while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = a[2] === undefined ? '' : a[2];
	return { tag: m[1], attrs, text: m[3] };
}

function stubElement(parsed) {
	return {
		tag: parsed.tag,
		textContent: parsed.text,
		hidden: Object.prototype.hasOwnProperty.call(parsed.attrs, 'hidden'),
		attrs: { ...parsed.attrs },
		clicks: [],
		setAttribute(name, value) { this.attrs[name] = String(value); },
		addEventListener(type, fn) { if (type === 'click') this.clicks.push(fn); },
		click() { for (const fn of this.clicks) fn(); }
	};
}

/**
 * Execute the page's real inline script against a stub document, clock, timer
 * and fetch. Nothing here re-implements the script: it is sliced out of the
 * emitted HTML and evaluated, so a change to the shipped page changes what
 * these tests observe.
 */
function runHoldingPage(page) {
	const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.indexOf('</script>'));
	const els = {
		s: stubElement(parseElement(page, 's')),
		p: stubElement(parseElement(page, 'p')),
		c: stubElement(parseElement(page, 'c'))
	};
	/** @type {Array<() => void>} */
	const timers = [];
	let clock = 1e6;
	let reloads = 0;
	let programmed = null;

	const env = {
		els,
		get status() { return els.s.textContent; },
		get live() { return els.s.attrs['aria-live']; },
		get reloads() { return reloads; },
		get scheduled() { return timers.length; },
		advance(ms) { clock += ms; },
		/** Park the document's focus on one of the page's controls. */
		focus(el) { doc.activeElement = el; },
		/**
		 * Fire the pending poll with a programmed outcome and settle the whole
		 * promise chain. `{ fail: true }` is a network error; otherwise pass the
		 * status and JSON body the poll endpoint would return.
		 */
		async poll(outcome) {
			const timer = timers.shift();
			if (!timer) throw new Error('the page scheduled no further poll');
			programmed = outcome;
			timer();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	};

	const doc = { getElementById: (id) => els[id], activeElement: null };
	const fetchStub = () => {
		const o = programmed;
		programmed = null;
		if (!o || o.fail) return Promise.reject(new Error('network'));
		return Promise.resolve({ status: o.status, json: () => Promise.resolve(o.body) });
	};
	const timerStub = (fn) => { timers.push(fn); };
	const locationStub = { reload() { reloads++; } };
	const dateStub = { now: () => clock };
	const mathStub = Object.create(Math);
	mathStub.random = () => 0;

	// eslint-disable-next-line no-new-func -- the page's own script text is the subject
	const run = new Function('document', 'fetch', 'setTimeout', 'location', 'Math', 'Date', script);
	run(doc, fetchStub, timerStub, locationStub, mathStub, dateStub);
	return env;
}

const busy = (queueDepth) => ({ status: 202, body: { admit: false, queueDepth, pollAfterMs: 2000 } });
const free = { status: 200, body: { admit: true } };

describe('the built-in holding page', () => {
	it('claims no queue position and no wait estimate', () => {
		const page = buildWaitingRoomPage({ queueDepth: 4, pollIntervalMs: 2000 });
		expect(page).not.toMatch(/in line|Ahead of you|Estimated wait/i);
		expect(page).toContain('<h1>Server at capacity</h1>');
	});

	it('opens on the neutral line when the caller seeds no depth', () => {
		const page = buildWaitingRoomPage({});
		expect(parseElement(page, 's').text).toBe('Waiting for a free slot.');
		expect(page).not.toContain('About 0');
	});

	it('agrees the first-paint grammar with the seeded depth', () => {
		expect(parseElement(buildWaitingRoomPage({ queueDepth: 1 }), 's').text)
			.toBe('About 1 person is waiting for a free slot.');
		expect(parseElement(buildWaitingRoomPage({ queueDepth: 3 }), 's').text)
			.toBe('About 3 people are waiting for a free slot.');
	});

	it('carries a persistent status region at first paint', () => {
		const s = parseElement(buildWaitingRoomPage({ queueDepth: 2 }), 's');
		expect(s.attrs.role).toBe('status');
		expect(s.attrs['aria-live']).toBe('polite');
		expect(s.attrs['aria-atomic']).toBe('true');
	});

	it('carries a named pause control and a focus indicator', () => {
		const page = buildWaitingRoomPage({ queueDepth: 2 });
		const p = parseElement(page, 'p');
		expect(p.tag).toBe('button');
		expect(p.attrs.type).toBe('button');
		expect(p.attrs['aria-pressed']).toBe('false');
		expect(p.text).toBe('Pause live updates');
		expect(page).toContain('button:focus-visible');
	});

	it('keeps the document baseline (language, title)', () => {
		const page = buildWaitingRoomPage({});
		expect(page).toContain('<html lang="en">');
		expect(page).toContain('<title>Waiting room</title>');
	});
});

describe('the holding page script', () => {
	const page = () => buildWaitingRoomPage({ queueDepth: 0, pollIntervalMs: 2000 });

	it('writes the polled count into the status region with agreed grammar', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(1));
		expect(env.status).toBe(waitingRoomStatusText(1));
		env.advance(60000);
		await env.poll(busy(5));
		expect(env.status).toBe(waitingRoomStatusText(5));
	});

	it('does not rewrite the region again inside the announce floor', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(4));
		expect(env.status).toBe(waitingRoomStatusText(4));
		env.advance(3000);
		await env.poll(busy(30));
		expect(env.status).toBe(waitingRoomStatusText(4));
		env.advance(11000);
		await env.poll(busy(30));
		expect(env.status).toBe(waitingRoomStatusText(30));
	});

	it('surfaces a failed check instead of retrying behind a stale count', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(4));
		env.advance(2000); // inside the floor: the state change must still land
		await env.poll({ fail: true });
		expect(env.status).toBe('The last check did not reach the server. Retrying.');
		expect(env.scheduled).toBe(1);
	});

	it('announces the recovery as soon as a check gets through again', async () => {
		const env = runHoldingPage(page());
		await env.poll({ fail: true });
		await env.poll(busy(7));
		expect(env.status).toBe(waitingRoomStatusText(7));
	});

	it('reloads by itself when a slot opens', async () => {
		const env = runHoldingPage(page());
		await env.poll(free);
		expect(env.reloads).toBe(1);
	});

	it('freezes the region while paused and keeps checking', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(4));
		env.els.p.click();
		expect(env.els.p.attrs['aria-pressed']).toBe('true');
		expect(env.els.p.textContent).toBe('Resume live updates');
		expect(env.status).toContain('Live updates paused.');
		// The region is never muted: what a paused page says is decided by which
		// rewrites it performs, and it still has to be able to confirm the press
		// that paused it and to announce a free slot.
		expect(env.live).toBe('polite');

		env.advance(60000);
		await env.poll(busy(40));
		expect(env.status).toContain('Live updates paused.');
		expect(env.scheduled).toBe(1);
	});

	it('keeps the paused wording through a failed check and its recovery', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(4));
		env.els.p.click();
		const frozen = env.status;
		expect(frozen).toContain('Live updates paused.');

		env.advance(60000);
		await env.poll({ fail: true });
		expect(env.status).toBe(frozen);
		env.advance(60000);
		await env.poll(busy(90));
		expect(env.status).toBe(frozen);
		expect(env.scheduled).toBe(1);

		// The blip left no residue: resuming lands on the count the last check
		// carried, not on a stale one frozen mid-blip and not on a retry notice.
		env.els.p.click();
		expect(env.status).toBe(waitingRoomStatusText(90));
	});

	it('resumes into the current state on the second press', async () => {
		const env = runHoldingPage(page());
		await env.poll(busy(4));
		env.els.p.click();
		env.advance(60000);
		await env.poll(busy(40));
		env.els.p.click();
		expect(env.els.p.attrs['aria-pressed']).toBe('false');
		expect(env.els.p.textContent).toBe('Pause live updates');
		expect(env.live).toBe('polite');
		expect(env.status).toBe(waitingRoomStatusText(40));
	});

	it('hands a paused visitor the reload instead of navigating for them', async () => {
		const env = runHoldingPage(page());
		env.els.p.click();
		await env.poll(free);
		expect(env.reloads).toBe(0);
		expect(env.els.c.hidden).toBe(false);
		// The pause control keeps its place: hiding it would drop the focus of a
		// visitor still resting on it.
		expect(env.els.p.hidden).toBe(false);
		expect(env.live).toBe('polite');
		expect(env.status).toBe('A slot is open. Choose Reload now to continue.');

		// Pressing pause again is not a reason to replace the only news on the
		// page with a paused notice that contradicts the visible button.
		env.els.p.click();
		env.els.p.click();
		expect(env.status).toBe('A slot is open. Choose Reload now to continue.');

		env.els.c.click();
		expect(env.reloads).toBe(1);
	});

	it('keeps polling after an offered slot so a dead page cannot outlive it', async () => {
		const env = runHoldingPage(page());
		env.els.p.click();
		await env.poll(free);
		expect(env.scheduled).toBe(1);

		// The check reads live capacity and reserves nothing, so the offer has to
		// be withdrawn - and said out loud - once somebody else takes the slot.
		env.advance(60000);
		await env.poll(busy(12));
		expect(env.els.c.hidden).toBe(true);
		expect(env.status).toContain('That slot was taken');
		expect(env.status).toContain('keeps checking');
		expect(env.scheduled).toBe(1);

		// Still paused: the count behind the withdrawal stays out of the region.
		env.advance(60000);
		await env.poll(busy(300));
		expect(env.status).toContain('That slot was taken');

		// A slot opening again is news a second time.
		env.advance(60000);
		await env.poll(free);
		expect(env.els.c.hidden).toBe(false);
		expect(env.status).toBe('A slot is open. Choose Reload now to continue.');
		expect(env.reloads).toBe(0);
	});

	it('does not pull the reload control out from under a visitor pressing it', async () => {
		const env = runHoldingPage(page());
		env.els.p.click();
		await env.poll(free);
		env.focus(env.els.c);

		env.advance(60000);
		await env.poll(busy(12));
		expect(env.els.c.hidden).toBe(false);
		expect(env.status).toContain('That slot was taken');
	});

	it('re-checks rather than navigating when the visitor resumes', async () => {
		const env = runHoldingPage(page());
		env.els.p.click();
		await env.poll(free);
		env.els.p.click();
		// Resuming restores the automatic reload but does not act on a reading
		// that is already a poll interval old.
		expect(env.reloads).toBe(0);
		expect(env.scheduled).toBe(1);
		await env.poll(free);
		expect(env.reloads).toBe(1);
	});

	it('drops the record of a missed slot when the pause is over', async () => {
		const env = runHoldingPage(page());
		env.els.p.click();
		await env.poll(free);
		env.advance(60000);
		await env.poll(busy(12));
		expect(env.status).toContain('That slot was taken');

		env.els.p.click();
		expect(env.status).toBe(waitingRoomStatusText(12));
		env.advance(60000);
		env.els.p.click();
		expect(env.status).toContain('Live updates paused.');
		expect(env.status).not.toContain('That slot was taken');
	});
});
