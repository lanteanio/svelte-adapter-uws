#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pack = path.join(root, 'docs', 'operations', 'v1');
const files = [
	'README.md',
	'failure-map.md',
	'process-and-deploy.md',
	'redis-outage.md',
	'resource-controls.md',
	'durable-work.md',
	'state-delivery.md',
	'coordinated-release.md',
	'drill.md'
];
const runbooks = files.slice(2, -1);
const requiredRunbookSections = [
	'## Trigger',
	'## Owner',
	'## Loss semantics',
	'## Abort criteria',
	'## Decision tree',
	'## Procedure',
	'## Recovery verification',
	'## Escalation and handoff'
];
const failures = [];

function read(relative) {
	const file = path.join(pack, relative);
	if (!fs.existsSync(file)) {
		failures.push(`missing ${path.relative(root, file)}`);
		return '';
	}
	return fs.readFileSync(file, 'utf8');
}

const contents = new Map(files.map((file) => [file, read(file)]));
const index = contents.get('README.md');
if (!/Operations pack version:\s*\*\*1\*\*/.test(index)) {
	failures.push('README.md must declare operations pack version 1');
}

for (const runbook of runbooks) {
	const source = contents.get(runbook);
	for (const heading of requiredRunbookSections) {
		if (!source.includes(heading)) failures.push(`${runbook} missing ${heading}`);
	}
}

const failureMap = contents.get('failure-map.md');
for (const runbook of runbooks) {
	if (!failureMap.includes(`./${runbook}`)) {
		failures.push(`failure-map.md does not route to ${runbook}`);
	}
}
if ((failureMap.match(/^\|[^\n]+\|$/gm) || []).length < 10) {
	failures.push('failure-map.md must retain at least eight failure rows plus its headers');
}

const drill = contents.get('drill.md');
for (const marker of ['## Automated corpus check', '## Human pass criteria', '## Scenario cards', '## Drill evidence']) {
	if (!drill.includes(marker)) failures.push(`drill.md missing ${marker}`);
}

const resourceControls = contents.get('resource-controls.md');
const compactResourceControls = resourceControls.replace(/\s+/g, ' ');
const expectedProtectionStates = [
	'admission-constrained',
	'posture-normal',
	'posture-elevated',
	'posture-siege',
	'backpressure',
	'host-pressure',
	'metrics-degraded',
	'redis-broken',
	'state-divergent',
	'client-degraded',
	'recovery-wave'
];
const protectionRows = [];
for (const line of resourceControls.split(/\r?\n/)) {
	const match = line.match(/^\|\s*`([a-z-]+)`\s*\|/);
	if (!match) continue;
	protectionRows.push(match[1]);
	const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
	if (cells.length !== 6 || cells.some((cell) => cell.length === 0)) {
		failures.push(`resource-controls.md matrix row ${match[1]} must fill all six decision columns`);
	}
}
if (protectionRows.join(',') !== expectedProtectionStates.join(',')) {
	failures.push(`resource-controls.md matrix order must be ${expectedProtectionStates.join(' -> ')}`);
}
for (const marker of [
	'## Correlated overload plus Redis-latency drill',
	'`breaker.reset()`',
	'pin protection to `normal`',
	'bidirectional cross-instance publish/replay',
	'bounded jittered cohort',
	'two observation windows'
]) {
	if (!compactResourceControls.includes(marker)) failures.push(`resource-controls.md missing drill gate ${marker}`);
}
const compactDrill = drill.replace(/\s+/g, ' ');
for (const marker of [
	'### Card E: overload plus Redis latency',
	'fleet restart',
	'`breaker.reset()`',
	'one instance remains `probing`',
	'bounded jittered recovery cohort',
	'two observation windows'
]) {
	if (!compactDrill.includes(marker)) failures.push(`drill.md Card E missing ${marker}`);
}

const coordinated = contents.get('coordinated-release.md');
const expectedScenarios = new Map([
	['baseline', { current: 2, minimum: 2, client: 2, policy: 'notify', result: 'admitted' }],
	['range-expand', { current: 3, minimum: 2, client: 2, policy: 'notify', result: 'admitted' }],
	['client-cutover', { current: 3, minimum: 2, client: 3, policy: 'reject', result: 'admitted' }],
	['minimum-cutover', { current: 3, minimum: 3, client: 2, policy: 'reject', result: 'PROTOCOL_MISMATCH' }],
	['rollback', { current: 2, minimum: 2, client: 3, policy: 'reject', result: 'PROTOCOL_MISMATCH' }]
]);
const matrixRows = new Map();
const matrixOrder = [];
for (const line of coordinated.split(/\r?\n/)) {
	const match = line.match(/^\|\s*([a-z-]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(notify|reject)\s*\|\s*(admitted|PROTOCOL_MISMATCH)\s*\|$/);
	if (!match) continue;
	const [, id, currentRaw, minimumRaw, clientRaw, policy, result] = match;
	matrixOrder.push(id);
	matrixRows.set(id, {
		current: Number(currentRaw),
		minimum: Number(minimumRaw),
		client: Number(clientRaw),
		policy,
		result
	});
}
const expectedOrder = [...expectedScenarios.keys()];
if (matrixOrder.join(',') !== expectedOrder.join(',')) {
	failures.push(`coordinated-release.md matrix order must be ${expectedOrder.join(' -> ')}`);
}
for (const [id, expected] of expectedScenarios) {
	const row = matrixRows.get(id);
	if (!row) {
		failures.push(`coordinated-release.md missing executable matrix row ${id}`);
		continue;
	}
	for (const field of ['current', 'minimum', 'client', 'policy', 'result']) {
		if (row[field] !== expected[field]) {
			failures.push(`coordinated-release.md matrix row ${id} has unsafe ${field}; expected ${expected[field]}`);
		}
	}
	const inside = row.client >= row.minimum && row.client <= row.current;
	if ((row.result === 'admitted') !== inside) {
		failures.push(`coordinated-release.md matrix row ${id} contradicts its inclusive range`);
	}
	if (!inside && row.policy !== 'reject') {
		failures.push(`coordinated-release.md matrix row ${id} cannot contain mismatch under notify`);
	}
}
if (!coordinated.includes('missing-advertisement') || !coordinated.includes('PROTOCOL_MISMATCH')) {
	failures.push('coordinated-release.md must retain the missing-advertisement typed rejection');
}

for (const [relative, source] of contents) {
	if (/\bRT-\d+\b/.test(source)) failures.push(`${relative} leaks an internal task id`);
	for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const target = match[1].trim();
		if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
		const clean = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0]);
		const resolved = path.resolve(pack, path.dirname(relative), clean);
		if (!fs.existsSync(resolved)) {
			failures.push(`${relative} has missing local link ${target}`);
		}
	}
}

if (failures.length) {
	console.error('operations pack v1: FAIL');
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(`operations pack v1: PASS (${files.length} files, ${runbooks.length} decision runbooks, local links verified)`);
