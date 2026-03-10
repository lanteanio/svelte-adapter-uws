// Barebones Node http.createServer -- absolute minimum, equivalent to bench 1.
import http from 'node:http';

const PORT = parseInt(process.env.PORT || '9001');

http.createServer((req, res) => {
	res.end('Hello World');
}).listen(PORT, '0.0.0.0', () => {
	console.log(`[node-baseline] listening on :${PORT}`);
});
