// Playwright fixture that collects V8 JS coverage from the browser.
// Writes coverage files compatible with NODE_V8_COVERAGE format so
// c8 can merge them with server-side coverage.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coverageDir = process.env.NODE_V8_COVERAGE || path.resolve(__dirname, '../../coverage/e2e-tmp');
let counter = 0;

/**
 * Start collecting JS coverage on a Playwright page.
 * Call stopBrowserCoverage() after the test to write the data.
 * @param {import('@playwright/test').Page} page
 */
export async function startBrowserCoverage(page) {
	const client = await page.context().newCDPSession(page);
	await client.send('Profiler.enable');
	await client.send('Profiler.startPreciseCoverage', {
		callCount: true,
		detailed: true
	});
	return client;
}

/**
 * Stop collecting and write V8 coverage to the shared coverage directory.
 * Filters to only include files from our source (client.js, plugins/).
 * @param {import('playwright-core/lib/client/cdpSession').CDPSession} client
 */
export async function stopBrowserCoverage(client) {
	const { result } = await client.send('Profiler.takePreciseCoverage');
	await client.send('Profiler.stopPreciseCoverage');
	await client.send('Profiler.disable');

	// Filter to our source files (served by Vite via /@fs/ prefix)
	const adapterRoot = path.resolve(__dirname, '../..').replace(/\\/g, '/');
	const ours = result.filter((entry) => {
		const url = entry.url || '';
		// Vite serves local files as /@fs/C:/path/to/file.js
		if (url.includes('/@fs/')) {
			const fsPath = url.split('/@fs/')[1]?.split('?')[0];
			if (!fsPath) return false;
			const normalized = fsPath.replace(/\\/g, '/');
			return normalized.startsWith(adapterRoot) &&
				!normalized.includes('node_modules') &&
				!normalized.includes('test/fixture');
		}
		return false;
	}).map((entry) => {
		// Rewrite URL from Vite /@fs/ format to file:// format for c8
		const fsPath = entry.url.split('/@fs/')[1].split('?')[0];
		return {
			...entry,
			url: 'file:///' + fsPath
		};
	});

	if (ours.length === 0) return;

	mkdirSync(coverageDir, { recursive: true });
	const filename = `coverage-browser-${process.pid}-${Date.now()}-${counter++}.json`;
	writeFileSync(
		path.join(coverageDir, filename),
		JSON.stringify({ result: ours })
	);
}
