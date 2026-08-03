// Transport RED instrumentation shared by the HTTP router and WebSocket
// behavior. The caller installs these wrappers only when an operator supplied
// a metrics registry. With metrics disabled, the original handlers and
// behavior object are registered unchanged: no request/message closure, label
// object, timer read, or userData/WeakMap entry is created on the hot path.

export const HTTP_DURATION_BUCKETS = Object.freeze([
	0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1,
	0.25, 0.5, 1, 2.5, 5, 10
]);

export const UPGRADE_DURATION_BUCKETS = HTTP_DURATION_BUCKETS;

export const WS_MESSAGE_DURATION_BUCKETS = Object.freeze([
	0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005,
	0.01, 0.025, 0.05, 0.1, 0.25, 1
]);

export const WS_CONNECTION_DURATION_BUCKETS = Object.freeze([
	1, 5, 15, 30, 60, 300, 900, 3600, 21600, 86400
]);

const HTTP_METHODS = Object.freeze([
	'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'other'
]);
const HTTP_OUTCOMES = Object.freeze(['ok', 'client_error', 'server_error', 'aborted']);
const UPGRADE_OUTCOMES = Object.freeze(['admitted', 'rejected', 'aborted', 'error']);
const WS_KINDS = Object.freeze(['text', 'binary']);
const WS_MESSAGE_OUTCOMES = Object.freeze(['ok', 'error']);
const WS_CONNECTION_OUTCOMES = Object.freeze(['clean', 'abnormal']);
const PUBLISH_OUTCOMES = Object.freeze(['delivered', 'no_subscribers']);

/** @param {readonly string[]} left @param {readonly string[]} right */
function labelMatrix(left, right) {
	/** @type {Record<string, Record<string, Readonly<Record<string, string>>>>} */
	const matrix = {};
	for (const a of left) {
		const row = {};
		for (const b of right) row[b] = Object.freeze({ [left === HTTP_METHODS ? 'method' : 'kind']: a, outcome: b });
		matrix[a] = Object.freeze(row);
	}
	return Object.freeze(matrix);
}

const HTTP_LABELS = labelMatrix(HTTP_METHODS, HTTP_OUTCOMES);
const WS_MESSAGE_LABELS = labelMatrix(WS_KINDS, WS_MESSAGE_OUTCOMES);
const UPGRADE_LABELS = Object.freeze(Object.fromEntries(
	UPGRADE_OUTCOMES.map((outcome) => [outcome, Object.freeze({ outcome })])
));
const WS_CONNECTION_LABELS = Object.freeze(Object.fromEntries(
	WS_CONNECTION_OUTCOMES.map((outcome) => [outcome, Object.freeze({ outcome })])
));
const PUBLISH_LABELS = Object.freeze(Object.fromEntries(
	PUBLISH_OUTCOMES.map((outcome) => [outcome, Object.freeze({ outcome })])
));

/** @param {string} method */
function boundedMethod(method) {
	const value = String(method || '').toLowerCase();
	return HTTP_METHODS.includes(value) ? value : 'other';
}

/** @param {number} status */
function httpOutcome(status) {
	if (status >= 500) return 'server_error';
	if (status >= 400) return 'client_error';
	return 'ok';
}

/** @param {unknown} status */
function statusCode(status) {
	const match = /^(\d{3})(?:\s|$)/.exec(String(status));
	return match === null ? null : Number(match[1]);
}

/**
 * @typedef {object} TransportMetricInstruments
 * @property {any} [httpRequests]
 * @property {any} [httpDuration]
 * @property {any} [upgradeDuration]
 * @property {any} [wsMessages]
 * @property {any} [wsMessageDuration]
 * @property {any} [wsConnectionDuration]
 * @property {any} [publishOutcomes]
 */

/**
 * Build the registration-time hooks once. Returns null only when every
 * instrument is absent, which leaves route registration byte-for-byte
 * unchanged.
 *
 * @param {TransportMetricInstruments} instruments
 * @param {() => number} clock Monotonic milliseconds.
 */
export function createTransportMetricHooks(instruments, clock) {
	if (!Object.values(instruments).some((instrument) => instrument !== undefined)) return null;
	return Object.freeze({
		instrumentHttp(handler, routeMethod) {
			if (instruments.httpRequests === undefined && instruments.httpDuration === undefined) return handler;
			return function transportMeasuredHttp(res, req) {
				const method = boundedMethod(
					typeof req?.getMethod === 'function' ? req.getMethod() : routeMethod
				);
				const started = instruments.httpDuration === undefined ? 0 : clock();
				let done = false;
				let status = 200;
				const finish = (outcome) => {
					if (done) return;
					done = true;
					const labels = HTTP_LABELS[method][outcome];
					instruments.httpRequests?.inc(labels);
					if (instruments.httpDuration !== undefined) {
						instruments.httpDuration.observe(labels, Math.max(0, clock() - started) / 1000);
					}
				};

				if (typeof res?.writeStatus === 'function') {
					const writeStatus = res.writeStatus;
					res.writeStatus = function measuredWriteStatus(value) {
						const parsed = statusCode(value);
						if (parsed !== null) status = parsed;
						return writeStatus.call(res, value);
					};
				}
				if (typeof res?.end === 'function') {
					const end = res.end;
					res.end = function measuredEnd(...args) {
						finish(httpOutcome(status));
						return end.apply(res, args);
					};
				}
				// endWithoutBody is a terminal call too: every redirect, 204,
				// HEAD, and empty admin reply completes through it. Leaving it
				// unpatched made that whole class of ordinary traffic
				// invisible to http_requests_total while the transport read
				// healthy.
				if (typeof res?.endWithoutBody === 'function') {
					const endWithoutBody = res.endWithoutBody;
					res.endWithoutBody = function measuredEndWithoutBody(...args) {
						finish(httpOutcome(status));
						return endWithoutBody.apply(res, args);
					};
				}
				if (typeof res?.close === 'function') {
					const close = res.close;
					res.close = function measuredClose(...args) {
						finish('aborted');
						return close.apply(res, args);
					};
				}
				if (typeof res?.onAborted === 'function') {
					const onAborted = res.onAborted;
					res.onAborted = function measuredOnAborted(callback) {
						return onAborted.call(res, () => {
							finish('aborted');
							return callback();
						});
					};
				}
				try {
					return handler(res, req);
				} catch (error) {
					finish('server_error');
					throw error;
				}
			};
		},

		instrumentWebSocket(behavior) {
			const measured = { ...behavior };
			if (instruments.upgradeDuration !== undefined && typeof behavior.upgrade === 'function') {
				const upgrade = behavior.upgrade;
				measured.upgrade = function transportMeasuredUpgrade(res, ...args) {
					const started = clock();
					let done = false;
					const finish = (outcome) => {
						if (done) return;
						done = true;
						instruments.upgradeDuration.observe(
							UPGRADE_LABELS[outcome],
							Math.max(0, clock() - started) / 1000
						);
					};
					if (typeof res?.upgrade === 'function') {
						const accept = res.upgrade;
						res.upgrade = function measuredAccept(...acceptArgs) {
							finish('admitted');
							return accept.apply(res, acceptArgs);
						};
					}
					if (typeof res?.end === 'function') {
						const end = res.end;
						res.end = function measuredReject(...endArgs) {
							finish('rejected');
							return end.apply(res, endArgs);
						};
					}
					if (typeof res?.close === 'function') {
						const close = res.close;
						res.close = function measuredUpgradeClose(...closeArgs) {
							finish('aborted');
							return close.apply(res, closeArgs);
						};
					}
					if (typeof res?.onAborted === 'function') {
						const onAborted = res.onAborted;
						res.onAborted = function measuredUpgradeAbort(callback) {
							return onAborted.call(res, () => {
								finish('aborted');
								return callback();
							});
						};
					}
					try {
						return upgrade(res, ...args);
					} catch (error) {
						finish('error');
						throw error;
					}
				};
			}

			if ((instruments.wsMessages !== undefined || instruments.wsMessageDuration !== undefined) &&
				typeof behavior.message === 'function') {
				const message = behavior.message;
				measured.message = async function transportMeasuredMessage(ws, data, isBinary) {
					const kind = isBinary ? 'binary' : 'text';
					const started = instruments.wsMessageDuration === undefined ? 0 : clock();
					let outcome = 'ok';
					try {
						return await message(ws, data, isBinary);
					} catch (error) {
						outcome = 'error';
						throw error;
					} finally {
						const labels = WS_MESSAGE_LABELS[kind][outcome];
						instruments.wsMessages?.inc(labels);
						if (instruments.wsMessageDuration !== undefined) {
							instruments.wsMessageDuration.observe(
								labels,
								Math.max(0, clock() - started) / 1000
							);
						}
					}
				};
			}

			if (instruments.wsConnectionDuration !== undefined &&
				typeof behavior.open === 'function' && typeof behavior.close === 'function') {
				const opened = new WeakMap();
				const open = behavior.open;
				const close = behavior.close;
				measured.open = function transportMeasuredOpen(ws, ...args) {
					opened.set(ws, clock());
					try {
						return open(ws, ...args);
					} catch (error) {
						opened.delete(ws);
						throw error;
					}
				};
				measured.close = function transportMeasuredClose(ws, code, ...args) {
					const started = opened.get(ws);
					opened.delete(ws);
					try {
						return close(ws, code, ...args);
					} finally {
						if (started !== undefined) {
							const outcome = code === 1000 || code === 1001 ? 'clean' : 'abnormal';
							instruments.wsConnectionDuration.observe(
								WS_CONNECTION_LABELS[outcome],
								Math.max(0, clock() - started) / 1000
							);
						}
					}
				};
			}
			return measured;
		},

		publishOutcome: instruments.publishOutcomes === undefined
			? null
			: (delivered) => instruments.publishOutcomes.inc(
				PUBLISH_LABELS[delivered ? 'delivered' : 'no_subscribers']
			)
	});
}
