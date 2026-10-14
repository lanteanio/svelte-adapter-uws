import { KIT3_MODULE_TOKEN } from '$app/env/private';
import { state } from './shared.js';

if (KIT3_MODULE_TOKEN !== 'fixture-secret') throw new Error('Extra entry evaluated before environment initialization');
state.entries.push('release');
if (!state.releaseEntry) throw new Error('Extra entries evaluated out of order');
state.releaseEntry();
