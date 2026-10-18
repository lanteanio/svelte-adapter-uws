import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, verifyLocalTag } from '../scripts/prepare-release.js';

const sourcePkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = sourcePkg.name + '@' + sourcePkg.version;
const bases = [];

afterEach(() => {
	for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

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
	writeFileSync(artifact, 'retained archive bytes');
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
		expect(() => verifyLocalTag({ cwd: repo.source, tag })).toThrow(/annotated/);
	});

	it('refuses a tagged commit outside origin/main', () => {
		const repo = repository();
		repo.run('commit', '-q', '--allow-empty', '-m', 'Unreviewed');
		repo.annotate('Release\n\nArtifact-SHA256: ' + repo.digest + '\n');
		expect(() => main({ cwd: repo.source, env: repo.env() })).toThrow(/origin\/main/);
		expect(() => verifyLocalTag({ cwd: repo.source, tag })).toThrow(/origin\/main/);
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
		expect(() => verifyLocalTag({ cwd: repo.source, tag })).toThrow(/Artifact-SHA256/);
	});

	it('refuses a local tag that binds different bytes', () => {
		const repo = repository();
		repo.annotate('Release\n\nArtifact-SHA256: ' + 'a'.repeat(64) + '\n');
		expect(() => verifyLocalTag({ cwd: repo.source, tag, artifact: repo.artifact })).toThrow(/does not match/);
	});
});
