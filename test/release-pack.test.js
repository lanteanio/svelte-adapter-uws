import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packRelease, validatePackManifest } from '../scripts/pack-release.js';

const sourcePkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const npmCli = process.env.UWS_RELEASE_NPM_CLI || process.env.npm_execpath;
function cliVersion(cli) {
	try { return JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version; } catch { return undefined; }
}
// CI always runs these against the pinned npm; local runs without it skip them.
const packingCli = Boolean(process.env.CI) || (npmCli && cliVersion(npmCli) === '11.5.1');
function fixture() {
	const base = mkdtempSync(join(tmpdir(), 'uws-release-pack-'));
	const source = join(base, 'source'); mkdirSync(source);
	const pkg = { ...sourcePkg, files: ['index.js', 'README.md'], dependencies: {}, optionalDependencies: {}, devDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} };
	writeFileSync(join(source, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
	writeFileSync(join(source, 'index.js'), 'export const value = 42;\n');
	writeFileSync(join(source, 'README.md'), '# Test package\n');
	const git = (...args) => {
		const result = spawnSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true });
		expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
	};
	git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('add', 'package.json', 'index.js', 'README.md');
	git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Test package');
	return { base, source, pkg, git };
}

async function archiveContents(tarball) {
	const files = new Map(); const reads = [];
	await createRequire(npmCli)('tar').t({ file: tarball, onentry(entry) {
		reads.push(new Promise((accept, reject) => {
			const chunks = []; entry.on('data', chunk => chunks.push(chunk)); entry.on('error', reject);
			entry.on('end', () => { files.set(entry.path, Buffer.concat(chunks)); accept(); });
		}));
	} });
	await Promise.all(reads); return files;
}

describe.skipIf(!packingCli)('immutable stable release packing (needs npm 11.5.1 as npm_execpath or UWS_RELEASE_NPM_CLI)', () => {
	it('packs real Git bytes reproducibly and preserves explicit gitHead through npm tarball metadata', async () => {
		const value = fixture();
		try {
			const first = await packRelease({ source: value.source, destination: join(value.base, 'first'), npmCli });
			const second = await packRelease({ source: value.source, destination: join(value.base, 'second'), npmCli });
			expect(first.sha256).toBe(second.sha256);
			expect(first.gitHead).toBe(value.git('rev-parse', 'HEAD'));
			const tarball = join(value.base, 'first', first.filename);
			const files = await archiveContents(tarball);
			expect([...files.keys()].sort()).toEqual(['package/README.md', 'package/index.js', 'package/package.json']);
			expect(files.get('package/index.js')).toEqual(readFileSync(join(value.source, 'index.js')));
			expect(files.get('package/README.md')).toEqual(readFileSync(join(value.source, 'README.md')));
			expect(JSON.parse(files.get('package/package.json'))).toEqual({ ...value.pkg, gitHead: first.gitHead });
			// This is the same full-metadata reader npm publish uses for a tarball.
			const pacote = createRequire(npmCli)('pacote');
			const metadata = await pacote.manifest(tarball, { fullmetadata: true, fullReadJson: true, cache: join(value.base, 'cache') });
			expect(metadata.gitHead).toBe(first.gitHead);
			expect(value.git('status', '--porcelain=v1')).toBe('');
			expect(JSON.parse(readFileSync(join(value.source, 'package.json'), 'utf8'))).not.toHaveProperty('gitHead');
			await expect(packRelease({ source: value.source, destination: join(value.base, 'first'), npmCli })).rejects.toThrow('already exists');
		} finally { rmSync(value.base, { recursive: true, force: true }); }
	}, 60_000);

	it('refuses dirty, untracked, non-main and scripted source before producing an artifact', async () => {
		const value = fixture();
		try {
			writeFileSync(join(value.source, 'index.js'), 'changed\n');
			await expect(packRelease({ source: value.source, destination: join(value.base, 'dirty'), npmCli })).rejects.toThrow('clean');
			writeFileSync(join(value.source, 'index.js'), 'export const value = 42;\n');
			writeFileSync(join(value.source, 'extra.js'), 'untracked\n');
			await expect(packRelease({ source: value.source, destination: join(value.base, 'untracked'), npmCli })).rejects.toThrow('clean');
			rmSync(join(value.source, 'extra.js'));
			value.git('branch', '-m', 'other');
			await expect(packRelease({ source: value.source, destination: join(value.base, 'wrong-branch'), npmCli })).rejects.toThrow('main');
			for (const key of ['prepack', 'prepare', 'postpack', 'postpack:release']) {
				expect(() => validatePackManifest({ ...value.pkg, scripts: { ...value.pkg.scripts, [key]: 'echo wrong' } })).toThrow('inventory');
			}
			expect(() => validatePackManifest({ ...value.pkg, gitHead: 'a'.repeat(40) })).toThrow('gitHead');
			for (const extra of [{ registry: 'http://127.0.0.1:59999' }, { provenance: false }]) {
				expect(() => validatePackManifest({ ...value.pkg, publishConfig: { ...value.pkg.publishConfig, ...extra } })).toThrow('identity');
			}
			await expect(packRelease({ source: value.source, destination: join(value.base, 'wrong-cli'), npmCli: '' })).rejects.toThrow('npm 11.5.1');
		} finally { rmSync(value.base, { recursive: true, force: true }); }
	}, 30_000);
	it('ignores untracked selection rules and hidden workspace edits when selecting frozen files', async () => {
		const value = fixture();
		try {
			value.pkg.files.push('files');
			writeFileSync(join(value.source, 'package.json'), JSON.stringify(value.pkg, null, 2) + '\n');
			writeFileSync(join(value.source, '.gitignore'), 'files/.npmignore\n');
			mkdirSync(join(value.source, 'files'));
			writeFileSync(join(value.source, 'files', 'required.js'), 'export const required = 42;\n');
			writeFileSync(join(value.source, 'index.js'), "export { required } from './files/required.js';\n");
			value.git('add', 'package.json', '.gitignore', 'index.js', 'files/required.js');
			value.git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Add required module');
			const baseline = await packRelease({ source: value.source, destination: join(value.base, 'baseline'), npmCli });
			writeFileSync(join(value.source, 'files', '.npmignore'), 'required.js\n');
			expect(value.git('status', '--porcelain=v1')).toBe('');
			const ignored = await packRelease({ source: value.source, destination: join(value.base, 'ignored'), npmCli });
			expect(ignored.sha256).toBe(baseline.sha256);
			expect(ignored.files.map(file => file.path)).toContain('files/required.js');
			value.git('update-index', '--assume-unchanged', 'index.js', 'package.json');
			writeFileSync(join(value.source, 'index.js'), 'throw new Error("uncommitted");\n');
			writeFileSync(join(value.source, 'package.json'), JSON.stringify({ ...value.pkg, files: [] }));
			expect(value.git('status', '--porcelain=v1')).toBe('');
			const hidden = await packRelease({ source: value.source, destination: join(value.base, 'hidden'), npmCli });
			expect(hidden.sha256).toBe(baseline.sha256);
		} finally { rmSync(value.base, { recursive: true, force: true }); }
	}, 60_000);

	it('rejects tracked symlink and submodule entries before npm can omit them', async () => {
		for (const mode of ['120000', '160000']) {
			const value = fixture();
			try {
				const target = mode === '120000' ? value.git('rev-parse', 'HEAD:index.js') : value.git('rev-parse', 'HEAD');
				value.git('config', 'core.symlinks', 'false');
				value.git('update-index', '--add', '--cacheinfo', mode + ',' + target + ',linked');
				if (mode === '120000') value.git('checkout-index', '-f', 'linked');
				else mkdirSync(join(value.source, 'linked'));
				value.git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Add linked entry');
				expect(value.git('status', '--porcelain=v1')).toBe('');
				await expect(packRelease({ source: value.source, destination: join(value.base, 'links'), npmCli })).rejects.toThrow('symlink, submodule');
			} finally { rmSync(value.base, { recursive: true, force: true }); }
		}
	}, 30_000);

});
