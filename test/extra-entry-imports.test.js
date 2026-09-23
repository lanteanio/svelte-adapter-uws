// The build imports each discovered `__` entry by the file Rollup wrote for it.
//
// The generated index used to import `./server/${name}.js` built from the entry
// name. Rollup rewrites characters it will not put in a file name, so an entry
// named `__a#b` is written as `__a_b.js` and the import pointed at nothing; an
// apostrophe in a name ended the quoted specifier and broke the whole file.
// This runs a real Rollup build of such entries and imports the index the
// helper produced, so the entries' side effects are what prove it.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { writeAndCloseRollupBundle, extraEntryImports } from '../src/build-rollup-lifecycle.js';

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('extra entry imports', () => {
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
});
