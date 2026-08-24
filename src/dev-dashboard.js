// The dev dashboard: one render path serving both the live page and the
// static diagnostic report.
//
// renderAppShell(snapshot, options) returns a complete self-contained HTML
// document - inline CSS, inline vanilla JS, the snapshot embedded as an
// application/json script tag. The SAME function renders the live dashboard
// (live: true, an EventSource keeps it current) and the shareable report file
// (live: false, opens from disk with no server). No build step, no static
// assets, no framework in the dependency graph: everything the browser needs
// is in the one string, and the page renders its data exclusively through DOM
// textContent, so the embedded JSON block is the only place data meets markup.
//
// This module is imported only by the uws() dev plugin. It never enters the
// production runtime graph.

import { runtimeVersionInfo } from './runtime/version-info.js';

/**
 * Cross-package contributor slot. `Symbol.for` because the bundler can hand
 * the dev plugin and an extensions package separate copies of this module - a
 * module-level Map in one copy is invisible to the other, while the global
 * symbol registry is shared by key. An extensions package therefore needs no
 * import from the adapter at all: it reaches the same registry through this
 * key and registers a section contributor.
 */
const CONTRIBUTORS_KEY = Symbol.for('svelte-adapter-uws.dashboard-contributors');

/** @returns {Map<string, (snapshot: object) => unknown>} */
export function dashboardContributors() {
	let m = /** @type {any} */ (globalThis)[CONTRIBUTORS_KEY];
	if (m === undefined) {
		m = new Map();
		/** @type {any} */ (globalThis)[CONTRIBUTORS_KEY] = m;
	}
	return m;
}

/**
 * Register a named section contributor. The contributor is called with the
 * composed snapshot core at build time and its return value lands under
 * `snapshot.sections[name]` - data only, rendered like every other reading
 * through DOM text. Registering the same name again replaces the previous
 * contributor, so a hot-reloaded module does not stack copies of itself.
 *
 * @param {string} name
 * @param {(snapshot: object) => unknown} contribute
 * @returns {() => void} removes this registration (a later replacement wins
 *   over the removal, matching last-registration-wins).
 */
export function registerDashboardContributor(name, contribute) {
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError('registerDashboardContributor: name must be a non-empty string');
	}
	if (typeof contribute !== 'function') {
		throw new TypeError('registerDashboardContributor: contribute must be a function');
	}
	const registry = dashboardContributors();
	registry.set(name, contribute);
	return () => {
		if (registry.get(name) === contribute) registry.delete(name);
	};
}

/**
 * Serialize a value for inlining into an HTML script block. `<` is escaped so
 * `</script>` inside a string value cannot terminate the block, and the two
 * Unicode line separators are escaped because they are valid JSON but were
 * historically invalid in JavaScript source - and some HTML processors
 * normalize them into real line breaks.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function inlineJsonForHtml(value) {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/**
 * Whether a fetched or streamed snapshot may replace the one on screen. Every
 * snapshot carries a monotonic sequence number; a response that raced a
 * slower path (a fetch answered after a newer streamed frame) is discarded,
 * so the page can never move backwards. This exact function is embedded into
 * the page's inline script, so the unit test and the browser run one source.
 *
 * @param {number} lastSeq
 * @param {unknown} nextSeq
 * @returns {boolean}
 */
export function acceptSnapshot(lastSeq, nextSeq) {
	return typeof nextSeq === 'number' && Number.isFinite(nextSeq) && nextSeq > lastSeq;
}

/**
 * The dashboard's request gate, pure over its inputs so it is testable
 * without a socket. Loopback-only, defended on three layers:
 *
 * - the SOCKET must be loopback: the dev server may be bound wide (`--host`),
 *   and diagnostics for every connection on the machine must not be readable
 *   from the network;
 * - the HOST header must name a loopback host. This is the DNS-rebinding
 *   defense: a hostile page can point its own domain's DNS at 127.0.0.1, and
 *   the victim's browser then reaches this listener over a genuine loopback
 *   socket - but it cannot forge the Host header, which still names the
 *   attacker's domain. A bare DNS name is refused even if it currently
 *   resolves to loopback, because what it resolves to is the attacker's
 *   choice;
 * - the ORIGIN header, when the browser sends one, must itself be a loopback
 *   origin, closing cross-site fetches from pages that already run on a
 *   non-loopback origin of this machine.
 *
 * @param {{ remoteAddress?: string | null, host?: string | null, origin?: string | null }} input
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function checkDashboardAccess(input) {
	if (!isLoopbackIp(input.remoteAddress)) {
		return { allowed: false, reason: 'socket is not loopback' };
	}
	if (!isLoopbackHostHeader(input.host)) {
		return { allowed: false, reason: 'host header is not a loopback host' };
	}
	if (typeof input.origin === 'string' && input.origin.length > 0) {
		let originHost;
		try {
			originHost = new URL(input.origin).hostname;
		} catch {
			return { allowed: false, reason: 'origin header does not parse' };
		}
		if (!isLoopbackHostname(originHost)) {
			return { allowed: false, reason: 'origin is not a loopback origin' };
		}
	}
	return { allowed: true };
}

/** @param {string | null | undefined} ip */
function isLoopbackIp(ip) {
	if (typeof ip !== 'string' || ip.length === 0) return false;
	let host = ip;
	if (host.startsWith('::ffff:')) host = host.slice(7);
	const zone = host.indexOf('%');
	if (zone !== -1) host = host.slice(0, zone);
	if (host === '::1') return true;
	return isIpv4InLoopbackBlock(host);
}

/**
 * Whether `host` is a COMPLETE IPv4 literal inside 127.0.0.0/8. A prefix test
 * like `startsWith('127.')` is the wrong tool here: it also matches the
 * hostname `127.evil.com`, which an attacker can register under their own
 * zone and rebind to loopback - so the Host/Origin gate would pass on a name
 * whose address is the attacker's choice, which is the whole rebinding attack.
 * Every octet must parse, so only a genuine 127.x.y.z address qualifies.
 *
 * @param {string} host
 */
function isIpv4InLoopbackBlock(host) {
	const parts = host.split('.');
	if (parts.length !== 4) return false;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return false;
		const n = Number(part);
		if (n > 255) return false;
	}
	return Number(parts[0]) === 127;
}

/**
 * The Host header carries `host[:port]`, with IPv6 literals in brackets.
 * Splitting on the LAST colon would cut an unbracketed IPv6 literal apart, so
 * brackets are handled first and a bare value with more than one colon is
 * treated as a hostless malformation and refused.
 *
 * @param {string | null | undefined} header
 */
function isLoopbackHostHeader(header) {
	if (typeof header !== 'string' || header.length === 0) return false;
	let host = header.trim();
	if (host.startsWith('[')) {
		const close = host.indexOf(']');
		if (close === -1) return false;
		const rest = host.slice(close + 1);
		if (rest !== '' && !/^:\d+$/.test(rest)) return false;
		host = host.slice(1, close);
	} else {
		const first = host.indexOf(':');
		if (first !== -1) {
			if (host.indexOf(':', first + 1) !== -1) return false;
			if (!/^\d+$/.test(host.slice(first + 1))) return false;
			host = host.slice(0, first);
		}
	}
	return isLoopbackHostname(host);
}

/** @param {string} hostname */
function isLoopbackHostname(hostname) {
	let host = hostname.toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (host === 'localhost' || host === 'localhost.') return true;
	return isLoopbackIp(host);
}

/**
 * Snapshot factory. The returned `next()` composes one dashboard snapshot
 * from the injected readers and stamps it with a strictly increasing
 * sequence number - one counter for the embedded snapshot, the SSE frames,
 * and the fetch endpoint, which is what makes the client's accept guard
 * meaningful across all three paths.
 *
 * Readers are injected rather than imported so the dev plugin passes its own
 * live structures; nothing here holds state beyond the counter.
 *
 * @param {{
 *   now: () => number,
 *   introspect: () => object,
 *   topicCounts: () => Map<string, number>
 * }} readers
 * @returns {() => object}
 */
export function createDashboardSnapshots(readers) {
	// Seed the counter from the clock, not from zero. A new snapshot factory
	// is built every time the dev server (re)starts, but an open page keeps
	// the last sequence it saw across that restart. A zero-based counter would
	// then hand the reconnected page numbers below what it already holds, and
	// its own freshness guard - which exists to stop a stale snapshot from
	// overwriting a fresh one - would discard every real snapshot until the
	// counter climbed back, turning the guard into a staleness lock. Epoch
	// milliseconds outrun the ~1/second consumption by a factor of a thousand,
	// so a restart always resumes above any number a prior session issued, and
	// the value stays strictly increasing within a session (including under a
	// frozen test clock, where each call still adds one).
	let seq = Math.floor(readers.now());
	return () => {
		seq += 1;
		const topics = [];
		const presence = [];
		const cursors = [];
		for (const [topic, subscribers] of readers.topicCounts()) {
			// Derived channels are presented as what they are instead of
			// leaking the `__`-prefixed transport spelling into the tables.
			if (topic.startsWith('__presence:')) {
				presence.push({ topic: topic.slice('__presence:'.length), watchers: subscribers });
			} else if (topic.startsWith('__cursor:')) {
				cursors.push({ topic: topic.slice('__cursor:'.length), watchers: subscribers });
			} else {
				topics.push({ topic, subscribers });
			}
		}
		topics.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
		presence.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
		cursors.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));

		const snapshot = {
			seq,
			at: readers.now(),
			mode: 'dev',
			// Single-process by construction: the dev plugin never clusters, and
			// saying so beats omitting the reading the production page will have.
			workers: { expected: 1, reporting: 1 },
			versions: { ...runtimeVersionInfo },
			introspect: readers.introspect(),
			topics,
			presence,
			cursors,
			/** @type {Record<string, unknown>} */
			sections: {}
		};
		for (const [name, contribute] of dashboardContributors()) {
			// A broken contributor loses its own section, never the dashboard -
			// and "broken" covers a section that cannot be serialized as well as
			// one that throws. The whole snapshot is JSON.stringify'd downstream
			// (the embedded block, the /snapshot body, every SSE frame), and the
			// SSE serialization runs inside a timer callback where an uncaught
			// throw would take the dev process down. So each section is proven
			// serializable HERE, inside the guard, before it can reach any of
			// those paths; a BigInt or a cycle becomes this section's error, not
			// a crash the whole page shares.
			try {
				const produced = contribute(snapshot);
				JSON.stringify(produced);
				snapshot.sections[name] = produced;
			} catch (err) {
				snapshot.sections[name] = { error: String(err && /** @type {any} */ (err).message || err) };
			}
		}
		return snapshot;
	};
}

/**
 * Render the complete self-contained document.
 *
 * @param {object} snapshot
 * @param {{ live: boolean, basePath: string }} options `basePath` is the
 *   dashboard mount path; the live page derives its stream, refresh, and
 *   report URLs from it.
 * @returns {string}
 */
export function renderAppShell(snapshot, options) {
	const live = options.live === true;
	const basePath = String(options.basePath);
	return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
		+ '<meta name="color-scheme" content="light dark">\n'
		+ '<title>' + (live ? 'uws dev dashboard' : 'uws diagnostic report') + '</title>\n'
		+ '<style>' + SHELL_CSS + '</style>\n'
		+ '</head>\n<body>\n'
		+ '<script type="application/json" id="uws-dash-snapshot">'
		+ inlineJsonForHtml(snapshot)
		+ '</script>\n'
		+ '<script type="application/json" id="uws-dash-config">'
		+ inlineJsonForHtml({ live, basePath })
		+ '</script>\n'
		+ '<main id="app"></main>\n'
		+ '<script>\n'
		+ 'var acceptSnapshot = ' + acceptSnapshot.toString() + ';\n'
		+ SHELL_JS
		+ '</script>\n'
		+ '</body>\n</html>\n';
}

// Plain, readable, both color schemes; nothing here is data-dependent.
const SHELL_CSS = [
	':root{color-scheme:light dark;--bg:#f6f7f9;--card:#ffffff;--ink:#1c2733;--muted:#5c6b7a;--line:#dde3ea;--ok:#1a7f37;--warn:#b54708;--bad:#b42318;--accent:#175cd3}',
	'@media (prefers-color-scheme:dark){:root{--bg:#0f1520;--card:#182231;--ink:#e6edf3;--muted:#94a3b3;--line:#2b3949;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}}',
	'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
	'main{max-width:1080px;margin:0 auto;padding:20px}',
	'header{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;justify-content:space-between;margin-bottom:14px}',
	'h1{font-size:18px;margin:0}h2{font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}',
	'.meta{color:var(--muted);font-size:12px}.meta a{color:var(--accent)}',
	'.badge{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;border:1px solid var(--line)}',
	'.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}',
	'.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}',
	'.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}',
	'.tile .v{font-size:22px;font-variant-numeric:tabular-nums}.tile .k{color:var(--muted);font-size:12px}',
	'section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px;overflow-x:auto}',
	'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}',
	'th{color:var(--muted);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}',
	'.empty{color:var(--muted)}pre{margin:0;white-space:pre-wrap;word-break:break-word}'
].join('\n');

// Vanilla, framework-free, DOM-built: every reading lands via textContent, so
// snapshot data can never become markup. Kept dumb on purpose - the page is a
// diagnostic surface, not an app.
const SHELL_JS = String.raw`(function () {
	'use strict';
	var snapshot = JSON.parse(document.getElementById('uws-dash-snapshot').textContent);
	var config = JSON.parse(document.getElementById('uws-dash-config').textContent);
	var lastSeq = -Infinity;
	var app = document.getElementById('app');

	function el(tag, cls, text) {
		var node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = String(text);
		return node;
	}
	function tile(label, value) {
		var t = el('div', 'tile');
		t.appendChild(el('div', 'v', value));
		t.appendChild(el('div', 'k', label));
		return t;
	}
	function table(headers, rows) {
		var t = el('table'), tr = el('tr');
		headers.forEach(function (h) { tr.appendChild(el('th', null, h)); });
		t.appendChild(tr);
		rows.forEach(function (row) {
			var r = el('tr');
			row.forEach(function (cell) { r.appendChild(el('td', null, cell)); });
			t.appendChild(r);
		});
		return t;
	}
	function section(title, node) {
		var s = el('section');
		s.appendChild(el('h2', null, title));
		s.appendChild(node);
		return s;
	}

	function render(s) {
		lastSeq = s.seq;
		app.textContent = '';
		var head = el('header');
		var left = el('div');
		left.appendChild(el('h1', null, config.live ? 'uws dev dashboard' : 'uws diagnostic report'));
		var v = s.versions || {};
		left.appendChild(el('div', 'meta',
			'adapter ' + (v.adapter || '?') + ' | protocol r' + (v.protocolRevision != null ? v.protocolRevision : '?')
			+ (v.realtime ? ' | realtime ' + v.realtime : '') + (v.extensions ? ' | extensions ' + v.extensions : '')));
		head.appendChild(left);
		var right = el('div', 'meta');
		var p = (s.introspect && s.introspect.pressure) || {};
		var badge = el('span', 'badge ' + (p.active ? 'bad' : 'ok'), p.active ? 'pressure: ' + p.reason : 'no pressure');
		right.appendChild(badge);
		right.appendChild(document.createTextNode(' seq ' + s.seq + ' | ' + new Date(s.at).toISOString() + ' ')); // determinism-allow: inline browser script (a string in SHELL_JS, never runtime-executed) formatting the snapshot's seam-stamped timestamp for display
		if (config.live) {
			var report = document.createElement('a');
			report.href = config.basePath + '/report';
			report.textContent = 'download diagnostic report';
			right.appendChild(report);
		}
		head.appendChild(right);
		app.appendChild(head);

		var intro = s.introspect || {};
		var grid = el('div', 'grid');
		grid.appendChild(tile('connections', intro.connections != null ? intro.connections : '?'));
		grid.appendChild(tile('topics', (s.topics || []).length));
		grid.appendChild(tile('protection', intro.protection || '?'));
		grid.appendChild(tile('workers', (s.workers ? s.workers.reporting + '/' + s.workers.expected : '?')));
		grid.appendChild(tile('publish rate/s', p.publishRate != null ? p.publishRate : '?'));
		grid.appendChild(tile('memory MB', p.memoryMB != null ? p.memoryMB : '?'));
		grid.appendChild(tile('backpressured', p.backpressuredConnections != null ? p.backpressuredConnections : '?'));
		grid.appendChild(tile('dropped frames', p.droppedFrames != null ? p.droppedFrames : '?'));
		app.appendChild(grid);

		var topics = s.topics || [];
		app.appendChild(section('topics', topics.length
			? table(['topic', 'subscribers'], topics.map(function (t) { return [t.topic, t.subscribers]; }))
			: el('div', 'empty', 'no live subscriptions')));

		var presence = s.presence || [];
		var cursors = s.cursors || [];
		if (presence.length || cursors.length) {
			var rows = presence.map(function (t) { return ['presence', t.topic, t.watchers]; })
				.concat(cursors.map(function (t) { return ['cursor', t.topic, t.watchers]; }));
			app.appendChild(section('presence and cursors', table(['lane', 'topic', 'watchers'], rows)));
		}

		var egress = p.egress || {};
		app.appendChild(section('egress', table(['deliveries', 'bytes', 'refused (topic)', 'refused (tenant)'],
			[[egress.deliveries || 0, egress.bytes || 0, egress.refusedTopic || 0, egress.refusedTenant || 0]])));

		Object.keys(s.sections || {}).forEach(function (name) {
			var body = el('pre');
			body.textContent = JSON.stringify(s.sections[name], null, 2);
			app.appendChild(section(name, body));
		});
	}

	render(snapshot);
	if (!config.live) return;

	function apply(next) {
		if (acceptSnapshot(lastSeq, next && next.seq)) render(next);
	}
	var source = new EventSource(config.basePath + '/events');
	source.onmessage = function (event) {
		try { apply(JSON.parse(event.data)); } catch (ignored) {}
	};
	// The fetch path exists for the reconnect gap; the accept guard is what
	// keeps a slow response from racing the stream backwards.
	source.onerror = function () {
		fetch(config.basePath + '/snapshot', { headers: { accept: 'application/json' } })
			.then(function (res) { return res.ok ? res.json() : null; })
			.then(function (next) { if (next) apply(next); })
			.catch(function (ignored) {});
	};
})();
`;
