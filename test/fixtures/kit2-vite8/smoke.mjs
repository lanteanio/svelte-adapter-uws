import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createServer } from 'node:net';
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const origin = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['build/index.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin }, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
let socket;
try {
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) { assert.equal(match[0], origin); ready = true; break; }
    assert.equal(child.exitCode, null, output);
    await delay(25);
  }
  assert.ok(ready, output);
  const response = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Kit 2 with Vite 8/);
  socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  const message = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
  socket.send('stock install');
  assert.equal((await message)[0].toString(), 'stock install');
  console.log('Kit 2/Vite 8 production HTTP and WebSocket smoke passed');
} finally {
  socket?.terminate();
  if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
}
