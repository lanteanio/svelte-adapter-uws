import { KIT3_MODULE_TOKEN } from '$app/env/private';
import { state } from './shared.js';

if (KIT3_MODULE_TOKEN !== 'fixture-secret') throw new Error('Extra entry evaluated before environment initialization');
state.entries.push('start');
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error('Extra entries did not evaluate as static siblings')), 5000);
	state.releaseEntry = () => { clearTimeout(timeout); resolve(); };
});
state.entries.push('ready');
