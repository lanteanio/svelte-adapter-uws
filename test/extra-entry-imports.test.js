// The build imports each discovered `__` entry by the file Rollup wrote for it.
//
// The generated index used to import `./server/${name}.js` built from the entry
// name. Rollup rewrites characters it will not put in a file name, so an entry
// named `__a#b` is written as `__a_b.js` and the import pointed at nothing; an
// apostrophe in a name ended the quoted specifier and broke the whole file.
// This runs a real Rollup build of such entries and imports the index the
// helper produced, so the entries' side effects are what prove it.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { writeAndCloseRollupBundle, extraEntryImports, discoverExtraEntries } from '../src/build-rollup-lifecycle.js';

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('extra entry imports', () => {
	it('discovers mixed-case entries in file-name order without sorting its input', () => {
		const listing = ['__b.js', '__known.js', '__a.js', '__B.js', 'x.js', '__data.json'];
		expect(discoverExtraEntries(listing, ['__known.js'])).toEqual(['__B', '__a', '__b']);
		expect(listing[0]).toBe('__b.js');
	});
	it('allows a later static entry to evaluate while the first awaits', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'extra-entry-await-'));
		dirs.push(root);
		const src = path.join(root, 'src');
		const out = path.join(root, 'out');
		mkdirSync(src);
		const marker = '__extraEntryAwaitProbe';
		writeFileSync(path.join(src, '__a.js'), `globalThis.${marker} = ['a-pre']; await new Promise(resolve => setTimeout(resolve, 20)); globalThis.${marker}.push('a-post');`);
		writeFileSync(path.join(src, '__b.js'), `globalThis.${marker}.push('b');`);
		const names = discoverExtraEntries(['__b.js', '__a.js'], []);
		const bundle = await rollup({ input: Object.fromEntries(names.map(name => [name, path.join(src, name + '.js')])) });
		const written = await writeAndCloseRollupBundle(bundle, { dir: path.join(out, 'server'), format: 'esm' });
		writeFileSync(path.join(out, 'index.mjs'), extraEntryImports(written, src, names) + '\n');
		// Native ESM is the deployment contract; Vitest's module runner serializes
		// static dependency evaluation and cannot establish sibling interleaving.
		const output = execFileSync(process.execPath, ['--input-type=module', '-e',
			`await import(${JSON.stringify(pathToFileURL(path.join(out, 'index.mjs')).href)}); console.log(JSON.stringify(globalThis.${marker}));`
		], { encoding: 'utf8', windowsHide: true });
		expect(JSON.parse(output)).toEqual(['a-pre', 'b', 'a-post']);
	});

	it('imports entries whose names Rollup rewrites or that carry an apostrophe', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'extra-entries-'));
		dirs.push(root);
		const src = path.join(root, 'src');
		const out = path.join(root, 'out');
		mkdirSync(src);
		const names = ['__a#b', "__it's", '__plain'].sort();
		const marker = `__extraEntryProbe_${Date.now()}`;
		for (const name of names) {
			writeFileSync(path.join(src, `${name}.js`), `(globalThis[${JSON.stringify(marker)}] ??= []).push(${JSON.stringify(name)});\n`);
		}
		const input = Object.fromEntries(names.map((name) => [name, path.join(src, `${name}.js`)]));
		const bundle = await rollup({ input });
		const written = await writeAndCloseRollupBundle(bundle, { dir: path.join(out, 'server'), format: 'esm' });
		const lines = extraEntryImports(written, src, names);
		expect(lines).not.toContain('__a#b.js');
		writeFileSync(path.join(out, 'index.mjs'), lines + '\n');
		await import(pathToFileURL(path.join(out, 'index.mjs')).href);
		expect(globalThis[marker], 'every entry ran, in load order').toEqual(names);
	});
	it('runs sanitized entries reached through a directory junction', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'extra-entry-junction-'));
		dirs.push(root);
		const real = path.join(root, 'real');
		const linked = path.join(root, 'linked');
		const out = path.join(root, 'out');
		mkdirSync(real);
		const names = ['__a#b', '__a%b', '__a_b'];
		const marker = '__extraEntryJunctionProbe';
		for (const name of names) {
			writeFileSync(path.join(real, name + '.js'), `(globalThis[${JSON.stringify(marker)}] ??= []).push(${JSON.stringify(name)});\n`);
		}
		symlinkSync(real, linked, 'junction');
		try {
			const input = Object.fromEntries(names.map((name) => [name, path.join(linked, name + '.js')]));
			const bundle = await rollup({ input, plugins: [nodeResolve()] });
			const written = await writeAndCloseRollupBundle(bundle, { dir: path.join(out, 'server'), format: 'esm' });
			for (const name of names) {
				expect(written.output.some((chunk) => chunk.type === 'chunk' &&
					typeof chunk.facadeModuleId === 'string' && path.resolve(chunk.facadeModuleId) === realpathSync(path.join(real, name + '.js')))).toBe(true);
			}
			const lines = extraEntryImports(written, linked, names);
			writeFileSync(path.join(out, 'index.mjs'), lines + '\n');
			await import(pathToFileURL(path.join(out, 'index.mjs')).href);
			expect(lines).not.toContain('__a#b.js');
			expect(lines).not.toContain('__a%b.js');
			expect(globalThis[marker], 'all colliding sanitized names must run in order').toEqual(names);
		} finally {
			delete globalThis[marker];
			unlinkSync(linked);
		}
	});

});
