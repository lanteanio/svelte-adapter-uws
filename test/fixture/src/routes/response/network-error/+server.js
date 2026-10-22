// A network-error Response, whose status 0 cannot be written as an HTTP status.
export function GET() {
	return Response.error();
}
