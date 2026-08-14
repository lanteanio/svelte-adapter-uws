// Generated artifacts are compared against the tree on CONTENT, not byte for
// byte.
//
// The repository is developed on Windows, and before `.gitattributes` forced
// LF checkouts, `core.autocrlf=true` materialised every committed text file
// with CRLF while every generator here emits LF. Seven gates compared the two
// directly and therefore failed on a clean checkout before anything had been
// edited - and `--write` could not fix it, because the next checkout restored
// the CRLF. The failure read as "generated documentation is stale", which
// sends the reader looking for a content drift that does not exist. The
// attributes file removes the CRLF checkout, but a clone predating it (or a
// tree materialised by other tooling) can still hold CRLF working copies, so
// these guards stay.
//
// The cases below reach five of the seven. The other two - check-entry-points
// and check-uws-pin - normalise at the read inside `main()`, so there is no
// exported comparison to hand a CRLF string to; what pins those is the chain
// itself running green against a fully-CRLF tree.
//
// Nothing caught it because the whole suite runs on working copies whose files
// the tools have already rewritten as LF. These cases supply the CRLF form
// explicitly rather than depending on how the tree happens to be checked out.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatedContentMatches } from '../scripts/generate-error-reference.js';
import { validateReadme } from '../scripts/check-documentation-contract.js';
import { loadSvelte4Profile, validateSvelte4Profile } from '../scripts/check-svelte-support.js';
import {
	COMPATIBILITY_START,
	COMPATIBILITY_END,
	normalizeGeneratedText,
	replaceCompatibilityBlock
} from '../scripts/check-compatibility.js';
import { RELATED_PROJECTS_END, validateRelatedProjects } from '../scripts/check-related-projects.js';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

/** The CRLF form a Windows checkout produces, whatever the working copy holds. */
function asCrlf(text) {
	return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/** The LF form a generator emits. */
function asLf(text) {
	return text.replace(/\r\n/g, '\n');
}

describe('generated artifacts survive a CRLF checkout', () => {
	it('matches a CRLF file against LF generator output in either direction', () => {
		const generated = 'line one\nline two\n';
		expect(generatedContentMatches(asCrlf(generated), generated)).toBe(true);
		expect(generatedContentMatches(generated, asCrlf(generated))).toBe(true);
		expect(generatedContentMatches(asCrlf(generated), asCrlf(generated))).toBe(true);
	});

	it('still reports a real content drift, whatever the line endings are', () => {
		// The guard must not be a way of passing everything: a changed WORD has to
		// fail from both forms, or normalising would have replaced one silent gate
		// with another.
		const generated = 'line one\nline two\n';
		const drifted = 'line one\nline three\n';
		expect(generatedContentMatches(asCrlf(drifted), generated)).toBe(false);
		expect(generatedContentMatches(asLf(drifted), generated)).toBe(false);
	});

	it('does not report a CRLF README as stale when its compatibility block is current', () => {
		// The exact shape of the reported defect: the rendered block is LF and the
		// file around it is CRLF, so splicing one into the other differs in nothing
		// but line endings.
		const crlfReadme = asCrlf(readme);
		const block = readme.slice(
			readme.indexOf(COMPATIBILITY_START),
			readme.indexOf(COMPATIBILITY_END) + COMPATIBILITY_END.length
		);
		const spliced = replaceCompatibilityBlock(crlfReadme, asLf(block));
		expect(spliced).not.toBe(crlfReadme);
		expect(normalizeGeneratedText(spliced)).toBe(normalizeGeneratedText(crlfReadme));
	});

	it('reaches the same documentation-contract verdict in either form', () => {
		// This one returned TWO errors on a CRLF checkout from a single cause -
		// the block read as stale AND as out of position - because it locates both
		// by literal newline anchors. Whatever it decides, it must decide the same
		// thing for a tree checked out either way.
		const manifest = JSON.parse(
			readFileSync(fileURLToPath(new URL('../docs/documentation.v1.json', import.meta.url)), 'utf8')
		);
		expect(validateReadme(asCrlf(readme), manifest)).toEqual(validateReadme(asLf(readme), manifest));
	});

	it('reaches the same Svelte-support verdict in either form', () => {
		// The rendered block is matched into the README with `includes`, which a
		// CRLF copy fails outright however current the block is.
		// Built by the script's own loader rather than assembled here: a
		// hand-rolled profile omits fields the validator reads and fails for a
		// reason that has nothing to do with line endings.
		const profile = loadSvelte4Profile();
		const workflow = readFileSync(
			fileURLToPath(new URL('../.github/workflows/test.yml', import.meta.url)), 'utf8'
		);
		const stale = 'README Svelte support block is stale';
		const fromCrlf = validateSvelte4Profile(profile, asCrlf(readme), workflow).filter((e) => e.includes(stale));
		const fromLf = validateSvelte4Profile(profile, asLf(readme), workflow).filter((e) => e.includes(stale));
		expect(fromCrlf).toEqual(fromLf);
		expect(fromLf).toEqual([]);
	});

	it('reaches the same related-projects verdict in either form', () => {
		// Same shape as the compatibility block: rendered with LF, compared against
		// a slice of the README, so a CRLF checkout differed in nothing but line
		// endings. Sibling manifests are left out deliberately - omitting both is
		// the supported call, and it renders the same block from the defaults.
		const stale = 'README related-projects block is stale';
		const staleOnly = (source) =>
			validateRelatedProjects({ readme: source }).filter((error) => error.includes(stale));
		expect(staleOnly(asCrlf(readme))).toEqual(staleOnly(asLf(readme)));
		expect(staleOnly(asLf(readme))).toEqual([]);

		// And it must still be able to say stale, from either form - normalising a
		// comparison is one edit away from disabling it.
		const drifted = readme.replace(RELATED_PROJECTS_END, 'an extra line\n' + RELATED_PROJECTS_END);
		expect(staleOnly(asCrlf(drifted))).toEqual([stale +
			'; regenerate it from sibling manifest descriptions']);
		expect(staleOnly(asLf(drifted))).toEqual([stale +
			'; regenerate it from sibling manifest descriptions']);
	});

	it('reaches the same verdict for a working copy in either form', () => {
		// The property that actually matters, stated over the real README rather
		// than a literal: what these gates decide must not depend on how the tree
		// was checked out. An assertion that the working copy IS LF would be the
		// same coupling wearing the opposite sign - and would fail on precisely
		// the clean Windows checkout this exists to support.
		const block = readme.slice(
			readme.indexOf(COMPATIBILITY_START),
			readme.indexOf(COMPATIBILITY_END) + COMPATIBILITY_END.length
		);
		const verdict = (source) => normalizeGeneratedText(
			replaceCompatibilityBlock(source, asLf(block))
		) === normalizeGeneratedText(source);
		expect(verdict(asCrlf(readme))).toBe(verdict(asLf(readme)));
	});
});
