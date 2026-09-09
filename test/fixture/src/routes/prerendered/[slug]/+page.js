// Prerendered under a NON-ASCII name, so the built prerendered map holds a
// path a request line can only spell percent-encoded. The redirect suite needs
// exactly that: the prerendered lookup matches the decoded spelling, and the
// trailing-slash 308 it issues has to redirect to a target a client can send.
export const prerender = true;

export function entries() {
	return [{ slug: 'café' }];
}

/** @param {{ params: { slug: string } }} event */
export function load({ params }) {
	return { slug: params.slug };
}
