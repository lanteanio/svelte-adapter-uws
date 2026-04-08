import { defineConfig } from '@playwright/test';

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
			use: { baseURL: 'http://localhost:49321' }
		},
		{
			name: 'prod',
			testMatch: 'prod.spec.js',
			use: { baseURL: 'http://localhost:49322' }
		}
	]
});
