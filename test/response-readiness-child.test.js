import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('finishes microtask-ready response bodies before the next check phase in plain Node', async () => {
	const source = `
import assert from 'node:assert/strict';
import { readReady } from './src/runtime/handler/response-read.js';
import { readBodyUpTo } from './src/runtime/handler/ssr-dedup.js';
let checks = 0;
for (const transformCount of [0, 2, 5]) {
	let body = new Response('x'.repeat(17000)).body;
	for (let i = 0; i < transformCount; i++) body = body.pipeThrough(new TransformStream());
	let checkPhase = false;
	const timer = setImmediate(() => { checkPhase = true; });
	try {
		const result = await readBodyUpTo(body, 512 * 1024);
		assert.equal(checkPhase, false, 'ready transforms finish in the current checkpoint');
		assert.equal(result.complete, true);
		assert.equal(new TextDecoder().decode(result.bytes), 'x'.repeat(17000));
		checks++;
	} finally { clearImmediate(timer); }
}
const reader = new Response('x'.repeat(17000)).body.getReader();
await reader.read();
let checkPhase = false;
const timer = setImmediate(() => { checkPhase = true; });
try {
	assert.equal((await readReady(reader)).done, true);
	assert.equal(checkPhase, false, 'ready EOF finishes in the current checkpoint');
	checks++;
} finally { clearImmediate(timer); reader.releaseLock(); }
console.log(JSON.stringify({ checks }));
`;
	const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', source], {
		cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 10000
	});
	expect(JSON.parse(stdout)).toEqual({ checks: 4 });
});
