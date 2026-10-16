import { fileURLToPath } from 'node:url';

process.argv.push('--fixture', fileURLToPath(new URL('.', import.meta.url)));
await import('../../fixture/lifecycle-smoke.mjs');
