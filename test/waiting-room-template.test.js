import { describe, it, expect, vi } from 'vitest';
import adapter from '../src/index.js';
import {
	assertAccessibleWaitingDocument,
	buildAccessibleCapacityRefusalPage,
	buildWaitingRoomPage,
	createWaitingRoomRequest,
	negotiateRejection,
	renderWaitingRoomTemplate,
	resolveWaitingRoom,
	waitingRoomStatusText
} from '../src/runtime/utils.js';

function accessibleDocument(content, htmlAttributes = 'lang="en" dir="ltr"') {
	return '<!doctype html><html ' + htmlAttributes + '><head><meta charset="utf-8">' +
		'<title>Please wait</title></head><body><main><h1>Server at capacity</h1>' +
		'<p role="status" aria-live="polite" aria-atomic="true">' + content + '</p>' +
		'<form method="get"><button type="submit">Try again</button></form>' +
		'</main></body></html>';
}

describe('AccessibleWaitingDocument', () => {
	it('accepts the shared baseline and the minimal opted-out response', () => {
		expect(assertAccessibleWaitingDocument(accessibleDocument('Please wait.')))
			.toEqual({ lang: 'en', dir: 'ltr' });
		expect(assertAccessibleWaitingDocument(buildAccessibleCapacityRefusalPage()))
			.toEqual({ lang: 'en', dir: 'ltr' });
	});

	it.each([
		['doctype', (page) => page.replace('<!doctype html>', '')],
		['html language', (page) => page.replace(' lang="en"', '')],
		['text direction', (page) => page.replace(' dir="ltr"', '')],
		['title', (page) => page.replace('<title>Please wait</title>', '')],
		['main landmark', (page) => page.replace(/<\/?main>/g, '')],
		['main role', (page) => page.replace('<main>', '<main role="region">')],
		['status live region', (page) => page.replace(' role="status" aria-live="polite" aria-atomic="true"', '')],
		['enabled live region', (page) => page.replace('aria-live="polite"', 'aria-live="off"')],
		['recovery action', (page) => page.replace(/<form[\s\S]*?<\/form>/, '')]
	])('rejects a document without its %s', (_name, remove) => {
		expect(() => assertAccessibleWaitingDocument(remove(accessibleDocument('Please wait.'))))
			.toThrow(/AccessibleWaitingDocument/);
	});

	it.each([
		['comment-only structure', '<p>visible filler</p><!-- <main><p role="status">Wait</p><button>Retry</button></main> -->'],
		['template-only structure', '<p>visible filler</p><template><main><p role="status">Wait</p><button>Retry</button></main></template>'],
		['script-only structure', '<p>visible filler</p><script>"<main><p role=status>Wait</p><button>Retry</button></main>"</script>'],
		['a hidden baseline', '<main hidden><p role="status">Wait</p><button>Retry</button></main><p>visible filler</p>'],
		['an inert baseline', '<main inert><p role="status">Wait</p><button>Retry</button></main><p>visible filler</p>'],
		['an aria-hidden baseline', '<main aria-hidden="true"><p role="status">Wait</p><button>Retry</button></main><p>visible filler</p>'],
		['a visually hidden baseline', '<main style="display: none !important"><p role="status">Wait</p><button>Retry</button></main><p>visible filler</p>']
	])('rejects %s outside the exposed accessibility tree', (_name, body) => {
		const page = '<!doctype html><html lang="en" dir="ltr"><head><title>Wait</title></head><body>' +
			body + '</body></html>';
		expect(() => assertAccessibleWaitingDocument(page)).toThrow(/AccessibleWaitingDocument/);
	});

	it('does not treat later ARIA fallback roles as the effective baseline roles', () => {
		const page = '<!doctype html><html lang="en" dir="ltr"><head><title>Wait</title></head>' +
			'<body><div role="none main"><p role="none status">Wait</p>' +
			'<button>Retry</button></div></body></html>';
		expect(() => assertAccessibleWaitingDocument(page)).toThrow(/main landmark/);
	});

	it.each([
		['a disabled button', '<button disabled>Retry</button>'],
		['an aria-disabled button', '<button aria-disabled="true">Retry</button>'],
		['a button in a disabled fieldset', '<fieldset disabled><button>Retry</button></fieldset>'],
		['a link in an aria-disabled group', '<div aria-disabled="true"><a href="/retry">Retry</a></div>'],
		['an empty form', '<form method="get"></form>'],
		['an unsafe link', '<a href="javascript:location.reload()">Retry</a>'],
		['an empty link', '<a href="/retry"></a>']
	])('does not accept %s as the recovery action', (_name, recovery) => {
		const page = '<!doctype html><html lang="en" dir="ltr"><head><title>Wait</title></head>' +
			'<body><main><p role="status">Please wait.</p>' + recovery + '</main></body></html>';
		expect(() => assertAccessibleWaitingDocument(page)).toThrow(/recovery control|safe link/);
	});

	it('validates and canonicalizes the document language tag', () => {
		expect(assertAccessibleWaitingDocument(accessibleDocument('Wait.', 'lang="EN-us" dir="ltr"')))
			.toEqual({ lang: 'en-US', dir: 'ltr' });
		expect(() => assertAccessibleWaitingDocument(accessibleDocument('Wait.', 'lang="123" dir="ltr"')))
			.toThrow(/valid html\[lang\]/);
	});

	it('accepts the user-agent label of an enabled submit input as recovery', () => {
		const page = '<!doctype html><html lang="en" dir="ltr"><head><title>Wait</title></head>' +
			'<body><main><p role="status">Please wait.</p><form><input type="submit"></form></main></body></html>';
		expect(assertAccessibleWaitingDocument(page)).toEqual({ lang: 'en', dir: 'ltr' });
	});
});

describe('negotiateRejection', () => {
	it.each([
		['text/html', 'html'],
		['TEXT/HTML; charset=utf-8', 'html'],
		['text/html;q=0.5,application/json', 'html'],
		['text/html;q=0', 'retry'],
		['text/html;q=0.000', 'retry'],
		['text/html;q=bogus', 'retry'],
		['text/html;profile="a,b";q=0', 'retry'],
		['text/html;profile=";q=1";q=0', 'retry'],
		['text/html;profile="unterminated;q=1', 'retry'],
		['application/nottext/html', 'retry'],
		['text/*,*/*', 'retry'],
		['application/json', 'retry']
	])('negotiates %s as %s', (accept, expected) => {
		expect(negotiateRejection(accept)).toBe(expected);
	});

	it('never renders HTML for an actual WebSocket handshake', () => {
		expect(negotiateRejection('text/html', 'websocket')).toBe('retry');
		expect(negotiateRejection('text/html', 'h2c, WebSocket')).toBe('retry');
	});
});

describe('renderWaitingRoomTemplate', () => {
	const ctx = {
		queueDepth: 7,
		estimatedSeconds: 12,
		pollIntervalMs: 3000,
		retryAfterSeconds: 4,
		admitCheckPath: '/__admit-check',
		appName: 'Example App',
		statusUrl: 'https://status.example.test',
		supportUrl: '/help',
		incidentId: 'INC-42'
	};

	it('substitutes every supported token', () => {
		const out = renderWaitingRoomTemplate(
			'q={{queueDepth}} eta={{estimatedSeconds}} poll={{pollIntervalMs}} ' +
			'retry={{retryAfterSeconds}} check={{admitCheckPath}} app={{appName}} ' +
			'status={{statusUrl}} support={{supportUrl}} incident={{incidentId}}',
			ctx
		);
		expect(out).toBe(
			'q=7 eta=12 poll=3000 retry=4 check=/__admit-check app=Example App ' +
			'status=https://status.example.test support=/help incident=INC-42'
		);
	});

	it('rejects unknown tokens with the offending token and supported list', () => {
		expect(() => renderWaitingRoomTemplate('{{estimatedSecond}} {{queueDepth}}', ctx))
			.toThrow(/Unknown waiting-room template token "\{\{estimatedSecond\}\}".*Supported tokens:.*\{\{queueDepth\}\}/);
	});

	it('rejects unresolved opening syntax without rejecting ordinary closing braces', () => {
		expect(() => renderWaitingRoomTemplate('{{queueDepth}', ctx))
			.toThrow(/Unclosed waiting-room template token/);
		expect(renderWaitingRoomTemplate('body{color:red}}', ctx)).toBe('body{color:red}}');
	});

	it('renders the atomic token escape and passes every closing-brace run through verbatim', () => {
		expect(renderWaitingRoomTemplate(
			'literal={{{{queueDepth}}}} live={{queueDepth}} close=}}}}',
			ctx
		)).toBe('literal={{queueDepth}} live=7 close=}}}}');

		// Four-plus consecutive closing braces are ordinary nested CSS and
		// minified JavaScript; the old independent }}}} escape silently ate
		// two of them and broke both.
		const css = '@media(a){@supports(b){.c{d:e;&:hover{f:g}}}}';
		expect(renderWaitingRoomTemplate(css, ctx)).toBe(css);
		const js = '(function(){if(a){for(;;){if(b){c()}}}})()';
		expect(renderWaitingRoomTemplate(js, ctx)).toBe(js);
		expect(renderWaitingRoomTemplate('x=}}}}}', ctx)).toBe('x=}}}}}');
	});

	it('rejects a non-token quadruple-brace opener loudly instead of corrupting it', () => {
		expect(() => renderWaitingRoomTemplate('{{{{notatoken}}}}', ctx))
			.toThrow(/Unknown waiting-room template token/);
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

	it('HTML-escapes every optional identity token and drops script URLs', () => {
		const out = renderWaitingRoomTemplate(
			'{{appName}}|{{statusUrl}}|{{supportUrl}}|{{incidentId}}',
			{
				...ctx,
				appName: '<b>Example & Co.</b>',
				statusUrl: '/status?detail="<down>"',
				supportUrl: 'javascript:alert(1)',
				incidentId: 'INC-42<script>'
			}
		);
		expect(out).toBe(
			'&lt;b&gt;Example &amp; Co.&lt;/b&gt;|' +
			'/status?detail=&quot;&lt;down&gt;&quot;||INC-42&lt;script&gt;'
		);
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
		const wr = resolved(accessibleDocument('ahead: {{queueDepth}}'));
		const page = wr.renderResponse(3);
		expect(page.body).toContain('ahead: 3');
		expect(page.lang).toBe('en');
	});

	it('rejects a fragment at adapter construction and runtime resolution', () => {
		expect(() => resolved('<p>ahead: {{queueDepth}}</p>'))
			.toThrow(/AccessibleWaitingDocument/);
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: { template: '<p>ahead: {{queueDepth}}</p>' }
				}
			}
		})).toThrow(/AccessibleWaitingDocument/);
	});

	it('rejects an empty string template identically at runtime and adapter construction', () => {
		expect(() => resolved('')).toThrow(/AccessibleWaitingDocument/);
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: { template: '' }
				}
			}
		})).toThrow(/AccessibleWaitingDocument/);
	});

	it('rejects an invalid template while resolving runtime configuration', () => {
		expect(() => resolved('<p>{{queueDepht}}</p>'))
			.toThrow(/Unknown waiting-room template token "\{\{queueDepht\}\}"/);
	});

	it('rejects invalid production templates when the adapter is constructed', () => {
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: { template: '<p>{{queueDepht}}</p>' }
				}
			}
		})).toThrow(/Unknown waiting-room template token "\{\{queueDepht\}\}"/);
	});

	it('falls back to the built-in page when no template is set', () => {
		const wr = resolveWaitingRoom({ maxConcurrent: 10 });
		const page = wr.renderPage(2);
		expect(page).toContain('<!doctype html>');
		expect(page).toContain('Server at capacity');
	});

	it('passes configured identity fields through the resolved waiting room', () => {
		const wr = resolveWaitingRoom({
			maxConcurrent: 10,
			waitingRoom: {
				appName: 'Example App',
				statusUrl: '/status',
				supportUrl: 'https://help.example.test',
				incidentId: 'INC-42'
			}
		});
		const page = wr.renderPage(2);
		expect(page).toContain('<title>Example App - Waiting room</title>');
		expect(page).toContain('<a href="/status">Service status</a>');
		expect(page).toContain('<a href="https://help.example.test">Get help</a>');
		expect(page).toContain('Incident reference: <code>INC-42</code>');
	});

	it('renders a full localized document from request headers and owns its metadata', () => {
		let received;
		const wr = resolveWaitingRoom({
			maxConcurrent: 10,
			waitingRoom: {
				renderer(context) {
					received = context;
					const arabic = context.request.headers.get('accept-language')?.startsWith('ar');
					return {
						body: accessibleDocument('Localized ar', 'lang="wrong" dir="ltr" class="host"'),
						lang: arabic ? 'ar' : 'en',
						dir: arabic ? 'rtl' : 'ltr',
						headers: { 'content-security-policy': "default-src 'none'" }
					};
				}
			}
		});
		const request = createWaitingRoomRequest({
			getMethod: () => 'get',
			getUrl: () => '/hold',
			getQuery: () => 'from=upgrade',
			forEach(visitor) {
				visitor('accept-language', 'ar-EG');
				visitor('accept-language', 'ar;q=0.9');
			}
		});
		const page = wr.renderResponse(3, request);
		expect(received.request.method).toBe('GET');
		expect(received.request.url).toBe('/hold?from=upgrade');
		expect(received.request.headers.get('Accept-Language')).toBe('ar-EG, ar;q=0.9');
		expect(received.request.headers.get('missing')).toBeNull();
		expect(page.body).toContain('<html lang="ar" dir="rtl" class="host">');
		expect(page.lang).toBe('ar');
		expect(page.dir).toBe('rtl');
		expect(page.varyAcceptLanguage).toBe(true);
		expect(page.headers).toEqual([['content-security-policy', "default-src 'none'"]]);
	});

	it('falls back once to the built-in page when a renderer violates the synchronous contract', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const wr = resolveWaitingRoom({
				maxConcurrent: 10,
				waitingRoom: {
					renderer: async () => ({
						body: '<html></html>',
						lang: 'en',
						dir: 'ltr'
					})
				}
			});
			for (let index = 0; index < 2; index++) {
				const page = wr.renderResponse();
				expect(page.body).toContain('<title>Waiting room</title>');
				expect(page.lang).toBe('en');
				expect(page.varyAcceptLanguage).toBe(true);
			}
			expect(error).toHaveBeenCalledTimes(1);
		} finally {
			error.mockRestore();
		}
	});

	it('falls back when a renderer tries to override locale ownership or returns a fragment', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const ownedHeader = resolveWaitingRoom({
				maxConcurrent: 10,
				waitingRoom: {
					renderer: () => ({
						body: '<html></html>',
						lang: 'en',
						dir: 'ltr',
						headers: { vary: 'Origin' }
					})
				}
			});
			expect(ownedHeader.renderResponse().varyAcceptLanguage).toBe(true);

			const fragment = resolveWaitingRoom({
				maxConcurrent: 10,
				waitingRoom: {
					renderer: () => ({
						body: '<main>Please wait</main>',
						lang: 'en',
						dir: 'ltr'
					})
				}
			});
			expect(fragment.renderResponse().body).toContain('<!doctype html>');
			expect(error).toHaveBeenCalledTimes(2);
		} finally {
			error.mockRestore();
		}
	});

	it('rejects ambiguous production renderer configuration at adapter construction', () => {
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: { renderer: '   ' }
				}
			}
		})).toThrow(/must not be an empty module path/);
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: { renderer: () => ({}) }
				}
			}
		})).toThrow(/renderer must be a module path string/);
		expect(() => adapter({
			websocket: {
				upgradeAdmission: {
					maxConcurrent: 10,
					waitingRoom: {
						renderer: './src/lib/server/waiting-room.js',
						template: '<html></html>'
					}
				}
			}
		})).toThrow(/renderer and \.template are mutually exclusive/);
	});

	it('still honours a function template passed programmatically', () => {
		const wr = resolveWaitingRoom({
			maxConcurrent: 10,
			waitingRoom: { template: (c) => accessibleDocument(`fn:${c.queueDepth}`) }
		});
		expect(wr.renderPage(5)).toContain('fn:5');
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
		expect(page).toContain('<html lang="en" dir="ltr">');
		expect(page).toContain('<title>Waiting room</title>');
	});

	it('uses a neutral semantic light/dark palette with no adapter branding', () => {
		const page = buildWaitingRoomPage({});
		for (const name of [
			'--waiting-room-page-background',
			'--waiting-room-panel-background',
			'--waiting-room-text',
			'--waiting-room-muted-text',
			'--waiting-room-border',
			'--waiting-room-link',
			'--waiting-room-focus-ring'
		]) {
			expect(page).toContain(name);
		}
		expect(page).toContain('@media(prefers-color-scheme:dark)');
		expect(page).not.toMatch(/adapter-uws|lanteanio/i);
	});

	it('escapes built-in identity fields and omits unsafe links', () => {
		const page = buildWaitingRoomPage({
			appName: '<img src=x onerror=alert(1)>',
			statusUrl: '/status?detail="<down>"',
			supportUrl: 'javascript:alert(1)',
			incidentId: 'INC-42</code><script>alert(1)</script>'
		});
		expect(page).toContain(
			'<title>&lt;img src=x onerror=alert(1)&gt; - Waiting room</title>'
		);
		expect(page).toContain('<a href="/status?detail=&quot;&lt;down&gt;&quot;">Service status</a>');
		expect(page).not.toContain('href="javascript:');
		expect(page).toContain(
			'Incident reference: <code>INC-42&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code>'
		);
		expect(page).not.toContain('<img src=x');
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
