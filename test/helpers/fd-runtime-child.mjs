import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const soft = process.argv[2];
if (soft !== 'native') {
	const readFile = fs.readFileSync;
	const readDir = fs.readdirSync;
	fs.readFileSync = function (path, ...args) {
		if (String(path) === '/proc/self/limits') return `Max open files  ${soft}  65536  files\n`;
		return readFile.call(this, path, ...args);
	};
	fs.readdirSync = function (path, ...args) {
		if (String(path) === '/proc/self/fd') return Array.from({ length: 43 }, (_, i) => String(i));
		return readDir.call(this, path, ...args);
	};
	syncBuiltinESMExports();
}
await import('../fixture/build-metrics/index.js');
