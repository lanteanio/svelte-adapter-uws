// Structural contract for the adapter-owned cross-repository workflow.
//
// The executable harness lives in svelte-adapter-uws-extensions. This
// test deliberately does not duplicate it; it pins the orchestration promises
// that are easiest for a workflow edit to silently weaken.

import { describe, it, expect } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
	attestPackedArtifact,
	classifyKnownTypeDebt,
	classifyTypeProof,
	decodeHarnessLog,
	reconcileDirectCompilerResults,
	reconstructTypeConsumer,
	serializeDirectCompilerEvidence
} from '../scripts/classify-cross-repo-types.js';
import { parseOverlayArgs } from '../scripts/install-cross-repo-overlays.js';

const workflow = readFileSync(
	fileURLToPath(new URL('../.github/workflows/cross-repo-heads.yml', import.meta.url)),
	'utf8'
);
const classifierPath = fileURLToPath(
	new URL('../scripts/classify-cross-repo-types.js', import.meta.url)
);
const classifierSource = readFileSync(classifierPath, 'utf8');

function packedHeader(name, size, type = '0') {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, 'utf8');
	header.write('0000644\0', 100, 8, 'ascii');
	header.write('0000000\0', 108, 8, 'ascii');
	header.write('0000000\0', 116, 8, 'ascii');
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
	header.write('00000000000\0', 136, 12, 'ascii');
	header.fill(0x20, 148, 156);
	header[156] = type.charCodeAt(0);
	header.write('ustar\0', 257, 6, 'ascii');
	header.write('00', 263, 2, 'ascii');
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
	return header;
}

function packedFixture(files) {
	const blocks = [];
	for (const [name, value] of Object.entries(files)) {
		const bytes = Buffer.from(value);
		const header = packedHeader(`package/${name}`, bytes.length);
		blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

const actionRefs = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);

const knownHarnessDiagnostic = "C:\\work\\consumer\\node_modules\\svelte-adapter-uws-extensions\\src\\redis\\session.d.ts(71): TS2304 Cannot find name 'T'.";
const harnessHeader = [
	'cross-repo gate: adapter + extensions + realtime, packed and installed as one set',
	'',
	'  svelte-adapter-uws             0.6.0-next.91    7b9ba00 +67 uncommitted',
	'  svelte-adapter-uws-extensions  0.6.0-next.63    90c9f88',
	'  svelte-realtime                0.6.0-next.90    c76a058',
	'  work dir: C:\\work',
	'',
	'  note: gating WORKING TREES, not committed SHAs: svelte-adapter-uws (67 uncommitted file(s))',
	''
];
const knownHarness = [
	...harnessHeader,
	'rungs:',
	'  [ok  ] pack: svelte-adapter-uws@0.6.0-next.91, svelte-adapter-uws-extensions@0.6.0-next.63, svelte-realtime@0.6.0-next.90',
	'  [ok  ] install: 3 packed heads + peers installed clean into consumer',
	'  [FAIL] types: 1 type error(s) in the shipped surface of the heads (92 subpaths imported)',
	`        ${knownHarnessDiagnostic}`,
	'',
	'summary',
	'  passed:  pack, install',
	'  FAILED:  types',
	'',
	'cross-repo gate: FAILED'
].join('\n');

const knownDirectDiagnostic = "node_modules/svelte-adapter-uws-extensions/src/redis/session.d.ts(71,24): error TS2304: Cannot find name 'T'.";
const knownDirectEvidence = serializeDirectCompilerEvidence({
	status: 2,
	signal: null,
	error: null,
	subpaths: 92,
	imports: 92,
	modes: 'bundler,node-esm,node-cjs',
	stdout: `${knownDirectDiagnostic}\n`,
	stderr: ''
});

function encodedLogs(source) {
	return [
		Buffer.from(source, 'utf8'),
		Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])
	];
}

describe('cross-repo heads workflow', () => {
	it('checks out all three repositories at explicit reproducible revisions', () => {
		expect(workflow).toContain('path: heads/svelte-adapter-uws');
		expect(workflow).toContain('repository: lanteanio/svelte-adapter-uws-extensions');
		expect(workflow).toContain('repository: lanteanio/svelte-realtime');
		expect(workflow).toContain('ref: ${{ github.sha }}');

		for (const variable of ['EXTENSIONS_REF', 'REALTIME_REF']) {
			expect(workflow, `${variable} must default to an immutable commit`).toMatch(
				new RegExp(`^  ${variable}: '[0-9a-f]{40}'$`, 'm')
			);
		}
		expect(workflow).toContain('persist-credentials: false');
		expect(workflow).not.toContain('secrets.');
	});

	it('pins every third-party action to an immutable commit', () => {
		expect(actionRefs.length).toBeGreaterThan(0);
		for (const ref of actionRefs) expect(ref).toMatch(/@[0-9a-f]{40}$/);
	});

	it('delegates every rung to the extensions harness against clean trees', () => {
		expect(workflow).toContain('heads/svelte-adapter-uws-extensions/scripts/cross-repo-gate.js');
		for (const rung of ['peers', 'types', 'check,unit', 'realtime-e2e', 'extensions-integration']) {
			expect(workflow, `missing ${rung} rung`).toContain(`--rungs ${rung}`);
		}
		expect(workflow.match(/--require-clean --strict --clean/g)?.length).toBe(8);
	});

	it('proves packed install and peer coherence on Linux and Windows', () => {
		expect(workflow).toContain('os: [ubuntu-latest, windows-latest]');
		expect(workflow).toContain('Pack and install heads; verify peers');
		expect(workflow).toContain('cross-repo-gate/tarballs/*.tgz');
		expect(workflow).toContain('cross-repo-gate/consumer/package-lock.json');
	});

	it('tolerates only the exact pinned declaration diagnostic', () => {
		expect(workflow).toMatch(/id: strict-types\s+continue-on-error: true/);
		expect(workflow).toContain('$logPath cross-repo-gate/consumer $evidencePath $env:TYPE_STEP_OUTCOME');
		expect(workflow).toContain('strict-type-proof: known');
		expect(workflow).toContain('independent direct tsc');

		for (const bytes of encodedLogs(knownHarness)) {
			expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), knownDirectEvidence)).toMatchObject({ known: true });
		}

		const unrelated = knownHarness.replace(
			"svelte-adapter-uws-extensions\\src\\redis\\session.d.ts(71): TS2304 Cannot find name 'T'.",
			"svelte-adapter-uws\\index.d.ts(4,2): TS2322 Type 'string' is not assignable to type 'number'."
		);
		expect(classifyKnownTypeDebt(unrelated, knownDirectEvidence)).toMatchObject({ known: false });
	});

	it('rejects hidden global compiler failures in UTF-8 and UTF-16 runs', () => {
		const directWithGlobalFailure = serializeDirectCompilerEvidence({
			status: 2,
			signal: null,
			error: null,
			subpaths: 92,
			imports: 92,
			modes: 'bundler,node-esm,node-cjs',
			stdout: [
				"node_modules/svelte-adapter-uws-extensions/src/redis/session.d.ts(71,24): error TS2304: Cannot find name 'T'.",
				"error TS18003: No inputs were found in config file 'tsconfig.json'."
			].join('\n'),
			stderr: ''
		});
		for (const bytes of encodedLogs(knownHarness)) {
			expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), directWithGlobalFailure)).toMatchObject({ known: false });
		}
	});

	it('rejects suffix laundering and any extra direct compiler stdout', () => {
		const directMutations = [
			`compiler transport lost one record\n${knownDirectDiagnostic}`,
			`${knownDirectDiagnostic}\ncompiler transport lost one record`,
			`error TS18003: hidden global failure /${knownDirectDiagnostic}`
		];
		for (const stdout of directMutations) {
			const evidence = serializeDirectCompilerEvidence({
				status: 2,
				signal: null,
				error: null,
				subpaths: 92,
				imports: 92,
				modes: 'bundler,node-esm,node-cjs',
				stdout,
				stderr: ''
			});
			for (const bytes of encodedLogs(knownHarness)) {
				expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), evidence)).toMatchObject({ known: false });
			}
		}

		const fusedHarness = knownHarness.replace(
			knownHarnessDiagnostic,
			"error TS18003: hidden global failure /node_modules/svelte-adapter-uws-extensions/src/redis/session.d.ts(71): TS2304 Cannot find name 'T'."
		);
		for (const bytes of encodedLogs(fusedHarness)) {
			expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), knownDirectEvidence)).toMatchObject({ known: false });
		}
	});

	it('requires the complete harness provenance header and exact direct evidence adjacency', () => {
		const truncated = knownHarness.slice(knownHarness.indexOf('rungs:'));
		expect(classifyKnownTypeDebt(truncated, knownDirectEvidence)).toMatchObject({ known: false });

		for (const evidence of [
			knownDirectEvidence.replace(
				'cross-repo direct tsc evidence v1\n',
				'cross-repo direct tsc evidence v1\nTypeError: compiler transport crashed\n'
			),
			knownDirectEvidence.replace(
				'----- compiler stdout end -----\n----- compiler stderr begin -----',
				'----- compiler stdout end -----\nerror TS18003: hidden outside bounded streams\n----- compiler stderr begin -----'
			)
		]) {
			expect(classifyKnownTypeDebt(knownHarness, evidence)).toMatchObject({ known: false });
		}
	});

	it('requires exact successful pack and install rung records', () => {
		for (const mutation of [
			knownHarness.replace('@0.6.0-next.90', '@0.6.0-next.90 status: 137'),
			knownHarness.replace('installed clean into consumer', 'installed clean into consumer killed by SIGKILL'),
			knownHarness.replace('installed clean into consumer', 'installed clean into consumer ELIFECYCLE')
		]) {
			expect(classifyKnownTypeDebt(mutation, knownDirectEvidence)).toMatchObject({ known: false });
		}
	});

	it('rejects unstructured terminal failure evidence in the harness transcript', () => {
		for (const failure of [
			'Error: ENOSPC while producing compiler output',
			'Exception: compiler producer crashed',
			'RangeException: producer died',
			'CompilerFailureError producer died',
			'node:internal/modules/cjs/loader: command not found',
			'/bin/sh: tsc: not found',
			'compiler process terminated by signal SIGTERM',
			'signal: SIGKILL',
			'signal SIGABRT',
			'exit-code: 137',
			'exit code 9',
			'EACCES while loading compiler',
			'spawn-error: ENOENT'
		]) {
			const mutation = knownHarness.replace('\nsummary', `\n${failure}\nsummary`);
			for (const bytes of encodedLogs(mutation)) {
				expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), knownDirectEvidence)).toMatchObject({ known: false });
			}
		}
	});

	it('rejects diagnostic-path laundering and coordinated subpath-count tampering', () => {
		const laundered = knownHarness.replace(
			knownHarnessDiagnostic,
			"C:\\error TS18003 hidden\\consumer\\node_modules\\svelte-adapter-uws-extensions\\src\\redis\\session.d.ts(71): TS2304 Cannot find name 'T'."
		);
		expect(classifyKnownTypeDebt(laundered, knownDirectEvidence)).toMatchObject({ known: false });

		const reducedDirectEvidence = serializeDirectCompilerEvidence({
			status: 2,
			signal: null,
			error: null,
			subpaths: 90,
			imports: 90,
			modes: 'bundler,node-esm,node-cjs',
			stdout: `${knownDirectDiagnostic}\n`,
			stderr: ''
		});
		expect(classifyKnownTypeDebt(knownHarness, reducedDirectEvidence)).toMatchObject({ known: false });
	});

	it('binds the installed head bytes to the integrity-locked packed artifact', () => {
		const root = mkdtempSync(join(tmpdir(), 'svelte-adapter-uws-packed-proof-'));
		const installed = join(root, 'installed');
		const tarballPath = join(root, 'head.tgz');
		const manifestPath = join(installed, 'package.json');
		const manifest = {
			name: 'example-head',
			version: '1.0.0',
			exports: { '.': './index.js', './sim': './sim.js' }
		};
		const files = {
			'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
			'index.d.ts': 'export type Control = true;\n'
		};
		try {
			mkdirSync(installed, { recursive: true });
			for (const [name, contents] of Object.entries(files)) writeFileSync(join(installed, name), contents);
			const tarball = packedFixture(files);
			writeFileSync(tarballPath, tarball);
			const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
			expect(() => attestPackedArtifact(installed, tarballPath, integrity, 'example-head')).not.toThrow();
			const raw = gunzipSync(tarball);
			const expectTarReject = (bytes, pattern) => {
				const compressed = gzipSync(bytes);
				writeFileSync(tarballPath, compressed);
				const digest = `sha512-${createHash('sha512').update(compressed).digest('base64')}`;
				expect(() => attestPackedArtifact(installed, tarballPath, digest, 'example-head')).toThrow(pattern);
			};
			const expectCompressedReject = (compressed, pattern) => {
				writeFileSync(tarballPath, compressed);
				const digest = `sha512-${createHash('sha512').update(compressed).digest('base64')}`;
				expect(() => attestPackedArtifact(installed, tarballPath, digest, 'example-head')).toThrow(pattern);
			};
			const rewriteChecksum = (bytes, offset = 0) => {
				const header = bytes.subarray(offset, offset + 512);
				header.fill(0x20, 148, 156);
				const checksum = header.reduce((sum, byte) => sum + byte, 0);
				header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
				return bytes;
			};
			const corruptChecksum = Buffer.from(raw);
			corruptChecksum[148] = corruptChecksum[148] === 0x30 ? 0x31 : 0x30;
			expectTarReject(corruptChecksum, /corrupt tar header checksum/);
			expectTarReject(Buffer.concat([packedHeader('package\/..\/..\/escape', 0, '5'), raw]), /unsafe path/);
			expectTarReject(raw.subarray(0, raw.length - 1024), /no canonical end-of-archive marker/);
			expectTarReject(raw.subarray(0, raw.length - 512), /invalid or non-terminal end-of-archive marker/);
			expectTarReject(Buffer.concat([raw, packedHeader('package/hidden', 0)]), /invalid or non-terminal end-of-archive marker/);
			const nonzeroPadding = Buffer.from(raw);
			nonzeroPadding[512 + Buffer.byteLength(files['package.json'])] = 0x41;
			expectTarReject(nonzeroPadding, /nonzero tar entry padding/);
			const newlinePath = Buffer.from(raw);
			newlinePath[Buffer.byteLength('package/package.json')] = 0x0a;
			expectTarReject(rewriteChecksum(newlinePath), /control character in a path/);
			const backslashPath = Buffer.from(raw);
			backslashPath['package'.length] = 0x5c;
			expectTarReject(rewriteChecksum(backslashPath), /backslash in a tar path/);
			expectTarReject(
				Buffer.concat([packedHeader('package/lib/', 0, '5'), packedHeader('package/lib/', 0, '5'), raw]),
				/duplicate or colliding path/
			);
			const badVersion = Buffer.from(raw);
			badVersion.write('xx', 263, 2, 'ascii');
			expectTarReject(rewriteChecksum(badVersion), /non-canonical ustar version/);
			const unterminatedSize = Buffer.from(raw);
			unterminatedSize.write('000000000000', 124, 12, 'ascii');
			expectTarReject(rewriteChecksum(unterminatedSize), /non-canonical tar size field/);

			const paxValue = 'path=package/index.d.tsX';
			let paxLength = paxValue.length + 3;
			while (`${paxLength} ${paxValue}`.length !== paxLength) paxLength = `${paxLength} ${paxValue}`.length;
			const pax = Buffer.from(`${paxLength} ${paxValue}`);
			const paxPadding = Buffer.alloc((512 - pax.length % 512) % 512);
			expectTarReject(
				Buffer.concat([packedHeader('PaxHeader', pax.length, 'x'), pax, paxPadding, raw]),
				/PAX record without a newline terminator/
			);
			const paxMetadata = Buffer.from('11 size=24\n');
			expectTarReject(
				Buffer.concat([
					packedHeader('PaxHeader', paxMetadata.length, 'x'),
					paxMetadata,
					Buffer.alloc((512 - paxMetadata.length % 512) % 512),
					raw
				]),
				/unsupported PAX attribute/
			);
			const hiddenGnuPath = Buffer.from('package/package.json\0hidden\0');
			expectTarReject(
				Buffer.concat([
					packedHeader('././@LongLink', hiddenGnuPath.length, 'L'),
					hiddenGnuPath,
					Buffer.alloc((512 - hiddenGnuPath.length % 512) % 512),
					raw
				]),
				/hidden bytes after a GNU long-path terminator/
			);
			expectCompressedReject(Buffer.concat([tarball, Buffer.from([0])]), /trailing data or multiple gzip members/);
			expectCompressedReject(Buffer.concat([tarball, gzipSync(Buffer.alloc(0))]), /trailing data or multiple gzip members/);

			writeFileSync(tarballPath, tarball);
			delete manifest.exports['./sim'];
			manifest.exports['./sim-shadow'] = './sim.js';
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			expect(() => attestPackedArtifact(installed, tarballPath, integrity, 'example-head'))
				.toThrow(/installed tree does not match its packed artifact/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('expands shipped wildcard exports into the independent direct type corpus', () => {
		const root = mkdtempSync(join(tmpdir(), 'svelte-adapter-uws-wildcard-proof-'));
		try {
			for (const name of ['svelte-adapter-uws', 'svelte-adapter-uws-extensions', 'svelte-realtime']) {
				const packageRoot = join(root, 'node_modules', name);
				mkdirSync(packageRoot, { recursive: true });
				const exports = { '.': { types: './index.d.ts', import: './index.js' } };
				if (name === 'svelte-adapter-uws-extensions') {
					exports['./wild/*'] = { types: './src/wild/*.d.ts', import: './src/wild/*.js' };
					mkdirSync(join(packageRoot, 'src', 'wild'), { recursive: true });
					writeFileSync(join(packageRoot, 'src', 'wild', 'broken.d.ts'), 'export type Broken = MissingWildcardType;\n');
					writeFileSync(join(packageRoot, 'src', 'wild', 'broken.js'), 'export {};\n');
					writeFileSync(join(packageRoot, 'src', 'wild', 'missing.js'), 'export {};\n');
				}
				writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', exports }, null, 2)}\n`);
				writeFileSync(join(packageRoot, 'index.d.ts'), 'export type Control = true;\n');
				writeFileSync(join(packageRoot, 'index.js'), 'export {};\n');
			}
			const result = reconstructTypeConsumer(root);
			expect(result).toMatchObject({ subpaths: 3, imports: 5 });
			expect(result.harnessSource).not.toContain('svelte-adapter-uws-extensions/wild/broken');
			expect(result.directSource).toContain("from 'svelte-adapter-uws-extensions/wild/broken';");
			expect(result.directSource).toContain("from 'svelte-adapter-uws-extensions/wild/missing';");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('fails closed when only NodeNext ESM exposes a conditional declaration defect', () => {
		const clean = { status: 0, signal: null, error: null, stdout: '', stderr: '' };
		const nodeEsm = {
			status: 2,
			signal: null,
			error: null,
			stdout: "node_modules/conditional-head/types/node-esm.d.mts(1,23): error TS2304: Cannot find name 'MissingOnlyInNodeEsm'.\n",
			stderr: ''
		};
		const result = reconcileDirectCompilerResults(clean, nodeEsm, clean);
		expect(result).toMatchObject({
			status: null,
			signal: null,
			error: { code: 'direct-mode-mismatch: bundler=0, node-esm=2, node-cjs=0' }
		});
		expect(result.stdout).toContain('MissingOnlyInNodeEsm');
		expect(classifierSource).toContain("const DIRECT_NODE_ESM_SOURCE = '.cross-repo-direct-consumer.mts';");
		expect(classifierSource).toContain('const nodeEsm = run(DIRECT_NODE_ESM_TSCONFIG);');
		expect(classifierSource).toContain("const DIRECT_MODE_ATTESTATION = 'bundler,node-esm,node-cjs';");
	});

	it('rejects odd-byte UTF-16 transcripts before decoding', () => {
		const malformed = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(knownHarness, 'utf16le'),
			Buffer.from([0x41])
		]);
		expect(() => decodeHarnessLog(malformed)).toThrow(/UTF-16LE harness log has an odd byte length/);
	});

	it('attests config and compiler identity before executing direct tsc', () => {
		const root = mkdtempSync(join(tmpdir(), 'svelte-adapter-uws-type-proof-'));
		const compilerDirectory = join(root, 'consumer', 'node_modules', 'typescript', 'bin');
		const harnessPath = join(root, 'harness.log');
		const evidencePath = join(root, 'direct.log');
		const executionMarker = join(root, 'consumer', 'fake-compiler-executed');
		try {
			mkdirSync(compilerDirectory, { recursive: true });
			writeFileSync(join(root, 'consumer', 'tsconfig.json'), '{}\n');
			writeFileSync(harnessPath, knownHarness);
			writeFileSync(join(compilerDirectory, 'tsc'), [
				"require('node:fs').writeFileSync('fake-compiler-executed', 'yes');",
				`console.log(${JSON.stringify(knownDirectDiagnostic)});`,
				'process.exit(2);',
				''
			].join('\n'));
			const result = spawnSync(process.execPath, [
				classifierPath,
				harnessPath,
				join(root, 'consumer'),
				evidencePath,
				'failure'
			], { encoding: 'utf8', windowsHide: true });
			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain('strict-type-proof: known');
			expect(readFileSync(evidencePath, 'utf8')).toContain(
				'spawn-error: consumer-attestation: consumer tsconfig does not match the strict proof contract'
			);
			expect(existsSync(executionMarker)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('rejects truncated, replaced, duplicated, and trailing terminal records in both encodings', () => {
		const mutations = [
			knownHarness.replace(/\ncross-repo gate: FAILED$/, ''),
			knownHarness.replace('cross-repo gate: FAILED', 'fatal: compiler producer crashed'),
			knownHarness.replace('\nsummary', '\nfatal: compiler producer crashed\nsummary'),
			`${knownHarness}\nfatal: output after terminal`,
			`${knownHarness}\ncross-repo gate: FAILED`
		];
		for (const mutation of mutations) {
			for (const bytes of encodedLogs(mutation)) {
				expect(classifyKnownTypeDebt(decodeHarnessLog(bytes), knownDirectEvidence)).toMatchObject({ known: false });
			}
		}
		expect(classifyKnownTypeDebt(knownHarness, `${knownDirectEvidence.trimEnd()}\nfatal: trailing producer output`))
			.toMatchObject({ known: false });
	});

	it('requires a direct clean replay when the harness reports success', () => {
		const cleanHarness = [
			...harnessHeader,
			'rungs:',
			'  [ok  ] pack: svelte-adapter-uws@0.6.0-next.91, svelte-adapter-uws-extensions@0.6.0-next.63, svelte-realtime@0.6.0-next.90',
			'  [ok  ] install: 3 packed heads + peers installed clean into consumer',
			'  [ok  ] types: 92 public subpaths typecheck strict from the packed tarballs (svelte-adapter-uws 33, svelte-adapter-uws-extensions 46, svelte-realtime 13)',
			'',
			'summary',
			'  passed:  pack, install, types',
			'',
			'cross-repo gate: PASSED'
		].join('\n');
		const cleanEvidence = serializeDirectCompilerEvidence({
			status: 0,
			signal: null,
			error: null,
			subpaths: 92,
			imports: 92,
			modes: 'bundler,node-esm,node-cjs',
			stdout: '',
			stderr: ''
		});
		expect(classifyTypeProof(cleanHarness, cleanEvidence)).toMatchObject({ status: 'clean' });
		expect(classifyTypeProof(cleanHarness, knownDirectEvidence)).toMatchObject({ status: null });
	});

	it('installs the packed dependency graph before source-tree suites', () => {
		for (const label of [
			'Pack heads for source-tree overlays',
			'Overlay packed sibling heads into source trees',
			'Pack heads for realtime overlays',
			'Overlay packed heads into realtime and its fixture',
			'Pack heads for extensions integration overlay',
			'Overlay packed adapter into extensions'
		]) expect(workflow).toContain(label);
		expect(workflow).toContain('--target heads/svelte-adapter-uws-extensions=svelte-adapter-uws');
		expect(workflow).toContain('--target heads/svelte-realtime=svelte-adapter-uws,svelte-adapter-uws-extensions');
		expect(workflow).toContain(
			'--target heads/svelte-realtime/test/fixture=svelte-adapter-uws,svelte-adapter-uws-extensions,svelte-realtime'
		);
		expect(
			parseOverlayArgs([
				'--tarballs', 'packed', '--target', 'fixture=svelte-adapter-uws,svelte-realtime'
			])
		).toEqual({
			tarballs: 'packed',
			targets: [{ directory: 'fixture', packages: ['svelte-adapter-uws', 'svelte-realtime'] }]
		});
	});

	it('is read-only, cancellable, bounded, and preserves evidence', () => {
		expect(workflow).toMatch(/permissions:\s+contents: read/);
		expect(workflow).toContain('cancel-in-progress: true');
		const timeouts = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1]));
		expect(timeouts).toHaveLength(4);
		expect(timeouts.every((minutes) => minutes > 0 && minutes <= 60)).toBe(true);
		expect(workflow).toContain('Record resolved revisions');
		expect(workflow).toContain('actions/upload-artifact@');
		expect(workflow).toContain('retention-days: 14');
		expect(workflow).not.toContain('if-no-files-found: warn');
		expect(workflow.match(/if-no-files-found: error/g)).toHaveLength(4);
	});
});
