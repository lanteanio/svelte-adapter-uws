#!/usr/bin/env node
/**
 * One definition of "this run is being treated as a gate".
 *
 * uWebSockets.js is an OPTIONAL native dependency fetched from GitHub, so npm
 * skips it SILENTLY when the fetch or the compile fails. Absent it, everything
 * that needs the real runtime reports a skip - which in a summary is
 * indistinguishable from a suite that ran and proved something. So absence is
 * tolerated while somebody is working locally, and is a hard failure the moment
 * the result is being read as evidence.
 *
 * That rule is applied in three places - `scripts/doctor.js`, the accepted-
 * binaries gate, and `test/helpers/real-runtime.js` - and three copies of a
 * three-term boolean is three chances for one of them to answer differently
 * from the others while every reader assumes one switch. It is a function here
 * so it is decided once, and so it can be driven by a test: the scripts compute
 * it in `main()`, which is the half a test that hands `required` in by hand
 * never reaches.
 *
 * @module scripts/require-uws
 */

/**
 * Whether a missing or unloadable native addon must fail rather than warn.
 *
 * `CI` is the environment variable every hosted runner sets, and it is honoured
 * on the exact string `'true'` rather than on truthiness, because a local shell
 * that exports `CI=''` to opt out has to be able to opt out.
 *
 * @param {string[]} argv the process arguments, `process.argv`
 * @param {Record<string, string | undefined>} env the environment, `process.env`
 * @returns {boolean}
 */
export function requiredMode(argv, env) {
	return argv.includes('--require-uws') || env.REQUIRE_UWS === '1' || env.CI === 'true';
}
