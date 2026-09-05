// Prerendered, so this page lands in the built prerendered map rather than
// being rendered per request. That is the whole point of it: the prerendered
// lookup percent-DECODES the target before matching, so it is a second lane
// into the reserved admin namespace, reached before SSR. A suite can only pin
// that the prefix check runs ahead of that lookup if there is something inside
// the prefix for the lookup to find.
export const prerender = true;
