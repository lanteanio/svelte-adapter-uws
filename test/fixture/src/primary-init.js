/**
 * Primary-thread init hook for the fixture app.
 *
 * `SLOW_PRIMARY_INIT_MS` holds the primary inside its own boot window. That
 * window is only reachable at all when an app supplies this hook: without one
 * the primary's remaining awaits are module imports measured in microseconds,
 * and no test can deliver a signal into them. The marker is printed BEFORE the
 * hold so a test can wait for the window to be open rather than racing a
 * fixed delay against it (a no-op when the variable is unset).
 */
export default async function primaryInit() {
	const holdMs = Number(process.env.SLOW_PRIMARY_INIT_MS || 0);
	if (holdMs > 0) {
		console.log('__PRIMARY_INIT_HOLDING__');
		await new Promise((resolve) => setTimeout(resolve, holdMs));
		console.log('__PRIMARY_INIT_DONE__');
	}
	return null;
}
