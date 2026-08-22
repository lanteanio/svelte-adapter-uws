// Production wiring for publish-egress accounting and ceilings: the outbound
// half of a tenant budget. The account itself - the windowed ledger, the
// ceiling semantics, the tenant resolution - lives in
// utils/egress-account.js, shared verbatim with the createTestServer harness
// and the dev plugin so enforcement cannot drift between surfaces. This
// module binds ONE account per worker to the runtime's shared state: the
// per-topic runaway-publisher stats, the window counters the pressure
// sampler drains, the metrics hook, and the throttled operational events.
//
// Every publish-family fan-out path in platform.js charges here exactly once
// per logical publish, and the optional ceilings refuse a publish BEFORE
// anything authoritative moves - no sequence is stamped, no frame is built,
// nothing reaches the native layer or the cross-worker relay for a refused
// publish. Relay-received frames charge nothing: the origin worker charged
// its own local recipients.

import { now } from '../runtime.js';
import { assert, PUBLISH_WARN_DEDUP_MAX } from '../utils.js';
import { normalizeEgressOptions, createEgressAccount } from '../utils/egress-account.js';
import { counters, topicPublishStats } from './state.js';
import { maybeWarnTopicRegistry } from './pressure-metrics.js';
import { emitOperationalEvent } from '../diagnostic.js';
import { privateValueMetadata } from '../utils/observability-privacy.js';

export { normalizeEgressOptions, createEgressAccount };
export { excludedRecipient, binaryFrameChargeBytes, envelopeWireBytes, EGRESS_ADMITTED, EGRESS_DEFAULT_WINDOW_MS } from '../utils/egress-account.js';

/**
 * One account per worker, configured by handler.js at startup. A holder (not
 * `export let`) so the write is visible to platform.js across modules, and
 * `armed` is one property read on the zero-config hot path.
 *
 * @type {{ armed: boolean, tenantArmed: boolean, bytesArmed: boolean, account: ReturnType<typeof createEgressAccount> | null }}
 */
export const egressGate = { armed: false, tenantArmed: false, bytesArmed: false, account: null };

/**
 * Per-(scope, topic) throttle for the refusal event, one line per minute per
 * key, FIFO-bounded exactly like the runaway-publisher dedup table.
 * @type {Map<string, number>}
 */
const refusalWarnAt = new Map();

/**
 * Per-scope throttle for the eviction event, one line per minute per scope.
 *
 * Keyed by scope alone rather than by key: the condition is a fact about how
 * many distinct topics or tenants published inside one window, so naming the
 * unlucky key would point at whichever one happened to be seated next and
 * would make the table grow with the churn it is reporting.
 * @type {Map<string, number>}
 */
const evictionWarnAt = new Map();

/**
 * A LIVE usage window was dropped to hold the ledger cap, so that key stops
 * being held to its ceiling for the rest of its window. Counter only: the
 * condition is a capacity fact about topic cardinality rather than a per-key
 * event, and a log line per eviction would fire at the rate of the churn that
 * caused it.
 *
 * @param {'topic' | 'tenant'} scope
 */
function reportEviction(scope) {
	counters.egressEvictedHook?.(scope);
	// The counter is the precise measure and the line is what a reader gets
	// without a scrape - the same pairing the refusal has. Throttled per scope
	// because an eviction fires at the rate of the churn that caused it, which
	// is the reason this was a counter alone until a dev deployment turned out
	// to have neither: the dev plugin registers no metrics, so a ledger evicting
	// there dropped enforcement with nothing on any surface saying so.
	const t = now();
	const last = evictionWarnAt.get(scope) || 0;
	if (t - last < 60_000) return;
	evictionWarnAt.set(scope, t);
	emitOperationalEvent({
		source: 'svelte-adapter-uws',
		component: 'runtime.egress',
		event: 'egress.window-evicted',
		severity: 'warn',
		dataClass: 'pseudonymous',
		message: 'The egress ledger dropped a usage window that was still counting, so that key is unmetered for the rest of it.',
		attributes: { scope, help: 'https://svti.me/egress' }
	});
}

/**
 * @param {'topic' | 'tenant'} scope
 * @param {string | null} topic
 * @param {'messages' | 'bytes' | 'deliveries'} dimension
 * @param {number} limit
 */
function reportRefusal(scope, topic, dimension, limit) {
	if (scope === 'tenant') counters.egressRefusedTenantWindow++;
	else counters.egressRefusedTopicWindow++;
	counters.egressRefusedHook?.(scope);
	const key = scope + '\0' + (topic === null ? '' : topic);
	const t = now();
	const last = refusalWarnAt.get(key) || 0;
	if (t - last < 60_000) return;
	if (refusalWarnAt.size >= PUBLISH_WARN_DEDUP_MAX && !refusalWarnAt.has(key)) {
		const oldest = refusalWarnAt.keys().next().value;
		if (oldest !== undefined) refusalWarnAt.delete(oldest);
	}
	refusalWarnAt.set(key, t);
	emitOperationalEvent({
		source: 'svelte-adapter-uws',
		component: 'runtime.egress',
		event: 'egress.publish-refused',
		severity: 'warn',
		dataClass: 'pseudonymous',
		message: 'A publish crossed a configured egress ceiling and was refused.',
		attributes: {
			scope,
			dimension,
			limit,
			topic: topic === null ? null : privateValueMetadata(topic, 'topic'),
			help: 'https://svti.me/egress'
		}
	});
}

/** @param {unknown} raw */
function reportResolverInvalid(raw) {
	emitOperationalEvent({
		source: 'svelte-adapter-uws',
		component: 'runtime.egress',
		event: 'egress.tenant-resolver-invalid',
		severity: 'error',
		dataClass: 'pseudonymous',
		message: 'The egress tenant resolver returned an unusable id; publishes are charged unattributed.',
		attributes: { valueType: raw === null ? 'null' : typeof raw, help: 'https://svti.me/egress' }
	});
}

/**
 * Configure this worker's egress account. Called once at startup by
 * handler.js; a re-run (a fresh handler factory in one process) replaces the
 * account and its windows wholesale. `tenantOf` is the handler module's
 * `egressTenantOf` export and must be a function when present - a defined
 * non-function refuses loudly, because reading it as "no resolver" would
 * stand every tenant ceiling down in silence.
 *
 * @param {any} rawOptions - WS_OPTIONS.egress
 * @param {unknown} tenantOf - the handler module's egressTenantOf export
 */
export function configureEgress(rawOptions, tenantOf) {
	if (tenantOf !== undefined && tenantOf !== null && typeof tenantOf !== 'function') {
		throw new TypeError(
			'the egressTenantOf export must be a function (topic) => tenantId | null; got ' + typeof tenantOf
		);
	}
	const options = normalizeEgressOptions(rawOptions);
	const account = createEgressAccount({
		options,
		tenantOf: typeof tenantOf === 'function' ? tenantOf : null,
		onRefused: reportRefusal,
		onResolverInvalid: reportResolverInvalid,
		onEvicted: reportEviction
	});
	egressGate.account = account;
	egressGate.armed = account.enabled;
	egressGate.tenantArmed = account.tenantEnabled && typeof tenantOf === 'function';
	egressGate.bytesArmed = account.bytesEnabled;
	return account;
}

/**
 * Resolve the tenant a server-side publish on `topic` is charged to, or null
 * when tenant ceilings are unarmed or the topic is unattributed. One memoized
 * map read in the steady state.
 *
 * @param {string} topic
 * @returns {string | null}
 */
export function resolvePublishTenant(topic) {
	if (!egressGate.tenantArmed) return null;
	return /** @type {NonNullable<typeof egressGate.account>} */ (egressGate.account).resolveTenant(topic);
}

/**
 * The pre-hoc admission for one logical publish on the production gate.
 * Always true while no ceiling is configured.
 *
 * @param {string | null} topic
 * @param {string | null} tenantId
 * @param {number} messages
 * @param {number} deliveries
 * @returns {boolean}
 */
export function admitPublishEgress(topic, tenantId, messages, deliveries) {
	const account = egressGate.account;
	if (account === null) return true;
	return account.admit(topic, tenantId, messages, deliveries);
}

/**
 * The topic half of the decision, for a call that spans several topics and
 * must pool its tenant share across them.
 *
 * @param {string | null} topic
 * @param {number} messages
 * @param {number} deliveries
 * @returns {boolean}
 */
export function admitTopicEgress(topic, messages, deliveries) {
	const account = egressGate.account;
	if (account === null) return true;
	return account.admitTopic(topic, messages, deliveries);
}

/**
 * The tenant half of the decision, taken once per tenant against the pooled
 * weight of every topic in the call.
 *
 * @param {string | null} tenantId
 * @param {string | null} topic - named in the refusal report only
 * @param {number} messages
 * @param {number} deliveries
 * @returns {boolean}
 */
export function admitTenantEgress(tenantId, topic, messages, deliveries) {
	const account = egressGate.account;
	if (account === null) return true;
	return account.admitTenant(tenantId, topic, messages, deliveries);
}

/**
 * Charge one admitted logical publish (or one whole admitted batch): the
 * per-topic runaway-publisher stats (their `m`/`b` fields keep their
 * pre-existing meanings; `d` is the additive deliveries dimension), the
 * worker egress window counters the pressure sampler drains, and the ceiling
 * account when armed. This is the ONE charge point every publish-family
 * fan-out path calls, replacing the per-site stats blocks.
 *
 * @param {string} topic
 * @param {string | null} tenantId
 * @param {number} messages
 * @param {number} deliveries - recipients times messages, exclusions deducted
 * @param {number} envelopeLen - UTF-16 length sum of the JSON envelopes (the
 *   pre-existing `topicPublishStats.b` unit, unchanged)
 * @param {number} wireBytes - total serialized wire bytes (per-recipient size
 *   summed over recipients and messages)
 */
export function chargePublishEgress(topic, tenantId, messages, deliveries, envelopeLen, wireBytes) {
	let s = topicPublishStats.get(topic);
	if (!s) {
		s = { m: 0, b: 0, d: 0 };
		topicPublishStats.set(topic, s);
		// Cold path: a brand-new topic just entered the registry - the cheap
		// place to check the topic-cardinality warn threshold.
		maybeWarnTopicRegistry();
	} else {
		assert(typeof s.m === 'number' && typeof s.b === 'number' && typeof s.d === 'number', 'topic.stats-shape', {
			messagesType: typeof s.m,
			bytesType: typeof s.b,
			deliveriesType: typeof s.d
		});
	}
	s.m += messages;
	s.b += envelopeLen;
	s.d += deliveries;
	counters.egressDeliveriesWindow += deliveries;
	counters.egressBytesWindow += wireBytes;
	const account = egressGate.account;
	if (account !== null && account.enabled) account.charge(topic, tenantId, messages, deliveries, wireBytes);
}

/**
 * Charge a direct (non-publish-stats) fan-out: `sendTo` and
 * `adviseReconnect`. These lanes never touch `topicPublishStats` - the
 * runaway-publisher rates keep meaning publish-family calls - but their
 * frames are egress like any other, so they land in the worker window
 * counters and, when a topic is present, in the ceiling account.
 *
 * @param {string | null} topic - null for the topic-less reconnect advisory
 * @param {string | null} tenantId
 * @param {number} deliveries
 * @param {number} wireBytes
 */
export function chargeDirectEgress(topic, tenantId, deliveries, wireBytes) {
	counters.egressDeliveriesWindow += deliveries;
	counters.egressBytesWindow += wireBytes;
	const account = egressGate.account;
	if (account !== null && account.enabled) account.charge(topic, tenantId, 1, deliveries, wireBytes);
}
