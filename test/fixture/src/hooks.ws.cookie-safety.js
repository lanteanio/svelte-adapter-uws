export function authenticate({ headers, cookies }) {
	const mode = headers['x-cookie-case'] || 'valid';
	const surrogate = mode.endsWith('low') ? '\udc00' : '\ud800';
	let name = 'safe', value = 'ok';
	const options = { path: '/' };
	if (mode.startsWith('name-')) name = 'pre' + surrogate + 'post';
	if (mode.startsWith('raw-')) { value = 'pre' + surrogate + 'post'; options.encode = false; }
	if (mode.startsWith('path-')) options.path = '/pre' + surrogate + 'post';
	if (mode.startsWith('relative-')) options.path = 'pre' + surrogate + 'post';
	if (mode.startsWith('domain-')) options.domain = 'pre' + surrogate + '.example';
	if (mode === 'expires-duck') options.expires = { toUTCString: () => 'Tue, 01 Jan 2030 00:00:00 GMT' };
	if (mode === 'expires-control') options.expires = { toUTCString: () => 'bad\r\nX-Injected: yes' };
	if (mode === 'expires-invalid') options.expires = new Date(NaN);
	if (mode === 'expires-proxy') options.expires = new Proxy(new Date('2030-01-01T00:00:00Z'), {});
	if (mode === 'expires-null') options.expires = null;
	if (mode === 'date-valid' || mode === 'date-tampered') options.expires = new Date('2030-01-01T00:00:00Z');
	if (mode === 'date-tampered') options.expires.toUTCString = () => 'bad\r\nX-Injected: yes';
	if (mode === 'date-subclass') options.expires = new class extends Date { getTime() { throw new Error('overridden'); } toUTCString() { throw new Error('overridden'); } }('2030-01-01T00:00:00Z');
	if (mode === 'encoded') value = '\ud83d\ude42';
	if (mode === 'relative') options.path = 'sub';
	if (mode === 'paired') { value = '\ud83d\ude42'; options.encode = false; }
	cookies.set(name, value, options);
	return new Response('cookie');
}
