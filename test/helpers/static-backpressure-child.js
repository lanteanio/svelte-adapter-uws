import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const build = fileURLToPath(new URL('../fixture/build/', import.meta.url));
const handler = await import(pathToFileURL(path.join(build, 'handler.js')).href);
const { cacheDir } = await import(pathToFileURL(path.join(build, 'handler/static-assets.js')).href);
cacheDir(process.argv[2], '/large-static', false);
await handler.start('127.0.0.1', Number(process.argv[3]));
process.send({ ready: true });
process.on('message', async ({ id, op }) => {
	if (op === 'memory') {
		global.gc();
		process.send({ id, rss: process.memoryUsage().rss });
	} else if (op === 'stop') {
		await handler.shutdown();
		handler.forceCloseApp();
		process.exit(0);
	}
});
