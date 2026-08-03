// Every bundled plugin publish must declare its sequence authority, because
// the cluster sequence guard on platform.publish/publishWire refuses an
// implicit per-worker counter in any multi-worker runtime. This is the static
// tripwire for the regression where the guard landed on the primitives while
// the plugins passed no options - which made cursor, presence, groups and
// replay throw on every broadcast in a cluster. The real-cluster proof lives
// in test/cluster-sequence-policy-real.test.js (group-roundtrip and
// replay-create probes); this scan is what catches a NEW plugin publish site
// added without a declaration, before it ever reaches a clustered runtime.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginsDir = fileURLToPath(new URL('../src/plugins', import.meta.url));

/**
 * Blank out comments so documentation examples do not read as call sites.
 * Newlines are preserved so reported line numbers stay real.
 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/^\s*\/\/[^\n]*/gm, (line) => line.replace(/[^\n]/g, ' '));
}

/** Extract every platform.publish / platform.publishWire call with its argument text. */
function publishCallSites(rawSource, file) {
	const source = stripComments(rawSource);
	const sites = [];
	const pattern = /platform\.(publish|publishWire)\(/g;
	for (const match of source.matchAll(pattern)) {
		// Balance parentheses from the call open, so multi-line calls are
		// captured whole.
		let depth = 0;
		let end = -1;
		for (let i = match.index + match[0].length - 1; i < source.length; i++) {
			if (source[i] === '(') depth++;
			else if (source[i] === ')' && --depth === 0) { end = i; break; }
		}
		expect(end, `${file}: unbalanced call at index ${match.index}`).toBeGreaterThan(-1);
		sites.push({
			file,
			call: source.slice(match.index, end + 1),
			line: source.slice(0, match.index).split('\n').length
		});
	}
	return sites;
}

describe('bundled plugin publishes declare cluster sequence authority', () => {
	it('every plugin publish site passes seq authority or forwards caller options', () => {
		const failures = [];
		for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const serverPath = path.join(pluginsDir, entry.name, 'server.js');
			let source;
			try { source = readFileSync(serverPath, 'utf8'); } catch { continue; }
			for (const site of publishCallSites(source, `src/plugins/${entry.name}/server.js`)) {
				const declaresSeq = /\bseq\s*:/.test(site.call);
				// A wrapper that relays the CALLER's options bag (channels
				// validation, throttle coalescing) is the caller's publish;
				// the app's own obligation is documented at the platform
				// surface and enforced by the runtime guard.
				const forwardsCallerOptions = /,\s*[\w$.]*[oO]ptions\s*\)$/.test(site.call);
				if (!declaresSeq && !forwardsCallerOptions) {
					failures.push(
						`${site.file}:${site.line} publishes without declaring sequence authority: ${site.call.replace(/\s+/g, ' ').slice(0, 120)}`
					);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it('the scan itself can fail', () => {
		// A guard that cannot fire is worse than no guard: prove the scanner
		// flags an undeclared publish and accepts the two legal shapes.
		const bad = "platform.publish(topic, event, data);";
		const badSites = publishCallSites(bad, 'synthetic');
		expect(badSites).toHaveLength(1);
		expect(/\bseq\s*:/.test(badSites[0].call)).toBe(false);
		const declared = "platform.publish(topic, event, data, { seq: false });";
		expect(/\bseq\s*:/.test(publishCallSites(declared, 'synthetic')[0].call)).toBe(true);
		for (const forwarded of [
			"platform.publish(topic, event, validated, options)",
			"platform.publish(topic, p.event, p.data, p.options)",
			"platform.publish(topic, event, data, publishOptions)",
		]) {
			expect(
				/,\s*[\w$.]*[oO]ptions\s*\)$/.test(publishCallSites(forwarded, 'synthetic')[0].call),
				forwarded
			).toBe(true);
		}
	});
});
