import { defineConfig } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

export default defineConfig({
	testDir: '.',
	timeout: 30000,
	retries: 0,
	workers: 1,
	globalSetup: './global-setup.js',
	globalTeardown: './global-teardown.js',
	use: {
		headless: true
	},
	projects: [
		{
			name: 'dev',
			testMatch: ['dev.spec.js', 'cursor-worker.spec.js', 'smooth.spec.js', 'exclude.spec.js'],
			use: { baseURL: `http://localhost:${DEV_PORT}` }
		},
		{
			name: 'prod',
			testMatch: ['prod.spec.js', 'cursor-worker.spec.js', 'smooth.spec.js', 'exclude.spec.js'],
			use: { baseURL: `http://localhost:${PROD_PORT}` }
		},
		{
			// Owns its two at-capacity servers (built from the waiting fixture
			// variants in its beforeAll), so it runs once rather than per
			// dev/prod server - the surfaces under test are the adapter's own
			// holding and refusal pages, identical on both.
			name: 'waiting',
			testMatch: ['waiting-room.spec.js']
		}
	]
});
