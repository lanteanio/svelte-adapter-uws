// Coverage report: unit tests (vitest) + e2e tests (playwright).
//
// Usage: node scripts/coverage.js
//
// Runs both test suites and reports coverage from each:
// - Vitest: captures unit test coverage via built-in v8 provider
// - Playwright: captures server-side V8 coverage (vite.js, handler.js) and
//   browser-side V8 coverage (client.js, plugin clients) via CDP

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eTmpDir = path.join(root, 'coverage', 'e2e-tmp');

rmSync(e2eTmpDir, { recursive: true, force: true });

const run = (cmd, env = {}) => execSync(cmd, {
	cwd: root,
	stdio: 'inherit',
	env: { ...process.env, ...env }
});

console.log('\n--- Unit tests (vitest) ---\n');
run('npx vitest run --coverage');

console.log('\n--- E2E tests (playwright) ---\n');
run(
	'npx playwright test --config test/e2e/playwright.config.js',
	{ NODE_V8_COVERAGE: e2eTmpDir }
);

console.log('\n--- E2E coverage (server + browser) ---\n');
run(
	`npx c8 report` +
	` --temp-directory "${e2eTmpDir}"` +
	` --reporter=text` +
	` --src .` +
	` --include="client.js"` +
	` --include="vite.js"` +
	` --include="files/**"` +
	` --include="plugins/**"`
);
