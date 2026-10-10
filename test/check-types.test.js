import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-types.js', import.meta.url));
const fixtures = [];
afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(exports, extra = {}, files = {}) {
	const root = mkdtempSync(join(tmpdir(), 'adapter-types-'));
	fixtures.push(root);
	const contents = {
		'package.json': JSON.stringify({ name: 'type-check-fixture', version: '1.0.0', type: 'module', files: ['src'], exports, ...extra }),
		'src/index.js': 'export const value = 1;\n',
		'src/index.d.ts': 'export declare const value: number;\n',
		'src/styles.css': 'body {}\n',
		...files
	};
	for (const [name, text] of Object.entries(contents)) {
		const target = join(root, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 10000 });
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.stdout).toContain('type-check-fixture@1.0.0');
	return { status: result.status, output: result.stdout + result.stderr };
}

it.each([
	{ './value': './src/index.js' },
	{ './value': { import: './src/index.js' } },
	{ './value': { default: './src/index.js' } },
	{ './value': { node: { import: './src/index.js' } } },
	{ import: './src/index.js' },
	'./src/index.js'
])('rejects an untyped runtime export: %j', (exports) => {
	const result = check(exports);
	expect(result.status).toBe(1);
	expect(result.output).toContain('./src/index.js has no types condition');
});

it('accepts declared runtime exports and non-JavaScript assets', () => {
	const result = check({
		'.': { types: './src/index.d.ts', default: './src/index.js' },
		'./styles': './src/styles.css'
	});
	expect(result.status).toBe(0);
});

it('does not treat legacy main and module fields as export-map subpaths', () => {
	const result = check(undefined, { main: './src/index.js', module: './src/index.js', types: './src/index.d.ts' });
	expect(result.status).toBe(0);
});

it('still rejects a declaration that omits a named runtime export', () => {
	const result = check({ '.': { types: './src/index.d.ts', default: './src/index.js' } }, {}, {
		'src/index.d.ts': 'export declare const different: number;\n'
	});
	expect(result.status).toBe(1);
	expect(result.output).toContain('exports `value` but ./src/index.d.ts does not declare it');
});

const typed = { '.': { types: './src/index.d.ts', default: './src/index.js' } };

it('accepts a root condition map with declarations', () => {
	expect(check(typed['.']).status).toBe(0);
});

it('follows a runtime star even when an adjacent declaration hides its name', () => {
	const result = check(typed, {}, {
		'src/index.js': "export * from './leaf.js';\n",
		'src/leaf.js': 'export const hidden = 1;\n',
		'src/leaf.d.ts': 'export {};\n'
	});
	expect(result.status).toBe(1);
	expect(result.output).toContain('exports `hidden`');
});

it('follows declaration stars using declaration resolution for JavaScript specifiers', () => {
	expect(check(typed, {}, {
		'src/index.d.ts': "export * from './leaf.js';\n",
		'src/leaf.d.ts': 'export declare const value: number;\n'
	}).status).toBe(0);
});

it('follows nested and cyclic stars without exporting default or ambiguous bindings', () => {
	expect(check(typed, {}, {
		'src/index.js': "export * from './a.js'; export * from './b.js';\n",
		'src/a.js': "export * from './index.js'; export * from './leaf.js'; export const conflict = 1; export default 1;\n",
		'src/b.js': "export * from './leaf.js'; export const conflict = 2;\n",
		'src/leaf.js': 'export const value = 1;\n'
	}).status).toBe(0);
});

it('keeps explicit exports that disambiguate stars and requires their declarations', () => {
	const result = check(typed, {}, {
		'src/index.js': "export * from './a.js'; export * from './b.js'; export { conflict } from './a.js';\n",
		'src/a.js': 'export const conflict = 1;\n',
		'src/b.js': 'export const conflict = 2;\n'
	});
	expect(result.status).toBe(1);
	expect(result.output).toContain('exports `conflict`');
});

it('recognizes a diamond through imported local bindings', () => {
	expect(check(typed, {}, {
		'src/index.js': "export * from './a.js'; export * from './b.js';\n",
		'src/a.js': "import { value } from './leaf.js'; export { value };\n",
		'src/b.js': "export { value } from './leaf.js';\n",
		'src/leaf.js': 'export const value = 1;\n'
	}).status).toBe(0);
});

it('resolves package stars separately for runtime and declarations', () => {
	const files = {
		'src/index.js': "export * from 'dependency';\n",
		'src/index.d.ts': "export * from 'dependency';\n",
		'node_modules/dependency/package.json': JSON.stringify({ name: 'dependency', type: 'module', exports: { types: './index.d.ts', import: './index.js' } }),
		'node_modules/dependency/index.js': 'export const value = 1;\n',
		'node_modules/dependency/index.d.ts': 'export declare const value: number;\n'
	};
	expect(check(typed, {}, files).status).toBe(0);
	files['node_modules/dependency/index.d.ts'] = 'export {};\n';
	const missing = check(typed, {}, files);
	expect(missing.status).toBe(1);
	expect(missing.output).toContain('exports `value`');
});

it.each(['js', 'd.ts'])('fails a missing %s re-export explicitly', (extension) => {
	const result = check(typed, {}, { [`src/index.${extension}`]: "export * from './missing.js';\n" });
	expect(result.status).toBe(1);
	expect(result.output).toContain('cannot resolve');
});

it('reads declarations as syntax so comments and string literals cannot invent names', () => {
	const result = check(typed, {}, {
		'src/index.d.ts': '// export const value: number;\nexport type Text = "export const value: number";\n'
	});
	expect(result.status).toBe(1);
	expect(result.output).toContain('exports `value`');
});

it('checks destructured named runtime exports', () => {
	const result = check(typed, {}, { 'src/index.js': 'export const { missing: hidden } = { missing: 1 };\n' });
	expect(result.status).toBe(1);
	expect(result.output).toContain('exports `hidden`');
});

it('requires a directly re-exported namespace reached through two star paths', () => {
	const branch = "export * as ns from './leaf.js';\n";
	const files = {
		'src/index.js': "export * from './a.js'; export * from './b.js';\n",
		'src/a.js': branch,
		'src/b.js': branch,
		'src/leaf.js': 'export const value = 1;\n',
		'src/leaf.d.ts': 'export declare const value: number;\n'
	};
	const missing = check(typed, {}, files);
	expect(missing.status).toBe(1);
	expect(missing.output).toContain('exports `ns`');
	files['src/index.d.ts'] = "export * as ns from './leaf.js';\n";
	expect(check(typed, {}, files).status).toBe(0);
});

it('keeps distinct locally re-exported namespace imports ambiguous', () => {
	const branch = "import * as ns from './leaf.js'; export { ns };\n";
	expect(check(typed, {}, {
		'src/index.js': "export * from './a.js'; export * from './b.js';\n",
		'src/a.js': branch,
		'src/b.js': branch,
		'src/leaf.js': 'export const value = 1;\n',
		'src/index.d.ts': 'export {};\n'
	}).status).toBe(0);
});
