#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const DIAGNOSTIC_PATH = String.raw`(?:(?:[A-Za-z]:)?\/(?:[A-Za-z0-9._-]+\/)*consumer\/)?node_modules`;
const KNOWN_HARNESS_DIAGNOSTIC = new RegExp(
	`^${DIAGNOSTIC_PATH}/svelte-adapter-uws-extensions/src/redis/session\\.d\\.ts\\(71\\): TS2304 Cannot find name 'T'\\.$`
);
const KNOWN_DIRECT_DIAGNOSTIC = new RegExp(
	`^${DIAGNOSTIC_PATH}/svelte-adapter-uws-extensions/src/redis/session\\.d\\.ts\\(71,24\\): error TS2304: Cannot find name 'T'\\.$`
);
const EVIDENCE_HEADER = 'cross-repo direct tsc evidence v1';
const STDOUT_BEGIN = '----- compiler stdout begin -----';
const STDOUT_END = '----- compiler stdout end -----';
const STDERR_BEGIN = '----- compiler stderr begin -----';
const STDERR_END = '----- compiler stderr end -----';
const EVIDENCE_TERMINAL = 'cross-repo direct tsc evidence: COMPLETE';
const HEADS = [
	'svelte-adapter-uws',
	'svelte-adapter-uws-extensions',
	'svelte-realtime'
];
const EXPECTED_TSCONFIG = {
	compilerOptions: {
		strict: true,
		noEmit: true,
		target: 'es2022',
		module: 'esnext',
		moduleResolution: 'bundler',
		skipLibCheck: false,
		types: ['node']
	},
	files: ['consumer.ts']
};
const DIRECT_BUNDLER_SOURCE = '.cross-repo-direct-consumer.ts';
const DIRECT_BUNDLER_TSCONFIG = '.cross-repo-direct-tsconfig.json';
const DIRECT_NODE_ESM_SOURCE = '.cross-repo-direct-consumer.mts';
const DIRECT_NODE_ESM_TSCONFIG = '.cross-repo-direct-node-esm-tsconfig.json';
const DIRECT_NODE_CJS_SOURCE = '.cross-repo-direct-consumer.cts';
const DIRECT_NODE_CJS_TSCONFIG = '.cross-repo-direct-node-cjs-tsconfig.json';
const DIRECT_MODE_ATTESTATION = 'bundler,node-esm,node-cjs';
const TYPESCRIPT_ATTESTATION = {
	range: '^5.6.0',
	version: '5.9.3',
	resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',
	integrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
	files: 132,
	treeSha256: 'd9f21ce5082611aef2af206a9eec690ac2b89a7c7ac943e422443071b6cfcf4c'
};

function normalized(source) {
	return String(source || '').replace(/\r\n?/g, '\n');
}

function matchingLines(lines, pattern) {
	return lines.filter((line) => pattern.test(line));
}

function diagnostics(source) {
	return normalized(source)
		.split('\n')
		.map((line) => line.trim().replace(/\\/g, '/'))
		.filter((line) => /(?:^|:\s+)(?:error\s+)?TS\d{4,5}(?::|\s)/.test(line));
}

function oneLine(lines, pattern, reason) {
	return matchingLines(lines, pattern).length === 1 ? null : reason;
}

function hasTerminalFailure(line) {
	return /(?:^|\s)(?:error|fatal(?: error)?|(?:[A-Za-z]*(?:Error|Exception))|uncaught|unhandled rejection|internal compiler error)(?:[:\s]|$)/i.test(line) ||
		/npm ERR!|node:internal|(?:command )?not found|no such file or directory|is not recognized|segmentation fault|core dumped|terminated by signal|assertion failed|\bpanic\b|process (?:exited|terminated|was killed) unexpectedly|\b(?:ENOENT|ENOSPC|EACCES|EPERM|EIO|ENOMEM|EPIPE|EMFILE|ENFILE|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE|EBUSY|EROFS|ENODEV|ENOSYS|EOVERFLOW)\b/i.test(line) ||
		/(?:^|\s)(?:signal|spawn-error)(?:\s*[:=]|\s+)(?!none(?:\s|$))\S+/i.test(line) ||
		/(?:^|\s)exit(?:[\s-]*code)?(?:\s*[:=]|\s+)(?!0(?:\s|$))\d+/i.test(line);
}

function parseHarnessHeader(lines) {
	if (!lines.length) return null;
	let cursor = 0;
	if (lines[cursor++] !== 'cross-repo gate: adapter + extensions + realtime, packed and installed as one set' ||
		lines[cursor++] !== '') return null;
	const version = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
	const versions = {};
	for (const name of HEADS) {
		const pattern = new RegExp(
			`^  ${name}\\s+(${version})\\s+(?:[0-9a-f]{7,40}|unknown)(?: \\+\\d+ uncommitted| git state unreadable)?$`
		);
		const match = pattern.exec(lines[cursor++]);
		if (!match) return null;
		versions[name] = match[1];
	}
	if (!/^  work dir: .+$/.test(lines[cursor++]) || lines[cursor++] !== '') return null;
	if (cursor < lines.length) {
		if (!/^  note: gating WORKING TREES, not committed SHAs: .+$/.test(lines[cursor++]) ||
			lines[cursor++] !== '') return null;
	}
	return cursor === lines.length ? { versions } : null;
}

function classifyHarness(source) {
	const log = normalized(source).trimEnd();
	const lines = log.split('\n');
	const terminal = lines.at(-1);
	const gateTerminals = matchingLines(lines, /^cross-repo gate: (?:FAILED|PASSED|INCOMPLETE|passed what it ran)/);
	if (gateTerminals.length !== 1 || !['cross-repo gate: FAILED', 'cross-repo gate: PASSED'].includes(terminal)) {
		return { status: null, reason: 'the harness has no single closed terminal result' };
	}
	if (oneLine(lines, /^summary$/, 'the harness summary is missing or duplicated')) {
		return { status: null, reason: 'the harness summary is missing or duplicated' };
	}
	if (oneLine(lines, /^rungs:$/, 'the harness rung boundary is missing or duplicated')) {
		return { status: null, reason: 'the harness rung boundary is missing or duplicated' };
	}
	const rungs = lines.indexOf('rungs:');
	const summary = lines.indexOf('summary');
	const header = parseHarnessHeader(lines.slice(0, rungs));
	if (rungs >= summary || !header) {
		return { status: null, reason: 'the harness header or section ordering is not canonical' };
	}
	if (matchingLines(lines, /^  \[SKIP\]/).length || matchingLines(lines, /^  SKIPPED:/).length) {
		return { status: null, reason: 'a rung was skipped' };
	}
	if (lines.some(hasTerminalFailure)) {
		return { status: null, reason: 'the harness transcript contains fatal producer output' };
	}

	const known = terminal === 'cross-repo gate: FAILED';
	const expectedPack = `  [ok  ] pack: ${HEADS.map((name) => `${name}@${header.versions[name]}`).join(', ')}`;
	const expectedInstall = '  [ok  ] install: 3 packed heads + peers installed clean into consumer';
	const expectedRecords = known
		? [/^  \[ok  \] pack:/, /^  \[ok  \] install:/, /^  \[FAIL\] types:/]
		: [/^  \[ok  \] pack:/, /^  \[ok  \] install:/, /^  \[ok  \] types:/];
	for (const pattern of expectedRecords) {
		if (matchingLines(lines, pattern).length !== 1) {
			return { status: null, reason: 'the harness rung records are missing, duplicated, or inconsistent' };
		}
	}
	if (matchingLines(lines, /^  \[(?:ok  |FAIL|SKIP)\]/).length !== 3) {
		return { status: null, reason: 'the harness reported an unexpected rung record' };
	}

	const foundDiagnostics = diagnostics(log);
	if (known) {
		if (lines.slice(summary).join('\n') !== [
			'summary',
			'  passed:  pack, install',
			'  FAILED:  types',
			'',
			'cross-repo gate: FAILED'
		].join('\n')) {
			return { status: null, reason: 'the failure summary is not the closed terminal suffix' };
		}
		const typeRecord = /^  \[FAIL\] types: 1 type error\(s\) in the shipped surface of the heads \((\d+) subpaths imported\)$/.exec(lines[rungs + 3] || '');
		if (summary - rungs !== 6 ||
			lines[rungs] !== 'rungs:' ||
			lines[rungs + 1] !== expectedPack ||
			lines[rungs + 2] !== expectedInstall ||
			!typeRecord || lines[rungs + 5] !== '' ||
			matchingLines(lines, /^  passed:\s+pack, install\s*$/).length !== 1 ||
			matchingLines(lines, /^  FAILED:\s+types\s*$/).length !== 1) {
			return { status: null, reason: 'the failure summary is not the exact types-only result' };
		}
		const diagnostic = (lines[rungs + 4] || '').trim().replace(/\\/g, '/');
		if (foundDiagnostics.length !== 1 || !KNOWN_HARNESS_DIAGNOSTIC.test(diagnostic)) {
			return { status: null, reason: `the harness exposed ${foundDiagnostics.length} non-canonical diagnostic(s)` };
		}
		return {
			status: 'known',
			subpaths: Number(typeRecord[1]),
			reason: 'closed harness transcript contains only the pinned defect'
		};
	}

	if (lines.slice(summary).join('\n') !== [
		'summary',
		'  passed:  pack, install, types',
		'',
		'cross-repo gate: PASSED'
	].join('\n')) {
		return { status: null, reason: 'the passing summary is not the closed terminal suffix' };
	}
	const typeRecord = /^  \[ok  \] types: (\d+) public subpaths typecheck strict from the packed tarballs \(svelte-adapter-uws (\d+), svelte-adapter-uws-extensions (\d+), svelte-realtime (\d+)\)$/.exec(lines[rungs + 3] || '');
	if (summary - rungs !== 5 ||
		lines[rungs] !== 'rungs:' ||
		lines[rungs + 1] !== expectedPack ||
		lines[rungs + 2] !== expectedInstall ||
		!typeRecord || lines[rungs + 4] !== '' ||
		Number(typeRecord[1]) !== Number(typeRecord[2]) + Number(typeRecord[3]) + Number(typeRecord[4]) ||
		matchingLines(lines, /^  passed:\s+pack, install, types\s*$/).length !== 1 ||
		matchingLines(lines, /^  FAILED:/).length || foundDiagnostics.length) {
		return { status: null, reason: 'the passing harness summary is inconsistent' };
	}
	return {
		status: 'clean',
		subpaths: Number(typeRecord[1]),
		reason: 'closed harness transcript reports a clean type surface'
	};
}

/**
 * Serialize the result of a direct compiler process after it has terminated.
 * The bounded markers make truncation, injected trailers, spawn failures and
 * stdout/stderr diagnostics independently visible to the later CI step.
 */
export function serializeDirectCompilerEvidence(result) {
	const stdout = normalized(result.stdout).trimEnd();
	const stderr = normalized(result.stderr).trimEnd();
	const spawnError = result.error
		? String(result.error.code || result.error.message || result.error).replace(/\s+/g, ' ')
		: 'none';
	return [
		EVIDENCE_HEADER,
		STDOUT_BEGIN,
		stdout,
		STDOUT_END,
		STDERR_BEGIN,
		stderr,
		STDERR_END,
		`exit-code: ${Number.isInteger(result.status) ? result.status : 'none'}`,
		`signal: ${result.signal || 'none'}`,
		`spawn-error: ${spawnError}`,
		`subpaths: ${Number.isInteger(result.subpaths) ? result.subpaths : 'none'}`,
		`imports: ${Number.isInteger(result.imports) ? result.imports : 'none'}`,
		`modes: ${result.modes === DIRECT_MODE_ATTESTATION ? result.modes : 'none'}`,
		EVIDENCE_TERMINAL,
		''
	].join('\n');
}

function extractDirectEvidence(source) {
	const evidence = normalized(source).trimEnd();
	const lines = evidence.split('\n');
	const unique = [EVIDENCE_HEADER, STDOUT_BEGIN, STDOUT_END, STDERR_BEGIN, STDERR_END, EVIDENCE_TERMINAL];
	for (const marker of unique) {
		if (lines.filter((line) => line === marker).length !== 1) {
			return { status: null, reason: `direct compiler evidence has an invalid ${marker} marker` };
		}
	}
	const stdoutBegin = lines.indexOf(STDOUT_BEGIN);
	const stdoutEnd = lines.indexOf(STDOUT_END);
	const stderrBegin = lines.indexOf(STDERR_BEGIN);
	const stderrEnd = lines.indexOf(STDERR_END);
	if (lines[0] !== EVIDENCE_HEADER ||
		stdoutBegin !== 1 || stdoutEnd + 1 !== stderrBegin ||
		!(stdoutBegin < stdoutEnd && stderrBegin < stderrEnd) ||
		lines.at(-1) !== EVIDENCE_TERMINAL || lines.length !== stderrEnd + 8) {
		return { status: null, reason: 'direct compiler evidence is truncated or has trailing output' };
	}

	const stdout = lines.slice(stdoutBegin + 1, stdoutEnd).join('\n');
	const stderr = lines.slice(stderrBegin + 1, stderrEnd).join('\n');
	const exit = /^exit-code: (\d+)$/.exec(lines[stderrEnd + 1]);
	const subpaths = /^subpaths: (\d+)$/.exec(lines[stderrEnd + 4]);
	const imports = /^imports: (\d+)$/.exec(lines[stderrEnd + 5]);
	if (!exit || lines[stderrEnd + 2] !== 'signal: none' || lines[stderrEnd + 3] !== 'spawn-error: none' ||
		!subpaths || !imports || Number(imports[1]) < Number(subpaths[1]) ||
		lines[stderrEnd + 6] !== `modes: ${DIRECT_MODE_ATTESTATION}`) {
		return { status: null, reason: 'the direct compiler did not terminate normally' };
	}
	if (stderr.trim()) return { status: null, reason: 'the direct compiler wrote to stderr' };

	const foundDiagnostics = diagnostics(stdout);
	const stdoutLines = stdout.split('\n').map((line) => line.replace(/\\/g, '/'));
	const exitCode = Number(exit[1]);
	if (exitCode === 0 && !stdout.trim() && foundDiagnostics.length === 0) {
		return { status: 'clean', subpaths: Number(subpaths[1]), imports: Number(imports[1]), reason: 'direct tsc passed' };
	}
	if (exitCode === 2 && stdoutLines.length === 1 && KNOWN_DIRECT_DIAGNOSTIC.test(stdoutLines[0])) {
		return { status: 'known', subpaths: Number(subpaths[1]), imports: Number(imports[1]), reason: 'direct tsc reproduced only the pinned defect' };
	}
	return {
		status: null,
		reason: `direct tsc exited ${exitCode} with ${foundDiagnostics.length} non-canonical diagnostic(s)`
	};
}

/** @returns {{ status: 'clean' | 'known' | null, reason: string }} */
export function classifyTypeProof(harnessSource, directEvidence) {
	const harness = classifyHarness(harnessSource);
	if (!harness.status) return harness;
	const direct = extractDirectEvidence(directEvidence);
	if (!direct.status) return direct;
	if (harness.status !== direct.status) {
		return { status: null, reason: `harness reported ${harness.status} but direct tsc reported ${direct.status}` };
	}
	if (harness.subpaths !== direct.subpaths) {
		return { status: null, reason: `harness reported ${harness.subpaths} subpaths but direct attestation found ${direct.subpaths}` };
	}
	return { status: harness.status, reason: `${harness.reason}; ${direct.reason}` };
}

/** Backward-shaped helper used by focused adversarial tests. */
export function classifyKnownTypeDebt(harnessSource, directEvidence) {
	const result = classifyTypeProof(harnessSource, directEvidence);
	return { known: result.status === 'known', reason: result.reason };
}

/** PowerShell 5 writes Tee-Object output as UTF-16LE; pwsh writes UTF-8. */
export function decodeHarnessLog(bytes) {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		if ((bytes.length - 2) % 2 !== 0) throw new Error('UTF-16LE harness log has an odd byte length');
		return bytes.subarray(2).toString('utf16le');
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		const swapped = Buffer.from(bytes.subarray(2));
		if (swapped.length % 2 !== 0) throw new Error('UTF-16BE harness log has an odd byte length');
		for (let index = 0; index + 1 < swapped.length; index += 2) {
			[swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
		}
		return swapped.toString('utf16le');
	}
	return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`${label} is missing or invalid: ${error instanceof Error ? error.message : error}`);
	}
}

function canonicalJson(value) {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])
	);
}

function packageFiles(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			const info = lstatSync(path);
			if (info.isDirectory()) visit(path);
			else if (info.isFile()) files.push(relative(root, path).replace(/\\/g, '/'));
		}
	};
	visit(root);
	return files;
}

function exportTargets(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(exportTargets);
	if (!value || typeof value !== 'object') return [];
	return Object.values(value).flatMap(exportTargets);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardSpecifiers(name, subpath, value, root, files) {
	if (value === null) return [];
	if ((subpath.match(/\*/g) || []).length !== 1) throw new Error(`${name} has a non-canonical wildcard export key: ${subpath}`);
	const replacements = new Set();
	const targets = exportTargets(value);
	if (!targets.length) throw new Error(`${name} wildcard export has no attributable target: ${subpath}`);
	for (const target of targets) {
		if (!target.startsWith('./') || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target) ||
			target.slice(2).split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
			throw new Error(`${name} wildcard export has an unsafe target: ${target}`);
		}
		const parts = target.slice(2).split('*');
		if (parts.length < 2) throw new Error(`${name} wildcard target does not substitute its key: ${target}`);
		let pattern = `^${escapeRegExp(parts[0])}(.+)`;
		for (let index = 1; index < parts.length; index++) {
			pattern += escapeRegExp(parts[index]);
			if (index < parts.length - 1) pattern += '\\1';
		}
		pattern += '$';
		const matcher = new RegExp(pattern);
		for (const file of files) {
			const match = matcher.exec(file);
			if (!match) continue;
			const replacement = match[1];
			if (!replacement || replacement.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
				throw new Error(`${name} wildcard export resolved an unsafe replacement`);
			}
			replacements.add(subpath.replace('*', replacement));
		}
	}
	return [...replacements].sort().map((entry) => `${name}/${entry.slice(2)}`);
}

function consumerSource(specifiers) {
	for (const name of HEADS) {
		if (!specifiers.some((specifier) => specifier === name || specifier.startsWith(`${name}/`))) {
			throw new Error(`${name} contributes no importable subpath`);
		}
	}
	const lines = [
		'// Generated by scripts/cross-repo-gate.js. Imports every public subpath',
		'// of the packed heads so tsc checks the shipped declarations.',
		''
	];
	specifiers.forEach((specifier, index) => lines.push(`import type * as m${index} from '${specifier}';`));
	lines.push('');
	lines.push(`export type Loaded = [${specifiers.map((_, index) => `typeof m${index}`).join(', ')}];`);
	lines.push('');
	return lines.join('\n');
}

export function reconstructTypeConsumer(consumerDirectory) {
	const consumer = resolve(consumerDirectory);
	const harnessSpecifiers = [];
	const directSpecifiers = [];
	for (const name of HEADS) {
		const root = join(consumer, 'node_modules', name);
		const pkg = readJson(join(root, 'package.json'), `${name} package manifest`);
		if (pkg.name !== name || !pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
			throw new Error(`${name} has no attributable exports map`);
		}
		const files = packageFiles(root);
		for (const [subpath, value] of Object.entries(pkg.exports)) {
			if (!subpath.startsWith('.')) continue;
			if (subpath.includes('*')) {
				directSpecifiers.push(...wildcardSpecifiers(name, subpath, value, root, files));
			} else {
				const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
				harnessSpecifiers.push(specifier);
				directSpecifiers.push(specifier);
			}
		}
	}
	if (new Set(harnessSpecifiers).size !== harnessSpecifiers.length || new Set(directSpecifiers).size !== directSpecifiers.length) {
		throw new Error('public export maps resolve duplicate concrete specifiers');
	}
	return {
		harnessSource: consumerSource(harnessSpecifiers),
		directSource: consumerSource(directSpecifiers),
		subpaths: harnessSpecifiers.length,
		imports: directSpecifiers.length
	};
}

function digestTreeRecords(records) {
	records.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
	let manifest = '';
	let previous = null;
	for (const record of records) {
		if (!record.name || record.name === previous) throw new Error(`package tree contains a duplicate path: ${record.name}`);
		previous = record.name;
		manifest += `${record.name}\0${record.size}\0${record.digest}\n`;
	}
	return {
		files: records.length,
		digest: createHash('sha256').update(manifest, 'utf8').digest('hex')
	};
}

function packageTreeDigest(root, label = 'package') {
	const rootInfo = lstatSync(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
		throw new Error(`${label} root is not a real directory`);
	}
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			const info = lstatSync(path);
			if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${relative(root, path)}`);
			if (info.isDirectory()) visit(path);
			else if (info.isFile()) {
				if (info.nlink !== 1) throw new Error(`${label} contains a linked file: ${relative(root, path)}`);
				files.push(path);
			}
			else throw new Error(`${label} contains a non-file entry: ${relative(root, path)}`);
		}
	};
	visit(root);
	const records = files.map((path) => {
		const name = relative(root, path).replace(/\\/g, '/');
		const bytes = readFileSync(path);
		return { name, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
	});
	return digestTreeRecords(records);
}

function tarText(block, start, length, label) {
	const field = block.subarray(start, start + length);
	const nul = field.indexOf(0);
	const end = nul < 0 ? field.length : nul;
	if (nul >= 0 && !field.subarray(nul).every((byte) => byte === 0)) {
		throw new Error(`${label} has nonzero bytes after a tar string terminator`);
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(field.subarray(0, end));
	} catch {
		throw new Error(`${label} has a non-UTF-8 tar path`);
	}
}

function tarSize(block) {
	const field = block.subarray(124, 136).toString('ascii');
	if (!/^(?:[0-7]{11}\0|[0-7]{10} \0)$/.test(field)) {
		throw new Error('packed artifact has a non-canonical tar size field');
	}
	const size = Number.parseInt(field, 8);
	if (!Number.isSafeInteger(size)) throw new Error(`packed artifact has an unsafe tar size: ${JSON.stringify(field)}`);
	return size;
}

function assertTarHeader(block, label) {
	const checksumField = block.subarray(148, 156).toString('ascii');
	if (!/^(?:[0-7]{6}\0 |[0-7]{6} \0)$/.test(checksumField)) {
		throw new Error(`${label} has an invalid tar header checksum field`);
	}
	const expected = Number.parseInt(checksumField, 8);
	const copy = Buffer.from(block);
	copy.fill(0x20, 148, 156);
	const actual = copy.reduce((sum, byte) => sum + byte, 0);
	if (expected !== actual) throw new Error(`${label} has a corrupt tar header checksum`);
	const magic = block.subarray(257, 263).toString('latin1');
	if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error(`${label} is not a canonical ustar archive`);
	if (block.subarray(263, 265).toString('ascii') !== '00') throw new Error(`${label} has a non-canonical ustar version`);
}

function safeTarPath(raw, label, directory = false) {
	const entry = String(raw);
	if (entry.includes('\\')) throw new Error(`${label} contains a backslash in a tar path`);
	if (!entry.startsWith('package/')) throw new Error(`${label} contains an entry outside package/: ${entry}`);
	if (/[\x00-\x1f\x7f]/.test(entry)) throw new Error(`${label} contains a control character in a path`);
	let name = entry.slice('package/'.length);
	if (directory && name.endsWith('/')) name = name.slice(0, -1);
	if (directory && !name) return '';
	if ((!directory && !name) || name.startsWith('/') ||
		name.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error(`${label} contains an unsafe path: ${entry}`);
	}
	return name;
}

function paxPath(payload) {
	let cursor = 0;
	let path = null;
	while (cursor < payload.length) {
		const separator = payload.indexOf(0x20, cursor);
		if (separator < 0) throw new Error('packed artifact has an invalid PAX record');
		const lengthToken = payload.subarray(cursor, separator).toString('ascii');
		if (!/^[1-9]\d*$/.test(lengthToken)) throw new Error('packed artifact has a non-decimal PAX record length');
		const length = Number(lengthToken);
		if (!Number.isSafeInteger(length) || length <= separator - cursor || cursor + length > payload.length) {
			throw new Error('packed artifact has an invalid PAX record length');
		}
		if (payload[cursor + length - 1] !== 0x0a) throw new Error('packed artifact has a PAX record without a newline terminator');
		const record = payload.subarray(separator + 1, cursor + length - 1).toString('utf8');
		const equals = record.indexOf('=');
		if (equals <= 0) throw new Error('packed artifact has an invalid PAX key/value record');
		const key = record.slice(0, equals);
		if (key !== 'path') throw new Error(`packed artifact has an unsupported PAX attribute: ${key}`);
		if (path !== null) throw new Error('packed artifact has a duplicate PAX path attribute');
		path = record.slice(equals + 1);
		if (!path) throw new Error('packed artifact has an empty PAX path');
		cursor += length;
	}
	if (path === null) throw new Error('packed artifact PAX header has no path attribute');
	return path;
}

function gunzipCanonical(compressed, label) {
	if (compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b ||
		compressed[2] !== 8 || compressed[3] !== 0) {
		throw new Error(`${label} is not a canonical single-member gzip archive`);
	}
	let member;
	try {
		member = inflateRawSync(compressed.subarray(10), { info: true });
	} catch (error) {
		throw new Error(`${label} has an invalid deflate stream: ${error instanceof Error ? error.message : error}`);
	}
	const end = 10 + member.engine.bytesWritten + 8;
	if (end !== compressed.length) throw new Error(`${label} has trailing data or multiple gzip members`);
	try {
		return gunzipSync(compressed);
	} catch (error) {
		throw new Error(`${label} has an invalid gzip checksum or footer: ${error instanceof Error ? error.message : error}`);
	}
}

function packedTreeDigest(compressed, label) {
	const archive = gunzipCanonical(compressed, label);
	if (archive.length % 512 !== 0) throw new Error(`${label} tar size is not aligned to a 512-byte block`);
	const records = [];
	const entries = new Map();
	const remember = (name, kind) => {
		if (entries.has(name)) throw new Error(`${label} contains a duplicate or colliding path: ${name}`);
		const segments = name ? name.split('/') : [];
		for (let index = 1; index < segments.length; index++) {
			const ancestor = segments.slice(0, index).join('/');
			if (entries.get(ancestor) === 'file') throw new Error(`${label} nests an entry beneath a file: ${name}`);
		}
		if (kind === 'file' && [...entries.keys()].some((entry) => entry.startsWith(`${name}/`))) {
			throw new Error(`${label} replaces a directory hierarchy with a file: ${name}`);
		}
		entries.set(name, kind);
	};
	let cursor = 0;
	let extendedPath = null;
	let ended = false;
	while (cursor + 512 <= archive.length) {
		const header = archive.subarray(cursor, cursor + 512);
		if (header.every((byte) => byte === 0)) {
			const second = archive.subarray(cursor + 512, cursor + 1024);
			if (second.length !== 512 || !second.every((byte) => byte === 0) ||
				!archive.subarray(cursor + 1024).every((byte) => byte === 0)) {
				throw new Error(`${label} has an invalid or non-terminal end-of-archive marker`);
			}
			ended = true;
			break;
		}
		assertTarHeader(header, label);
		const size = tarSize(header);
		const payloadStart = cursor + 512;
		const payloadEnd = payloadStart + size;
		const paddedEnd = payloadStart + Math.ceil(size / 512) * 512;
		if (paddedEnd > archive.length) throw new Error(`${label} has a truncated tar entry`);
		const payload = archive.subarray(payloadStart, payloadEnd);
		if (!archive.subarray(payloadEnd, paddedEnd).every((byte) => byte === 0)) {
			throw new Error(`${label} has nonzero tar entry padding`);
		}
		const type = String.fromCharCode(header[156] || 0);
		const prefix = tarText(header, 345, 155, label);
		const headerName = [prefix, tarText(header, 0, 100, label)].filter(Boolean).join('/');
		if (type === 'x') {
			if (extendedPath !== null) throw new Error(`${label} has stacked extended path headers`);
			extendedPath = paxPath(payload);
		} else if (type === 'L') {
			if (extendedPath !== null) throw new Error(`${label} has stacked extended path headers`);
			if (!payload.length || payload.at(-1) !== 0) throw new Error(`${label} has an unterminated GNU long path`);
			if (payload.subarray(0, -1).includes(0)) throw new Error(`${label} has hidden bytes after a GNU long-path terminator`);
			extendedPath = payload.subarray(0, -1).toString('utf8');
			if (!extendedPath) throw new Error(`${label} has an empty GNU long path`);
		} else {
			const entry = extendedPath !== null ? extendedPath : headerName;
			extendedPath = null;
			if (type === '0' || type === '\0') {
				const name = safeTarPath(entry, label);
				remember(name, 'file');
				records.push({
					name,
					size: payload.length,
					digest: createHash('sha256').update(payload).digest('hex')
				});
			} else if (type === '5') {
				if (size !== 0) throw new Error(`${label} contains a directory entry with a payload: ${entry}`);
				remember(safeTarPath(entry, label, true), 'directory');
			} else {
				throw new Error(`${label} contains unsupported tar entry type ${JSON.stringify(type)} at ${entry}`);
			}
		}
		cursor = paddedEnd;
	}
	if (extendedPath !== null) throw new Error(`${label} ends with an orphaned extended path`);
	if (!ended) throw new Error(`${label} has no canonical end-of-archive marker`);
	return digestTreeRecords(records);
}

export function attestPackedArtifact(installedRoot, tarballPath, expectedIntegrity, label = 'packed head') {
	const tarball = readFileSync(tarballPath);
	const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
	if (integrity !== expectedIntegrity) throw new Error(`${label} tarball does not match its lock integrity`);
	const packedTree = packedTreeDigest(tarball, `${label} tarball`);
	const installedTree = packageTreeDigest(installedRoot, `${label} package`);
	if (packedTree.files !== installedTree.files || packedTree.digest !== installedTree.digest) {
		throw new Error(`${label} installed tree does not match its packed artifact`);
	}
}

function attestPackedHeads(consumer, lock) {
	for (const name of HEADS) {
		const locked = lock.packages?.[`node_modules/${name}`];
		const installedRoot = join(consumer, 'node_modules', name);
		const installed = readJson(join(installedRoot, 'package.json'), `${name} package manifest`);
		const expectedResolved = `file:../tarballs/${name}-${installed.version}.tgz`;
		if (installed.name !== name || !locked || locked.version !== installed.version ||
			locked.resolved !== expectedResolved || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked.integrity || '')) {
			throw new Error(`${name} lock identity does not match the installed packed head`);
		}
		const tarballPath = resolve(consumer, locked.resolved.slice('file:'.length));
		attestPackedArtifact(installedRoot, tarballPath, locked.integrity, name);
	}
}

export function attestTypeScriptInstallation(consumerDirectory) {
	const consumer = resolve(consumerDirectory);
	const consumerPackage = readJson(join(consumer, 'package.json'), 'consumer package manifest');
	if (consumerPackage.devDependencies?.typescript !== TYPESCRIPT_ATTESTATION.range) {
		throw new Error('consumer TypeScript range does not match the pinned harness contract');
	}
	const lock = readJson(join(consumer, 'package-lock.json'), 'consumer package lock');
	const locked = lock.packages?.['node_modules/typescript'];
	if (lock.packages?.['']?.devDependencies?.typescript !== TYPESCRIPT_ATTESTATION.range ||
		locked?.version !== TYPESCRIPT_ATTESTATION.version ||
		locked?.resolved !== TYPESCRIPT_ATTESTATION.resolved ||
		locked?.integrity !== TYPESCRIPT_ATTESTATION.integrity) {
		throw new Error('consumer lock does not contain the pinned TypeScript identity');
	}
	const typescriptRoot = join(consumer, 'node_modules', 'typescript');
	const installed = readJson(join(typescriptRoot, 'package.json'), 'installed TypeScript manifest');
	if (installed.name !== 'typescript' || installed.version !== TYPESCRIPT_ATTESTATION.version ||
		installed.main !== './lib/typescript.js' || installed.bin?.tsc !== './bin/tsc') {
		throw new Error('installed TypeScript manifest does not match the pinned compiler');
	}
	const tree = packageTreeDigest(typescriptRoot, 'TypeScript package');
	if (tree.files !== TYPESCRIPT_ATTESTATION.files || tree.digest !== TYPESCRIPT_ATTESTATION.treeSha256) {
		throw new Error(`installed TypeScript tree does not match the pinned compiler (${tree.files} files, ${tree.digest})`);
	}
	return resolve(typescriptRoot, 'bin', 'tsc');
}

export function attestTypeConsumer(consumerDirectory) {
	const consumer = resolve(consumerDirectory);
	const config = readJson(join(consumer, 'tsconfig.json'), 'consumer tsconfig');
	if (JSON.stringify(canonicalJson(config)) !== JSON.stringify(canonicalJson(EXPECTED_TSCONFIG))) {
		throw new Error('consumer tsconfig does not match the strict proof contract');
	}
	const lock = readJson(join(consumer, 'package-lock.json'), 'consumer package lock');
	attestPackedHeads(consumer, lock);
	const expected = reconstructTypeConsumer(consumer);
	let actualSource;
	try {
		actualSource = readFileSync(join(consumer, 'consumer.ts'), 'utf8').replace(/\r\n?/g, '\n');
	} catch (error) {
		throw new Error(`generated consumer source is missing: ${error instanceof Error ? error.message : error}`);
	}
	if (actualSource !== expected.harnessSource) {
		throw new Error('generated consumer source does not match the installed public exports');
	}
	return {
		compiler: attestTypeScriptInstallation(consumer),
		subpaths: expected.subpaths,
		imports: expected.imports,
		directSource: expected.directSource
	};
}

/** Fail closed unless every supported TypeScript resolver mode has the same process result. */
export function reconcileDirectCompilerResults(bundler, nodeEsm, nodeCjs) {
	const signature = (value) => JSON.stringify({
		status: value.status,
		signal: value.signal,
		error: value.error ? String(value.error.code || value.error.message || value.error) : null,
		stdout: normalized(value.stdout),
		stderr: normalized(value.stderr)
	});
	const bundlerSignature = signature(bundler);
	if (bundlerSignature === signature(nodeEsm) && bundlerSignature === signature(nodeCjs)) return bundler;
	return {
		status: null,
		signal: null,
		error: {
			code: `direct-mode-mismatch: bundler=${bundler.status ?? 'none'}, node-esm=${nodeEsm.status ?? 'none'}, node-cjs=${nodeCjs.status ?? 'none'}`
		},
		stdout: [
			`----- bundler -----\n${normalized(bundler.stdout)}`,
			`----- node-esm -----\n${normalized(nodeEsm.stdout)}`,
			`----- node-cjs -----\n${normalized(nodeCjs.stdout)}`
		].join('\n'),
		stderr: [
			`----- bundler -----\n${normalized(bundler.stderr)}`,
			`----- node-esm -----\n${normalized(nodeEsm.stderr)}`,
			`----- node-cjs -----\n${normalized(nodeCjs.stderr)}`
		].join('\n')
	};
}

function captureDirectCompiler(consumerDirectory, evidencePath) {
	const consumer = resolve(consumerDirectory);
	let result;
	try {
		const attestation = attestTypeConsumer(consumer);
		writeFileSync(join(consumer, DIRECT_BUNDLER_SOURCE), attestation.directSource, 'utf8');
		writeFileSync(join(consumer, DIRECT_NODE_ESM_SOURCE), attestation.directSource, 'utf8');
		writeFileSync(join(consumer, DIRECT_NODE_CJS_SOURCE), attestation.directSource, 'utf8');
		writeFileSync(join(consumer, DIRECT_BUNDLER_TSCONFIG), `${JSON.stringify({
			...EXPECTED_TSCONFIG,
			files: [DIRECT_BUNDLER_SOURCE]
		}, null, 2)}\n`, 'utf8');
		writeFileSync(join(consumer, DIRECT_NODE_ESM_TSCONFIG), `${JSON.stringify({
			compilerOptions: {
				...EXPECTED_TSCONFIG.compilerOptions,
				module: 'nodenext',
				moduleResolution: 'nodenext'
			},
			files: [DIRECT_NODE_ESM_SOURCE]
		}, null, 2)}\n`, 'utf8');
		writeFileSync(join(consumer, DIRECT_NODE_CJS_TSCONFIG), `${JSON.stringify({
			compilerOptions: {
				...EXPECTED_TSCONFIG.compilerOptions,
				module: 'nodenext',
				moduleResolution: 'nodenext'
			},
			files: [DIRECT_NODE_CJS_SOURCE]
		}, null, 2)}\n`, 'utf8');
		const run = (config) => spawnSync(process.execPath, [attestation.compiler, '--project', config, '--pretty', 'false'], {
			cwd: consumer,
			encoding: 'utf8',
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024
		});
		const bundler = run(DIRECT_BUNDLER_TSCONFIG);
		const nodeEsm = run(DIRECT_NODE_ESM_TSCONFIG);
		const nodeCjs = run(DIRECT_NODE_CJS_TSCONFIG);
		result = reconcileDirectCompilerResults(bundler, nodeEsm, nodeCjs);
		result.subpaths = attestation.subpaths;
		result.imports = attestation.imports;
		result.modes = DIRECT_MODE_ATTESTATION;
	} catch (error) {
		result = {
			status: null,
			signal: null,
			error: {
				code: `consumer-attestation: ${error instanceof Error ? error.message : error}`
			},
			subpaths: null,
			imports: null,
			modes: null,
			stdout: '',
			stderr: ''
		};
	}
	const evidence = serializeDirectCompilerEvidence(result);
	mkdirSync(dirname(resolve(evidencePath)), { recursive: true });
	writeFileSync(evidencePath, evidence, 'utf8');
	return evidence;
}

function main() {
	const [harnessPath, consumerDirectory, evidencePath, expectedOutcome] = process.argv.slice(2);
	if (process.argv.length !== 6 || !['success', 'failure'].includes(expectedOutcome)) {
		console.error('usage: node scripts/classify-cross-repo-types.js <harness-log> <consumer-dir> <direct-evidence-log> <success|failure>');
		process.exit(2);
	}
	const harness = decodeHarnessLog(readFileSync(harnessPath));
	const evidence = captureDirectCompiler(consumerDirectory, evidencePath);
	const result = classifyTypeProof(harness, evidence);
	const expectedStatus = expectedOutcome === 'success' ? 'clean' : 'known';
	if (result.status !== expectedStatus) {
		console.error(`unclassified strict type result: ${result.reason}`);
		process.exit(1);
	}
	console.log(`strict-type-proof: ${result.status}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
