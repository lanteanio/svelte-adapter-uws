import { defineEnvVars } from '@sveltejs/kit/env';
export const variables = defineEnvVars({ KIT3_MODULE_TOKEN: { schema: value => value } });
