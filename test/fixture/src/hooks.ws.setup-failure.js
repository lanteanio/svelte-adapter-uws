let basePlatform;
let opens = 0;
let closes = 0;
export function upgrade({ headers }) {
	const failure = headers['x-setup-failure'];
	if (failure === 'platform') {
		const original = Object.create;
		Object.create = function (prototype, properties) {
			if (prototype === basePlatform) {
				Object.create = original;
				throw new Error('fixture platform allocation failed');
			}
			return original(prototype, properties);
		};
	} else if (failure === 'registration') {
		const original = Set.prototype.add;
		Set.prototype.add = function (value) {
			const result = original.call(this, value);
			if (typeof value?.getUserData === 'function') {
				Set.prototype.add = original;
				throw new Error('fixture connection registration failed');
			}
			return result;
		};
	}
	return {};
}
export function open(ws, { platform }) {
	basePlatform = Object.getPrototypeOf(platform);
	opens++;
	platform.send(ws, 'probe', 'counts', { opens, closes, connections: platform.connections });
}
export function close() { closes++; }
