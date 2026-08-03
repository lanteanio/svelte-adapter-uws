import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { parse as parseYaml } from 'yaml';
import { packageFiles } from '../scripts/check-links.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
const markdown = new MarkdownIt({ html: true });
const contributorTarget = './CONTRIBUTING.md';
const cloneCommands = [
	'git clone https://github.com/lanteanio/svelte-adapter-uws.git',
	'cd svelte-adapter-uws',
	'npm run bootstrap',
	'npm run smoke',
	'npm run verify:fast',
	'npm run verify:pr'
];

function inlineText(children = []) {
	let text = '';
	for (const child of children) {
		if (child.type === 'text' || child.type === 'code_inline') text += child.content;
		else if (child.type === 'softbreak' || child.type === 'hardbreak') text += ' ';
		else if (child.children) text += inlineText(child.children);
	}
	return text;
}

function levelTwoHeadings(source) {
	const tokens = markdown.parse(source, {});
	const headings = [];
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type === 'heading_open' && tokens[index].tag === 'h2') {
			headings.push(inlineText(tokens[index + 1]?.children));
		}
	}
	return headings;
}

function contributorRoutes(source) {
	const tokens = markdown.parse(source, {});
	const firstH2 = tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h2');
	const all = [];
	const intro = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type !== 'inline') continue;
		for (const child of token.children || []) {
			if (child.type !== 'link_open' || child.attrGet('href') !== contributorTarget) continue;
			all.push(child.attrGet('href'));
			if (
				(firstH2 === -1 || index < firstH2) &&
				tokens[index - 1]?.type === 'paragraph_open' &&
				tokens[index - 1]?.level === 0
			) {
				intro.push(child.attrGet('href'));
			}
		}
	}
	return { all, intro };
}

function cloneJourney(source) {
	const tokens = markdown.parse(source, {});
	const heading = tokens.findIndex((token, index) =>
		token.type === 'heading_open' &&
		token.tag === 'h2' &&
		inlineText(tokens[index + 1]?.children) === 'Clone to green'
	);
	if (heading === -1) return null;
	const end = tokens.findIndex((token, index) =>
		index > heading && token.type === 'heading_open' && (token.tag === 'h1' || token.tag === 'h2')
	);
	const section = tokens.slice(heading + 3, end === -1 ? undefined : end);
	const fence = section.find((token) => token.type === 'fence');
	if (!fence) return null;
	return {
		language: fence.info.trim().split(/\s+/)[0],
		commands: fence.content
			.split(/\r?\n/)
			.map((line) => line.replace(/\s+#.*$/, '').trim())
			.filter(Boolean)
	};
}

describe('public contribution contract', () => {
	it('routes from the README top into one copyable clone-to-fast-green journey', () => {
		const readme = read('README.md');
		const contributing = read('CONTRIBUTING.md');
		const routes = contributorRoutes(readme);
		expect(routes.all).toEqual([contributorTarget]);
		expect(routes.intro).toEqual([contributorTarget]);
		expect(cloneJourney(contributing)).toEqual({ language: 'bash', commands: cloneCommands });
		const pkg = JSON.parse(read('package.json'));
		for (const command of cloneCommands.filter((command) => command.startsWith('npm run '))) {
			expect(pkg.scripts[command.slice('npm run '.length)], command).toBeTruthy();
		}
		expect(contributing).toContain('**There is no build step.** The package ships source');
		expect(levelTwoHeadings(contributing)).toEqual([
			'Table of contents',
			'Clone to green',
			'The native dependency, and how a green run can prove nothing',
			'What each command runs',
			'Documentation contributions',
			'What to run before you propose a change',
			'Where things live',
			'What moves together',
			'Review routing',
			'Issue lifecycle and backlog contract',
			'House conventions',
			'Proposing the change'
		]);
		const packed = new Set(packageFiles());
		for (const relative of ['CONTRIBUTING.md', 'docs/releasing.md', 'docs/release-manifest.md', 'SECURITY.md']) {
			expect(packed.has(relative), relative).toBe(true);
		}
	});

	it('rejects contributor routes hidden in comments or code fences', () => {
		const readme = read('README.md');
		const route = '[Contributing](./CONTRIBUTING.md)';
		for (const hidden of ['<!-- ' + route + ' -->', '~~~markdown\n' + route + '\n~~~']) {
			const routes = contributorRoutes(readme.replace(route, hidden));
			expect(routes.all).toEqual([]);
			expect(routes.intro).toEqual([]);
		}
	});

	it('binds the clone journey to its first rendered shell fence', () => {
		const contributing = read('CONTRIBUTING.md');
		const corrupted = contributing
			.replace('npm run bootstrap   # root deps, the fixture\'s own deps, then the doctor', 'npm run not-bootstrap')
			.replace('npm run smoke       # real HTTP health + WebSocket subscribe/publish checkpoint', 'npm run not-smoke')
			.replace('npm run verify:fast # seconds - the static gates', 'npm run not-fast')
			.replace('npm run verify:pr   # exactly what the hosted gate runs', 'npm run not-pr');
		for (const command of cloneCommands.slice(2)) expect(corrupted).toContain(command);
		expect(cloneJourney(corrupted)).toEqual({
			language: 'bash',
			commands: cloneCommands.slice(0, 2).concat([
				'npm run not-bootstrap',
				'npm run not-smoke',
				'npm run not-fast',
				'npm run not-pr'
			])
		});
		expect(cloneJourney(corrupted)?.commands).not.toEqual(cloneCommands);
	});

	it('routes structured issues and private security reports', () => {
		const config = read('.github/ISSUE_TEMPLATE/config.yml');
		const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
		const feature = read('.github/ISSUE_TEMPLATE/feature_request.yml');
		const usage = read('.github/ISSUE_TEMPLATE/usage_question.yml');
		expect(config).toContain('blank_issues_enabled: false');
		expect(config).toContain('/security/advisories/new');
		expect(config).not.toContain('/discussions');
		for (const id of ['observed', 'expected', 'reproduction', 'version', 'environment', 'verification']) {
			expect(bug).toMatch(new RegExp('id: ' + id + '\\b'));
		}
		for (const id of ['problem', 'outcome', 'alternatives', 'compatibility', 'verification']) {
			expect(feature).toMatch(new RegExp('id: ' + id + '\\b'));
		}
		for (const id of ['version', 'goal', 'attempted', 'environment', 'checks']) {
			expect(usage).toMatch(new RegExp('id: ' + id + '\\b'));
		}
		expect((bug.match(/required: true/g) ?? []).length).toBeGreaterThanOrEqual(8);
		expect((feature.match(/required: true/g) ?? []).length).toBeGreaterThanOrEqual(5);
		expect((usage.match(/required: true/g) ?? []).length).toBeGreaterThanOrEqual(6);
		expect(parseYaml(usage).name).toBe('Usage question');
	});

	it('makes evidence, release, generated-file and security checks visible before review', () => {
		const template = read('.github/pull_request_template.md');
		for (const phrase of [
			'regression test fails without the fix',
			'npm run check',
			'version bump',
			'CHANGELOG.md',
			'Generated or blessed artifacts',
			'lockfile',
			'benchmark numbers',
			'SECURITY.md'
		]) {
			expect(template).toContain(phrase);
		}
	});

	it('defines ready, done, priority, WIP, blocking and periodic review', () => {
		const contributing = read('CONTRIBUTING.md');
		for (const phrase of [
			'Definition of Ready',
			'Merge criteria',
			'three implementation issues',
			'status:blocked',
			'30 days',
			'good first issue',
			'No CLA or DCO sign-off is required'
		]) {
			expect(contributing).toContain(phrase);
		}
	});

	it('maps every verification lane to duration, setup, scope, and explicit exceptions', () => {
		const contributing = read('CONTRIBUTING.md');
		const pkg = JSON.parse(read('package.json'));
		expect(contributing).toContain('| Lane | Typical duration | Required setup | Scope and exception |');
		for (const lane of [
			'verify:fast',
			'verify:suite',
			'verify:sim',
			'verify:pr',
			'test:e2e',
			'test:coverage'
		]) {
			expect(pkg.scripts[lane], lane).toBeTruthy();
			expect(contributing, lane).toContain('`npm run ' + lane + '`');
		}
		for (const phrase of [
			'missing addon is a failure',
			'not hosted, so omission must be explicit',
			'platform you cannot run must be named as a gap',
			'appropriate for iteration, never a substitute for a runtime lane',
			'Run once per clone or dependency change'
		]) {
			expect(contributing).toContain(phrase);
		}
	});

	it('routes every path and makes high-risk propagation reviewable without archaeology', () => {
		const contributing = read('CONTRIBUTING.md');
		const owners = read('.github/CODEOWNERS');
		expect(owners).toMatch(/^\* @lanteanio$/m);
		for (const pattern of [
			'/src/runtime/ @lanteanio',
			'/src/plugins/ @lanteanio',
			'/src/*.d.ts @lanteanio',
			'/PROTOCOL.md @lanteanio',
			'/protocol.schema.json @lanteanio',
			'/test-vectors/ @lanteanio',
			'/scripts/ @lanteanio',
			'/.github/ @lanteanio'
		]) {
			expect(owners).toContain(pattern);
		}
		expect(contributing).toContain('| Change family | Primary paths | Required companions | Review focus |');
		for (const family of [
			'Adapter/build option',
			'Runtime behavior',
			'Wire or protocol',
			'Public export/type',
			'Plugin',
			'Documentation/generator',
			'CI, dependency, release, or security'
		]) {
			expect(contributing).toContain('| ' + family + ' |');
		}
	});

	it('defines canonical docs ownership, preview, synchronization, and one docs acceptance lane', () => {
		const contributing = read('CONTRIBUTING.md');
		const pkg = JSON.parse(read('package.json'));
		expect(contributing).toContain('[svelte-realtime-docs source](https://github.com/lanteanio/svelte-realtime-docs)');
		expect(contributing).toContain('tutorial, how-to, reference, explanation, and');
		expect(contributing).toContain('This README owns package identity, installation, support status');
		expect(contributing).toContain('Do not repair drift by maintaining the same fact twice.');
		expect(contributing).toContain('`npm run dev` for');
		expect(contributing).toContain('`npm run verify` for its acceptance gate');
		expect(contributing).toContain('Report both repository heads');
		const stages = pkg.scripts['verify:docs'].split(' && ');
		for (const stage of [
			'node scripts/check-links.js',
			'node scripts/check-entry-points.js',
			'node scripts/generate-api-docs.js --check',
			'node scripts/check-migration-freshness.js'
		]) {
			expect(stages).toContain(stage);
		}
		for (const test of [
			'test/docs-map.test.js',
			'test/packed-readme-examples.test.js',
			'test/migration-lifecycle.test.js',
			'test/migration-rehearsal.test.js',
			'test/compatibility-contract.test.js'
		]) {
			expect(pkg.scripts['verify:docs']).toContain(test);
		}
	});

	it('ships mechanical editor defaults without rewriting contributor files', () => {
		const editor = read('.editorconfig');
		expect(editor).toMatch(/^root = true/m);
		expect(editor).toContain('end_of_line = lf');
		expect(editor).toContain('insert_final_newline = true');
		expect(editor).toContain('trim_trailing_whitespace = true');
		expect(editor).toContain('indent_style = tab');
		expect(editor).toContain('indent_style = space');
	});
});
