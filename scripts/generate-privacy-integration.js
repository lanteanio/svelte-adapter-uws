#!/usr/bin/env node
/**
 * Validate the ecosystem privacy manifest and render the deployer guide and
 * host-fillable RoPA/DPA/transfer worksheet.
 *
 * Usage:
 *   node scripts/generate-privacy-integration.js
 *   node scripts/generate-privacy-integration.js --check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = resolve(root, 'docs/privacy/v1/data-flow-retention.json');
export const guidePath = resolve(root, 'docs/privacy-integration.md');
export const checklistPath = resolve(root, 'docs/privacy/v1/ropa-dpa-transfer-checklist.md');

const EXPECTED_PACKAGES = [
	'svelte-adapter-uws',
	'svelte-adapter-uws-extensions',
	'svelte-realtime'
];
const REQUIRED_ACTIVITY_IDS = [
	'http-and-websocket-transit',
	'browser-connection-resume',
	'adapter-in-process-replay',
	'adapter-session-and-dedup',
	'browser-offline-mutation-queue',
	'development-inspection',
	'realtime-in-process-state-and-erasure',
	'durable-replay',
	'durable-idempotency',
	'durable-dead-letters',
	'durable-tasks-jobs-and-alarms',
	'cluster-ephemeral-state',
	'logs-metrics-and-traces',
	'application-and-backup-copies'
];
const ERASURE_MODES = new Set(['explicit', 'configured', 'host-owned']);
const REQUIRED_ACTIVITY_FIELDS = [
	'purpose', 'data', 'subjects', 'storage', 'defaultRetention', 'controls',
	'erasure', 'hostActions', 'transfer', 'sources'
];

function presentString(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function stringList(value) {
	return Array.isArray(value) && value.length > 0 && value.every(presentString);
}

/** Load the canonical manifest from disk. */
export function loadManifest() {
	return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * Validate the manifest as a deployer contract, not merely syntactically.
 * Each activity has to state actual retention, a deletion limitation, a host
 * action, transfer posture, and implementation evidence. This rejects the
 * dangerous "covered by forget" shorthand that prompted this contract.
 */
export function validateManifest(manifest) {
	const errors = [];
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return ['manifest must be an object'];
	}
	if (manifest.schemaVersion !== 'privacy-data-flow-retention/v1') {
		errors.push('schemaVersion must be privacy-data-flow-retention/v1');
	}
	if (manifest.contractVersion !== 1) errors.push('contractVersion must be 1');
	if (!presentString(manifest.scope)) errors.push('scope must be a non-empty string');

	const packageNames = Array.isArray(manifest.packages)
		? manifest.packages.map((item) => item?.name).sort()
		: [];
	if (JSON.stringify(packageNames) !== JSON.stringify(EXPECTED_PACKAGES)) {
		errors.push(`packages must contain exactly: ${EXPECTED_PACKAGES.join(', ')}`);
	}
	for (const item of manifest.packages || []) {
		if (!presentString(item?.role)) errors.push(`package ${item?.name || '<unknown>'} needs a role`);
		if (!presentString(item?.repository) || !item.repository.startsWith('https://github.com/lanteanio/')) {
			errors.push(`package ${item?.name || '<unknown>'} needs an official repository URL`);
		}
	}

	const responsibilityKeys = ['ecosystem', 'deployer', 'infrastructureProvider'];
	for (const key of responsibilityKeys) {
		if (!presentString(manifest.responsibilityModel?.[key])) errors.push(`responsibilityModel.${key} is required`);
	}
	const erasureKeys = ['coordinator', 'covered', 'notCovered', 'completionRule'];
	for (const key of erasureKeys) {
		if (!presentString(manifest.erasureBoundary?.[key])) errors.push(`erasureBoundary.${key} is required`);
	}
	if (!/Do not report erasure complete/i.test(manifest.erasureBoundary?.completionRule || '')) {
		errors.push('erasureBoundary.completionRule must prohibit premature completion');
	}

	if (!Array.isArray(manifest.activities) || manifest.activities.length < 12) {
		errors.push('activities must contain at least 12 ecosystem processing activities');
		return errors;
	}
	const ids = new Set();
	const coveredPackages = new Set();
	for (const [index, activity] of manifest.activities.entries()) {
		const at = `activities[${index}]`;
		if (!presentString(activity?.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(activity.id)) {
			errors.push(`${at}.id must be a kebab-case identifier`);
		} else if (ids.has(activity.id)) {
			errors.push(`${at}.id duplicates ${activity.id}`);
		} else {
			ids.add(activity.id);
		}
		for (const field of REQUIRED_ACTIVITY_FIELDS) {
			if (activity?.[field] === undefined || activity[field] === null) errors.push(`${at}.${field} is required`);
		}
		if (!stringList(activity?.packages)) errors.push(`${at}.packages must be a non-empty string list`);
		for (const name of activity?.packages || []) {
			coveredPackages.add(name);
			if (!EXPECTED_PACKAGES.includes(name)) errors.push(`${at}.packages contains unknown package ${name}`);
		}
		if (!presentString(activity?.purpose)) errors.push(`${at}.purpose must be non-empty`);
		if (!stringList(activity?.data)) errors.push(`${at}.data must identify data categories`);
		if (!stringList(activity?.subjects)) errors.push(`${at}.subjects must identify data subjects`);
		if (!presentString(activity?.storage)) errors.push(`${at}.storage must be non-empty`);
		if (!presentString(activity?.defaultRetention?.policy)) errors.push(`${at}.defaultRetention.policy is required`);
		if (typeof activity?.defaultRetention?.automatic !== 'boolean') errors.push(`${at}.defaultRetention.automatic must be boolean`);
		if (!presentString(activity?.defaultRetention?.limit)) errors.push(`${at}.defaultRetention.limit is required`);
		if (!stringList(activity?.controls)) errors.push(`${at}.controls must identify retention controls`);
		if (!ERASURE_MODES.has(activity?.erasure?.mode)) errors.push(`${at}.erasure.mode must be explicit, configured, or host-owned`);
		if (!presentString(activity?.erasure?.action)) errors.push(`${at}.erasure.action is required`);
		if (!presentString(activity?.erasure?.limitations)) errors.push(`${at}.erasure.limitations is required`);
		if (!stringList(activity?.hostActions)) errors.push(`${at}.hostActions must be a non-empty string list`);
		if (!presentString(activity?.transfer)) errors.push(`${at}.transfer must be non-empty`);
		if (!Array.isArray(activity?.sources) || activity.sources.length === 0) {
			errors.push(`${at}.sources must include implementation evidence`);
		} else {
			for (const [sourceIndex, source] of activity.sources.entries()) {
				if (!EXPECTED_PACKAGES.includes(source?.repository) || !presentString(source?.path)) {
					errors.push(`${at}.sources[${sourceIndex}] needs a known repository and path`);
				}
			}
		}
		if (activity?.defaultRetention?.automatic === false && !activity.hostActions?.some((item) => /set|define|clear|delete|register|extend|configure|document/i.test(item))) {
			errors.push(`${at} has no automatic time boundary and needs an actionable host retention/deletion step`);
		}
	}
	for (const name of EXPECTED_PACKAGES) {
		if (!coveredPackages.has(name)) errors.push(`activities do not cover ${name}`);
	}
	for (const id of REQUIRED_ACTIVITY_IDS) {
		if (!ids.has(id)) errors.push(`activities must include ${id}`);
	}
	return errors;
}

function escapeCell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function list(values) {
	return values.map((value) => `- ${value}`).join('\n');
}

function sourceLabel(source) {
	return `\`${source.repository}:${source.path}\``;
}

/** Render the shipped human integration guide. */
export function renderGuide(manifest) {
	const out = [];
	out.push('# Privacy integration contract');
	out.push('');
	out.push('<!-- GENERATED by scripts/generate-privacy-integration.js from docs/privacy/v1/data-flow-retention.json. -->');
	out.push('');
	out.push(`Contract: **${manifest.schemaVersion}** (revision ${manifest.contractVersion}).`);
	out.push('');
	out.push('This guide is an engineering inventory, not legal advice. It tells a deployer where');
	out.push('the three-package ecosystem can process or retain data, which defaults are unsafe');
	out.push('to treat as a retention deadline, and which deletion legs remain application-owned.');
	out.push('Copy the [host worksheet](./privacy/v1/ropa-dpa-transfer-checklist.md), fill every');
	out.push('placeholder, and have the result reviewed against the deployment and applicable law.');
	out.push('');
	out.push('The machine-readable source is');
	out.push('[`docs/privacy/v1/data-flow-retention.json`](./privacy/v1/data-flow-retention.json).');
	out.push('Generated output is checked in CI; change the manifest, then run');
	out.push('`npm run privacy:generate`.');
	out.push('');
	out.push('## Responsibility boundary');
	out.push('');
	out.push(`- **Ecosystem:** ${manifest.responsibilityModel.ecosystem}`);
	out.push(`- **Deployer:** ${manifest.responsibilityModel.deployer}`);
	out.push(`- **Infrastructure provider:** ${manifest.responsibilityModel.infrastructureProvider}`);
	out.push('');
	out.push('Installing these packages does not itself appoint the projects as a processor or');
	out.push('create a DPA. A hosted Redis, Postgres, log, metric, trace, backup, push, webhook,');
	out.push('or support provider may receive data and must be assessed by the deployer.');
	out.push('');
	out.push('## Erasure is a coordinated workflow');
	out.push('');
	out.push(`**Coordinator:** \`${manifest.erasureBoundary.coordinator}\`.`);
	out.push('');
	out.push(`**Covered:** ${manifest.erasureBoundary.covered}`);
	out.push('');
	out.push(`**Not covered:** ${manifest.erasureBoundary.notCovered}`);
	out.push('');
	out.push(`**Completion rule:** ${manifest.erasureBoundary.completionRule}`);
	out.push('');
	out.push('A capacity limit is not a retention deadline. “No TTL”, browser persistence, and');
	out.push('host-defined telemetry retention are called out below because eviction or eventual');
	out.push('overwrite cannot support a promised deletion time.');
	out.push('');
	out.push('## Processing and retention matrix');
	out.push('');
	out.push('| Activity | Packages | Data and storage | Default retention | Erasure boundary | Host action |');
	out.push('| --- | --- | --- | --- | --- | --- |');
	for (const activity of manifest.activities) {
		const retention = `${activity.defaultRetention.policy}. ${activity.defaultRetention.limit}`;
		const erasure = `${activity.erasure.action} Limitation: ${activity.erasure.limitations}`;
		out.push(`| \`${activity.id}\`<br>${escapeCell(activity.purpose)} | ${activity.packages.map((name) => `\`${name}\``).join('<br>')} | ${escapeCell(activity.data.join('; '))}<br><br>${escapeCell(activity.storage)} | ${escapeCell(retention)} | ${escapeCell(erasure)} | ${escapeCell(activity.hostActions.join(' '))} |`);
	}
	out.push('');
	out.push('## Activity details and evidence');
	out.push('');
	for (const activity of manifest.activities) {
		out.push(`### ${activity.id}`);
		out.push('');
		out.push(`**Subjects:** ${activity.subjects.join('; ')}.`);
		out.push('');
		out.push('**Retention controls:**');
		out.push('');
		out.push(list(activity.controls));
		out.push('');
		out.push(`**Transfer/recipient posture:** ${activity.transfer}`);
		out.push('');
		out.push(`**Implementation evidence:** ${activity.sources.map(sourceLabel).join(', ')}.`);
		out.push('');
	}
	out.push('## Minimum deployment gate');
	out.push('');
	out.push('Before production or before declaring an erasure complete:');
	out.push('');
	out.push('1. Map every enabled feature to the matrix and add application-specific activities.');
	out.push('2. Replace every no-TTL or host-defined default with a documented period or justified exception.');
	out.push('3. Configure identity extractors and durable `purgeUser` wiring before storing user data.');
	out.push('4. Cover browser storage, telemetry, downstream effects, replicas, exports, and backups.');
	out.push('5. Record processor/subprocessor, region, DPA, transfer mechanism, access, and deletion evidence.');
	out.push('6. Test partial failure: an erasure request remains incomplete until every required leg succeeds.');
	out.push('');
	return out.join('\n') + '\n';
}

/** Render a host-fillable RoPA, DPA, and transfer worksheet. */
export function renderChecklist(manifest) {
	const out = [];
	out.push('# Host privacy, RoPA, DPA, and transfer worksheet');
	out.push('');
	out.push('<!-- GENERATED TEMPLATE by scripts/generate-privacy-integration.js. Copy before filling. -->');
	out.push('');
	out.push(`Based on **${manifest.schemaVersion}** revision ${manifest.contractVersion}. This is an engineering template, not legal advice.`);
	out.push('');
	out.push('Do not edit this generated template in place. Copy it into the deployment record,');
	out.push('replace every `[HOST: ...]` field, add application-specific rows, record approvers,');
	out.push('and review it when package versions, configuration, vendors, regions, purposes,');
	out.push('or retention periods change.');
	out.push('');
	out.push('## Deployment identity');
	out.push('');
	out.push('- Service/deployment: [HOST: name and environment]');
	out.push('- Controller: [HOST: legal entity and contact]');
	out.push('- Processor (if applicable): [HOST: legal entity and instructions]');
	out.push('- DPO/privacy contact: [HOST: contact]');
	out.push('- Security/operations owner: [HOST: contact]');
	out.push('- Package versions/configuration evidence: [HOST: immutable release/config reference]');
	out.push('- Review date / next review / approver: [HOST: dates and names]');
	out.push('');
	out.push('## RoPA processing inventory');
	out.push('');
	out.push('| Ecosystem activity | Enabled? | Deployment purpose and lawful basis | Data/subjects actually used | Recipients and regions | Retention and deletion evidence | Owner |');
	out.push('| --- | --- | --- | --- | --- | --- | --- |');
	for (const activity of manifest.activities) {
		out.push(`| \`${activity.id}\` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |`);
	}
	out.push('| [HOST: application-specific activity] | [HOST] | [HOST] | [HOST] | [HOST] | [HOST] | [HOST] |');
	out.push('');
	out.push('## Retention and erasure controls');
	out.push('');
	out.push('- [ ] Every enabled activity has an exact retention period/trigger; capacity-only and `ttl=0` defaults are not presented as deadlines.');
	out.push('- [ ] Offline persistence uses an account-specific `persistKey`, a positive `maxAge`, and sign-out/account-switch clearing.');
	out.push('- [ ] Replay and dead-letter stores use positive TTLs where personal data is possible.');
	out.push('- [ ] `forgetUserId` and durable `purgeUser` are configured and tested for each applicable store.');
	out.push('- [ ] `FORGET_STORE_FAILED`, timeouts, and partial deletion keep the request open and trigger a retry/escalation.');
	out.push('- [ ] Adapter replay/session/dedup, jobs, alarms, application stores, downstream side effects, and custom stores have explicit deletion legs.');
	out.push('- [ ] Browser storage, logs, metrics, traces, support exports, replicas, caches, and backups have explicit deletion or put-beyond-use rules.');
	out.push('- [ ] Completion evidence contains no unnecessary personal data and names every successful, failed, and non-applicable leg.');
	out.push('');
	out.push('Erasure runbook/evidence location: [HOST: controlled link]');
	out.push('');
	out.push('## Processor, DPA, and subprocessor review');
	out.push('');
	out.push('Repeat for hosting, proxy/CDN, Redis, Postgres, logging, metrics, tracing, SIEM,');
	out.push('backups, push, webhook, support, analytics, and any application recipient.');
	out.push('');
	out.push('| Provider/recipient | Role and service | Data/subjects | DPA and instructions | Subprocessors/change notice | Security/access/deletion | Regions | Owner/evidence |');
	out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
	out.push('| [HOST: provider] | [HOST: processor/subprocessor/independent recipient] | [HOST] | [HOST: DPA/version/instructions] | [HOST: list + notice/objection] | [HOST: controls and deletion SLA] | [HOST] | [HOST] |');
	out.push('');
	out.push('## International transfer review');
	out.push('');
	out.push('| Transfer route | Exporter/importer and countries | Data/purpose | Mechanism | Supplementary measures | Transfer assessment/evidence | Revalidation trigger |');
	out.push('| --- | --- | --- | --- | --- | --- | --- |');
	out.push('| [HOST: service/data flow] | [HOST] | [HOST] | [HOST: adequacy/SCC/other] | [HOST: encryption/key control/minimisation] | [HOST: controlled link] | [HOST: date/vendor/legal change] |');
	out.push('');
	out.push('## Approval');
	out.push('');
	out.push('- Privacy/legal review: [HOST: approver/date/findings]');
	out.push('- Security review: [HOST: approver/date/findings]');
	out.push('- Engineering/operations review: [HOST: approver/date/drill evidence]');
	out.push('- Residual risks and accepted exceptions: [HOST: owner/expiry/mitigation]');
	out.push('');
	return out.join('\n') + '\n';
}

function normalizedFile(path) {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const manifest = loadManifest();
	const errors = validateManifest(manifest);
	if (errors.length > 0) {
		console.error('generate-privacy-integration: invalid manifest:');
		for (const error of errors) console.error(`  - ${error}`);
		process.exit(1);
	}
	const nextGuide = renderGuide(manifest);
	const nextChecklist = renderChecklist(manifest);
	if (process.argv.includes('--check')) {
		let stale = false;
		for (const [path, expected, label] of [
			[guidePath, nextGuide, 'docs/privacy-integration.md'],
			[checklistPath, nextChecklist, 'docs/privacy/v1/ropa-dpa-transfer-checklist.md']
		]) {
			let currentStale = false;
			try {
				if (normalizedFile(path) !== expected) currentStale = true;
			} catch {
				currentStale = true;
			}
			if (currentStale) {
				stale = true;
				console.error(`generate-privacy-integration: ${label} is missing or stale.`);
			}
		}
		if (stale) {
			console.error('  Run: npm run privacy:generate');
			process.exit(1);
		}
		console.log(`generate-privacy-integration: ${manifest.activities.length} activities validated and generated docs are current.`);
	} else {
		writeFileSync(guidePath, nextGuide);
		writeFileSync(checklistPath, nextChecklist);
		console.log(`generate-privacy-integration: wrote ${guidePath}`);
		console.log(`generate-privacy-integration: wrote ${checklistPath}`);
	}
}
