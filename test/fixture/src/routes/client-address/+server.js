// Return the actual runtime client-address result or its configuration error.
export function GET({ getClientAddress }) {
	try { return Response.json({ address: getClientAddress() }); }
	catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
}
