#!/usr/bin/env node
/**
 * Every console-printed FAILURE on a server surface is either indexed or
 * deliberately not, and this gate is where that decision is recorded.
 *
 * docs/errors.md is generated from the error registry, so it can only ever
 * describe lines that go THROUGH the registry. Nothing enumerated the ones
 * that do not: a `console.error('[ws] something broke:', err)` added anywhere
 * printed an operator-facing failure that no search of the reference could
 * resolve, and both existing gates passed it - the attribution gate accepts
 * any owned family tag such as `[ws]`, and the reference generator only walks
 * entries that already exist.
 *
 * So this gate starts from the CALL SITES instead. Every console failure on a
 * scanned surface must be one of:
 *
 *   - printed through `adapterConsoleLine(ADAPTER_ERROR_IDS.X, ...)`, where X
 *     resolves to a real console-emitting registry entry whose severity agrees
 *     with the console method - which puts the line in docs/errors.md and makes
 *     the emitted text the registry's own prefix;
 *   - printed through a diagnostic formatter, which enters the structured
 *     diagnostic pipeline and is indexed by its event name; or
 *   - named in UNINDEXED below, with a reason for why an operator who saw the
 *     line needs no reference entry.
 *
 * Anything else fails.
 *
 * THE KEY IS THE WHOLE STATIC SKELETON of the printed text - every literal
 * part it will always contain, with `{}` where a value is interpolated, and
 * nothing dropped. Two weaker keys came first and both let a decision cover
 * text nobody had judged: the leading literal alone (two failures in one file
 * share a tag), and the skeleton truncated for readability (rewording the tail
 * of a long advisory - the remediation a reason describes - kept the key). The
 * whole skeleton is what an operator would recognise, so a line that MOVES
 * keeps its decision and a line that is REWORDED loses it and comes back for a
 * fresh one. It is NOT collision-proof - the key collapses whitespace runs, so
 * two lines differing only there produce one key, and an object literal keeps
 * the last of a duplicate silently - which is why the collision check below
 * stayed. A stale entry, matching nothing, fails too. Two spellings of one
 * printed line can also key differently: a template's RAW text is read, so a
 * `\n` written in a template survives as the two literal characters while the
 * same line built from concatenated string literals carries a real newline.
 *
 * SCOPE is EVERY module under `src`, minus a named list of exclusions with a
 * reason each (EXCLUDED below). Listing what is scanned instead of what is not
 * was the wrong way round: ten server-side modules were in neither list, so a
 * failure added to one of them would have shipped unindexed and green while
 * the generated document claimed complete coverage. Default-in means a NEW
 * file is covered the day it is added. `console.log`/`info`/`debug` are not
 * failures.
 *
 * WHAT IT CANNOT SEE, stated so nobody mistakes the gate for a proof. It reads
 * one module at a time and follows a console printer as far as a local binding:
 * a declaration, an object-pattern destructuring, a parameter or destructuring
 * default, a later assignment, `.bind(console)`, and a binding of the bare
 * `console` identifier. What still evades it, in one module: a binding of a
 * QUALIFIED console (`const c = globalThis.console`), a printer stored on an
 * object property (`obj.log = console.error`), one that arrives as an argument
 * to a function with no default, one imported from another module, and a line
 * whose text is built at runtime - the last of which also means a recorded
 * reason can vouch for words the key never saw. Alias resolution is by NAME
 * and blind to scope, so a module that binds `log` to console in one function
 * has every other `log(...)` in it treated as a console failure - a false
 * positive rather than a hole, and none exists in the tree today. All of this
 * needs whole-program analysis, which is not worth its cost here: the shapes
 * this gate does catch are the ones every failure in the tree actually used,
 * and `process.stderr.write` is refused outright.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'src');

/**
 * Modules under `src` this gate does NOT read, and why. Everything else is
 * scanned, so a file that belongs here has to be put here deliberately.
 */
export const EXCLUDED = new Map(Object.entries({
	'index.js': 'the build-time adapter; its output is build-log text an operator never sees at runtime',
	'client.js': 'the browser client, printing into devtools for the developer of the page rather than the operator of the server',
	'client-runtime.js': 'browser client internals, same audience as client.js',
	'plugins/channels/client.js': 'browser half of the plugin',
	'plugins/crdt/client.js': 'browser half of the plugin',
	'plugins/cursor/client.js': 'browser half of the plugin',
	'plugins/cursor/cursor-worker.js': 'runs in a browser worker',
	'plugins/cursor/render/index.js': 'browser renderer',
	'plugins/cursor/render/canvas2d.js': 'browser renderer',
	'plugins/cursor/render/webgl2.js': 'browser renderer',
	'plugins/cursor/render/webgpu.js': 'browser renderer',
	'plugins/groups/client.js': 'browser half of the plugin',
	'plugins/presence/client.js': 'browser half of the plugin',
	'plugins/replay/client.js': 'browser half of the plugin',
	'plugins/smooth/client.js': 'browser half of the plugin'
}));

/** Formatters whose output is a structured diagnostic event, indexed by event name. */
const PIPELINE_FORMATTERS = new Set(['formatDiagnostic', 'formatOperationalDiagnostic', 'assertionDiagnostic']);

/** Console methods that print a failure. */
const FAILURE_METHODS = new Set(['warn', 'error']);

const ENTRY_BY_ID = new Map(ADAPTER_ERROR_REGISTRY.map((entry) => [entry.id, entry]));

/**
 * Console failures that stay out of the reference, and why. The key is
 * `<path under src>::<static skeleton of the printed text>`.
 *
 * The bar for an entry here: an operator who reads this line needs nothing
 * the reference could add - because the line is a developer-only debug aid,
 * because it merely narrates a decision whose real failure is indexed
 * elsewhere, or because the line already carries its own complete guidance
 * and a stable route.
 */
export const UNINDEXED = new Map(Object.entries({
	// Debug-gated: printed only under the WS debug flag, for someone reading
	// their own wire codec.
	'runtime/handler/wire-state.js::[ws] wire.state.onAttach threw for': 'debug-flag-gated aid for the author of the codec, not an operator-facing failure',
	'runtime/handler/wire-state.js::[ws] wire.state.onDetach threw': 'debug-flag-gated aid for the author of the codec, not an operator-facing failure',

	// Teardown mechanics that accompany an indexed line, or an escalation whose
	// root cause surfaces through its own entry.
	'runtime/index.js::[primary] hard exit with {} live worker(s); SIGKILL for a clean teardown (orchestrator respawns).': 'teardown mechanics printed after the failure that caused the hard exit, which is indexed either way - ADAPTER-ERR-WORKER-RESTART-LIMIT when the restart budget is spent, ADAPTER-ERR-LISTEN when the acceptor cannot listen',
	'runtime/index.js::[primary] reconciled {} stranded worker slot(s)': 'self-heal notice: the primary recovered stranded slots, nothing is left for an operator to act on',
	'runtime/index.js::[primary] asking minority worker %d to exit to re-converge (RESTART_ON_STATE_DIVERGENCE=1)': 'the action taken after the indexed divergence line, which carries the cause',
	'runtime/index.js::[primary] relay-gap worker=%d frames=%d': 'the relay-gap failure is indexed; this is the primary echoing the worker report',
	'runtime/index.js::[primary] asking worker %d to exit to re-sync after a relay gap (RESTART_ON_STATE_DIVERGENCE=1)': 'the action taken after the indexed relay-gap line, which carries the cause',
	'runtime/index.js::[svelte-adapter-uws] {}Shutdown finished in {}ms but was NOT clean (see the lines above).': 'a summary of the indexed shutdown failures printed above it',

	// The rest, grouped by what makes each one need no entry.
	//
	// THE DEV-SERVER AND TEST-HARNESS LINES need one rule stated once, because
	// the same commit routes some of them through the registry and leaves
	// others here, and that looks arbitrary otherwise. A harness line is
	// rerouted when a CONSOLE entry for that failure already exists, because
	// then the production text and the harness text are the same words and
	// sharing the id costs nothing. It stays here when the production runtime
	// reports that failure as a diagnostic EVENT: minting a console entry for
	// it would put text in the operator reference that no production server can
	// ever print. What makes that acceptable is who is reading - the dev server
	// and createTestServer print to a developer who has the stack trace and the
	// source in front of them, while the operator of a production server never
	// sees these lines at all. The reason on each says which twin covers it.
	//
	// TWO DELIBERATE EXCEPTIONS, so the rule is not read as absolute: both
	// sendTo async-filter twins stay here even though a console entry exists
	// for that failure. Rerouting them would replace their `[adapter-uws]` and
	// `[adapter-uws/testing]` tags with the production `[ws]`, and those tags
	// are the only thing in the line that says which server printed it - a
	// developer running both at once would lose that. The guidance and the
	// short link are identical either way, so the reroute would buy nothing.
	"plugins/_shared/sensitive.js::[svelte-adapter-uws] [{}] dropped the field '{}' from the default projection - its name reads as credentials, personal data or transport metadata, and the default never broadcasts those to peers. If this field is safe to share, pass an explicit select, e.g. select: (ud) => ({ {} }).": "privacy default doing its job: names the dropped field and the explicit select that keeps it",
	"plugins/_shared/sensitive.js::[svelte-adapter-uws] [{}] dropped the field '{}' from the default projection, and has now reported {} distinct dropped names - further ones are suppressed. A flood of distinct names here means they are coming from the wire (an upgrade hook spreading the request context), not from your own fields.": "the suppression notice for the line above it, and it says what a flood of distinct names means",
	"plugins/groups/server.js::[group {}] async onJoin rejected after being refused:": "the refusal already threw a named error to the caller; this reports the late rejection of a hook that was told to be synchronous",
	"plugins/presence/server.js::[svelte-adapter-uws] presence.update(): field '{}' is reserved and was dropped. Reserved names are the dedup key field, id, role, __-prefixed, constructor/prototype and credential-shaped names, so a client cannot overwrite the identity its peers see. If this call is server-owned and intentional, pass clientUpdateFields: ['{}', ...] to replace the guard with an explicit allowlist.": "names the reserved field, why it was dropped, and the names that are free to use",
	"plugins/presence/server.js::[svelte-adapter-uws] presence: key field '{}' is credential-shaped, so the default select() drops it and each connection gets its own presence entry (no multi-tab dedup). The dedup key is broadcast as the roster key, so it must not be a secret: dedup on a non-secret identifier (e.g. a user id), or pass an explicit select() that returns '{}' if it really is one.": "names the field, the consequence for the roster, and the explicit select that resolves it",
	"runtime/handler.js::[svelte-adapter-uws] Warning: Admin route {}/* is mounted with NO adapter-level authentication. It is publicly reachable unless the app's admin() handler gates it (e.g. by validating a session cookie or bearer token). Set websocket.adminAuthAcknowledged: true once it is gated to silence this.": "states the exposure and the acknowledgement option that silences it once the app gates the route",
	"runtime/handler.js::[svelte-adapter-uws] Warning: No ORIGIN, HOST_HEADER, or PROTOCOL_HEADER configured. The server will use http:// with the request Host header. For production, either: SSL_CERT + SSL_KEY for native TLS (no proxy needed) ORIGIN=https://example.com (behind a TLS proxy) PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy) See: https://svti.me/adapter-origin": "lists every accepted configuration and a short link",
	"runtime/handler.js::[svelte-adapter-uws] Warning: WebSocket handler exports unknown \"{}\". Did you mean one of: {}?\\n See: https://svti.me/ws-hooks": "names the unknown export, the valid set and a short link",
	"runtime/handler.js::[ws] Rejected a WebSocket upgrade (429) keyed on a {} client address ({}) while ADDRESS_HEADER is unset. If this server runs behind a reverse proxy, load balancer, or docker userland-proxy that rewrites the source address, every client shares one address and the per-IP `upgradeRateLimit` becomes a single GLOBAL cap (also true for the plugins/ratelimit per-message limiter, which keys on the same address). Restore real client IPs with one of: ADDRESS_HEADER=x-forwarded-for (+ XFF_DEPTH for the trusted-proxy hop count) docker `userland-proxy: false` so iptables DNAT preserves the source IP websocket.upgradeRateLimit: 0 to disable the per-IP limit if you throttle upstream See: https://svti.me/upgrade-ratelimit-proxy": "carries the full proxy-configuration remedy inline, once per worker",
	"runtime/handler.js::[ws] userData key \"{}\" may contain sensitive data. userData is accessible to all server-side handlers via ws.getUserData(). Store sensitive data outside userData and reference it by a non-sensitive ID. See: https://svti.me/userdata-sensitive": "names the key, the exposure and the remedy, with a short link",
	"runtime/handler/config.js::[svelte-adapter-uws] Ignored a {} client-address claim from untrusted peer {}: the peer is not in TRUSTED_PROXIES, so the socket address was used instead. If this peer is a legitimate proxy, add its address (or CIDR range) to TRUSTED_PROXIES.": "names the ignored claim and the TRUSTED_PROXIES fix inline",
	"runtime/handler/pressure-metrics.js::[ws] publishBatched frame is {} bytes (>{}). Large frames may trip per-message-deflate and surprise CPU budgets. Consider chunking the batch into multiple publishBatched calls. See: https://svti.me/publish-batched": "states the threshold, the risk and the chunking remedy, with a short link",
	"runtime/index.js::[primary] WORKER_BOOT_TIMEOUT_MS={}ms is below the {}ms floor (two heartbeat intervals) and would risk false-killing a healthy slow boot; using {}ms.": "informational: the runtime clamped a configured value and says what it used and why",
	"runtime/index.js::[primary] Worker {} ({}#{}) {}, asking it to exit...": "the health verdict behind an ordinary restart; if the worker then refuses to leave, the SIGKILL that follows is indexed as ADAPTER-ERR-WORKER-EXIT-SIGKILL",
	"runtime/index.js::[svelte-adapter-uws] file-descriptor preflight: {}": "boot advisory. NOTE the body is built in utils/fd-limit.js and interpolated, so this key cannot see it and this reason cannot vouch for it - what it vouches for is the decision that a preflight advisory needs no reference entry, which holds however the body is worded",
	"runtime/utils/upgrade-headers.js::[adapter-uws] Set-Cookie on the 101 upgrade response is rejected by Cloudflare Tunnel and some other edge proxies (WebSocket opens, then closes with 1006 TCP FIN). Migrate to the `authenticate` hook to refresh session cookies over a normal HTTP response: export function authenticate({ cookies }) { cookies.set(...); } See: https://svti.me/cf-cookies": "carries its own cause, migration instruction and short link inline",
	"testing.js::[adapter-uws/testing] platform.sendTo filter returned a Promise; treating as fail-closed. Resolve filter inputs into userData from your `upgrade` hook so the filter can read them synchronously. See: https://svti.me/sendto-async": "the developer sees the same fail-closed guidance and short link the production line carries, indexed as ADAPTER-ERR-SENDTO-ASYNC-FILTER; the harness tag is kept so a reader knows which server printed it",
	"testing.js::[adapter-uws/testing] resume hook threw:": "the production runtime reports this failure as the indexed diagnostic event resume.hook-failed (ADAPTER-ERR-RESUME-HOOK), which is where an operator finds its cause and recovery; the developer running the harness has the throw itself",
	"testing.js::[ws] resume hook result read threw for topic": "the operator-facing twin is ADAPTER-ERR-RESUME-HOOK-READ, which indexes the same failure in the production runtime",
	"testing.js::[ws] subscribe hook threw:": "the operator-facing twin is the indexed diagnostic event subscribe.hook-failed (ADAPTER-ERR-SUBSCRIBE-HOOK); this line reaches a developer who already has the throw",
	"testing.js::[ws] subscribeBatch hook threw:": "the operator-facing twin is the indexed diagnostic event subscribe.batch-hook-failed (ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK); this line reaches a developer who already has the throw",
	"testing.js::[ws] subscribeBatch result read threw:": "the operator-facing twin is the indexed diagnostic event subscribe.batch-result-read-failed (ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT); this line reaches a developer who already has the throw",
	"vite.js::[adapter-uws] handler load error detail:": "the raw error behind the indexed ADAPTER-ERR-VITE-LOAD line, printed for its stack and source location",
	"vite.js::[adapter-uws] handler reload error detail:": "the raw error behind the indexed ADAPTER-ERR-VITE-RELOAD line, printed for its stack and source location",
	"vite.js::[adapter-uws] platform.sendTo filter returned a Promise; treating as fail-closed. Resolve filter inputs into userData from your `upgrade` hook so the filter can read them synchronously. See: https://svti.me/sendto-async": "the developer sees the same fail-closed guidance and short link the production line carries, indexed as ADAPTER-ERR-SENDTO-ASYNC-FILTER; the dev tag is kept so a reader knows which server printed it",
	"vite.js::[adapter-uws] resume hook threw:": "the production runtime reports this failure as the indexed diagnostic event resume.hook-failed (ADAPTER-ERR-RESUME-HOOK), which is where an operator finds its cause and recovery; the developer running the dev server has the throw itself",
	"vite.js::[adapter-uws] unknown uws() plugin option(s): {} - not recognized by the dev plugin and ignored. Check the spelling against UWSPluginOptions in vite.d.ts. Note the dev plugin takes these FLAT, not under a `websocket` key as svelte.config.js does.": "dev-configuration advisory: names the unknown keys, where the valid ones are declared, and the flat-versus-nested trap",
	"vite.js::[adapter-uws] upgrade() returned response headers. These are only applied in production (uWS); the ws library used in dev does not support custom 101 headers. See: https://svti.me/dev-101-headers": "dev-only parity notice with a short link; nothing failed, and production behaves as documented",
	"vite.js::[adapter-uws] upgradeResponse() attaches Set-Cookie to the 101 response. This fails silently behind Cloudflare Tunnel and some other strict edge proxies (WebSocket opens, then closes with 1006). Use the `authenticate` hook to refresh session cookies over a normal HTTP response. See: https://svti.me/cf-cookies": "dev-only parity notice carrying the same guidance as the production Set-Cookie advisory",
	"vite.js::[ws] dev connection error:": "a dev-server socket error surfaced verbatim for the developer at the keyboard",
	"vite.js::[ws] subscribe hook threw:": "the operator-facing twin is the indexed diagnostic event subscribe.hook-failed (ADAPTER-ERR-SUBSCRIBE-HOOK); this line reaches a developer who already has the throw",
	"vite.js::[ws] subscribeBatch hook threw:": "the operator-facing twin is the indexed diagnostic event subscribe.batch-hook-failed (ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK); this line reaches a developer who already has the throw",
	"vite.js::[ws] subscribeBatch result read threw:": "the operator-facing twin is the indexed diagnostic event subscribe.batch-result-read-failed (ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT); this line reaches a developer who already has the throw",
}));

/** @param {string} dir */
function jsFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? jsFiles(path) : entry.name.endsWith('.js') ? [path] : [];
	});
}

/** Path under `src`, in the one spelling both maps are keyed by. */
function relPath(path) {
	return relative(sourceRoot, path).split(String.fromCharCode(92)).join('/');
}

function scannedFiles() {
	return jsFiles(sourceRoot).filter((path) => !EXCLUDED.has(relPath(path)));
}

/** Exclusions that no longer name a file, so the list cannot rot into fiction. */
export function staleExclusions() {
	return [...EXCLUDED.keys()].filter((rel) => {
		try { return !statSync(join(sourceRoot, rel)).isFile(); } catch { return true; }
	});
}

/**
 * The static skeleton of a printed argument: every literal character it will
 * always contain, with `{}` where a value is interpolated. This is the text an
 * operator would recognise, minus the values that differ per occurrence.
 *
 * @param {any} node
 * @returns {string}
 */
export function staticSkeleton(node) {
	if (node == null) return '{}';
	if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : '{}';
	if (node.type === 'TemplateLiteral') {
		let out = '';
		for (let i = 0; i < node.quasis.length; i++) {
			out += node.quasis[i].value.raw;
			if (i < node.expressions.length) out += '{}';
		}
		return out;
	}
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		return staticSkeleton(node.left) + staticSkeleton(node.right);
	}
	return '{}';
}

/**
 * The allowlist key carries the WHOLE skeleton, collapsed to one line.
 *
 * It was truncated at first, for a readable allowlist next to a multi-line
 * advisory. That quietly broke the rule this gate exists to enforce: rewording
 * the tail of a long line - replacing the remediation an entry's reason
 * describes, say - left the first hundred characters intact, so the decision
 * carried over to text nobody had judged. Keeping the whole thing makes
 * "a reworded line comes back for a fresh decision" true rather than nearly
 * true, and it also makes two different lines unable to share a key at all.
 *
 * @param {string} skeleton
 */
export function skeletonKey(skeleton) {
	return skeleton.replace(/\s+/g, ' ').trim();
}

function walk(node, visit) {
	if (!node || typeof node !== 'object') return;
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
	}
}

/** A console failure method, under any spelling this gate follows. */
const SOLE_CONSOLE = new Set(['console']);

function consoleMethod(node, consoleObjectNames = SOLE_CONSOLE) {
	if (node?.type !== 'MemberExpression') return null;
	const object = node.object;
	// `console.error`, and `globalThis.console.error` / `globalThis['console'].error`.
	const isConsole = (object?.type === 'Identifier' && consoleObjectNames.has(object.name)) ||
		(object?.type === 'MemberExpression' &&
			(object.property?.name === 'console' ||
				(object.computed && object.property?.type === 'Literal' && object.property.value === 'console')));
	if (!isConsole) return null;
	const method = node.computed
		? (node.property?.type === 'Literal' ? node.property.value : null)
		: node.property?.name;
	return typeof method === 'string' && FAILURE_METHODS.has(method) ? method : null;
}

/** The id an `adapterConsoleLine(...)` call names, or null when it is not that call. */
function consoleLineId(node) {
	if (node?.type !== 'CallExpression' || node.callee?.type !== 'Identifier' ||
		node.callee.name !== 'adapterConsoleLine') return null;
	const first = node.arguments[0];
	if (first?.type === 'MemberExpression' && first.object?.name === 'ADAPTER_ERROR_IDS' && !first.computed) {
		return { key: first.property?.name, id: ADAPTER_ERROR_IDS[first.property?.name] };
	}
	if (first?.type === 'Literal' && typeof first.value === 'string') return { key: first.value, id: first.value };
	return { key: null, id: null };
}

/**
 * Classify one module's console failures.
 *
 * Pure with respect to the supplied source, so a test drives it with a
 * synthetic module rather than by editing the runtime.
 *
 * @param {string} source module text
 * @param {string} rel path under src, used for the allowlist key
 * @param {Map<string, string>} [allowlist]
 * @returns {{ indexed: number, pipeline: number, used: string[], failures: string[] }}
 */
export function auditConsoleFailures(source, rel, allowlist = UNINDEXED) {
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	const failures = [];
	const used = [];
	/** key -> the skeleton that produced it, so a whitespace collision is caught. */
	const keyed = new Map();
	let indexed = 0;
	let pipeline = 0;

	// Printers that ARE a console failure method under another name. A module
	// that takes `log = console.error` as an injectable default - the shape the
	// relay spill policy uses so a test can capture its output - prints through
	// a call this walk would otherwise not recognise. The bindings are
	// collected first, then their calls are classified exactly like a direct
	// one, so the indirection buys testability and not an exemption.
	/** @type {Map<string, string>} name -> method */
	const aliases = new Map();
	/** `console.error`, and `console.error.bind(console)` - the same printer. */
	const boundConsoleMethod = (node, objects) => consoleMethod(node, objects) ??
		(node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
			node.callee.property?.name === 'bind' ? consoleMethod(node.callee.object, objects) : null);
	// Bindings of the console OBJECT, so `const c = console; c.error(...)` is
	// the same call under another name.
	const consoleObjects = new Set(['console']);
	walk(ast, (node) => {
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' &&
			(node.init?.name === 'console' || consoleObjects.has(node.init?.name))) {
			consoleObjects.add(node.id.name);
		}
	});
	walk(ast, (node) => {
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
			const method = boundConsoleMethod(node.init, consoleObjects);
			if (method) aliases.set(node.id.name, method);
		}
		// `const { error } = console` / `const { error: fail } = console`
		if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' &&
			consoleObjects.has(node.init?.name)) {
			for (const prop of node.id.properties) {
				const from = prop.key?.name;
				const to = prop.value?.type === 'Identifier' ? prop.value.name : null;
				if (to !== null && FAILURE_METHODS.has(from)) aliases.set(to, from);
			}
		}
		// A default: `{ log = console.error } = options`, or a parameter default.
		if (node.type === 'AssignmentPattern' && node.left?.type === 'Identifier') {
			const method = boundConsoleMethod(node.right, consoleObjects);
			if (method) aliases.set(node.left.name, method);
		}
		// A later assignment to an already-declared binding.
		if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
			const method = boundConsoleMethod(node.right, consoleObjects);
			if (method) aliases.set(node.left.name, method);
		}
	});

	walk(ast, (node) => {
		if (node.type !== 'CallExpression') return;
		// Writing the failure straight to the stream skips every classification
		// above, so it is refused outright rather than classified.
		if (node.callee?.type === 'MemberExpression' && node.callee.property?.name === 'write' &&
			node.callee.object?.type === 'MemberExpression' && node.callee.object.property?.name === 'stderr') {
			failures.push(`src/${rel}:${node.loc.start.line}: process.stderr.write bypasses the console index, which ` +
				'reads console calls only.\n' +
				'    If it reports a failure, print it through the error registry with console.error instead. If it is a\n' +
				'    raw dump or a forwarded child stream, this rule needs a decision recorded next to it - nothing in\n' +
				'    the tree writes to stderr today, so no allowlist for it exists yet.');
			return;
		}
		const method = consoleMethod(node.callee, consoleObjects) ?? aliases.get(node.callee?.name);
		if (!method) return;
		const printer = node.callee?.type === 'Identifier' ? node.callee.name + '() (console.' + method + ' alias)' : 'console.' + method;
		const first = node.arguments[0];

		const named = consoleLineId(first);
		if (named !== null) {
			// The call SHAPE is not the contract; the id is. A dangling id makes
			// adapterConsoleLine throw at the moment the failure it was meant to
			// report happens - inside a catch block, where the throw replaces the
			// recovery that catch was performing.
			const entry = named.id === null ? undefined : ENTRY_BY_ID.get(named.id);
			if (entry === undefined) {
				failures.push(`src/${rel}:${node.loc.start.line}: ${printer} prints through adapterConsoleLine with ` +
					`${named.key === null ? 'a computed id' : 'ADAPTER_ERROR_IDS.' + named.key}, which is not a registry entry.\n` +
					'    adapterConsoleLine throws on an unknown id, so this would replace the failure with a TypeError.');
				return;
			}
			if (entry.emission !== 'console') {
				failures.push(`src/${rel}:${node.loc.start.line}: ${printer} prints ${entry.id}, whose emission is ` +
					`"${entry.emission}" rather than "console"; adapterConsoleLine refuses it at runtime.`);
				return;
			}
			// A warn-level line indexed as an error (or the reverse) misfiles
			// wherever severity routes, and the reference then describes the
			// failure at an urgency the log does not carry.
			const expected = method === 'warn' ? 'warn' : 'error';
			if (entry.severity !== expected && !(method === 'error' && entry.severity === 'fatal')) {
				failures.push(`src/${rel}:${node.loc.start.line}: ${printer} prints ${entry.id}, whose registry severity is ` +
					`"${entry.severity}"; a console.${method} line is severity "${expected}".`);
				return;
			}
			// The PRINTER's file must be listed. That is all this can check: an
			// entry's prose routinely describes behaviour decided elsewhere -
			// the posture entry's consequence is settled in pressure-metrics.js,
			// the relay-spill entry's direction in index.js - and no gate can
			// tell which files a sentence depends on. What it does buy is that
			// an entry cannot silently acquire a call site nobody checked its
			// prose against, which is how three of these entries came to
			// describe a site they were never read at. The reference generator
			// validates none of this: it short-circuits as soon as any file
			// mentions the id.
			const declared = (entry.sources || []).map((source) => source.replace(/^src\//, ''));
			if (!declared.includes(rel)) {
				failures.push(`src/${rel}:${node.loc.start.line}: ${printer} prints ${entry.id}, whose sources do not ` +
					`name this file (declared: ${declared.map((d) => 'src/' + d).join(', ') || 'none'}).\n` +
					"    Add it, and re-read the entry's cause/consequence/recovery/next-action against THIS call site -\n" +
					'    an entry written for one site is routinely false at another.');
				return;
			}
			indexed++;
			return;
		}
		if (first?.type === 'CallExpression' && first.callee?.type === 'Identifier' &&
			PIPELINE_FORMATTERS.has(first.callee.name)) { pipeline++; return; }

		const skeleton = staticSkeleton(first);
		// A line with no invariant words of its own cannot be searched for and
		// cannot be keyed: its text is whatever the values happened to be.
		if (!/[a-z]{3}/i.test(skeleton.replace(/^(?:\s*\[[^\]]*\])+/, '').replace(/\{\}/g, ' '))) {
			failures.push(
				`src/${rel}:${node.loc.start.line}: ${printer} prints a line with no invariant text of its own ` +
				`(skeleton ${JSON.stringify(skeleton)}), so there is nothing for an operator to search for.\n` +
				'    Give the line a fixed subject, then index it or record it in UNINDEXED in\n' +
				'    scripts/check-console-index.js.'
			);
			return;
		}
		const key = rel + '::' + skeletonKey(skeleton);
		// Whitespace normalisation can map two different lines onto one key, and
		// a recorded decision would then cover the one nobody judged.
		const seen = keyed.get(key);
		if (seen !== undefined && seen !== skeleton) {
			failures.push(`src/${rel}:${node.loc.start.line}: this line and an earlier one in the same file ` +
				`produce the same key ${JSON.stringify(key)}, so one recorded decision would cover both.\n` +
				'    They differ only in whitespace; give one of them wording that differs in words.');
			return;
		}
		keyed.set(key, skeleton);
		if (allowlist.has(key)) { used.push(key); return; }
		failures.push(
			`src/${rel}:${node.loc.start.line}: ${printer} prints a failure that the error reference cannot resolve.\n` +
			`    skeleton: ${JSON.stringify(skeleton)}\n` +
			'    Index it: add an entry to ADAPTER_ERROR_REGISTRY with emission "console" and print it through\n' +
			'    adapterConsoleLine(ADAPTER_ERROR_IDS.<ID>, detail) - the emitted text then IS the indexed prefix.\n' +
			'    Or, if an operator who read it needs nothing the reference could add, record that decision in\n' +
			`    UNINDEXED in scripts/check-console-index.js under the key ${JSON.stringify(key)}.`
		);
	});
	return { indexed, pipeline, used, failures };
}

/**
 * Audit every scanned surface.
 * @param {Map<string, string>} [allowlist]
 */
export function auditRuntimeConsoleFailures(allowlist = UNINDEXED) {
	const failures = [];
	const used = new Set();
	let indexed = 0;
	let pipeline = 0;
	let modules = 0;
	for (const path of scannedFiles()) {
		modules++;
		const rel = relPath(path);
		const result = auditConsoleFailures(readFileSync(path, 'utf8'), rel, allowlist);
		indexed += result.indexed;
		pipeline += result.pipeline;
		for (const key of result.used) used.add(key);
		failures.push(...result.failures);
	}
	for (const rel of staleExclusions()) {
		failures.push(`stale EXCLUDED entry in scripts/check-console-index.js: ${JSON.stringify(rel)} is not a file under src.
` +
			'    An exclusion that names nothing is a decision about a module that no longer exists; delete it.');
	}
	for (const key of allowlist.keys()) {
		if (!used.has(key)) {
			failures.push(
				`stale UNINDEXED entry in scripts/check-console-index.js: ${JSON.stringify(key)} matches no call site.\n` +
				'    The line was removed or reworded. A reworded failure needs a fresh decision, not an inherited one:\n' +
				'    re-key the entry to the new text, or delete it if the line is gone.'
			);
		}
	}
	return { indexed, pipeline, unindexed: used.size, modules, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const { indexed, pipeline, unindexed, modules, failures } = auditRuntimeConsoleFailures();
	console.log(`check-console-index: ${pkg.name}@${pkg.version}`);
	console.log(`  ${modules} module(s) scanned under src (${EXCLUDED.size} excluded by name): ${indexed} indexed through the registry, ${pipeline} through the diagnostic pipeline, ${unindexed} deliberately unindexed.`);
	if (failures.length > 0) {
		console.error(`\n  ${failures.length} console failure(s) unaccounted for:\n`);
		for (const failure of failures) console.error('  ' + failure + '\n');
		process.exit(1);
	}
	console.log('  OK - every console failure on a scanned surface is indexed or accounted for.');
}
