import buffer from 'node:buffer';
import { webcrypto } from 'node:crypto';

const File = /** @type {import('node:buffer') & { File?: File}} */ (buffer).File;

/** @type {Record<string, any>} */
const globals = {
	crypto: webcrypto,
	File
};

for (const name in globals) {
	if (name in globalThis) continue;

	Object.defineProperty(globalThis, name, {
		enumerable: true,
		configurable: true,
		writable: true,
		value: globals[name]
	});
}
