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
