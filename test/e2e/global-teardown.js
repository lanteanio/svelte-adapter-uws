export default async function globalTeardown() {
	const servers = globalThis.__e2eServers || [];

	for (const proc of servers) {
		// Close stdin -> the server script calls process.exit(0) -> V8 coverage is flushed
		proc.stdin.end();

		await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				proc.kill();
				resolve();
			}, 5000);

			proc.on('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}
}
