// Production-built proof for the transport RED wrappers. Unit mocks cannot
// establish that uWebSockets.js response objects permit the terminal-method
// instrumentation used by handler.js, so this boots the real metrics fixture
// and drives HTTP, upgrade, message, close, and native publish paths.

import { afterAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

async function scrape(httpUrl) {
	const response = await fetch(httpUrl + '/metrics');
	const text = await response.text();
	const values = new Map();
	for (const line of text.split('\n')) {
		const match = /^([a-z_][a-z0-9_]*) (-?\d+(?:\.\d+)?)$/.exec(line);
		if (match) values.set(match[1], Number(match[2]));
	}
	return values;
}

async function oneMessageAndCleanClose(url) {
	const { WebSocket } = await import('ws');
	await new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('WebSocket transport-metrics probe timed out'));
		}, 5000);
		socket.once('open', () => {
			socket.send(JSON.stringify({ type: 'hello', caps: [] }));
			setTimeout(() => socket.close(1000), 10);
		});
		socket.once('close', () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describeUWS('production transport RED metrics', () => {
	let server;
	afterAll(async () => { await server?.stop(); });

	it('observes real HTTP/upgrade/message/close/native-publish paths', async () => {
		server = await startRealRuntime({ variant: 'metrics' });

		const page = await fetch(server.httpUrl + '/');
		expect(page.status).toBe(200);
		await page.arrayBuffer();

		const upgrade = await rawUpgrade(server.port);
		expect(upgrade.status).toBe('101');
		await oneMessageAndCleanClose(server.wsUrl);

		server.handler.relayPublish(
			'__transport_metrics_no_subscribers__',
			'{"topic":"__transport_metrics_no_subscribers__","event":"probe","data":null,"seq":1}',
			false,
			1
		);

		const values = await scrape(server.httpUrl);
		for (const name of [
			'http_requests_total',
			'http_request_duration_seconds',
			'upgrade_duration_seconds',
			'ws_messages_total',
			'ws_message_duration_seconds',
			'ws_connection_duration_seconds',
			'ws_publish_outcomes_total'
		]) {
			expect(values.get(name), name).toBeGreaterThan(0);
		}

		// A response with no body terminates through endWithoutBody (every
		// redirect, 204, and HEAD). That path was once uninstrumented, which
		// silently removed a whole class of ordinary traffic from the RED
		// counters. The fixture registry aggregates labels away, so this is a
		// delta assertion: the before-scrape completes (+1) and the HEAD must
		// count too (+1); an uninstrumented endWithoutBody yields only +1.
		const before = (await scrape(server.httpUrl)).get('http_requests_total');
		const headResponse = await fetch(server.httpUrl + '/', { method: 'HEAD' });
		expect(headResponse.status).toBe(200);
		const after = (await scrape(server.httpUrl)).get('http_requests_total');
		expect(after, 'a no-body HEAD completion must increment http_requests_total')
			.toBeGreaterThanOrEqual(before + 2);
	}, 15_000);
});
