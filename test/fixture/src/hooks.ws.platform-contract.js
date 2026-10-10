export function open(ws, { platform }) {
	const members = [];
	for (const member in platform) members.push(member);
	platform.send(ws, 'contract', 'members', { members: members.sort(), requestId: platform.requestId });
}
