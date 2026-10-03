// openssl, for the suites that need a real X.509 certificate. A suite decides
// describe-vs-skip at collection time, so it resolves the binary at module
// scope. On Windows the shell PATH often lacks openssl, but Git for Windows
// bundles one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns {string | null} the openssl binary, or null when none runs */
export function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
	}
	for (const bin of candidates) {
		try {
			execFileSync(bin, ['version'], { stdio: 'ignore' });
			return bin;
		} catch {}
	}
	return null;
}

/**
 * A self-signed certificate for `localhost` and `127.0.0.1`, written into
 * `dir`.
 *
 * @param {string} openssl
 * @param {string} dir
 * @returns {{ key: string, cert: string }} the PEM texts
 */
export function loopbackCertificate(openssl, dir) {
	const key = join(dir, 'loopback.key');
	const cert = join(dir, 'loopback.crt');
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
		'-keyout', key, '-out', cert, '-subj', '/CN=localhost',
		'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
	], { stdio: 'ignore' });
	return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}
