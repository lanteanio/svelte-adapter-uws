# svelte-adapter-uws

A SvelteKit adapter powered by [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) - the fastest HTTP/WebSocket server available for Node.js, written in C++ and exposed through V8.

I've been loving Svelte and SvelteKit for a long time. I always wanted to expand on the standard adapters, sifting through the internet from time to time, never finding what I was searching for - a proper high-performance adapter with first-class WebSocket support, native TLS, pub/sub built in, and a client library that just works. So I'm doing it myself.

## What you get

- **HTTP & HTTPS** - native TLS via uWebSockets.js `SSLApp`, no reverse proxy needed
- **WebSocket & WSS** - built-in pub/sub with a reactive Svelte client store
- **In-memory static file cache** - assets loaded once at startup, served from RAM with precompressed brotli/gzip variants
- **Backpressure handling** - streaming responses that won't blow up memory
- **Graceful shutdown** - waits for in-flight requests before exiting
- **Health check endpoint** - `/healthz` out of the box
- **Zero-config WebSocket** - just set `websocket: true` and go

---

## Table of contents

- [Installation](#installation)
- [Quick start: HTTP](#quick-start-http)
- [Quick start: HTTPS](#quick-start-https)
- [Quick start: WebSocket](#quick-start-websocket)
- [Quick start: WSS (secure WebSocket)](#quick-start-wss-secure-websocket)
- [Development, Preview & Production](#development-preview--production)
- [Adapter options](#adapter-options)
- [Environment variables](#environment-variables)
- [WebSocket handler (`hooks.ws`)](#websocket-handler-hooksws)
- [Authentication](#authentication)
- [Platform API (`event.platform`)](#platform-api-eventplatform)
- [Client store API](#client-store-api)
- [TypeScript setup](#typescript-setup)
- [Svelte 4 support](#svelte-4-support)
- [Deploying with Docker](#deploying-with-docker)
- [Clustering](#clustering)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

### Starting from scratch

If you don't have a SvelteKit project yet:

```bash
npx sv create my-app
cd my-app
npm install
```

### Adding the adapter

```bash
npm install svelte-adapter-uws
npm install uNetworking/uWebSockets.js#v20.60.0
```

> **Note:** uWebSockets.js is a native C++ addon installed directly from GitHub, not from npm. It may not compile on all platforms. Check the [uWebSockets.js README](https://github.com/uNetworking/uWebSockets.js) if you have issues.
>
> **Docker:** Use `node:22-trixie-slim` or another glibc >= 2.38 image. Bookworm-based images and Alpine won't work. See [Deploying with Docker](#deploying-with-docker).

If you plan to use WebSockets during development, also install `ws`:

```bash
npm install -D ws
```

---

## Quick start: HTTP

The simplest setup - just swap the adapter and you're done.

**svelte.config.js**
```js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter()
  }
};
```

**Build and run:**
```bash
npm run build
node build
```

Your app is now running on `http://localhost:3000`.

To change the host or port:
```bash
HOST=0.0.0.0 PORT=8080 node build
```

---

## Quick start: HTTPS

No reverse proxy needed. uWebSockets.js handles TLS natively with its `SSLApp`.

**svelte.config.js** - same as HTTP, no changes needed:
```js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter()
  }
};
```

**Build and run with TLS:**
```bash
npm run build
SSL_CERT=/path/to/cert.pem SSL_KEY=/path/to/key.pem node build
```

Your app is now running on `https://localhost:3000`.

> Both `SSL_CERT` and `SSL_KEY` must be set. Setting only one will throw an error.

### Behind a reverse proxy (nginx, Caddy, etc.)

If your proxy terminates TLS and forwards to HTTP:

```bash
ORIGIN=https://example.com node build
```

Or if you want flexible header-based detection:
```bash
PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host node build
```

> **Important:** `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER`, and `ADDRESS_HEADER` are trusted verbatim. Only set these when running behind a reverse proxy that overwrites the corresponding headers on every request. If the server is directly internet-facing, clients can spoof these values. When in doubt, use a fixed `ORIGIN` instead.

---

## Quick start: WebSocket

Three things to do:

1. **Enable WebSocket in the adapter**
2. **Add the Vite plugin** (for dev mode)
3. **Use the client store** in your Svelte components

### Step 1: Enable WebSocket

**svelte.config.js**
```js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter({
      websocket: true
    })
  }
};
```

That's it. This gives you a pub/sub WebSocket server at `/ws` with no authentication. Any client can connect, subscribe to topics, and receive messages.

### Step 2: Add the Vite plugin

This makes WebSockets work during `npm run dev`. Without this, `event.platform` won't have WebSocket methods in dev mode.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uwsDev from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uwsDev()]
};
```

### Step 3: Use the client store

**src/routes/+page.svelte**
```svelte
<script>
  import { on, status } from 'svelte-adapter-uws/client';

  // Subscribe to the 'notifications' topic
  // Auto-connects, auto-subscribes, auto-reconnects
  const notifications = on('notifications');
</script>

{#if $status === 'open'}
  <span>Connected</span>
{/if}

{#if $notifications}
  <p>Event: {$notifications.event}</p>
  <p>Data: {JSON.stringify($notifications.data)}</p>
{/if}
```

### Step 4: Publish from the server

**src/routes/api/notify/+server.js**
```js
export async function POST({ request, platform }) {
  const data = await request.json();

  // This sends to ALL clients subscribed to 'notifications'
  platform.publish('notifications', 'new-message', data);

  return new Response('OK');
}
```

**Build and run:**
```bash
npm run build
node build
```

---

## Quick start: WSS (secure WebSocket)

WSS works automatically when you enable TLS. WebSocket connections upgrade over the same HTTPS port.

**svelte.config.js**
```js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter({
      websocket: true
    })
  }
};
```

```bash
npm run build
SSL_CERT=/path/to/cert.pem SSL_KEY=/path/to/key.pem node build
```

The client store automatically uses `wss://` when the page is served over HTTPS - no configuration needed on the client side.

---

## Development, Preview & Production

### `npm run dev` - works (with the Vite plugin)

Development works as expected. The Vite plugin (`svelte-adapter-uws/vite`) spins up a `ws` WebSocket server alongside Vite's dev server, so your client store and `event.platform` work identically to production.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uwsDev from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uwsDev()]
};
```

Without the Vite plugin:
- HTTP routes work fine
- `event.platform` is `undefined` - any code calling `platform.publish()` will throw
- The client store will try to connect to `/ws` and fail silently (auto-reconnect will keep trying)

### `npm run preview` - WebSockets don't work

SvelteKit's preview server is Vite's built-in HTTP server. It doesn't know about uWebSockets.js or WebSocket upgrades. Your HTTP routes and SSR will work, but **WebSocket connections will fail**.

Use `node build` instead of preview for testing WebSocket features.

### `node build` - production, everything works

This is the real deal. uWebSockets.js handles everything:

```bash
npm run build
node build
```

Or with environment variables:
```bash
PORT=8080 HOST=0.0.0.0 node build
```

Or with TLS:
```bash
SSL_CERT=./cert.pem SSL_KEY=./key.pem PORT=443 node build
```

---

## Adapter options

```js
adapter({
  // Output directory for the build
  out: 'build', // default: 'build'

  // Precompress static assets with brotli and gzip
  precompress: true, // default: true

  // Prefix for environment variables (e.g. 'MY_APP_' -> MY_APP_PORT)
  envPrefix: '', // default: ''

  // Health check endpoint (set to false to disable)
  healthCheckPath: '/healthz', // default: '/healthz'

  // WebSocket configuration
  websocket: true // or false, or an options object (see below)
})
```

### WebSocket options

```js
adapter({
  websocket: {
    // Path for WebSocket connections
    path: '/ws', // default: '/ws'

    // Path to your custom handler module (auto-discovers src/hooks.ws.js if omitted)
    handler: './src/lib/server/websocket.js', // default: auto-discover

    // Max message size in bytes (connections sending larger messages are closed)
    maxPayloadLength: 16 * 1024, // default: 16 KB

    // Seconds of inactivity before the connection is closed
    idleTimeout: 120, // default: 120

    // Max bytes of backpressure per connection before messages are dropped.
    // uWS defaults to 64 KB; this adapter uses 1 MB to handle pub/sub spikes.
    // Lower this if you expect many slow consumers.
    maxBackpressure: 1024 * 1024, // default: 1 MB

    // Enable per-message deflate compression
    compression: false, // default: false

    // Automatically send pings to keep the connection alive
    sendPingsAutomatically: true, // default: true

    // Seconds before an async upgrade handler is rejected with 504
    upgradeTimeout: 10, // default: 10

    // Allowed origins for WebSocket connections
    // 'same-origin' - only accept where Origin matches Host and scheme (default)
    // '*' - accept from any origin
    // ['https://example.com'] - whitelist specific origins
    allowedOrigins: 'same-origin' // default: 'same-origin'
  }
})
```

---

## Environment variables

All variables are set at **runtime** (when you run `node build`), not at build time.

If you set `envPrefix: 'MY_APP_'` in the adapter config, all variables are prefixed (e.g. `MY_APP_PORT` instead of `PORT`).

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | Listen port |
| `ORIGIN` | *(derived)* | Fixed origin (e.g. `https://example.com`) |
| `SSL_CERT` | - | Path to TLS certificate file |
| `SSL_KEY` | - | Path to TLS private key file |
| `PROTOCOL_HEADER` | - | Header for protocol detection (e.g. `x-forwarded-proto`) |
| `HOST_HEADER` | - | Header for host detection (e.g. `x-forwarded-host`) |
| `PORT_HEADER` | - | Header for port override (e.g. `x-forwarded-port`) |
| `ADDRESS_HEADER` | - | Header for client IP (e.g. `x-forwarded-for`) |
| `XFF_DEPTH` | `1` | Position from right in `X-Forwarded-For` |
| `BODY_SIZE_LIMIT` | `512K` | Max request body size (supports `K`, `M`, `G` suffixes) |
| `SHUTDOWN_TIMEOUT` | `30` | Seconds to wait during graceful shutdown |
| `CLUSTER_WORKERS` | - | Number of worker threads (or `auto` for CPU count) |

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the server:
1. Stops accepting new connections
2. Emits a `sveltekit:shutdown` event on `process` (for cleanup hooks like closing database connections)
3. Waits for in-flight SSR requests to complete (up to `SHUTDOWN_TIMEOUT` seconds)
4. Exits

```js
// Listen for shutdown in your server code (e.g. hooks.server.js)
process.on('sveltekit:shutdown', async (reason) => {
  console.log(`Shutting down: ${reason}`);
  await db.close();
});
```

### Examples

```bash
# Simple HTTP
node build

# Custom port
PORT=8080 node build

# Behind nginx
ORIGIN=https://example.com node build

# Behind a proxy with forwarded headers
PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host ADDRESS_HEADER=x-forwarded-for node build

# Native TLS
SSL_CERT=./cert.pem SSL_KEY=./key.pem node build

# Everything at once
SSL_CERT=./cert.pem SSL_KEY=./key.pem PORT=443 HOST=0.0.0.0 BODY_SIZE_LIMIT=10M SHUTDOWN_TIMEOUT=60 node build
```

---

## WebSocket handler (`hooks.ws`)

### No handler needed (simplest)

With `websocket: true`, a built-in handler accepts all connections and handles subscribe/unsubscribe messages from the client store. No file needed.

> **Note:** `websocket: true` only sets up the server side. To actually receive messages in the browser, you need to import the client store (`on`, `crud`, etc.) in your Svelte components. Without the client store, the WebSocket endpoint exists but nothing connects to it.

### Auto-discovered handler

Create `src/hooks.ws.js` (or `.ts`, `.mjs`) and it will be automatically discovered - no config needed:

**src/hooks.ws.js**
```js
// Called during the HTTP -> WebSocket upgrade handshake.
// Return an object to accept (becomes ws.getUserData()).
// Return false to reject with 401.
// Omit this export to accept all connections.
export async function upgrade({ headers, cookies, url, remoteAddress }) {
  const sessionId = cookies.session_id;
  if (!sessionId) return false;

  const user = await validateSession(sessionId);
  if (!user) return false;

  // Whatever you return here is available as ws.getUserData()
  return { userId: user.id, name: user.name };
}

// Called when a connection is established
export function open(ws) {
  const { userId } = ws.getUserData();
  console.log(`User ${userId} connected`);

  // Subscribe this connection to a user-specific topic
  ws.subscribe(`user:${userId}`);
}

// Called when a message is received
// Note: subscribe/unsubscribe messages from the client store are
// handled automatically BEFORE this function is called
export function message(ws, data, isBinary) {
  const msg = JSON.parse(Buffer.from(data).toString());
  console.log('Got message:', msg);
}

// Called when a client tries to subscribe to a topic (optional)
// Return false to deny the subscription
export function subscribe(ws, topic) {
  const { role } = ws.getUserData();
  // Only admins can subscribe to admin topics
  if (topic.startsWith('admin') && role !== 'admin') return false;
}

// Called when the connection closes
export function close(ws, code, message) {
  const { userId } = ws.getUserData();
  console.log(`User ${userId} disconnected`);
}

// Called when backpressure has drained (optional, for flow control)
export function drain(ws) {
  // You can resume sending large messages here
}
```

### Explicit handler path

If your handler is somewhere other than `src/hooks.ws.js`:

```js
adapter({
  websocket: {
    handler: './src/lib/server/websocket.js'
  }
})
```

### What the handler gets

The `upgrade` function receives an `UpgradeContext`:

```js
{
  headers: { 'cookie': '...', 'host': 'localhost:3000', ... },  // all lowercase
  cookies: { session_id: 'abc123', theme: 'dark' },             // parsed from Cookie header
  url: '/ws',                                                    // request path
  remoteAddress: '127.0.0.1'                                     // client IP
}
```

The `subscribe` function receives `(ws, topic)` and can return `false` to deny a client's subscription request. Omit it to allow all subscriptions.

The `ws` object in `open`, `message`, `close`, and `drain` is a [uWebSockets.js WebSocket](https://github.com/uNetworking/uWebSockets.js). Key methods:

- `ws.getUserData()` - returns whatever `upgrade` returned
- `ws.subscribe(topic)` - subscribe to a topic for `app.publish()`
- `ws.unsubscribe(topic)` - unsubscribe from a topic
- `ws.send(data)` - send a message to this connection
- `ws.close()` - close the connection

---

## Authentication

WebSocket authentication uses the exact same cookies as your SvelteKit app. When the browser opens a WebSocket connection, it sends all cookies for the domain - including session cookies set by SvelteKit's `cookies.set()`. No tokens, no query parameters, no extra client-side code.

Here's the full flow from login to authenticated WebSocket:

### Step 1: Login sets a cookie (standard SvelteKit)

**src/routes/login/+page.server.js**
```js
import { authenticate, createSession } from '$lib/server/auth.js';

export const actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const email = form.get('email');
    const password = form.get('password');

    const user = await authenticate(email, password);
    if (!user) return { error: 'Invalid credentials' };

    const sessionId = await createSession(user.id);

    // This cookie is automatically sent on WebSocket upgrade requests
    cookies.set('session', sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      maxAge: 60 * 60 * 24 * 7 // 1 week
    });

    return { success: true };
  }
};
```

### Step 2: WebSocket handler reads the same cookie

**src/hooks.ws.js**
```js
import { getSession } from '$lib/server/auth.js';

export async function upgrade({ cookies }) {
  // Same cookie that SvelteKit set during login
  const sessionId = cookies.session;
  if (!sessionId) return false; // -> 401, connection rejected

  const user = await getSession(sessionId);
  if (!user) return false; // -> 401, expired or invalid session

  // Attach user data to the socket - available via ws.getUserData()
  return { userId: user.id, name: user.name, role: user.role };
}

export function open(ws) {
  const { userId, role } = ws.getUserData();
  console.log(`${userId} connected (${role})`);

  // Subscribe to user-specific and role-based topics
  ws.subscribe(`user:${userId}`);
  if (role === 'admin') ws.subscribe('admin');
}

export function close(ws) {
  const { userId } = ws.getUserData();
  console.log(`${userId} disconnected`);
}
```

### Step 3: Client - nothing special needed

**src/routes/dashboard/+page.svelte**
```svelte
<script>
  import { on, status } from 'svelte-adapter-uws/client';

  // The browser sends cookies automatically on the upgrade request.
  // If the session is invalid, the connection is rejected and
  // auto-reconnect will retry (useful if the user logs in later).
  const notifications = on('notifications');
  const userMessages = on('user-messages');
</script>

{#if $status === 'open'}
  <span>Authenticated & connected</span>
{:else if $status === 'connecting'}
  <span>Connecting...</span>
{:else}
  <span>Disconnected (not logged in?)</span>
{/if}
```

### Step 4: Send messages to specific users from anywhere

**src/routes/api/notify/+server.js**
```js
import { json } from '@sveltejs/kit';

export async function POST({ request, platform }) {
  const { userId, message } = await request.json();

  // Only that user receives this (they subscribed in open())
  platform.publish(`user:${userId}`, 'notification', { message });

  return json({ sent: true });
}
```

### Why this works

The WebSocket upgrade is an HTTP request. The browser treats it like any other request to your domain - it includes all cookies, follows the same-origin policy, and respects `httpOnly`/`secure`/`sameSite` flags. There's no difference between how cookies reach a `+page.server.js` load function and how they reach the `upgrade` handler.

| What | Where | Same cookies? |
|---|---|---|
| Page load | `+page.server.js` `load()` | Yes |
| Form action | `+page.server.js` `actions` | Yes |
| API route | `+server.js` | Yes |
| Server hook | `hooks.server.js` `handle()` | Yes |
| **WebSocket upgrade** | **`hooks.ws.js` `upgrade()`** | **Yes** |

---

## Platform API (`event.platform`)

Available in server hooks, load functions, form actions, and API routes.

### `platform.publish(topic, event, data)`

Send a message to all WebSocket clients subscribed to a topic:

```js
// src/routes/todos/+page.server.js
export const actions = {
  create: async ({ request, platform }) => {
    const formData = await request.formData();
    const todo = await db.createTodo(formData.get('text'));

    // Every client subscribed to 'todos' receives this
    platform.publish('todos', 'created', todo);

    return { success: true };
  }
};
```

### `platform.send(ws, topic, event, data)`

Send a message to a single WebSocket connection. Wraps in the same `{ topic, event, data }` envelope as `publish()`.

This is useful when you store WebSocket references (e.g. in a `Map`) and need to message specific connections from SvelteKit handlers:

```js
// src/hooks.ws.js - store connections by user ID
const userSockets = new Map();

export function open(ws) {
  const { userId } = ws.getUserData();
  userSockets.set(userId, ws);
}

export function close(ws) {
  const { userId } = ws.getUserData();
  userSockets.delete(userId);
}

// Export the map so SvelteKit handlers can access it
export { userSockets };
```

```js
// src/routes/api/dm/+server.js - send to a specific user
import { userSockets } from '../../hooks.ws.js';

export async function POST({ request, platform }) {
  const { targetUserId, message } = await request.json();
  const ws = userSockets.get(targetUserId);
  if (ws) {
    platform.send(ws, 'dm', 'new-message', { message });
  }
  return new Response('OK');
}
```

To reply directly from inside `hooks.ws.js` (where `platform` isn't available), use `ws.send()` with the envelope format:

```js
// src/hooks.ws.js
export function message(ws, rawData) {
  const msg = JSON.parse(Buffer.from(rawData).toString());
  // Reply to sender using the same envelope format the client store expects
  ws.send(JSON.stringify({ topic: 'echo', event: 'reply', data: { got: msg } }));
}
```

### `platform.sendTo(filter, topic, event, data)`

Send a message to all connections whose `userData` matches a filter function. Returns the number of connections the message was sent to.

This is simpler than manually maintaining a `Map` of connections - no `hooks.ws.js` needed:

```js
// src/routes/api/dm/+server.js - send to a specific user
export async function POST({ request, platform }) {
  const { targetUserId, message } = await request.json();
  const count = platform.sendTo(
    (userData) => userData.userId === targetUserId,
    'dm', 'new-message', { message }
  );
  return new Response(count > 0 ? 'Sent' : 'User offline');
}
```

```js
// Send to all admins
platform.sendTo(
  (userData) => userData.role === 'admin',
  'alerts', 'warning', { message: 'Server load high' }
);
```

### `platform.connections`

Number of active WebSocket connections:

```js
// src/routes/api/stats/+server.js
import { json } from '@sveltejs/kit';

export async function GET({ platform }) {
  return json({ online: platform.connections });
}
```

### `platform.subscribers(topic)`

Number of clients subscribed to a specific topic:

```js
export async function GET({ platform, params }) {
  return json({
    viewers: platform.subscribers(`page:${params.id}`)
  });
}
```

### `platform.topic(name)` - scoped helper

Reduces repetition when publishing multiple events to the same topic:

```js
// src/routes/todos/+page.server.js
export const actions = {
  create: async ({ request, platform }) => {
    const todos = platform.topic('todos');
    const todo = await db.create(await request.formData());
    todos.created(todo);  // shorthand for platform.publish('todos', 'created', todo)
  },

  update: async ({ request, platform }) => {
    const todos = platform.topic('todos');
    const todo = await db.update(await request.formData());
    todos.updated(todo);
  },

  delete: async ({ request, platform }) => {
    const todos = platform.topic('todos');
    const id = (await request.formData()).get('id');
    await db.delete(id);
    todos.deleted({ id });
  }
};
```

The topic helper also has counter methods:

```js
const online = platform.topic('online-users');
online.set(42);         // -> { event: 'set', data: 42 }
online.increment();     // -> { event: 'increment', data: 1 }
online.increment(5);    // -> { event: 'increment', data: 5 }
online.decrement();     // -> { event: 'decrement', data: 1 }
```

---

## Client store API

Import from `svelte-adapter-uws/client`. Everything auto-connects - you don't need to call `connect()` first.

### `on(topic)` - subscribe to a topic

The main function most users need. Returns a Svelte readable store that updates whenever a message is published to the topic.

> **Important:** The store starts as `null` (no message received yet). Always use `{#if $store}` before accessing properties, or you'll get "Cannot read properties of null".

```svelte
<script>
  import { on } from 'svelte-adapter-uws/client';

  // Full event envelope: { topic, event, data }
  const todos = on('todos');
</script>

<!-- ALWAYS guard with {#if} - $todos is null until the first message arrives -->
{#if $todos}
  <p>{$todos.event}: {JSON.stringify($todos.data)}</p>
{/if}

<!-- WRONG - will crash with "Cannot read properties of null" -->
<!-- <p>{$todos.event}</p> -->
```

### `on(topic, event)` - subscribe to a specific event

Filters to a single event name and wraps the payload in `{ data }`:

```svelte
<script>
  import { on } from 'svelte-adapter-uws/client';

  // Only 'created' events, wrapped in { data }
  const newTodo = on('todos', 'created');
</script>

{#if $newTodo}
  <p>New todo: {$newTodo.data.text}</p>
{/if}
```

### `.scan(initial, reducer)` - accumulate state

Like `Array.reduce` but reactive. Each new event feeds through the reducer:

```svelte
<script>
  import { on } from 'svelte-adapter-uws/client';

  const todos = on('todos').scan([], (list, { event, data }) => {
    if (event === 'created') return [...list, data];
    if (event === 'updated') return list.map(t => t.id === data.id ? data : t);
    if (event === 'deleted') return list.filter(t => t.id !== data.id);
    return list;
  });
</script>

{#each $todos as todo (todo.id)}
  <p>{todo.text}</p>
{/each}
```

### `crud(topic, initial?, options?)` - live CRUD list

One-liner for real-time collections. Handles `created`, `updated`, and `deleted` events automatically:

```svelte
<script>
  import { crud } from 'svelte-adapter-uws/client';

  let { data } = $props(); // from +page.server.js load()

  // $todos auto-updates when server publishes created/updated/deleted
  const todos = crud('todos', data.todos);
</script>

{#each $todos as todo (todo.id)}
  <p>{todo.text}</p>
{/each}
```

Options:
- `key` - property to match items by (default: `'id'`)
- `prepend` - add new items to the beginning instead of end (default: `false`)

```js
// Notifications, newest first
const notifications = crud('notifications', [], { prepend: true });

// Items keyed by 'slug' instead of 'id'
const posts = crud('posts', data.posts, { key: 'slug' });
```

Pair with `platform.topic()` on the server:

```js
// Server: +page.server.js
export const actions = {
  create: async ({ request, platform }) => {
    const todo = await db.create(await request.formData());
    platform.topic('todos').created(todo);      // client sees 'created'
  },
  update: async ({ request, platform }) => {
    const todo = await db.update(await request.formData());
    platform.topic('todos').updated(todo);      // client sees 'updated'
  },
  delete: async ({ request, platform }) => {
    await db.delete((await request.formData()).get('id'));
    platform.topic('todos').deleted({ id });    // client sees 'deleted'
  }
};
```

### `lookup(topic, initial?, options?)` - live keyed object

Like `crud()` but returns a `Record<string, T>` instead of an array. Better for dashboards and fast lookups:

```svelte
<script>
  import { lookup } from 'svelte-adapter-uws/client';

  let { data } = $props();
  const users = lookup('users', data.users);
</script>

{#if $users[selectedId]}
  <UserCard user={$users[selectedId]} />
{/if}
```

### `latest(topic, max?, initial?)` - ring buffer

Keeps the last N events. Perfect for chat, activity feeds, notifications:

```svelte
<script>
  import { latest } from 'svelte-adapter-uws/client';

  // Keep the last 100 chat messages
  const messages = latest('chat', 100);
</script>

{#each $messages as msg}
  <p><b>{msg.event}:</b> {msg.data.text}</p>
{/each}
```

### `count(topic, initial?)` - live counter

Handles `set`, `increment`, and `decrement` events:

```svelte
<script>
  import { count } from 'svelte-adapter-uws/client';

  const online = count('online-users');
</script>

<p>{$online} users online</p>
```

Server:
```js
platform.topic('online-users').increment();
platform.topic('online-users').decrement();
platform.topic('online-users').set(42);
```

### `once(topic, event?, options?)` - wait for one event

Returns a promise that resolves with the first matching event and then unsubscribes:

```js
import { once } from 'svelte-adapter-uws/client';

// Wait for any event on the 'jobs' topic
const event = await once('jobs');

// Wait for a specific event
const result = await once('jobs', 'completed');

// With a timeout (rejects if no event within 5 seconds)
const result = await once('jobs', 'completed', { timeout: 5000 });

// Timeout without event filter
const event = await once('jobs', { timeout: 5000 });
```

### `status` - connection status

Readable store with the current connection state:

```svelte
<script>
  import { status } from 'svelte-adapter-uws/client';
</script>

{#if $status === 'open'}
  <span class="badge green">Live</span>
{:else if $status === 'connecting'}
  <span class="badge yellow">Connecting...</span>
{:else}
  <span class="badge red">Disconnected</span>
{/if}
```

### `ready()` - wait for connection

Returns a promise that resolves when the WebSocket connection is open:

```js
import { ready } from 'svelte-adapter-uws/client';

await ready();
// connection is now open, safe to send messages
```

### `connect(options?)` - power-user API

Most users don't need this - `on()` and `status` auto-connect. Use `connect()` when you need `close()`, `send()`, or custom options:

```js
import { connect } from 'svelte-adapter-uws/client';

const ws = connect({
  path: '/ws',               // default: '/ws'
  reconnectInterval: 3000,   // default: 3000 ms
  maxReconnectInterval: 30000, // default: 30000 ms
  maxReconnectAttempts: Infinity, // default: Infinity
  debug: true                // default: false - turn this on to see everything!
});

// With debug: true, you'll see every WebSocket event in the browser console:
//   [ws] connected
//   [ws] subscribe -> todos
//   [ws] <- todos created { id: 1, text: "Buy milk" }
//   [ws] send -> { type: "ping" }
//   [ws] disconnected
//   [ws] queued -> { type: "important" }
//   [ws] resubscribe -> todos
//   [ws] flush -> { type: "important" }

// Manual topic management
ws.subscribe('chat');
ws.unsubscribe('chat');

// Send custom messages to the server
ws.send({ type: 'ping' });

// Send with queue (messages queue up while disconnected, flush on reconnect)
ws.sendQueued({ type: 'important', data: '...' });

// Permanent disconnect (won't auto-reconnect)
ws.close();
```

---

## TypeScript setup

Add the platform type to your `src/app.d.ts`:

```ts
import type { Platform as AdapterPlatform } from 'svelte-adapter-uws';

declare global {
  namespace App {
    interface Platform extends AdapterPlatform {}
  }
}

export {};
```

Now `event.platform.publish()`, `event.platform.topic()`, etc. are fully typed.

---

## Svelte 4 support

This adapter supports both Svelte 4 and Svelte 5. All examples in this README use Svelte 5 syntax (`$props()`, runes). If you're on Svelte 4, here's how to translate:

**Svelte 5 (used in examples)**
```svelte
<script>
  import { crud } from 'svelte-adapter-uws/client';

  let { data } = $props();
  const todos = crud('todos', data.todos);
</script>
```

**Svelte 4 equivalent**
```svelte
<script>
  import { crud } from 'svelte-adapter-uws/client';

  export let data;
  const todos = crud('todos', data.todos);
</script>
```

The only difference is how you receive props. The client store API (`on`, `crud`, `lookup`, `latest`, `count`, `once`, `status`, `connect`) works identically in both versions - it uses `svelte/store` which hasn't changed.

---

## Deploying with Docker

uWebSockets.js is a native C++ addon, so your Docker image needs to match the platform it was compiled for. Build inside the container to be safe.

```dockerfile
FROM node:22-trixie-slim AS build

# git is required - uWebSockets.js is installed from GitHub, not npm
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage - no git needed
FROM node:22-trixie-slim

WORKDIR /app
COPY --from=build /app/build build/
COPY --from=build /app/node_modules node_modules/
COPY package.json .

EXPOSE 3000
CMD ["node", "build"]
```

With TLS:
```dockerfile
CMD ["sh", "-c", "SSL_CERT=/certs/cert.pem SSL_KEY=/certs/key.pem node build"]
```

With environment variables:
```bash
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e ORIGIN=https://example.com \
  my-app
```

> **Important:** Use Debian Trixie or Ubuntu 24.04+ based images (glibc >= 2.38). Bookworm-based images (`node:*-slim`, `node:*-bookworm`) ship glibc 2.36 which is too old for uWebSockets.js. Don't use Alpine either - uWebSockets.js binaries are compiled against glibc, not musl.

---

## Clustering

The adapter supports multi-core scaling via uWebSockets.js worker thread distribution. A primary thread creates an acceptor app that distributes incoming connections across worker threads, each running their own uWS instance. This works on **all platforms** (Linux, macOS, Windows).

Set the `CLUSTER_WORKERS` environment variable to enable it:

```bash
# Use all available CPU cores
CLUSTER_WORKERS=auto node build

# Fixed number of workers
CLUSTER_WORKERS=4 node build

# Combined with other options
CLUSTER_WORKERS=auto PORT=8080 ORIGIN=https://example.com node build
```

If a worker crashes, it is automatically restarted with exponential backoff. On `SIGTERM`/`SIGINT`, the primary tells all workers to drain in-flight requests and shut down gracefully.

### WebSocket + clustering

`platform.publish()` is automatically relayed across all workers via the primary thread, so subscribers on any worker receive the message. This is built in — no external pub/sub needed.

Per-worker limitations (acceptable for most apps):
- `platform.connections` — returns the count for the local worker only
- `platform.subscribers(topic)` — returns the count for the local worker only
- `platform.sendTo(filter, ...)` — only reaches connections on the local worker

---

## Performance

### Why uWebSockets.js?

uWebSockets.js is a C++ HTTP and WebSocket server compiled to a native V8 addon. It consistently outperforms Node.js' built-in `http` module, Express, Fastify, and every other JavaScript HTTP server by a significant margin.

We ran a comprehensive benchmark suite isolating every layer of overhead - from barebones uWS through the full adapter pipeline - and compared against `@sveltejs/adapter-node` (Node http + Polka + sirv) and the most popular WebSocket libraries (`socket.io`, `ws`). The benchmark code is in the [`bench/`](bench/) directory so you can reproduce it yourself.

### HTTP: adapter-uws vs adapter-node

Tested with a trivial SvelteKit handler (isolates adapter overhead from your app code):

| | adapter-uws | adapter-node | Multiplier |
|---|---|---|---|
| **Static files** | 135,300 req/s | 20,100 req/s | **6.7x faster** |
| **SSR** | 125,100 req/s | 53,900 req/s | **2.3x faster** |

<sup>100 connections, 10 pipelining, 10s, 2 runs averaged. Node v24, Windows 11.</sup>

The static file gap is the largest because `adapter-node` uses sirv which calls `fs.createReadStream().pipe(res)` per request, while we serve from an in-memory `Map` with a single `res.cork()` + `res.end()`. The SSR gap comes from uWS's C++ HTTP parsing and batched writes vs Node's async drain event cycle.

### WebSocket: uWS vs socket.io vs ws

50 connected clients, 10 senders, burst mode, 8 seconds:

| Server | Messages delivered/s | vs adapter-uws |
|---|---|---|
| **uWS native** (barebones) | 3,625,000 | 1.0x |
| **adapter-uws** (full handler) | 3,642,000 | baseline |
| **socket.io** | 177,200 | **20.5x slower** |
| **ws** library | 164,500 | **22.1x slower** |

uWS native pub/sub delivered 3.6M messages/s with perfect 50x fan-out. After optimization, the adapter matches it -- the byte-prefix check and string template envelope add near-zero overhead to the hot path. `socket.io` and `ws` both collapsed under the same load, delivering less than 1x fan-out (massive message loss/queueing).

### Where the overhead goes

**HTTP (SSR path) - 23% total overhead vs barebones uWS:**

| Layer | Cost | Notes |
|---|---|---|
| `res.cork()` + status + headers | 11.4% | Writing a proper HTTP response - unavoidable |
| `new Request()` construction | 9.7% | Required by SvelteKit's `server.respond()` contract |
| Response body reader loop | ~2% | `getReader()` + `read()` + async scheduling |
| Header collection, AbortController | ~0% | Measured at 0.08us and 0.004us per request |

**WebSocket - optimized down from 27% to ~4% overhead vs barebones uWS pub/sub:**

The two largest WebSocket costs were `JSON.parse()` on every message for the subscribe/unsubscribe check (15%) and `JSON.stringify()` for envelope wrapping (8%). Both have been optimized:

| Layer | Before | After | How |
|---|---|---|---|
| Subscribe/unsubscribe check | ~15% | ~0% | Byte-prefix discriminator: control messages start with `{"ty` (byte[3]=`y`), user envelopes start with `{"to` (byte[3]=`o`). A single byte comparison skips `JSON.parse` for all regular messages -- from 0.39us to 0.001us per message. |
| Envelope wrapping | ~8% | ~4.5% | String template with `esc()` validation instead of `JSON.stringify` on a wrapper object. Topic and event names are validated with a fast char scan (~10ns) that throws on quotes, backslashes, or control characters — only `data` is stringified. From 0.135us to ~0.085us per publish. |
| Connection tracking | ~2% | ~2% | Unchanged |
| Origin validation, upgrade headers | ~2% | ~2% | Unchanged |

**What we don't add:**
- No middleware chain (no Polka, no Express)
- No routing layer (uWS native routing + SvelteKit's router)
- No per-request stream allocation for static files (in-memory Buffer, not `fs.createReadStream`)
- No Node.js `http.IncomingMessage` shim (we construct `Request` directly from uWS)

### The bottom line

The adapter retains 77% of raw uWS HTTP throughput and ~96% of raw uWS WebSocket throughput. The HTTP overhead is dominated by things SvelteKit requires (`new Request()`, proper HTTP headers). The WebSocket overhead is now almost entirely the `JSON.stringify` of your `data` payload -- the adapter's own machinery costs near zero. In a real app, your load functions and component rendering will dwarf all of this -- the adapter's job is to get out of the way, and it does.

To run the benchmarks yourself:

```bash
npm install  # installs uWebSockets.js, autocannon, etc.
node bench/run.mjs          # adapter overhead breakdown
node bench/run-compare.mjs  # full comparison vs adapter-node + socket.io
```

---

## Full example: real-time todo list

Here's a complete example tying everything together.

**svelte.config.js**
```js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter({
      websocket: true
    })
  }
};
```

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uwsDev from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uwsDev()]
};
```

**src/routes/todos/+page.server.js**
```js
import { db } from '$lib/server/db.js';

export async function load() {
  return { todos: await db.getTodos() };
}

export const actions = {
  create: async ({ request, platform }) => {
    const text = (await request.formData()).get('text');
    const todo = await db.createTodo(text);
    platform.topic('todos').created(todo);
  },

  toggle: async ({ request, platform }) => {
    const id = (await request.formData()).get('id');
    const todo = await db.toggleTodo(id);
    platform.topic('todos').updated(todo);
  },

  delete: async ({ request, platform }) => {
    const id = (await request.formData()).get('id');
    await db.deleteTodo(id);
    platform.topic('todos').deleted({ id });
  }
};
```

**src/routes/todos/+page.svelte**
```svelte
<script>
  import { crud, status } from 'svelte-adapter-uws/client';

  let { data } = $props();
  const todos = crud('todos', data.todos);
</script>

{#if $status === 'open'}
  <span>Live</span>
{/if}

<form method="POST" action="?/create">
  <input name="text" placeholder="New todo..." />
  <button>Add</button>
</form>

<ul>
  {#each $todos as todo (todo.id)}
    <li>
      <form method="POST" action="?/toggle">
        <input type="hidden" name="id" value={todo.id} />
        <button>{todo.done ? 'Undo' : 'Done'}</button>
      </form>
      <span class:done={todo.done}>{todo.text}</span>
      <form method="POST" action="?/delete">
        <input type="hidden" name="id" value={todo.id} />
        <button>Delete</button>
      </form>
    </li>
  {/each}
</ul>
```

Open the page in two browser tabs. Create, toggle, or delete a todo in one tab - it appears in the other tab instantly.

---

## Troubleshooting

### "WebSocket works in production but not in dev"

You need the Vite plugin. Without it, there's no WebSocket server running during `npm run dev`.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uwsDev from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uwsDev()]
};
```

Also make sure `ws` is installed:
```bash
npm install -D ws
```

### "Cannot read properties of undefined (reading 'publish')"

This means `event.platform` is `undefined`. Two possible causes:

**Cause 1: Missing Vite plugin in dev mode**

Same fix as above - add `uwsDev()` to your `vite.config.js`.

**Cause 2: Calling `platform` on the client side**

`event.platform` only exists on the server. If you're calling it in a `+page.svelte` or `+layout.svelte` file, move that code to `+page.server.js` or `+server.js`.

```js
// WRONG - +page.svelte (client-side)
platform.publish('todos', 'created', todo);

// RIGHT - +page.server.js (server-side)
export const actions = {
  create: async ({ platform }) => {
    platform.publish('todos', 'created', todo);
  }
};
```

### "WebSocket connects but immediately disconnects (and keeps reconnecting)"

Your `upgrade` handler is returning `false`, which rejects the connection with 401. The client store's auto-reconnect then tries again, gets rejected again, and so on.

**To debug**, enable debug mode on the client:
```js
import { connect } from 'svelte-adapter-uws/client';
connect({ debug: true });
```

Then check the browser's Network tab -> WS tab. You'll see the upgrade request and its 401 response.

**Common causes:**
- The session cookie isn't being set (check your login action)
- The cookie name doesn't match (`cookies.session` vs `cookies.session_id`)
- The session expired or is invalid
- `sameSite: 'strict'` can block cookies on cross-origin navigations - try `'lax'` if you're redirecting from an external site

### "WebSocket doesn't work with `npm run preview`"

This is expected. SvelteKit's preview server is Vite's built-in HTTP server - it doesn't know about WebSocket upgrades. Use `node build` instead:

```bash
npm run build
node build
```

### "Could not load uWebSockets.js"

uWebSockets.js is a native C++ addon. It's installed from GitHub, not npm, and needs to compile for your platform.

```bash
# Make sure you're using the right install command (no uWebSockets.js@ prefix)
npm install uNetworking/uWebSockets.js#v20.60.0
```

**On Windows:** Make sure you have the Visual C++ Build Tools installed. You can get them from the [Visual Studio Installer](https://visualstudio.microsoft.com/downloads/) (select "Desktop development with C++").

**On Linux:** Make sure `build-essential` is installed:
```bash
sudo apt install build-essential
```

**On Docker:** Use a Trixie-based image with git:
```dockerfile
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
```

### "I can't see what's happening with WebSocket messages"

Turn on debug mode. It logs every WebSocket event to the browser console:

```svelte
<script>
  import { connect } from 'svelte-adapter-uws/client';

  // Call this once, anywhere - it's a singleton
  connect({ debug: true });
</script>
```

You'll see output like:
```
[ws] connected
[ws] subscribe -> todos
[ws] <- todos created {"id":1,"text":"Buy milk"}
[ws] disconnected
[ws] resubscribe -> todos
```

### "Messages are arriving but my store isn't updating"

Make sure the topic names match exactly between server and client:

```js
// Server
platform.publish('todos', 'created', todo);  // topic: 'todos'

// Client - must match exactly
const todos = on('todos');     // 'todos' - correct
const todos = on('Todos');     // 'Todos' - WRONG, case sensitive
const todos = on('todo');      // 'todo'  - WRONG, singular vs plural
```

### "How do I see what the message envelope looks like?"

Every message sent through `platform.publish()` or `platform.topic().created()` arrives as JSON with this shape:

```json
{
  "topic": "todos",
  "event": "created",
  "data": { "id": 1, "text": "Buy milk", "done": false }
}
```

The client store parses this automatically. When you use `on('todos')`, the store value is:
```js
{ topic: 'todos', event: 'created', data: { id: 1, text: 'Buy milk', done: false } }
```

When you use `on('todos', 'created')`, you get the payload wrapped in `{ data }`:
```js
{ data: { id: 1, text: 'Buy milk', done: false } }
```

### "WebSocket works locally but not behind nginx/Caddy"

Your reverse proxy needs to forward WebSocket upgrade requests. Here's a complete nginx config that handles both your app and WebSocket:

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # WebSocket - must be listed before the catch-all
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else - your SvelteKit app
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then run your app with:
```bash
PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=host ADDRESS_HEADER=x-forwarded-for node build
```

For Caddy, it just works - Caddy proxies WebSocket upgrades automatically, no special config needed:

```
example.com {
    reverse_proxy localhost:3000
}
```

### "I want to use a different WebSocket path"

Set it in both the adapter config and the client:

**svelte.config.js**
```js
adapter({
  websocket: {
    path: '/my-ws'
  }
})
```

**Client**
```js
import { connect } from 'svelte-adapter-uws/client';
connect({ path: '/my-ws' });
```

Or if you're using `on()` directly (which auto-connects), call `connect()` first:

```svelte
<script>
  import { connect, on } from 'svelte-adapter-uws/client';

  // Set the path before any on() calls
  connect({ path: '/my-ws' });

  const todos = on('todos');
</script>
```

---

## License

[MIT](LICENSE)
