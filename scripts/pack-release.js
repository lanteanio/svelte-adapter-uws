#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = {
	test: 'vitest run',
	'test:watch': 'vitest',
	'test:e2e': 'npx playwright test --config test/e2e/playwright.config.js',
	'test:coverage': 'node scripts/coverage.js',
	'pack:release': 'node scripts/pack-release.js'
};

export function validatePackManifest(pkg) {
	if (pkg.name !== 'svelte-adapter-uws' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkg.version) ||
		pkg.version.split('.').some(part => !Number.isSafeInteger(Number(part))) ||
		JSON.stringify(pkg.publishConfig) !== JSON.stringify({ tag: 'latest' })) {
		throw new Error('release packing requires the canonical stable package identity');
	}
	if (Object.hasOwn(pkg, 'gitHead')) throw new Error('source package.json must not contain gitHead');
	if (JSON.stringify(Object.entries(pkg.scripts || {}).sort()) !== JSON.stringify(Object.entries(scripts).sort())) {
		throw new Error('package scripts differ from the closed release inventory');
	}
}

function run(command, args, cwd, encoding = 'utf8') {
	const result = spawnSync(command, args, { cwd, encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(command + ' failed: ' + (result.error?.message || String(result.stderr)));
	return result.stdout;
}

export async function packRelease({ source = root, destination, npmCli = process.env.npm_execpath }) {
	if (!destination) throw new Error('an explicit artifact destination is required');
	const requestedOutput = resolve(destination);
	if (!npmCli || JSON.parse(readFileSync(resolve(dirname(npmCli), '..', 'package.json'), 'utf8')).version !== '11.5.1') {
		throw new Error('release packing requires npm 11.5.1');
	}
	const git = (...args) => run('git', args, source).trim();
	if (git('status', '--porcelain=v1')) throw new Error('release source must be clean');
	const head = git('rev-parse', 'HEAD');
	if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('release source must be a full Git commit');
	const inMain = ['refs/heads/main', 'refs/remotes/origin/main'].some(branch =>
		spawnSync('git', ['merge-base', '--is-ancestor', head, branch], { cwd: source, stdio: 'ignore', windowsHide: true }).status === 0);
	if (!inMain) throw new Error('release source must belong to main');
	const pkg = JSON.parse(git('show', 'HEAD:package.json'));
	validatePackManifest(pkg);
	const filename = pkg.name + '-' + pkg.version + '.tgz';
	if (existsSync(join(requestedOutput, filename))) throw new Error('retained release artifact already exists');
	const npm = (args, cwd) => JSON.parse(run(process.execPath, [npmCli, ...args], cwd));
	const entries = new Map();
	const portablePaths = new Set();
	for (const line of git('ls-tree', '-r', '-z', head).split('\0').filter(Boolean)) {
		const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
		if (!match) throw new Error('frozen source contains a symlink, submodule or unsupported entry');
		const path = match[3];
		const parts = path.split('/');
		if (path.includes('\\') || isAbsolute(path) || /[\x00-\x1f:]/.test(path) ||
			parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
			portablePaths.has(path.toLowerCase())) throw new Error('frozen source has an unsafe or nonportable path: ' + path);
		portablePaths.add(path.toLowerCase());
		entries.set(path, { mode: match[1], hash: match[2] });
	}
	mkdirSync(requestedOutput, { recursive: true });
	const output = realpathSync(requestedOutput);
	const staging = realpathSync(mkdtempSync(join(output, '.pack-')));
	const frozen = join(staging, 'source');
	const selected = join(staging, 'package');
	const write = (base, path, bytes, mode) => {
		const target = resolve(base, ...path.split('/'));
		const child = relative(base, target);
		if (isAbsolute(child) || child === '..' || child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('staged path escapes its private root');
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		chmodSync(target, mode === '100755' ? 0o755 : 0o644);
	};
	try {
		// npm sees only the complete committed tree, including its selection rules.
		// Ignored workspace files and index flags cannot alter this input.
		for (const [path, entry] of entries) write(frozen, path, run('git', ['cat-file', 'blob', entry.hash], source, null), entry.mode);
		const listed = npm(['pack', '--ignore-scripts', '--dry-run', '--json'], frozen);
		if (listed.length !== 1 || listed[0].filename !== filename) throw new Error('npm pack list has an unexpected identity');
		const expected = new Map();
		for (const file of listed[0].files) {
			const path = file.path;
			const entry = entries.get(path);
			if (!entry || expected.has(path)) throw new Error('npm pack contains an unexpected or duplicate file: ' + path);
			expected.set(path, run('git', ['cat-file', 'blob', entry.hash], source, null));
		}
		if (!expected.has('package.json')) throw new Error('package manifest is missing from npm pack list');
		expected.set('package.json', Buffer.from(JSON.stringify({ ...pkg, gitHead: head }, null, 2) + '\n'));
		for (const [path, bytes] of expected) write(selected, path, bytes, entries.get(path).mode);
		const records = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', output], selected);
		if (records.length !== 1 || records[0].filename !== filename ||
			JSON.stringify(records[0].files.map(file => file.path).sort()) !== JSON.stringify([...expected.keys()].sort())) {
			throw new Error('release archive file list differs from the frozen source');
		}
		const tarball = join(output, filename);
		const tar = createRequire(npmCli)('tar');
		const seen = new Set();
		const reads = [];
		await tar.t({ file: tarball, onentry(entry) {
			const path = entry.path.startsWith('package/') ? entry.path.slice(8) : '';
			reads.push(new Promise((accept, reject) => {
				const chunks = [];
				entry.on('data', chunk => chunks.push(chunk));
				entry.on('error', reject);
				entry.on('end', () => {
					if (entry.type !== 'File' || !expected.has(path) || seen.has(path) || !Buffer.concat(chunks).equals(expected.get(path))) {
						reject(new Error('release archive bytes differ from frozen source: ' + entry.path));
					} else { seen.add(path); accept(); }
				});
			}));
		} });
		await Promise.all(reads);
		if (seen.size !== expected.size) throw new Error('release archive is incomplete');
		return { ...records[0], gitHead: head, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') };
	} finally {
		const actual = realpathSync(staging);
		const child = relative(output, actual);
		if (actual !== staging || lstatSync(staging).isSymbolicLink() || !child.startsWith('.pack-') || child.includes('/') || child.includes('\\') || isAbsolute(child)) {
			throw new Error('refusing cleanup outside the private staging directory');
		}
		rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 4 || process.argv[2] !== '--destination') throw new Error('usage: npm run pack:release -- --destination <directory>');
		console.log(JSON.stringify([await packRelease({ destination: process.argv[3] })], null, 2));
	} catch (error) {
		console.error('release packing failed: ' + error.message);
		process.exitCode = 1;
	}
}
