import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageFiles } from '../scripts/check-links.js';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { createDiagnostic } from '../src/runtime/diagnostic.js';
import { WAITING_ROOM_TEMPLATE_TOKENS } from '../src/runtime/utils/waiting-room-template.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const contract = read('docs/translating.md');
const registry = JSON.parse(read('docs/messages.v1.json'));
const packageJson = JSON.parse(read('package.json'));
const readme = read('README.md');
const surface = (id) => registry.surfaces.find((candidate) => candidate.id === id);

function partitionErrors(entry, actualFields) {
	const categories = [
		...(entry.machineFields || []),
		...(entry.humanFields || []),
		...(entry.contextFields || [])
	];
	const counts = new Map();
	for (const field of categories) counts.set(field, (counts.get(field) || 0) + 1);
	const actual = new Set(actualFields);
	const errors = [];
	for (const field of actual) {
		if (!counts.has(field)) errors.push('missing:' + field);
		else if (counts.get(field) !== 1) errors.push('duplicate:' + field);
	}
	for (const field of counts.keys()) {
		if (!actual.has(field)) errors.push('extra:' + field);
	}
	return errors.sort();
}

describe('ecosystem translation contract', () => {
	it('ships one reachable source-locale contract and its registry', () => {
		// The contract lives under docs/, which the docs entry publishes.
		expect(packageJson.files).toContain('docs');
		expect(packageFiles()).toContain('docs/translating.md');
		expect(packageFiles()).toContain('docs/messages.v1.json');
		expect(readme).toContain('[translation contract](./docs/translating.md)');
		expect(registry.schemaVersion).toBe(1);
		expect(registry.sourceLocale).toBe('en');
		expect(registry.catalogOwner).toBe('application');
		expect(registry.defaultTextPolicy).toBe('english-diagnostic-fallback');
	});

	it('covers every ecosystem owner with unique, fully classified surfaces', () => {
		const ids = registry.surfaces.map(({ id }) => id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			'structured-diagnostic',
			'adapter-error-reference',
			'subscription-denial',
			'connection-failure',
			'waiting-room',
			'protocol-and-telemetry',
			'application-payload'
		]);
		const owners = new Set(registry.surfaces.flatMap(({ sourcePackages }) => sourcePackages));
		expect(owners).toEqual(new Set([
			'svelte-adapter-uws',
			'svelte-realtime',
			'svelte-adapter-uws-extensions',
			'application'
		]));
		for (const entry of registry.surfaces) {
			expect(['machine', 'diagnostic', 'mixed', 'application-ui']).toContain(entry.classification);
			expect(entry.machineFields.length).toBeGreaterThan(0);
			expect(entry.humanFields.length).toBeGreaterThan(0);
			expect(entry.translationOwner).toBe('application');
			expect(entry.rule).toMatch(/\S/);
		}
	});

	it('separates structured diagnostic routing from human text', () => {
		const diagnostic = createDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.listener',
			event: 'runtime.listen.failed',
			severity: 'fatal',
			message: 'Could not bind',
			dataClass: 'operational'
		});
		const entry = surface('structured-diagnostic');
		expect(entry.machineFields).toEqual([
			'schemaVersion',
			'occurredAt',
			'source',
			'component',
			'event',
			'severity',
			'level',
			'dataClass'
		]);
		expect(entry.humanFields).toEqual(['message']);
		expect(entry.contextFields).toEqual(['attributes']);
		expect(partitionErrors(entry, Object.keys(diagnostic))).toEqual([]);
		expect(partitionErrors(
			{ ...entry, machineFields: entry.machineFields.filter((field) => field !== 'event') },
			Object.keys(diagnostic)
		)).toContain('missing:event');
		expect(partitionErrors(
			{ ...entry, humanFields: [...entry.humanFields, 'invented'] },
			Object.keys(diagnostic)
		)).toContain('extra:invented');
		expect(contract).toContain('Do not render an \`Error.message\`, diagnostic \`message\`');
		expect(contract).toMatch(/Do not\s+match or alert on those strings\./);
	});

	it('classifies every adapter error registry field at its owning boundary', () => {
		const entry = surface('adapter-error-reference');
		const actualFields = [
			...new Set(ADAPTER_ERROR_REGISTRY.flatMap((error) => Object.keys(error)))
		];
		expect(entry.machineFields).toEqual([
			'id',
			'code',
			'event',
			'component',
			'severity',
			'sources',
			'anchor',
			'help'
		]);
		expect(entry.humanFields).toEqual([
			'problemPrefix',
			'messagePrefix',
			'cause',
			'consequence',
			'automaticRecovery',
			'nextAction'
		]);
		expect(partitionErrors(entry, actualFields)).toEqual([]);
		for (const error of ADAPTER_ERROR_REGISTRY) {
			expect(error.id).toMatch(/^ADAPTER-ERR-/);
			expect(error.event).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/);
			for (const field of entry.humanFields) {
				if (Object.hasOwn(error, field)) {
					expect(error[field] === null || /\S/.test(error[field])).toBe(true);
				}
			}
		}
		expect(partitionErrors(
			{ ...entry, humanFields: entry.humanFields.filter((field) => field !== 'cause') },
			actualFields
		)).toContain('missing:cause');
		expect(partitionErrors(
			{ ...entry, machineFields: [...entry.machineFields, 'messagePrefix'] },
			actualFields
		)).toContain('duplicate:messagePrefix');
	});

	it('locks declared-code, placeholder, and bidi laws without promoting free text', () => {
		const denial = surface('subscription-denial');
		const failure = surface('connection-failure');
		const waitingRoom = surface('waiting-room');
		expect(denial.machineFields).toContain('SubscribeDenialReason');
		expect(denial.humanFields).toContain('custom reason');
		expect(failure.humanFields).toEqual(['reason']);
		expect(failure.machineFields).not.toContain('reason');
		expect(waitingRoom.machineFields).toEqual([
			'lang',
			'dir',
			...WAITING_ROOM_TEMPLATE_TOKENS.map((token) => `{{${token}}}`)
		]);
		expect(contract).toContain('FIRST STRONG ISOLATE (U+2068)');
		expect(contract).toMatch(/POP\s+DIRECTIONAL ISOLATE \(U\+2069\)/);
		expect(contract).toContain('HTML escaping and bidirectional isolation solve different problems');
	});
});
