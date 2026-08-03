import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function fencedSnippet(marker) {
	const markerAt = readme.indexOf(marker);
	if (markerAt < 0) throw new Error(`README snippet marker not found: ${marker}`);
	const fenceAt = readme.lastIndexOf('```js\n', markerAt);
	const bodyAt = fenceAt + '```js\n'.length;
	const end = readme.indexOf('\n```', markerAt);
	if (fenceAt < 0 || end < bodyAt) throw new Error(`README snippet fence is malformed: ${marker}`);
	return readme.slice(bodyAt, end) + '\n';
}

describe('packed README examples', () => {
	it('imports and executes the authorization lock example from the packed public subpath', async () => {
		const temp = mkdtempSync(path.join(tmpdir(), 'adapter-uws-readme-'));
		try {
			const packArgs = ['pack', '--json', '--pack-destination', temp];
			const command = process.platform === 'win32' ? process.execPath : 'npm';
			const args = process.platform === 'win32'
				? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...packArgs]
				: packArgs;
			const packed = JSON.parse(execFileSync(command, args, {
				cwd: root,
				encoding: 'utf8',
				timeout: 120000
			}));
			const tarball = path.join(temp, packed[0].filename);
			expect(existsSync(tarball)).toBe(true);

			const consumer = path.join(temp, 'consumer');
			const installed = path.join(consumer, 'node_modules', 'svelte-adapter-uws');
			mkdirSync(installed, { recursive: true });
			execFileSync('tar', [
				'-xzf', tarball, '-C', installed, '--strip-components=1'
			], { encoding: 'utf8', timeout: 120000 });

			const modulePath = path.join(consumer, 'hooks.ws.mjs');
			writeFileSync(modulePath, fencedSnippet('// packed-example: plugin-authorization-lock'));
			const example = await import(pathToFileURL(modulePath).href);
			const ws = { getUserData: () => ({ userId: 'operator-1', role: 'admin' }) };
			const data = Buffer.from(JSON.stringify({
				topic: 'demo',
				action: 'reset-counter',
				payload: null
			}));

			await expect(example.message(ws, { data })).resolves.toBeUndefined();
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}, 180000);
});
