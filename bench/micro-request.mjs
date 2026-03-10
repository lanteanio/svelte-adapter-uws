// Microbenchmark: isolates the cost of new Request() construction
// outside of any server context, measuring pure JS overhead.

const origin = 'http://localhost:3000';
const iterations = 500_000;

// Typical headers from a browser request
const headerPairs = [
	['host', 'localhost:3000'],
	['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
	['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
	['accept-language', 'en-US,en;q=0.5'],
	['accept-encoding', 'gzip, deflate, br'],
	['connection', 'keep-alive'],
	['cookie', 'session=abc123; theme=dark; lang=en'],
	['cache-control', 'no-cache'],
];

// Warmup
for (let i = 0; i < 1000; i++) {
	new Request(origin + '/test?q=1', { method: 'GET', headers: headerPairs, duplex: 'half' });
}

// Measure Request construction only
console.log(`\nMicrobenchmark: new Request() x ${iterations.toLocaleString()}\n`);

const t0 = performance.now();
for (let i = 0; i < iterations; i++) {
	new Request(origin + '/test?q=1', { method: 'GET', headers: headerPairs, duplex: 'half' });
}
const t1 = performance.now();

const totalMs = t1 - t0;
const perReq = (totalMs / iterations * 1000).toFixed(2); // microseconds
const rateK = (iterations / totalMs).toFixed(1); // thousands per ms = millions per sec... no
const rateMil = (iterations / (totalMs / 1000)).toFixed(0);

console.log(`  Total: ${totalMs.toFixed(0)}ms for ${iterations.toLocaleString()} iterations`);
console.log(`  Per request: ${perReq} us`);
console.log(`  Throughput: ${Number(rateMil).toLocaleString()} req/s (single-threaded, no I/O)\n`);

// Measure header collection (simulated req.forEach)
const headerObj = {};
for (const [k, v] of headerPairs) headerObj[k] = v;

const t2 = performance.now();
for (let i = 0; i < iterations; i++) {
	const h = {};
	for (const k in headerObj) h[k] = headerObj[k];
	// Also simulate Object.entries for Request construction
	Object.entries(h);
}
const t3 = performance.now();

const headerMs = t3 - t2;
const headerPer = (headerMs / iterations * 1000).toFixed(2);
console.log(`  Header copy + Object.entries: ${headerMs.toFixed(0)}ms total, ${headerPer} us/req\n`);

// Measure Response construction + body reading
const t4 = performance.now();
for (let i = 0; i < iterations; i++) {
	new Response('Hello World', { status: 200, headers: { 'content-type': 'text/plain' } });
}
const t5 = performance.now();

const respMs = t5 - t4;
const respPer = (respMs / iterations * 1000).toFixed(2);
console.log(`  new Response() construction: ${respMs.toFixed(0)}ms total, ${respPer} us/req\n`);

// Measure Response body reading (getReader + read + read)
const t6 = performance.now();
let count = 0;
for (let i = 0; i < 100_000; i++) {
	const resp = new Response('Hello World', { status: 200, headers: { 'content-type': 'text/plain' } });
	const reader = resp.body.getReader();
	reader.read().then(({ value }) => { count += value.byteLength; return reader.read(); });
}
const t7 = performance.now();
// Wait for microtasks
await new Promise(r => setTimeout(r, 100));

const readMs = t7 - t6;
const readPer = (readMs / 100_000 * 1000).toFixed(2);
console.log(`  Response body getReader+read (100k): ${readMs.toFixed(0)}ms total, ${readPer} us/req\n`);

// AbortController creation cost
const t8 = performance.now();
for (let i = 0; i < iterations; i++) {
	new AbortController();
}
const t9 = performance.now();
const abortMs = t9 - t8;
const abortPer = (abortMs / iterations * 1000).toFixed(2);
console.log(`  new AbortController(): ${abortMs.toFixed(0)}ms total, ${abortPer} us/req\n`);
