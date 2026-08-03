#!/usr/bin/env node
// The contributor map must describe the repository that exists.
//
// CONTRIBUTING.md carries three inventories a contributor navigates by: the
// gates in `npm run check`, the jobs the hosted workflow runs, and the npm
// lanes it tells people to run. All three were hand-maintained prose, and all
// three went stale inside the very batch that wrote them - the gate list
// described 11 of 24 gates under a heading reading as the complete list, two
// newly added CI jobs went undocumented while the file still promised
// `verify:pr` was "exactly the hosted lanes", and a third "eight static gates"
// claim survived an edit that corrected the same count twice elsewhere.
//
// Prose cannot be trusted to track a list the tree already defines, so this
// gate derives each inventory from its real source and fails on the delta. It
// is the reason the map can be relied on rather than merely written carefully.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Gate script basenames chained in `npm run check`, in order. */
export function gatesInCheck(checkScript) {
	return [...checkScript.matchAll(/scripts\/([a-z0-9-]+)\.js/g)].map((match) => match[1]);
}

/** Gate names the contributor map documents, from its bullet list. */
export function documentedGates(contributing) {
	return [...contributing.matchAll(/^- \*\*((?:check|generate)-[a-z0-9-]+)(?: --check)?\*\*/gm)].map((match) => match[1]);
}

/**
 * Every `npm run <name>` the contributor map tells a reader to run IN THIS
 * REPOSITORY.
 *
 * The documentation section sends a contributor to a sibling repository's own
 * checkout and names that repository's lanes, which this package legitimately
 * does not define. Scope is therefore per paragraph: a paragraph that names a
 * sibling repository is describing that checkout, not this one.
 */
export function referencedLanes(contributing) {
	const lanes = new Set();
	for (const paragraph of contributing.split(/\n\s*\n/)) {
		if (/svelte-realtime|svelte-adapter-uws-extensions|its own checkout/.test(paragraph)) continue;
		for (const match of paragraph.matchAll(/npm run ([a-z0-9:-]+)/g)) lanes.add(match[1]);
	}
	return [...lanes];
}

/**
 * The lanes `npm run verify:pr` actually chains, expanded through package.json
 * rather than read from prose.
 */
export function verifyPrLanes(scripts) {
	const seen = new Set();
	const walk = (name) => {
		for (const match of (scripts[name] ?? '').matchAll(/npm run ([a-z0-9:-]+)/g)) {
			if (seen.has(match[1])) continue;
			seen.add(match[1]);
			walk(match[1]);
		}
	};
	walk('verify:pr');
	return [...seen];
}

/**
 * The lanes of THIS package that the hosted workflow runs.
 *
 * A step carrying a `working-directory` runs another package's scripts - the
 * support-floor job runs `npm run check`, `build` and `smoke` inside the locked
 * Svelte 4 application, and counting those as this repository's lanes would
 * report a difference that does not exist.
 */
export function hostedLanes(workflow) {
	const lanes = new Set();
	for (const job of Object.values(workflow.jobs ?? {})) {
		for (const step of job.steps ?? []) {
			if (typeof step.run !== 'string' || step['working-directory']) continue;
			for (const match of step.run.matchAll(/npm run ([a-z0-9:-]+)/g)) lanes.add(match[1]);
		}
	}
	return [...lanes];
}

export function findProblems({ contributing, pkg, workflow }) {
	const problems = [];

	const gates = gatesInCheck(pkg.scripts?.check ?? '');
	if (gates.length === 0) problems.push('could not read any gate out of the check script');
	const documented = new Set(documentedGates(contributing));
	for (const gate of gates) {
		if (!documented.has(gate)) {
			problems.push(`gate ${gate} runs in npm run check but the contributor map does not document it`);
		}
	}
	for (const name of documented) {
		if (!gates.includes(name)) {
			problems.push(`the contributor map documents ${name}, which npm run check does not run`);
		}
	}

	// A hardcoded count is the shape that went stale three times. Any numeric
	// claim about the gates has to agree with the chain.
	const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
		'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
		'nineteen', 'twenty'];
	for (const match of contributing.matchAll(/\b([a-z]+|\d+)[- ](?:static |dependency-free )?gates\b/gi)) {
		const raw = match[1].toLowerCase();
		const value = /^\d+$/.test(raw) ? Number(raw) : words.indexOf(raw);
		if (value === -1 || value === undefined) continue;
		if (value !== gates.length) {
			problems.push(`the contributor map says "${match[0]}" but npm run check chains ${gates.length}`);
		}
	}

	const jobs = Object.keys(workflow.jobs ?? {});
	if (jobs.length === 0) problems.push('could not read any job out of the test workflow');
	for (const job of jobs) {
		if (!contributing.includes(job)) {
			problems.push(`the test workflow runs job ${job} but the contributor map never names it`);
		}
	}

	const scripts = pkg.scripts ?? {};

	// The map called `verify:pr` the hosted-gate equivalent in its preamble and
	// its lane table while the inventory three paragraphs below correctly said
	// the opposite. Two prose claims on one page cannot be trusted to agree, so
	// the equivalence is settled against the two real lists instead.
	const prLanes = new Set(verifyPrLanes(scripts));
	const hosted = new Set(hostedLanes(workflow));
	const localOnly = [...prLanes].filter((lane) => !hosted.has(lane));
	const hostedOnly = [...hosted].filter((lane) => !prLanes.has(lane));
	if (localOnly.length > 0 || hostedOnly.length > 0) {
		const delta = `verify:pr runs ${localOnly.join(', ') || 'nothing'} that the workflow does not, ` +
			`and the workflow runs ${hostedOnly.join(', ') || 'nothing'} that verify:pr does not`;
		// Blocklisting the phrasings that already went stale, so they cannot
		// return...
		for (const claim of [
			/hosted[- ]gate equivalent/i,
			/`npm run verify:pr` is exactly/i,
			/local equivalent of an accepted pull request/i
		]) {
			const found = contributing.match(claim);
			if (found) problems.push(`the contributor map still says "${found[0].trim()}", but ${delta}`);
		}
		// ...and requiring the disclaimer outright, because a blocklist only
		// catches wording someone already wrote. This half fails on a NEW way of
		// claiming the same wrong thing, which the blocklist above cannot.
		if (!/verify:pr`? is not the hosted gate/i.test(contributing)) {
			problems.push(
				`the contributor map never states that verify:pr is not the hosted gate, but ${delta}`
			);
		}
	}

	for (const lane of referencedLanes(contributing)) {
		if (!(lane in scripts)) {
			problems.push(`the contributor map tells a reader to run npm run ${lane}, which package.json does not define`);
		}
	}

	return { problems, gateCount: gates.length, jobCount: jobs.length };
}

function main() {
	const contributing = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const workflow = parse(readFileSync(resolve(root, '.github', 'workflows', 'test.yml'), 'utf8'));
	const { problems, gateCount, jobCount } = findProblems({ contributing, pkg, workflow });
	if (problems.length > 0) throw new Error(problems.join('\n- '));
	console.log(`check-contributor-map: ${gateCount} gates and ${jobCount} hosted jobs are documented`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-contributor-map failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
