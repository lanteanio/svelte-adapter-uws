import { cancelBodyProbe } from '../../body-cancel-probe.js';

export async function POST({ request }) {
	return cancelBodyProbe(request);
}
