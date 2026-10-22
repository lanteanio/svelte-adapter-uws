// A Response whose body the endpoint already read, which the server cannot
// send and answers with a 500 of its own.
export async function GET() {
	const response = new Response('already read', { headers: { 'content-type': 'text/plain' } });
	response.body.getReader();
	return response;
}
