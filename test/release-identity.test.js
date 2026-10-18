import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

afterEach(() => {
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
