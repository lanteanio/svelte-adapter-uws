// A user/plugin message hook is an untrusted extension boundary from the
// runtime's point of view. A synchronous throw inside an async socket callback,
// or a Promise rejection returned by the hook, must close only that connection
// rather than becoming an unhandled rejection that terminates the worker.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

let server = null;
const clients = [];

afterEach(async () => {
	for (const ws of clients.splice(0)) {
		try { ws.terminate(); } catch { /* already closed */ }
	}
	await server?.close();
	server = null;
	vi.restoreAllMocks();
});

async function connect(wsUrl) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	clients.push(ws);
	return ws;
}

function closed(ws, timeoutMs = 1500) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('offending connection stayed open')),
			timeoutMs
		);
		ws.once('close', (code, reason) => {
			clearTimeout(timer);
			resolve({ code, reason: reason.toString() });
		});
	});
}

const CASES = [
	{
		name: 'a synchronous throw',
		message() { throw new Error('sync message failure'); }
	},
	{
		name: 'an asynchronous rejection',
		async message() { throw new Error('async message failure'); }
	}
];

describe('message-hook exception containment', () => {
	for (const testCase of CASES) {
		it(`contains ${testCase.name} to the offending connection`, async () => {
			const { createTestServer } = await import('../src/testing.js');
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			server = await createTestServer({
				handler: { message: testCase.message }
			});

			const offender = await connect(server.wsUrl);
			const peer = await connect(server.wsUrl);
			const close = closed(offender);

			// Not a built-in control frame, so it reaches the app/plugin hook.
			offender.send('{"topic":"room","event":"probe","data":null}');

			await expect(close).resolves.toEqual({
				code: 1011,
				reason: 'Message handler error'
			});
			expect(peer.readyState, 'an unrelated connection must remain open').toBe(peer.OPEN);
			expect(
				error.mock.calls.some((call) => String(call[0]).includes('message hook threw')),
				'the server log must retain the actual hook failure'
			).toBe(true);
		});
	}

	it('is awaited at every app-message delegation on all three surfaces', () => {
		const surfaces = [
			['src/runtime/handler.js', 2],
			['src/testing.js', 1],
			['src/vite.js', 1]
		];

		for (const [file, expectedCalls] of surfaces) {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
			const root = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
			let imported = false;
			let awaited = 0;
			let unawaited = 0;

			const visit = (node, parent = null) => {
				if (!node || typeof node !== 'object') return;
				if (Array.isArray(node)) {
					for (const child of node) visit(child, parent);
					return;
				}
				if (node.type === 'ImportDeclaration' &&
					typeof node.source?.value === 'string' &&
					node.source.value.endsWith('/hook-boundary.js')) {
					imported = node.specifiers.some((specifier) =>
						specifier.type === 'ImportSpecifier' &&
						specifier.imported.name === 'runMessageHook' &&
						specifier.local.name === 'runMessageHook'
					);
				}
				if (node.type === 'CallExpression' &&
					node.callee?.type === 'Identifier' &&
					node.callee.name === 'runMessageHook') {
					if (parent?.type === 'AwaitExpression' && parent.argument === node) awaited++;
					else unawaited++;
				}
				for (const [key, child] of Object.entries(node)) {
					if (key === 'type' || key === 'start' || key === 'end') continue;
					visit(child, node);
				}
			};
			visit(root);

			expect(imported, `${file} must import the real shared boundary unaliased`).toBe(true);
			expect(unawaited, `${file} has an unawaited message-hook boundary`).toBe(0);
			expect(awaited, `${file} must contain every app-message delegation`).toBe(expectedCalls);
		}
	});
});
