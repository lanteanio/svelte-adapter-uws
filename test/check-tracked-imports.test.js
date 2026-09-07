// The tracked-imports gate must refuse every import FORM that breaks a clone,
// not only the one-line named import a regular expression happens to match: a
// side-effect import, a named import spanning lines, `export ... from`, a
// literal dynamic import and a `require` all load the target at module load.
// It must also ignore a specifier that is only quoted in a comment or a
// string, since neither is a declaration. Each shape is driven against a
// scratch repository through the exported scan and, for the motivating case,
// through the real command-line entry.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOffenses, relativeImports, trackedPaths } from '../scripts/check-tracked-imports.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check-tracked-imports.js', import.meta.url));

describe('the tracked tree', () => {
	it('is clean, over a source list large enough to mean something', () => {
		const { offenses, scanned } = findOffenses();
		expect(offenses).toEqual([]);
		expect(scanned).toBeGreaterThan(400);
		expect(trackedPaths().has('scripts/check-tracked-imports.js')).toBe(true);
	});
});

describe('reading the imports of a module', () => {
	it('collects every static and dynamic form with the line it sits on', () => {
		const text = [
			'#!/usr/bin/env node',
			"import './side-effect.js';",
			'import {',
			'\tvalue',
			"} from './multiline.js';",
			"import def from './default.js';",
			"export { x } from './re-export.js';",
			"export * from './star.js';",
			"export const y = 1;",
			"const lazy = () => import('./lazy.js');",
			"const req = require('./legacy.cjs');",
			"const tpl = import(`./template.js`);",
			"import 'node:fs';",
			"import bare from 'acorn';"
		].join('\n');
		expect(relativeImports(text)).toEqual([
			{ specifier: './side-effect.js', line: 2 },
			{ specifier: './multiline.js', line: 3 },
			{ specifier: './default.js', line: 6 },
			{ specifier: './re-export.js', line: 7 },
			{ specifier: './star.js', line: 8 },
			{ specifier: './lazy.js', line: 10 },
			{ specifier: './legacy.cjs', line: 11 },
			{ specifier: './template.js', line: 12 }
		]);
	});

	it('does not read a specifier out of a comment, a string or a computed import', () => {
		const text = [
			"// import './commented.js';",
			"/* import x from './blocked.js'; */",
			"const doc = \"import y from './quoted.js'\";",
			"const spec = './computed.js';",
			'const a = import(spec);',
			'const b = import(`./${spec}`);',
			"const c = require(spec);",
			"import real from './real.js';"
		].join('\n');
		expect(relativeImports(text)).toEqual([{ specifier: './real.js', line: 8 }]);
	});
});

describe('against a scratch repository', () => {
	let repo;
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	const write = (rel, text) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'tracked-imports-'));
		git('init', '-q');
		git('config', 'user.email', 'test@example.invalid');
		git('config', 'user.name', 'Test');
		write('src/tracked.js', 'export const t = 1;\n');
		write('src/cjs.cjs', 'module.exports = 1;\n');
		write('src/clean.js', "import { t } from './tracked.js';\nexport { t };\n");
		write('src/named.js', "import { u } from './untracked.js';\nexport { u };\n");
		write('src/side-effect.js', "import './untracked.js';\n");
		write('src/multiline.js', "import {\n\tu\n} from './untracked.js';\nexport { u };\n");
		write('src/re-export.js', "export { u } from './untracked.js';\n");
		write('src/star.js', "export * from './untracked.js';\n");
		write('src/lazy.js', "export const load = () => import('./untracked.js');\n");
		write('src/legacy.js', "const one = require('./cjs.cjs');\nconst gone = require('./missing.cjs');\n");
		write('src/missing.js', "import { m } from './absent.js';\nexport { m };\n");
		write('src/bare.js', "import { t } from './tracked';\nexport { t };\n");
		write('src/query.js', "import { t } from './tracked.js?variant';\nexport { t };\n");
		write('src/quoted.js', "// import './ghost.js';\nconst s = \"import './ghost.js'\";\nexport { s };\n");
		write('src/computed.js', "const which = './untracked.js';\nexport const load = () => import(which);\n");
		write('src/broken.js', 'export const = ;\n');
		write('src/theme.css', 'body { margin: 0; }\n');
		write('src/styled.js', "import './widget.svelte';\nimport './theme.css';\n");
		write('scripts/tool.js', "#!/usr/bin/env node\nimport { t } from '../src/tracked.js';\nconsole.log(t);\n");
		write('test/fixture/src/app.js', "import '../build/handler/state.js';\n");
		write('test/uses-build.test.js', "import '../test/fixture/build/index.js';\nimport '../test/fixture/build-grant/index.js';\n");
		write('other/ignored.js', "import './untracked.js';\n");
		git('add', '-A');
		git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
		// On disk, never added: the case the gate exists for.
		write('src/untracked.js', 'export const u = 2;\n');
		write('src/widget.svelte', '<p>hi</p>\n');
		// The fixture's generated output: on disk, untracked, and out of scope.
		write('test/fixture/build/index.js', 'export {};\n');
		write('test/fixture/build/handler/state.js', 'export {};\n');
		write('test/fixture/build-grant/index.js', 'export {};\n');
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it('refuses every import form that reaches the untracked file, and names the line', () => {
		const { offenses, scanned } = findOffenses(repo);
		expect(scanned).toBe(19);
		const untracked = offenses.filter((line) => line.includes('./untracked.js'));
		expect(untracked.map((line) => line.split(':')[0]).sort()).toEqual([
			'src/lazy.js', 'src/multiline.js', 'src/named.js', 'src/re-export.js', 'src/side-effect.js', 'src/star.js'
		]);
		for (const line of untracked) expect(line).toMatch(/present on disk, absent from git/);
		expect(untracked.find((line) => line.startsWith('src/multiline.js'))).toMatch(/^src\/multiline\.js:1: /);
		expect(untracked.find((line) => line.startsWith('src/lazy.js'))).toMatch(/^src\/lazy\.js:1: /);
	});

	it('reports a target that resolves to nothing, an extensionless specifier and a file that does not parse', () => {
		const { offenses } = findOffenses(repo);
		expect(offenses.find((line) => line.startsWith('src/missing.js'))).toMatch(/imports \.\/absent\.js - which resolves to nothing/);
		expect(offenses.find((line) => line.startsWith('src/legacy.js'))).toMatch(/:2: imports \.\/missing\.cjs - which resolves to nothing/);
		expect(offenses.find((line) => line.startsWith('src/bare.js'))).toMatch(/imports \.\/tracked - no file extension/);
		expect(offenses.find((line) => line.startsWith('src/broken.js'))).toMatch(/does not parse as a module/);
		// Any extension names a file: the untracked .svelte is an offense, the
		// tracked .css is not, and neither is mistaken for a bare specifier.
		const styled = offenses.filter((line) => line.startsWith('src/styled.js'));
		expect(styled).toHaveLength(1);
		expect(styled[0]).toMatch(/^src\/styled\.js:1: imports \.\/widget\.svelte - present on disk, absent from git/);
	});

	it('leaves alone a tracked target, a query suffix, a quoted specifier, a computed import, the generated fixture output and a directory outside the scan', () => {
		const { offenses } = findOffenses(repo);
		const files = new Set(offenses.map((line) => line.split(':')[0]));
		for (const clean of ['src/clean.js', 'src/query.js', 'src/quoted.js', 'src/computed.js', 'scripts/tool.js', 'test/fixture/src/app.js', 'test/uses-build.test.js', 'other/ignored.js']) {
			expect(files.has(clean), clean).toBe(false);
		}
	});

	it('the command-line entry exits 1 against the scratch tree and 0 once the file is tracked', () => {
		const before = spawnSync(process.execPath, [SCRIPT, repo], { encoding: 'utf8' });
		expect(before.status).toBe(1);
		expect(before.stderr).toMatch(/src\/side-effect\.js:1: imports \.\/untracked\.js - present on disk, absent from git/);
		expect(before.stderr).toMatch(/breaks every clone/);

		// The offenses that are not the untracked file stay, so track it AND
		// remove the other shapes to see the entry report a clean tree.
		git('add', 'src/untracked.js', 'src/widget.svelte');
		git('rm', '-q', '--cached', 'src/missing.js', 'src/legacy.js', 'src/bare.js', 'src/broken.js');
		const after = spawnSync(process.execPath, [SCRIPT, repo], { encoding: 'utf8' });
		expect(after.status).toBe(0);
		expect(after.stdout).toMatch(/16 tracked source file\(s\) scanned; every relative import resolves to a tracked file/);
	});

	it('the entry refuses to call an empty repository clean', () => {
		const empty = mkdtempSync(join(tmpdir(), 'tracked-imports-empty-'));
		try {
			execFileSync('git', ['init', '-q'], { cwd: empty, stdio: 'ignore' });
			const result = spawnSync(process.execPath, [SCRIPT, empty], { encoding: 'utf8' });
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/listed no source file/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
