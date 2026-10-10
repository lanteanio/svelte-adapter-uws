import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFlag } from '../scripts/leak-lane.js';

it.each([
	['minutes', '2'], ['scenario', 'http'], ['scenario', 'churn'],
	['out', 'dir with spaces'], ['out', 'dir=name=kept']
])('reads --%s in separated and equals forms', (name, value) => {
	expect(readFlag([`--${name}`, value], name, 'fallback')).toBe(value);
	expect(readFlag([`--${name}=${value}`], name, 'fallback')).toBe(value);
});
it('retains defaults only when the named flag is absent and keeps the first occurrence', () => {
	expect(readFlag(['--scenario=http'], 'minutes', '3')).toBe('3');
	expect(readFlag(['--out=first', '--out', 'second'], 'out', 'default')).toBe('first');
	expect(readFlag(['--out', 'first', '--out=second'], 'out', 'default')).toBe('first');
});
it.each([['--minutes'], ['--minutes='], ['--minutes', ''], ['--minutes', '--scenario=http']])(
	'refuses missing flag values in %j', (...argv) => {
		expect(() => readFlag(argv, 'minutes', '3')).toThrow('--minutes requires a value');
	}
);
it('accepts a negative number as the value so duration validation can reject it', () => {
	expect(readFlag(['--minutes', '-5'], 'minutes', '3')).toBe('-5');
});
it('uses equals-form values at the executable entry point before building', () => {
	const script = fileURLToPath(new URL('../scripts/leak-lane.js', import.meta.url));
	const result = spawnSync(process.execPath, [script, '--minutes=2m', '--scenario', '__argument-check__'], {
		encoding: 'utf8', timeout: 8000, windowsHide: true
	});
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(2);
	expect(result.stderr).toContain('--minutes must be a number from 1 to 60, got "2m"');
	expect(result.stderr).not.toContain('unknown scenario');
	expect(result.stdout).toBe('');
}, 10000);
