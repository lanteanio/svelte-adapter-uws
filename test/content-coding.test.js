// Accept-Encoding negotiation (src/runtime/utils/content-coding.js), the
// function both the static lane and the single-chunk SSR lane call.
//
// The defect this replaces was substring matching: `acceptEncoding.includes('br')`
// read `br;q=0` - a refusal - as an acceptance, and read no preference at all,
// so `gzip;q=1, br;q=0.5` got brotli. The cases below are RFC 9110 12.5.3 read
// literally, each one a header shape a real client sends.

import { describe, it, expect } from 'vitest';
import { negotiateEncoding } from '../src/runtime/utils/content-coding.js';

const both = (header) => negotiateEncoding(header, true, true);

describe('negotiateEncoding', () => {
	it('serves brotli for the headers browsers actually send', () => {
		expect(both('gzip, deflate, br, zstd')).toBe('br');
		expect(both('gzip, deflate, br')).toBe('br');
		expect(both('deflate, gzip, br, zstd')).toBe('br');
		expect(both('br')).toBe('br');
	});

	it('serves gzip when brotli is not offered, and identity when nothing is', () => {
		expect(both('gzip, deflate')).toBe('gzip');
		expect(both('gzip')).toBe('gzip');
		expect(both('deflate')).toBe('');
		expect(both('')).toBe('');
		expect(both('identity')).toBe('');
	});

	it('a q=0 is a refusal, whatever else the header says', () => {
		expect(both('br;q=0, gzip')).toBe('gzip');
		expect(both('gzip, br;q=0')).toBe('gzip');
		expect(both('br;q=0.0, gzip;q=0.000')).toBe('');
		expect(both('br;q=0')).toBe('');
		expect(both('gzip;q=0, deflate')).toBe('');
	});

	it('the highest weight wins, and the server preference breaks a tie', () => {
		expect(both('gzip;q=1.0, br;q=0.5')).toBe('gzip');
		expect(both('gzip;q=0.8, br;q=0.9')).toBe('br');
		expect(both('gzip;q=0.5, br;q=0.5')).toBe('br');
		expect(both('br;q=0.001, gzip;q=0.002')).toBe('gzip');
		// Listed order carries no preference of its own.
		expect(both('gzip, br')).toBe('br');
	});

	it('a wildcard stands for every coding not named, at its own weight', () => {
		expect(both('*')).toBe('br');
		expect(both('*;q=0.5')).toBe('br');
		expect(both('*;q=0, gzip')).toBe('gzip');
		expect(both('*;q=0.1, gzip;q=0.5')).toBe('gzip');
		expect(both('*;q=0.9, gzip;q=0.5')).toBe('br');
		expect(both('*;q=0')).toBe('');
		expect(both('identity;q=0, *;q=0')).toBe('');
	});

	it('only the codings the server holds are candidates', () => {
		expect(negotiateEncoding('gzip, deflate, br', false, true)).toBe('gzip');
		expect(negotiateEncoding('gzip, deflate, br', true, false)).toBe('br');
		expect(negotiateEncoding('br', false, true)).toBe('');
		expect(negotiateEncoding('*', false, false)).toBe('');
		expect(negotiateEncoding('gzip', false, false)).toBe('');
	});

	it('coding names are case-insensitive tokens, not substrings', () => {
		expect(both('GZIP, BR')).toBe('br');
		expect(both('Gzip')).toBe('gzip');
		// A token that merely contains the letters is a different coding.
		expect(both('sbr')).toBe('');
		expect(both('brotli')).toBe('');
		expect(both('xgzip')).toBe('');
		expect(both('gzipx')).toBe('');
		expect(both('x-gzip')).toBe('');
	});

	it('tolerates the whitespace and empty elements the list grammar allows', () => {
		expect(both('  gzip , br ')).toBe('br');
		expect(both('gzip,,br')).toBe('br');
		expect(both(',')).toBe('');
		expect(both('gzip ; q=0 , br')).toBe('br');
		expect(both('gzip;q=0 ,br')).toBe('br');
		expect(both('\tbr\t')).toBe('br');
	});

	it('reads only the q parameter and leaves the default weight on one it cannot read', () => {
		expect(both('br;level=5, gzip;q=0.5')).toBe('br');
		expect(both('br;foo=bar;q=0, gzip')).toBe('gzip');
		expect(both('br;Q=0, gzip')).toBe('gzip');
		// Not a qvalue: no digits, above one, wrong punctuation. The coding
		// keeps its default weight rather than being refused or preferred.
		expect(both('br;q=abc, gzip;q=0.5')).toBe('br');
		expect(both('br;q=2, gzip;q=0.5')).toBe('br');
		expect(both('br;q=, gzip;q=0.5')).toBe('br');
		expect(both('br;q=0.5x, gzip;q=0.6')).toBe('br');
		expect(both('br;q=1.5, gzip;q=0.6')).toBe('br');
		// More than three decimals is outside the grammar too.
		expect(both('br;q=0.0001, gzip;q=0.5')).toBe('br');
		expect(both('br;q=1.000, gzip')).toBe('br');
		expect(both('br;q=0., gzip;q=0.5')).toBe('gzip');
	});

	it('the first listing of a coding is the one that counts', () => {
		expect(both('br, br;q=0, gzip')).toBe('br');
		expect(both('br;q=0, br')).toBe('');
		expect(both('*;q=0, *, gzip')).toBe('gzip');
	});

	it('a weight separated from its coding by whitespace is still its weight', () => {
		// The one-search path must not read `br ;q=0` as a weightless listing.
		expect(both('br ;q=0, gzip')).toBe('gzip');
		expect(both('br\t; q=0, gzip')).toBe('gzip');
		expect(both('gzip, br ; q=0.5')).toBe('gzip');
		expect(both(' br , gzip')).toBe('br');
	});

	it('the one-search path leaves a spelling inside another token to the full pass', () => {
		expect(both('x-br, br')).toBe('br');
		expect(both('sbr, gzip')).toBe('gzip');
		expect(both('gzip, x-gzip')).toBe('gzip');
		expect(negotiateEncoding('x-gzip', false, true)).toBe('');
		expect(negotiateEncoding('x-gzip, gzip', false, true)).toBe('gzip');
	});
});
