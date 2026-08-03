import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { documentationFiles, linksOf } from '../scripts/check-links.js';
import {
	collectExternalUrls,
	crawlExternalLinks,
	crawlUrl,
	externalLinksOf,
	looksLikeSoft404,
	publicUrlProblem
} from '../scripts/check-external-links.js';

let server;
let base;

const CHECKOUT_ACTION = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const SETUP_NODE_ACTION = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const CRAWL_COMMAND = 'node scripts/check-external-links.js --concurrency=4 --timeout-ms=15000 --max-redirects=6';

function workflowFailures(source) {
	const document = parseDocument(source, { uniqueKeys: true });
	const failures = document.errors.map((error) => `invalid YAML: ${error.message}`);
	if (failures.length) return failures;
	const workflow = document.toJS();
	const triggers = workflow.on || {};
	if (JSON.stringify(Object.keys(triggers).sort()) !== JSON.stringify(['schedule', 'workflow_dispatch'])) {
		failures.push('workflow triggers drifted');
	}
	if (triggers.schedule?.length !== 1 || triggers.schedule[0]?.cron !== '43 5 * * 2') {
		failures.push('weekly schedule drifted');
	}
	if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' })) {
		failures.push('top-level permissions are not exactly contents: read');
	}
	const job = workflow.jobs?.['external-links'];
	if (!job || job['runs-on'] !== 'ubuntu-latest' || job['timeout-minutes'] !== 20 || job.permissions !== undefined) {
		failures.push('external-links job boundary drifted');
	}
	const steps = job?.steps || [];
	if (steps.length !== 3 || steps[0]?.uses !== CHECKOUT_ACTION || steps[1]?.uses !== SETUP_NODE_ACTION) {
		failures.push('workflow action steps are not the exact pinned actions');
	}
	if (steps.some((step) => step.uses && !/@[0-9a-f]{40}$/i.test(step.uses))) {
		failures.push('workflow contains a mutable action reference');
	}
	if (steps[1]?.with?.['node-version-file'] !== '.nvmrc') failures.push('Node version source drifted');
	if (steps[2]?.name !== 'Crawl external documentation targets' || steps[2]?.run !== CRAWL_COMMAND) {
		failures.push('crawler command drifted');
	}
	return failures;
}

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === '/ok') {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<!doctype html><title>Useful guide</title><h1>Guide</h1>');
			return;
		}
		if (req.url === '/redirect') {
			res.writeHead(301, { location: '/ok' });
			res.end();
			return;
		}
		if (req.url === '/soft') {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<!doctype html><title>404 - Page not found</title><h1>Nothing here</h1>');
			return;
		}
		if (req.url === '/loop-a') {
			res.writeHead(302, { location: '/loop-b' });
			res.end();
			return;
		}
		if (req.url === '/loop-b') {
			res.writeHead(302, { location: '/loop-a' });
			res.end();
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('missing');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

describe('external documentation link inventory', () => {
	it('collects visible HTTP links once and preserves every source location', () => {
		const documents = [
			{ relative: 'README.md', text: '[one](https://example.com/a#first) and [two](https://example.com/a#second)\n`[example](https://ignored.invalid)`\n' },
			{ relative: 'MIGRATION.md', text: '```md\n[x](https://ignored.invalid)\n```\n[three](//example.com/a)\n' }
		];
		const inventory = collectExternalUrls(documents);
		expect(inventory.invalid).toEqual([]);
		expect([...inventory.urls.keys()]).toEqual(['https://example.com/a']);
		expect(inventory.urls.get('https://example.com/a')).toHaveLength(3);
		expect(externalLinksOf('[bad](https://user:secret@example.com/)')[0].failure)
			.toContain('credentials');
	});

	it('includes rendered reference, angle-destination, and raw HTML URLs', () => {
		const text = [
			'[reference][guide]',
			'',
			'[guide]: <https://example.com/reference path>',
			'<a href="https://example.com/html">HTML</a>'
		].join('\n');
		expect(externalLinksOf(text).map((link) => link.url)).toEqual([
			'https://example.com/reference%20path',
			'https://example.com/html'
		]);
	});

	it('rejects loopback, private, link-local, and credentialed fetch targets', () => {
		for (const url of [
			'http://localhost/',
			'http://127.0.0.1/',
			'http://10.0.0.1/',
			'http://172.16.0.1/',
			'http://192.168.1.1/',
			'http://169.254.169.254/',
			'http://localhost./',
			'http://service.local./',
			'http://service.internal./',
			'http://[::1]/',
			'http://[::ffff:127.0.0.1]/',
			'https://user:secret@example.com/'
		]) expect(publicUrlProblem(url), url).toBeTruthy();
		expect(publicUrlProblem('https://example.com/docs')).toBe(null);
	});
});

describe('bounded redirect and soft-404 crawl', () => {
	it('rejects terminal-dot private hosts before invoking fetch', async () => {
		let calls = 0;
		const result = await crawlUrl('http://localhost./', {
			fetchImpl: async () => {
				calls++;
				return new Response('unexpected');
			}
		});
		expect(result).toMatchObject({ ok: false, kind: 'unsafe-url' });
		expect(calls).toBe(0);
	});

	it('distinguishes direct success, hard error, redirect, soft 404, and loop', async () => {
		const options = { allowPrivate: true, timeoutMs: 2000 };
		const [ok, hard, redirect, soft, loop] = await Promise.all([
			crawlUrl(base + '/ok', options),
			crawlUrl(base + '/hard', options),
			crawlUrl(base + '/redirect', options),
			crawlUrl(base + '/soft', options),
			crawlUrl(base + '/loop-a', options)
		]);
		expect(ok).toMatchObject({ ok: true, kind: 'ok', status: 200 });
		expect(hard).toMatchObject({ ok: false, kind: 'http-error', status: 404 });
		expect(redirect).toMatchObject({ ok: false, kind: 'redirect', status: 200 });
		expect(redirect.redirects).toEqual([
			{ from: base + '/redirect', status: 301, to: base + '/ok' }
		]);
		expect(soft).toMatchObject({ ok: false, kind: 'soft-404', status: 200 });
		expect(loop).toMatchObject({ ok: false, kind: 'redirect-loop' });
	});

	it('recognizes not-found titles/headings without matching ordinary prose', () => {
		expect(looksLikeSoft404('<title>Page not found</title>')).toBe(true);
		expect(looksLikeSoft404('<h1>410 Gone</h1>')).toBe(true);
		expect(looksLikeSoft404('<title>Oops! That page cannot be found</title>')).toBe(true);
		expect(looksLikeSoft404('<h2>Page not found</h2>')).toBe(true);
		expect(looksLikeSoft404('<title>The page you requested was not found</title>')).toBe(true);
		expect(looksLikeSoft404('<title>Guide to handling HTTP 404 responses</title><h1>Operations</h1>')).toBe(false);
		expect(looksLikeSoft404('<h2>Diagnosing page not found responses</h2>')).toBe(false);
	});

	it('runs a bounded concurrent batch without losing result order', async () => {
		const urls = [base + '/ok', base + '/hard', base + '/soft'];
		const results = await crawlExternalLinks(urls, { allowPrivate: true, concurrency: 2, timeoutMs: 2000 });
		expect(results.map((result) => result.url)).toEqual(urls);
		expect(results.map((result) => result.kind)).toEqual(['ok', 'http-error', 'soft-404']);
	});
});

describe('scheduled external link ownership', () => {
	it('runs weekly and manually with structurally pinned read-only actions and bounded crawler flags', () => {
		const workflow = readFileSync(new URL('../.github/workflows/docs-links.yml', import.meta.url), 'utf8');
		expect(workflowFailures(workflow)).toEqual([]);

		const unpinned = workflow.replace(
			'uses: ' + CHECKOUT_ACTION,
			'name: ' + CHECKOUT_ACTION + '\n        uses: actions/checkout@main'
		);
		expect(workflowFailures(unpinned)).toContain('workflow contains a mutable action reference');

		const commandLaundering = workflow.replace(
			'run: ' + CRAWL_COMMAND,
			'run: node -e "process.exit(0)" # ' + CRAWL_COMMAND
		);
		expect(workflowFailures(commandLaundering)).toContain('crawler command drifted');

		const elevatedJob = workflow.replace(
			'    timeout-minutes: 20',
			'    timeout-minutes: 20\n    permissions: write-all'
		);
		expect(workflowFailures(elevatedJob)).toContain('external-links job boundary drifted');
	});

	it('keeps GitHub source links on the canonical main branch', () => {
		const root = new URL('..', import.meta.url);
		const stale = [];
		for (const relative of documentationFiles()) {
			const text = readFileSync(new URL(relative.split('/').map(encodeURIComponent).join('/'), root), 'utf8');
			for (const link of linksOf(text)) {
				if (/github\.com\/[^/]+\/[^/]+\/blob\/master(?:\/|$)/i.test(link.target)) {
					stale.push(`${relative}:${link.line} ${link.target}`);
				}
			}
		}
		expect(stale).toEqual([]);
	});
});
