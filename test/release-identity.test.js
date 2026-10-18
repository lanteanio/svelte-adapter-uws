import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { main, verifyLocalTag } from '../scripts/prepare-release.js';

const sourcePkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = sourcePkg.name + '@' + sourcePkg.version;
const script = fileURLToPath(new URL('../scripts/prepare-release.js', import.meta.url));
const bases = [];

afterEach(() => {
	for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

// A gzipped ustar archive holding only package/package.json.
function tarball(manifest) {
	const body = Buffer.from(JSON.stringify(manifest));
	const header = Buffer.alloc(512);
	header.write('package/package.json', 0);
	header.write('0000644\0', 100);
	header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
	header.write('0', 156);
	header.write('ustar\0' + '00', 257);
	return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
}

function repository() {
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
	const { name, version, private: hidden, repository: repo, publishConfig } = sourcePkg;
	writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version, private: hidden, repository: repo, publishConfig }, null, 2) + '\n');
	run('add', 'package.json');
	run('commit', '-qm', 'Release source');
	run('update-ref', 'refs/remotes/origin/main', 'HEAD');
	const artifact = join(base, 'artifact.tgz');
	writeFileSync(artifact, tarball({ name, version, gitHead: run('rev-parse', 'HEAD') }));
	const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
	const annotate = (body, at = 'HEAD') => {
		const file = join(base, 'annotation.txt');
		writeFileSync(file, body);
		run('tag', '-a', tag, at, '-F', file);
	};
	const env = () => ({
		GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GITHUB_REF: 'refs/tags/' + tag,
		GITHUB_REPOSITORY: 'lanteanio/svelte-adapter-uws', GITHUB_SHA: run('rev-parse', 'refs/tags/' + tag)
	});
	return { base, source, run, artifact, digest, annotate, env };
}

describe('release identity against real tags', () => {
	it('binds an annotated tag on main to its artifact digest', () => {
		const repo = repository();
		repo.annotate('Release ' + sourcePkg.version + '\n\nArtifact-SHA256: ' + repo.digest + '\n');
		const identity = main({ cwd: repo.source, env: repo.env() });
		expect(identity.artifactSha256).toBe(repo.digest);
		expect(identity.head).toBe(repo.run('rev-parse', 'HEAD'));
		expect(verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact }).artifactSha256).toBe(repo.digest);
	});

	it('refuses a lightweight tag', () => {
		const repo = repository();
		repo.run('tag', tag);
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow();
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/annotated/);
	});

	it('refuses a tagged commit outside origin/main', () => {
		const repo = repository();
		repo.run('commit', '-q', '--allow-empty', '-m', 'Unreviewed');
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest + '\n');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/origin\/main/);
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/origin\/main/);
	});

	it('does not accept a local branch named origin/main as the remote branch', () => {
		const repo = repository();
		repo.run('checkout', '-q', '-b', 'side');
		repo.run('commit', '-q', '--allow-empty', '-m', 'Unreviewed');
		repo.run('branch', 'origin/main', 'side');
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest + '\n');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/origin\/main/);
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/origin\/main/);
	});

	it('refuses a tag whose tarball was packed from another commit', () => {
		const repo = repository();
		const packed = repo.run('rev-parse', 'HEAD');
		repo.run('commit', '-q', '--allow-empty', '-m', 'Later main commit');
		repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
		writeFileSync(repo.artifact, tarball({ name: sourcePkg.name, version: sourcePkg.version, gitHead: repo.run('rev-parse', 'HEAD') }));
		const digest = createHash('sha256').update(readFileSync(repo.artifact)).digest('hex');
		repo.annotate('Release\n\nArtifact-SHA256: ' + digest + '\n', packed);
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/gitHead/);
	});

	it('requires the retained tarball and exact arguments', () => {
		const repo = repository();
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest + '\n');
		expect(() => verifyLocalTag({ cwd: repo.source, tag })).toThrow(/tarball is required/);
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.base })).toThrow();
		for (const args of [['--verify-tag', tag], ['--verify-tag', tag, '--artefact', repo.artifact], ['--verify-tag', tag, '--artifact', repo.artifact, '--force']]) {
			const result = spawnSync(process.execPath, [script, ...args], { cwd: repo.source, encoding: 'utf8', windowsHide: true });
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/usage/);
		}
	});

	it('refuses a dirty checkout', () => {
		const repo = repository();
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest + '\n');
		writeFileSync(join(repo.source, 'stray.txt'), 'untracked');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/dirty/);
	});

	it('refuses annotations a pushed tag could never correct', () => {
		const repo = repository();
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest.toUpperCase() + '\n');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/artifact SHA256/);
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/Artifact-SHA256/);
	});

	it('refuses a local tag that binds different bytes', () => {
		const repo = repository();
		repo.annotate('Release\n\nArtifact-SHA256: ' + 'a'.repeat(64) + '\n');
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/does not match/);
	});
});
