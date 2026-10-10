import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/leak-lane.js', import.meta.url));
const invalidScenario = '__argument-check__';

// The invalid scenario is a second guard: even a broken minutes parser cannot
// enter the fixture build or a measurement window while this test runs.
function invoke(minutes) {
	return spawnSync(process.execPath, [script, '--minutes', minutes, '--scenario', invalidScenario], {
		encoding: 'utf8', timeout: 8000, windowsHide: true
	});
}

it.each(['2m', 'Infinity', 'NaN', '0', '61', '0.5', 'abc', '-5', ' '])(
	'refuses invalid measurement minutes %j before inspecting scenarios or building', (minutes) => {
		const result = invoke(minutes);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`--minutes must be a number from 1 to 60, got "${minutes}"`);
		expect(result.stderr).not.toContain('unknown scenario');
		expect(result.stdout).toBe('');
	}, 10000
);

it.each(['1', '3', '60', '1e1', '1.5'])(
	'accepts measurement minutes %j and then validates the scenario', (minutes) => {
		const result = invoke(minutes);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`unknown scenario "${invalidScenario}"`);
		expect(result.stderr).not.toContain('--minutes must');
		expect(result.stdout).toBe('');
	}, 10000
);
