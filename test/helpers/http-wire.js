import { connect } from 'node:net';

/** A raw request keeps encoded targets and repeated headers exactly as sent. */
export function requestWire(port, target, { method = 'GET', host = 'example.com', headers = [], body = '' } = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(method + ' ' + target + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n' +
				headers.map(([name, value]) => name + ': ' + value + '\r\n').join('') + '\r\n' + body);
		});
		socket.setTimeout(10000, () => socket.destroy(new Error('HTTP response timed out')));
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => {
			const data = Buffer.concat(chunks);
			const split = data.indexOf('\r\n\r\n');
			const lines = data.subarray(0, split).toString('latin1').split('\r\n');
			const fields = {};
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(':');
				fields[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
			}
			resolve({ status: Number(lines[0].split(' ')[1]), headers: fields, body: data.subarray(split + 4).toString() });
		});
	});
}
