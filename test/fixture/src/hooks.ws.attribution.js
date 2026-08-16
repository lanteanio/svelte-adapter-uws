// Attribution resolution against the built runtime. The upgrade hook copies
// the client's attribution-drive headers into userData - the server-trusted
// carrier - and the attribution export derives its answer from THAT, exactly
// as a real app derives it from the identity its upgrade hook established.
// Every failure mode is selected per connection through those fields, so the
// same build drives the healthy path, the unattributed path, the invalid-id
// refusal, and the throwing-resolver refusal.

import { attribution as readAttribution } from 'svelte-adapter-uws/connection';

export function upgrade({ headers }) {
	return {
		attrMode: headers['x-attr-mode'] || '',
		attrTenant: headers['x-attr-tenant'] || '',
		attrPrincipal: headers['x-attr-principal'] || ''
	};
}

export function attribution(user) {
	switch (user.attrMode) {
		case 'ok':
			return {
				tenantId: user.attrTenant || undefined,
				principalId: user.attrPrincipal || undefined
			};
		case 'invalid':
			// A raw space fails the [a-zA-Z0-9_-] rule.
			return { tenantId: 'not a valid id' };
		case 'throw':
			throw new Error('__ATTRIBUTION_RESOLVER_CRASH__');
		default:
			return null;
	}
}

// Lifecycle counters, served through the probe lane: a refused connection
// must bump NEITHER (its open hook never ran, so its close hook stays silent
// too), while an admitted connection bumps both across its life.
const lifecycle = { open: 0, close: 0 };

export function open() {
	lifecycle.open++;
}

export function close() {
	lifecycle.close++;
}

export function message(ws, { data, platform }) {
	let msg;
	try {
		msg = JSON.parse(Buffer.from(data).toString());
	} catch {
		return;
	}
	if (msg?.type === 'lifecycle-probe') {
		platform.send(ws, 'probe', 'lifecycle-probe', {
			nonce: msg.nonce,
			open: lifecycle.open,
			close: lifecycle.close
		});
		return;
	}
	if (msg?.type !== 'attribution-probe') return;
	// Echo what the PUBLIC accessor reads back, plus whether the stored object
	// is frozen, so the client-observed frame is the assertion surface.
	const attr = readAttribution(ws);
	platform.send(ws, 'probe', 'attribution-probe', {
		nonce: msg.nonce,
		attribution: attr,
		frozen: attr === null ? null : Object.isFrozen(attr)
	});
}
