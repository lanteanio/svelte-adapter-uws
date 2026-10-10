import { KIT3_MODULE_TOKEN } from '$app/env/private';
if (KIT3_MODULE_TOKEN !== 'fixture-secret') throw new Error('Metrics module evaluated before environment initialization');
export default {
	counter: () => ({ inc() {} }),
	gauge: () => ({ set() {} }),
	histogram: () => ({ observe() {} })
};
