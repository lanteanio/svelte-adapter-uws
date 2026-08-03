import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const manifest = JSON.parse(readFileSync(new URL('../docs/code-blocks.v1.json', import.meta.url), 'utf8'));

function fencedSnippet(marker) {
	const markerAt = readme.indexOf(marker);
	if (markerAt < 0) throw new Error(`README snippet marker not found: ${marker}`);
	const fenceAt = readme.lastIndexOf('```js\n', markerAt);
	const bodyAt = fenceAt + '```js\n'.length;
	const end = readme.indexOf('\n```', markerAt);
	if (fenceAt < 0 || end < bodyAt) throw new Error(`README snippet fence is malformed: ${marker}`);
	return readme.slice(bodyAt, end) + '\n';
}

/** Fence body by its manifest record: `line` is the 1-based fence-open line. */
function fenceBodyAt(line) {
	const lines = readme.split('\n');
	const open = line - 1;
	if (!lines[open]?.startsWith('```')) throw new Error(`no fence opens at README.md:${line}`);
	let end = open + 1;
	while (end < lines.length && !lines[end].startsWith('```')) end++;
	if (end >= lines.length) throw new Error(`fence at README.md:${line} never closes`);
	return lines.slice(open + 1, end).join('\n') + '\n';
}

// Every block the manifest classifies as executed/packed-runtime names this
// file as its verification target, so this file must actually run ALL of
// them - a single hand-marked snippet would let 45 of 46 "executed" labels
// ship unexecuted.
const EXECUTED = manifest.blocks.filter((block) => block.classification === 'executed');

describe('packed README examples', () => {
	let temp;
	let consumer;

	beforeAll(() => {
		temp = mkdtempSync(path.join(tmpdir(), 'adapter-uws-readme-'));
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

		consumer = path.join(temp, 'consumer');
		const installed = path.join(consumer, 'node_modules', 'svelte-adapter-uws');
		mkdirSync(installed, { recursive: true });
		execFileSync('tar', [
			'-xzf', tarball, '-C', installed, '--strip-components=1'
		], { encoding: 'utf8', timeout: 120000 });
		writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
			name: 'readme-consumer',
			private: true,
			type: 'module'
		}));

		// A real `npm install svelte-adapter-uws` delivers the package's
		// declared dependency tree; the tarball alone does not. Satisfy it
		// from this repo's own lockfile-resolved node_modules (hoisted, so
		// transitive dependencies ride along) via links, not the network.
		for (const entry of readdirSync(path.join(root, 'node_modules'))) {
			if (entry.startsWith('.') || entry === 'svelte-adapter-uws') continue;
			const source = path.join(root, 'node_modules', entry);
			const target = path.join(consumer, 'node_modules', entry);
			if (existsSync(target)) continue;
			symlinkSync(source, target, 'junction');
		}
	}, 180000);

	afterAll(() => {
		if (temp) rmSync(temp, { recursive: true, force: true });
	});

	it('imports and executes the authorization lock example from the packed public subpath', async () => {
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
	}, 60000);

	it('executes every fence the manifest classifies as executed against the packed tarball', () => {
		expect(EXECUTED.length).toBeGreaterThan(30);
		const failures = [];
		for (const block of EXECUTED) {
			const file = path.join(consumer, `readme-${block.line}.mjs`);
			const body = fenceBodyAt(block.line);
			writeFileSync(file, block.language === 'ts'
				? ts.transpileModule(body, {
					compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
				}).outputText
				: body);
			try {
				execFileSync(process.execPath, [file], {
					cwd: consumer,
					encoding: 'utf8',
					timeout: 120000,
					stdio: ['ignore', 'pipe', 'pipe']
				});
			} catch (error) {
				const detail = (error.stderr || error.message || '').toString().split('\n').slice(0, 6).join('\n');
				failures.push(`README.md:${block.line} (${block.section}) failed:\n${detail}`);
			}
		}
		expect(failures, failures.join('\n\n')).toEqual([]);
	}, 600000);
});
