# svelte-adapter-uws

A SvelteKit adapter powered by [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) - the fastest HTTP/WebSocket server available for Node.js, written in C++ and exposed through V8.

I've been loving Svelte and SvelteKit for a long time. I always wanted to expand on the standard adapters, sifting through the internet from time to time, never finding what I was searching for - a proper high-performance adapter with first-class WebSocket support, native TLS, pub/sub built in, and a client library that just works. So I'm doing it myself.

## What you get

- **HTTP & HTTPS** - native TLS via uWebSockets.js `SSLApp`, no reverse proxy needed
- **WebSocket & WSS** - built-in pub/sub with a reactive Svelte client store
- **In-memory static file cache** - assets loaded once at startup, served from RAM with precompressed brotli/gzip variants
- **Dynamic response compression** - SSR HTML and API JSON compressed on the fly with brotli or gzip
- **Backpressure handling** - streaming responses that won't blow up memory
- **Graceful shutdown** - waits for in-flight requests before exiting
- **Health check endpoint** - `/healthz` out of the box
- **Zero-config WebSocket** - just set `websocket: true` and go

---

## Table of contents

**Getting started**
- [Installation](#installation)
- [Quick start: HTTP](#quick-start-http)
- [Quick start: HTTPS](#quick-start-https)
- [Quick start: WebSocket](#quick-start-websocket)
- [Quick start: WSS (secure WebSocket)](#quick-start-wss-secure-websocket)
- [Development, Preview & Production](#development-preview--production)

**Configuration**
- [Adapter options](#adapter-options)
- [Environment variables](#environment-variables)
- [TypeScript setup](#typescript-setup)
- [Svelte 4 support](#svelte-4-support)

**WebSocket deep dive**
- [WebSocket handler (`hooks.ws`)](#websocket-handler-hooksws)
- [Authentication](#authentication)
- [Refreshing session cookies on WebSocket connect](#refreshing-session-cookies-on-websocket-connect)
- [Platform API (`event.platform`)](#platform-api-eventplatform)
- [Client store API](#client-store-api)
- [Seeding initial state](#seeding-initial-state)

**Plugins**
- [Middleware](#middleware)
- [Replay (SSR gap)](#replay-ssr-gap)
- [Presence](#presence)
- [Typed channels](#typed-channels)
- [Throttle/debounce](#throttledebounce)
- [Rate limiting](#rate-limiting)
- [Cursor (ephemeral state)](#cursor-ephemeral-state)
- [Queue (ordered delivery)](#queue-ordered-delivery)
- [Broadcast groups](#broadcast-groups)

**Deployment & scaling**
- [Deploying with Docker](#deploying-with-docker)
- [Clustering](#clustering)
- [OS tuning for production](#os-tuning-for-production)
- [Performance](#performance)

**Examples**
- [Full example: real-time todo list](#full-example-real-time-todo-list)

**Help**
- [Troubleshooting](#troubleshooting)
- [Related projects](#related-projects)
- [License](#license)

---

**Getting started**

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

### Step 2: Add the Vite plugin (required)

The Vite plugin is **required** when using WebSockets. It does two things:

1. **Dev mode** - spins up a WebSocket server so `event.platform` works during `npm run dev`
2. **Production builds** - runs your `hooks.ws` file through Vite's pipeline so `$lib`, `$env`, and `$app` imports resolve correctly

Without it, your `hooks.ws` file won't be able to import from `$lib` or use `$env` variables, and `event.platform` won't work in dev.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uws()]
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

The Vite plugin is required for WebSocket support in both dev and production (see [Step 2](#step-2-add-the-vite-plugin-required)). It spins up a `ws` WebSocket server alongside Vite's dev server, so your client store and `event.platform` work identically to production.

Changes to your `hooks.ws` file are picked up automatically -- the plugin reloads the handler on save and closes existing connections so they reconnect with the new code. No dev server restart needed.

**Note:** The dev server does not enforce `allowedOrigins`. Origin checks only run in production. A warning is logged at startup as a reminder.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uws()]
};
```

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

**Configuration**

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

    // Seconds before an async upgrade handler is rejected with 504 (0 to disable)
    upgradeTimeout: 10, // default: 10

    // Sliding-window rate limit: max WebSocket upgrade requests per IP per window.
    // Prevents connection flood attacks. Uses a sliding window so a client cannot
    // double the effective rate by placing requests at a fixed-window boundary.
    // Set to 0 to disable.
    upgradeRateLimit: 10,       // default: 10
    upgradeRateLimitWindow: 10, // window size in seconds, default: 10

    // Allowed origins for WebSocket connections
    // 'same-origin' - only accept where Origin matches Host and scheme (default)
    // '*' - accept from any origin
    // ['https://example.com'] - whitelist specific origins
    // Requests without an Origin header (non-browser clients) are rejected
    // unless an upgrade handler is configured to authenticate them.
    allowedOrigins: 'same-origin' // default: 'same-origin'
  }
})
```

### Backpressure and connection limits

These options control how the server handles misbehaving or slow clients at the WebSocket level:

**`maxPayloadLength`** (default: 16 KB) -- the maximum size of a single incoming WebSocket message. If a client sends a message larger than this, uWS closes the connection immediately (not just the message -- the entire connection is dropped). Set this based on the largest message your application expects to receive.

**`maxBackpressure`** (default: 1 MB) -- the per-connection outbound send buffer. When a client reads slower than the server writes, messages queue up in this buffer. Once it overflows, subsequent `send()` and `publish()` calls for that connection silently drop the message. The `drain` hook fires when the buffer empties again. Lower this if you expect many slow consumers to avoid per-connection memory bloat.

**`upgradeRateLimit`** (default: 10 per 10s window) -- sliding-window rate limit on WebSocket upgrade requests per client IP. Clients exceeding the limit get a `429 Too Many Requests` response. The IP rate map is capped at 10,000 entries with LRU eviction by activity score, so sustained connection floods from many IPs don't cause unbounded memory growth.

### Static file behavior

All static assets (from the `client/` and `prerendered/` output directories) are loaded once at startup and served directly from RAM. Each response automatically includes:

- `Content-Type`: detected from the file extension
- `Vary: Accept-Encoding`: required for correct CDN/proxy caching when serving precompressed variants
- `Accept-Ranges: bytes`: enables partial content requests (e.g. for download resume)
- `X-Content-Type-Options: nosniff`: prevents MIME-type sniffing in browsers
- `ETag`: derived from the file's modification time and size; enables `304 Not Modified` responses
- `Cache-Control: public, max-age=31536000, immutable`: for versioned assets under `/_app/immutable/`
- `Cache-Control: no-cache`: for all other assets (forces ETag revalidation)

**Range requests (HTTP 206):** The server handles `Range: bytes=start-end` requests for static files. Single byte ranges are supported (`bytes=0-499`, `bytes=-500`, `bytes=500-`). Multi-range requests (comma-separated) are served as full `200` responses. An unsatisfiable range returns `416 Range Not Satisfiable`. When a `Range` header is present, the response is always served uncompressed so byte offsets are correct. The `If-Range` header is respected: if it doesn't match the file's ETag, the full file is returned.

Files with extensions that browsers cannot render inline (`.zip`, `.tar`, `.tgz`, `.exe`, `.dmg`, `.pkg`, `.deb`, `.apk`, `.iso`, `.img`, `.bin`, etc.) automatically receive `Content-Disposition: attachment` so browsers prompt a download dialog instead of attempting to display them.

If `precompress: true` is set in the adapter options, brotli (`.br`) and gzip (`.gz`) precompressed variants are loaded at startup and served when the client's `Accept-Encoding` header includes `br` or `gzip`. Precompressed variants are only used when they are smaller than the original file.

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
| `CLUSTER_MODE` | *(auto)* | `reuseport` (Linux default) or `acceptor` (other platforms) |
| `WS_DEBUG` | - | Set to `1` to enable structured WebSocket debug logging (open, close, subscribe, publish) |

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the server:
1. Stops accepting new connections
2. Waits for in-flight SSR requests to complete (up to `SHUTDOWN_TIMEOUT` seconds)
3. Emits a `sveltekit:shutdown` event on `process` (for cleanup hooks like closing database connections)
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

**WebSocket deep dive**

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
export function open(ws, { platform }) {
  const { userId } = ws.getUserData();
  console.log(`User ${userId} connected`);

  // Subscribe this connection to a user-specific topic
  ws.subscribe(`user:${userId}`);
}

// Called when a message is received
// Note: subscribe/unsubscribe messages from the client store are
// handled automatically BEFORE this function is called
export function message(ws, { data, isBinary }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  console.log('Got message:', msg);
}

// Called when a client tries to subscribe to a topic (optional)
// Return false to deny the subscription
export function subscribe(ws, topic, { platform }) {
  const { role } = ws.getUserData();
  // Only admins can subscribe to admin topics
  if (topic.startsWith('admin') && role !== 'admin') return false;
}

// Called when a client unsubscribes from a topic (optional)
// Use this to clean up per-topic state (presence, groups, etc.)
export function unsubscribe(ws, topic, { platform }) {
  console.log(`Unsubscribed from ${topic}`);
}

// Called when the connection closes
export function close(ws, { code, message, platform }) {
  const { userId } = ws.getUserData();
  console.log(`User ${userId} disconnected`);
}

// Called when backpressure has drained (optional, for flow control)
export function drain(ws, { platform }) {
  // You can resume sending large messages here
}
```

### Message protocol

The adapter uses a JSON envelope format for all pub/sub messages: `{ topic, event, data }`. Control messages from the client store (`subscribe`, `unsubscribe`, `subscribe-batch`) use `{ type, topic }` or `{ type, topics }`.

To avoid JSON-parsing every incoming message, the handler uses a byte-prefix discriminator: control messages start with `{"type"` (byte 3 is `y`), while user envelopes start with `{"topic"` (byte 3 is `o`). A single byte comparison skips `JSON.parse` entirely for user messages. Messages over 8 KB are also skipped (generous ceiling for `subscribe-batch` with many topics, well above any realistic control message).

### Topic validation

Topics submitted by clients are validated before being accepted:

- Must be between 1 and 256 characters
- Must not contain control characters (code points below 32)
- `subscribe-batch` accepts at most 256 topics per message (the client only sends what it was subscribed to before a reconnect)

Topics prefixed with `__` are reserved for adapter plugins (presence uses `__presence:*`, replay uses `__replay:*`). They are not blocked at the protocol level because plugins subscribe to them from the client, but application code should not use the `__` prefix for its own topics.

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
  url: '/ws?token=abc',                                           // request path + query string
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
  // To refresh the session cookie on connect, use the `authenticate` hook
  // (see "Refreshing session cookies on WebSocket connect" below).
  // `upgradeResponse()` with custom non-cookie headers is also supported:
  // return upgradeResponse({ userId: user.id }, { 'x-session-version': '2' });
  return { userId: user.id, name: user.name, role: user.role };
}

export function open(ws, { platform }) {
  const { userId, role } = ws.getUserData();
  console.log(`${userId} connected (${role})`);

  // Subscribe to user-specific and role-based topics
  ws.subscribe(`user:${userId}`);
  if (role === 'admin') ws.subscribe('admin');
}

export function close(ws, { platform }) {
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

### Refreshing session cookies on WebSocket connect

For short-lived sessions you often want to rotate the session cookie every time a client connects. The obvious approach -- attaching `Set-Cookie` to the 101 Switching Protocols response via `upgradeResponse()` -- is RFC-compliant but **is silently rejected by Cloudflare Tunnel, Cloudflare's proxy, and some other strict edge proxies**. The symptom is that the WebSocket `open` handler fires server-side, then the connection closes with code 1006 (`Received TCP FIN before WebSocket close frame`) before any frames are exchanged. The adapter emits a build-time warning when it detects this pattern.

The adapter ships a first-class solution: the optional `authenticate` hook runs as a normal HTTP POST **before** the WebSocket upgrade. `Set-Cookie` rides on a standard 2xx response, which every proxy handles correctly; the browser then attaches the refreshed cookie to the upgrade request that follows.

**Step 1: add an `authenticate` export to `hooks.ws.js`**

```js
// src/hooks.ws.js
import { getSession, renewSession } from '$lib/server/auth.js';

// Runs as POST /__ws/auth, before the WebSocket upgrade.
// cookies.set() becomes Set-Cookie on a standard 204 response.
export async function authenticate({ cookies }) {
  const session = await getSession(cookies.get('session'));
  if (!session) return false; // -> 401, client does not open the WebSocket

  const renewed = await renewSession(session);
  cookies.set('session', renewed.token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7
  });
}

// Your existing upgrade() hook stays unchanged - it reads the now-fresh cookie.
export async function upgrade({ cookies }) {
  const session = await getSession(cookies.session);
  if (!session) return false;
  return { userId: session.userId, role: session.role };
}
```

The `authenticate` event exposes the SvelteKit event shape you already know: `{ request, headers, cookies, url, remoteAddress, getClientAddress, platform }`. Return values:

- `undefined` / nothing - success, responds `204 No Content` with any `Set-Cookie` headers from `cookies.set()` (recommended).
- `false` - responds `401 Unauthorized`. The client does not open the WebSocket.
- A full `Response` - used as-is; any `cookies.set()` calls are merged in.

**Step 2: opt in from the client**

```js
import { connect } from 'svelte-adapter-uws/client';

// Hit /__ws/auth before every WebSocket connect (including reconnects)
connect({ auth: true });

// Or point at a custom path (e.g. behind a Cloudflare Access rule)
connect({ auth: '/api/ws-auth' });
```

With `auth: true` the client stores runs `fetch('/__ws/auth', { method: 'POST', credentials: 'include' })` before every `new WebSocket(...)` call, including after automatic reconnects. Concurrent connect attempts share a single in-flight preflight. A `4xx` response is treated as terminal (the user is not authenticated); `5xx` and network errors fall back to the normal reconnect backoff.

**Configuration**

- The default auth path is `/__ws/auth`. Override with `adapter({ websocket: { authPath: '/api/ws-auth' } })`.
- The hook is only mounted when `authenticate` is exported from `hooks.ws` -- no runtime cost when unused.
- Dev mode (Vite plugin) mirrors the production route on the same path.

**Why not put `Set-Cookie` on the 101?**

Cloudflare's HTTP/2 WebSocket bridging rewrites 101 responses, and `Set-Cookie` on the 101 trips the edge into tearing the connection down. This is undocumented Cloudflare behavior, but reproducible on every tunnel and proxy connector. The `authenticate` hook sidesteps it entirely by using a standard HTTP response.

---

## Platform API (`event.platform`)

Available in server hooks, load functions, form actions, API routes, and WebSocket hooks (`hooks.ws`).

### `platform.publish(topic, event, data, options?)`

Send a message to all WebSocket clients subscribed to a topic.

Topic and event names are validated before being written into the JSON envelope -- quotes, backslashes, and control characters will throw. This prevents JSON injection when names are built from dynamic values like user IDs (`platform.publish(\`user:\${id}\`, ...)`). The validation is a single-pass char scan and adds no measurable overhead.

In cluster mode, the message is automatically relayed to all other workers. Pass `{ relay: false }` to skip the relay when the message originates from an external pub/sub source (Redis, Postgres LISTEN/NOTIFY, etc.) that already delivers to every process:

```js
// Redis subscriber running on every worker -- relay would cause duplicates
sub.on('message', (channel, payload) => {
  platform.publish(channel, 'update', JSON.parse(payload), { relay: false });
});
```

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

export function open(ws, { platform }) {
  const { userId } = ws.getUserData();
  userSockets.set(userId, ws);
}

export function close(ws, { platform }) {
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

You can also reply directly from inside `hooks.ws.js` using `platform.send()` or `ws.send()` with the envelope format:

```js
// src/hooks.ws.js
export function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  // Using platform.send (recommended):
  platform.send(ws, 'echo', 'reply', { got: msg });
  // Or using ws.send with manual envelope:
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

> **Performance:** `sendTo` iterates every open connection and runs your filter function against each one. It's fine for low-frequency operations like sending a DM or notifying admins, but don't use it in a hot loop. If you're broadcasting to a known group of users, subscribe them to a shared topic and use `platform.publish()` instead -- topic-based pub/sub is handled natively by uWS in C++ and doesn't touch the JS event loop.

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

### `platform.batch(messages)`

Publish multiple messages in a single call. Useful when an action updates several topics at once:

```js
platform.batch([
  { topic: 'todos', event: 'created', data: todo },
  { topic: `user:${userId}`, event: 'activity', data: { action: 'create' } },
  { topic: 'stats', event: 'increment', data: { key: 'todos_created' } }
]);
```

Each entry is published with `platform.publish()`. Cross-worker relay is batched automatically, so this is more efficient than three separate `publish()` calls from a relay overhead perspective.

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

### `onDerived(topicFn, store)` - reactive topic subscription

Subscribes to a topic derived from a reactive value. When the source store changes, the old topic is released and the new one is subscribed automatically.

```svelte
<script>
  import { page } from '$app/stores';
  import { onDerived } from 'svelte-adapter-uws/client';
  import { derived } from 'svelte/store';

  // Subscribe to a different topic based on the current route
  const roomId = derived(page, ($page) => $page.params.id);
  const messages = onDerived((id) => `room:${id}`, roomId);
</script>

{#if $messages}
  <p>{$messages.event}: {JSON.stringify($messages.data)}</p>
{/if}
```

Without `onDerived`, you'd need to manually watch the source store and call `connect().subscribe()` / `connect().unsubscribe()` yourself when it changes. `onDerived` handles the full lifecycle: subscribes when the first Svelte subscriber arrives, switches topics when the source changes, and unsubscribes from the server when the last Svelte subscriber leaves.

### `crud(topic, initial?, options?)` - live CRUD list

Subscribes to a topic and handles `created`, `updated`, and `deleted` events automatically:

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
- `maxAge` - auto-remove entries that haven't been created/updated within this many milliseconds (see [maxAge](#maxage---client-side-entry-expiry) below)

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

Options:
- `key` - property to match items by (default: `'id'`)
- `maxAge` - auto-remove entries that haven't been created/updated within this many milliseconds (see [maxAge](#maxage---client-side-entry-expiry) below)

### `maxAge` - client-side entry expiry

Both `crud()` and `lookup()` accept a `maxAge` option (in milliseconds). When set, entries that haven't received a `created` or `updated` event within that window are automatically removed from the store. Explicit `deleted` events still remove entries immediately.

This is useful for state backed by an external store with TTL (e.g. Redis). If the server fails to broadcast a removal event (mass disconnects, crashes, Redis TTL expiry without keyspace notifications), clients clean up on their own:

```js
// Presence entries expire after 90s without a refresh
const users = lookup('__presence:board', data.users, { key: 'key', maxAge: 90_000 });

// Sensor readings expire after 30s without an update
const sensors = lookup('sensors', [], { key: 'id', maxAge: 30_000 });

// Same option works on crud()
const items = crud('items', data.items, { maxAge: 60_000 });
```

The sweep runs at `maxAge / 2` intervals (minimum 1 second). The timer is cleaned up automatically when the last subscriber unsubscribes.

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

Server (from any hook or handler that has `platform`):
```js
// In hooks.ws.js - track connected users:
export function open(ws, { platform }) {
  platform.topic('online-users').increment();
}
export function close(ws, { platform }) {
  platform.topic('online-users').decrement();
}

// Or from a SvelteKit handler:
platform.topic('online-users').set(42);
```

> **Heads up:** The increment/decrement pattern above has a subtle race condition - a newly connected client won't see the current count because its `subscribe` message hasn't been processed yet when `open` fires. See [Seeding initial state](#seeding-initial-state) for the fix.

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

In SSR (no browser WebSocket and no explicit `url`), `ready()` resolves immediately and is a no-op. In native app environments where `window` doesn't exist but you passed a `url` to `connect()`, `ready()` correctly waits for the connection to open.

`ready()` rejects if the connection is permanently closed before it opens. This happens when the server sends a terminal close code (1008/4401/4403), retries are exhausted, or `close()` is called explicitly. If you call `ready()` in a context where permanent closure is possible, add a `.catch()` handler or use `try/await/catch`.

### `connect(options?)` - power-user API

Most users don't need this - `on()` and `status` auto-connect. Use `connect()` when you need `close()`, `send()`, or custom options.

**If you pass custom options** (like a non-default `path`), call `connect()` before any `on()`, `status`, `ready()`, or `once()` calls. Those functions auto-connect with defaults, and the connection is locked once created. A console warning will fire if your options are ignored due to ordering:

```js
import { connect } from 'svelte-adapter-uws/client';

const ws = connect({
  url: 'wss://my-app.com/ws', // full URL for cross-origin / native app usage (overrides path)
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
//   [ws] resubscribe-batch -> ['todos', 'chat']
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

### Automatic connection behaviors

The client handles several edge cases automatically, with no configuration required:

**Exponential backoff with proportional jitter**: each reconnect attempt waits longer than the previous one. The jitter is +-25% of the base delay (not a fixed +-500ms), so at high attempt counts thousands of clients are spread over a wide window rather than clustering.

**Page visibility reconnect**: when a browser tab resumes from background or a phone is unlocked, the client reconnects immediately instead of waiting for the backoff timer. Browsers often close WebSocket connections silently when a tab is hidden.

**Batch resubscription**: on reconnect, all topics are resubscribed in batched `subscribe-batch` messages. Each batch stays under the server's 8 KB control-message ceiling and 256-topic-per-batch cap. For typical apps (under 200 topics with short names) this is a single frame; larger sets are automatically chunked.

**Zombie detection**: the client checks every 30 seconds whether the server has been completely silent for more than 150 seconds (2.5x the server's idle timeout). If so, it forces a close and reconnects. This catches connections that appear open but were silently dropped by the server, which is common on mobile after wake from sleep.

### Cross-origin and native app usage

By default, the client derives the WebSocket URL from `window.location`. If your client runs on a different origin -- a mobile app (Svelte Native, React Native), a standalone Node.js script, or any context where the backend lives elsewhere -- pass a `url` to connect to it directly:

```js
import { connect, on } from 'svelte-adapter-uws/client';

connect({ url: 'wss://my-app.com/ws' });

const todos = on('todos');
```

When `url` is set, `path` is ignored and the `window` check is bypassed, so the client works in environments without a browser DOM. All other features (reconnect, backoff, batch resubscription, topic stores) work the same way.

> **Note:** Your server's `allowedOrigins` config must include the origin your client connects from (or `'*'` during development). See the [origin validation](#origin-validation) section.

---

## Seeding initial state

When a client connects, there's a window between the WebSocket opening and the client's topic subscriptions being processed. Any `platform.publish()` calls that happen during `open` will be missed by the connecting client, because it hasn't subscribed to those topics yet.

This matters most with `count()`. If your `open` hook does `platform.topic('online').set(total)`, the connecting client won't see it - the `set` event is broadcast before the client's `subscribe` message arrives.

The fix is to use the `subscribe` hook instead of (or alongside) `open` to send the current value directly to the subscribing client:

```js
// src/hooks.ws.js
let online = 0;

export function open(ws, { platform }) {
  online++;
  platform.topic('online').set(online); // broadcasts to already-subscribed clients
}

export function subscribe(ws, topic, { platform }) {
  // When a client subscribes to 'online', send it the current count
  if (topic === 'online') {
    platform.send(ws, 'online', 'set', online);
  }
}

export function close(ws, { platform }) {
  online--;
  platform.topic('online').set(online);
}
```

```svelte
<!-- src/routes/+page.svelte -->
<script>
  import { count } from 'svelte-adapter-uws/client';

  const online = count('online');
</script>

<p>{$online} online</p>
```

The `subscribe` hook fires at the right moment - after the client is actually subscribed to the topic. `platform.send()` sends only to that one client, so it gets the current value without waiting for the next broadcast.

This same pattern works for any topic where new subscribers need to see the current state. For a CRUD list, you could send the full dataset in `subscribe`:

```js
// src/hooks.ws.js
export async function subscribe(ws, topic, { platform }) {
  if (topic === 'todos') {
    const todos = await db.getTodos();
    for (const todo of todos) {
      platform.send(ws, 'todos', 'created', todo);
    }
  }
}
```

```svelte
<script>
  import { crud } from 'svelte-adapter-uws/client';

  // No need for load() data - the subscribe hook seeds the list
  const todos = crud('todos');
</script>

{#each $todos as todo (todo.id)}
  <p>{todo.text}</p>
{/each}
```

---

## Plugins

Opt-in modules that build on top of the adapter's public API. They don't change any core behavior -- if you don't import them, they don't exist. Each plugin ships in its own subdirectory under `plugins/` with separate server and client entry points.

### Middleware

Composable message processing pipeline. Chain functions that run on inbound messages before your handler logic. Each middleware receives a context and a `next` function -- call `next()` to continue, skip it to stop the chain.

#### Setup

```js
// src/lib/server/pipeline.js
import { createMiddleware } from 'svelte-adapter-uws/plugins/middleware';

export const pipeline = createMiddleware(
  // logging
  async (ctx, next) => {
    console.log(`[${ctx.topic}] ${ctx.event}`);
    await next();
  },
  // auth check
  async (ctx, next) => {
    const userId = ctx.ws.getUserData()?.userId;
    if (!userId) return; // stop chain -- unauthenticated
    ctx.locals.userId = userId;
    await next();
  },
  // data enrichment
  async (ctx, next) => {
    ctx.data = { ...ctx.data, processedAt: Date.now() };
    await next();
  }
);
```

#### Usage

```js
// src/hooks.ws.js
import { pipeline } from '$lib/server/pipeline';

export async function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  const ctx = await pipeline.run(ws, msg, platform);
  if (!ctx) return; // chain was stopped (e.g. auth failed)

  // ctx.locals.userId is available here
  // ctx.data has the enriched data
}
```

#### API

| Method | Description |
|---|---|
| `pipeline.run(ws, message, platform)` | Execute the chain. Returns context or `null` if stopped |
| `pipeline.use(fn)` | Append a middleware at runtime |

The context object:

| Field | Description |
|---|---|
| `ctx.ws` | The WebSocket connection |
| `ctx.message` | Original parsed message |
| `ctx.topic` | Message topic (mutable) |
| `ctx.event` | Message event (mutable) |
| `ctx.data` | Message data (mutable) |
| `ctx.platform` | Platform reference |
| `ctx.locals` | Scratch space for middleware to share data |

#### Limitations

- **Server-side only.** No client component.
- **No state.** The middleware itself is stateless -- it's a pure pipeline. Use `ctx.locals` to pass data between middlewares within a single message.
- **Double `next()` guard.** Calling `next()` twice in the same middleware is a no-op (the second call does nothing).

### Replay (SSR gap)

When you combine SSR with WebSocket live updates, there's a gap between server-side data loading and the moment the client's WebSocket connects. Messages published during that window are lost.

The replay plugin solves this without touching the adapter core. It's opt-in -- if you don't import it, it doesn't exist.

#### How it works

1. **Server:** publish through a replay buffer instead of `platform.publish()` directly -- messages get a sequence number and are stored in a ring buffer
2. **SSR:** pass the current sequence number to the client via your `load()` function
3. **Client:** `onReplay()` connects, requests missed messages, and switches to live mode once caught up

#### Setup

Create a shared replay instance:

```js
// src/lib/server/replay.js
import { createReplay } from 'svelte-adapter-uws/plugins/replay';

export const replay = createReplay({ size: 500 });
```

Use it when publishing:

```js
// src/routes/chat/+page.server.js
import { replay } from '$lib/server/replay';

export async function load() {
  const messages = await db.getRecentMessages();
  return { messages, seq: replay.seq('chat') };
}

export const actions = {
  send: async ({ request, platform }) => {
    const form = await request.formData();
    const msg = await db.createMessage(Object.fromEntries(form));
    replay.publish(platform, 'chat', 'created', msg);
  }
};
```

Handle replay requests in your WebSocket handler:

```js
// src/hooks.ws.js
import { replay } from '$lib/server/replay';

export function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  if (msg.type === 'replay') {
    replay.replay(ws, msg.topic, msg.since, platform, msg.reqId);
    return;
  }
}
```

Subscribe on the client with gap-free delivery:

```svelte
<!-- src/routes/chat/+page.svelte -->
<script>
  import { onReplay } from 'svelte-adapter-uws/plugins/replay/client';
  let { data } = $props();

  const messages = onReplay('chat', { since: data.seq }).scan(
    data.messages,
    (list, { event, data }) => {
      if (event === 'created') return [...list, data];
      return list;
    }
  );
</script>

{#each $messages as msg}
  <p>{msg.text}</p>
{/each}
```

#### Server API

```js
import { createReplay } from 'svelte-adapter-uws/plugins/replay';

const replay = createReplay({
  size: 1000,      // max messages per topic (default: 1000)
  maxTopics: 100   // max tracked topics, LRU evicted (default: 100)
});

replay.publish(platform, topic, event, data)           // publish + buffer
replay.seq(topic)                                      // current sequence number
replay.since(topic, seq)                               // buffered messages after seq
replay.replay(ws, topic, sinceSeq, platform, reqId)    // send missed messages to one client
replay.clear()                                         // reset everything
replay.clearTopic(topic)                               // reset one topic
```

#### Client API

```js
import { onReplay } from 'svelte-adapter-uws/plugins/replay/client';

// Works exactly like on() but bridges the SSR gap
const store = onReplay('chat', { since: data.seq });

// .scan() works the same as on().scan()
const messages = onReplay('chat', { since: data.seq }).scan([], reducer);
```

Each `onReplay()` call generates a unique request ID that is sent with the replay request and matched against the server's responses. This means multiple `onReplay('chat', ...)` instances on the same page (e.g. two components subscribing to the same topic) each receive only their own replay stream and don't see each other's events. The server must pass `msg.reqId` to `replay.replay()` as shown above for this to work.

**Buffer overflow:** If more than `size` messages were published before the client connected and the ring buffer wrapped around, the store emits a synthetic `{ event: 'truncated', data: null }` event after the replayed messages. Check for it in your reducer or subscriber to decide whether to reload all data from the server:

```js
const messages = onReplay('chat', { since: data.seq }).scan(data.messages, (list, { event, data }) => {
  if (event === 'truncated') return []; // buffer overflow - reload from server
  if (event === 'created') return [...list, data];
  return list;
});
```

#### Limitations

- **In-memory only.** The ring buffer lives in the server process. A restart loses the buffer. For most apps this is fine -- the gap is typically under a second, and a page reload after a server restart gives fresh SSR data anyway.
- **Single-worker only.** In clustered mode, each worker has its own buffer. If the SSR load runs on worker A and the WebSocket connects to worker B, the replay won't have the right messages. If you need replay with clustering, stick to a single worker or use an external store.
- **Buffer overflow.** If more than `size` messages are published to a topic before a client requests replay, the oldest are gone. Size the buffer for your expected throughput during the SSR-to-connect window (usually well under 100 messages).

---

### Presence

Track who's connected to a topic in real time. Handles multi-tab dedup (same user with two tabs open = one presence entry), broadcasts join/leave events, and provides a live store on the client.

#### Setup

Create a shared presence instance:

```js
// src/lib/server/presence.js
import { createPresence } from 'svelte-adapter-uws/plugins/presence';

export const presence = createPresence({
  key: 'id',
  select: (userData) => ({ id: userData.id, name: userData.name }),
  heartbeat: 60_000  // optional: needed if clients use maxAge
});
```

Wire it into your WebSocket hooks:

```js
// src/hooks.ws.js
import { presence } from '$lib/server/presence';

export function upgrade({ cookies }) {
  const user = validateSession(cookies.session_id);
  if (!user) return false;
  return { id: user.id, name: user.name };
}

export const { subscribe, unsubscribe, close } = presence.hooks;
```

The `hooks` object handles everything: `subscribe` calls `join()` for regular topics and sends the current presence list for `__presence:*` topics, `close` calls `leave()`. If you need custom logic (auth gating, topic filtering), wrap the hook:

```js
export function subscribe(ws, topic, ctx) {
  if (topic === 'vip' && !ws.getUserData().isVip) return false;
  presence.hooks.subscribe(ws, topic, ctx);
}

export const { unsubscribe, close } = presence.hooks;
```

Use it on the client:

```svelte
<!-- src/routes/room/+page.svelte -->
<script>
  import { on } from 'svelte-adapter-uws/client';
  import { presence } from 'svelte-adapter-uws/plugins/presence/client';

  const messages = on('room');
  const users = presence('room');
</script>

<aside>
  <h3>{$users.length} online</h3>
  {#each $users as user (user.id)}
    <span>{user.name}</span>
  {/each}
</aside>
```

Use `presence.list()` in load functions for SSR:

```js
// +page.server.js
import { presence } from '$lib/server/presence';

export async function load() {
  return { users: presence.list('room'), online: presence.count('room') };
}
```

#### Server API

```js
import { createPresence } from 'svelte-adapter-uws/plugins/presence';

const presence = createPresence({
  key: 'id',             // field for multi-tab dedup (default: 'id')
  select: (userData) => userData,  // extract public fields (default: full userData)
  heartbeat: 60_000      // broadcast active keys every 60s (default: disabled)
});

presence.hooks                       // ready-made { subscribe, unsubscribe, close } hooks
presence.join(ws, topic, platform)   // add user to topic (call from subscribe hook)
presence.leave(ws, platform)         // remove from all topics (call from close hook)
presence.sync(ws, topic, platform)   // send list without joining (for observers)
presence.list(topic)                 // current user data array
presence.count(topic)                // unique user count
presence.clear()                     // reset everything (stops heartbeat timer)
```

#### Client API

```js
import { presence } from 'svelte-adapter-uws/plugins/presence/client';

const users = presence('room');
// $users = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
```

The `presence()` function accepts an optional second argument with a `maxAge` option (in milliseconds). When set, entries that haven't been refreshed within that window are automatically removed from the store. This makes clients self-healing when the server fails to broadcast `leave` events under load.

**Important:** `maxAge` requires the server-side `heartbeat` option. Without heartbeat, no events arrive between the initial `list` and eventual `leave`, so maxAge would expire every user -- including ones who are still connected. The heartbeat periodically tells clients which keys are still active, resetting their maxAge timers.

```js
// Server: heartbeat every 60s
const presence = createPresence({ key: 'id', heartbeat: 60_000 });

// Client: entries expire after 120s without a heartbeat refresh
const users = presence('room', { maxAge: 120_000 });
```

Rule of thumb: set `heartbeat` to half (or less) of the client's `maxAge`.

#### How multi-tab dedup works

If user "Alice" (key `id: '1'`) has three browser tabs open, `presence.join()` is called three times with the same key. The plugin ref-counts connections per key: Alice appears once in the list. When she closes two tabs, she stays present. Only when the last tab closes does the plugin broadcast a `leave` event.

If Alice's data changes between connections (for example she updates her avatar in one session and opens a fresh tab), `join()` detects the difference and broadcasts an `updated` event so other clients immediately see the new data. The `updated` event has the same shape as `join`: `{ key, data }`.

If no `key` field is found in the selected data (e.g. no auth), each connection is tracked separately.

#### Limitations

- **In-memory only.** Same as replay -- server restart clears presence. On restart, clients reconnect and re-subscribe, so the list rebuilds within seconds.
- **Single-worker only.** Each worker tracks its own presence. In clustered mode, the list reflects only the local worker's connections.
- **Requires subscription.** The client must subscribe to the topic (via `on()`, `crud()`, etc.) for the server's `subscribe` hook to fire. `presence('room')` alone shows you the list but doesn't register you as present unless you're also subscribed to `room`.

### Typed channels

Define message schemas per topic so event names and data shapes are validated at publish time. Catches typos and shape mismatches before they reach the wire -- instead of silently sending garbage that the client ignores.

#### Setup

```js
// src/lib/server/channels.js
import { createChannel } from 'svelte-adapter-uws/plugins/channels';

export const todos = createChannel('todos', {
  created: (d) => ({ id: d.id, text: d.text, done: d.done }),
  updated: (d) => ({ id: d.id, text: d.text, done: d.done }),
  deleted: (d) => ({ id: d.id })
});
```

Each event maps to a validator function. The function receives the raw data and returns the validated (and optionally transformed) output. Throw to reject.

With Zod (or any library that exposes `.parse()`):

```js
import { z } from 'zod';
import { createChannel } from 'svelte-adapter-uws/plugins/channels';

const Todo = z.object({ id: z.string(), text: z.string(), done: z.boolean() });

export const todos = createChannel('todos', {
  created: Todo,
  updated: Todo,
  deleted: z.object({ id: z.string() })
});
```

#### Server API

```js
import { todos } from '$lib/server/channels';

// In a form action or API route:
export async function POST({ request, platform }) {
  const data = await request.json();
  const todo = await db.save(data);

  todos.publish(platform, 'created', todo);  // validates, then publishes
  todos.publish(platform, 'typo', todo);     // throws: unknown event "typo"
  todos.publish(platform, 'created', {});    // throws: validation failed (if validator rejects)
}
```

| Method | Description |
|---|---|
| `channel.publish(platform, event, data)` | Validate and broadcast to all subscribers |
| `channel.send(platform, ws, event, data)` | Validate and send to a single connection |
| `channel.topic` | The topic string |
| `channel.events` | Array of valid event names |

Validators can strip private fields before publishing. If your validator returns `{ id, text }` but the input had `{ id, text, secret }`, only `id` and `text` reach clients.

#### Client API

The client wrapper is optional -- it catches event name typos on the receiving side too.

```svelte
<script>
  import { channel } from 'svelte-adapter-uws/plugins/channels/client';

  const todos = channel('todos', ['created', 'updated', 'deleted']);

  const all     = todos.on();          // all events (same as on('todos'))
  const created = todos.on('created'); // filtered  (same as on('todos', 'created'))
  const typo    = todos.on('craeted'); // throws Error immediately
</script>
```

The `events` array is optional. Without it, `.on()` works exactly like the regular `on()` with the topic pre-filled -- no validation, just convenience.

You can still use `crud()`, `lookup()`, `latest()`, etc. directly with the topic string. The client channel is purely additive.

#### Limitations

- **Runtime only.** The validation happens at publish/send time, not at compile time. TypeScript generics give you autocomplete for event names, but data shape checking is runtime.
- **No dependency on Zod.** The plugin accepts any validator function or any object with a `.parse()` method. You bring your own validation library (or use plain functions).

### Throttle/debounce

Per-topic publish rate limiting. Wraps `platform.publish()` to coalesce rapid-fire updates (mouse position, typing indicators, live metrics). Sends the latest value at most once per interval. No timers to manage yourself.

Two modes:

- **`throttle(ms)`** -- sends immediately on first call (leading edge), then at most once per interval (trailing edge). Latest value wins within each interval.
- **`debounce(ms)`** -- waits until no calls for the full interval, then sends the latest value. Each new call resets the timer.

#### Setup

```js
import { throttle, debounce } from 'svelte-adapter-uws/plugins/throttle';

const mouse  = throttle(50);   // at most once per 50ms per topic
const search = debounce(300);  // wait for 300ms of silence
```

#### Usage

```js
// In hooks.ws.js
import { mouse, search } from '$lib/server/rate-limiters';

export function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());

  if (msg.type === 'cursor') {
    // 60 mouse moves/sec from 20 users = 1200 publishes/sec
    // With throttle(50), each topic publishes at most 20/sec
    mouse.publish(platform, 'cursors', 'move', {
      userId: ws.getUserData().id,
      x: msg.x, y: msg.y
    });
  }

  if (msg.type === 'search') {
    // User types fast -- only publish when they pause
    search.publish(platform, 'search-results', 'query', { q: msg.q });
  }
}
```

Rate limiting is per-topic. If you call `mouse.publish()` for topics `'room-a'` and `'room-b'`, each topic has its own independent timer.

#### API

| Method | Description |
|---|---|
| `limiter.publish(platform, topic, event, data)` | Publish with rate limiting |
| `limiter.flush()` | Send all pending immediately, clear all timers |
| `limiter.flush(topic)` | Send pending for one topic |
| `limiter.cancel()` | Discard all pending, clear all timers |
| `limiter.cancel(topic)` | Discard pending for one topic |
| `limiter.interval` | The configured interval in ms |

#### How throttle works

```
t=0    publish({x:0})  --> sends immediately (leading edge)
t=10   publish({x:1})  --> stored (latest)
t=30   publish({x:2})  --> stored (overwrites x:1)
t=50   [timer fires]   --> sends {x:2} (trailing edge)
t=60   publish({x:3})  --> stored
t=100  [timer fires]   --> sends {x:3}
t=150  [timer fires]   --> nothing pending, goes idle
t=200  publish({x:4})  --> sends immediately (new leading edge)
```

#### How debounce works

```
t=0    publish({q:"h"})      --> stored, timer starts
t=80   publish({q:"he"})     --> stored, timer resets
t=160  publish({q:"hel"})    --> stored, timer resets
t=260  [timer fires, 100ms]  --> sends {q:"hel"}
```

#### Limitations

- **Server-side only.** No client component -- the client receives messages at the throttled rate naturally.
- **Latest value only.** Intermediate values within an interval are discarded, not queued. If you need every message delivered, don't throttle.
- **Timer-based.** Uses `setTimeout` internally. Precision depends on Node.js event loop load (typically < 1ms drift).

### Rate limiting

Token-bucket rate limiter for inbound WebSocket messages. Protects against spam, abuse, and runaway clients. Supports per-IP, per-connection, or custom key extraction, with optional auto-ban when a bucket is exhausted.

Different from throttle -- throttle shapes **outbound** publish rate, rate limiting protects **inbound** against abuse.

#### Setup

```js
// src/lib/server/ratelimit.js
import { createRateLimit } from 'svelte-adapter-uws/plugins/ratelimit';

export const limiter = createRateLimit({
  points: 10,         // 10 messages
  interval: 1000,     // per second
  blockDuration: 30000 // auto-ban for 30s when exhausted
});
```

#### Usage

```js
// src/hooks.ws.js
import { limiter } from '$lib/server/ratelimit';

export function message(ws, { data, platform }) {
  const { allowed, remaining, resetMs } = limiter.consume(ws);
  if (!allowed) return; // drop the message

  // ... handle message normally
}
```

#### API

| Method | Description |
|---|---|
| `limiter.consume(ws, cost?)` | Deduct tokens (cost must be >= 0, defaults to 1), returns `{ allowed, remaining, resetMs }` |
| `limiter.reset(key)` | Clear the bucket for a key |
| `limiter.ban(key, duration?)` | Manually ban a key |
| `limiter.unban(key)` | Remove a ban |
| `limiter.clear()` | Reset all state |

#### Options

| Option | Default | Description |
|---|---|---|
| `points` | *required* | Tokens per interval (positive integer) |
| `interval` | *required* | Refill interval in ms |
| `blockDuration` | `0` | Auto-ban duration in ms when exhausted (0 = no auto-ban) |
| `keyBy` | `'ip'` | `'ip'`, `'connection'`, or `(ws) => string` |

With `keyBy: 'ip'` (default), the limiter reads `userData.remoteAddress`, `.ip`, or `.address`. With `keyBy: 'connection'`, each WebSocket gets its own bucket. Pass a function for custom grouping (e.g. by user ID or room).

#### Limitations

- **Server-side only.** No client component needed.
- **In-memory.** Buckets live in the process. In cluster mode, each worker has independent rate limits (acceptable for most apps -- abusers hit the same worker via the acceptor).
- **Lazy cleanup.** Expired buckets are swept when the internal map exceeds 1000 entries.

### Cursor (ephemeral state)

Lightweight fire-and-forget broadcasting for transient state -- mouse cursors, text selections, drag positions, drawing strokes. Built-in throttle with trailing edge ensures the final position always arrives. Auto-cleanup on disconnect.

#### Setup

```js
// src/lib/server/cursors.js
import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

export const cursors = createCursor({
  throttle: 50, // at most one broadcast per 50ms per user per topic
  select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
});
```

#### Server usage

Use the `hooks` helper for zero-config cursor handling. The `message` hook handles `cursor` and `cursor-snapshot` messages automatically, and `close` calls `remove()`. The hooks verify that the sender is subscribed to the `__cursor:{topic}` channel before processing -- clients that haven't passed the `subscribe` hook for that topic are silently rejected.

```js
// src/hooks.ws.js
import { cursors } from '$lib/server/cursors';

export function message(ws, ctx) {
  if (cursors.hooks.message(ws, ctx)) return;
  // handle other messages...
}

export const close = cursors.hooks.close;
```

For custom auth or topic filtering, handle the messages manually:

```js
export function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  if (msg.type === 'cursor') {
    cursors.update(ws, msg.topic, { x: msg.x, y: msg.y }, platform);
  }
  if (msg.type === 'cursor-snapshot') {
    cursors.snapshot(ws, msg.topic, platform);
  }
}

export function close(ws, { platform }) {
  cursors.remove(ws, platform);
}
```

#### Client usage

```svelte
<script>
  import { cursor } from 'svelte-adapter-uws/plugins/cursor/client';

  const positions = cursor('canvas');
</script>

{#each [...$positions] as [key, { user, data }] (key)}
  <div
    class="cursor-dot"
    style="left: {data.x}px; top: {data.y}px; background: {user.color}"
  >
    {user.name}
  </div>
{/each}
```

The client store is a `Readable<Map<string, { user, data }>>`. The Map updates when cursors move or disconnect. The store handles `update`, `remove`, `snapshot`, and `bulk` events. The `snapshot` event is authoritative -- it replaces all client-side state (used for initial sync and reconnect). The `bulk` event merges entries additively (used by the [extensions repo](https://github.com/lanteanio/svelte-adapter-uws-extensions) topicThrottle feature when flushing coalesced updates).

**Initial sync and reconnect.** The `cursor(topic)` store sends a `{ type: 'cursor-snapshot', topic }` message every time the WebSocket connection opens -- both on first connect and on every reconnect. The server calls `cursors.snapshot(ws, topic, platform)` in its `message` handler, which sends a `snapshot` event back with the current cursor state (or an empty array if nobody is active). The client replaces its entire cursor map with the snapshot contents, clearing any stale entries from before the disconnect. Wire `cursors.snapshot()` in your message handler as shown in the server example above.

The `cursor()` function accepts an optional second argument with a `maxAge` option (in milliseconds). When set, cursor entries that haven't received an update within that window are automatically removed. This makes clients self-healing when the server fails to broadcast `remove` events under load:

```js
const positions = cursor('canvas', { maxAge: 30_000 });
```

#### Server API

| Method | Description |
|---|---|
| `cursors.update(ws, topic, data, platform)` | Broadcast position (throttled) |
| `cursors.remove(ws, platform)` | Remove from all topics, broadcast removal |
| `cursors.snapshot(ws, topic, platform)` | Send current positions to one connection (initial sync) |
| `cursors.list(topic)` | Current positions (for SSR) |
| `cursors.clear()` | Reset all state and timers |

#### How throttle works

The cursor plugin uses leading edge + trailing edge throttle internally:

```
t=0    update({x:0})  --> broadcasts immediately (leading edge)
t=20   update({x:5})  --> stored (within 50ms window)
t=40   update({x:9})  --> stored (overwrites x:5)
t=50   [timer fires]  --> broadcasts {x:9} (trailing edge)
```

The trailing edge ensures you always see where the cursor stopped, even if the user stops moving mid-window.

#### Limitations

- **In-memory.** Cursor positions live in the process. In cluster mode, each worker tracks its own connections.
- **No persistence.** Positions are lost on restart. This is intentional -- cursors are ephemeral.

### Queue (ordered delivery)

Per-key async task queue with configurable concurrency and backpressure. With the default `concurrency: 1`, tasks are processed strictly in order per key -- useful for sequential operations like collaborative editing, turn-based games, or transaction sequences. With `concurrency > 1`, dequeue order is preserved but tasks run in parallel, so completion order is not guaranteed.

#### Setup

```js
// src/lib/server/queue.js
import { createQueue } from 'svelte-adapter-uws/plugins/queue';

// Sequential processing per key (default concurrency: 1)
export const queue = createQueue({ maxSize: 100 });
```

#### Usage

```js
// src/hooks.ws.js
import { queue } from '$lib/server/queue';

export async function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());

  // Messages for the same topic are processed one at a time
  const result = await queue.push(msg.topic, async () => {
    const record = await db.update(msg.data);
    platform.publish(msg.topic, 'updated', record);
    return record;
  });
}
```

#### API

| Method | Description |
|---|---|
| `queue.push(key, task)` | Enqueue a task, returns promise with the task's return value |
| `queue.size(key?)` | Waiting + running count for a key, or total |
| `queue.clear(key?)` | Cancel waiting tasks (running tasks continue) |
| `queue.drain(key?)` | Wait for all tasks to complete |

#### Options

| Option | Default | Description |
|---|---|---|
| `concurrency` | `1` | Max concurrent tasks per key |
| `maxSize` | `Infinity` | Max waiting tasks per key (rejects when exceeded) |
| `onDrop` | `null` | Called with `{ key, task }` when a task is rejected |

Different keys are independent -- `push('room-a', ...)` and `push('room-b', ...)` run concurrently. Only tasks with the same key are queued.

#### Limitations

- **Server-side only.** No client component.
- **In-memory.** Queue state lives in the process. Not durable across restarts.
- **No cancellation.** Running tasks cannot be aborted. `clear()` only rejects waiting tasks.

### Broadcast groups

Named groups with explicit membership, roles, metadata, and lifecycle hooks. Like topics but with access control -- you decide who can join, what role they have, and what happens when the group fills up or closes.

#### Setup

```js
// src/lib/server/lobby.js
import { createGroup } from 'svelte-adapter-uws/plugins/groups';

export const lobby = createGroup('lobby', {
  maxMembers: 50,
  meta: { game: 'chess' },
  onJoin: (ws, role) => console.log('joined as', role),
  onFull: (ws, role) => {
    // optionally notify the rejected client
  }
});
```

#### Server usage

Use the `hooks` helper for zero-config access control. The `subscribe` hook intercepts the internal `__group:lobby` topic, calls `join()`, and blocks the subscription if the group is full or closed. The `close` hook calls `leave()`.

```js
// src/hooks.ws.js
import { lobby } from '$lib/server/lobby';

export const { subscribe, unsubscribe, close } = lobby.hooks;
```

If you need custom logic (role selection, auth gating), wrap the hook:

```js
// src/hooks.ws.js
import { lobby } from '$lib/server/lobby';

export function subscribe(ws, topic, ctx) {
  if (topic === '__group:lobby') {
    const role = ws.getUserData().isAdmin ? 'admin' : 'member';
    return lobby.join(ws, ctx.platform, role) ? undefined : false;
  }
  lobby.hooks.subscribe(ws, topic, ctx);
}

export const { unsubscribe, close } = lobby.hooks;
```

Publish to group members:

```js
// Broadcast to everyone
lobby.publish(platform, 'chat', { text: 'hello' });

// Broadcast only to admins
lobby.publish(platform, 'admin-alert', { msg: 'new report' }, 'admin');
```

#### Client usage

```svelte
<script>
  import { group } from 'svelte-adapter-uws/plugins/groups/client';

  const lobby = group('lobby');
  const members = lobby.members;
</script>

<p>{$members.length} members</p>
```

The client store exposes two reactive values: the main store for events (`$lobby` -- latest message) and `.members` for the live member list. The member list updates automatically on join, leave, and close events -- no polling needed.

#### Server API

| Method | Description |
|---|---|
| `group.join(ws, platform, role?)` | Add member. Returns `true` or `false` if full/closed |
| `group.leave(ws, platform)` | Remove member |
| `group.publish(platform, event, data, role?)` | Broadcast (optionally filtered by role) |
| `group.send(platform, ws, event, data)` | Send to one member (throws if not a member) |
| `group.members()` | Array of `{ ws, role }` |
| `group.count()` | Member count |
| `group.has(ws)` | Check membership |
| `group.close(platform)` | Dissolve group, notify everyone |
| `group.name` | Group name (read-only) |
| `group.meta` | Metadata (get/set) |
| `group.hooks` | Ready-made `{ subscribe, unsubscribe, close }` hooks with access control |

Roles: `'member'` (default), `'admin'`, `'viewer'`.

#### Options

| Option | Default | Description |
|---|---|---|
| `maxMembers` | `Infinity` | Maximum members |
| `meta` | `{}` | Initial metadata (shallow-copied) |
| `onJoin` | -- | `(ws, role) => void` |
| `onLeave` | -- | `(ws, role) => void` |
| `onFull` | -- | `(ws, role) => void` |
| `onClose` | -- | `() => void` |

#### Limitations

- **In-memory.** Group state lives in the process. In cluster mode, each worker manages its own groups independently.
- **No persistence.** Groups are lost on restart. If you need durable rooms, store membership in a database and rebuild on start.
- **Role-filtered publish uses `send()`.** When filtering by role, the plugin iterates members and sends individually instead of using the topic broadcast. Fine for typical group sizes, but O(n) with member count.

---

**Deployment & scaling**

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

The adapter supports multi-core scaling with two modes, auto-selected based on platform.

Set the `CLUSTER_WORKERS` environment variable to enable it:

```bash
# Use all available CPU cores
CLUSTER_WORKERS=auto node build

# Fixed number of workers
CLUSTER_WORKERS=4 node build

# Combined with other options
CLUSTER_WORKERS=auto PORT=8080 ORIGIN=https://example.com node build
```

If a worker crashes, it is automatically restarted with exponential backoff (100ms initial, doubling up to 5s, max 50 attempts before the primary exits). On `SIGTERM`/`SIGINT`, the primary tells all workers to drain in-flight requests and shut down gracefully.

The primary thread monitors worker health with a 10-second heartbeat interval. If a worker fails to acknowledge a heartbeat within 30 seconds (stuck event loop, deadlock), the primary terminates it and the restart policy kicks in.

### Clustering modes

**`reuseport`** (Linux default) -- each worker binds to the same port via `SO_REUSEPORT`. The kernel distributes incoming connections across all listening workers. There is no single-threaded acceptor bottleneck and no single point of failure -- one worker crashing does not affect the others.

**`acceptor`** (macOS/Windows default) -- a primary thread creates an acceptor app that receives all connections and distributes them to worker threads via uWS child app descriptors. Works on all platforms.

The mode is auto-detected. Override it explicitly if needed:

```bash
# Force acceptor mode on Linux (e.g. for debugging)
CLUSTER_MODE=acceptor CLUSTER_WORKERS=auto node build
```

Setting `CLUSTER_MODE=reuseport` on non-Linux platforms is an error (SO_REUSEPORT is not reliable outside Linux).

### WebSocket + clustering

`platform.publish()` is automatically relayed across all workers via the primary thread, so subscribers on any worker receive the message. This is built in -- no external pub/sub needed. The relay is microtask-batched: a SvelteKit action that calls `publish()` multiple times sends a single IPC message per microtask instead of one per call.

If you add your own cross-process messaging (Redis, Postgres LISTEN/NOTIFY, etc.), pass `{ relay: false }` to prevent duplicate delivery -- your external source already fans out to every worker, so the built-in relay would double it.

Per-worker limitations (acceptable for most apps):
- `platform.connections`  - returns the count for the local worker only
- `platform.subscribers(topic)`  - returns the count for the local worker only
- `platform.sendTo(filter, ...)`  - iterates the local worker's connections only, no cross-worker relay

### Docker / multi-process deployments (Linux)

On Linux, `SO_REUSEPORT` is set on every `app.listen()` call -- including single-process mode. This means multiple independent `node build` processes can bind to the same port without any adapter-level clustering. The kernel distributes connections across them.

If you already have external pub/sub (Redis, Postgres LISTEN/NOTIFY) handling cross-process messaging, you do not need `CLUSTER_WORKERS` at all. Just run multiple replicas and let your infrastructure handle the rest:

```yaml
# docker-compose.yml
services:
  app:
    build: .
    command: node build
    network_mode: host
    environment:
      - PORT=443
      - SSL_CERT=/certs/cert.pem
      - SSL_KEY=/certs/key.pem
    deploy:
      replicas: 4
```

Each replica is a plain single-process `node build`. No coordinator thread, no built-in relay. Docker handles restarts, Redis handles cross-process messaging, the kernel handles port sharing.

With `network_mode: host`, containers share the host network stack directly -- no port mapping needed, and services like Postgres and Redis are reachable via `127.0.0.1`. This avoids Docker bridge DNS and gives the best network performance.

**When to use what:**
- **`CLUSTER_WORKERS`** -- single-machine deployments without Docker/k8s/systemd managing processes for you
- **Docker replicas** -- production deployments where your infrastructure already handles process management and you have external pub/sub for cross-process messaging

---

## OS tuning for production

uWebSockets.js can handle hundreds of thousands of connections per process, but Linux defaults are conservative. For any deployment expecting more than a few hundred concurrent WebSocket connections, apply these settings on the host machine.

### Kernel parameters

Add to `/etc/sysctl.conf` and run `sysctl -p`:

```
net.ipv4.tcp_max_syn_backlog = 4096   # pending TCP connection queue
net.ipv4.tcp_tw_reuse = 1             # reuse TIME_WAIT sockets faster
net.core.somaxconn = 4096             # listen() backlog limit
fs.file-max = 1024000                 # system-wide file descriptor limit
net.netfilter.nf_conntrack_max = 262144  # connection tracking table size (default 65536 fills up fast under load, drops ALL new TCP including SSH)
net.ipv4.tcp_fastopen = 3             # TCP Fast Open for both client and server (saves 1 RTT on reconnecting clients)
net.ipv4.tcp_defer_accept = 5         # don't wake the app until data arrives (ignores port scanners and half-open probes)
```

**TCP Fast Open** (`tcp_fastopen = 3`) lets a returning client send data in the SYN packet, eliminating one round-trip for the first request after a short idle. Browsers and HTTP clients that support TFO will use it automatically. The value `3` enables it for both incoming (server) and outgoing (client) connections.

**TCP Defer Accept** (`tcp_defer_accept = 5`) keeps the kernel from delivering the accepted socket to the application until data arrives. Port scanners, SYN probes, and clients that open a TCP connection but send nothing are handled at the kernel level rather than consuming event loop time. The value is the timeout in seconds before a data-less connection is dropped.

### File descriptor limits

Add to `/etc/security/limits.conf` (takes effect on next login):

```
*     soft  nofile  1024000
*     hard  nofile  1024000
root  soft  nofile  1024000
root  hard  nofile  1024000
```

The wildcard `*` does not apply to the root user on most Linux distributions. If the app runs as root (common in Docker), the explicit `root` lines are required.

### Docker

If running in Docker, the container also needs raised limits. Add to your `docker-compose.yml`:

```yaml
services:
  app:
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
```

Without these changes, each process is limited to 1024 file descriptors (the default). Each WebSocket connection uses one file descriptor, so the default caps you at roughly 1000 concurrent connections per process. The server CPU can be well under 50% and you will still hit this ceiling -- the bottleneck is the OS, not uWS or your application code.

For a deeper walkthrough, see [Millions of active WebSockets with Node.js](https://unetworkingab.medium.com/millions-of-active-websockets-with-node-js-7dc575746a01) from the uWebSockets.js authors.

### Stress testing: run it from the server

If you run a stress test from your local machine against a remote server, every WebSocket connection goes through your home router's NAT table. Home routers typically have 1024 to 4096 NAT entries. Once the table fills up, the router drops ALL new outbound connections -- not just your test, but SSH, your phone on WiFi, everything on your network.

Symptoms of NAT table exhaustion:
- Connection ceiling stuck around 1200-1900 regardless of server tuning
- SSH to the server times out during the test
- Other devices on the same WiFi lose internet access
- Server CPU is barely loaded (the server is fine, your router is not)
- Switching your phone from WiFi to mobile data works immediately

The fix: run the stress test from the server itself (localhost to localhost) or from a machine on the same network as the server. This bypasses NAT entirely and lets you hit the actual server limits.

### Connection management (uWS defaults)

uWebSockets.js manages connection lifecycle at the C++ level. These are its built-in behaviors:

**HTTP keepalive:** uWS closes idle HTTP connections after 10 seconds of inactivity. This is compiled into the C++ layer and is not configurable from JavaScript. Behind a reverse proxy (nginx, Caddy, Cloudflare), the proxy manages keepalive for external clients; uWS handles only the proxy-to-app leg.

**Slow-loris protection:** uWS requires at least 16 KB/second of throughput from each HTTP client. Connections that send data slower than this (a common DoS technique) are dropped by the C++ layer before they reach your application code.

**WebSocket ping/pong:** Set `idleTimeout` in the adapter's `websocket` option (in seconds) to have uWS send automatic WebSocket ping frames and close connections that don't respond. The default is 120 seconds. The client store handles pong automatically.

```js
// svelte.config.js
adapter({
  websocket: {
    idleTimeout: 120,   // close WS connections silent for 120s
    maxPayloadLength: 16 * 1024 * 1024  // max incoming WS message size
  }
})
```

---

## Performance

### Why uWebSockets.js?

uWebSockets.js is a C++ HTTP and WebSocket server compiled to a native V8 addon. It consistently outperforms Node.js' built-in `http` module, Express, Fastify, and every other JavaScript HTTP server by a significant margin.

We ran a comprehensive benchmark suite isolating every layer of overhead - from barebones uWS through the full adapter pipeline - and compared against `@sveltejs/adapter-node` (Node http + Polka + sirv) and the most popular WebSocket libraries (`socket.io`, `ws`). The benchmark code is in the [`bench/`](bench/) directory so you can reproduce it yourself.

### HTTP: adapter-uws vs adapter-node

Tested with a trivial SvelteKit handler (isolates adapter overhead from your app code):

| | adapter-uws | adapter-node | Multiplier |
|---|---|---|---|
| **Static files** | 165,700 req/s | 24,500 req/s | **6.8x faster** |
| **SSR** | 150,500 req/s | 58,300 req/s | **2.6x faster** |

<sup>100 connections, 10 pipelining, 10s, 2 runs averaged. Node v24, Windows 11.</sup>

The static file gap is the largest because `adapter-node` uses sirv which calls `fs.createReadStream().pipe(res)` per request, while we serve from an in-memory `Map` with a single `res.cork()` + `res.end()`. The SSR gap comes from uWS's C++ HTTP parsing and batched writes vs Node's async drain event cycle.

### WebSocket: uWS vs socket.io vs ws

50 connected clients, 10 senders, burst mode, 8 seconds:

| Server | Messages delivered/s | vs adapter-uws |
|---|---|---|
| **uWS native** (barebones) | 3,583,000 | baseline |
| **adapter-uws** (full handler) | 3,583,000 | 1.0x |
| **ws** library | 232,200 | **15.4x slower** |
| **socket.io** | 226,700 | **15.8x slower** |

uWS native pub/sub delivered 3.5M messages/s with exact 50x fan-out. The adapter matches it -- the byte-prefix check and string template envelope add near-zero overhead to the hot path. `socket.io` and `ws` both collapsed under the same load, delivering less than 1x fan-out (massive message loss/queueing).

### Where the overhead goes

**HTTP (SSR path) - ~32% total overhead vs barebones uWS:**

| Layer | Cost | Notes |
|---|---|---|
| `res.cork()` + status + headers | ~12.6% | Writing a proper HTTP response - unavoidable |
| `new Request()` construction | ~9% | Required by SvelteKit's `server.respond()` contract |
| async/Promise scheduling | ~3% | `getReader()` + `read()` + event loop yield |
| Header collection, remoteAddress | ~1% | `req.forEach` + TextDecoder |

**WebSocket - at parity with barebones uWS pub/sub:**

| Layer | Cost | How |
|---|---|---|
| Subscribe/unsubscribe check | ~0% | Byte-prefix discriminator: byte[3] is `y` for `{"ty` (control) and `o` for `{"to` (user envelope). One comparison skips `JSON.parse` for all user messages (0.001us per message). |
| Envelope wrapping | ~0% | String template + `esc()` char scan instead of `JSON.stringify` on a wrapper object. Only `data` is stringified. ~0.085us per publish. |
| Connection tracking | ~2% | `Set` add/delete on open/close. |
| Origin validation, upgrade headers | ~2% | Four `req.getHeader` calls on upgrade. |

**What we don't add:**
- No middleware chain (no Polka, no Express)
- No routing layer (uWS native routing + SvelteKit's router)
- No per-request stream allocation for static files (in-memory Buffer, not `fs.createReadStream`)
- No Node.js `http.IncomingMessage` shim (we construct `Request` directly from uWS)

### Internal optimizations

The adapter applies several allocation and caching strategies to stay off the GC's radar on the hot path:

- **Request state pooling** -- SSR requests need a `{ aborted: false }` state object. Instead of allocating one per request (which promotes to V8's old generation and stays there), the adapter maintains a pool of up to 256 reusable state objects. Eliminates young-gen GC churn under sustained load.
- **Envelope prefix cache** -- `platform.publish()` and `platform.send()` wrap data in a `{"topic":"...","event":"...","data":...}` envelope. The prefix up to `"data":` is cached in a 256-entry LRU map keyed by topic+event. Repeated publishes to the same topic/event (the common case) skip 4 string concatenations and the character validation scan. The cache is trimmed every 60 seconds to reclaim stale entries from shifted traffic patterns.

### SSR request deduplication

When multiple concurrent requests arrive for the same anonymous (no cookie/auth) GET or HEAD URL, only one is dispatched to SvelteKit. The others wait for the result and reconstruct their own response from the shared buffer. This prevents redundant rendering work during traffic spikes, a common pattern when a post goes viral or a cron job hits a popular page at the same time as real users.

Dedup is automatically skipped for:
- Any request with a `Cookie` or `Authorization` header (personalized responses must not be shared)
- POST, PUT, PATCH, DELETE (mutations must always execute)
- Responses with a `Set-Cookie` header (personalized)
- Response bodies larger than 512 KB (too large to buffer and share)
- Requests with an `X-No-Dedup: 1` header (opt-out escape hatch)

No configuration is needed. The dedup map holds at most 500 in-flight keys simultaneously as a safety valve against memory pressure from unique URLs.

**Vary and personalization contract:** The adapter deduplicates by method + URL only. It cannot inspect every possible input that might affect your response (user-agent quirks, custom headers, etc.). The contract is:

- If your route handler produces different output based on a request header or other input, emit a `Vary` header listing those headers. The adapter checks the `Vary` header after rendering and discards the dedup entry if `Vary` is present, preventing that response from being shared.
- If you have a route that varies by something the adapter cannot detect (e.g. server-side A/B test state), add `X-No-Dedup: 1` to opt out entirely.

Anonymous GET/HEAD routes that produce the same output for all users (landing pages, docs, prerendered pages) benefit most from dedup and require no action.

**Measured benefit:** 200 concurrent requests to the same anonymous URL with a 5ms render delay: without dedup, 200 render calls; with dedup, 1 render call. 200x reduction in CPU and memory pressure.

### The bottom line

The adapter retains ~68% of raw uWS HTTP throughput and matches uWS native WebSocket throughput. The HTTP overhead is dominated by things SvelteKit requires (`new Request()`, proper HTTP headers). The WebSocket overhead is now almost entirely the `JSON.stringify` of your `data` payload -- the adapter's own machinery costs near zero. In a real app, your load functions and component rendering will dwarf all of this -- the adapter's job is to get out of the way, and it does.

To run the benchmarks yourself:

```bash
npm install  # installs uWebSockets.js, autocannon, etc.
node bench/run.mjs          # adapter overhead breakdown
node bench/run-compare.mjs  # full comparison vs adapter-node + socket.io
node bench/run-dedup.mjs    # SSR dedup render-call reduction
```

---

**Examples**

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
import uws from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uws()]
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

**Help**

## Troubleshooting

### "WebSocket works in production but not in dev"

You need the Vite plugin. Without it, there's no WebSocket server running during `npm run dev`.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';

export default {
  plugins: [sveltekit(), uws()]
};
```

Also make sure `ws` is installed:
```bash
npm install -D ws
```

### "Cannot read properties of undefined (reading 'publish')"

This means `event.platform` is `undefined`. Two possible causes:

**Cause 1: Missing Vite plugin in dev mode**

Same fix as above - add `uws()` to your `vite.config.js`.

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

**To stop the retry loop when credentials are permanently invalid**, close the WebSocket with a terminal close code from inside your `open` or `message` handler. The client will not reconnect on these codes:

| Code | Meaning |
|---|---|
| `1008` | Policy Violation (standard) |
| `4401` | Unauthorized (custom) |
| `4403` | Forbidden (custom) |

```js
// src/hooks.ws.js
export async function open(ws, { platform }) {
  const userData = ws.getUserData();
  if (!userData.userId) {
    ws.close(4401, 'Unauthorized'); // client will not retry
    return;
  }
}
```

When the server closes with code `4429`, the client treats it as a rate limit signal and backs off more aggressively before retrying.

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

Every message sent through `platform.publish()` or `platform.topic().created()` arrives as JSON with this shape. The envelope is constructed with string concatenation for speed, but `topic` and `event` are validated first -- if either contains a quote, backslash, or control character, the call throws instead of producing malformed JSON:

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

## Testing

```bash
npm test              # 777 unit tests (vitest, ~2s)
npm run test:e2e      # 25 e2e tests (playwright, ~13s)
npm run test:coverage # both + coverage reports (~30s)
```

Unit tests cover store patterns, adapter options, plugin logic, client behavior, and the WebSocket test harness. They run in vitest with the `vmForks` pool.

E2e tests start a real SvelteKit app (`test/fixture/`) with the adapter installed via `file:../..`. Playwright runs two projects:

- **dev** -- `vite dev` with the Vite plugin. Tests SSR, static files, WebSocket pub/sub (via `ws` clients), and the real `client.js` running in Chromium.
- **prod** -- `vite build` + `node build/index.js` through uWebSockets.js. Tests the same surface against the production runtime, plus the health check endpoint and 404 handling.

The coverage script collects V8 coverage from both the Playwright server processes (vite.js, handler.js) and the browser (client.js via Chrome DevTools Protocol), then reports them alongside the vitest unit coverage.

First-time setup for e2e:

```bash
cd test/fixture && npm install && cd ../..
npx playwright install chromium
```

### Test harness for WebSocket handlers

The `svelte-adapter-uws/testing` entry point provides `createTestServer()` for integration-testing your `hooks.ws` handlers against a real uWebSockets.js server:

```js
import { createTestServer } from 'svelte-adapter-uws/testing';
import { WebSocket } from 'ws';
import { describe, it, expect, afterEach } from 'vitest';
import * as myHandler from '../src/hooks.ws.js';

let server;
afterEach(() => server?.close());

it('rejects unauthenticated upgrades', async () => {
  server = await createTestServer({ handler: myHandler });

  const ws = new WebSocket(server.wsUrl);
  const code = await new Promise((resolve) => {
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
  });
  expect(code).toBe(401);
});

it('publishes to subscribers', async () => {
  server = await createTestServer({ handler: myHandler });

  const ws = new WebSocket(server.wsUrl, {
    headers: { cookie: 'session=valid-token' }
  });
  await new Promise(r => ws.on('open', r));

  ws.send(JSON.stringify({ type: 'subscribe', topic: 'todos' }));
  await new Promise(r => setTimeout(r, 10));

  const msg = new Promise(r => ws.on('message', d => r(JSON.parse(d.toString()))));
  server.platform.publish('todos', 'created', { id: 1 });
  expect(await msg).toMatchObject({ topic: 'todos', event: 'created' });

  ws.close();
});
```

The test server starts on a random port (typically in ~2ms), uses the same subscribe/unsubscribe protocol as production, and exposes the full Platform API (`publish`, `send`, `sendTo`, `topic`, `connections`, `subscribers`).

---

## Related projects

- [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions) -- Redis-backed extensions for multi-server deployments: persistent presence, distributed pub/sub, session storage, and more.
- [svelte-realtime](https://github.com/lanteanio/svelte-realtime) -- Opinionated full-stack starter built on this adapter. Auth, database, real-time CRUD, and deployment config out of the box.
- [svelte-realtime-demo](https://github.com/lanteanio/svelte-realtime-demo) -- Live demo of svelte-realtime. [Try it here.](https://svelte-realtime-demo.lantean.io/)

## License

[MIT](LICENSE)
