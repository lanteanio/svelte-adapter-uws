#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readAdapterPackageJson, uwsLoadErrorMessage } from '../src/uws-load-hint.js';

export const NATIVE_CHECK_BYPASS = 'SVELTE_ADAPTER_UWS_SKIP_NATIVE_CHECK';

/**
 * Verify that the platform can load the optional native server dependency.
 * The dependency stays optional so client-only consumers can explicitly skip
 * it, while ordinary installs fail immediately with the native loader cause.
 *
 * @param {() => Promise<unknown>} [importer]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ skipped: boolean }>}
 */
export async function verifyNativeInstall(
	importer = () => import('uWebSockets.js'),
	env = process.env
) {
	if (env[NATIVE_CHECK_BYPASS] === '1') return { skipped: true };
	try {
		await importer();
		return { skipped: false };
	} catch (cause) {
		throw new Error(uwsLoadErrorMessage(readAdapterPackageJson(), cause), { cause });
	}
}

async function main() {
	try {
		const result = await verifyNativeInstall();
		if (result.skipped) {
			console.warn(
				'Skipping the uWebSockets.js native-load check because ' + NATIVE_CHECK_BYPASS + '=1.'
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
const current = fileURLToPath(import.meta.url);
const isCli = invoked !== null && (process.platform === 'win32'
	? invoked.toLowerCase() === current.toLowerCase()
	: invoked === current);
if (isCli) await main();
