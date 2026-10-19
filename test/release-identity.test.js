import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { main, tarballFile, verifyLocalTag } from '../scripts/prepare-release.js';

const rootFile = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const sourcePkg = JSON.parse(rootFile('package.json'));
const tag = sourcePkg.name + '@' + sourcePkg.version;
const script = fileURLToPath(new URL('../scripts/prepare-release.js', import.meta.url));
// The tagged commit carries the release route the local check validates.
const releaseFiles = ['package.json', '.github/workflows/release.yml', '.github/workflows/test.yml', 'docs/releasing.md'];
const bases = [];
const links = [];

afterEach(() => {
	// Remove dependency links first so cleanup never walks into the real tree.
	for (const link of links.splice(0)) {
		try { unlinkSync(link); } catch { rmdirSync(link); }
	}
	for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function header(name, size, { type = '0', prefix = '', sizeField } = {}) {
	const block = Buffer.alloc(512);
	block.write(name, 0);
	block.write('0000644\0', 100);
	block.write(sizeField ?? size.toString(8).padStart(11, '0') + '\0', 124);
	block.write(type, 156);
	block.write('ustar\0' + '00', 257);
	if (prefix) block.write(prefix, 345);
	return block;
}

// A gzipped ustar archive; each entry is { name, body, type, prefix, sizeField }.
function tarball(entries) {
	const blocks = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body);
		blocks.push(header(entry.name, body.length, entry), body, Buffer.alloc((512 - body.length % 512) % 512));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const manifestEntry = manifest => ({ name: 'package/package.json', body: JSON.stringify(manifest) });

function repository({ pkg = sourcePkg } = {}) {
	const base = mkdtempSync(join(tmpdir(), 'uws-release-identity-'));
	bases.push(base);
	const source = join(base, 'source');
	const run = (...args) => {
		const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: source, encoding: 'utf8', windowsHide: true });
		expect(result.status, result.stderr).toBe(0);
		return result.stdout.trim();
	};
	spawnSync('git', ['init', '-q', '-b', 'main', source], { encoding: 'utf8', windowsHide: true });
	run('config', 'core.autocrlf', 'false');
	for (const file of releaseFiles) {
		mkdirSync(dirname(join(source, file)), { recursive: true });
		writeFileSync(join(source, file), file === 'package.json' ? JSON.stringify(pkg, null, 2) + '\n' : rootFile(file));
	}
	run('add', ...releaseFiles);
	run('commit', '-qm', 'Release source');
	run('update-ref', 'refs/remotes/origin/main', 'HEAD');
	const artifact = join(base, 'artifact.tgz');
	const pack = (gitHead = run('rev-parse', 'HEAD'), entries = [manifestEntry({ name: pkg.name, version: pkg.version, gitHead })]) => {
		writeFileSync(artifact, tarball(entries));
		return createHash('sha256').update(readFileSync(artifact)).digest('hex');
	};
	const digest = pack();
	const annotate = (body, at = 'HEAD') => {
		const file = join(base, 'annotation.txt');
		writeFileSync(file, body);
		run('tag', '-a', tag, at, '-F', file);
	};
	const env = () => ({
		GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GITHUB_REF: 'refs/tags/' + tag,
		GITHUB_REPOSITORY: 'lanteanio/svelte-adapter-uws', GITHUB_SHA: run('rev-parse', 'refs/tags/' + tag)
	});
	const verify = () => verifyLocalTag({ cwd: source, tag, artifact });
	return { base, source, run, artifact, digest, pack, annotate, env, verify };
}

const annotation = digest => 'Release ' + sourcePkg.version + '\n\nArtifact-SHA256: ' + digest + '\n';

describe('release identity against real tags', () => {
	it('binds an annotated tag on main to its artifact digest', async () => {
		const repo = repository();
		repo.annotate(annotation(repo.digest));
		const identity = main({ cwd: repo.source, env: repo.env() });
		expect(identity.artifactSha256).toBe(repo.digest);
		expect(identity.head).toBe(repo.run('rev-parse', 'HEAD'));
		expect((await repo.verify()).artifactSha256).toBe(repo.digest);
	});

	it('refuses a lightweight tag', async () => {
		const repo = repository();
		repo.run('tag', tag);
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow();
		await expect(repo.verify()).rejects.toThrow(/annotated/);
	});

	it('refuses a tagged commit outside origin/main', async () => {
		const repo = repository();
		repo.run('commit', '-q', '--allow-empty', '-m', 'Unreviewed');
		repo.annotate(annotation(repo.pack()));
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/origin\/main/);
		await expect(repo.verify()).rejects.toThrow(/origin\/main/);
	});

	it('does not accept a local branch named like the remote branch', async () => {
		const repo = repository();
		repo.run('checkout', '-q', '-b', 'side');
		repo.run('commit', '-q', '--allow-empty', '-m', 'Unreviewed');
		repo.run('branch', 'origin/main', 'side');
		repo.annotate(annotation(repo.pack()));
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/origin\/main/);
		await expect(repo.verify()).rejects.toThrow(/origin\/main/);
		// Without the remote-tracking ref, git would resolve the full name to a local branch.
		repo.run('update-ref', '-d', 'refs/remotes/origin/main');
		repo.run('branch', 'refs/remotes/origin/main', 'side');
		await expect(repo.verify()).rejects.toThrow(/refs\/remotes\/origin\/main is missing/);
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/refs\/remotes\/origin\/main is missing/);
	});

	it('refuses a tag whose tarball was packed from another commit', async () => {
		const repo = repository();
		const packed = repo.run('rev-parse', 'HEAD');
		repo.run('commit', '-q', '--allow-empty', '-m', 'Later main commit');
		repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
		repo.annotate(annotation(repo.pack()), packed);
		await expect(repo.verify()).rejects.toThrow(/gitHead/);
	});

	it('refuses a tarball of another package or version', async () => {
		for (const manifest of [{ name: 'other-package', version: sourcePkg.version }, { name: sourcePkg.name, version: '0.0.1' }]) {
			const repo = repository();
			const digest = repo.pack(undefined, [manifestEntry({ ...manifest, gitHead: repo.run('rev-parse', 'HEAD') })]);
			repo.annotate(annotation(digest));
			await expect(repo.verify()).rejects.toThrow(/tarball package is/);
		}
	});

	it('refuses a file that is not an npm tarball even when its digest matches', async () => {
		const repo = repository();
		writeFileSync(repo.artifact, 'retained bytes');
		repo.annotate(annotation(createHash('sha256').update('retained bytes').digest('hex')));
		await expect(repo.verify()).rejects.toThrow();
		const gzip = repository();
		const digest = gzip.pack(undefined, [{ name: 'package/index.js', body: 'export {};' }]);
		gzip.annotate(annotation(digest));
		await expect(gzip.verify()).rejects.toThrow(/not an npm tarball/);
	});

	it('reads the manifest npm and tar would read and refuses ambiguous archives', () => {
		const manifest = JSON.stringify({ name: 'x', version: '1.0.0' });
		const read = entries => tarballFile(tarball(entries), 'package/package.json')?.toString();
		expect(read([{ name: 'package.json', prefix: 'package', body: manifest }])).toBe(manifest);
		const pax = '29 path=package/package.json\n';
		expect(read([{ name: 'PaxHeader/long', type: 'x', body: pax }, { name: 'ignored-name', body: manifest }])).toBe(manifest);
		expect(read([{ name: 'PaxHeader/long', type: 'x', body: pax }, { name: 'ignored-name', body: manifest }, { name: 'package/other.js', body: 'x' }])).toBe(manifest);
		expect(read([{ name: 'package/package.json', body: manifest }, { name: 'package/package.json', body: manifest }])).toBeUndefined();
		expect(read([{ name: 'package/package.json', body: manifest, sizeField: '-1000\0' }])).toBeUndefined();
		expect(read([{ name: 'package/package.json', body: manifest, sizeField: '77777777777\0' }])).toBeUndefined();
		// parseInt would read a signed size; tar size fields are octal digits only.
		expect(read([{ name: 'package/package.json', body: manifest, sizeField: '+' + manifest.length.toString(8) + '\0' }])).toBeUndefined();
	});

	it('refuses a tagged package or workflow that CI would refuse', async () => {
		const hidden = repository({ pkg: { ...sourcePkg, private: true } });
		hidden.annotate(annotation(hidden.digest));
		await expect(hidden.verify()).rejects.toThrow(/private package/);
		const drifted = repository();
		writeFileSync(join(drifted.source, '.github/workflows/release.yml'), rootFile('.github/workflows/release.yml').replace('cancel-in-progress: false', 'cancel-in-progress: true'));
		drifted.run('commit', '-qam', 'Drift');
		drifted.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
		drifted.annotate(annotation(drifted.pack()));
		await expect(drifted.verify()).rejects.toThrow(/without cancelling/);
	});

	it('checks the workflow of the tagged commit, not the working tree', async () => {
		const workflow = rootFile('.github/workflows/release.yml');
		const drift = workflow.replace('cancel-in-progress: false', 'cancel-in-progress: true');
		const edited = repository();
		edited.annotate(annotation(edited.digest));
		writeFileSync(join(edited.source, '.github/workflows/release.yml'), drift);
		expect((await edited.verify()).artifactSha256).toBe(edited.digest);
		const restored = repository();
		writeFileSync(join(restored.source, '.github/workflows/release.yml'), drift);
		restored.run('commit', '-qam', 'Drift');
		restored.annotate(annotation(restored.pack()));
		writeFileSync(join(restored.source, '.github/workflows/release.yml'), workflow);
		restored.run('commit', '-qam', 'Restore');
		restored.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
		await expect(restored.verify()).rejects.toThrow(/without cancelling/);
	});

	it('runs the CI identity check with Node builtins only', () => {
		// The identity job runs this script before installing any dependency.
		const text = rootFile('scripts/prepare-release.js');
		const imports = [...text.matchAll(/^\s*(?:import|export)\s[^'";]*?from\s*(['"])([^'"]+)\1|^\s*import\s*(['"])([^'"]+)\3/gm)].map(match => match[2] ?? match[4]);
		expect(imports.length).toBeGreaterThan(0);
		for (const specifier of imports) expect(specifier).toMatch(/^node:/);
		const repo = repository();
		mkdirSync(join(repo.source, 'scripts'));
		writeFileSync(join(repo.source, 'scripts/prepare-release.js'), text);
		repo.run('add', 'scripts/prepare-release.js');
		repo.run('commit', '-qm', 'Release script');
		repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
		const digest = repo.pack();
		repo.annotate(annotation(digest));
		const output = join(repo.base, 'github-output.txt');
		const result = spawnSync(process.execPath, ['scripts/prepare-release.js'], {
			cwd: repo.source, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...repo.env(), GITHUB_OUTPUT: output }
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(output, 'utf8')).toBe('sha256=' + digest + '\nfilename=' + sourcePkg.name + '-' + sourcePkg.version + '.tgz\n');
	});

	it('requires the retained tarball and exact arguments', async () => {
		const repo = repository();
		repo.annotate(annotation(repo.digest));
		await expect(verifyLocalTag({ cwd: repo.source, tag })).rejects.toThrow(/tarball is required/);
		await expect(verifyLocalTag({ cwd: repo.source, tag, artifact: repo.base })).rejects.toThrow();
		for (const args of [['--verify-tag', tag], ['--verify-tag', tag, '--artefact', repo.artifact], ['--verify-tag', tag, '--artifact', repo.artifact, '--force']]) {
			const result = spawnSync(process.execPath, [script, ...args], { cwd: repo.source, encoding: 'utf8', windowsHide: true });
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/usage/);
		}
	});

	it('refuses a dirty checkout', () => {
		const repo = repository();
		repo.annotate(annotation(repo.digest));
		writeFileSync(join(repo.source, 'stray.txt'), 'untracked');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/dirty/);
	});

	it('refuses annotations a pushed tag could never correct', async () => {
		const repo = repository();
		repo.annotate(annotation(repo.digest.toUpperCase()));
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/artifact SHA256/);
		await expect(repo.verify()).rejects.toThrow(/Artifact-SHA256/);
	});

	it('refuses a local tag that binds different bytes', async () => {
		const repo = repository();
		repo.annotate(annotation('a'.repeat(64)));
		await expect(repo.verify()).rejects.toThrow(/does not match/);
	});

	it('keeps the release scripts loadable from a CRLF checkout', () => {
		// Vite's SSR transform only recognises an LF-terminated hashbang, so a
		// hashbang in a CRLF checkout breaks every test that imports the script.
		for (const file of ['scripts/prepare-release.js', 'scripts/check-release-workflow.js', 'scripts/pack-release.js']) {
			expect(rootFile(file).startsWith('#!'), file).toBe(false);
		}
	});
});

// The commands in docs/releasing.md, run as written in a clone whose origin is
// a local bare repository.
const releasingDoc = rootFile('docs/releasing.md').replace(/\r\n/g, '\n');
function docBlock(language) {
	const blocks = [...releasingDoc.matchAll(/```(\w+)\n([\s\S]*?)```/g)].filter(([, lang, body]) => lang === language && body.includes('git tag -a'));
	expect(blocks).toHaveLength(1);
	return blocks[0][2];
}
const powershell = ['pwsh', 'powershell'].find(bin => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true }).status === 0);
const posixShell = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true }).status === 0;

function releaseClone() {
	const base = mkdtempSync(join(tmpdir(), 'uws-release-docs-'));
	bases.push(base);
	const origin = join(base, 'origin.git');
	const work = join(base, 'work');
	const git = (cwd, ...args) => {
		const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
		expect(result.status, result.stderr).toBe(0);
		return result.stdout.trim();
	};
	git(base, 'init', '-q', '--bare', '-b', 'main', origin);
	git(base, 'init', '-q', '-b', 'main', work);
	for (const [key, value] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.test'], ['tag.gpgSign', 'false'], ['commit.gpgSign', 'false']]) git(work, 'config', key, value);
	git(work, 'remote', 'add', 'origin', origin);
	for (const file of [...releaseFiles, 'scripts/prepare-release.js', 'scripts/check-release-workflow.js']) {
		mkdirSync(dirname(join(work, file)), { recursive: true });
		writeFileSync(join(work, file), rootFile(file));
	}
	writeFileSync(join(work, '.gitignore'), 'node_modules\n');
	git(work, 'add', '-A');
	git(work, 'commit', '-qm', 'Release source');
	// Stands in for npm ci: the local check loads yaml.
	const modules = join(work, 'node_modules');
	symlinkSync(realpathSync(fileURLToPath(new URL('../node_modules', import.meta.url))), modules, 'junction');
	links.push(modules);
	const source = git(work, 'rev-parse', 'HEAD');
	const artifact = join(base, 'artifact.tgz');
	writeFileSync(artifact, tarball([manifestEntry({ name: sourcePkg.name, version: sourcePkg.version, gitHead: source })]));
	const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
	// Every push in these tests must land in the local bare repository.
	expect(realpathSync(git(work, 'remote', 'get-url', 'origin'))).toBe(realpathSync(origin));
	const remote = () => ({ heads: git(work, 'ls-remote', '--heads', origin), tags: git(work, 'ls-remote', '--tags', origin) });
	return { base, work, git, source, artifact, sha256, remote };
}

function runBlock(language, clone, { artifact = clone.artifact, prelude = '' } = {}) {
	const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	const options = { cwd: clone.work, encoding: 'utf8', windowsHide: true, env };
	if (language === 'powershell') {
		const script = `${prelude}$source = '${clone.source}'\n$tarball = '${artifact}'\n` + docBlock('powershell');
		return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], options);
	}
	const script = `${prelude}source='${clone.source}'\ntarball='${artifact.replaceAll('\\', '/')}'\n` + docBlock('sh');
	return spawnSync('sh', ['-c', script], options);
}

const hasLocalTag = clone => spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/' + tag], { cwd: clone.work, windowsHide: true }).status === 0;

describe('documented release tag commands', () => {
	it('documents the version this commit releases', () => {
		expect(docBlock('powershell')).toContain("'" + tag + "'");
		expect(docBlock('sh')).toContain('tag=' + tag + '\n');
	});

	for (const language of ['powershell', 'sh']) {
		const available = language === 'powershell' ? !!powershell : posixShell;
		// PowerShell runs on every CI lane; a POSIX shell is required off Windows.
		it.skipIf(!available && (language === 'powershell' || process.platform === 'win32'))(`tags only after the checks pass in ${language}`, () => {
			const clone = releaseClone();
			const result = runBlock(language, clone);
			expect(result.status, result.stdout + result.stderr).toBe(0);
			expect(result.stdout).toContain('local tag ' + tag + ' binds ' + clone.sha256 + ' at ' + clone.source);
			// main is pushed, the tag is created locally and left for a separate push.
			expect(clone.remote()).toEqual({ heads: clone.source + '\trefs/heads/main', tags: '' });
			const body = clone.git(clone.work, 'cat-file', 'tag', tag);
			expect(body.slice(body.indexOf('\n\n') + 2)).toBe('Release ' + sourcePkg.version + '\n\nArtifact-SHA256: ' + clone.sha256);
		}, 60_000);

		it.skipIf(!available && (language === 'powershell' || process.platform === 'win32'))(`refuses to run outside the clean checkout at the source commit in ${language}`, () => {
			const moved = releaseClone();
			moved.git(moved.work, 'commit', '-q', '--allow-empty', '-m', 'Later work');
			const elsewhere = runBlock(language, moved);
			expect(elsewhere.status).not.toBe(0);
			expect(elsewhere.stderr).toContain('run this in the clean main checkout');
			const dirty = releaseClone();
			writeFileSync(join(dirty.work, 'stray.txt'), 'untracked');
			const unclean = runBlock(language, dirty);
			expect(unclean.status).not.toBe(0);
			expect(unclean.stderr).toContain('run this in the clean main checkout');
			for (const clone of [moved, dirty]) {
				expect(clone.remote()).toEqual({ heads: '', tags: '' });
				expect(hasLocalTag(clone)).toBe(false);
			}
		}, 60_000);

		it.skipIf(!available && (language === 'powershell' || process.platform === 'win32'))(`stops before pushing when the tarball cannot be hashed in ${language}`, () => {
			const clone = releaseClone();
			// A digest left over from an earlier run in the same session must not be reused.
			const stale = language === 'powershell' ? `$sha256 = '${'a'.repeat(64)}'\n` : `sha256=${'a'.repeat(64)}\n`;
			const result = runBlock(language, clone, { artifact: join(clone.base, 'missing.tgz'), prelude: stale });
			expect(result.status).not.toBe(0);
			expect(clone.remote()).toEqual({ heads: '', tags: '' });
			expect(hasLocalTag(clone)).toBe(false);
		}, 60_000);

		it.skipIf(!available && (language === 'powershell' || process.platform === 'win32'))(`stops before tagging when main cannot be pushed in ${language}`, () => {
			const clone = releaseClone();
			const unrelated = clone.git(clone.work, 'commit-tree', 'HEAD^{tree}', '-m', 'Unrelated main');
			clone.git(clone.work, 'push', '-q', join(clone.base, 'origin.git'), unrelated + ':refs/heads/main');
			const result = runBlock(language, clone);
			expect(result.status).not.toBe(0);
			expect(clone.remote()).toEqual({ heads: unrelated + '\trefs/heads/main', tags: '' });
			expect(hasLocalTag(clone)).toBe(false);
		}, 60_000);
	}
});
