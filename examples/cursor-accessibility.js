const SHAPES = Object.freeze(['circle', 'square', 'diamond', 'triangle']);
const COLORS = Object.freeze([
	'#c62828',
	'#1565c0',
	'#2e7d32',
	'#6a1b9a',
	'#ef6c00',
	'#00838f',
	'#ad1457',
	'#4527a0'
]);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const MAX_NAME_CODE_POINTS = 80;
const MAX_ANNOUNCED_NAMES = 3;

function hashKey(key) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index++) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function cursorShape(key) {
	return SHAPES[hashKey(String(key)) % SHAPES.length];
}

export function cursorColor(user, key) {
	const selected = typeof user?.color === 'string' ? user.color.trim() : '';
	return HEX_COLOR.test(selected) ? selected : COLORS[hashKey(String(key)) % COLORS.length];
}

export function cursorName(user, key) {
	const selected = typeof user?.name === 'string' ? user.name.trim() : '';
	if (selected) {
		const normalized = selected
			.normalize('NFC')
			.replace(UNSAFE_NAME_CHARACTERS, ' ')
			.replace(/\s+/gu, ' ')
			.trim();
		if (normalized) return Array.from(normalized).slice(0, MAX_NAME_CODE_POINTS).join('');
	}
	return 'Collaborator ' + hashKey(String(key)).toString(36).padStart(7, '0');
}

export function hasFiniteCursorPosition(data) {
	return Number.isFinite(data?.x) && Number.isFinite(data?.y);
}

export function describeBoardPosition(data, cells) {
	if (!hasFiniteCursorPosition(data)) return 'position unavailable';
	for (const cell of cells) {
		if (
			data.x >= cell.x &&
			data.x < cell.x + cell.width &&
			data.y >= cell.y &&
			data.y < cell.y + cell.height
		) {
			return 'at ' + cell.label;
		}
	}
	return 'outside named board regions';
}

function formatNames(names) {
	if (names.length > MAX_ANNOUNCED_NAMES) {
		const omitted = names.length - MAX_ANNOUNCED_NAMES;
		return (
			names.slice(0, MAX_ANNOUNCED_NAMES).join(', ') +
			', and ' +
			omitted +
			(omitted === 1 ? ' other' : ' others')
		);
	}
	if (names.length < 2) return names[0] || '';
	if (names.length === 2) return names[0] + ' and ' + names[1];
	return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

export function summarizeCursorRosterChange(previous, current) {
	if (!(previous instanceof Map)) return '';
	const joined = [];
	const left = [];
	for (const [key, entry] of current) {
		if (!previous.has(key)) joined.push(cursorName(entry.user, key));
	}
	for (const [key, entry] of previous) {
		if (!current.has(key)) left.push(cursorName(entry.user, key));
	}
	joined.sort();
	left.sort();
	const messages = [];
	if (joined.length) messages.push(formatNames(joined) + ' joined the board.');
	if (left.length) messages.push(formatNames(left) + ' left the board.');
	return messages.join(' ');
}
