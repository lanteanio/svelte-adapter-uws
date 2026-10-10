import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function readContract() {
	return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
		import { PLATFORM_MEMBERS } from 'svelte-adapter-uws/platform-contract';
		console.log(JSON.stringify({ members: PLATFORM_MEMBERS, frozen: Object.isFrozen(PLATFORM_MEMBERS) }));
	`], { cwd: root, encoding: 'utf8' }));
}

it('offers a frozen member inventory through the supported package subpath', () => {
	const contract = readContract();
	expect(contract.frozen).toBe(true);
	expect(contract.members).toEqual([...new Set(contract.members)].sort());
	expect(contract.members).toContain('requestId');
	expect(contract.members).toContain('publishWireBatch');
});

it('keeps the generated public declaration inventory current', () => {
	expect(() => execFileSync(process.execPath, ['scripts/generate-platform-contract.js', '--check'], {
		cwd: root, encoding: 'utf8'
	})).not.toThrow();
});
describe('platform inventory on a real handler connection', () => {
	let runtime;
	let client;
	beforeAll(async () => { runtime = await startRealRuntime({ variant: 'platformcontract' }); }, 400000);
	afterAll(async () => { client?.close(); await runtime?.stop(); });
	it('includes every inherited and contextual public member without internal symbols', async () => {
		client = await connectRealClient(runtime.wsUrl);
		const answer = await client.waitFor((frame) => frame?.topic === 'contract' && frame.event === 'members');
		expect(answer).not.toBeNull();
		expect(answer.parsed.data.requestId).toEqual(expect.any(String));
		expect(answer.parsed.data.members).toEqual(readContract().members);
	});
});
