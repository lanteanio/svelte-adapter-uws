#!/usr/bin/env node
/**
 * Consumer prerequisite checkpoint. Unlike postinstall, this never honours
 * the client-only bypass: invoking the preflight explicitly asks whether this
 * process can build and boot the native server.
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, platformVerdict } from './doctor.js';
import { readAdapterPackageJson, uwsInstallSpec } from '../src/uws-load-hint.js';

const require = createRequire(import.meta.url);

export function detectLibc(report = process.report) {
	if (process.platform !== 'linux') return null;
	try {
		const header = report.getReport().header;
		return header.glibcVersionRuntime
			? { name: 'glibc', version: String(header.glibcVersionRuntime) }
			: { name: 'musl', version: null };
	} catch {
		return null;
	}
}

function versionFromSpec(spec) {
	return (String(spec).match(/v(\d+\.\d+\.\d+)(?:\.tar\.gz)?$/) || [])[1] || null;
}

export function evaluatePreflight({
	pkg,
	nodeVersion,
	platform,
	arch,
	libc,
	nativeVersion,
	nativeError
}) {
	const results = [];
	const floor = String(pkg.engines?.node || '>=0').match(/\d+(?:\.\d+){0,2}/)?.[0] || '0';
	results.push(compareVersions(nodeVersion, floor) < 0
		? {
			name: 'node', status: 'fail',
			detail: nodeVersion + ' (requires ' + pkg.engines.node + ')',
			fix: 'install a supported Node release before installing or building the app'
		}
		: { name: 'node', status: 'ok', detail: nodeVersion + ' (requires ' + pkg.engines.node + ')' });

	if (platform === 'linux' && libc === null) {
		results.push({
			name: 'platform', status: 'fail', detail: platform + '/' + arch + ' libc unknown',
			fix: 'run on a detectable glibc >= 2.38 environment; musl has no published binary'
		});
	} else {
		results.push(platformVerdict(platform, arch, libc));
	}

	const spec = uwsInstallSpec(pkg) || '';
	const expected = versionFromSpec(spec);
	if (nativeError !== null || nativeVersion === null) {
		results.push({
			name: 'uWebSockets.js', status: 'fail',
			detail: 'not loadable' + (nativeError ? ' (' + nativeError + ')' : ''),
			fix: 'install the matched archive and rerun: npm install ' + spec
		});
	} else if (expected !== null && nativeVersion !== expected) {
		results.push({
			name: 'uWebSockets.js', status: 'fail',
			detail: nativeVersion + ' installed, expected ' + expected,
			fix: 'install the matched archive and rerun: npm install ' + spec
		});
	} else {
		results.push({ name: 'uWebSockets.js', status: 'ok', detail: nativeVersion });
	}
	return results;
}

function probeNative() {
	try {
		const entry = require.resolve('uWebSockets.js');
		require('uWebSockets.js');
		const version = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).version;
		return { nativeVersion: String(version), nativeError: null };
	} catch (error) {
		return {
			nativeVersion: null,
			nativeError: String(error instanceof Error ? error.message : error).split('\n')[0]
		};
	}
}

export async function runPreflight({
	pkg = readAdapterPackageJson(),
	nodeVersion = process.version,
	platform = process.platform,
	arch = process.arch,
	libc = detectLibc(),
	native = probeNative(),
	log = console.log,
	error = console.error
} = {}) {
	const results = evaluatePreflight({
		pkg, nodeVersion, platform, arch, libc,
		nativeVersion: native.nativeVersion,
		nativeError: native.nativeError
	});
	log('preflight: ' + pkg.name + '@' + pkg.version + ' | Node ' + nodeVersion +
		' | ABI ' + process.versions.modules + ' | ' + platform + '/' + arch);
	for (const result of results) {
		const line = '  ' + (result.status === 'ok' ? 'OK  ' : 'FAIL') + ' ' +
			result.name + '  ' + result.detail;
		(result.status === 'ok' ? log : error)(line);
		if (result.status !== 'ok' && result.fix) error('       fix: ' + result.fix);
	}
	const failed = results.filter((result) => result.status === 'fail');
	if (failed.length) {
		error('preflight FAILED at prerequisite boundary: ' + failed.map((result) => result.name).join(', '));
		return { ok: false, results };
	}
	log('preflight OK - Node, platform/libc, and the pinned native addon are ready.');
	return { ok: true, results };
}

// The published bin is a SYMLINK in node_modules/.bin on POSIX, so argv[1] is
// the link path while import.meta.url is the real file: comparing them
// unresolved made `svelte-adapter-uws-preflight` a silent no-op there, and a
// CI step or a documented stop-condition that runs it would always "pass".
// Resolve both through the filesystem before comparing.
function realOrSelf(path) {
	try { return realpathSync(path); } catch { return path; }
}
const invoked = process.argv[1] ? realOrSelf(resolve(process.argv[1])) : null;
const current = realOrSelf(fileURLToPath(import.meta.url));
const isCli = invoked !== null && (process.platform === 'win32'
	? invoked.toLowerCase() === current.toLowerCase()
	: invoked === current);
if (isCli) {
	const result = await runPreflight();
	if (!result.ok) process.exitCode = 1;
}
