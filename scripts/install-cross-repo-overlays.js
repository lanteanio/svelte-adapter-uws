#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGES = [
	'svelte-adapter-uws',
	'svelte-adapter-uws-extensions',
	'svelte-realtime'
];

const TARBALL_NAMES = {
	'svelte-adapter-uws': /^svelte-adapter-uws-(?!extensions-).+\.tgz$/,
	'svelte-adapter-uws-extensions': /^svelte-adapter-uws-extensions-.+\.tgz$/,
	'svelte-realtime': /^svelte-realtime-.+\.tgz$/
};

/** @param {string} directory */
export function findHeadTarballs(directory) {
	const names = readdirSync(directory).filter((name) => name.endsWith('.tgz'));
	return Object.fromEntries(
		PACKAGES.map((name) => {
			const matches = names.filter((entry) => TARBALL_NAMES[name].test(entry));
			if (matches.length !== 1) {
				throw new Error(`expected exactly one ${name} tarball in ${directory}; found ${matches.length}`);
			}
			return [name, resolve(directory, matches[0])];
		})
	);
}

/** @param {string[]} argv */
export function parseOverlayArgs(argv) {
	let tarballs = null;
	const targets = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === '--tarballs') tarballs = argv[++index];
		else if (argv[index] === '--target') {
			const value = argv[++index] || '';
			const split = value.indexOf('=');
			if (split < 1) throw new Error('--target must be <directory>=<package,package>');
			const directory = value.slice(0, split);
			const packages = value.slice(split + 1).split(',').filter(Boolean);
			if (!packages.length || packages.some((name) => !PACKAGES.includes(name))) {
				throw new Error(`invalid package list for target ${directory}`);
			}
			targets.push({ directory, packages });
		} else throw new Error(`unknown argument: ${argv[index]}`);
	}
	if (!tarballs || !targets.length) throw new Error('--tarballs and at least one --target are required');
	return { tarballs, targets };
}

function installTarget(target, tarballs) {
	const directory = resolve(target.directory);
	if (!existsSync(join(directory, 'package.json'))) throw new Error(`${directory} has no package.json`);
	for (const name of target.packages) {
		rmSync(join(directory, 'node_modules', ...name.split('/')), { recursive: true, force: true });
	}
	const args = [
		'install', '--prefix', directory, '--no-save', '--package-lock=false', '--ignore-scripts',
		'--no-audit', '--no-fund', '--loglevel=error', ...target.packages.map((name) => tarballs[name])
	];
	const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
	const result = process.platform === 'win32'
		? spawnSync(
			process.env.ComSpec || 'cmd.exe',
			['/d', '/s', '/c', [NPM, ...args].map(quoteCmdArg).join(' ')],
			options
		)
		: spawnSync(NPM, args, options);
	if (result.error || result.status !== 0) {
		throw new Error(result.stderr || result.stdout || result.error?.message || `npm exited ${result.status}`);
	}

	for (const name of target.packages) {
		const installed = JSON.parse(readFileSync(join(directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
		const digest = createHash('sha256').update(readFileSync(tarballs[name])).digest('hex');
		console.log(`${directory}: ${name}@${installed.version} from ${basename(tarballs[name])} sha256:${digest}`);
	}
}

function quoteCmdArg(value) {
	const source = String(value);
	return /[\s"^&|<>()]/.test(source) ? `"${source.replace(/"/g, '""')}"` : source;
}

function main() {
	try {
		const options = parseOverlayArgs(process.argv.slice(2));
		const tarballs = findHeadTarballs(resolve(options.tarballs));
		for (const target of options.targets) installTarget(target, tarballs);
	} catch (error) {
		console.error(`cross-repo overlay: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
