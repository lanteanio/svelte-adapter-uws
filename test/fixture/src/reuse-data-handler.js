const APP_KEY = Symbol.for('fixture.application.value');
const PLATFORM = Symbol.for('adapter-uws.ws.platform');
const SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');
const SESSION = Symbol.for('adapter-uws.ws.session-id');
const CAPS = Symbol.for('adapter-uws.ws.caps');

export function createReuseHandler() {
	let saved;
	return {
		upgrade({ headers }) {
			if (headers['x-reuse-data'] === 'direct') return saved;
			if (headers['x-reuse-data'] === 'spread') return { ...saved, additional: 'kept' };
			return { application: 'kept', [APP_KEY]: 'symbol-kept' };
		},
		async open(ws, { platform }) {
			const data = ws.getUserData();
			const first = saved === undefined;
			const previousPlatform = saved?.[PLATFORM];
			const previousSession = saved?.[SESSION];
			const staleCaps = data[CAPS]?.has('fixture-capability') ?? false;
			const staleMembership = data[SUBSCRIPTIONS]?.has('first-only') ?? false;
			if (first) {
				saved = data;
				data[CAPS] = new Set(['fixture-capability']);
				await platform.subscribe(ws, 'first-only');
			}
			platform.send(ws, 'probe', 'copied', {
				first, application: data.application, symbol: data[APP_KEY], additional: data.additional,
				freshPlatform: first || platform !== previousPlatform,
				freshSession: first || data[SESSION] !== previousSession,
				staleMembership, staleCaps,
				originalMembership: saved[SUBSCRIPTIONS].has('first-only')
			});
		}
	};
}
