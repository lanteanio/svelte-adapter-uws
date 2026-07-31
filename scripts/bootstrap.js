#!/usr/bin/env node
/**
 * `npm run bootstrap` - clone to a tree that can actually run the suite.
 *
 * A root install is not enough and nothing says so at the moment it matters:
 * test/fixture is a separate SvelteKit app with its own lockfile, its
 * node_modules is gitignored, and several suites build it to boot the REAL
 * runtime. Without that install they fail inside `vite build`, minutes in, with
 * output that never mentions the missing install.
 *
 * Root dependencies are installed only when node_modules is absent - the fresh
 * clone. Reinstalling them from here would have npm delete the tree underneath
 * the npm process that is running this script, which fails outright on Windows
 * file locks; when they are already present this prints the command to run
 * instead of running it.
 *
 * Ends by running the doctor, so the last thing printed is whether the machine
 * can prove anything, and its exit code is this command's exit code.
 *
 * @module scripts/bootstrap
 */
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'fixture');

/**
 * Run `npm ci` in one directory. npm sets npm_execpath to its own entry script
 * when it runs a script, so the same npm is used rather than whatever the PATH
 * resolves - and driving it through node avoids the .cmd/shell-quoting split.
 * @param {string} cwd
 */
function npmCi(cwd) {
	const exec = process.env.npm_execpath;
	const useExec = typeof exec === 'string' && exec.endsWith('.js') && existsSync(exec);
	const result = useExec
		? spawnSync(process.execPath, [exec, 'ci'], { cwd, stdio: 'inherit' })
		: spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (result.error) {
		console.error(`bootstrap FAILED: could not run npm in ${cwd}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`bootstrap FAILED: \`npm ci\` in ${cwd} exited ${result.status}`);
		process.exit(result.status || 1);
	}
}

console.log('bootstrap: installing what a clone needs to run the suite');

if (existsSync(join(root, 'node_modules'))) {
	console.log('  root dependencies present (run `npm ci` yourself to refresh them).');
} else {
	console.log('  root: npm ci');
	npmCi(root);
}

console.log('  test/fixture: npm ci');
npmCi(fixture);

console.log('  doctor:');
const doctor = spawnSync(process.execPath, [join(root, 'scripts', 'doctor.js'), ...process.argv.slice(2)], {
	cwd: root, stdio: 'inherit'
});
process.exit(doctor.status === null ? 1 : doctor.status);
