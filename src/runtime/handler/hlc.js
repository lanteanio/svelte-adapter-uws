import { createHlc } from '../utils.js';

// The hybrid logical clock the platform projects as `platform.hlc()`. One
// per-process instance; its wall component is non-decreasing and a logical
// tiebreaker disambiguates same-millisecond and backward-step reads. Read only
// when an event needs a causal stamp, never on the per-publish hot path.
export const readHlc = createHlc();
