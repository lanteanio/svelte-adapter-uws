export function announce(platform, user) {
	return platform.publish('presence-audit', 'changed', {
		id: user.id,
		name: user.name
	});
}
