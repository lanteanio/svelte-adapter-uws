// An endpoint that answers HEAD itself, the way an app states the GET's size
// without rendering it. `?declare=0` answers with no length, so both things a
// bodyless HEAD may say about its length are observable on a real build.

const BODY = 'twelve bytes';

export function GET() {
	return new Response(BODY, { headers: { 'content-type': 'text/plain' } });
}

export function HEAD({ url }) {
	const headers = { 'content-type': 'text/plain' };
	if (url.searchParams.get('declare') !== '0') headers['content-length'] = String(BODY.length);
	return new Response(null, { headers });
}
