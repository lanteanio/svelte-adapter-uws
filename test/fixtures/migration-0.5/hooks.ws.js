import { createPresence } from 'svelte-adapter-uws/plugins/presence';

export const presence = createPresence({
	key: 'id',
	binary: false,
	heartbeat: 0,
	topicThrottle: 0
});

export const { subscribe, unsubscribe, close } = presence.hooks;
