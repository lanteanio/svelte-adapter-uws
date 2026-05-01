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
			testMatch: 'dev.spec.js',
			use: { baseURL: `http://localhost:${DEV_PORT}` }
		},
		{
			name: 'prod',
			testMatch: 'prod.spec.js',
			use: { baseURL: `http://localhost:${PROD_PORT}` }
		}
	]
});
