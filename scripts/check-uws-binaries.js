#!/usr/bin/env node
/**
 * Verify that the installed uWebSockets.js is the exact tree this repository
 * accepted, byte for byte.
 *
 * The exposure: the addon is declared as `github:uNetworking/uWebSockets.js#<tag>`
 * and a Git TAG is mutable. It carries prebuilt native binaries - one of which
 * is dlopen'd in every production process - built elsewhere, with no npm
 * integrity hash (a git dependency is addressed by commit, not by a registry
 * digest) and no signature. Retagging upstream, or anything that answers a
 * fetch, changes what a fresh install runs while every version string in sight
 * stays identical. Nothing in the tree would have noticed.
 *
 * So the accepted tree is recorded here instead: the spec, the commit the
 * lockfile resolves, the upstream source commit the package names, and a digest
 * per shipped file. A mismatch means the bytes running locally are not the bytes
 * that were reviewed, whatever the version says - which is the whole question.
 *
 * Boundaries, because two of them are not obvious:
 *
 *   - TEXT FILES ARE HASHED WITH CRLF NORMALIZED TO LF. The package is a git
 *     dependency, so npm CHECKS IT OUT with the contributor's own git config,
 *     and `core.autocrlf=true` on Windows rewrites every text file it ships.
 *     Hashing those raw would fail on a correct install for a reason that has
 *     nothing to do with integrity.
 *   - THE BINARIES ARE HASHED RAW. Git never rewrites a file containing a NUL
 *     byte, and they are the code that actually executes, so they are compared
 *     exactly as they landed on disk.
 *   - THE TREE IS EXPECTED TO BE FLAT. Upstream ships one directory of files and
 *     the record holds a digest per file, so an entry that is not a file is
 *     reported as a change of SHAPE rather than stepped over. The verdict this
 *     prints claims the whole tree; it must not be printed about a tree
 *     containing something nobody looked at.
 *   - NOT INSTALLED IS NOT A PASS. The addon is optional and npm skips it
 *     silently, so absence is reported and tolerated locally, and is a FAILURE
 *     under `--require-uws` / `REQUIRE_UWS=1` / `CI` - the same rule the test
 *     helper applies, so one switch makes every layer demand the real thing.
 *
 * Re-accepting after a deliberate pin bump, which is a review step and not a
 * formality - the diff it writes is the record of which binaries changed:
 *
 *   npm install                              (resolve the new pin)
 *   node scripts/check-uws-binaries.js --update
 *
 * Dependency-free, modeled on the sibling check-* scripts, wired into
 * `npm run check` and so into pretest.
 *
 * @module scripts/check-uws-binaries
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { requiredMode } from './require-uws.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTED = join(root, 'scripts', 'uws-accepted.json');
const INSTALLED = join(root, 'node_modules', 'uWebSockets.js');
const LOCK_KEY = 'node_modules/uWebSockets.js';

/**
 * Recorded in place of a digest when an installed entry is not a file.
 *
 * Upstream ships ONE FLAT DIRECTORY. A nested entry is a change of SHAPE rather
 * than of content, and the record has no digest that could describe it, so it is
 * carried through as a problem instead. Skipping it silently would let this gate
 * print "the installed tree is the accepted tree, byte for byte" about a tree
 * containing something it never looked at, and that sentence is the only thing
 * the gate exists to be able to say.
 *
 * Not a hex digest, so it can never collide with one.
 */
export const NOT_A_FILE = 'not-a-file';

/**
 * Digest of one shipped file. A NUL byte is how git itself decides a file is
 * binary and must not be rewritten, so it is also how this decides whether the
 * bytes on disk are allowed to differ from the bytes upstream committed.
 *
 * @param {Buffer} buf
 * @returns {string} sha256, hex
 */
export function digestFile(buf) {
	const binary = buf.includes(0);
	const bytes = binary ? buf : Buffer.from(buf.toString('utf8').split('\r\n').join('\n'), 'utf8');
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Digest every entry of an installed package directory, by name. An entry that
 * is not a file gets `NOT_A_FILE` rather than a digest, so `compare` reports it
 * instead of the walk stepping over it.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function hashTree(dir) {
	/** @type {Record<string, string>} */
	const files = {};
	for (const name of readdirSync(dir).sort()) {
		const abs = join(dir, name);
		files[name] = statSync(abs).isFile() ? digestFile(readFileSync(abs)) : NOT_A_FILE;
	}
	return files;
}

/**
 * The git ref an install spec or a lockfile `resolved` URL points at.
 * @param {string | undefined} spec
 * @returns {string | null}
 */
export function refOf(spec) {
	if (typeof spec !== 'string') return null;
	const hash = spec.indexOf('#');
	return hash === -1 ? null : spec.slice(hash + 1);
}

/**
 * Everything that does not match, as one list. Empty means the installed tree
 * is the accepted tree.
 *
 * The accepted spec is held as package + ref rather than as one string so that
 * this record is not itself an install spec: the sibling pin guard scans every
 * tracked file for one and would fail on a stale record with advice to hand-edit
 * it, which is the one repair that must never be made here.
 *
 * @param {{ package: string, ref: string, commit: string, upstreamSourceCommit: string, files: Record<string, string> }} accepted
 * @param {{ spec: string | undefined, commit: string | null, files: Record<string, string> | null }} actual
 * @returns {string[]}
 */
export function compare(accepted, actual) {
	const problems = [];
	const acceptedSpec = `${accepted.package}#${accepted.ref}`;

	if (actual.spec !== acceptedSpec) {
		problems.push(
			`the manifest pin is ${actual.spec}, accepted is ${acceptedSpec}. A pin bump is a ` +
			're-acceptance: install it, review what changed, then re-run with --update.'
		);
	}
	if (actual.commit !== accepted.commit) {
		problems.push(
			`the lockfile resolves commit ${actual.commit}, accepted is ${accepted.commit}. The ` +
			'pin is a mutable TAG, so a moved tag changes this while every version string stays put.'
		);
	}

	// Nothing installed: the caller decides whether that is fatal.
	if (actual.files === null) return problems;

	for (const [name, digest] of Object.entries(accepted.files)) {
		if (!(name in actual.files)) problems.push(`missing from the installed tree: ${name}`);
		// A name that was accepted as a file and is now something else is
		// reported once, below, as the shape change it is.
		else if (actual.files[name] === NOT_A_FILE) continue;
		else if (actual.files[name] !== digest) {
			problems.push(`content differs: ${name}\n      accepted ${digest}\n      installed ${actual.files[name]}`);
		}
	}
	for (const name of Object.keys(actual.files)) {
		if (actual.files[name] === NOT_A_FILE) {
			problems.push(
				`not a file: ${name}. Upstream ships one flat directory, so this is a change of ` +
				'SHAPE, and a digest cannot describe it. Widen the walk deliberately, then re-accept.'
			);
			continue;
		}
		if (!(name in accepted.files)) problems.push(`present in the installed tree but never accepted: ${name}`);
	}
	return problems;
}

/** The installed tree's state, or nulls when the optional addon is absent. */
function installedState() {
	if (!existsSync(INSTALLED)) return { files: null, sourceCommit: null };
	const sourceCommitFile = join(INSTALLED, 'source_commit');
	return {
		files: hashTree(INSTALLED),
		sourceCommit: existsSync(sourceCommitFile) ? readFileSync(sourceCommitFile, 'utf8').trim() : null
	};
}

function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
	const update = process.argv.includes('--update');
	const required = requiredMode(process.argv, process.env);

	const spec = pkg.optionalDependencies && pkg.optionalDependencies['uWebSockets.js'];
	const commit = refOf(lock.packages && lock.packages[LOCK_KEY] && lock.packages[LOCK_KEY].resolved);
	const installed = installedState();

	console.log(`check-uws-binaries: ${pkg.name}@${pkg.version}`);

	if (update) {
		if (installed.files === null) {
			console.error('\ncheck-uws-binaries --update FAILED: nothing installed to accept.');
			console.error('  Run `npm install` first - the tree being accepted has to exist.');
			process.exit(1);
		}
		// The record holds a digest per file and has no way to express anything
		// else, so a tree that is no longer flat must not be blessed into it -
		// that would turn an unexamined entry into an accepted one.
		const shape = Object.keys(installed.files).filter((name) => installed.files[name] === NOT_A_FILE);
		if (shape.length) {
			console.error('\ncheck-uws-binaries --update FAILED: the installed tree is not flat.');
			for (const name of shape) console.error(`  x not a file: ${name}`);
			console.error('  Widen the walk deliberately before accepting a tree it cannot describe.');
			process.exit(1);
		}
		const hash = String(spec).indexOf('#');
		const accepted = {
			package: hash === -1 ? spec : String(spec).slice(0, hash),
			ref: refOf(spec),
			commit,
			upstreamSourceCommit: installed.sourceCommit,
			files: installed.files
		};
		writeFileSync(ACCEPTED, JSON.stringify(accepted, null, '\t') + '\n');
		console.log(`  accepted ${Object.keys(installed.files).length} file(s) of ${spec}`);
		console.log(`  commit ${commit}, upstream source ${installed.sourceCommit}`);
		console.log('  Review the diff: it is the record of which binaries changed.');
		return;
	}

	const accepted = JSON.parse(readFileSync(ACCEPTED, 'utf8'));
	console.log(`  accepted: ${accepted.package}#${accepted.ref} at ${accepted.commit} (${Object.keys(accepted.files).length} files)`);

	if (installed.files === null) {
		// Optional and skipped silently by npm, so say it out loud either way.
		const message = 'uWebSockets.js is not installed, so the accepted binaries were not verified.';
		if (required) {
			console.error(`\ncheck-uws-binaries FAILED: ${message}`);
			console.error(`  npm install ${String(spec).replace(/^github:/, '')}`);
			process.exit(1);
		}
		console.log(`  SKIPPED - ${message}`);
		console.log('  (--require-uws, REQUIRE_UWS=1 or CI makes this a failure.)');
		return;
	}

	const problems = compare(accepted, { spec, commit, files: installed.files });
	if (installed.sourceCommit !== accepted.upstreamSourceCommit) {
		problems.push(
			`the package names upstream source commit ${installed.sourceCommit}, accepted is ` +
			`${accepted.upstreamSourceCommit}. Same version, different source.`
		);
	}

	if (problems.length) {
		console.error(`\ncheck-uws-binaries FAILED (${problems.length}):`);
		for (const problem of problems) console.error(`  x ${problem}`);
		console.error('  These are the bytes that get dlopen\'d in production. If the change is');
		console.error('  intended, review it and re-accept with `node scripts/check-uws-binaries.js --update`.');
		process.exit(1);
	}

	console.log(`  OK - the installed tree is the accepted tree, byte for byte.`);
}

// Importable for its own test suite; only the CLI invocation touches the disk.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
