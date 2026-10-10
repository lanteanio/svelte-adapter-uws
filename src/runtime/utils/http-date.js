import { now } from '../runtime.js';

const IMF = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Parse the three HTTP-date forms, rejecting non-HTTP and impossible dates.
 * RFC 850 years use the rolling 50-year boundary from RFC 9110 section 5.6.7.
 * @param {string} value
 * @returns {number} Milliseconds since the epoch, or NaN.
 */
export function parseHttpDate(value) {
	let parts = IMF.exec(value);
	let obsolete = false;
	if (!parts) {
		parts = RFC850.exec(value);
		obsolete = parts !== null;
	}
	if (!parts) {
		const asc = ASCTIME.exec(value);
		if (!asc || asc[0].length !== value.length) return NaN;
		parts = [asc[0], asc[1], asc[3], asc[2], asc[7], asc[4], asc[5], asc[6]];
	}
	if (parts[0].length !== value.length) return NaN;
	const day = Number(parts[2]);
	const month = MONTHS.indexOf(parts[3]);
	let year = Number(parts[4]);
	const hour = Number(parts[5]);
	const minute = Number(parts[6]);
	const second = Number(parts[7]);
	if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return NaN;
	let limit;
	if (obsolete) {
		limit = new Date(now()); // determinism-allow: formats the injected runtime clock
		limit.setUTCFullYear(limit.getUTCFullYear() + 50);
		year += Math.floor(limit.getUTCFullYear() / 100) * 100;
	}
	let timestamp = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
	if (obsolete && timestamp + (second === 60 ? 1000 : 0) > limit.getTime()) {
		year -= 100;
		timestamp = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
	}
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = month === 1 ? (leap ? 29 : 28) : (month === 3 || month === 5 || month === 8 || month === 10 ? 30 : 31);
	if (year < 1900 || day > daysInMonth || DAYS[(Math.floor(timestamp / 86400000) % 7 + 11) % 7] !== parts[1].slice(0, 3)) return NaN;
	return timestamp + (second === 60 ? 1000 : 0);
}
