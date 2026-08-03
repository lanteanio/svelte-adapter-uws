import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const read = (relative) => readFileSync(fileURLToPath(new URL('../' + relative, import.meta.url)), 'utf8');
const unit = read('examples/deployment/svelte-adapter-uws.service');
const composeSource = read('examples/deployment/compose.yaml');
const compose = YAML.parse(composeSource);
const workflow = read('.github/workflows/test.yml');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

describe('external recovery deployment examples', () => {
	it('makes readiness, watchdog recovery, and termination grace explicit in systemd', () => {
		expect(unit).toMatch(/^Type=notify$/m);
		expect(unit).toMatch(/^NotifyAccess=all$/m);
		expect(unit).toMatch(/^TimeoutStartSec=90s$/m);
		expect(unit).toMatch(/^WatchdogSec=30s$/m);
		expect(unit).toMatch(/^Restart=on-failure$/m);
		expect(unit).toMatch(/^RestartSec=2s$/m);
		expect(unit).toMatch(/^KillSignal=SIGTERM$/m);
		expect(unit).toMatch(/^TimeoutStopSec=45s$/m);
	});

	it('makes restart, readiness, and termination grace explicit for containers', () => {
		const app = compose.services.app;
		expect(app.restart).toBe('unless-stopped');
		expect(app.stop_signal).toBe('SIGTERM');
		expect(app.stop_grace_period).toBe('45s');
		expect(app.healthcheck.test.join(' ')).toContain('/readyz');
		expect(app.deploy.restart_policy).toEqual({ condition: 'any', delay: '2s' });
		expect(app.deploy.update_config.order).toBe('start-first');
	});

	it('ships the examples and links operators to them', () => {
		expect(pkg.files).toContain('examples');
		expect(readme).toContain('./examples/deployment/svelte-adapter-uws.service');
		expect(readme).toContain('./examples/deployment/compose.yaml');
	});
});

describe('Linux external-respawner drill wiring', () => {
	it('has a dedicated Ubuntu job that runs the public drill command', () => {
		expect(pkg.scripts['drill:respawner']).toBe('node scripts/drill-respawner.js');
		expect(workflow).toMatch(/respawner-drill:\s*[\s\S]*?runs-on: ubuntu-latest[\s\S]*?run: npm run drill:respawner/);
	});

	it('drives both clustered worker escalation and a direct primary kill', () => {
		const drill = read('scripts/drill-respawner.js');
		const supervisor = read('test/fixtures/external-respawner.mjs');
		expect(drill).toContain("CLUSTER_WORKERS: '2'");
		expect(drill).toContain("type: 'respawner-drill-wedge'");
		expect(drill).toContain("type: 'kill-primary'");
		expect(drill).toMatch(/generation === 3/);
		expect(supervisor).toContain("child?.kill('SIGKILL')");
	});
});
