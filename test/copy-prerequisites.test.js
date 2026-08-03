import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function between(start, end) {
	const from = README.indexOf(start);
	const to = README.indexOf(end, from + start.length);
	expect(from, start).toBeGreaterThanOrEqual(0);
	expect(to, end).toBeGreaterThan(from);
	return README.slice(from, to);
}

function proseUnits(markdown) {
	let fenced = false;
	const visible = [];
	for (const line of markdown.split(/\r?\n/)) {
		if (/^```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) visible.push(line);
	}
	return visible
		.join('\n')
		.split(/\n\s*\n/)
		.flatMap((block) => /^\s*[-*] /.test(block) ? block.split('\n') : [block])
		.map((unit) => unit.trim())
		.filter(Boolean);
}

const ABSOLUTE = /\b(?:always|never|automatic(?:ally)?|guaranteed?|guarantees?|secure|zero-config|no configuration(?: is)? needed|exactly-once|just)\b/i;
// An assurance sentence is bounded only by an explicit conditional or scoping
// STRUCTURE in the same sentence: a subordinating conjunction, a scope
// preposition with an object, or an explicit dependency phrase. Bare topic
// words (transport, tls, set, not, ...) deliberately do not count - a word
// list that broad made the previous detector pass every retired phrase.
const SENTENCE_SCOPE = new RegExp(
	'\\b(?:if|when|whenever|where|while|unless|until|(?<!-)once|provided(?: that)?|as long as|so long as|only)\\b' +
	'|\\b(?:within|inside|per|during|under)\\b\\s+\\S' +
	'|\\bdepends? on\\b|\\bsubject to\\b|\\bexcept\\b',
	'i'
);

function sentences(unit) {
	return unit
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

// "not durable, cluster-coherent, or exactly-once" is a disclaimer, not an
// assurance: an absolute word within a few tokens of a preceding negator does
// not need its own scope clause.
const NEGATED_TAIL = /\b(?:not|no|nor|cannot|can't|isn't|aren't|doesn't|don't|won't|without)\b(?:\s+[A-Za-z0-9`$_-]+[,;]?){0,4}\s*$/i;

function sentenceHasUnboundedAbsolute(sentence) {
	if (SENTENCE_SCOPE.test(sentence)) return false;
	const absolutes = new RegExp(ABSOLUTE.source, 'gi');
	let match;
	while ((match = absolutes.exec(sentence)) !== null) {
		if (!NEGATED_TAIL.test(sentence.slice(0, match.index))) return true;
	}
	return false;
}

function unboundedUnits(markdown) {
	return proseUnits(markdown).filter((unit) => sentences(unit).some(sentenceHasUnboundedAbsolute));
}

describe('consequential copy keeps prerequisites beside assurances', () => {
	it('makes the absolute-word detector non-vacuous and recognizes a bounded statement', () => {
		expect(unboundedUnits('WebSockets are always secure.')).toEqual(['WebSockets are always secure.']);
		expect(unboundedUnits('When TLS is enabled, WSS secures transport only; authentication is separate.')).toEqual([]);
	});

	it('catches the retired assurance shapes the previous word-presence detector let through', () => {
		for (const unbounded of [
			'- **Zero-config WebSocket** - set `websocket: true` and go',
			'Your data is always secure and requires no thought.',
			'Dedup guarantees exactly-once execution, no configuration needed, transport included.',
			'The client store automatically uses `wss://` on HTTPS pages - no configuration needed.',
			'Mutations must always execute.'
		]) {
			expect(unboundedUnits(unbounded), unbounded).toHaveLength(1);
		}
		for (const bounded of [
			'Side effects run once per id while an entry remains within its TTL.',
			'When both `SSL_CERT` and `SSL_KEY` are set, the upgrade always uses the TLS listener.'
		]) {
			expect(unboundedUnits(bounded), bounded).toEqual([]);
		}
	});

	it('requires the scope clause in the same sentence as the assurance', () => {
		expect(unboundedUnits('Delivery is guaranteed. This holds when the socket stays open.'))
			.toEqual(['Delivery is guaranteed. This holds when the socket stays open.']);
		expect(unboundedUnits('Delivery is guaranteed while the socket stays open. The buffer is bounded.'))
			.toEqual([]);
	});

	it('finds no unbounded absolute in the onboarding and dedup decision surfaces', () => {
		const scope = [
			between('## What you get', '**Upgrading?**'),
			between('## Quick start: WebSocket', '**Configuration**'),
			between('### Dedup (idempotency window)', '### Presence'),
			between('### SSR request deduplication', '### The bottom line')
		].join('\n\n');

		expect(unboundedUnits(scope)).toEqual([]);
	});

	it('keeps the WebSocket prerequisite and default-open boundary in its setup unit', () => {
		const step = between('### Step 1: Enable WebSocket', '### Step 2: Add the Vite plugin');
		expect(step).toContain('with no authentication');
		expect(step).toMatch(/Complete the required Vite step\s+below/);
		expect(step).toMatch(/add the policy described under \[Authentication\]/);
	});

	it('keeps the WebSocket quick-start promise aligned with every numbered step', () => {
		const quickStart = between('## Quick start: WebSocket', '## Quick start: WSS');
		const promise = quickStart.slice(0, quickStart.indexOf('### Step 1:'));
		const promisedSteps = [...promise.matchAll(/^\d+\. \*\*/gm)];
		const stepHeadings = [...quickStart.matchAll(/^### Step (\d+):/gm)];

		expect(promise).toContain('Four things to do:');
		expect(promisedSteps).toHaveLength(4);
		expect(stepHeadings.map((match) => Number(match[1]))).toEqual([1, 2, 3, 4]);
		expect(promisedSteps).toHaveLength(stepHeadings.length);
	});

	it('keeps every cross-section reference to the quick-start step count accurate', () => {
		const quickStart = between('## Quick start: WebSocket', '## Quick start: WSS');
		const stepCount = [...quickStart.matchAll(/^### Step (\d+):/gm)].length;
		const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
		const references = [...README.matchAll(/all\s+([a-z0-9]+)\s+WebSocket quick-start steps/gi)];

		expect(stepCount).toBeGreaterThan(0);
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			const word = reference[1].toLowerCase();
			const value = numberWords[word] ?? Number(word);
			expect(value, reference[0]).toBe(stepCount);
		}
	});

	it('describes capacity defaults by their failure behavior rather than labeling users', () => {
		const caps = between('**Plugin caps**', 'The `webhooks` row');
		expect(caps).toContain('finite defaults and fail by refusing work or evicting bounded state');
		expect(README.toLowerCase()).not.toContain('idiot-proof');
	});

	it('names TLS separately from authentication and authorization before WSS convenience', () => {
		const wss = between('## Quick start: WSS (TLS-encrypted WebSocket)', '## Development, Preview & Production');
		const boundary = wss.indexOf('WSS encrypts the WebSocket transport');
		const convenience = wss.indexOf('the client store selects `wss://`');

		expect(boundary).toBeGreaterThanOrEqual(0);
		expect(boundary).toBeLessThan(convenience);
		expect(wss).toContain('it does not authenticate a client');
		expect(wss).toContain('authorize a topic');
		expect(wss).toContain('set both `SSL_CERT` and `SSL_KEY`');
	});

	it('puts process/window/capacity limits before the dedup use case', () => {
		const dedup = between('### Dedup (idempotency window)', '#### Setup');
		const prerequisite = dedup.indexOf('Within one process, while an entry remains inside its fixed TTL and capacity');
		const use = dedup.indexOf('suited to bounded retry suppression');

		expect(prerequisite).toBeGreaterThanOrEqual(0);
		expect(prerequisite).toBeLessThan(use);
		expect(dedup).toContain('not durable, cluster-coherent, or exactly-once');
	});

	it('keeps the retired absolute convenience phrases out of public copy', () => {
		for (const phrase of [
			'Zero-config WebSocket',
			'Quick start: WSS (secure WebSocket)',
			"That's it. This gives you",
			'production, everything works',
			'This is the real deal',
			'No configuration is needed',
			'charge a card once',
			'side effects only run once per id within ttl'
		]) {
			expect(README.toLowerCase(), phrase).not.toContain(phrase.toLowerCase());
		}
	});
});
