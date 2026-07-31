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
- **Liveness + readiness probes** - `/healthz` (always 200 while up) and `/readyz` (503 `starting` before `init` commits, 503 `draining` once shutdown begins) out of the box
- **Zero-config WebSocket** - just set `websocket: true` and go

**Upgrading from 0.4.x?** See the [migration guide](./MIGRATION.md) for every breaking change between 0.4.x and 0.5.x.

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
- [Dedup (idempotency window)](#dedup-idempotency-window)
- [Presence](#presence)
- [Typed channels](#typed-channels)
- [Throttle/debounce](#throttledebounce)
- [Rate limiting](#rate-limiting)
- [Cursor (ephemeral state)](#cursor-ephemeral-state)
- [Queue (ordered delivery)](#queue-ordered-delivery)
- [Lock (per-key serialization)](#lock-per-key-serialization)
- [Session (in-process store with sliding TTL)](#session-in-process-store-with-sliding-ttl)
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

## Version compatibility

The three ecosystem packages move together. Bump them as a group:

| `svelte-adapter-uws` | `svelte-realtime` | `svelte-adapter-uws-extensions` | Notes |
|---|---|---|---|
| `^0.4.x` | `^0.4.x` | `^0.4.x` | Legacy stable |
| `^0.5.0` | `^0.5.0` | `^0.5.0` | Current. Node 22+ required. See `MIGRATION.md` if upgrading from 0.4. |

Mixed-version installs are rejected at install time with a peer-dep warning.

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
npm install uNetworking/uWebSockets.js#v20.69.0
```

> **Note:** uWebSockets.js is a native C++ addon installed directly from GitHub, not from npm. It may not compile on all platforms. Check the [uWebSockets.js README](https://github.com/uNetworking/uWebSockets.js) if you have issues.
>
> **Docker:** Use `node:22-trixie-slim` or another glibc >= 2.38 image. Bookworm-based images and Alpine won't work. See [Deploying with Docker](#deploying-with-docker).

The supported set is exactly what the pinned addon ships prebuilt binaries for - there is no source build to fall back on:

| platform | arch | note |
|---|---|---|
| linux | x64, arm64 | glibc >= 2.38. musl (Alpine) has no binary at all |
| darwin | x64, arm64 | |
| win32 | x64 | no arm64 binary is published |

Node is `>=22.0.0`, and the same "no source build to fall back on" applies to the Node ABI: the pinned addon ships one binary per ABI it targets, currently three (Node 22, 24 and 26). `engines` does not block a Node major outside that set, but there is no binary for one - and because the addon is an OPTIONAL dependency, npm reports nothing when it finds none, so the first sign is `adapt()` failing at build time. A clone of this repository additionally pins 22.23.2 in `.nvmrc`, the version the hosted gate runs and the one to reproduce a native ABI question on.

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

> **Important:** `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER`, and `ADDRESS_HEADER` are trusted verbatim by default. Only set these when running behind a reverse proxy that overwrites the corresponding headers on every request. If the server is directly internet-facing, clients can spoof these values. When in doubt, use a fixed `ORIGIN` instead.

A proxy that appends its line instead of overwriting is handled rather than being an error. When a request arrives with two `X-Forwarded-Proto` lines the last one wins, because that is the line the hop in front wrote and an earlier one is whatever the client sent. The same rule covers `HOST_HEADER`, `PORT_HEADER` and every `ADDRESS_HEADER` name except `x-forwarded-for`, which keeps all of its lines joined with `", "` so `XFF_DEPTH` can count the hops.

To make the trust mechanical instead of topological, set `TRUSTED_PROXIES` to a comma-separated list of proxy addresses or CIDR ranges (IPv4 and IPv6):

```bash
ADDRESS_HEADER=x-forwarded-for TRUSTED_PROXIES=10.0.0.0/8,::1 node build
```

With `TRUSTED_PROXIES` set, `ADDRESS_HEADER` is honored only when the direct socket peer is in the list; a claim from any other peer is ignored (the socket address is used, with a one-shot warning), so a client that can reach the listener directly cannot spoof its rate-limit identity or `getClientAddress()`. Unset, the historical trust-verbatim behavior is unchanged.

If your load balancer speaks [PROXY protocol v2](https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt) (HAProxy, AWS NLB, etc.) instead of an address header, opt in with `PROXY_PROTOCOL=1`: the preamble's source address becomes the client address for rate limiting and `getClientAddress()`. Combine it with `TRUSTED_PROXIES` - uWS accepts a PP2 preamble from any peer, so without the allowlist any direct client could spoof its address the same way an ungated header does. An `ADDRESS_HEADER` on top of PROXY protocol composes: the header (from a trusted app proxy) wins over the PP2 address (from the outer LB).

**Repeated header lines.** A request carrying two lines of the same header is not resolved by last-wins across the board; the policy is fixed per header class. A repeated `host`, `content-length`, `transfer-encoding`, `content-type`, `authorization`, `proxy-authorization` or `origin` is answered `400 Bad Request`, and a WebSocket upgrade carrying one is refused with the same status: those headers decide how a request is framed, how its body is parsed, who it is from, or which origin it claims, and the value this layer picked might not be the one the proxy in front picked. Every other repeated header is merged or picked. `cookie` joins with `"; "` (what an HTTP/2 to HTTP/1.1 downgrade at an edge proxy produces). `set-cookie` keeps its first line and is never joined - a comma is legal inside an `Expires` date. The single-valued proxy headers keep their last line: the names you configured through `PROTOCOL_HEADER` / `HOST_HEADER` / `PORT_HEADER` / `ADDRESS_HEADER` (`x-forwarded-for` excepted - it stays joined, which is what `XFF_DEPTH` counts), plus the ubiquitous spellings (`x-forwarded-proto`, `x-forwarded-host`, `x-forwarded-port`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, and friends) whether or not you configured them. Everything else is comma-joined in arrival order, including vendor chains such as `x-original-forwarded-for`, `forwarded` and `via` - with one carve-out: naming one of those as your `ADDRESS_HEADER` moves it into the last-line class, because the client-IP resolver reads any name other than `x-forwarded-for` as a single address and a joined value would put the client's own bytes in front of the proxy's.

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

The Vite plugin is required for WebSocket support in both dev and production (see [Step 2](#step-2-add-the-vite-plugin-required)). It spins up a `ws` WebSocket server alongside Vite's dev server, so the client protocol and `event.platform` API are available during development. It is a behavioural implementation of those contracts, not the production handler: it runs on `ws`, cannot attach custom headers to the 101 response, and does not exercise the built uWS artifact, worker/cluster lifecycle, TLS, admission, or build-time option substitution. Security-sensitive runtime tests should also boot the built fixture; a passing dev-server test alone is not production evidence.

Changes to your `hooks.ws` file are picked up automatically - the plugin reloads the handler on save and closes existing connections so they reconnect with the new code. No dev server restart needed.

**Note:** The dev plugin enforces `allowedOrigins` on WebSocket upgrades the same way the production handler does. For local dev scenarios that need to accept arbitrary origins (e.g. WSS from a staging client during integration), pass `devSkipOriginCheck: true` to the plugin: `uws({ devSkipOriginCheck: true })`.

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

  // Liveness probe - 200 whenever the process is up, including during a drain
  // (set to false to disable)
  healthCheckPath: '/healthz', // default: '/healthz'

  // Readiness probe - 200 when ready, 503 during graceful shutdown so a load
  // balancer drains this instance (set to false to disable)
  readinessCheckPath: '/readyz', // default: '/readyz'

  // WebSocket configuration
  websocket: true // or false, or an options object (see below)
})
```

The two probes answer different questions, and wiring them the other way round is the classic rolling-deploy outage:

- `healthCheckPath` is **liveness**: `200` for as long as the process runs, in every state including the whole drain. Wire a liveness probe here and nothing else.
- `readinessCheckPath` is **routing**: `200 ready` only while the instance is ready; `503` while it is starting up (before `init` commits) and once shutdown has begun. The 503 body is the state - `starting` or `draining` - because those are opposite things to an operator watching a rolling deploy: every new pod reporting `draining` reads as a stuck or reversed rollout. Wire the load balancer and the readiness probe here.
- Accepting connections is neither: the socket stays open through the drain delay, which is what makes a rolling restart lossless.

### WebSocket options

```js
adapter({
  websocket: {
    // Path for WebSocket connections
    path: '/ws', // default: '/ws'

    // Path to your custom handler module (auto-discovers src/hooks.ws.js if omitted)
    handler: './src/lib/server/websocket.js', // default: auto-discover

    // Max message size in bytes (connections sending larger messages are closed)
    maxPayloadLength: 1024 * 1024, // default: 1 MB

    // Seconds of inactivity before the connection is closed.
    // 0 DISABLES the idle timeout entirely - a silent connection is then never
    // closed and holds its slot until the client goes away, so pair it with
    // upgradeAdmission.maxConcurrent if you set it.
    idleTimeout: 120, // default: 120

    // Max bytes of backpressure per connection before messages are dropped.
    // uWS defaults to 64 KB; this adapter uses 1 MB to handle pub/sub spikes.
    // Lower this if you expect many slow consumers.
    maxBackpressure: 1024 * 1024, // default: 1 MB

    // Close a connection that stays pinned over maxBackpressure instead of
    // shedding its frames forever - the bounded-recovery knob for a chronically
    // slow consumer that would otherwise wedge a worker. Default false keeps the
    // zero-config shed-and-continue behavior. Watch platform.pressure.maxBufferedBytes.
    closeOnBackpressureLimit: false, // default: false

    // Enable per-message deflate. Default false (byte-identical to no
    // compression). `true` = SHARED_COMPRESSOR; a uWS constant (e.g.
    // uWS.DEDICATED_COMPRESSOR_4KB) for finer control. Applied per frame,
    // not blanket - see "WebSocket compression" below.
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

**`maxPayloadLength`** (default: 1 MB) - the maximum size of a single incoming WebSocket message. If a client sends a message larger than this, uWS closes the connection immediately (not just the message - the entire connection is dropped). Set this based on the largest message your application expects to receive. uWS's own default is 16 KB, which the adapter previously matched; the 1 MB default ships now to handle typical app payloads in a single frame without forcing chunked-upload frameworks into ~12 KB chunks (which the previous 16 KB cap did). For a stricter cap, pin an explicit value (e.g. `16 * 1024` for the uWS-matching 16 KB).

**`maxBackpressure`** (default: 1 MB) - the per-connection outbound send buffer, AND the threshold above which `publish` / `send` / `publishBatched` silently skip a subscriber. When a specific subscriber's buffer is over this size, uWS drops that frame *for that subscriber only* while continuing to deliver to every non-backpressured subscriber. This makes `publish` / `send` / `publishBatched` volatile-by-default for slow consumers (the right behavior for cursor positions, typing indicators, presence pings - see "Volatile / fire-and-forget delivery" below). The `drain` hook fires per-connection when the buffer empties again. Lower this if you want subscribers shed sooner; raise it if you prefer to keep the connection queued and absorb temporary slowness. uWS's own default is 64 KB; this adapter sets 1 MB to favor keeping the connection alive under pub/sub spikes.

**`closeOnBackpressureLimit`** (default: `false`) - when `true`, uWS **closes** a connection that stays pinned over `maxBackpressure` instead of perpetually shedding its frames. The default shed-and-continue behavior keeps the connection alive and silently drops frames past the cap, which is correct for a transient spike but lets a permanently-slow client tie up buffer memory indefinitely; opt in to drop such a client instead. This is the bounded-recovery knob for a chronically slow consumer that would otherwise wedge a worker's outbound queue. Watch `platform.pressure.maxBufferedBytes` / `platform.pressure.backpressuredConnections` (or the `ws_backpressure_max_bytes` / `ws_backpressure_connections` metrics gauges) to decide whether your workload needs it. Default `false` is byte-identical to the previous behavior.

**`compression`** (default: `false`) - per-message deflate for outbound frames. The default is byte-identical to no compression. Set `true` for `SHARED_COMPRESSOR` (one shared sliding window across all sockets - the right choice for a many-connection server), or pass a uWS constant like `uWS.DEDICATED_COMPRESSOR_4KB` (a per-socket window: slightly better compression for a few high-throughput connections, but memory grows with connection count). When a compressor is configured, compression is applied **per frame, not blanket**: text frames (`publish` / `send`) compress by default, binary codec frames (`publishWire` / `sendWire`) are opt-in, the **cursor** plugin stays uncompressed (its 60 Hz hot path), and the **presence** plugin opts in (low-frequency). This split matters because permessage-deflate CPU scales **per subscriber** - uWS does not compress-once-and-fan-out, even for `SHARED_COMPRESSOR` - so compressing a high-frequency broadcast to many subscribers is expensive (a coalesced cursor frame fanned to 1000 subscribers at 60 Hz can cost more than a full CPU core per topic). For a high-frequency, high-fan-out **text** topic, pass `{ compress: false }` to `publish` / `send` to opt it out. None of this applies until you enable compression.

**`upgradeRateLimit`** (default: 10 per 10s window) - sliding-window rate limit on WebSocket upgrade requests per client IP. Clients exceeding the limit get a `429 Too Many Requests` response. The IP rate map is capped at 10,000 entries, enforced when an entry is inserted rather than only by the 60s sweep, so a flood of rotating client identities cannot grow it unbounded in between. At the cap the least active entry in a rotating sample is evicted and the new client is admitted, rather than the new client being refused - refusing would let one host rotating `X-Forwarded-For` fill the map and lock every other client out until the next sweep. Keys are truncated to 128 characters, matching the accepted single-address-header ceiling, so the entry cap bounds memory rather than only entry count while accepted identities remain distinct; longer `X-Forwarded-For` chains sharing that prefix share a limiter bucket. Set to `0` to disable.

**`authPathRateLimit`** (default: 30 per 10s window) - the same sliding-window limit on the auth preflight endpoint, the request `connect({ auth: true })` clients POST before upgrading. Over the limit they get `429 Too Many Requests` and your `authenticate` hook is never called, so a credential check against a database cannot be driven at full server speed from one address. The default is higher than `upgradeRateLimit` on purpose: every reconnect that preflights also upgrades, so this door sees at least as much traffic during a reconnect wave, and matching them would make the preflight refuse traffic the upgrade limit would have admitted. `authPathRateLimitWindow` sets the window; `0` disables. Same client-address resolution as `upgradeRateLimit`, so the same proxy caveat applies.

> **Behind a proxy?** The limit is keyed on the client IP, which is the raw socket address unless you set `ADDRESS_HEADER`. If the server sits behind a reverse proxy, an L4 load balancer, or docker's `userland-proxy` (its default) that rewrites the source address, **every client arrives as the same gateway IP** and the "per-IP" limit silently collapses into a single **global** cap - 10 new connections per 10s for the entire site, trivially tripped by normal traffic or a crawler. The runtime emits a one-time warning the first time it rejects an upgrade keyed on a private/loopback address while `ADDRESS_HEADER` is unset. To restore real per-IP limiting, set `ADDRESS_HEADER=x-forwarded-for` (with [`XFF_DEPTH`](#environment-variables) for the trusted-proxy hop count) so the limiter sees the real client, set docker `userland-proxy: false` so iptables DNAT preserves the source IP, or set `upgradeRateLimit: 0` if you rate-limit upstream. Match `XFF_DEPTH` to the number of hops that actually append: a value larger than the real chain finds fewer addresses than hops and falls back to the socket address, which resolves every client to the gateway again - the exact collapse this callout is about. The same applies to the per-message [`plugins/ratelimit`](https://github.com/lanteanio/svelte-adapter-uws-extensions), which keys on the same resolved address.

**`upgradeAdmission`** (default: disabled) - two-layer admission control on the upgrade path, both opt-in:

- `maxConcurrent` caps how many upgrades may be in flight at once. Crossed requests get a fast `503 Service Unavailable` before any per-request work, so a connection storm can be shed without spending CPU on TLS, header parsing, or cookie decoding. Set this just above your steady-state in-flight count to act as a circuit breaker.
- `perTickBudget` caps how many actual `res.upgrade()` calls run per Node.js event-loop tick. Once the budget is spent, subsequent calls are deferred via `setImmediate` so the loop is not starved by 10K synchronous handshakes from one I/O batch. Pre-upgrade work (rate limit, origin check, hook dispatch) still runs in the original tick; only the hand-off to the C++ upgrade path is paced. Start with `64` and adjust based on your peak burst envelope.
- `waitingRoom` upgrades the over-capacity rejection from a bare `503` to a content-negotiated waiting room: a browser navigation gets a self-polling HTML holding page that reloads itself when capacity frees, while a WebSocket upgrade or non-HTML client keeps a `503` with a jittered `Retry-After`. On by default once `maxConcurrent > 0`; set `waitingRoom: false` for the exact bare `503`. The page polls a read-only `/__admit-check` endpoint (`202` with a waiting-count body while full, `200` when capacity exists) that consumes no gate slot. Tune with `waitingRoom: { path, admitCheckPath, retryAfterSeconds, pollIntervalMs, template }`.
  - The built-in page carries a `Pause live updates` control. A paused page keeps polling but hands the visitor a `Reload now` button instead of navigating for them. `/__admit-check` reports live capacity and reserves nothing, so a slot it offers can be taken by another browser first: the page keeps polling across an offer, withdraws it when a later check disagrees, and pressing `Reload now` after that simply re-serves the holding page.
  - What the page states is the capacity situation and, when a count is available, an approximate number of browsers waiting. It shows no queue position and no wait estimate, because admission keeps no arrival order and nothing measures the drain rate. The poll body's `queueDepth` is a rolling count of browsers polling the page (a crowd size, not a place in a line) and `estimatedSeconds` is that count at a nominal one slot per second. A deployment that wants a real position and a real estimate has to implement a ticketed queue and render it through `waitingRoom.template`.
- `cursorLane` reserves a fraction of `maxConcurrent` (default `0.25`, at least one slot) for a deprioritised cursor-only upgrade lane - a second WebSocket that requests the `svelte-realtime-cursor` subprotocol. A cursor upgrade is admitted only while both the main ceiling and the cursor sub-budget have room, so a flood of cursor connects can never starve main-WebSocket admission; the main lane never waits on the cursor sub-budget. The cursor lane is refused first and, under `siege`, refused entirely - always with a bare `503` (never the holding page, since the cursor connection is not a browser). Omit `cursorLane` to disable the lane: the second counter never increments and admission is unchanged. Set it with `cursorLane: { fraction }`.

```js
adapter({
  websocket: {
    upgradeAdmission: { maxConcurrent: 1000, perTickBudget: 64 }
  }
});
```

The two layers are independent: each works without the other. Both default to `0` (disabled) so the upgrade path stays unchanged unless you opt in.

**`protection`** (default: `'normal'`) - a graduated admission posture layered over `upgradeAdmission`. `'auto'` escalates under sustained pressure and relaxes on recovery, with hysteresis so it cannot flap (escalate fast, relax slow); `'normal'` / `'elevated'` / `'siege'` pin a level for incident response.

- `elevated` widens the waiting-room `Retry-After` jitter (and tightens any loaded per-IP / capability-cookie extensions).
- `siege` refuses every new upgrade (the waiting-room holding page or a `503`) and makes `/__admit-check` always poll-again. Existing connections are never touched at any level.

`platform.protection` reads the live level. While a posture is engaged, `platform.pressure.reason` can surface `CAPACITY` (precedence `MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS`). Default `'normal'` is a true no-op - the reject path and pressure are byte-identical to before.

**Kernel pressure sources** (on by default where the host exposes them, invisible elsewhere) - two signals the process-local counters cannot see feed the same pressure surface:

- **PSI stall time** (`/proc/pressure/{cpu,memory,io}`, PSI-enabled Linux kernels): the share of the last 10 seconds tasks spent stalled on a contended resource. Fires the `PSI` reason at `pressure.psiCpuSome` (cpu `some`, default `60`), `pressure.psiMemoryFull` (memory `full` - thrash, which fires meaningfully earlier than an OOM-adjacent heap ratio; default `15`), or `pressure.psiIoFull` (default `50`). Each accepts `false` to disable.
- **CFS quota throttling** (cgroup `cpu.stat`, v1 and v2 layouts): the fraction of the sample window the container's CPU quota held the whole process suspended. A quota-throttled worker is not merely contended - it is periodically STOPPED, a failure mode PSI `some` can miss - so it fires its own `CPU_QUOTA` reason at `pressure.cpuThrottledRatio` (default `0.25`).

Both sources are probed once at startup: on any host without them (non-Linux, PSI compiled out, no cgroup limits) the sample fields are simply absent and every path is byte-identical to before. The readings ride `platform.pressure.psi` / `platform.pressure.cpuThrottle` and fold into the `platform.pressure.value` saturation scalar worst-of.

**`postureExport`** (default: off) - a local stream socket where an external process follows the live posture without speaking the app's protocol:

```js
adapter({ websocket: { postureExport: '/run/app/posture.sock' } });
```

Consumers connect to the unix socket (or a `\\.\pipe\...` named pipe on Windows) and receive newline-delimited JSON - `{"v":1,"posture":"elevated","reason":"PSI","value":0.83,"psi":{...},"cpuThrottle":{...}}` - once on connect, once on every posture/reason transition, and once per pressure sample. The steady 1 Hz cadence doubles as a liveness contract: a consumer that stops receiving lines knows the adapter is gone (killed, frozen, deadlocked) with no extra protocol. Built for an edge-defense daemon or an external watchdog; local-only, read-only (inbound bytes are ignored), and payload-free - posture, reason, and kernel pressure numbers only. The export can never hurt the server it reports on: a failed listen logs once and disables it, serialization is skipped entirely with zero consumers, and a consumer that stops draining is disconnected rather than buffered without bound.

**systemd integration** (automatic under a `Type=notify` unit, a no-op everywhere else) - the runtime detects `NOTIFY_SOCKET` and sends `READY` once the service actually accepts traffic (after the app's `init` hook resolves in single-process mode; on first listen in clustered modes), `STOPPING` when a graceful shutdown begins, and - when `WatchdogSec=` is set - a `WATCHDOG` ping at half the timeout from a main-loop timer, so a frozen event loop stops the pings and systemd applies the unit's recovery action. Notifications go through the `systemd-notify` helper, so give the unit `NotifyAccess=all`:

```ini
[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
ExecStart=/usr/bin/node build/index.js
```

**`metrics`** (default: off) - a **module path** whose default export (or a named `metrics` / `registry` export) is a Prometheus-style registry that makes the whole admission stack chartable. Any registry with positional `counter(name, help, labelNames?)` / `gauge(name, help)` factories works - the `createMetrics()` registry from [`svelte-adapter-uws-extensions/prometheus`](https://github.com/lanteanio/svelte-adapter-uws-extensions) fits as-is and owns naming concerns like a global prefix.

It is a module path (like `handler`), not a live object: adapter options are serialized into the build, so a registry constructed inline in `svelte.config.js` never reaches the production runtime. Put the registry in its own module; the adapter bundles it, populates it, and exposes the **same instance** on `platform.metrics`. Scrape it from a route via `platform.metrics` - do not re-import the metrics module from app code, which would create a second, empty copy.

```js
// src/lib/server/metrics.js
import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
export const metrics = createMetrics();

// svelte.config.js
adapter({
  websocket: {
    upgradeAdmission: { maxConcurrent: 1000, perTickBudget: 64 },
    protection: 'auto',
    metrics: './src/lib/server/metrics.js'
  }
});

// src/routes/metrics/+server.js  (scrape endpoint)
export const GET = ({ platform }) =>
  new Response(platform.metrics.serialize(), {
    headers: { 'content-type': 'text/plain; version=0.0.4' }
  });
```

| Metric | Type | What it charts |
| --- | --- | --- |
| `upgrade_admitted_total` | counter | Upgrades accepted (the `res.upgrade()` actually ran). |
| `upgrade_rejected_total{reason}` | counter | Upgrades rejected before open. Reasons, in the order the upgrade path can reach them: `siege`, `over_capacity`, `cursor_lane`, `duplicate_header` (a repeated framing / identity header, which cannot be given one reading), `ip_rate_limit`, `bad_origin`, `auth_timeout`, `auth_rejected`, `hook_error`. One more, `auth_rate_limit`, is emitted on the auth preflight POST rather than on an upgrade - it shares this counter because it refuses the same client at the door in front of the handshake. That preflight also answers a repeated framing header with a `400`, and that rejection is counted on no series, so a dashboard built on this counter sees duplicate-header refusals from the upgrade path only. |
| `upgrade_rate_map_evicted_total{door}` | counter | Rate-limit entries evicted to make room at the map cap. `door` is `upgrade` or `auth` - a sustained rate on either door means rotating client identities are churning that limiter's map faster than the periodic sweep reclaims it. |
| `upgrade_inflight` | gauge | Upgrades currently between admission and open (sampled once per pressure interval). |
| `waiting_room_queue_depth` | gauge | Clients currently polling the waiting room (sampled; `0` with the room off). |
| `protection_posture_state` | gauge | The live posture: `0` normal, `1` elevated, `2` siege (sampled). |
| `protection_posture_transitions_total{from,to}` | counter | Posture level changes - chart it next to the rejected reasons for an incident timeline. |
| `state_divergence_total{role}` | counter | Cross-worker state-hash divergence detections (clustered mode, when [`stateHashIntervalMs`](#cross-worker-state-divergence-detection) is set). `role` is `majority` or `minority`. No topic strings or client identity - the hash is structure-only. |
| `open_fds` | gauge | File descriptors currently open by the process (sampled every ~5 pressure intervals). Registered only where an fd directory exists (Linux, macOS). Worker threads share one process-wide table, so in clustered mode every worker reports the same whole-process value - aggregate with `max()`, never `sum()`. |
| `fd_soft_limit` | gauge | The soft file-descriptor limit; new sockets fail with `EMFILE` at this count. Chart `open_fds` against it for connection headroom. Registered only where the limit is readable. Same clustered-mode note as `open_fds`: aggregate with `max()`. |
| `framework_assertion_violations_total{category,severity}` | counter | Framework invariant violations, mirroring the queryable `platform.assertions` Map. `severity` is `soft` (a recoverable `assert`) or `fatal` (a hard-tier termination). Category cardinality is bounded by the source-declared categories - never user input. |

Each posture change also logs one `[ws] protection posture <from> -> <to>` line with the rolling reject rate and the base pressure reason at the moment of transition. Costs when enabled: one unlabelled counter increment per accepted upgrade, one labelled increment per rejection, and three gauge writes per pressure sample; when off, every site is a single undefined check. The counters record server decisions, not client behaviour - a client that disconnects mid-upgrade is counted in neither, so admitted + rejected can read below a load balancer's attempt count under flappy clients. Instrument failures are contained (a registry that throws on emit logs once and is silenced; one that throws at instrument creation fails at startup, loudly). No client identity (IP, session) ever appears in a label - the per-IP picture lives in the extensions per-IP bucket's own `upgrade_bucket_*` counters, and capability-cookie failures in its `capability_cookie_misses_total{reason}` (an app hook that rejects on a cookie miss surfaces here as `auth_rejected`).

#### Layered admission: upgrade-path + message-path

`upgradeAdmission` operates at the WebSocket handshake. It sheds connection attempts before TLS work and before any per-request CPU is spent. That is the right primitive when the threat is "too many clients are trying to connect" - a connection flood, a thundering herd after a deploy, a runaway client retry loop.

It is NOT the right primitive when the threat is "established connections are sending too many RPCs" - a chatty client, an abusive presence ping loop, a misbehaving game tick. Those calls have already passed the handshake; the connection is open; you want to shed at the message dispatch layer instead.

For that second layer, [`svelte-adapter-uws-extensions`](https://github.com/lanteanio/svelte-adapter-uws-extensions) ships `createAdmissionControl`, an opt-in message-path admission wrapper that runs against already-accepted connections. The two stack naturally:

```js
// Production wiring sketch
import { createAdmissionControl } from 'svelte-adapter-uws-extensions';

const messageAdmission = createAdmissionControl({ /* RPC concurrency, per-key buckets, ... */ });

// In hooks.ws.js
export function message(ws, ctx) {
  messageAdmission.run(ws, ctx, async () => {
    // ... your message handler ...
  });
}

// In svelte.config.js
adapter({
  websocket: {
    upgradeAdmission: { maxConcurrent: 1000, perTickBudget: 64 }  // handshake layer
  }
});
```

The two layers do not share state, configuration, or call sites. They cannot drift apart because the WebSocket lifecycle enforces the ordering: a connection that fails `upgradeAdmission` never reaches the message handler at all, so `createAdmissionControl` only ever sees connections that were already admitted at the handshake. The layering is a structural property, not a runtime one.

### Security configuration

Defense-in-depth opt-ins layered on top of `allowedOrigins`. All default to safe values; flip them only after the documented audit step.

- **`websocket.authPathRequireOrigin`** (default `true`) - the `/__ws/auth` POST endpoint requires `x-requested-with: XMLHttpRequest`, `Sec-Fetch-Site: same-origin`, or an `Origin` matching `allowedOrigins`. The adapter client always stamps `x-requested-with` so the browser path is unaffected. Set `false` to accept native (non-browser) clients without those headers.
- **`websocket.compressCredentialedResponses`** (default `false`) - requests carrying `Cookie` or `Authorization` skip dynamic brotli/gzip compression to defend against the [BREACH](https://en.wikipedia.org/wiki/BREACH) attack (compressed length leaks attacker-influenced reflected input alongside a secret). Set `true` only after auditing the page surface for BREACH defenses (random per-response masking, prefix randomization, no secrets reflected with attacker input). Build-time precompressed static files are unaffected.
- **`websocket.unsafeSameOriginWithoutHostPin`** (default `false`) - when `allowedOrigins: 'same-origin'` is paired with no fronting trust (no `ORIGIN` env, no `HOST_HEADER` env, no native TLS, no `upgrade()` hook), the runtime throws at startup because the same-origin check then compares two attacker-controlled headers (Origin vs Host). Set `true` to restore the previous warn-only behavior. Pin the deployment shape first (`ORIGIN`, `HOST_HEADER`, native TLS, or an `upgrade()` hook).

`websocket.allowSystemTopicSubscribe` (default `false`) and `websocket.allowNonAsciiTopics` (default `false`) are documented in [Topic validation](#topic-validation); `websocket.authorizeWireSubscribe` (default `false`) is documented in [Wire-subscribe authorization](#wire-subscribe-authorization). The Vite plugin mirrors all of these flags, but its options are a separate flat bag: repeat the production posture in `vite.config.js` (for example, `uws({ authorizeWireSubscribe: true })`). Flags are not copied from `svelte.config.js` into the dev plugin. `devSkipOriginCheck` (default `false`) on the plugin disables the dev-mode `allowedOrigins` enforcement for local-only scenarios.

### Outbound SSRF gate (`svelte-adapter-uws/safe-url`)

Server-side code that fetches a user-supplied URL - an outbound webhook, a link preview, an avatar import - is a classic SSRF target. `isSafeUrl` answers "is it safe to fetch this" with one boolean, and never throws:

```js
import { isSafeUrl, checkUrl, classifyAddress } from 'svelte-adapter-uws/safe-url';

if (!isSafeUrl(userWebhookUrl)) throw new Error('Webhook URL is not allowed');

checkUrl('http://169.254.169.254/');   // { safe: false, reason: 'metadata' }
classifyAddress('8.8.8.8');            // null, i.e. a real public address
```

It is pure and synchronous, classifying the URL's *literal* host: loopback, link-local, RFC1918, CGNAT, cloud metadata (v4, v6 and by hostname), and the IPv4-embedding IPv6 forms - IPv4-mapped, NAT64, 6to4, ISATAP - are unwrapped to the embedded IPv4 and re-checked, so `http://[64:ff9b::a9fe:a9fe]/` cannot smuggle the metadata IP past an IPv4-only check. Non-http(s) schemes are refused in every mode. To also close DNS rebinding, pass a resolver to the async `checkUrlResolved`.

**On a NAT64 network, declare your prefix.** The default classifier recognises NAT64 embeddings across `64:ff9b::/32`; if your translator uses a Network-Specific Prefix elsewhere, `nat64Prefix` is required for SSRF protection because that range otherwise looks like ordinary public IPv6. Inside the recognised range, an IPv6 address still does not record which of the six RFC 6052 prefix lengths produced it, so without a declaration the embedded IPv4 is read at all of them and the URL refused if *any* reading looks private. That is fail-closed but costs real destinations - the readings that do not match your prefix decode prefix bits into a phantom address, which refuses roughly a quarter of public destinations at `/48` and a third at `/32` and `/40`. For a `/96` inside `64:ff9b:1::/48` the subnet id becomes the phantom's leading octets, so about a quarter of subnet ids refuse *everything*.

```js
isSafeUrl(url, { nat64Prefix: '64:ff9b::/96' });      // or '64:ff9b:1:a::/96', or your own NSP
```

One reading is then taken instead of six, which removes the over-block entirely. A private embedded address is still refused, so a *correct* declaration cannot re-open a blocked destination.

> **Declare the exact prefix your translator uses.** Treat this option as a trusted assertion about your network. A parseable wrong length in *either* direction can turn an address the guard would otherwise refuse into an allowed one. A shorter declaration reads prefix bits as the destination; a longer declaration reads destination and suffix bits. For example, declaring a parent `/48` for a real `/96` can miss `169.254.169.254`, while declaring `/64` for a real `/48` can read private `10.8.8.8` as public `8.8.0.0`. The real prefix length is not recoverable from the address text, and trying every length would restore the false positives this option exists to remove. A non-zero suffix proves some mismatches and is refused, but a clean suffix does not prove the declaration correct. Only a value that does not parse at all is safe by default - that one is ignored in favour of reading every length. At `/96`, RFC 6052 also requires bits 64-71 of the prefix itself to be zero; a `/96` declaration that breaks that rule refuses the whole range rather than none.

The dead-subnet problem is not confined to `/96` either: a `/56` on an unlucky subnet byte refuses 100% of destinations, and a `/40` averages ~44% across subnet bytes for the same reason. Nothing about the prefix tells you whether yours is one of the bad ones, which is the whole argument for declaring it.

Note `allow` (in `allowlist` mode) narrows the permitted set - it never widens it. The range checks run first, so allowlisting a private host does not re-open it, and `allow` is not an escape from the over-block above.

### Verifying a received webhook (`svelte-adapter-uws/plugins/webhooks`)

`verifyWebhookSignature` is the receiving half of the delivery signature, shipped as code rather than a prose snippet because the contract has four ways to get subtly wrong and every receiver that re-implements it from documentation gets to make those mistakes independently.

```js
import { verifyWebhookSignature } from 'svelte-adapter-uws/plugins/webhooks';

export async function POST({ request }) {
	const headers = Object.fromEntries(request.headers);
	// The RAW bytes, before any JSON round-trip.
	const rawBody = await request.arrayBuffer();

	if (!verifyWebhookSignature(headers, rawBody, { secret: process.env.WEBHOOK_SECRET })) {
		return new Response('bad signature', { status: 401 });
	}
	const event = JSON.parse(new TextDecoder().decode(rawBody));
	// ...
}
```

**Pass the body as bytes, not as a parsed object.** Any byte container works - a Node `Buffer`, the `ArrayBuffer` from `request.arrayBuffer()`, a typed-array view over one, or the raw string. A parsed object is refused rather than coerced, because `JSON.stringify` does not reproduce the bytes the sender signed: key order, whitespace and number formatting all differ, so a re-serialized body verifies against nothing.

It returns a boolean and never throws, including when `options` is omitted entirely - every malformed input fails closed. The signature covers `"<timestamp>.<body>"`, and the timestamp is required and checked against a freshness window (`toleranceSeconds`, default 300) so a captured delivery cannot replay forever. Comparison is constant-time. During a secret rotation pass `secrets: [next, previous]`; the sender emits both entries in one header and either one accepts.

> **Breaking receiver change: update receivers before upgrading senders.** A
> receiver that still verifies `HMAC(secret, body)` rejects every delivery from
> the timestamped sender. The sender deliberately does not emit a second,
> body-only signature: accepting that legacy entry would keep captured
> deliveries replayable forever while making the migration look secure.

Freshness bounds replay; it does not make a request single-use inside the
five-minute window. After successful verification, deduplicate on the
authenticated `x-webhook-signature` value or on a unique event identifier
inside the signed body. Do not rely on the mutable `idempotency-key` header
alone as a security replay token: that header is not part of the HMAC.

### Sending a webhook (`deliverWebhook` and the delivery controls)

`deliverWebhook(config, topic, event, data, hooks?)` performs one outbound delivery and returns its terminal outcome. It never throws and reports nothing - the caller owns reporting and dead-letter capture. The optional `hooks` are three independent controls; omit them and delivery behaves as it always has, with first attempts unrationed and retries bounded only by `retry.attempts` (default 3).

```js
import { deliverWebhook, createWebhookAdmission, createRetryBudget, createWebhookBreaker }
	from 'svelte-adapter-uws/plugins/webhooks';

// One set of controls per process, shared by every delivery.
const admission = createWebhookAdmission();          // first attempts, per destination address
const budget = createRetryBudget();                  // retries, per hooks.key
const breaker = createWebhookBreaker();              // endpoint ejection, per hooks.key

const outcome = await deliverWebhook(
	{ url: 'https://hooks.example.com/inbox', secret: process.env.WEBHOOK_SECRET },
	'orders', 'created', { id: 17 },
	{ admission, budget, breaker, key: registrationId }
);

if (!outcome.ok) {
	if (outcome.err.code === 'WEBHOOK_ADMISSION_DENIED') queue.push(event); // over allowance, retry later
	else if (outcome.err.code === 'WEBHOOK_CIRCUIT_OPEN') deadLetter(event); // endpoint ejected
	else deadLetter(event, outcome.err, outcome.attempts);
}
```

Three controls, three different questions, and the scoping differs on purpose:

| Hook | Rations | Keyed by | Denial |
|------|---------|----------|--------|
| `hooks.admission` | the FIRST attempt of each delivery | `<address>:<port>` - every address the SSRF gate pinned the socket to (not `hooks.key`, not the URL) | terminal `attempts: 0`, `WebhookAdmissionDeniedError` (`code: 'WEBHOOK_ADMISSION_DENIED'`) |
| `hooks.budget` | each RETRY, before its backoff | `hooks.key` | terminal, carrying the last delivery error |
| `hooks.breaker` | every attempt to an ejected endpoint | `hooks.key` | terminal `attempts: 0`, `WebhookCircuitOpenError` (`code: 'WEBHOOK_CIRCUIT_OPEN'`) |

The admission gate ignores both `hooks.key` and the URL because a scheduler typically holds one registration (and one key) per subscription, and several registrations routinely point at the same endpoint. Keying the first-attempt ceiling on the caller's key would give each of them a full allowance, so the configured ceiling would come out multiplied by the number of registrations. Keying on the URL or its origin only narrows that, because the caller picks the hostname too - `127.0.0.1:8080`, `localhost:8080`, `localhost.:8080` and any number of wildcard-DNS names are distinct URLs reaching one listener. A pinned address is the one part the caller cannot rename, so registrations, aliases, path rewrites and per-event `url` callbacks that land on one address draw on one bucket.

The gate charges every address in the pin, not one chosen member of it: which member the socket ends up on is decided by the connect logic, and the caller orders its own DNS answer, so a single-member rule would name a bucket a padded answer can point away from. Charging the set settles it - whichever address the request goes to has paid for it.

What that does not cover, stated so nobody has to discover it:

- One endpoint published on several addresses (separate IPv4 and IPv6 literals, or DNS answers whose address sets differ) is several destinations, holds one allowance each, and a delivery to it spends one unit at each of them. A caller who controls its own DNS answer can therefore spend an unrelated address's allowance without sending it any traffic. What holds without qualification is narrower: a request cannot be put on an address **at the first hop** without spending that address's unit - see the redirect bullet below for what happens after it.
- A refusal part-way through a multi-address set keeps the units already taken (the interface only takes), so a refused delivery can cost more than it sent, never less.
- A DNS answer wider than 32 addresses is pinned to its first 32, so the socket may use only those and only those are charged.
- The in-process gate is per process, so a cluster multiplies allowances by replica count until a shared implementation with the same `take(destination)` interface is injected through the same seam.
- A redirect hop is not charged. The redirect target is chosen by the endpoint being delivered to, so charging it would let anyone who can register a webhook drain a bystander's allowance by answering `302` to that bystander. Size what that leaves unmetered from both knobs rather than from `maxRedirects` alone: delivery is attempted once per hop and retries inside each hop, so one admitted delivery can issue up to `(maxRedirects + 1) * retry.attempts` requests - **18** at the defaults of `5` and `3` - and only the first hop's destination set is charged. The SSRF gate still runs on every hop, so none of them can reach an address the gate refuses; they are unmetered, not unchecked.

A URL the SSRF gate rejects costs nothing: the gate runs first, so an unparseable URL, a `file:` / `data:` / `gopher:` scheme and a blocked address (link-local metadata, private ranges) never spend a destination's allowance.

A denial is deliberately distinguishable from a delivery failure: nothing was sent and the endpoint said nothing about its health, so requeue the event rather than dead-lettering it, and note that the breaker is not moved by an admission denial (only outcomes with `attempts > 0` move it). Only a definite no from an injected gate (`false`, or the `0` a Lua-scripted shared backend replies with) refuses a delivery - a throw, or an implementation that answers with nothing, admits, because a shared backend having a bad minute must not become an outbound outage.

### Capacity model

Every internal `Map` / `Set` that grows with client behaviour or topic cardinality has an explicit upper bound and a defined behaviour at saturation. The defaults are deliberately generous (1,000,000 across the board) - far above any healthy single-connection use, even at uWS's million-connection scale - so the cap catches obvious bugs and runaway clients without ever biting real apps. Aggregate memory at extreme scale is bounded separately by `upgradeAdmission.maxConcurrent`; per-connection caps are not the right place to defend against a 1M-connection DoS.

| Site | Default cap | Behaviour at saturation | Override |
|------|-------------|-------------------------|----------|
| Subscriptions per connection | 1,000,000 | `subscribe-denied` with reason `'RATE_LIMITED'` | not exposed |
| Pending `platform.request` calls per connection | 1,000,000 | promise rejects with "pending requests exceeded" | not exposed |
| `sendCoalesced` keys per connection | 1,000,000 | drop oldest insertion-order entry on insert | not exposed |
| Topic seq registry (`topicSeqs`) | 1,000,000 | one structured `console.warn` with topN publishers; publish continues | not exposed (resume protocol depends on persistence) |
| Runaway-publisher warn dedup | 1,000,000 | FIFO-evict oldest entry on insert | not exposed |
| `envelopePrefixCache` | 256 | FIFO half-evict | not exposed |
| `decodeCache` | 256 | FIFO half-evict | not exposed |
| SSR dedup in-flight | 500 | new request bypasses dedup | not exposed |
| SSR dedup body buffer per request | 512 KB | response replays without dedup | not exposed |
| Upgrade rate-limit IP map | 10,000 entries, 128-character keys | least active of rotating sample, at insertion | not exposed |
| Auth-preflight rate-limit IP map | 10,000 entries, 128-character keys | least active of rotating sample, at insertion | not exposed |
| Aggregate live connections | unbounded by default | reject upgrade with 503 once `maxConcurrent` set | `upgradeAdmission.maxConcurrent` |
| Outbound buffer per connection | 1 MB | uWS drops the frame for that subscriber only | `wsOptions.maxBackpressure` |

Both rate-limit maps key IPv6 on its **/64 prefix**, not the full address: a /64 is the smallest block a host is routinely given, so keying on the /128 would let one ordinary attacker source every request from a fresh address and never share a bucket with itself. IPv4 keeps its full address, and so does anything whose /64 is shared by unrelated clients - IPv4-mapped, NAT64 (`64:ff9b::/32`), Teredo (`2001::/32`) and link-local. A 6to4 address (`2002::/16`) encodes its site allocation and is keyed coarser, on its **/48 site prefix**, so the whole site shares one bucket. Note the consequence for legitimate traffic: clients behind one /64 (a campus, an office, a VPN) share a bucket.

**Plugin caps** use finite defaults and fail by refusing work or evicting bounded state:

| Plugin | Cap | Behaviour at saturation | Override |
|--------|-----|-------------------------|----------|
| `replay` | `maxTopics: 100`, ring `size: 1000` | LRU evict / ring overwrite | per-topic options |
| `presence` | `maxConnections: 1_000_000`, `maxTopics: 1_000_000`, `maxTopicsPerConnection: 100` | drop oldest registry entry; refuse a connection's over-cap join | constructor options |
| `cursor` | `maxConnections: 1_000_000`, `maxTopics: 1_000_000` | drop oldest insertion-order entry; pending throttle timers cleared | constructor options |
| `throttle` / `debounce` | `maxTopics: 1_000_000` | flush pending then drop oldest topic | second arg to `throttle(interval, options)` / `debounce(...)` |
| `lock` | `maxKeys: 1_000_000` | new-key `withLock` rejects with "active key count exceeded" | constructor options |
| `ratelimit` | `maxBuckets: 1_000_000` | evict the least active unbanned bucket of a sample on insert; `onEvict` callback fires | constructor options |
| `queue` | `maxSize: 1_000_000` per key, `maxKeys` / `maxPendingTotal` / `maxRunningTotal` `1_000_000` aggregate | `push` rejects with a typed `err.code`, `onDrop` fires with the bound that tripped; work over `maxRunningTotal` waits its turn rather than being rejected | constructor options (pass `Infinity` to opt out) |
| `dedup` | `maxEntries: 10_000` | soft + hard cap, oldest insertion-order evicted | constructor options |
| `session` | `maxEntries: 10_000` | soft + hard cap, oldest insertion-order evicted | constructor options |
| `groups` | `maxMembers: 1_000_000` per group | `join` returns `false`, `onFull` callback fires | constructor options (pass `Infinity` to opt out) |
| `webhooks` | opt-in: `createWebhookAdmission` `capacity: 100`, `refillPerSec: 10` per destination address, `maxKeys: 1024` destinations, so an aggregate 102,400 admitted deliveries in a burst / 10,240 per second per process; same per-key figures for `createRetryBudget` | delivery refused with `WEBHOOK_ADMISSION_DENIED` (admission) / retries stop early (budget); at `maxKeys` only a bucket refilled to full is reclaimed, and a destination that cannot be tracked is refused rather than admitted untracked | factory options (lower `maxKeys` to lower the aggregate); omit the hook for no ceiling |

The `webhooks` row is the only opt-in one: those caps exist only once you pass the hooks to `deliverWebhook`, so the row states the default figures of the control rather than of the plugin. `capacity: 100` bounds one destination and `maxKeys * capacity` bounds the process, but both count ADMITTED DELIVERIES rather than HTTP requests, so neither is the figure to size an outbound path off on its own: one admitted delivery may issue up to `retry.attempts` x (`maxRedirects` + 1) requests - 18 on the delivery defaults - and the path has to carry that multiple. Lower `retry.attempts` or `maxRedirects` to shrink the multiplier, `maxKeys` to shrink the aggregate. A delivery to a host answering with several addresses spends one unit at each of them, so both figures are upper bounds on deliveries rather than exact counts of them.

Two policy notes:

- **Per-conn cap math at uWS scale.** `1,000,000 subscriptions × 1,000,000 connections` is more than any realistic process can handle. The per-conn caps catch single-connection bugs (a `for (i=0; i<N; i++) ws.subscribe('topic-' + i)` loop, a misbehaving extension); they do not pretend to OOM-protect a 1M-connection server. Set `upgradeAdmission.maxConcurrent` for that.
- **`topicSeqs` is warn-only.** The seq registry cannot evict entries - the resume protocol depends on each topic's monotonic counter persisting for the process lifetime, and dropping a row would corrupt any reconnecting client trying to resume that topic. The cap fires a single structured `console.warn` with the topN recent publishers when the threshold is first crossed; ops sees the leak shape and can reduce topic cardinality (or opt out with `{ seq: false }` per publish) before OOM.

### Static file behavior

All static assets (from the `client/` and `prerendered/` output directories) are loaded once at startup and served directly from RAM. Each response automatically includes:

- `Content-Type`: detected from the file extension
- `Vary: Accept-Encoding`: required for correct CDN/proxy caching when serving precompressed variants
- `Accept-Ranges: bytes`: enables partial content requests (e.g. for download resume)
- `X-Content-Type-Options: nosniff`: prevents MIME-type sniffing in browsers
- `ETag`: derived from the file's modification time and size; enables `304 Not Modified` responses. Each content-coding is a distinct representation and carries its own validator, with the coding appended inside the quotes (`W/"lx3k9-1f4"`, `W/"lx3k9-1f4-br"`, `W/"lx3k9-1f4-gzip"`), so a conditional request or a resume can never cross from one representation to another
- `Cache-Control: public, max-age=31536000, immutable`: for versioned assets under `/_app/immutable/`
- `Cache-Control: no-cache`: for all other assets (forces ETag revalidation)

**Range requests (HTTP 206):** The server handles `Range: bytes=start-end` requests for static files that carry a validator. Single byte ranges are supported (`bytes=0-499`, `bytes=-500`, `bytes=500-`). Multi-range requests (comma-separated) are served as full `200` responses. An unsatisfiable range returns `416 Range Not Satisfiable`, quoting the negotiated representation's length in `Content-Range: bytes */N`. A range is served from whichever representation the request negotiates, in that representation's own coordinates: a resume sent with `Accept-Encoding: br` gets a `206` of the brotli bytes, carrying `Content-Encoding: br` and a `Content-Range` measured against the brotli length, so the client can join it onto the prefix it already has. `If-Range` is matched against that representation's ETag, so a validator from a different representation does not match and the full body is returned rather than a slice whose offsets would be meaningless. A `Range` that cannot be honoured (malformed, multi-range, or a stale `If-Range`) falls through to a normal negotiated response, compression included. Versioned assets under `/_app/immutable/` carry no validator and are therefore never served as a range - a client could not tell a resume apart from a changed file.

Files with extensions that browsers cannot render inline (`.zip`, `.tar`, `.tgz`, `.exe`, `.dmg`, `.pkg`, `.deb`, `.apk`, `.iso`, `.img`, `.bin`, etc.) automatically receive `Content-Disposition: attachment` so browsers prompt a download dialog instead of attempting to display them.

If `precompress: true` is set in the adapter options, brotli (`.br`) and gzip (`.gz`) precompressed variants are loaded at startup and served when the client's `Accept-Encoding` header includes `br` or `gzip`. Precompressed variants are only used when they are smaller than the original file. Each variant is a separate representation: it carries its own ETag, byte ranges into it are measured against its own length, and `Vary: Accept-Encoding` is sent on every response - including `304 Not Modified`, which also repeats the validated representation's `ETag` and `Cache-Control` so a shared cache updates the right stored variant under the right freshness policy.

#### Security headers on static assets (`staticHeaders`)

> **Important:** security headers set in `hooks.server.ts` (`handle`) apply to **SSR responses only**. Static and prerendered assets are served from the in-memory fast path that returns *before* SSR is reached, so they never see the `handle` hook. A CSP, HSTS, or `X-Frame-Options` you set in `handle` will be missing on `/llms.txt`, `favicon.ico`, `robots.txt`, `.well-known/*`, and every prerendered page.

Use the top-level `staticHeaders` adapter option to attach app-chosen headers to every static and prerendered response:

```js
adapter({
  staticHeaders: {
    'content-security-policy': "default-src 'self'",
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(), camera=()'
  }
})
```

Keys are case-insensitive and merged once at index time (zero per-request cost). The handler's own transfer / caching / range headers cannot be overridden - `content-type`, `content-encoding`, `content-range`, `content-length`, `date`, `etag`, `cache-control`, `vary`, `accept-ranges` - supplying one logs a build warning and is ignored. Every other header (including overriding the default `x-content-type-options`) is applied. To keep headers identical across SSR and static responses, set the same values in both `handle` and `staticHeaders`.

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
| `SSL_WATCH` | `1` | Hot-reload the cert on disk change (SNI swap, no restart); `0` disables |
| `SSL_RELOAD_DEBOUNCE_MS` | `500` | Debounce (ms) for the cert-reload watcher |
| `SSL_SNI_HOSTS` | *(cert SAN)* | Comma-separated SNI host override for cert hot-reload |
| `PROTOCOL_HEADER` | - | Header for protocol detection (e.g. `x-forwarded-proto`) |
| `HOST_HEADER` | - | Header for host detection (e.g. `x-forwarded-host`) |
| `PORT_HEADER` | - | Header for port override (e.g. `x-forwarded-port`) |
| `ADDRESS_HEADER` | - | Header for client IP (e.g. `x-forwarded-for`) |
| `XFF_DEPTH` | `1` | Position from right in `X-Forwarded-For`, counted across every `X-Forwarded-For` line of the request (a proxy that appends its own line per hop, as HAProxy's `option forwardfor` does, is counted the same as one comma-joined line). A chain shorter than `XFF_DEPTH` falls back to the socket address |
| `TRUSTED_PROXIES` | - | Comma-separated proxy IPs/CIDRs; when set, `ADDRESS_HEADER` and PROXY protocol are honored only from these peers |
| `PROXY_PROTOCOL` | - | `1` accepts a PROXY protocol v2 preamble as the client address (combine with `TRUSTED_PROXIES`) |
| `BODY_SIZE_LIMIT` | `512K` | Max request body size (supports `K`, `M`, `G` suffixes) |
| `SHUTDOWN_DELAY_MS` | `0` | Milliseconds to keep serving after readiness flips to 503, so a load balancer can deregister this instance before its sockets close. Only applies to `SIGTERM` / `SIGINT` (in cluster mode the primary waits it once for the whole fleet). `0` is correct outside Kubernetes-style rolling deploys |
| `SHUTDOWN_TIMEOUT` | `30` | Seconds the whole shutdown sequence may take, measured from the end of `SHUTDOWN_DELAY_MS`: the `shutdown` hook, the in-flight request drain and the `sveltekit:shutdown` listeners share this one budget. When it expires the close path continues, the phase that ran out is named in the log, and the process exits. `0` means no budget at all - every phase is awaited for as long as it takes, so a hook that never settles holds the process until your supervisor kills it |
| `RECONNECT_DISPERSAL_MS` | `5000` | Graceful-shutdown reconnect dispersal window (ms); `0` disables the advisory |
| `CLUSTER_WORKERS` | - | Number of worker threads (or `auto` for CPU count) |
| `CLUSTER_MODE` | *(auto)* | `reuseport` (Linux default) or `acceptor` (other platforms) |
| `CLUSTER_RELAY_RING_KB` | `256` | Shared-memory relay ring size per direction per worker (KB). The cross-worker publish fan-out rides SharedArrayBuffer rings instead of structured-clone `postMessage`; `0` falls back to `postMessage` |
| `RESTART_ON_STATE_DIVERGENCE` | - | Set to `1` to terminate a worker the primary detects as diverged (see [Cross-worker state-divergence detection](#cross-worker-state-divergence-detection)). Default: log + metric only |
| `WORKER_BOOT_TIMEOUT_MS` | `60000` | Clustered mode: how long a worker may run its `init` hook before the primary treats a non-acking boot as wedged and escalates the slot. A healthy async init keeps acking the primary's heartbeats and is never affected regardless of how long it takes; only a boot that blocks the event loop (a sync loop / native hang) and stops acking hits this deadline. `0` disables it; a value below two heartbeat intervals (20s) is raised to that floor |
| `WS_DEBUG` | - | Set to `1` to enable structured WebSocket debug logging (open, close, subscribe, publish) |

### Graceful shutdown

Readiness, liveness and accepting new connections are three separate things, and the shutdown sequence moves them at three different moments.

On `SIGTERM` or `SIGINT`, the server:

1. Reports **not ready** - `readinessCheckPath` (default `/readyz`) answers `503` with the body `draining`, so a load balancer stops routing new work here. The server keeps accepting and serving; liveness (`healthCheckPath`, default `/healthz`) keeps answering `200`, so a liveness probe never restarts an instance that is shutting down on purpose.
2. Waits `SHUTDOWN_DELAY_MS` (default `0`) for that readiness change to propagate to the balancer. Still accepting throughout.
3. Runs the `hooks.ws` `shutdown` hook, then closes the listen socket and sends every WebSocket client a clean `1001 Going Away`.
4. Waits for in-flight SSR requests to finish.
5. Runs the `sveltekit:shutdown` listeners on `process` and **awaits** them, so a database pool close or a final durable write completes before the process goes away.
6. Exits.

Steps 3 to 5 share ONE budget, `SHUTDOWN_TIMEOUT` seconds (default 30), which starts after the delay in step 2. Application code runs in steps 3 and 5, and neither can hold the process past that budget: when it expires the sequence continues, the phase that ran out is named on stderr, and the exit still happens. Both receive an `AbortSignal` and the deadline so they can give up cleanly on their own terms.

Set `SHUTDOWN_TIMEOUT=0` if your cleanup must never be cut off: there is then no budget, both phases are awaited to completion, and the hook receives `signal: null, deadline: null` so it can see that nothing will interrupt it. The trade is the obvious one - a hook that never settles holds the process until your supervisor kills it - so the server logs that it is running without a budget.

Readiness also stays `503` during **startup**: the listen socket is bound before your `init` hook runs (so arriving connections are queued by the kernel rather than refused), and readiness only turns green once `init` has resolved. An `init` that throws never turns it green at all. The 503 body is the state itself - `starting` while booting, `draining` once shutdown has begun - so a rolling deploy is readable from the probe alone.

Connected WebSocket clients are advised to reconnect on a jittered schedule before the socket closes, so a draining node's clients scatter across `RECONNECT_DISPERSAL_MS` (default 5000ms) instead of all reconnecting at once and stampeding the replacement node. Set `RECONNECT_DISPERSAL_MS=0` to restore the exact legacy shutdown. To drain a node without shutting it down (e.g. ahead of a rolling deploy), call `platform.adviseReconnect({ windowMs })` yourself - it broadcasts the advisory (optionally to a `filter`ed subset) and returns the count advised.

```js
// Cleanup in your server code (e.g. hooks.server.js). The listener is awaited.
process.on('sveltekit:shutdown', async (reason, { signal, deadline }) => {
  console.log(`Shutting down: ${reason}`);
  await db.close();
});
```

```js
// Or, closer to the app, in src/hooks.ws.js - this one runs BEFORE the socket
// closes, which is where flushing app state belongs.
export async function shutdown({ platform, reason, signal, deadline }) {
  await flushMetrics({ signal });
}
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

When TLS is configured the server hot-reloads the certificate: a renewed cert on disk (certbot / cert-manager) is picked up automatically and served on new handshakes without re-binding the listen socket or dropping live connections. At boot nothing changes - the boot cert is served by the plain TLS context, exactly as with `SSL_WATCH=0`. Only when the cert on disk genuinely changes (its fingerprint differs from the one being served) is the renewed cert registered as a uWS SNI server name for its SAN host(s), with the server's full route set mirrored onto it, so SNI-matching clients get the fresh cert and identical routing. The cert + key are validated before the swap, so a half-written file keeps the previous cert. Set `SSL_WATCH=0` to opt out. A non-SNI / unmatched-SNI client keeps the boot-time cert until a restart (the uWS default context is static). This works in clustered modes too: the primary watches the cert directory and broadcasts the reload to every worker, and each worker validates and fingerprint-gates its own swap, so a renewed cert is served live across the whole cluster without a restart.

A failed reload keeps the previous certificate, which protects availability and also hides the failure - renewal is dead while every probe stays green. So while the reload path is degraded (the watcher failed to start, the certificate on disk did not validate, or a swap failed mid-apply), the server re-reports it hourly on stderr together with the served certificate's expiry and remaining validity, once that certificate is within 14 days of expiring. Readiness is deliberately not tied to certificate expiry: a fleet that takes itself out of rotation over an expiring certificate removes a service that is still serving.

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

// Called when a message is received.
// Note: subscribe/unsubscribe messages from the client store are
// handled automatically BEFORE this function is called.
//
// `msg` is the JSON-parsed envelope when the adapter parsed the frame
// for control-message routing but no control type matched (i.e. it
// looks like `{"type":"<custom>",...}` from a plugin). The adapter
// already did `TextDecoder + JSON.parse` once during routing, so this
// avoids a second parse on the dispatch path. `msg` is `undefined`
// for binary frames, prefix-miss frames, parse failures, or frames
// that parse to a non-object.
export function message(ws, { data, isBinary, msg }) {
  if (msg) {
    // Already-parsed JSON object envelope - dispatch by msg.type
    console.log('Got envelope:', msg);
    return;
  }
  // Binary or non-envelope text frame - decode manually
  console.log('Got raw frame, byteLength:', data.byteLength);
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

// Called when the connection closes. The context carries per-connection
// stats (id / duration / messagesIn / messagesOut / bytesIn / bytesOut)
// alongside `code` / `message` / `subscriptions`. Counters are only
// populated when this hook is exported - the adapter skips the
// per-connection bookkeeping otherwise to keep the hot path zero-cost.
export function close(ws, { code, id, duration, messagesIn, messagesOut, bytesIn, bytesOut, subscriptions }) {
  const { userId } = ws.getUserData();
  console.log(
    `User ${userId} (session ${id}) disconnected after ${duration}ms ` +
    `(${messagesIn} in / ${messagesOut} out, ${bytesIn} / ${bytesOut} bytes, ` +
    `topics: ${[...subscriptions].join(', ')})`
  );
}

// Called when backpressure has drained (optional, for flow control)
export function drain(ws, { platform }) {
  // You can resume sending large messages here
}

// Called when a reconnecting client presents the previous session id
// plus the per-topic seq numbers it last saw. Use this to fill the
// disconnect gap, typically by replaying buffered events. Optional -
// without this hook, reconnects still work; the client just falls
// through to live mode without a gap fill.
export function resume(ws, { sessionId, lastSeenSeqs, platform }) {
  for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
    replay.replay(ws, topic, sinceSeq, platform);
  }
}
```

### Session resume

On every WS open, the server stamps a session id and announces it to the client (`{"type":"welcome","sessionId":"..."}`). The client stores the id in `sessionStorage` (keyed per ws path) and tracks the highest `seq` it has seen for each topic.

When the connection drops and the client reconnects, it presents the previous session id plus the per-topic last-seen seqs in a `{"type":"resume", sessionId, lastSeenSeqs}` frame, sent before `subscribe-batch`. If you export a `resume` hook, you receive `(ws, { sessionId, lastSeenSeqs, platform })` and can replay any events the client missed during the disconnect window. The server acks with `{"type":"resumed"}` once your hook returns; the client then resubscribes and live messages resume.

Without a `resume` hook the protocol is still safe: the server acks the resume frame, the client falls through to live mode, and your app behaves the same as a cold connect.

The session id is per-process and per-connection. It does not persist across server restarts; a client presenting a session id the server has never seen receives the same `resumed` ack and falls through.

#### Detecting a reset seq space (per-topic epoch)

The in-memory seq counters live in process memory and restart at 1 on every server boot. A client that reconnects to a freshly restarted process and presents an old `lastSeenSeqs[topic]` would, if gap-filled naively, be served a brand-new seq space as if it were a continuation - silently skipping or duplicating state. To detect this, each `subscribed` ack carries an `epoch`: the current generation of that topic's seq space. The client tracks it per topic and presents it back as `lastSeenEpochs` (parallel to `lastSeenSeqs`) on resume.

In your `resume` hook, compare each presented epoch to the live one via `platform.topicEpoch(topic)`:

```js
export function resume(ws, { lastSeenSeqs, lastSeenEpochs, platform }) {
  for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
    const presented = lastSeenEpochs?.[topic];
    if (presented !== undefined && presented !== platform.topicEpoch(topic)) {
      // The seq space reset since the client last saw it. Re-read this topic
      // from the source of truth instead of replaying a reset space against a
      // stale offset (e.g. signal a cold-rehydrate on '__replay:' + topic).
      continue;
    }
    replay.replay(ws, topic, sinceSeq, platform); // match: gap-fill as usual
  }
}
```

The epoch is strictly additive. An old client omits it (and an old server omits the ack field); a missing epoch is treated as a match, so resume behaves exactly as before. In a single worker every topic shares the one per-process generation, so a restart cold-rehydrates every tracked topic at once - correct, since the whole in-memory seq map reset together.

### Subscribe acknowledgements

When the client subscribes, it includes a numeric `ref` so the server can ack with the result:

- `{"type":"subscribed", topic, ref, epoch}` - subscription accepted. `epoch` is the current generation of the topic's seq space (see [Detecting a reset seq space](#detecting-a-reset-seq-space-per-topic-epoch)); old clients ignore it.
- `{"type":"subscribe-denied", topic, ref, reason}` - subscription rejected. `reason` is one of the canonical codes `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`, `'RATE_LIMITED'`, or any custom string the server's `subscribe` hook returned.

The denial is surfaced on the client through the `denials` store. Show it as a banner, route to a login page, anything you like:

```svelte
<script>
  import { denials } from 'svelte-adapter-uws/client';
</script>

{#if $denials}
  <p class="error">Cannot subscribe to {$denials.topic}: {$denials.reason}</p>
{/if}
```

The server's `subscribe` hook controls denial reasons:

```js
export function subscribe(ws, topic, { platform }) {
  const { userId, role } = ws.getUserData();
  if (!userId) return 'UNAUTHENTICATED';                  // -> subscribe-denied
  if (topic.startsWith('admin') && role !== 'admin') {
    return 'FORBIDDEN';
  }
  // omit / return undefined / return true -> subscribed
}
```

Old clients that send `subscribe` without a `ref` get no ack frame (silent allow / silent deny, as before). Old servers that ignore `ref` don't break new clients - they just don't emit acks; the client sees no entry in `denials` and treats the subscription as active.

`subscribe-batch` works the same way: one ack frame per topic in the batch, all sharing the batch's single `ref`.

For batch subscribes (typically the resubscribe-on-reconnect path) you can opt into a single-call `subscribeBatch` hook instead of paying N `subscribe` calls. The framework calls it once with all pre-validated topics and applies the returned per-topic decisions:

```js
export async function subscribeBatch(ws, topics, { platform }) {
  const { userId } = ws.getUserData();
  // One DB query for all topics instead of N
  const allowed = await db.allowedTopics(userId, topics);
  const allowedSet = new Set(allowed);
  const denials = {};
  for (const topic of topics) {
    if (!allowedSet.has(topic)) denials[topic] = 'FORBIDDEN';
  }
  return denials; // omit a topic -> allow; false -> FORBIDDEN; string -> that reason
}
```

If you only export `subscribe`, the framework still loops it per topic for batch-subscribes (no behaviour change). Export `subscribeBatch` only when you need the single-query optimization. The hook is sync in this version; for async lookups, pre-cache user grants on `userData` during `upgrade`.

### Message protocol

The adapter uses a JSON envelope format for all pub/sub messages: `{ topic, event, data, seq? }`. Control messages from the client store (`subscribe`, `unsubscribe`, `subscribe-batch`, `resume`) use `{ type, topic, ref? }`, `{ type, topics, ref? }`, or `{ type, sessionId, lastSeenSeqs }`. The server emits `{"type":"welcome","sessionId":"..."}` on open, `{"type":"resumed"}` after a resume frame, and `{"type":"subscribed",...}` / `{"type":"subscribe-denied",...}` per topic when the client supplied a `ref`.

To avoid JSON-parsing every incoming message, the handler uses a byte-prefix discriminator: control messages start with `{"type"` (byte 3 is `y`), while user envelopes start with `{"topic"` (byte 3 is `o`). A single byte comparison skips `JSON.parse` entirely for user messages. Messages over 8 KB are also skipped (generous ceiling for `subscribe-batch` with many topics, well above any realistic control message).

For the complete frame-by-frame wire contract - every control frame, the capability table, the binary `0x03` payload layout, and the resume model - see [PROTOCOL.md](PROTOCOL.md). It is the spec a non-JavaScript client implements against; this section is the at-a-glance summary.

### Topic validation

Topics submitted by clients are validated before being accepted:

- Must be between 1 and 256 UTF-16 code units (an astral symbol such as an emoji costs two, matching the `maxTopicLength` caps in the cursor and throttle plugins)
- Default accept set is printable ASCII (0x20-0x7E) excluding `"` and `\`. Control bytes, line separators (U+2028/U+2029), bidirectional overrides (U+202E), the byte-order mark, and other non-ASCII runes are rejected at the wire boundary so log dashboards and admin UIs see a clean, greppable topic name. Apps that legitimately accept non-ASCII topic names from clients can opt in via `websocket.allowNonAsciiTopics: true` (always-illegal `"` and `\` remain rejected, and so do unpaired surrogates, which have no UTF-8 encoding and would reach the client as a different name than the one that was subscribed to). The opt-in widens the letters and nothing else: with it on, a topic may again contain a bidirectional control or the byte-order mark, so a console that renders topic names back to a human sees whatever the client sent.
- `subscribe-batch` accepts at most 256 topics per message (the client only sends what it was subscribed to before a reconnect)

Topics prefixed with `__` are reserved for framework-internal channels (presence uses `__presence:*`, replay uses `__replay:*`, plus `__signal:*`, `__group:*`, `__rpc`, etc.). Wire-level subscribes to `__`-prefixed topics are rejected with `INVALID_TOPIC`, so a client cannot intercept signals routed to other users or plugin broadcasts. The narrow exception is a namespace registered by a plugin that owns its wire subscription flow: the topic may reach that plugin's hook, but the request still fails unless the hook establishes tracked membership before it returns. Importing the groups plugin therefore does not open arbitrary `__group:*` topics, while its own documented `group.hooks` join can work without disabling the system-topic guard globally. Server-side `platform.subscribe(ws, '__signal:userId')` (the legitimate pattern that `enableSignals` uses) still works because the block is on the wire layer only. Advanced apps that intentionally route public topics through the `__` prefix can opt out broadly via `websocket.allowSystemTopicSubscribe: true`.

### Wire-subscribe authorization

By default the adapter is a primitive: any connected client may subscribe to any valid, non-`__` topic, and per-topic authorization is entirely your [`subscribe` hook](#authentication) (with no hook, subscription is open). That is the right default for a building block, but it leaves a gap for a framework that authorizes subscriptions **server-side** - in an RPC handler that runs a guard and then calls `platform.subscribe(ws, topic)` - rather than in a wire hook. In that model a client could still send a raw `{ type: 'subscribe', topic }` frame for a topic it was never granted (a private room, another tenant's channel) and receive its fan-out, because the guard ran only on the server-initiated subscribe, not the client's wire frame.

Set `websocket.authorizeWireSubscribe: true` (or call `platform.authorizeWireSubscribe()` once at startup) to close that gap. With it on, a client-initiated `subscribe` / `subscribe-batch` is honored only for a topic the server already authorized for that connection via `platform.subscribe` - unless you export your own `subscribe` / `subscribeBatch` hook, which then decides every topic exactly as before. Two things do *not* stand the gate down, because neither is your app deciding: a plugin hook you re-export verbatim (presence's and groups' are marked as side effects, so following their READMEs no longer disables the gate for every other topic), and a plugin's own `__`-prefixed channel (a group is joined by subscribing to `__group:<name>`, which that plugin's hook authorizes - the gate defers to it there and nowhere else). Wrap a plugin hook in your own function and it counts as yours again. Server-side `platform.subscribe` is the trusted path and is never gated; `platform.checkSubscribe` is gated only when you pass `{ requireGrant: true }`, which is what the presence and cursor observer lanes do. Observer membership is rechecked after an async side-effect hook, so `platform.unsubscribe` revokes an in-flight check instead of letting it return an obsolete allow; a real re-grant before the hook lands remains valid. A framework whose subscriptions are all server-initiated (like [`svelte-realtime`](https://github.com/lanteanio/svelte-realtime), which authorizes each subscription in its stream RPC) arms this automatically. A client that attaches server-managed topics can suppress its own redundant subscribe frame with the client-side `setTopicManaged(topic)` (exported from `svelte-adapter-uws/client`).

For `npm run dev`, repeat the static flag on the Vite plugin: `uws({ authorizeWireSubscribe: true })`. The adapter's `websocket` object is build configuration; it is not copied into the separate plugin instance created by `vite.config.js`. Omitting the flat plugin option therefore leaves the dev server at its documented open default even when the production build is armed.

### Explicit handler path

If your handler is somewhere other than `src/hooks.ws.js`:

```js
adapter({
  websocket: {
    handler: './src/lib/server/websocket.js'
  }
})
```

Name it here and you are done: the Vite dev plugin reads the value from SvelteKit's resolved configuration (whether it came from `svelte.config.js` or the direct `sveltekit(config)` form), so the module the dev server runs is the module the build bundles. Adapter handler paths keep the adapter's project-working-directory base even when Vite has an explicit `root`. The plugin also accepts a `handler` of its own (`uws({ handler })`); naming a *different* module on both fails the build rather than one of them quietly winning, and the build log names the module it actually bundled.

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
  // It throws a TypeError for a header that cannot be written safely - a name
  // outside the RFC 7230 token set, a non-string value, or a string outside
  // Node's accepted header class (TAB, printable ASCII and Latin-1 high bytes).
  // CR, LF and NUL split or truncate the 101; the other refused controls fail
  // at strict Node-based proxies. The throw takes the hook-error path: 500, no
  // 101. Passing no headers at all
  // is fine, so `upgradeResponse(ud, refresh ? headers : undefined)` works.
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

For short-lived sessions you often want to rotate the session cookie every time a client connects. The obvious approach - attaching `Set-Cookie` to the 101 Switching Protocols response via `upgradeResponse()` - is RFC-compliant but **is silently rejected by Cloudflare Tunnel, Cloudflare's proxy, and some other strict edge proxies**. The symptom is that the WebSocket `open` handler fires server-side, then the connection closes with code 1006 (`Received TCP FIN before WebSocket close frame`) before any frames are exchanged. The adapter emits a build-time warning when it detects this pattern.

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
- The hook is only mounted when `authenticate` is exported from `hooks.ws` - no runtime cost when unused.
- Dev mode (Vite plugin) mirrors the production route on the same path.
- The endpoint requires `x-requested-with: XMLHttpRequest`, `Sec-Fetch-Site: same-origin`, or an `Origin` matching `allowedOrigins` (CSRF defense). The adapter client always stamps `x-requested-with`. Native (non-browser) clients that need to reach this endpoint without those headers can opt out via `websocket.authPathRequireOrigin: false`. See [Security configuration](#security-configuration).

**Why not put `Set-Cookie` on the 101?**

Cloudflare's HTTP/2 WebSocket bridging rewrites 101 responses, and `Set-Cookie` on the 101 trips the edge into tearing the connection down. This is undocumented Cloudflare behavior, but reproducible on every tunnel and proxy connector. The `authenticate` hook sidesteps it entirely by using a standard HTTP response.

---

## Platform API (`event.platform`)

Available in server hooks, load functions, form actions, API routes, and WebSocket hooks (`hooks.ws`).

### `platform.publish(topic, event, data, options?)`

Send a message to all WebSocket clients subscribed to a topic.

Topic and event names are validated before being written into the JSON envelope - quotes, backslashes, and control characters will throw. This prevents JSON injection when names are built from dynamic values like user IDs (`platform.publish(\`user:\${id}\`, ...)`). The validation is a single-pass char scan and adds no measurable overhead.

In cluster mode, the message is automatically relayed to all other workers. Pass `{ relay: false }` to skip the relay when the message originates from an external pub/sub source (Redis, Postgres LISTEN/NOTIFY, etc.) that already delivers to every process:

```js
// Redis subscriber running on every worker - relay would cause duplicates
sub.on('message', (channel, payload) => {
  platform.publish(channel, 'update', JSON.parse(payload), { relay: false });
});
```

Every published frame is also stamped with a monotonic per-topic `seq` field in the envelope (first publish to a topic is `seq: 1`, then 2, 3, ...). Reconnecting clients can use this to detect dropped frames and resume from where they left off. Pass `{ seq: false }` to skip stamping for ephemeral or high-cardinality topics where the counter map would grow unbounded. Pass `{ seq: <number> }` to stamp an explicit, externally-authoritative sequence instead of the in-memory counter (the counter is left untouched) - the hook a replay backend uses to keep the broadcast frame and its buffer on one sequence space across a restart or across cluster instances:

```js
// Skip seq for per-user cursor topics: counter map would grow with users
platform.publish(`cursor:${userId}`, 'move', pos, { seq: false });
```

Pass `{ jitterMs }` to de-herd a thundering-herd broadcast: the frame carries a de-herd WINDOW, and each receiving client rolls its own random delay in `[0, jitterMs)` before dispatching, so a broadcast that makes N clients all react ramps across the window instead of spiking at t+0. The outbound fan-out stays a single native publish - the window is carried verbatim, never a server-rolled offset (which would defer every subscriber identically). Omit / `0` = immediate; the no-jitter frame is byte-identical to before. `svelte-realtime`'s `ctx.publish(..., { jitterMs })` validates the window to a 60s ceiling and the client clamps it again:

```js
// One reroute event; 50k clients ramp their re-fetch across 5s instead of at once
platform.publish('route:i95-incident', 'reroute', detour, { jitterMs: 5000 });
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

### `platform.sendCoalesced(ws, { key, topic, event, data })`

Send a message to a single connection with **coalesce-by-key** semantics. Each `(connection, key)` pair holds at most one pending message; if a newer call for the same `key` arrives before the previous frame drains to the wire, the older value is replaced in place.

Use this for latest-value streams where intermediate values are noise - price ticks, cursor positions, presence state, typing indicators, scroll position. Under load, this is the difference between the client lagging by a thousand stale frames and the client always seeing the most recent value.

If you want a backpressured subscriber to keep eventually receiving the latest value (the queue-and-drain shape), `sendCoalesced` is the right primitive. If you want backpressured subscribers skipped entirely so the wire stays current for everyone else, use `platform.publish` / `platform.send` instead - those drop on backpressure (see the "Volatile / fire-and-forget delivery" section below). `sendCoalesced` is explicitly drop-the-middle, keep-the-latest; `publish` / `send` are explicitly drop-the-laggard, keep-everyone-else-current.

```js
// src/hooks.ws.js - cursor positions during a collaborative edit
export function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  if (msg.event === 'cursor') {
    const { docId, userId } = ws.getUserData();
    // Coalesce per (connection, user) - one pending cursor frame per peer.
    // High-frequency mousemove updates collapse cleanly under backpressure.
    for (const peer of getPeersOf(docId)) {
      platform.sendCoalesced(peer, {
        key: 'cursor:' + userId,
        topic: 'doc:' + docId,
        event: 'cursor',
        data: { userId, x: msg.data.x, y: msg.data.y }
      });
    }
  }
}
```

Three properties worth knowing:

- **Latest value wins.** `set` on an existing key replaces the value but keeps the original slot, so coalescing one key never reorders the rest of the queue.
- **Lazy serialization.** `data` is held as-is in the per-connection buffer and only `JSON.stringify`'d at flush time. A stream that overwrites the same key 1000 times before a single drain pays one serialization, not 1000.
- **Auto-resume on drain.** When `maxBackpressure` is hit, pumping stops and resumes on the next uWS drain event automatically. No manual flow control.

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

> **Performance:** `sendTo` iterates every open connection and runs your filter function against each one. It's fine for low-frequency operations like sending a DM or notifying admins, but don't use it in a hot loop. If you're broadcasting to a known group of users, subscribe them to a shared topic and use `platform.publish()` instead - topic-based pub/sub is handled natively by uWS in C++ and doesn't touch the JS event loop.

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

### `platform.forEachSubscriber(topic, fn)`

Where `subscribers(topic)` returns a count, `forEachSubscriber(topic, fn)` yields the sockets themselves - it invokes `fn(ws, userData)` once for every connection on this instance subscribed to `topic`. Use it when a single shared `publish` cannot express the fan-out: send each subscriber a different slice (per-viewport cursor culling), skip a back-pressured consumer, or vary the payload per recipient.

```js
// Backpressure-aware per-subscriber cursor fan-out:
platform.forEachSubscriber(`__cursor:${board}`, (ws) => {
  if (platform.bufferedAmount(ws) > maxQueued) return; // skip a slow consumer; it catches up next flush
  platform.send(ws, `__cursor:${board}`, 'bulk', sliceFor(ws));
});
```

The walk is O(connections) and synchronous, and is paid only by the caller, so reserve it for the topics that genuinely need per-subscriber treatment; the zero-config `publish` path never calls it. Pair it with `platform.send` (closed-WS safe) and `platform.bufferedAmount` inside `fn`. In clustered mode each instance holds only its own connections, so the walk is per-instance - the same locality the Redis-backed cursor / presence variants rely on.

### `platform.assertions`

Per-category counter of framework invariant violations. The adapter ships internal hard-asserts at ~30 invariant sites (envelope build, WebSocket lifecycle, subscription bookkeeping, cross-worker IPC payloads, server-initiated request entry shape, sendCoalesced state). When one fires, the counter for that category increments and a structured `[adapter-uws/assert]` line is logged.

Most apps will never see a non-empty entry here. A non-zero counter indicates a regression in the framework or a third-party plugin and should be reported as a GitHub issue with the category string and accompanying log context.

```js
export async function GET({ platform }) {
  // Surface the counters in your /healthz or ops dashboard
  const assertions = {};
  for (const [category, count] of platform.assertions) {
    assertions[category] = count;
  }
  return json({ healthy: Object.keys(assertions).length === 0, assertions });
}
```

The returned `Map` is the live module-level instance - read-only, do not mutate. In test mode (`process.env.VITEST` set, or `NODE_ENV === 'test'`) the assert helper additionally throws so test runners surface the failure; in production it logs and counts but does not throw, so a violation inside a uWS callback frame cannot crash the worker.

### `platform.closedWsAborts`

Per-worker count of best-effort uWS operations that aborted because the underlying WebSocket had already closed. Bumped every time `platform.subscribe`, `platform.unsubscribe`, `platform.send`, `platform.sendCoalesced`, `platform.sendTo`, or `platform.request` is called on a `ws` whose native handle has been freed - typically because the caller `await`-ed something (auth, loader, subscribe hook) and the client closed during the wait.

These methods are *closed-WS safe* by contract: they swallow uWS's `Invalid access of closed uWS.WebSocket` exception, return a success-shaped no-op sentinel (`null` for subscribe, `false` for unsubscribe, `2` for send, etc.), and bump this counter. Callers can fire-and-forget without a per-site try/catch.

```js
export async function GET({ platform }) {
  return json({ closedWsAborts: platform.closedWsAborts });
}
```

A non-zero value is normal under client churn (tab close, network blips, mass reconnect waves). A rapidly-growing value under steady load indicates either pathological client behaviour or that the server's async setup path is too long for its connect rate. In clustered mode, sum across workers for cluster-wide visibility.

Monotonic, per-worker, reset only on process restart.

### `platform.introspect()`

A PII-free snapshot of this worker's transport-layer health in one read: `connections`, `closedWsAborts`, the `protection` posture, `maxPayloadLength`, the scalar `pressure` signals (without `topPublishers` - topic names can embed ids), and the `assertions` counters. Counts and enums only - never a topic name, user id, or socket handle. Pure (a fresh plain object each call), so it is safe behind an auth-gated admin route or a scrape interval.

```js
export function GET({ platform }) {
  return json(platform.introspect());
  // { connections: 38, closedWsAborts: 0, protection: 'normal', maxPayloadLength: 1048576,
  //   pressure: { active: false, reason: 'NONE', value: 0, subscriberRatio: 0, publishRate: 0, memoryMB: 0 },
  //   assertions: {} }
}
```

`svelte-realtime`'s `introspect()` composes this under a `transport` key automatically, so its admin route surfaces the dispatch snapshot and this transport snapshot from one call.

### The reserved `/__realtime/*` admin route

When your WebSocket handler exports an `admin(request)` function - `svelte-realtime`'s auth-gated observability handler is the canonical one - the adapter mounts it at the reserved `/__realtime/*` path, registered **before** the SSR catch-all so admin traffic never hits page routing. The adapter bridges the uWS request to the framework-agnostic Web `Request` -> `Response` contract the handler speaks and writes the response back; it is pure transport plumbing, so **all** authorization lives in your handler (the adapter never inspects or short-circuits the decision). A handler that throws, rejects, or returns a non-`Response` yields a generic `500` with no detail leaked. The route is a no-op unless the handler exports `admin`, so existing apps are unaffected.

Configure the prefix with `websocket.adminPath`:

```js
// svelte.config.js
adapter({
  websocket: {
    adminPath: '/__ops'   // relocate it (default '/__realtime')
    // adminPath: false    // OR disable the auto-mount entirely
  }
});
```

Set a **string** to relocate the route (defense-in-depth, or to avoid colliding with an app route), or **`false`** to disable the auto-mount entirely - for apps that mount the `admin` handler themselves through a SvelteKit `+server.js` route (with their own middleware), so there is no second adapter-owned mount point. It must be an absolute path differing from `websocket.path` and `websocket.authPath`; an invalid value fails the build. The `svelte-realtime` admin handler is mount-prefix agnostic, so the path is configured here in one place.

### `platform.pressure` and `platform.onPressure(cb)`

Worker-local backpressure signal. The adapter samples once per second (configurable) and reports the most urgent active stress as a single `reason` enum, so user code can degrade with intent instead of generic panic.

```js
platform.pressure
// {
//   active: false,
//   value: 0,                     // 0..1 saturation scalar (0 idle, 1 saturated)
//   subscriberRatio: 12.4,        // total subscriptions / connections, on this worker
//   publishRate: 240,             // platform.publish() calls/sec, last sample
//   memoryMB: 128,                // process.memoryUsage().rss in MB
//   reason: 'NONE',               // 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY'
//   maxBufferedBytes: 0,          // worst per-connection outbound queue seen this tick (vs maxBackpressure)
//   backpressuredConnections: 0   // sampled connections holding a notable (>64 KB) outbound queue
// }
```

`maxBufferedBytes` and `backpressuredConnections` are the outbound-queue view: `publish` fans out in C++ and drops silently past `maxBackpressure`, so these are how you SEE that shedding. The sampler reads `getBufferedAmount()` for a bounded sample of connections (up to 1024 per tick, so the cost is fixed even on a large worker); compare `maxBufferedBytes` against `maxBackpressure` (1 MB default) to gauge how close the worst consumer is to being shed, and set `closeOnBackpressureLimit` if you want a chronically wedged consumer dropped instead of shed forever.

`value` folds the worst of the threshold signals and per-connection send-pressure into one number, so `platform.pressure.value > 0.8` is a coarse load gauge when you do not need to branch on the specific `reason`. Reading `platform.pressure` is a property access - safe in hot paths, no I/O. Use it for synchronous shed decisions in request handlers:

```js
// src/routes/api/heavy-write/+server.js
export async function POST({ platform, request }) {
  if (platform.pressure.reason === 'MEMORY') {
    return new Response('Try again shortly', { status: 503 });
  }
  // ... normal write path
}
```

`platform.onPressure(cb)` fires only on **transitions** (when `reason` changes between samples), not on every tick. Returns an unsubscribe function:

```js
// src/hooks.ws.js - notify the connected client when pressure state changes
export function open(ws, { platform }) {
  const off = platform.onPressure(({ reason, active }) => {
    platform.send(ws, '__pressure', reason, { active });
  });
  ws.getUserData().__offPressure = off;
}

export function close(ws) {
  ws.getUserData().__offPressure?.();
}
```

**Reason precedence is fixed:** `MEMORY > PUBLISH_RATE > SUBSCRIBERS`. A worker under multiple stresses reports the most urgent one. Memory wins because the worker is approaching OOM and nothing else matters; publish rate is next because CPU saturation cascades fastest; subscriber ratio is last because heavy fan-out degrades gracefully.

**Thresholds are configurable per-deployment.** Defaults are conservative - a healthy small app should never trip them in steady state. Override via `WebSocketOptions.pressure`:

```js
// svelte.config.js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter({
      websocket: {
        pressure: {
          memoryHeapUsedRatio: 0.9,         // default 0.85
          publishRatePerSec: 50000,          // default 10000 (aggregate)
          subscriberRatio: false,            // disable this signal
          sampleIntervalMs: 500,             // default 1000; clamped to >=100
          topicPublishRatePerSec: 10000,     // default 5000 (per topic)
          topicPublishBytesPerSec: 5_000_000 // default 10485760 (10 MB/s per topic)
        }
      }
    })
  }
};
```

Set any individual threshold to `false` to disable that signal. `sampleIntervalMs` is clamped to a minimum of 100 ms.

> **Clustering:** `platform.pressure` is per-worker. Each worker samples its own counters and reports its own snapshot. There is no aggregate "cluster pressure" - a hot worker should shed its own load without waiting for the rest of the cluster.

#### Per-topic publish-rate detection

Beyond the aggregate `publishRatePerSec` signal, the sampler also tracks **per-topic** publish rates and surfaces the top 5 each tick:

```js
platform.pressure.topPublishers
// [
//   { topic: 'cursor:room-42', messagesPerSec: 8500, bytesPerSec: 1234567 },
//   { topic: 'audit:org-1',    messagesPerSec: 1200, bytesPerSec:  234567 },
//   ...
// ]
```

When a topic crosses `topicPublishRatePerSec` or `topicPublishBytesPerSec` in a sample window, the adapter flags it as a runaway publisher. By default this prints a throttled `console.warn` (one per topic per minute). For programmatic handling, register `platform.onPublishRate(cb)` - doing so suppresses the default warning so you own the surface:

```js
platform.onPublishRate((events) => {
  for (const e of events) {
    metrics.record('runaway_publisher', {
      topic: e.topic,
      msgRate: e.messagesPerSec,
      byteRate: e.bytesPerSec
    });
  }
});
```

The bookkeeping is cheap: the per-topic counter mutates two integer fields in place per `platform.publish()` call (one entry allocated the first time a topic is published to, then zero allocations forever after). Set `topicPublishRatePerSec: false` and `topicPublishBytesPerSec: false` to disable per-topic tracking entirely if you do not want it.

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

### `platform.request(ws, event, data, options?)`

Send a request to one connection and await its reply. Use this for server-driven confirmations, capability challenges, or any flow where the server needs an answer from a specific client.

```js
// In a hook on the server
const reply = await platform.request(ws, 'confirm-action', { op: 'delete' }, {
  timeoutMs: 5000
});
if (reply.confirmed) {
  await actuallyDelete();
}
```

The framework picks a fresh `ref`, sends `{type:'request', ref, event, data}`, and the returned Promise resolves with whatever the client's `onRequest` handler returned. Rejects with `Error('request timed out')` after `timeoutMs` (default `5000`) and with `Error('connection closed')` if the WebSocket closes before a reply arrives.

The client side opts in by registering a single handler:

```js
import { onRequest } from 'svelte-adapter-uws/client';

onRequest(async (event, data) => {
  if (event === 'confirm-action') {
    return { confirmed: confirm(`Are you sure? (${data.op})`) };
  }
  throw new Error('unknown event: ' + event);
});
```

Throw or reject from the handler to send an error reply; the server's awaiting Promise rejects with the same message. With no handler installed, request frames are dropped silently and the server times out.

### `platform.publishBatched(messages)`

Publish a list of `{topic, event, data}` events as a single `{type:'batch', events:[...]}` WebSocket frame per affected subscriber, instead of one frame per event. Each subscriber receives only the events whose topics are in their subscription set, in submitted order. Subscribers with no overlap with the batch's topics receive nothing.

```js
// Form action publishing several related events:
export const actions = {
  closeBook: async ({ platform }) => {
    const { items, audit } = await db.closeBook();
    platform.publishBatched([
      ...items.map(i => ({ topic: 'org:42:items', event: 'updated', data: i })),
      { topic: 'org:42:audit', event: 'closed', data: audit }
    ]);
  }
};
```

The frame the client receives:

```json
{ "type": "batch", "events": [
  { "topic": "org:42:items", "event": "updated", "data": ..., "seq": 17 },
  { "topic": "org:42:items", "event": "updated", "data": ..., "seq": 18 },
  { "topic": "org:42:audit", "event": "closed", "data": ..., "seq": 4 }
] }
```

The bundled `svelte-adapter-uws/client` decodes the batch frame and dispatches each contained event through the same per-topic store ladder a single-event frame would take - indistinguishable from N individual frames except for the latency drop and the lower onmessage bill.

**When the win shows up.** Wire-level batching has two characteristic shapes that pay off:

- **Bulk fan-out, single topic.** A bulk import publishing 50 events to a topic with 500 subscribers used to send 25,000 frames (50 events x 500 subs); now it sends 500 frames (1 batch x 500 subs). The publishBatched path benches at ~3.2M events/sec on this profile vs ~840K events/sec for an equivalent `publish()` loop (~3.8x speedup, measured locally).
- **Room-state reset, overlapping topics.** A handler that publishes 5 events across 3 rooms where every viewer is in all 3 rooms benches at ~1.46M events/sec vs ~1.15M events/sec for the loop (~27% speedup).

**When the win does not apply.** Mixed subscriber views (some subs see only a subset of the batch's topics) and small disjoint batches (e.g. 3 events to 3 topics with disjoint subscriber sets) cannot share one frame - the C++ TopicTree fanout used by `publish()` is faster than building per-subscriber payloads in JS for those shapes. `publishBatched` detects these cases and falls back to a per-event `publish()` loop, so calling it is at least as fast as the publish loop the user would have written by hand. Verified on a third bench profile (3 events x 50 subs disjoint topics): delta `0.3%` (within noise).

**Capability handshake.** The client opts in by sending `{type:'hello', caps:['batch']}` after the WebSocket opens. The bundled client does this automatically. When the server detects that any interested subscriber has not advertised the `'batch'` capability, the call falls back to the publish loop so old clients receive plain envelopes they can decode. Mixing old and new clients in the same call is safe; old clients simply do not benefit from the batched optimization.

**Cross-worker relay.** A single `publish-batched` IPC frame carries the full event list to other workers in cluster mode. Each receiving worker re-runs the fast-path detection against ITS local subscriber set and dispatches via either a single batch envelope (fast path) or per-event publishes (slow path). Wire batching is preserved cluster-wide instead of degrading to per-event relays at the worker boundary. Pass `{relay: false}` per-event to skip the relay (use when the messages came from an external pub/sub source already fanning out to every worker).

**Coalesce by key.** Each event takes an optional `coalesceKey?: string` field. Events that share a key collapse so only the latest value survives, with the surviving entry kept at the latest occurrence's position. Events without a key pass through unchanged. Use this for high-frequency batches where intermediate values are noise - a single call carrying 100 cursor positions for the same user delivers only the latest.

```js
platform.publishBatched(positions.map(p => ({
  topic: 'cursors',
  event: 'move',
  data: p,
  coalesceKey: 'cursor:' + p.userId   // latest position per user wins
})));
```

**Frame-size budget.** A batched frame larger than 256 KB triggers a throttled `console.warn`; uWS per-message-deflate may kick in at large sizes and surprise CPU budgets. Chunk into multiple `publishBatched` calls when the warning fires.

**Order and seq.** Within one batched frame, events appear in call order (after any `coalesceKey` collapsing). Each event is independently stamped with a per-topic monotonic `seq`, identical to `publish()`; pass `{seq: false}` per-event to skip stamping for that one event. The streaming `sendCoalesced` API (per-key replacement on a single connection) is independent of `publishBatched`'s batch-level `coalesceKey`; mixing the two on the same subscriber is supported but produces separate frames.

**Two distinct contracts - pick one.** The existing `platform.batch(messages)` is NOT wire-level batching - it is a `for` loop calling `publish()` once per message, so N submitted messages still produce N WebSocket frames per subscribed connection. The cross-worker relay coalesces per microtask, but the client still pays N onmessage dispatches. Use `batch()` when you want per-message return values; use `publishBatched()` when you want one-frame-per-subscriber wire batching.

### `platform.requestTopic(topic, event, data, options?)`

Broadcast-with-reply: the request/reply analog of `publish`. Sends a request to **every** connection subscribed to `topic` on this instance and resolves with one result per subscriber.

```js
const results = await platform.requestTopic('room:42', 'ping', { at: Date.now() }, { timeoutMs: 1000 });
// [{ ok: true, reply }, { ok: false, error: 'request timed out' }, ...]
const live = results.filter((r) => r.ok).map((r) => r.reply);
```

**Partial success** is the contract: a subscriber that times out, errors, or whose socket closed lands in the array as `{ ok: false, error }` and never fails the whole call. `timeoutMs` (default 5000) bounds each request; since they run concurrently it is effectively the whole-fan-out budget. Walks this worker's subscriber set - a topic whose subscribers span a cluster is handled per-instance (cross-instance broadcast is the extensions layer's job). `svelte-realtime`'s `live.push({ topic })` / `live.notify({ topic })` aggregate this.

### `platform.grantPublish(ws, topic)` / `revokePublish(ws)` / `publishGrant(ws)` - client-driven relay (the game lane)

By default only your server code publishes to a topic. The **game lane** lets an authorized client publish to the one room it was granted, with the server stamping the ordering seq and fanning out to the room - the wire for a real-time session where every participant emits input (a game, a shared simulation) rather than one server-side author. It is the publish dual of [wire-subscribe authorization](#wire-subscribe-authorization).

`platform.grantPublish(ws, topic)` binds a connection to publish to exactly one `topic` - typically at join, right after your guard authorizes the connection for the room. `revokePublish(ws)` clears it (session end); `publishGrant(ws)` returns the bound topic or `null`.

```js
// In your join RPC / subscribe gate, once the connection is authorized:
export function subscribe(ws, topic, { platform }) {
  platform.grantPublish(ws, topic); // the client may now publish to this room
}
```

A granted client sends `{ type: 'game', event, data, id? }` - **no topic**: the server derives it from the grant, so a client can never publish to a room it did not join, nor spoof another room. The server stamps a monotonic per-room `seq` and fans the frame out to the room's other subscribers as an ordinary event envelope `{ topic, event, data, seq, id? }`, with the **sender excluded** (it already holds its own input and predicts locally) and the client-chosen `id` echoed so a receiver can reconcile it against its prediction. An ungranted frame is answered to the sender with `{ type: 'game-denied', reason: 'FORBIDDEN' }`; a granted-but-malformed frame (a non-string `event`) with `reason: 'INVALID'`. The lane is additive and needs no capability token (PROTOCOL.md section 3.10).

`platform.publishGame(senderWs, topic, event, data, id?)` is the same relay from server code: it stamps the room seq and fans out excluding `senderWs` (pass `null` to include everyone - e.g. a server-authored or bot frame), returning `{ seq, delivered }`. On the `svelte-realtime` client the game lane is consumed by the smoothed-entity command channel. A client on a hot input path can run the lane over the compact `0x03` binary transport instead of JSON (ingress kind `game:1`, PROTOCOL.md section 6.6) - same semantics, opt-in, transparent.

### `platform.requestId`

A correlation id you can thread through structured logs to follow a single request across server hooks, load functions, and downstream services.

For HTTP requests, a fresh UUID is generated per request. For WebSocket connections the id is stamped once at upgrade and reused for every hook on that connection (`open`, `subscribe`, `message`, `drain`, `close`). In both cases an inbound `X-Request-ID` header overrides the generated value when present, so callers, gateways, and tracing collectors can supply their own id and have it follow the request through your code.

```js
// src/routes/api/orders/+server.js
export async function POST({ platform, request }) {
  const log = logger.child({ requestId: platform.requestId });
  log.info('order request received');

  const order = await db.create(await request.json());
  platform.publish('orders', 'created', order);

  log.info({ orderId: order.id }, 'order published');
  return json({ ok: true, requestId: platform.requestId });
}
```

```js
// hooks.ws.js - the same id flows through every WS hook on a connection
export function open(ws, { platform }) {
  logger.info({ requestId: platform.requestId }, 'ws open');
}

export function close(ws, { platform, code }) {
  logger.info({ requestId: platform.requestId, code }, 'ws close');
}
```

The header value is sanitized before being used: only printable ASCII (no whitespace, no control chars) up to 128 chars is honoured. Anything else is ignored and a fresh UUID is generated instead, so the id is always safe to interpolate into log lines.

The adapter never writes `X-Request-ID` on the response automatically - emitting it back is an app-layer choice (usually for outbound observability). Set it explicitly if you want callers to see it:

```js
return new Response(body, {
  headers: { 'x-request-id': platform.requestId }
});
```

> **Dev-mode note:** in `vite dev`, the dev server generates a fresh UUID per request but does not honour `X-Request-ID` for HTTP traffic (SvelteKit's `emulate.platform()` runs without access to request headers). Production reads the header. Dev-mode WebSocket connections honour the header normally.

### Volatile / fire-and-forget delivery

`platform.publish`, `platform.send`, and `platform.publishBatched` are **all volatile under backpressure**. When a specific subscriber's outbound buffer is over `maxBackpressure` (default 1 MB, configurable in `websocket.maxBackpressure`), uWS skips that subscriber for that frame while continuing to deliver to every non-backpressured subscriber. The skip is silent, per-subscriber, and does not queue for retry. There is no separate `volatile: true` flag because the volatile semantic is the default.

This is the right behavior for transient state where stale values are worse than dropped ones - cursor positions, typing indicators, presence pings, telemetry pulses, draft auto-saves. Slow / disconnected / backgrounded subscribers fall behind silently while everyone else stays current.

```js
// Cursor broadcast: every reader gets the latest position they can keep up
// with; lagging readers silently lose intermediate values, no queue grows.
platform.publish(`doc:${docId}:cursors`, 'move', { userId, x, y }, { seq: false });
```

Pair with `{ seq: false }` to opt out of seq stamping for these high-cardinality, replay-uninteresting topics. The seq counter map is per-topic and grows with cardinality, so opting out keeps memory bounded for unbounded-cardinality topic spaces like `cursor:${userId}` or `presence:${sessionId}`.

For the **drop-the-middle, keep-the-latest** shape on a single connection (the value still arrives, just collapsed across intermediate frames), use `platform.sendCoalesced(ws, ...)` instead. That path queues per `(connection, key)` and drains on the next uWS `drain` event rather than dropping. Quick comparison:

| Primitive | Behavior under backpressure |
|---|---|
| `platform.publish` / `send` / `publishBatched` | Skip the backpressured subscriber, deliver to others. No retry. |
| `platform.sendCoalesced(ws, { key, ... })` | Queue per `(ws, key)`, latest value wins, drain on next `onWritable`. |

To tune how aggressively backpressured subscribers get skipped, lower `maxBackpressure` in `websocket` options (the smaller the buffer, the sooner uWS starts skipping). The 1 MB default favors keeping the connection alive over shedding load; drop to 64 KB or 256 KB if your workload prefers shedding faster.

For visibility into whether subscribers are actually being skipped at scale, watch `platform.pressure.publishRate` and `platform.pressure.topPublishers` - a topic publishing far above its consumer rate is the canonical signature of a backpressure-shedding workload.

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

Readable store with the current connection state. Five states drive distinct UI affordances:

- `'connecting'` - establishing a connection (initial attempt or retry)
- `'open'` - connected, live data is flowing
- `'suspended'` - WS is technically open but the tab is in the background; server may close idle backgrounded sockets, so live data is best-effort
- `'disconnected'` - lost connection, will retry automatically
- `'failed'` - terminal: auth denied, max retries exhausted, or `close()` called

```svelte
<script>
  import { status } from 'svelte-adapter-uws/client';
</script>

{#if $status === 'open'}
  <span class="badge green">Live</span>
{:else if $status === 'suspended'}
  <span class="badge muted">Paused (tab in background)</span>
{:else if $status === 'connecting'}
  <span class="badge yellow">Connecting...</span>
{:else if $status === 'disconnected'}
  <span class="badge orange">Reconnecting...</span>
{:else}
  <span class="badge red">Connection failed</span>
{/if}
```

The `'suspended'` overlay flips back to `'open'` automatically when the tab returns to the foreground (assuming the WebSocket survived the hide period; if it did not, the state machine drives `'connecting'` -> `'open'` via the normal reconnect path).

### `failure` - cause of the most recent disconnect

Sibling Readable to `status`. Use `status` to drive UI state; use `failure` to drive what message you show. Stays at `null` while connected, set when the connection drops, cleared on the next successful `'open'`.

The value is a discriminated union by `kind`:

```ts
type Failure =
  | { kind: 'ws-close'; class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY'; code: number; reason: string }
  | { kind: 'auth-preflight'; class: 'AUTH'; status: number; reason: string };
```

Five `class` values let consumers render targeted UI without inspecting raw close codes:

- `'TERMINAL'` - server permanently rejected the client (close codes 1008 / 4401 / 4403). The retry loop is stopped; the user must re-authenticate or refresh.
- `'EXHAUSTED'` - reconnect attempts exceeded `maxReconnectAttempts`. The network never recovered; surface a manual-retry button.
- `'THROTTLE'` - server signalled rate-limiting (close code 4429). Reconnect is still scheduled, jumped ahead in the backoff curve.
- `'RETRY'` - normal transient drop (1006 abnormal closure, network blip, server restart). Reconnect is in progress; usually paired with the `'disconnected'` status.
- `'AUTH'` - the auth preflight (`{ auth: true }`) failed before the WebSocket was opened. 4xx is terminal; 5xx and network errors retry. The HTTP status code is in `status`, not `code`.

`failure === null` while `status === 'failed'` is the deliberately-ended state - the user called `close()`, not a transport-level failure.

```svelte
<script>
  import { status, failure } from 'svelte-adapter-uws/client';
</script>

{#if $failure?.class === 'TERMINAL'}
  <p class="error">Session expired. <a href="/login">Sign in again</a></p>
{:else if $failure?.class === 'EXHAUSTED'}
  <p class="error">Connection lost. <button onclick={() => location.reload()}>Reload</button></p>
{:else if $failure?.class === 'THROTTLE'}
  <p class="warn">Server is busy. Retrying shortly...</p>
{:else if $failure?.class === 'AUTH'}
  <p class="error">Could not authenticate (HTTP {$failure.status}). <a href="/login">Sign in</a></p>
{:else if $status === 'disconnected'}
  <span>Reconnecting...</span>
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

**Suspend detection**: a device sleep freezes the monotonic clock while the wall clock keeps counting, so on wake the client compares the two deltas. When the gap exceeds 60 seconds and the socket has not delivered a frame in the last few seconds, a still-open socket is not trusted - the server has usually idle-dropped it without the close frame ever arriving - and the client force-reconnects immediately with a session resume, instead of showing frozen data until the silence detector catches up. A socket that provably survived the sleep (a fresh frame already arrived) is left alone. Checked when the tab becomes visible, when it hides, and on the 30-second detector tick, so a lid-close on a visible tab is caught whichever event fires first.

**Batch resubscription**: on reconnect, all topics are resubscribed in batched `subscribe-batch` messages. Each batch stays under the server's 8 KB control-message ceiling and 256-topic-per-batch cap. For typical apps (under 200 topics with short names) this is a single frame; larger sets are automatically chunked.

**Microtask-batched initial subscribes**: multiple `subscribe(topic)` calls landing in the same microtask coalesce into one `subscribe-batch` wire frame. A page that mounts many topic stores in a tight loop (a multi-stream dashboard, a `svelte-realtime` page initializing 5 stream RPCs) triggers the server's `subscribeBatch` hook ONCE instead of the per-topic `subscribe` hook N times. Single-topic case stays as a plain `subscribe` frame for the minimal-change wire shape. Same chunking limits as the reconnect path. Topics are still added to the local subscription set synchronously, so a disconnect between the call and the microtask flush loses nothing - the reopen path picks them up. **Test-code note**: code asserting on the exact wire shape of two same-microtask subscribes seeing two `subscribe` frames now sees one `subscribe-batch` frame; use `.find(m => m.type === 'subscribe-batch' && m.topics.includes(...))` instead.

**Zombie detection**: the client checks every 30 seconds whether the server has been completely silent for more than 150 seconds (2.5x the server's idle timeout). If so, it forces a close and reconnects. This catches connections that appear open but were silently dropped by the server, which is common on mobile after wake from sleep.

### Cross-origin and native app usage

By default, the client derives the WebSocket URL from `window.location`. If your client runs on a different origin - a mobile app (Svelte Native, React Native), a standalone Node.js script, or any context where the backend lives elsewhere - pass a `url` to connect to it directly:

```js
import { connect, on } from 'svelte-adapter-uws/client';

connect({ url: 'wss://my-app.com/ws' });

const todos = on('todos');
```

When `url` is set, `path` is ignored and the `window` check is bypassed, so the client works in environments without a browser DOM. All other features (reconnect, backoff, batch resubscription, topic stores) work the same way.

> **Note:** Your server's `allowedOrigins` config must include the origin your client connects from (or `'*'` during development). See the [cross-origin and native app usage](#cross-origin-and-native-app-usage) section.

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

Opt-in modules that build on top of the adapter's public API. They don't change any core behavior - if you don't import them, they don't exist. Each plugin ships in its own subdirectory under `plugins/` with separate server and client entry points.

### Authorization model

Plugin action APIs are **authorization-free primitives**: they do not know roles or ownership, and execute whatever trusted server code passes. Calling `withLock(key, fn)`, `replay.replay(ws, topic, since)`, or `idempotency.handle(key, fn)` is no more an authorization check than calling `Map.set(key, value)` is one. The narrow exception is a client-facing observer handshake: `presence.sync()` and `cursor.snapshot()` consult `platform.checkSubscribe` before installing their private tap, because the built-in `message` hooks feed them a client-named topic. That transport check does not replace your application authorization for mutations or other plugin calls.

Your message handler is the gate. Identity is established at connect time by the [`upgrade()` hook](#authentication) and stashed on the socket via `ws.getUserData()`. Your `message()` handler reads that identity, decides whether the action is allowed, and **only then** invokes the plugin:

```js
// hooks.ws.js
import { withLock } from 'svelte-adapter-uws/plugins/lock';

export async function message(ws, { data }) {
  const { topic, action, payload } = JSON.parse(Buffer.from(data).toString());
  const { userId, role } = ws.getUserData() ?? {};

  // 1. Authentication: did upgrade() reject? If not, ws.getUserData() is non-empty.
  if (!userId) return;

  // 2. Authorization: this handler decides. The plugin does not.
  if (action === 'reset-counter' && role !== 'admin') return;

  // 3. Only now is the plugin invoked. withLock has no idea who the caller is.
  await withLock(`counter:${topic}`, async () => {
    // ... critical section
  });
}
```

Higher-level frameworks built on this adapter (e.g. [`svelte-realtime`](https://github.com/lanteanio/svelte-realtime)) wrap this pattern: `ctx.user` is the same identity object the `upgrade()` hook returned, and the framework's `_guard` / `live.public()` / `// realtime-allow-public` machinery is the authorization layer at the RPC seam. Apart from the observer transport check above, the framework's application authorization lives outside the plugins.

The same pattern applies to every plugin in this section: read identity, decide, then invoke. A plugin that "looks like an auth gate" by virtue of taking a userId-shaped key (e.g. `presence.subscribe(`user:${userId}`)`) is just substituting whatever string the caller hands it - if your handler interpolates `payload.targetUserId` from the wire without checking that the caller owns it, the plugin will happily address a user the caller has no business touching.

### Middleware

Composable message processing pipeline. Chain functions that run on inbound messages before your handler logic. Each middleware receives a context and a `next` function - call `next()` to continue, skip it to stop the chain.

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
    if (!userId) return; // stop chain - unauthenticated
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
- **No state.** The middleware itself is stateless - it's a pure pipeline. Use `ctx.locals` to pass data between middlewares within a single message.
- **Double `next()` guard.** Calling `next()` twice in the same middleware is a no-op (the second call does nothing).

### Replay (SSR gap)

When you combine SSR with WebSocket live updates, there's a gap between server-side data loading and the moment the client's WebSocket connects. Messages published during that window are lost.

The replay plugin solves this without touching the adapter core. It's opt-in - if you don't import it, it doesn't exist.

> **Authorization:** the replay buffer is identity-blind. It replays whatever messages were captured to whoever asks for them. Your `message()` handler (or your topic-subscribe gate) is the place that decides whether the requesting socket is allowed to see this topic's history. See [Authorization model](#authorization-model).

#### How it works

1. **Server:** publish through a replay buffer instead of `platform.publish()` directly - messages get a sequence number and are stored in a ring buffer
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
    // Authorize first: the buffer is identity-blind. Only replay topics
    // this connection is subscribed to (i.e. passed the subscribe gate) -
    // without the check, a client can name any topic and read its history.
    if (!ws.isSubscribed(msg.topic)) return;
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

- **In-memory only.** The ring buffer lives in the server process. A restart loses the buffer. For most apps this is fine - the gap is typically under a second, and a page reload after a server restart gives fresh SSR data anyway.
- **Single-worker only.** In clustered mode, each worker has its own buffer. If the SSR load runs on worker A and the WebSocket connects to worker B, the replay won't have the right messages. If you need replay with clustering, stick to a single worker or use an external store.
- **Buffer overflow.** If more than `size` messages are published to a topic before a client requests replay, the oldest are gone. Size the buffer for your expected throughput during the SSR-to-connect window (usually well under 100 messages).

---

### Dedup (idempotency window)

In-process "have I seen this id before?" cache with fixed-window TTL. The natural use is wrapping a side-effecting handler so client retries after a flaky disconnect don't double-execute - charge a card once, send an email once, deduct inventory once - even when the client legitimately retries the same call.

The TTL is the deduplication window: an id is considered "fresh" for `ttl` ms after the first claim. Duplicate claims within the window do NOT extend the TTL (semantics match Redis `SET NX EX`, which is the eventual swap target if you outgrow the in-process variant).

> **Authorization:** dedup keys are whatever the caller passes. If your handler builds the id from a wire field without checking ownership (e.g. `id: payload.clientRequestId`), one user can deliberately collide with another user's id and block their next legitimate request. Always derive the dedup key from a trusted identity prefix - e.g. `\`order:${ws.getUserData().userId}:${payload.clientRequestId}\``. See [Authorization model](#authorization-model).

#### Setup

```js
// src/lib/server/dedup.js
import { createDedup } from 'svelte-adapter-uws/plugins/dedup';

// 5-minute window: a retry within 5 minutes sees the duplicate; after
// the window the same id is treated as a fresh delivery.
export const messages = createDedup({ ttl: 5 * 60 * 1000 });
```

#### Usage

```js
// src/hooks.ws.js
import { messages } from '$lib/server/dedup';

export function message(ws, { data }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  if (!messages.claim(msg.id)) return; // duplicate, ignore silently
  processMessage(msg); // side effects only run once per id within ttl
}
```

The pattern composes with idempotency-key headers on form actions and RPCs the same way - the client generates a stable id (UUID v7 or `crypto.randomUUID()`), persists it locally before submission, and reuses it on retry. The server's first `claim()` succeeds and runs the side effect; the retry's `claim()` returns `false` and the handler exits early.

#### API

| Method | Description |
|---|---|
| `dedup.claim(id)` | Try to claim `id` as first-sight. Returns `true` if unseen / expired (and records a fresh window). Returns `false` if `id` is currently inside its window. |
| `dedup.has(id)` | `true` iff `id` was claimed and is still within its window. Lazy-prunes expired ids on access. |
| `dedup.delete(id)` | Forget `id` explicitly. Returns `true` if the entry was live before deletion, `false` otherwise. |
| `dedup.size()` | Current number of retained ids (may include expired ids not yet pruned). |
| `dedup.clear()` | Forget all ids. |

#### Options

| Option | Default | Description |
|---|---|---|
| `ttl` | *required* | Deduplication window in milliseconds. Must be positive. |
| `maxEntries` | `10000` | Soft cap on retained ids. When the map grows past 110% of this cap, expired entries are pruned in a single pass; if still over cap (every entry is inside its window), the oldest insertion-order entries are evicted regardless. |

#### Limitations

- **In-memory and per-process.** In cluster mode, each worker has its own dedup cache. If a client retry lands on a different worker than the original, it will not see the duplicate. For cluster-coherent dedup, swap to the Redis variant in `svelte-adapter-uws-extensions`.
- **No persistence.** Restarting the worker forgets all in-flight ids. The window after a restart is effectively zero until clients re-claim. For payment-grade idempotency, back the cache with a durable store.
- **Window-bounded, not exactly-once.** A retry that arrives more than `ttl` after the original is treated as a fresh delivery. Choose `ttl` longer than your worst-case retry latency.
- **Shared capacity under flood.** The pool is one global map across all users, so eviction pressure does not respect key namespaces. A flood of more than 110% of `maxEntries` distinct ids inside one TTL hard-evicts other users' live entries and re-arms their operations: a victim's retry of an already-processed id is treated as first-sight and the side effect double-executes. Key namespacing (e.g. `order:${userId}:${clientRequestId}`) scopes collision resistance, not capacity, so it does NOT mitigate the flood. Size `maxEntries` above your peak claim rate multiplied by `ttl`, and pair with the [rate limiter](#rate-limiting) so a single caller cannot mint distinct ids fast enough to saturate the pool. Hosts handling financial or other one-shot side effects should monitor `dedup.size()` against `maxEntries` and alert on saturation.

---

### Presence

Track who's connected to a topic in real time. Handles multi-tab dedup (same user with two tabs open = one presence entry), broadcasts compact join/leave diffs (microtask-batched so multi-event ticks collapse to one frame), and provides a live store on the client.

> **Authorization:** the presence list shows whoever subscribes to the topic - the plugin does not gate topic-subscribe. If a topic should be limited to a subset of users (`team:42` -> only team-42 members), enforce that in your `subscribe` handler or via a [topic gate](#topic-validation). The `select` callback only chooses which fields of `ws.getUserData()` to publish; it does not decide whether the caller is allowed on the topic. See [Authorization model](#authorization-model).

#### Setup

Create a shared presence instance:

```js
// src/lib/server/presence.js
import { createPresence } from 'svelte-adapter-uws/plugins/presence';

export const presence = createPresence({
  key: 'id',
  select: (userData) => ({ id: userData.id, name: userData.name })
  // heartbeat:      30_000 (default) - broadcast every 30s; clients refresh maxAge / re-add aged-out entries
  // maxConnections: 1_000_000 (default) - hard cap on tracked connections
  // maxTopics:      1_000_000 (default) - hard cap on active topic registry
  // maxTopicsPerConnection: 100 (default) - bounds one socket's presence-topic multiplier
  // binary:         true (default) - send compact 0x03 frames to binary-capable clients (presence.protocol:1); false forces JSON for all
  // topicThrottle:  16 (default) - roughly one topic-wide diff per display frame; 0 restores next-tick-only batching
  // maxFieldsBytes: 8192 (default) - per-update() fields size cap; over-cap updates are dropped
  // maxTotalFieldsBytes: 65_536 (default) - cumulative per-user budget for durable update() fields
  // clientUpdateFields: unset (default) - update() may set any field except server-reserved identity names
  //                   (key field, id, role, credential-shaped); set to an array to allow ONLY those fields
});
```

The registry caps bound internal Maps that grow with topic cardinality (`chat-${userId}` patterns) and connection count. `maxTopicsPerConnection` also composes with `maxTotalFieldsBytes`: at the defaults one socket can retain at most about 6.25 MiB of dynamic fields across its presence entries, rather than multiplying 64 KB by the global one-million-topic limit. Registry eviction drops the oldest insertion-order state. In practice eviction is rare because `presence.hooks.close` calls `leave(ws)` automatically on disconnect.

Wire it into your WebSocket hooks:

```js
// src/hooks.ws.js
import { presence } from '$lib/server/presence';

export function upgrade({ cookies }) {
  const user = validateSession(cookies.session_id);
  if (!user) return false;
  return { id: user.id, name: user.name };
}

export const { subscribe, unsubscribe, message, close } = presence.hooks;
```

The `hooks` object handles everything: `subscribe` calls `join()` for regular topics and sends the current presence snapshot for `__presence:*` topics, `message` answers the client's reconnect/late-join snapshot request (so a reconnecting client re-binds its roster instead of waiting for the next diff), `close` calls `leave()`. Wire `message` in - omitting it leaves board-scoped presence stale across reconnects. If you need custom logic (auth gating, topic filtering), wrap the hook:

```js
export function subscribe(ws, topic, ctx) {
  if (topic === 'vip' && !ws.getUserData().isVip) return false;
  presence.hooks.subscribe(ws, topic, ctx);
}

export const { unsubscribe, message, close } = presence.hooks;
```

The snapshot `message` path does gate the requested topic through `platform.checkSubscribe` before it subscribes the socket to `__presence:<topic>` or emits a roster. With `authorizeWireSubscribe` armed and no application authorization hook, the connection must already hold a server grant from `platform.subscribe`; otherwise the request is dropped. With the policy unarmed, the normal subscribe-hook decision applies. A missing `checkSubscribe` method fails closed. This is a transport/topic gate, not a role policy: keep application-specific checks in your subscribe hook, and grant protected rooms server-side before the client asks for its observer snapshot.

#### Binary wire mode

Presence frames ride a compact **binary wire** for capable clients by default (`presence.protocol:1`): `state` / `diff` / `heartbeat` are encoded as a `0x03` frame instead of a JSON envelope whenever the client supports it, and sent as the identical JSON to everyone else - from one publish. Fully transparent: the `presence()` store decodes back to the same `{ event, data }`. Unlike the cursor wire, the codec is **stateless** (no per-connection dictionary): a presence value is arbitrary user data carried as a length-prefixed JSON string, so the win is the `0x03` framing, not the value bytes - a modest but durable reduction (roughly 2-13% depending on roster size) that holds up under the real uWS permessage-deflate compressors, measured in `bench/ws-compression-ab.mjs`. `createPresence({ binary: false })` forces JSON for every client; a value the codec cannot represent falls back to JSON for that one frame. The same `platform.publishWire` / `registerWireCodec` mechanism documented under the cursor plugin powers it.

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
  // Explicit public-field allowlist; omit `select` to use the recursive denylist.
  select: (userData) => ({ id: userData.id, name: userData.name }),
  heartbeat: 30_000      // broadcast every 30s (default: 30000; pass 0 to disable)
});

presence.hooks                       // ready-made { subscribe, unsubscribe, close } hooks
presence.join(ws, topic, platform)   // add user to topic (call from subscribe hook)
presence.leave(ws, platform)         // remove from all topics (call from close hook)
presence.sync(ws, topic, platform)   // send snapshot without joining (for observers)
presence.list(topic)                 // current user data array
presence.count(topic)                // unique user count
presence.flushDiffs()                // drain buffered diff publishes synchronously
presence.clear()                     // reset everything (stops heartbeat timer)
```

#### Wire format

The plugin emits three frame types on the `__presence:{topic}` channel:

- `{event: 'state', data: {[key]: meta}}` - full snapshot, sent to a single connection on join or sync.
- `{event: 'diff', data: {joins: {[key]: meta}, leaves: {[key]: meta}}}` - changes, broadcast to all subscribers of the topic.
- `{event: 'heartbeat', data: {[key]: meta}}` - periodic full-roster refresh, broadcast every `heartbeat` ms (30 s default). Carries a `{userKey: data}` map so a client whose entry aged out of its local `maxAge` sweep can re-add it from the heartbeat alone, without waiting for the next `diff`.

Diffs are buffered in a microtask queue: multiple joins / leaves in the same tick collapse into one diff frame. Within a diff, `leaves` are applied first then `joins`, so an update (same key in both) ends with the user present using the new data. If a key cycles join then leave in the same tick, the diff carries only the latest op (`leave` wins).

The Redis-backed variant in the [extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions) package emits the same three frame shapes, so the same client bundle works against either backend.

#### Client API

```js
import { presence } from 'svelte-adapter-uws/plugins/presence/client';

const users = presence('room');
// $users = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
```

The client store defaults to a 90 s `maxAge` sweep: entries that haven't been refreshed by a heartbeat or `diff` / `state` inside the window are removed from the local map. With the server's 30 s default heartbeat, still-present users are refreshed three times per window and never flicker; ghost entries left over by silent server-side cleanup (cluster mass-disconnect, ungraceful client close) clear within one sweep window.

For admin / audit views that want unbounded retention ("show every user who ever touched this topic"), opt out with `maxAge: 0`:

```js
const everyoneEver = presence('room', { maxAge: 0 });
```

To customize the window, set `maxAge` and the matching server `heartbeat` together (rule of thumb: heartbeat is one-third of `maxAge` or less, so a still-present user gets at least two refreshes per sweep window):

```js
// Server: heartbeat every 60s
const presence = createPresence({ key: 'id', heartbeat: 60_000 });

// Client: entries expire after 180s without a heartbeat refresh
const users = presence('room', { maxAge: 180_000 });
```

#### How multi-tab dedup works

If user "Alice" (key `id: '1'`) has three browser tabs open, `presence.join()` is called three times with the same key. The plugin ref-counts connections per key: Alice appears once in the list. When she closes two tabs, she stays present. Only when the last tab closes does the plugin broadcast a `leave` event.

If Alice's data changes between connections (for example she updates her avatar in one session and opens a fresh tab), `join()` detects the difference and broadcasts an `updated` event so other clients immediately see the new data. The `updated` event has the same shape as `join`: `{ key, data }`.

If no `key` field is found in the selected data (e.g. no auth), each connection is tracked separately.

The dedup key is read from the data the `select` callback returned, so a field the projection drops cannot dedup. The default `select` denylist covers the `key` field too, deliberately: the resolved key is broadcast as the roster key in every frame, so it must never be a secret. Naming a credential-shaped dedup key (`key: 'sessionId'`, `key: 'apiKey'`) logs a warning at startup and falls back to per-connection entries rather than publishing the value. Dedup on a non-secret identifier such as a user id, or pass an explicit `select` that returns the field if it genuinely is one.

#### Field-level updates and transient fields

`presence.update(ws, topic, fields, platform)` sets dynamic fields on the present user as a field-level delta - only fields whose value actually changed are merged into the user and broadcast in the next `diff` under `updates[key]`. A typing toggle sends `{ typing: true }`, not the whole user object. The update applies to the user (per dedup key), so any of a multi-tab user's connections may call it and every observer sees one change. A connection that is not present on the topic, or an update where nothing changed, is a no-op.

Updates are bounded and identity-safe: a fields blob over `maxFieldsBytes` (default 8 KB, same shape as the cursor plugin's `maxDataBytes`) is dropped, a user's durable fields may not exceed the cumulative `maxTotalFieldsBytes` budget (default 64 KB - durable fields ride every future snapshot and heartbeat), and one connection may hold at most `maxTopicsPerConnection` presence memberships (default 100), which bounds the cross-topic multiplier. Topic-wide diffs are coalesced behind `topicThrottle` (default 16 ms); pass `0` only when the old next-tick latency is worth giving up the default rate bound. Server-reserved field names (the dedup key field, `id`, `role`, `__`-prefixed, `constructor`/`prototype`, credential-shaped names) are stripped so a client cannot overwrite the server-selected identity its peers see. Pass `clientUpdateFields: ['typing', 'selection']` to accept only an explicit allowlist (which is also the escape hatch for deliberately letting clients write a reserved name).

```js
// server
presence.update(ws, 'room', { typing: true }, platform);
```

```svelte
<!-- client: the field is merged into the existing user object -->
{#each $users as u (u.id)}
  <span>{u.name}{#if u.typing} is typing...{/if}</span>
{/each}
```

A browser can push its own fields directly with `presenceUpdate(topic, fields)` from the presence client - no out-of-band RPC. It sends a `presence-update` frame that the server routes to the same `update()`. The connection must already be present on the topic (subscribed), so a push from a non-member is a silent no-op; whether a field is durable or transient is decided by the server config, not the caller.

```svelte
<script>
  import { presence, presenceUpdate } from 'svelte-adapter-uws/plugins/presence/client';

  const users = presence('doc-1');
  // Toggle a transient typing flag as the user types.
  function onInput() { presenceUpdate('doc-1', { typing: true }); }
</script>
```

Fields named in the `transient` option are broadcast live to the subscribers connected at the moment they change, but are **excluded from the `state` snapshot and the heartbeat roster**. So a (re)joining or swept-then-readded client never inherits a possibly-stale transient value - a disconnected typer leaves no stuck indicator. Identity fields (from `select`) and durable `update()` fields not listed in `transient` ride the snapshot normally.

```js
const presence = createPresence({
  key: 'id',
  select: (ud) => ({ id: ud.id, name: ud.name }),
  transient: ['typing', 'selection'] // live-only; never in the snapshot
});
```

The wire stays additive: a deployment that never calls `update()` sends the exact `{ joins, leaves }` diff as before, and an old client ignores the `updates` field. (The field-level `updates` map rides the JSON form; pure join/leave diffs keep the binary wire.)

#### Limitations

- **In-memory only.** Same as replay - server restart clears presence. On restart, clients reconnect and re-subscribe, so the list rebuilds within seconds.
- **Single-worker only.** Each worker tracks its own presence. In clustered mode, the list reflects only the local worker's connections.
- **Requires subscription.** The client must subscribe to the topic (via `on()`, `crud()`, etc.) for the server's `subscribe` hook to fire. `presence('room')` alone shows you the list but doesn't register you as present unless you're also subscribed to `room`.

### Typed channels

Define message schemas per topic so event names and data shapes are validated at publish time. Catches typos and shape mismatches before they reach the wire - instead of silently sending garbage that the client ignores.

> **Authorization:** typed channels validate **shape**, not **identity**. A schema check that the payload has `{id, text, done}` does not prove the caller is allowed to publish on this channel. Gate the publish in your handler before invoking the channel. See [Authorization model](#authorization-model).

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

The client wrapper is optional - it catches event name typos on the receiving side too.

```svelte
<script>
  import { channel } from 'svelte-adapter-uws/plugins/channels/client';

  const todos = channel('todos', ['created', 'updated', 'deleted']);

  const all     = todos.on();          // all events (same as on('todos'))
  const created = todos.on('created'); // filtered  (same as on('todos', 'created'))
  const typo    = todos.on('craeted'); // throws Error immediately
</script>
```

The `events` array is optional. Without it, `.on()` works exactly like the regular `on()` with the topic pre-filled - no validation, just convenience.

You can still use `crud()`, `lookup()`, `latest()`, etc. directly with the topic string. The client channel is purely additive.

#### Limitations

- **Runtime only.** The validation happens at publish/send time, not at compile time. TypeScript generics give you autocomplete for event names, but data shape checking is runtime.
- **No dependency on Zod.** The plugin accepts any validator function or any object with a `.parse()` method. You bring your own validation library (or use plain functions).

### Throttle/debounce

Per-topic publish rate limiting. Wraps `platform.publish()` to coalesce rapid-fire updates (mouse position, typing indicators, live metrics). Sends the latest value at most once per interval. No timers to manage yourself.

Two modes:

- **`throttle(ms)`** - sends immediately on first call (leading edge), then at most once per interval (trailing edge). Latest value wins within each interval.
- **`debounce(ms)`** - waits until no calls for the full interval, then sends the latest value. Each new call resets the timer.

> **Authorization:** throttle/debounce shape outbound publish rate, nothing else. The plugin does not check who is publishing or whether they are allowed to. Gate the publish in your handler. See [Authorization model](#authorization-model).

#### Setup

```js
import { throttle, debounce } from 'svelte-adapter-uws/plugins/throttle';

const mouse  = throttle(50);   // at most once per 50ms per topic
const search = debounce(300);  // wait for 300ms of silence

// Both factories accept an optional second argument with a `maxTopics`
// cap on the active topic registry (default 1_000_000). When the cap is
// reached, the oldest insertion-order topic is flushed (its pending
// value publishes immediately) and dropped before the new topic is
// inserted. Lower the cap if you want louder feedback when topic
// cardinality runs away.
const positions = throttle(50, { maxTopics: 10_000 });
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
    // User types fast - only publish when they pause
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

- **Server-side only.** No client component - the client receives messages at the throttled rate naturally.
- **Latest value only.** Intermediate values within an interval are discarded, not queued. If you need every message delivered, don't throttle.
- **Timer-based.** Uses `setTimeout` internally. Precision depends on Node.js event loop load (typically < 1ms drift).

### Rate limiting

Fixed-window rate limiter for inbound WebSocket messages. Protects against spam, abuse, and runaway clients. Supports per-IP, per-connection, or custom key extraction, with optional auto-ban when a bucket is exhausted.

The allowance refills in full at each interval boundary (fixed window, not token bucket): a client can fire a full window of messages at the end of one interval and another full window at the start of the next - up to 2x `points` inside a short seam. If burst smoothness matters, prefer a smaller `points` / `interval` pair with the same average rate (e.g. `points: 5, interval: 500` instead of `points: 10, interval: 1000`).

Different from throttle - throttle shapes **outbound** publish rate, rate limiting protects **inbound** against abuse.

> **Authorization:** rate limiting is anti-abuse, not authorization. A bucket-exhaustion check answers "is this caller flooding?", not "is this caller allowed?". Identity-based access checks (role, ownership, tenant) still live in your handler. The two layers compose: gate auth first, then meter. See [Authorization model](#authorization-model).

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
| `limiter.ban(key, duration?)` | Manually ban a key. Banning a key the limiter has not seen is an insert, so at `maxBuckets` it evicts another key's bucket - an app that bans ids supplied by the traffic it is defending against therefore lets that traffic force one eviction of another client's rate-limit state per ban |
| `limiter.unban(key)` | Remove a ban (the window counter is untouched) |
| `limiter.clear()` | Reset all state |

`reset`, `ban`, `unban` and `clear` take an optional trailing tenant id when a `tenant` resolver is configured, so a tenant's calls touch only that tenant's buckets.

#### Options

| Option | Default | Description |
|---|---|---|
| `points` | *required* | Tokens per interval (positive integer) |
| `interval` | *required* | Refill interval in ms |
| `blockDuration` | `0` | Auto-ban duration in ms when exhausted (0 = no auto-ban) |
| `keyBy` | `'ip'` | `'ip'`, `'connection'`, or `(ws) => string` |
| `tenant` | - | `(ws) => id \| null`, an optional per-connection tenant resolver. When set, the bucket key is scoped by the returned id so two tenants sharing an IP, connection or custom key get independent buckets. Return `null`/`undefined` for an unscoped connection; omit for a single-tenant deployment |
| `maxBuckets` | `1_000_000` | Hard cap on retained buckets. The lazy expired-entry sweep runs first; the hard cap protects against sustained DDoS where every entry is unexpired. At the cap an insert evicts the least active bucket of a sample, where activity is the allowance drawn across the current window and the one before it. A bucket serving a ban is taken only when every sampled candidate is banned, and then it is the most recently placed ban of that sample - so the oldest ban in the map is never the one evicted, but a newer one can be, since the choice sees a sample rather than the whole map |
| `evictionSample` | `16` | How many buckets an eviction inspects before choosing its victim. The whole map is inspected when it holds fewer entries than this |
| `onEvict` | - | `({ key, banned }) => void`, called once per eviction, after the call that triggered it has finished deciding. `key` is the stored bucket key (`tenantId + '\0' + key` when `tenant` is set). `banned: true` means every sampled candidate was still serving a ban, so enforcement state had to be dropped - alert on it: the cap is too small for the number of bans in flight |

With `keyBy: 'ip'` (default), the limiter reads `userData.remoteAddress`, `.ip`, or `.address`. With `keyBy: 'connection'`, each WebSocket gets its own bucket. Pass a function for custom grouping (e.g. by user ID or room).

**Eviction is not a reset, and it is not a ban amnesty.** At `maxBuckets` an insert reclaims a slot from the least active bucket of a rotating sample, measured over the current window and the one before it. A bucket serving a ban is taken only when every sampled candidate is banned, and then it is the most recently placed ban of that sample. The rule is sample-local - an eviction inspects `evictionSample` buckets, not the whole map - so read what it guarantees at the far end: the ban placed longest ago is never the victim, and a flood minting identities, which can only add newer bans, cannot clear the oldest ban in the map (that needs an eviction able to compare two entries, so `evictionSample: 1` or a one-bucket cap simply takes the entry it lands on). It is not a promise that a ban always survives. A saturated map has to drop one ban to admit any new key, the one it drops is only the newest of the buckets that eviction walked, and traffic that first fills the map with its own bans can then have a ban placed after those churned out. Every such drop is reported through `onEvict` with `banned: true`, and sizing `maxBuckets` above the number of bans you expect in flight is what actually keeps enforcement intact.

#### Limitations

- **Server-side only.** No client component needed.
- **In-memory.** Buckets live in the process. In cluster mode, each worker has independent rate limits (acceptable for most apps - abusers hit the same worker via the acceptor).
- **Lazy cleanup.** Expired buckets are swept when the internal map exceeds 1000 entries.
- **Fixed-window seam burst.** Refills happen in full at each interval boundary, so up to 2x `points` can pass inside a short seam across a boundary (e.g. 9 accepted messages in ~1s at `points: 5, interval: 1000`). The adapter core's upgrade limiter uses a sliding window to avoid this; this plugin keeps the simpler fixed-window model.

### Cursor (ephemeral state)

Lightweight fire-and-forget broadcasting for transient state - mouse cursors, text selections, drag positions, drawing strokes. Built-in throttle with trailing edge ensures the final position always arrives. Auto-cleanup on disconnect.

> **Authorization:** the cursor plugin broadcasts whatever the caller publishes to whoever is subscribed to the topic. It does not gate topic-subscribe or topic-publish. The `select` callback chooses which fields of the publisher's userData to attach to the broadcast - it does not authorize. If a cursor topic should be limited (e.g. `doc:42` -> only doc-42 collaborators), enforce that in your subscribe/publish handler. See [Authorization model](#authorization-model).

#### Setup

```js
// src/lib/server/cursors.js
import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

export const cursors = createCursor({
  throttle: 16,       // per-cursor: at most one broadcast per 16ms (~60 Hz)
  topicThrottle: 16,  // per-topic: coalesce all movers into one frame per 16ms
  select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
  // maxConnections: 1_000_000 (default) - hard cap on tracked connections
  // maxTopics:      1_000_000 (default) - hard cap on active topic registry
});
```

Both `throttle` and `topicThrottle` default to 16 ms (~60 Hz). For a 120 Hz demo, halve them to 8. To disable per-topic coalescing entirely (every broadcast goes straight out), pass `topicThrottle: 0`. The two cap options bound internal Maps that grow with client behaviour. Eviction at cap drops the oldest insertion-order entry; for `maxTopics` the dropped topic's pending timers (per-cursor and topic-coalesce) are cleared first.

`topicThrottle` is the bandwidth lever for crowded rooms: rather than fan out one frame per cursor per tick, the server emits one `bulk` array per topic per window carrying every cursor that moved in that window. Bandwidth per peer scales with active-mover count, not with mover-count times per-mover rate.

#### Cutting cursor volume (opt-in reducers)

`topicThrottle` shrinks each frame; three opt-in reducers cut volume further - one at ingest, two at fan-out:

```js
export const cursors = createCursor({
  minMove: 1,           // jitter filter: drop a move smaller than 1 unit (here: exact repeats)
  viewport: true,       // viewport culling, defaults (shorthand for { enabled: true })
  backpressure: true    // backpressure drop, default 1 MiB cap
  // viewport: { enabled: true, padding: 256, cell: 256 } to tune
  // backpressure: { enabled: true, maxBufferedBytes: 1024 * 1024 } to tune
  // position: (data) => ({ x: data.x, y: data.y }) if coords are nested elsewhere
});
```

All three default off and are independent. `viewport: true` / `backpressure: true` are shorthand for `{ enabled: true }`; setting a tuning key (`padding`, `cell`, `maxBufferedBytes`) without `enabled` throws rather than silently doing nothing.

**Jitter filter (`minMove`)** drops a cursor move at ingest - before it reaches the flush - when it hasn't moved at least `minMove` (Chebyshev distance, in the units `position` returns) from the **last broadcast** position, so a burst of wobble around a point is never fanned out. When movement then stops, a debounced settle delivers the final resting position once - even if it is within `minMove` of the last broadcast - so a still cursor is never left stranded at a stale point (an exact repeat stays dropped: the settle sends nothing when the rest position is unchanged). It is off by default (`0`); for integer-pixel cursor data `minMove: 1` drops exact-repeat frames at no visual cost, and `2`-`4` suppresses sub-pixel wobble from high-DPI input. Pick the value for your coordinate scale (1 board unit can be many on-screen pixels when zoomed in), which is why there is no default. A dropped frame is still kept as the latest value, so `list()` / `snapshot()` (SSR, late joiners) see the true current position.

**Viewport culling** pairs with the client's `cursor(topic, { viewport })` (see Client usage below). A subscriber that reports its visible region receives only the cursors moving inside it (widened by `padding`, in board units, so a cursor just off-screen is already present when the user pans toward it; the overscan grows with `1 / zoom` when zoomed out). A subscriber that never reports a viewport is treated as **whole-board and is never culled** - culling is opt-in per subscriber and can never blank a board. On a spread-out board this cuts per-subscriber cursor traffic by roughly the ratio of the whole board to one viewport (tens of x in practice). `position` returning `null` (or throwing) opts a single frame out of culling - it is delivered to everyone - so a coordinate-less frame is never culled to nothing.

> **Coordinate space.** The reported viewport rect and your `move()` data must be in the **same** space - the board's. A scroll container reports `{ x: scrollLeft, y: scrollTop, w: clientWidth, h: clientHeight }` (board coordinates), so a `move()` that sends raw `e.clientX/clientY` (screen coordinates) will be culled away as soon as the user scrolls. Send board coordinates: `move('board', { x: e.clientX + board.scrollLeft, y: e.clientY + board.scrollTop })`, or report a screen-space rect if you send screen coordinates. Getting this wrong is the one way culling can hide cursors.

**Backpressure** reads each subscriber's queued bytes (`platform.bufferedAmount`) and skips one whose queue exceeds `maxBufferedBytes` for the current flush. Cursors are latest-value, so a skipped subscriber catches up on the next flush with the latest coalesced positions - it renders one cadence later, never a backlog - and a stalled consumer's write queue can never exceed the cap plus one flush of cursor bytes. It is independent of culling: enable it alone to get the memory bound without viewport reporting.

The two fan-out reducers (culling and backpressure) use a per-subscriber walk (`O(connections)` per flush), so enable them on high-fan-out topics; the jitter filter has no such cost (it drops at ingest). Culling pays for the walk lazily: a viewport-enabled topic stays on the shared C++ fan-out until at least one of its subscribers reports a viewport, so enabling it globally costs nothing on topics whose clients never report. These two also assume a non-zero `topicThrottle` (the default) - with `topicThrottle: 0` every individual update triggers a full walk, defeating the coalescing the walk relies on.

**Is it working?** `cursors.stats()` exposes `viewportsReported`, `perSubscriberFlushes`, `bpSkips`, `culledEntriesDropped`, and `jitterDropped` (moves the `minMove` filter dropped at ingest; `0` unless `minMove > 0`). If culling seems to do nothing, read them in order: `viewportsReported === 0` means no client is reporting a viewport (you forgot `cursor(topic, { viewport })`, or the element is unmounted); `viewportsReported > 0` but `culledEntriesDropped === 0` means clients report but nothing is being culled - usually a coordinate-space mismatch (see above) or a `position` extractor returning `null` for your data shape. `remove` (a cursor leaving) is always broadcast to everyone, so a departing cursor is never stuck on a culled screen.

#### Wire shape

Positions live on the `update` / `bulk` channel; user metadata lives on the `catalog` / `join` channel. The split keeps per-frame wire bytes minimal: a position frame is ~16 bytes per cursor (key + coords), and the user object (name, color, avatar, etc.) flows only when a user first appears.

| Event | Payload | Sent by |
|---|---|---|
| `catalog` | `[{key, user}, ...]` | `snapshot()` - initial roster to a single new subscriber |
| `join` | `{key, user}` | first `update()` on a (ws, topic) pair |
| `update` | `{key, data}` | single-mover position frame |
| `bulk` | `[{key, data}, ...]` | multi-mover coalesced position frame |
| `remove` | `{key}` | `remove()` or `hooks.close` |

The cluster-aware [extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions) Redis-backed cursor speaks the same wire format, so the same client bundle works against either backend.

#### Binary wire mode

Cursor frames ride a compact **binary wire** by default. The events above are the same; on the wire they are encoded as a binary `0x03` frame instead of a JSON envelope whenever the client supports it. This is fully transparent: `cursor()` / `move()` are unchanged, the store still yields `Map<key, { user, data }>`, and the decode happens in the framework before your code sees the event.

The binary wire forms, negotiated per connection by capability:

- **Full-string keys (`cursor.protocol:2`, schema 1).** Every frame carries each cursor's key string. A 221-cursor coalesced `bulk` is **~83% smaller** than JSON and decodes ~4-5x faster.
- **Short-id dictionary (`cursor.protocol:3`, schema 2), the default for capable clients.** Each cursor key is announced once, then referenced by a 1-2 byte per-connection id, so the key bytes leave the wire after the first frame and the decoder resolves the id from a cached map - **no per-entry string decode**. For realistic clustered keys this lands a warm `bulk` at **~88-89% smaller than JSON** and decodes **~16-18x faster than `JSON.parse` (~4.4x faster than the full-string wire)**. No `JSON.parse` on the cursor receive path at all.
- **Temporally-streamed positions (`cursor.protocol:5`, schema 4), for smoothing clients.** On top of the stamped dictionary wire (`cursor.protocol:4`, schema 3 - see the interpolation section below), each cursor's position is bit-packed against that cursor's *previous* sample instead of sent as two raw float32s: whole-pixel drift costs a few bits per axis, fractional drift a couple of bytes. The streamed value is the float32-narrowed position, so a client decodes exactly what the float32 wire would have delivered - the precision contract never changes across versions, only the bytes drop. Advertised automatically by smoothing cursor pipelines; the per-cursor stream state is per-connection, cleared by that cursor's `remove`, and reset on reconnect.

- **Capability-gated, never breaking.** The client advertises both `cursor.protocol:2` and `cursor.protocol:3` in its `hello` frame; the server sends the dictionary form to clients that advertised it and the full-string form to older binary clients, and a client with neither receives JSON unchanged. The frame's 1-byte schema version tells the decoder which form it is. Old client <-> new server and new client <-> old server both keep working.
- **`binary: false` to disable, `dictionary: false` to keep the full-string wire.** `createCursor({ binary: false })` forces JSON for every client (e.g. to keep DevTools' WS inspector readable). `createCursor({ dictionary: false })` keeps binary but uses the full-string form for everyone, encoded once and fanned out to all subscribers. The dictionary is per-connection stateful, so each capable subscriber's frame is encoded independently; a warm dictionary encode is much cheaper than a full-string encode, so the default is a net win (cheaper CPU and smaller frames) for typical per-process fan-out - reach for `dictionary: false` only on a single process serving very high per-topic subscriber counts (hundreds-plus on one worker), where the per-subscriber encode would cost more CPU than the bandwidth saving is worth. The wire format is the server's decision; the library reads no URL parameter and a client cannot force its own connection back to JSON.
- **Positions are `float32`, keys are strings.** Fractional positions (e.g. `clientX - getBoundingClientRect().left`) are carried losslessly enough for cursors (sub-0.01 px at screen scale). Cursor `data` that is not exactly `{ x, y }` numeric - extra fields, non-numeric values - transparently falls back to JSON for that frame, so richer cursor payloads keep working.

Writing your own high-throughput plugin? The same mechanism is available via `platform.publishWire(topic, event, data, wire)` / `platform.sendWire(...)` on the server (where `wire = { capability, schemaVersion, encode(event, data, state?), state? }` and `encode` returns a `Uint8Array` payload or `null` to fall back to JSON), plus `registerWireCodec(prefix, { capability, capabilities?, sink?, state?, decode })` from `svelte-adapter-uws/client` on the client. The optional `wire.state` slot gives the codec one object per connection (`onAttach(ws)` / `onDetach(ws, state)`) for a stateful wire like the cursor dictionary; the per-connection `state` is reset on reconnect. A codec marked `sink: true` applies each frame in place inside `decode` (e.g. into a local document replica that drives its own reactive surface) instead of returning a `{ event, data }` store event - its return is ignored and nothing is dispatched, so a frame that mutated local state never also fans out as a store update. JSON-only deployments pay nothing - `publishWire` takes the same single broadcast as `publish` when no connected client wants binary.

#### Server usage

Use the `hooks` helper for zero-config cursor handling. The `message` hook handles `cursor` and `cursor-snapshot` messages automatically, and `close` calls `remove()`. A snapshot first runs `platform.checkSubscribe` for the client-named base topic and, only when allowed, establishes the `__cursor:{topic}` tap. Later `cursor` and `cursor-viewport` frames require that tap and fail closed if membership cannot be queried. With `authorizeWireSubscribe` armed and no application authorization hook, grant the base topic server-side with `platform.subscribe` before the client requests its snapshot.

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
export async function message(ws, { data, platform }) {
  const msg = JSON.parse(Buffer.from(data).toString());
  if (msg.type === 'cursor') {
    cursors.update(ws, msg.topic, { x: msg.x, y: msg.y }, platform);
  }
  if (msg.type === 'cursor-snapshot') {
    await cursors.snapshot(ws, msg.topic, platform);
  }
}

export function close(ws, { platform }) {
  cursors.remove(ws, platform);
}
```

#### Client usage

```svelte
<script>
  import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';

  const positions = cursor('canvas');

  function onmousemove(e) {
    move('canvas', { x: e.clientX, y: e.clientY });
  }
</script>

<div on:mousemove={onmousemove}>
  {#each [...$positions] as [key, { user, data }] (key)}
    <div
      class="cursor-dot"
      style="left: {data.x}px; top: {data.y}px; background: {user.color}"
    >
      {user.name}
    </div>
  {/each}
</div>
```

`move(topic, data)` is the recommended path for sending cursor updates. Calls are coalesced via `requestAnimationFrame` so even a 1000 Hz high-DPI mouse collapses to at most one send per repaint, matching the server-side `topicThrottle` default. Multi-topic callers do not clobber each other. No-op in non-browser environments.

**Reporting a viewport (for cursor culling).** Pass a `viewport` source to `cursor(topic, { viewport })` and the store reports the visible region automatically - on scroll, resize, zoom, and even a late-bound element - while subscribed, sending a frame only when the rect actually changes. No manual `onscroll` / `ResizeObserver` wiring.

```svelte
<script>
  import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
  let board;
  // Auto-reports board's visible region; omit `viewport` to see all cursors.
  const cursors = cursor('board', { viewport: () => board });
</script>

<div bind:this={board}
     onpointermove={(e) => move('board', { x: e.clientX + board.scrollLeft, y: e.clientY + board.scrollTop })}>
  {#each [...$cursors] as [key, { user, data }] (key)}
    <div class="cursor" style="left:{data.x}px; top:{data.y}px">{user.name}</div>
  {/each}
</div>
```

Note the `move()` data is in **board coordinates** (`clientX + scrollLeft`), matching the reported rect's space - see the coordinate-space note in [Viewport culling](#cutting-cursor-volume-opt-in-reducers). The `viewport` source can be a scroll-container element, an explicit `{ x, y, w, h, zoom? }` rect (virtualized canvas), or a getter returning either. For an advanced case the lower-level `reportViewport(topic, source)` is also exported.

Reporting is **per-subscriber and opt-in**: a subscriber that never reports a viewport is treated as whole-board and is never culled, so this can never blank a board by accident. The server records the latest rect per `(subscriber, topic)`; turn on [viewport culling](#cutting-cursor-volume-opt-in-reducers) (`viewport: true`) so the server sends each reporter only the cursors inside its rect. On the server, `cursors.hooks.message` handles the `cursor-viewport` frame automatically alongside `cursor` and `cursor-snapshot`; `cursors.viewportFor(ws, topic)` reads the recorded rect (or `null` if the subscriber never reported one).

The client store is a `Readable<Map<string, { user, data }>>`. The Map updates when cursors move, join, or disconnect. Internally the store merges the `catalog`/`join` stream (user metadata) with the `update`/`bulk` stream (positions); positions whose user has not yet been seen are withheld until the matching join arrives - they appear on the next render once the catalog catches up.

**Which entry is mine?** The store's `self` readable carries this connection's own roster key (`null` until the server assigns one): the server sends it single-target as a `you` event in every snapshot reply and once before the connection's first `join` broadcast on the topic, so it is known as soon as the store syncs - or, for a connection that never snapshots, as soon as it first `move()`s. Compare it against the Map's keys to badge or skip the local user's own cursor:

```svelte
<script>
  const cursors = cursor('board');
  const me = cursors.self;
</script>

{#each [...$cursors] as [key, { user, data }] (key)}
  {#if key !== $me}
    <div class="cursor" style="left:{data.x}px; top:{data.y}px">{user.name}</div>
  {/if}
{/each}
```

**Initial sync and reconnect.** The `cursor(topic)` store sends a `{ type: 'cursor-snapshot', topic }` message every time the WebSocket connection opens - both on first connect and on every reconnect. The server calls `cursors.snapshot(ws, topic, platform)` in its `message` handler, which sends a `catalog` event (roster) followed by a `bulk` event (positions) back to the requesting client. Late joiners see existing cursors immediately. Wire `cursors.snapshot()` in your message handler as shown in the server example above.

The `cursor()` function accepts an optional second argument with a `maxAge` option (in milliseconds). When set, cursor entries that haven't received a position update within that window are automatically removed. This makes clients self-healing when the server fails to broadcast `remove` events under load:

```js
const positions = cursor('canvas', { maxAge: 30_000 });
```

#### Canvas rendering (worker offload)

At high cursor density the DOM `{#each}` above stops being the bottleneck you can fix: every frame still lands on the main thread, gets parsed there, and re-renders through reactivity. Hand `cursor()` a canvas instead and the entire ingest-decode-merge-paint pipeline moves into a dedicated worker that owns its own WebSocket (subscribed only to the cursor topic) and the canvas's transferred drawing surface. The main thread reads nothing from the cursor stream - at any density.

```svelte
<script>
  import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
  let canvas = $state();
  $effect(() => cursor('board:42', { canvas }).mount());
</script>

<canvas bind:this={canvas} class="cursor-layer"></canvas>
<div onpointermove={(e) => move('board:42', { x: e.clientX, y: e.clientY })}> ... </div>
```

That is the whole zero-config path. `mount()` returns its teardown, so the `$effect` one-liner is the complete lifecycle; unmounting pauses the pipeline (socket closed, state cleared) and a remount on the same canvas resumes it, same or different topic. `move()` is unchanged - sending stays on the main thread (pointer events only exist there); only receiving and rendering move off it. On a browser without the worker pipeline (no `OffscreenCanvas`, an old Safari) the identical call renders on the main thread through the same renderer backends: same visuals, lower ceiling, no API difference, no thrown error.

What the worker does for you:

- **Decodes off the main thread.** Binary cursor frames decode 15-18x faster than `JSON.parse`, and even that cost now happens where it cannot drop an app frame.
- **Renders through a density-aware backend.** Canvas2D below 500 in-view cursors (zero GPU setup for quiet boards), automatic promotion to an instanced WebGL2 renderer at the threshold - one draw call per frame at any count. Crossing back down never thrashes backends.
- **Culls and reports the viewport.** The worker tracks your `viewport` source (or the canvas element itself), paints only the in-view subset, and reports the rect on its own socket so [server-side culling](#cutting-cursor-volume-opt-in-reducers) also shrinks the wire.
- **Reconnects independently.** The cursor socket has its own backoff and liveness check; a cursor-stream hiccup never disturbs your main connection, and vice versa.

Options, all opt-in:

```js
const handle = cursor('board:42', {
  canvas,
  rendering: 'auto',          // 'auto' | 'main' (forces main thread, adds handle.store) | 'worker' (throws if unsupported)
  gpu: 'auto',                // 'auto' | 'canvas2d' | 'webgl2' | 'webgpu' (reserved; throws until it ships)
  gpuThreshold: 500,          // in-view count where 'auto' promotes to the GPU backend
  smooth: true,               // render-in-the-past interpolation for remote cursors (see below)
  mainThreadFeed: { rate: 10 }, // opt-in thinned position feed back to the main thread
  hideSelf: true,             // exclude the viewer's own cursor from the canvas (and the feed)
  maxAge: 30_000,             // same self-healing sweep as the store
  viewport: () => board       // same sources as the store path; defaults to the canvas element
});
```

`hideSelf` keeps the canvas from painting a trailing echo of the local pointer (the OS cursor already marks it). The filter key is this connection's server-assigned roster key - exposed as `handle.self`, `null` until the first `move()` on the topic triggers the server's single-target `you` event - and it always comes from the main connection: the worker's own socket has a different key and never self-filters from it. Remote cursors are unaffected, and the underlying data (`handle.store`, the plain store) stays complete - `hideSelf` filters pixels, never data.

#### Smooth remote cursors (`smooth`)

Without smoothing, remote cursors paint exactly where the last wire frame put them - at typical coalesced rates that is visibly steppy, and one dropped frame freezes a cursor until the next one lands. `smooth: true` switches remote rendering to buffered playback: each cursor keeps a short history of server-stamped samples, and every render frame paints the position interpolated between the two samples that straddle a render time held a small, self-tuning delay behind the newest data. A single dropped frame becomes invisible (there is still a real pair of samples around the render time), and motion between wire frames is filled in at full display rate.

The trade is stated once and plainly: **remote cursors render `interpolationMs` behind their newest known position - a larger delay survives more dropped frames but trails further behind.** The `'auto'` default tracks twice the measured update interval, so a stream already arriving at display rate collapses toward the 32ms floor and pays almost nothing, while a coarse stream widens itself just enough. Your own pointer is unaffected (it is drawn by the OS, not the canvas), and the `mainThreadFeed` keeps shipping raw wire positions - smoothing changes pixels, never data.

`snapGapMs` catches a discontinuity that arrives as a delivery gap; `snapSpeedPerSec` catches the one that does not. A cursor the app relocates - rather than the pointer moving it - lands on the ordinary cadence, its two samples one interval apart, so a gap threshold never fires and the cursor is interpolated across the whole board. The default `'auto'` measures each pair against the cursor's own neighbouring samples and snaps one that outruns both by a wide factor, which needs no knowledge of your board's units. Pass a number to add an exact board-units-per-second ceiling on top, above the fastest real flick the board can produce; pass `0` to turn both off.

```js
cursor('board:42', { canvas, smooth: true });                  // tuned defaults
cursor('board:42', {
  canvas,
  smooth: {
    interpolationMs: 'auto',    // or a fixed ms: the render-in-the-past delay
    extrapolateMs: 250,         // dead-reckoning cap when the buffer runs dry
    snapGapMs: 500,             // sample gap snapped (a view re-entry, an idle resume), not smeared
    snapSpeedPerSec: 'auto'     // jump detection; a number adds a hard ceiling, 0 turns it off
  }
});
```

Under the hood this negotiates two extra capabilities. `cursor.protocol:4`: the server stamps each position frame with its wall clock (one byte per frame steady-state, delta-coded), the snapshot reply leads with a `time` event that seeds a per-socket server-clock estimator, and the worker (or the main-thread fallback - same code, same visuals) samples each cursor's ring at the estimated server time minus the delay. And `cursor.protocol:5`: each cursor's position travels bit-packed against its own previous sample instead of as two raw float32s (identical decoded values, far fewer bytes - see the wire-forms list above). Old servers and old clients keep working: a server that knows neither keeps sending the form the connection negotiated, and without the stamp the interpolator runs on arrival times, which still smooths but breathes with network jitter.

`handle.feed` (present only with `mainThreadFeed`) is a `Readable<Map<key, { user, data, colorRGBA }>>` sampled at the feed rate in board coordinates - for the leader badge, the minimap, the "3 people here" pill - not a second rendering path: at 500 in-view cursors a feed tick costs the main thread ~30 microseconds. Apps that genuinely need full reactive cursor data alongside their own canvas use `rendering: 'main'` and read `handle.store`.

`handle.configure({ colorOf, hide })` sets display config: the callbacks run on the main thread against the live roster (and re-run as users join), and only the resolved per-key results cross to the worker. `colorOf(user)` returns a hex string or packed RGBA integer; anything else keeps the deterministic default palette. A user hidden by `hide` disappears from the canvas and the feed.

One canvas renders one topic at a time, and a canvas whose surface was transferred belongs to its worker for the element's lifetime - `handle.destroy()` is terminal (leaving the board for good); for component lifecycles rely on the `mount()` teardown. The worker identifies its socket with the `svelte-realtime-cursor` subprotocol, so deployments running the admission gate's cursor lane shed cursor sockets before main connections under load.

#### Server API

| Method | Description |
|---|---|
| `cursors.update(ws, topic, data, platform)` | Broadcast position (per-cursor + per-topic throttled). The first call per (ws, topic) sends the mover its own roster key (single-target `you`), then broadcasts `join`. |
| `cursors.remove(ws, platform)` | Remove from all topics, broadcast `remove` per topic |
| `cursors.snapshot(ws, topic, platform)` | Send current positions to one connection as `time` + `you` + `catalog` + `bulk` (initial sync; `time` seeds the smoothing clock, `you` is the requester's own roster key) |
| `cursors.list(topic)` | Current positions (for SSR) |
| `cursors.viewport(ws, topic, rect)` | Record a subscriber's viewport rect (called for you by `hooks.message` on a `cursor-viewport` frame) |
| `cursors.viewportFor(ws, topic)` | The subscriber's last reported rect, or `null` if it never reported one |
| `cursors.stats()` | Scheduler + fan-out health: `flushes`, `driftMeanMs`/`driftMaxMs`, `dirtyTopicsCurrent`, `activeTopicsTotal`, `viewportsReported`, `perSubscriberFlushes`, `bpSkips`, `culledEntriesDropped` |
| `cursors.clear()` | Reset all state and timers |

#### How throttle works

The cursor plugin uses two layers of throttle:

1. **`throttle`** caps how often a single user broadcasts on a single topic. Leading edge fires the first move immediately; subsequent moves within the window are stored and a trailing timer flushes the latest position at the window boundary.
2. **`topicThrottle`** caps how often a topic emits a frame at all. Every move appends to the topic's dirty set and shares a single tracker-wide timer that fires once per cadence cycle. Multiple movers in the same window coalesce into one `bulk` array; a single mover in the window emits one `update`. There is no synchronous leading-edge fire: every flush goes through the tick, so movers arriving from different sockets (each a separate JS task in production) batch into the same frame regardless of how many task boundaries separate them.

```
throttle: 16, topicThrottle: 16

t=0    A.update({x:0})         --> 'join' A (catalog channel)
                                   position queued in topic dirty set
t=4    B.update({x:0})         --> 'join' B (catalog channel)
                                   position queued in topic dirty set
t=8    A.update({x:5})         --> queued (entry-level throttle says wait until t=16)
t=16   [tick timer fires]      --> 'bulk' [{key:A, data:{x:5}}, {key:B, data:{x:0}}]
```

Latency cost vs. the alternate "fire-the-first-mover-synchronously" design: the first mover on an idle topic waits up to `topicThrottleMs` before its frame leaves. At the default 16 ms (~60 Hz) that's one frame-budget; well below the perceptual floor for cursor. The cost buys cross-socket coalescing - without it, the first mover from each socket fragments out as its own single-cursor `update` because uWS dispatches each WS message as its own JS task and microtasks drain between dispatches.

#### Limitations

- **In-memory.** Cursor positions live in the process. In cluster mode, each worker tracks its own connections. For cross-instance cursor sharing use the Redis-backed variant from the [extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions) package.
- **No persistence.** Positions are lost on restart. This is intentional - cursors are ephemeral.

### Smooth (prediction and reconciliation)

The building blocks for server-authoritative entities whose owners predict their own input client-side: a dragged shape, an avatar, a game character. The high-level surface lives in [svelte-realtime](https://github.com/lanteanio/svelte-realtime)'s `live.smooth()`; the adapter ships the primitives for apps composing their own wire.

```js
// Server: the authoritative command processor + the binary codec.
import { createSmoothAuthority, createSmoothWireCodec, SMOOTH_TOPIC_PREFIX } from 'svelte-adapter-uws/plugins/smooth';

const authority = createSmoothAuthority({ apply });   // apply: (state, command, ctx) => state
const codec = createSmoothWireCodec();

// Per tick (the caller owns the cadence). The wire topic is the room name
// behind the reserved smooth prefix - the same topic the client's tap binds.
const wireTopic = SMOOTH_TOPIC_PREFIX + room;
const { updates, acks, events, idle } = authority.drain();
for (const u of updates) platform.publishWire(wireTopic, 'update', { key: u.key, data: u.state }, codec, { excludeWs: u.ws });
for (const a of acks) platform.sendWire(a.ws, wireTopic, 'ack', { id: a.id, state: a.state, t: Date.now() }, codec);
// Discrete one-shot events (ctx.emitEvent): author-excluded by default - the
// owner drew its own copy optimistically - unless the event opted into toAuthor.
// The codec declines 'event', so this rides the JSON fallback, which honors excludeWs.
for (const e of events) platform.publishWire(wireTopic, 'event', { type: e.type, key: e.key, data: e.data, id: e.id }, codec, e.opts && e.opts.toAuthor ? undefined : { excludeWs: e.ws });
```

```js
// Client: the channel composes prediction, interpolation, and the wire glue.
import { createSmoothChannel } from 'svelte-adapter-uws/plugins/smooth/client';

const channel = createSmoothChannel({ apply, initial, transport: { sendCommand, sync } });
channel.onFrame((local, remote) => paint(local, remote));
channel.onEvent((e) => { if (e.type === 'shot') muzzleFlash(e.data); });  // origin:'local' optimistically; 'server' for other authors
channel.command({ dx: 4, dy: 0 });   // applied locally this frame, reconciled on ack
```

The contract that makes it correct: clients send COMMANDS, never state; the server applies them through the same `apply` function the client predicts with and acknowledges each owner with the resulting state; the client rebases on every acknowledgement and replays its un-acknowledged tail. Corrections below `errorThreshold` snap silently, larger ones ease over `smoothTimeMs` while the simulation itself adopts the truth immediately - except a correction that arrives more than `snapGapMs` after the previous acknowledgement (a reconnect or a backgrounded-tab resume, where the prediction ran unsupervised across the whole gap), which snaps rather than dragging the entity across it. One-shot side effects in `apply` guard on `ctx.firstTime`; randomness draws from `ctx.rng` (reseeded per command id, so prediction, replay, and the server draw identically); `ctx.key` names the entity whose command is being applied - the attribution handle for authoritative side effects (who fired the shot), the same value on the authority and on the owner's own prediction (null client-side until the first sync reply announces the identity). If acknowledgements stop past the window bounds, prediction is killed - the entity renders the last authoritative state and recovers through a full-state sync - rather than allowed to run away.

Two health surfaces cover the two ways the world can go quiet. `onOverflow(cb)` fires when the LOCAL prediction window overflows (the server stopped acknowledging the owner's commands). `onStall(cb)` fires when the REMOTE world goes quiet - no inbound authority frame for longer than `stallMs` (default 1000) while remote entities are tracked, a blackout on a still-open socket that overflow never sees - and clears when frames resume; the same state reads synchronously off `channel.stalled` and `stats().stalled`. Per entity, each interpolated remote state in the frame carries its freshness under the exported `SMOOTH_FRESHNESS` Symbol key - `'live'`, `'coasting'` (dead-reckoned within the extrapolation cap), or `'stale'` (frozen past it) - so a renderer can `state[SMOOTH_FRESHNESS]` to dim a coasted entity without a second structure. Resume is eased, not popped: a reconnect or manual `resync()` after a brief absence slides each entity from where it was last drawn into the rebuilt basis over `resumeEaseMs` (default 150; 0 snaps; a blackout longer than `snapGapMs` always snaps), and a `'suspended' -> 'open'` refocus where the socket survived reconciles the catalog in place - no clear, no reset - so a tab-switch does not pop the world.

A remote entity the server REPLACES rather than moves - a teleport, a respawn, a scripted placement - arrives on the ordinary tick, so the sample pair that straddles the render time carries the whole jump inside one interval and `snapGapMs` cannot see it. `snapSpeedPerSec` decides how that pair is drawn: `'auto'` (the default) reads the jump off the entity's own neighbouring samples and snaps it, on the remote view, in the dead-reckoning that follows it, and in the resume ease after a resync; a number adds an absolute world-units-per-second ceiling on top; `0` restores pure interpolation.

Discrete one-shot effects - a shot, a hit, a pickup - take the event channel rather than state: `ctx.emitEvent(type, data, opts?)` fires once on a command's optimistic application (the `firstTime` gate suppresses it on every reconciliation replay, so the owner draws one muzzle flash, not one per replay), and `channel.onEvent` delivers it with `origin:'local'` the frame the command was issued. The authority emits the same event with a matching `<commandId>:<ordinal>` key and broadcasts it author-excluded, so other clients receive it with `origin:'server'` while the owner never double-draws its own. An event the owner must also confirm against the server's adjudication (a hit) sets `opts.toAuthor`: it is no longer author-excluded, and the shared key lets the owner correlate the optimistic copy with the authoritative one. The author-exclusion is the fan-out's job, not the client's (the channel never suppresses by key, so one author's `7:0` can never shadow another's): publish each event with `excludeWs` set to its `ws` as shown above, or the owner receives both copies and double-draws. A fan-out that does not honor `excludeWs` - a hand-rolled broadcast, or a cross-instance relay (cluster mode) where exclusion is local to the owning worker - must carry the exclusion itself.

The pure cores (`plugins/smooth/predict.js`, `random.js`, `interpolate.js`, `clock.js`) take every time reading as an argument, so the same code runs in a worker, on the main thread, and under a deterministic simulation harness unchanged. Replaying a 5-command window costs ~85ns (`bench/35-smooth-replay-ab.mjs`); the steady-state loop allocates nothing beyond the by-contract window entries.

### CRDT documents (replicas, sync, persistence)

The building blocks for conflict-free shared documents: every participant holds a local replica, concurrent edits merge to the same value everywhere without a transform step, and reconnect/offline recovery is one idempotent state-vector exchange. The high-level surface lives in [svelte-realtime](https://github.com/lanteanio/svelte-realtime)'s `live.doc()` / `live.map()` / `live.array()`; the adapter ships the primitives for apps composing their own wire. Built on [yjs](https://github.com/yjs/yjs) (a regular dependency, loaded only when these subpaths are imported); Yjs types never appear on the public surface - documents are opaque bytes to everything but these two modules.

```js
// Server: the per-topic authoritative replica set + the persistence schedule.
import { createCrdtAuthority, normalizeCrdtAccess } from 'svelte-adapter-uws/plugins/crdt/replica';
import { createCrdtWireCodec, CRDT_TOPIC_PREFIX } from 'svelte-adapter-uws/plugins/crdt';

const authority = createCrdtAuthority({
  persist: {
    load: (topic, { signal }) => db.loadSnapshot(topic, { signal }),   // once per cold topic; concurrent joins coalesce
    store: (topic, bytes, { signal, deadline, attempt }) =>            // debounced, compacted, flushed on empty
      db.saveSnapshot(topic, bytes, { signal, timeout: deadline && deadline - Date.now() })
  }
});
const codec = createCrdtWireCodec();

// A joiner syncs: reference the replica, answer with exactly what it lacks.
await authority.acquire(topic);
const reply = {
  diff: authority.diff(topic, clientStateVector),   // the missing structs (full state for a new client)
  sv: authority.stateVector(topic)                  // so the client can upload what the SERVER lacks
};

// An inbound edit: merge, then fan the same bytes out (excluding the sender).
const bytes = authority.applyUpdate(topic, updateBytes);
if (bytes) platform.publishWire(CRDT_TOPIC_PREFIX + topic, 'crdt', { op: 'update', bytes: Array.from(bytes) }, codec, { excludeWs: sender });

// The last leaver: the final store runs before the replica unloads.
authority.release(topic);

// Graceful shutdown: flush, then act on what did NOT land. destroy() discards.
const flushed = await authority.persistNow();          // bounded by flushTimeout (default 10s)
if (!flushed.ok) console.error('crdt documents not persisted', flushed.dirty, flushed.failed);
authority.destroy();
```

`ok` is exactly `flushed.dirty.length === 0`, so an authority configured with no `persist.store` hook reports `ok: false` for any topic holding edits - it has nothing to make them durable with, and the snippet above logs on shutdown for an in-memory-only setup.

```js
// Client: the channel owns the local replica and the recovery loop.
import { createCrdtChannel } from 'svelte-adapter-uws/plugins/crdt/channel';

const channel = createCrdtChannel({ transport: { sendUpdate, sync, close } });
const cards = channel.map('cards');
cards.onChange((keys) => render(keys));
cards.set('c1', { title: 'hello' });   // applies locally now, merges everywhere
```

A collaborative `text` facet additionally exposes **position anchors that survive concurrent edits** - the primitive a selection or cursor highlight needs so it stays on the same characters as other users type around it. `text.anchorRange(start, end)` encodes a `[start, end)` range as opaque bytes; `text.resolveRange(bytes)` maps them back to current `{ start, end }` offsets on any converged replica, after arbitrary concurrent inserts and deletes. The start binds right and the end binds left, so an insert exactly at either edge stays outside the range while one strictly inside extends it; deleting the anchored text collapses the range to a caret at the deletion point, and a malformed or unresolvable blob returns `null`. `anchorRange` is a read (no write access). The bytes are opaque - no CRDT-library type crosses the API - so they ride a presence roster or any side channel; this is what `svelte-realtime`'s `live.multiplayer({ selections: 'crdt' })` is built on.

The properties that make it correct: the merge is commutative and idempotent, so apply order never matters and replaying overlap is a no-op - which collapses every recovery path (reconnect, offline, a frame lost to backpressure) into the same two-way exchange: the client sends its state vector, applies the server's diff, and uploads `encodeStateAsUpdate(localDoc, serverVector)`. The local replica IS the offline queue; there is no frame bookkeeping to lose. A dependency gap after any apply (the fingerprint of a lost frame, whatever dropped it) schedules a debounced resync through the same exchange - and because that detector needs a causally-later update to expose the gap, the healthy channel also runs the exchange on a low-frequency background cadence (`reconcileIntervalMs`, default 30s, `0` disables), so a lost frame with no successor - the last edit before everyone goes idle - converges within one cadence tick instead of standing until the next reconnect. An in-sync exchange costs one tiny request answered with an empty diff; the server re-runs the document guard on each exchange (that is also how a mid-session permission change reaches a connected client), so a guard that queries a database sees roughly one call per mounted client per cadence. Persistence is never on the message path: the authority captures a consistent full-state snapshot and writes it on a debounce/max-wait/compaction schedule, with the final store gating the unload so a dirty replica is never destroyed - and stores for one topic are chained so they can never race each other out of order.

The scheduled path is best-effort - a rejected store retries at the max-wait cadence and the operator watches `onError` - but an explicit `persistNow()` is not, because a caller that awaits it is usually about to exit. It resolves (never rejects) to `{ ok, durable, declined, failed, timedOut, dirty }`, so a shutdown path can tell "every store rejected" from "everything is durable" instead of both looking like success, and it is bounded by `flushTimeout` (default 10000 ms; per call `persistNow(topic?, { timeout })`, `Infinity` to wait indefinitely) so one wedged backend cannot hold the process open until the orchestrator kills it. `ok` is exactly "nothing is left unconfirmed", so `if (result.ok) authority.destroy()` can never discard bytes - and `destroy()` discards pending edits by contract, so check the flush result before calling it. On expiry the unfinished topics are reported in `timedOut` and their `store` call's `AbortSignal` fires; that write is then abandoned - whatever it eventually answers is discarded, the replica goes back to dirty, and a fresh full-state write is scheduled - so a flush that gave up can never leave unwritten bytes looking stored. It is one rescheduled write, not an unbounded retry loop: if that one also never settles, only the next `persistNow()` recovers the topic - editing does not, because the edit's own write queues behind the wedged one - which is why a deployment that can wedge a write wants a periodic flush, and why a shutdown path should act on `dirty` rather than flush and exit. A write that a second, longer-budget `persistNow()` is still waiting on is left running, and the `deadline` it was handed is that longer flush's: the shortest budget in the process decides for nobody but itself.

The hooks receive the context they run in: `store(topic, bytes, { signal, deadline, attempt })` and `load(topic, { signal })`. `attempt` counts consecutive writes of the same unstored state that did not confirm - 1 after a durable write, and 1 however fast the edits arrive against a healthy backend - and `signal` also aborts when the topic is erased with `drop()` or the authority is destroyed. Honouring `signal` is optional; a host that ignores it can see the rescheduled write overlap the one it abandoned, so honour it if you want a topic's writes strictly serialized. `deadline` is the epoch-ms reading at which the LAST flush waiting on that write stops waiting (`null` when nothing bounds it), taken when the write is dispatched; a flush that joins a write already in flight cannot widen the reading the host took, so a host that must keep a write alive for whoever is still waiting bounds on `signal` as well. A call cancelled by `drop()` or `destroy()` does not reach `onError` - tearing down is not a persistence fault - while one cancelled by a flush deadline does, and only the flush-deadline case re-dirties the record and reschedules, since an erase or teardown has no record left.

`normalizeCrdtAccess` is the one definition of the `{read, write, comment}` access record both layers share: a boolean widens to all three rights, a partial record defaults missing rights to false. The `comment` right is carried and cached in full but no comment producer exists yet - the server cannot structurally verify that a client-tagged update touches only comment marks until the rich-text marks layer lands, and trusting the tag would be a write bypass, so the right activates with that layer.

Single-edit merge measures ~2us, a 500-edit offline flush applies in ~0.4ms, and full-state compaction at a 100-entry document costs ~51us (`bench/micro-crdt-apply.mjs`).

### Queue (ordered delivery)

Per-key async task queue with configurable concurrency and backpressure. With the default `concurrency: 1`, tasks are processed strictly in order per key - useful for sequential operations like collaborative editing, turn-based games, or transaction sequences. With `concurrency > 1`, dequeue order is preserved but tasks run in parallel, so completion order is not guaranteed.

> **Authorization:** the queue serializes tasks by key; it does not decide who is allowed to enqueue under a given key. If your handler builds the queue key from a wire field without checking ownership (e.g. `key: payload.docId`), an unauthorized client can interleave tasks into another tenant's queue and either DoS the owner with high-priority work or starve their queue with low-priority padding. Derive the queue key from a trusted prefix - e.g. `\`doc:${assertedDocId(ctx, payload.docId)}\``. See [Authorization model](#authorization-model).

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
| `queue.stats()` | Occupancy gauges, peaks, and lifetime totals |

#### Options

| Option | Default | Description |
|---|---|---|
| `concurrency` | `1` | Max concurrent tasks per key |
| `maxSize` | `1_000_000` | Max waiting tasks per key (rejects with `QUEUE_FULL` when exceeded). Pass `Infinity` to disable the cap (not recommended at uWS scale) |
| `maxKeys` | `1_000_000` | Max keys with live work. A key is live from its first accepted `push()` until it has no waiting and no running task, so draining a key frees its slot. A `push()` for a key that is not live rejects with `QUEUE_TOO_MANY_KEYS`; pushes to already-live keys are unaffected. Pass `Infinity` to disable |
| `maxPendingTotal` | `1_000_000` | Max waiting tasks summed across all keys. Rejects with `QUEUE_BACKLOG_FULL` regardless of how much room the selected key still has under `maxSize`. Pass `Infinity` to disable |
| `maxRunningTotal` | `1_000_000` | Max tasks in flight summed across all keys. A scheduling bound, not an admission bound: work above it waits its turn (and is then subject to `maxPendingTotal`) rather than being rejected. Pass `Infinity` to disable |
| `maxKeyLength` | `256` | Reject keys longer than this at `push()` entry |
| `onDrop` | `null` | Called with `{ key, task, reason }` when a bound rejects a task; `reason` is `'maxSize'`, `'maxKeys'` or `'maxPendingTotal'`. A throw from it is contained and counted as `stats().onDropErrorsTotal`, so a broken metrics sink cannot change the shed decision or turn `push()`'s rejection into a synchronous throw |

Different keys are independent - `push('room-a', ...)` and `push('room-b', ...)` run concurrently. Only tasks with the same key are queued.

**Per-key bounds do not bound the queue.** `maxSize` and `concurrency` are per key, so N distinct keys each below `maxSize` still add up to N x maxSize waiting tasks, and N keys each below `concurrency` still start N x concurrency tasks at once. That is the shape a high-cardinality key (`user:${userId}`, `doc:${docId}`) produces under load: queueing is bypassed entirely and arbitrary work launches. The three aggregate bounds are what cap the totals, and **they only do anything once you set them**: at the `1_000_000` defaults none of them binds at any realistic load, so a default queue still starts a task per key exactly as it always did. Treat the defaults as a ceiling that turns an OOM into a typed rejection, and set your real capacity:

```js
export const queue = createQueue({
  concurrency: 4,
  maxKeys: 10_000,         // how many docs can be mid-flight
  maxPendingTotal: 50_000, // total backlog you are willing to hold
  maxRunningTotal: 64      // total work you are willing to run at once
});
```

Once `maxRunningTotal` binds, keys are serviced round-robin - one task per key per turn - so a saturated key cannot hold the whole budget and starve keys that arrived later.

#### Shedding

Rejections carry a typed `err.code` and the bound that tripped, so a handler can shed without parsing messages:

| `err.code` | Raised when |
|---|---|
| `QUEUE_FULL` | the key's waiting list is at `maxSize` (`err.maxSize`) |
| `QUEUE_TOO_MANY_KEYS` | the key is new and `maxKeys` keys are live (`err.maxKeys`) |
| `QUEUE_BACKLOG_FULL` | waiting tasks across all keys are at `maxPendingTotal` (`err.maxPendingTotal`) |
| `QUEUE_CLEARED` | `clear()` cancelled the task before it ran |

Every one also carries `err.key`.

```js
try {
  await queue.push('doc:' + docId, work);
} catch (err) {
  if (err.code === 'QUEUE_BACKLOG_FULL') return new Response('busy', { status: 503 });
  throw err;
}
```

#### Observability

`queue.stats()` returns live gauges plus lifetime totals. The peaks are what tell you whether a bound needs raising - a `pendingPeak` that sits at `maxPendingTotal` means you are shedding, a `runningPeak` well under `maxRunningTotal` means the bound is not the constraint. `readyCurrent` is how many keys are queued for a running slot, so a `readyCurrent` that stays high is `maxRunningTotal` holding work back.

```js
queue.stats();
// {
//   keysCurrent: 12, pendingCurrent: 340, runningCurrent: 64, readyCurrent: 8,
//   keysPeak: 91, pendingPeak: 12_004, runningPeak: 64,
//   pushedTotal: 918_233, completedTotal: 917_829, failedTotal: 40,
//   clearedTotal: 0, onDropErrorsTotal: 0,
//   dropped: { maxSize: 0, maxKeys: 0, maxPendingTotal: 320 }
// }
```

#### Limitations

- **Server-side only.** No client component.
- **In-memory.** Queue state lives in the process. Not durable across restarts.
- **No cancellation.** Running tasks cannot be aborted. `clear()` only rejects waiting tasks, with `QUEUE_CLEARED`.

### Lock (per-key serialization)

Per-key critical-section primitive. Concurrent `withLock(key, fn)` calls on the same key run one at a time in FIFO order; calls on different keys run in parallel. Use this for atomic read-modify-write on user state, "only one in-flight upgrade per resource," or anywhere two concurrent requests racing the same record would corrupt it.

Backed by a per-key FIFO waiter queue: the holder runs `fn` until it settles, then the next waiter is promoted to head. Errors in one caller's `fn` propagate to that caller and do NOT block subsequent waiters.

> **Authorization:** `withLock(key, fn)` serializes whoever calls it under that key. The plugin does not check whether the caller is allowed to mutate the resource the key represents. If your handler interpolates a wire-supplied key, an attacker can grab a lock on a resource they don't own and stall any legitimate owner trying to acquire it (denial of service) - or worse, race ahead of legitimate write paths if your business logic assumes "I hold the lock therefore I have permission to mutate." Derive the lock key from a trusted prefix - e.g. `\`account:${assertedAccountId(ctx, payload.accountId)}\``. See [Authorization model](#authorization-model).

#### Setup

```js
// src/lib/server/locks.js
import { createLock } from 'svelte-adapter-uws/plugins/lock';

export const locks = createLock();
// Or with an explicit cap:
// export const locks = createLock({ maxKeys: 100_000 });
```

#### Usage

```js
// src/routes/account/+page.server.js
import { locks } from '$lib/server/locks';

export const actions = {
  topUp: async ({ request, locals }) => {
    const amount = Number((await request.formData()).get('amount'));

    // Two concurrent top-ups for the same user must not interleave.
    return locks.withLock('user:' + locals.userId, async () => {
      const user = await db.getUser(locals.userId);
      user.balance += amount;
      await db.saveUser(user);
      return { balance: user.balance };
    });
  }
};
```

The lock holds until `fn` resolves (or rejects); the next waiter in line then runs. Different keys are independent - `withLock('user:1', ...)` and `withLock('user:2', ...)` run in parallel.

#### Bounded wait with `maxWaitMs`

The third argument to `withLock` is an optional `{ maxWaitMs }`. When set, the caller is rejected with a `LOCK_TIMEOUT` error if it does not acquire the lock within `maxWaitMs` milliseconds. The current holder's `fn` is not interrupted; only the waiting caller gives up. Subsequent waiters on the same key are unaffected - they continue in their original order, and a timeout never blocks the queue.

```js
try {
  return await locks.withLock('user:' + userId, work, { maxWaitMs: 5000 });
} catch (err) {
  if (err.code === 'LOCK_TIMEOUT') {
    // Surface a 503, retry elsewhere, fall back to a degraded path...
    return new Response('busy', { status: 503 });
  }
  throw err;
}
```

The thrown error carries `code: 'LOCK_TIMEOUT'`, `key` (the contended key), and `maxWaitMs` (the configured wait), so error-handler code can render a useful response without parsing the message string.

`maxWaitMs: 0` fails immediately if any other caller currently holds or is queued ahead of you. Useful for "try-lock" patterns where you want to fall back instead of wait.

#### API

| Method | Description |
|---|---|
| `locks.withLock(key, fn, options?)` | Run `fn` with exclusive access to `key`. Returns the promise `fn` returns. Pass `{ maxWaitMs }` to bound the wait. |
| `locks.held(key)` | `true` iff a lock is currently in flight for `key` (running `fn` or with at least one queued waiter). Observational only - do not branch on it to decide whether to acquire (the answer can change before your `withLock` call). |
| `locks.size()` | Number of keys with any in-flight or queued activity. |
| `locks.clear()` | Drop all in-flight tracking AND reject any pending waiters with a `LOCK_CLEARED` error. Currently-running `fn` calls are not interrupted; they finish normally. Use in tests / teardown. |

#### Options

| Option | Default | Description |
|---|---|---|
| `maxKeys` | `1_000_000` | Hard cap on the number of distinct keys with any in-flight or queued activity. New-key `withLock` calls reject synchronously with "active key count exceeded" when the registry is at cap; existing keys can still be entered. Protects against unbounded key cardinality on `lock-${userId}` patterns. |

#### Limitations

- **Re-entrant calls deadlock.** Calling `locks.withLock(key, ...)` from inside a function already holding `key` queues behind the outer lock and never resolves. Avoid recursive locking; if you need it, derive a sub-key.
- **Single-process only.** In cluster mode, each worker has its own waiter queue. If two requests race the same key on different workers, the lock does not coordinate them. For cluster-coherent locks, use Redis `SET NX` or a database advisory lock.
- **No hold-time bound.** `maxWaitMs` caps how long a caller waits for the lock, but does NOT cap how long the holder retains it. A `fn` that hangs holds the lock until it resolves. Wrap `fn` in a timeout guard if you need to cap hold time.

### Session (in-process store with sliding TTL)

In-process key-value store with sliding TTL: every read or `touch()` extends an entry's lifetime by another full `ttl` window. Designed for the "load on WebSocket upgrade, refresh on activity" pattern - the upgrade handler reads a session by token, and any subsequent message keeps it alive while the user is active.

Use this when your auth layer hands you a token (cookie, header, query param) and you need a place to put the resolved session data without re-querying your database on every message. Pair with the `dedup` plugin if you want once-per-window semantics on side effects.

> **Authorization:** the session store maps tokens to data. Producing the token-to-user binding (your auth layer) and validating the token before lookup (your `upgrade()` hook or middleware) are NOT the plugin's job. If your handler calls `sessions.get(payload.token)` with a wire-supplied token without first confirming the caller owns it, an attacker can lift any active token they happen to know and impersonate its owner. The plugin is a cache; the auth check belongs upstream. See [Authorization model](#authorization-model).

#### Setup

```js
// src/lib/server/sessions.js
import { createSession } from 'svelte-adapter-uws/plugins/session';

// 30-minute sliding window.
export const sessions = createSession({ ttl: 30 * 60 * 1000 });
```

#### Usage

```js
// src/hooks.server.js - populate on login.
import { sessions } from '$lib/server/sessions';

export const handle = async ({ event, resolve }) => {
  if (event.url.pathname === '/login' && event.request.method === 'POST') {
    const { username, password } = await event.request.formData();
    const user = await db.authenticate(username, password);
    if (user) {
      const token = crypto.randomUUID();
      sessions.set(token, { userId: user.id, role: user.role });
      event.cookies.set('session_id', token, { path: '/', httpOnly: true });
    }
  }
  return resolve(event);
};
```

```js
// src/hooks.ws.js - read on upgrade, refresh on every message.
import { sessions } from '$lib/server/sessions';

export function upgrade({ cookies }) {
  const token = cookies.session_id;
  if (!token) return false;
  const session = sessions.get(token); // get() also extends TTL
  if (!session) return false;
  return { token, userId: session.userId, role: session.role };
}

export function message(ws) {
  // Keep the session alive on any client traffic
  sessions.touch(ws.getUserData().token);
}
```

#### API

| Method | Description |
|---|---|
| `sessions.get(token)` | Look up by token. Returns the stored data if present and not expired, else `null`. On a hit, extends TTL (sliding window). Expired entries are removed lazily on access. |
| `sessions.set(token, data)` | Store or replace data for `token`. Resets the TTL. |
| `sessions.delete(token)` | Remove an entry. Returns `true` if the token was present (and not yet expired), `false` otherwise. |
| `sessions.touch(token)` | Extend TTL without reading data. Returns `true` if the entry was present and refreshed, `false` if missing / expired. |
| `sessions.size()` | Current number of retained entries (may include expired entries not yet pruned). |
| `sessions.clear()` | Remove all entries. |

#### Options

| Option | Default | Description |
|---|---|---|
| `ttl` | *required* | Time to live in milliseconds. Each `get` / `touch` / `set` extends an entry's expiry to `Date.now() + ttl`. Must be positive. |
| `maxEntries` | `10000` | Soft cap on retained entries. When the map grows past 110% of this cap, expired entries are pruned in a single pass; if still over cap after pruning, the oldest insertion-order entries are evicted regardless. |

#### Limitations

- **In-memory and per-process.** In cluster mode, each worker has its own store. A user's WebSocket connection sticks to one worker (uWS sticky-routing), so this is fine for the connect-time read; if you need cross-worker session sharing, swap to Redis or database-backed sessions.
- **No persistence.** A worker restart forgets all sessions. For long-lived sessions across restarts, store the canonical record in a durable store and use this plugin only as a hot cache.
- **No pubsub on expiry.** Sessions silently disappear when their TTL elapses. If you need a logout-on-expiry signal to the client, layer your own timer on top.

### Broadcast groups

Named groups with explicit membership, roles, metadata, and lifecycle hooks. Like topics with an admission step: you decide who can join, what role they have, and what happens when the group fills up or closes.

> **Authorization:** the group's `onJoin` hook is **the** place the join decision lives; the plugin itself does not authorize. Returning a role from `onJoin` admits the socket; throwing rejects. If your `onJoin` accepts every caller and only relies on `maxMembers` for backpressure, the group is effectively public - which may be fine, but is your decision, not the plugin's. The "access control" framing above refers to the **mechanism** (membership lookup, roles, slot counts) you can wire up; the policy is yours. See [Authorization model](#authorization-model).

#### Setup

`onJoin` is synchronous. Return `false` for an ordinary policy rejection, return `'member'`, `'admin'`, or `'viewer'` to override the requested role, or return `undefined` to accept it unchanged. It runs before membership, the join broadcast, the native subscription, and the member-list response, so a rejection cannot disclose the roster or leave a hidden subscription behind.

```js
// src/lib/server/lobby.js
import { createGroup } from 'svelte-adapter-uws/plugins/groups';

export const lobby = createGroup('lobby', {
  maxMembers: 50,
  meta: { game: 'chess' },
  onJoin: (ws) => {
    const user = ws.getUserData();
    if (!user.canJoinLobby) return false;
    return user.isAdmin ? 'admin' : 'member';
  },
  onFull: (ws, role) => {
    // optionally notify the rejected client
  }
});
```

#### Server usage

Use the `hooks` helper for ready-made admission and membership wiring. The `subscribe` hook intercepts the internal `__group:lobby` topic, calls `join()`, and blocks the subscription when `onJoin` rejects or the group is full or closed. The registered `__group:` namespace is allowed through the default system-topic guard only to reach this hook; the wire request is not accepted unless `join()` establishes tracked membership. The `close` hook calls `leave()`.

```js
// src/hooks.ws.js
import { lobby } from '$lib/server/lobby';

export const { subscribe, unsubscribe, close } = lobby.hooks;
```

The exported `subscribe` function is marked as a plugin side effect, so it does not disarm an enabled server-grant gate for unrelated topics. If your app relies on server-issued grants, keep `websocket.authorizeWireSubscribe: true` in the adapter and repeat `authorizeWireSubscribe: true` in the Vite plugin's separate option bag. You do not need `allowSystemTopicSubscribe`; that broad opt-out exposes every `__` namespace to your authorization hook.

Prefer `onJoin` for group-specific role selection and admission. If you need a custom wire `subscribe` hook, remember that wrapping the plugin hook makes it an application authorization hook: it decides every client-named topic and the server-grant gate deliberately steps aside. Deny every topic your wrapper does not explicitly authorize:

```js
// src/hooks.ws.js
import { lobby } from '$lib/server/lobby';

export function subscribe(ws, topic, ctx) {
  if (topic === '__group:lobby') {
    const role = ws.getUserData().isAdmin ? 'admin' : 'member';
    return lobby.join(ws, ctx.platform, role) ? undefined : false;
  }
  return false;
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

The client store exposes two reactive values: the main store for events (`$lobby` - latest message) and `.members` for the live member list. The member list updates automatically on join, leave, and close events - no polling needed.

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
| `group.maxMembers` | Resolved member cap, including the default (read-only) |
| `group.meta` | Metadata (get/set) |
| `group.hooks` | Ready-made `{ subscribe, unsubscribe, close }` admission and membership hooks |

Roles: `'member'` (default), `'admin'`, `'viewer'`.

#### Options

| Option | Default | Description |
|---|---|---|
| `maxMembers` | `1_000_000` | Maximum members. Pass `Infinity` to disable the cap |
| `meta` | `{}` | Initial metadata (shallow-copied) |
| `onJoin` | - | Synchronous admission: `(ws, requestedRole) => false \| role \| void` |
| `onLeave` | - | `(ws, role) => void` |
| `onFull` | - | `(ws, role) => void` |
| `onClose` | - | `() => void` |

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

That 30-second timeout applies once a worker has become ready. A separate, more generous **boot deadline** covers the startup window: a worker answers the primary's heartbeats from before its `init` hook runs, so a healthy async init - however slow - keeps acking and is never disturbed, while an init that wedges the event loop (a synchronous infinite loop, a native hang) stops acking and is escalated after `WORKER_BOOT_TIMEOUT_MS` (default 60s, set `0` to disable; a value below two heartbeat intervals (20s) is raised to that floor, since a worker cannot ack before its first ping and its liveness clock then trails by up to one interval between pings) instead of stranding the worker's cluster slot forever. Escalation is the same path a steady-state wedge takes - the worker is asked to close and exit, and a genuinely event-loop-blocked worker that cannot self-close falls through to a whole-process `SIGKILL` that your orchestrator (systemd / Kubernetes / Docker) respawns, because a worker thread holding a uWS App cannot be force-terminated in-process without aborting the process. Two boundaries: a warmup that *synchronously* blocks the event loop cannot ack and still reads as wedged (keep long warmups async, or off the boot path, if they must run under the deadline); and an `init` that hangs while keeping the event loop *free* (an `await` that never resolves - a connection to a down dependency with no timeout) keeps acking and is treated as alive, so the boot deadline will not catch it. Give such `init` work its own timeout.

### Clustering modes

**`reuseport`** (Linux default) - each worker binds to the same port via `SO_REUSEPORT`. The kernel distributes incoming connections across all listening workers. There is no single-threaded acceptor bottleneck and no single point of failure - one worker crashing does not affect the others.

**`acceptor`** (macOS/Windows default) - a primary thread creates an acceptor app that receives all connections and distributes them to worker threads via uWS child app descriptors. Works on all platforms.

The mode is auto-detected. Override it explicitly if needed:

```bash
# Force acceptor mode on Linux (e.g. for debugging)
CLUSTER_MODE=acceptor CLUSTER_WORKERS=auto node build
```

Setting `CLUSTER_MODE=reuseport` on non-Linux platforms is an error (SO_REUSEPORT is not reliable outside Linux).

### WebSocket + clustering

`platform.publish()` is automatically relayed across all workers via the primary thread, so subscribers on any worker receive the message. This is built in - no external pub/sub needed. The relay is microtask-batched: a SvelteKit action that calls `publish()` multiple times sends a single IPC message per microtask instead of one per call.

If you add your own cross-process messaging (Redis, Postgres LISTEN/NOTIFY, etc.), pass `{ relay: false }` to prevent duplicate delivery - your external source already fans out to every worker, so the built-in relay would double it.

Per-worker limitations (acceptable for most apps):
- `platform.connections`  - returns the count for the local worker only
- `platform.subscribers(topic)`  - returns the count for the local worker only
- `platform.sendTo(filter, ...)`  - iterates the local worker's connections only, no cross-worker relay
- `platform.closedWsAborts`  - per-worker counter; sum across workers for cluster total
- `platform.assertions`  - per-worker counter Map

### Shared memory across workers, and compute workers

By default every worker is an island - there is no seam to hand them shared state, and every worker listens, so a latency-critical compute loop competes with connection I/O on the same thread. Two options change that.

**`primaryInit`** runs once in the primary thread, before any worker spawns. Use it to allocate cross-worker shared memory - a `SharedArrayBuffer`, SPSC/MPSC rings, a `MessagePort` - that every worker then receives with the same references, no race. Its return value is surfaced to the `init` hook as `workerData`, and is replayed *identically* when a crashed worker respawns (a fresh buffer would be a different world). It is a **module path** (like `metrics`), not a live function: adapter options are serialized into the build, so a function written in `svelte.config.js` could never reach the runtime. The module is bundled as its own isolated entry, so the primary loads only it - never the app graph - and a top-level side effect in `hooks.ws` never runs in the supervisor.

**`workers: { compute }`** splits the `CLUSTER_WORKERS` pool into I/O workers (listen + serve) and `compute` dedicated compute workers that fire `init` (receiving the shared memory via `workerData`) but never bind a listen socket - so a tick loop pays no connection-I/O jitter - all under the same lifecycle (drain, crash-respawn with identical `workerData`, heartbeat, metrics). I/O workers = total - compute.

```js
// src/lib/server/cluster.js
export default function primaryInit({ env }) {
  const world = new SharedArrayBuffer(WORLD_BYTES);
  return { world };            // -> every worker's init({ workerData }) sees the same buffer
}

// svelte.config.js
adapter({
  websocket: {
    primaryInit: './src/lib/server/cluster.js',
    workers: { compute: 2 }    // of CLUSTER_WORKERS total; the rest serve connections
  }
});

// src/hooks.ws.js
export function init({ platform, workerData }) {
  const view = new Int32Array(workerData.world);  // shared across all workers
  // ...I/O workers read/write it per request; compute workers drive it on a tick
}
```

```bash
# 12 workers: 10 serve connections, 2 run the shared-memory compute loop
CLUSTER_WORKERS=12 node build
```

General-purpose beyond simulations: a cross-worker LRU cache, a shared rate-limit / token-bucket table, shared metric counters, or shared model weights. No effect in single-process mode (`workerData` is `null`); with neither option set, behavior is byte-identical to a cluster without them.

### Cross-worker state-divergence detection

The relay carries each published message to every worker, so under healthy operation every worker has seen the same set of published messages per topic. Optionally, the cluster can watch for the case where it has *not* - a relay frame that reached some workers but not another (a partial fan-out, a frame a worker failed to apply). This shows up as workers disagreeing on the highest sequence number they have delivered for a topic.

Enable it with `stateHashIntervalMs` (clustered mode only):

```js
// svelte.config.js
adapter({
  websocket: {
    stateHashIntervalMs: 30000 // each worker reports a state hash every ~30s
  }
})
```

When set, each worker periodically folds a structure-only projection of its relay state into a single 32-bit hash and reports it to the primary. The primary buckets the reports by its own clock (so a worker's clock skew never matters), and once every live worker has reported it compares the hashes. If they disagree at rest, the primary logs a `state-divergence` line carrying the epoch, the per-thread hash, and the majority/minority split. **Only the integer hash and the worker's thread id ever cross the thread boundary - no topic strings, no payloads, no client identity.**

The same interval also checks for a **lost interior frame**, which the hash comparison structurally cannot see: a worker that received frames 2 and 3 of a stream and one that received 1, 2 and 3 both top out at 3, so their hashes agree exactly. Each worker numbers the frames it hands to the relay, per topic, and a receiver that finds a hole in that numbering has lost data - it does not need to be compared against anyone to know that, so it reports it directly rather than being voted on:

```
[adapter-uws/relay-gap] lost 1 relayed frame(s) for topic=room:42 from worker=3 (ordinals 7-7). This worker is missing state its siblings received.
[primary] relay-gap worker=5 frames=1
```

A hole is only reported once it has outlived any plausible in-process reorder, so a frame that is merely late is never called lost, and each loss is reported once rather than restated on every interval. When a `metrics` registry is configured the frames are counted on `relay_gap_frames_total`. `RESTART_ON_STATE_DIVERGENCE=1` also covers this case, and unambiguously: the worker that reports the gap is the worker that lost the data, so there is no majority to weigh.

This is observe-only by default: a divergence is logged, and (when a [`metrics`](#backpressure-and-connection-limits) registry is configured) the `state_divergence_total` counter is incremented. It never costs anything in single-process mode or when `stateHashIntervalMs` is `0` (the default) - no reporter timer is scheduled.

To have the primary automatically terminate a diverged (minority) worker so it restarts and re-converges, set the `RESTART_ON_STATE_DIVERGENCE=1` environment variable. This is **off by default** - a diverged worker is left running and only logged, because terminating a worker is disruptive and the right response is often operator judgement, not an automatic kill:

```bash
CLUSTER_WORKERS=auto RESTART_ON_STATE_DIVERGENCE=1 node build
```

Divergence between workers in the built-in relay indicates a framework or plugin bug and is worth reporting. Note that topics fed from an *external* pub/sub source (passed with `{ relay: false }`) never travel the in-process relay, so the gap detector - which numbers relayed frames - has nothing to check for them. They are still included in the divergence hash, which projects the whole sequence map regardless of how a topic was published.

### Per-worker consistency auditor

Each worker runs a background consistency auditor that checks the framework's structural invariants - for example, that every connection's subscription bookkeeping is internally consistent - against a snapshot of its live connections. It is **on by default** and zero-config; it exists to turn a silent state-corruption bug into a loud, logged signal.

It is built to be safe and cheap:

- **Off the hot path.** Publish, send, subscribe, and close pay nothing. The auditor reads state the worker already maintains, on a slow, jittered, unref'd timer that never holds the event loop open.
- **Bounded.** It audits a fixed slice of connections per tick, walked round-robin, so a worker with a million connections does a constant amount of work each tick regardless of how many connections it holds.
- **Structure-only.** The snapshot carries no payloads, no topic strings, and no client identity beyond the per-connection session id used as a log label.
- **Soft by default.** A detected violation logs a `[adapter-uws/assert]` line and increments the queryable [`platform.assertions`](#platformassertions) counter; it does **not** terminate the worker. The single exception is a subscription slot that has become corrupt (a non-`Set`, which cannot heal): if it persists across two consecutive audits, it escalates to a deferred worker restart (exit code 78), the same code the cross-worker divergence restart uses.

The cadence is configurable, and `0` disables the auditor entirely:

```js
// svelte.config.js
adapter({
  websocket: {
    consistencyAuditIntervalMs: 5000 // default; 0 disables the auditor (no timer, zero cost)
  }
})
```

Unlike the state-divergence reporter, the auditor runs in single-process **and** clustered deployments alike - it is a per-worker net, not a cross-worker comparison.

### Docker / multi-process deployments (Linux)

On Linux, `SO_REUSEPORT` is set on every `app.listen()` call - including single-process mode. This means multiple independent `node build` processes can bind to the same port without any adapter-level clustering. The kernel distributes connections across them.

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

With `network_mode: host`, containers share the host network stack directly - no port mapping needed, and services like Postgres and Redis are reachable via `127.0.0.1`. This avoids Docker bridge DNS and gives the best network performance.

**When to use what:**
- **`CLUSTER_WORKERS`** - single-machine deployments without Docker/k8s/systemd managing processes for you
- **Docker replicas** - production deployments where your infrastructure already handles process management and you have external pub/sub for cross-process messaging

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

Without these changes, each process is limited to 1024 file descriptors (the default). Each WebSocket connection uses one file descriptor, so the default caps you at roughly 1000 concurrent connections per process. The server CPU can be well under 50% and you will still hit this ceiling - the bottleneck is the OS, not uWS or your application code.

The server checks this at boot: when the soft limit is below 8192 it logs a one-line warning with the remediation above, so a low-limit deployment is caught before the first connection storm instead of during it. With the [`metrics`](#backpressure-and-connection-limits) option configured, the `open_fds` and `fd_soft_limit` gauges chart the live headroom.

For a deeper walkthrough, see [Millions of active WebSockets with Node.js](https://unetworkingab.medium.com/millions-of-active-websockets-with-node-js-7dc575746a01) from the uWebSockets.js authors.

### Stress testing: run it from the server

If you run a stress test from your local machine against a remote server, every WebSocket connection goes through your home router's NAT table. Home routers typically have 1024 to 4096 NAT entries. Once the table fills up, the router drops ALL new outbound connections - not just your test, but SSH, your phone on WiFi, everything on your network.

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

**WebSocket ping/pong:** Set `idleTimeout` in the adapter's `websocket` option (in seconds) to have uWS send automatic WebSocket ping frames and close connections that don't respond. The default is 120 seconds. The client store handles pong automatically. Setting it to `0` disables the idle timeout, which also disables that liveness check: a connection whose peer has silently gone away is never reaped and keeps its slot.

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

uWS native pub/sub delivered 3.5M messages/s with exact 50x fan-out. The adapter matches it - the byte-prefix check and string template envelope add near-zero overhead to the hot path. `socket.io` and `ws` both collapsed under the same load, delivering less than 1x fan-out (massive message loss/queueing).

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

- **Request state pooling** - SSR requests need a `{ aborted: false }` state object. Instead of allocating one per request (which promotes to V8's old generation and stays there), the adapter maintains a pool of up to 256 reusable state objects. Eliminates young-gen GC churn under sustained load.
- **Envelope prefix cache** - `platform.publish()` and `platform.send()` wrap data in a `{"topic":"...","event":"...","data":...}` envelope. The prefix up to `"data":` is cached in a 256-entry LRU map keyed by topic+event. Repeated publishes to the same topic/event (the common case) skip 4 string concatenations and the character validation scan. The cache is trimmed every 60 seconds to reclaim stale entries from shifted traffic patterns.

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

The adapter retains ~68% of raw uWS HTTP throughput and matches uWS native WebSocket throughput. The HTTP overhead is dominated by things SvelteKit requires (`new Request()`, proper HTTP headers). The WebSocket overhead is now almost entirely the `JSON.stringify` of your `data` payload - the adapter's own machinery costs near zero. In a real app, your load functions and component rendering will dwarf all of this - the adapter's job is to get out of the way, and it does.

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
npm install uNetworking/uWebSockets.js#v20.69.0
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

**Working in a clone of this repository:** the installed addon is verified byte for byte against `scripts/uws-accepted.json` - the resolved commit, the upstream source commit, and a SHA-256 per shipped file. A `check-uws-binaries FAILED` message means the installed binaries are not the ones this tree was tested against, and the repair is `npm install`, not editing the record. A deliberate pin bump is re-accepted with `node scripts/check-uws-binaries.js --update`; review that diff, it is the record of which binaries changed.

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

Every message sent through `platform.publish()` or `platform.topic().created()` arrives as JSON with this shape. The envelope is constructed with string concatenation for speed, but `topic` and `event` are validated first - if either contains a quote, backslash, or control character, the call throws instead of producing malformed JSON:

```json
{
  "topic": "todos",
  "event": "created",
  "data": { "id": 1, "text": "Buy milk", "done": false },
  "seq": 42
}
```

The `seq` field is a monotonic per-topic sequence number stamped automatically on every `platform.publish()`. The first publish to a topic sends `seq: 1`, the next `seq: 2`, and so on; each topic has its own counter. Reconnecting clients can use the seq to detect dropped frames and resume from where they left off. Pass `{ seq: false }` to skip stamping when you don't care about gap detection or when topic cardinality is unbounded:

```js
// Standard publish - seq stamped automatically
platform.publish('chat', 'message', msg);

// Opt out for ephemeral or high-cardinality topics
platform.publish(`cursor:${userId}`, 'move', pos, { seq: false });
```

> **Clustering:** the per-topic counter is worker-local. Each worker stamps its own publishes; relayed messages from other workers pass through with the originating worker's seq. For cluster-wide monotonic seq across all workers, wire up the Redis Lua INCR variant from the extensions package, which stamps its authoritative sequence onto the broadcast frame through the `{ seq: <number> }` publish option so the wire seq and the replay buffer share one space.

The client store parses this automatically. When you use `on('todos')`, the store value is:
```js
{ topic: 'todos', event: 'created', data: { id: 1, text: 'Buy milk', done: false }, seq: 42 }
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

Working in a clone of this repository, these are the commands around them:

| Command | What it does |
|---|---|
| `npm run bootstrap` | Root deps if absent, the fixture's own deps, then the doctor |
| `npm run doctor` | Whether this machine can prove anything; `--require-uws` makes a missing addon fatal |
| `npm run verify:fast` | The static gates |
| `npm run verify:pr` | Exactly what the hosted gate runs |
| `npm run verify:full` | `verify:pr` plus the Playwright e2e run, which no workflow runs |
| `npm run check:links` | Dead anchors and dead relative links in the shipped docs |

Unit tests cover store patterns, adapter options, plugin logic, client behavior, and the WebSocket test harness. They run in vitest with the `vmForks` pool.

E2e tests start a real SvelteKit app (`test/fixture/`) with the adapter installed via `file:../..`. Playwright runs two projects:

- **dev** - `vite dev` with the Vite plugin. Tests SSR, static files, WebSocket pub/sub (via `ws` clients), and the real `client.js` running in Chromium.
- **prod** - `vite build` + `node build/index.js` through uWebSockets.js. Tests the same surface against the production runtime, plus the health check endpoint and 404 handling.

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

The test server starts on a random port (typically in ~2ms), uses the same subscribe/unsubscribe protocol as production, and exposes the full Platform API (`publish`, `send`, `sendTo`, `topic`, `connections`, `subscribers`, `assertions`).

#### `createTestServer` options

```js
server = await createTestServer({
  handler: myHandler,
  // Mirror of the production wsOptions; pass either to test the same
  // behaviour your production app gets.
  upgradeAdmission: { maxConcurrent: 100, perTickBudget: 16 },
  // Other production-equivalents available:
  // wsOptions: { maxBackpressure, idleTimeout, maxPayloadLength, ... },
  // origin: '*' | 'same-origin' | string[],
  // env: { ... }   // ENV_PREFIX-aware env shim for the SvelteKit `platform.env`
});
```

`close()` fires your `shutdown` hook with the same `{ platform, reason, signal, deadline }` production passes, under the same `SHUTDOWN_TIMEOUT` budget (seconds, default 30, `0` = no budget), so a hook that gives up cleanly on `signal` - or one that wedges - behaves here the way it will in the deployment. `/readyz` answers `503 starting` while your `init` hook runs, exactly as a real instance does. Two differences worth knowing rather than discovering: the harness reads `SHUTDOWN_TIMEOUT` without the `ENV_PREFIX` your deployment may apply, and it has no in-flight request drain and no `sveltekit:shutdown` phase for the budget to cover - here the budget bounds the hook only.

`upgradeAdmission` is the same `{ maxConcurrent, perTickBudget }` shape the production handler accepts via `adapter({ websocket: { upgradeAdmission: ... } })`. Passing it to `createTestServer` lets you assert admission shedding (503 responses on the upgrade path) end-to-end without booting a full SvelteKit app. `protection` and `metrics` mirror the production options the same way: the harness emits `upgrade_admitted_total` and `upgrade_rejected_total{reason}` at the branches it mirrors (`siege`, `over_capacity`, `cursor_lane`, `auth_rejected`, `hook_error`), so a test can assert the admission counters with a recording registry. The sampled gauges and the `ip_rate_limit` / `bad_origin` / `auth_timeout` reasons are production-only - the harness runs no pressure sampler, no per-IP limiter, no origin check, and no upgrade timeout.

#### Curated helper re-exports from `svelte-adapter-uws/testing`

Downstream test code (extensions, app-side integration tests, custom transport bridges) often needs to assert on the same wire shapes the production runtime produces. The `testing` entry point re-exports a curated set of pure helpers and userData slot constants so you don't redeclare helpers that would drift over time:

```js
import {
  createTestServer,
  // wire-protocol helpers
  esc, completeEnvelope, wrapBatchEnvelope,
  isValidWireTopic, createScopedTopic,
  // behaviour helpers
  collapseByCoalesceKey, resolveRequestId, createChaosState,
  // per-connection userData slot constants (use as Symbol keys on userData)
  WS_SUBSCRIPTIONS, WS_COALESCED, WS_SESSION_ID,
  WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM,
  WS_CAPS, WS_REQUEST_ID_KEY
} from 'svelte-adapter-uws/testing';
```

Production-internal plumbing (mime lookup, byte parsing, cookie split, write-chunk backpressure, sampler internals, upgrade admission factory, origin allowlist matcher) is deliberately NOT re-exported so the test surface can stay stable while production hot paths remain free to refactor.

#### Chaos / fault-injection

The test platform also carries `__chaos(cfg)` for simulating broken-network conditions. Use it to verify that protocol code (subscribe acks, session resume, sendCoalesced, request/reply) recovers from message loss and slow consumers without changing the test fixture's hooks.

```js
// Verify the client store's reconnect path delivers buffered seqs
// after a 30% packet-loss episode.
server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 0.3 });
for (let i = 0; i < 100; i++) {
  server.platform.publish('feed', 'tick', { i });
}
await new Promise(r => setTimeout(r, 200));
server.platform.__chaos(null);  // back to normal delivery

// The client received some subset of the 100 ticks; on reconnect,
// the resume protocol should fill the gap.
```

```js
// Stretch the wire by 50ms per frame to exercise sendCoalesced
// drop semantics under backpressure.
server.platform.__chaos({ scenario: 'slow-drain', delayMs: 50 });
```

```js
// Reorder publishes within a 50ms jitter window: each frame waits
// an independently-random delay before reaching subscribers.
// Adjacent frames can arrive out of order, exercising seq-gap
// detection and idempotency-key handling.
server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: 50 });
```

```js
// Simulate a worker process restart: close all live WebSocket
// connections with a clean close frame. The server stays up and
// keeps accepting new connections, so the test can immediately
// observe the client's reconnect + resume behavior.
server.platform.__chaos({ scenario: 'worker-flap' });
// Or with a custom close code / reason:
server.platform.__chaos({ scenario: 'worker-flap', code: 4001, reason: 'maintenance' });
```

**Continuous scenarios** (consulted on every outbound frame):

- **`drop-outbound`** - discards outbound frames before they reach the wire with the configured `dropRate` (a probability in `[0, 1]`). Affects every server-to-client frame: `platform.publish`, `platform.send`, `platform.sendTo`, `platform.request`, the welcome envelope, subscribe acks, and the resumed ack.
- **`slow-drain`** - defers outbound frames by `delayMs` milliseconds via `setTimeout`. Order is preserved per call site (every frame waits the same delay).
- **`ipc-reorder`** - defers each outbound frame by an independently-random delay in `[0, maxJitterMs)`. Adjacent frames can arrive out of order, simulating cross-worker relay reordering or queue jitter. `maxJitterMs` is capped at `60_000`.

**One-shot trigger** (does NOT change continuous chaos state):

- **`worker-flap`** - closes every currently-live WebSocket connection with a clean close frame. Defaults to `code: 1012` ("server restart") and `reason: 'worker restart'`; both are configurable. The server stays up and accepts new connections; an active continuous scenario (e.g. `drop-outbound`) survives the flap and applies to subsequent frames. Use to verify clients reconnect, present their resume token, and your `resume` hook fills the gap correctly.

Pass `null` (or call `__chaos()` with no argument) to clear the active continuous scenario; the harness returns to its zero-overhead fast paths. While a scenario is active, `platform.publish` switches from uWS's C++ TopicTree fan-out to a JS-side fanout so the chaos state can intercept per recipient.

> Note: `__chaos` lives on the test platform only. The production runtime does not ship the harness; chaos belongs in test files, not user code.

##### Scope: WS-frame outbound only

`__chaos` is a WebSocket-frame outbound chokepoint - it intercepts what the test harness sends to its connected WS clients, and only that. Transport-level traffic to anything else you've wired up alongside the adapter (an ioredis client for cross-instance pub/sub, a `pg` connection for `LISTEN/NOTIFY`, a NATS subscription, a custom HTTP backend) does NOT pass through `sendOutboundT` and is untouched by the harness.

This is intentional: each layer's chaos surface stays cohesive with what that layer actually owns. The adapter knows its WS wire and ships chaos for that. Each backend / extension knows its own wire and is the right place to wrap that wire's client.

##### Wrap your own transport for cross-wire chaos

For cross-wire fault injection, the `createChaosState` factory re-exported from `svelte-adapter-uws/testing` is the same primitive `__chaos` uses internally. Wrap any transport client with it and you get the same `__chaos({ scenario, dropRate, delayMs })` ergonomic, scoped to that client. The pattern is one helper:

```js
import { createChaosState } from 'svelte-adapter-uws/testing';

// Wrap any transport client (ioredis, pg, NATS, fetch, ...) so its
// outbound calls become chaos-controllable from test code. Same shape
// as __chaos on the test platform, scoped to this one client.
function makeChaosClient(client, methodName = 'publish') {
  const chaos = createChaosState();
  const original = client[methodName].bind(client);

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === '__chaos') return (cfg) => chaos.set(cfg);
      if (prop !== methodName) return Reflect.get(target, prop, receiver);
      return async (...args) => {
        if (chaos.shouldDropOutbound()) return 0;
        const delay = chaos.getDelayMs();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return original(...args);
      };
    }
  });
}

// Test:
const redis = makeChaosClient(realRedisClient, 'publish');
redis.__chaos({ scenario: 'drop-outbound', dropRate: 0.3 });
// ... drive the system, assert it tolerates 30% Redis publish loss ...
redis.__chaos(null);
```

Composes across transports: `makeChaosClient(pgClient, 'query')`, `makeChaosClient(natsClient, 'publish')`, etc. Zero new adapter surface; downstream extensions that need cross-wire fault injection own their own wrappers.

### Deterministic simulation

`createTestServer` runs your handler against a real server with real timing. When you need to reproduce a rare interleaving exactly - a drop that only matters when it races a subscribe, an ordering that only breaks under reorder - reach for `svelte-adapter-uws/sim`. It drives the **same** wire dispatch over an in-memory server under a virtual clock and a seeded fault model, so a seed reproduces a run bit-for-bit: a seed plus a commit is the entire bug report.

```js
import { runSim, replaySim } from 'svelte-adapter-uws/sim';

const result = await runSim({
  seed: 'my-seed',
  clients: 4,
  topics: ['room'],
  faults: { drop: 0.2, reorder: 0.6, maxJitterMs: 30 },
  handler: {
    subscribe(ws, topic) { return topic.startsWith('admin:') ? 'FORBIDDEN' : null; }
  }
});

result.invariantViolations; // [] when bookkeeping stayed sound under the faults
result.clientFrames;        // each client's decoded frames, in delivery order

// Re-run the exact same seed and assert the outcome reproduces bit-for-bit.
const replay = await replaySim(result);
replay.reproduced; // true
```

The scheduler models the event loop's microtask -> timers -> check phase boundary, so a `setTimeout(0)` lands in a later timers phase rather than collapsing into the microtask drain - the publish/relay coalescers batch exactly as they do in production. A seeded PRNG backs every clock, RNG, UUID, and timer, and the fault engine applies `drop` / `delayMs` / `reorder` / `duplicate` / `corrupt` per wire frame. Pass a `scenario(api, { clients, topics })` function to script your own client traffic, or omit it for the default connect/subscribe/publish exercise. `runSimMany({ seeds, base })` sweeps a range of seeds. It is dev/test infrastructure - no new runtime dependency.

#### Seed swarm

`runSimSwarm` runs many seeds and reports pass/fail with an exact reproduce key - the failing seed string is the entire local reproduce command. It owns no wall clock and reads no environment, so it stays deterministic; supply the seed range and let a CI runner stamp the wall-clock metadata.

```js
import { runSimSwarm } from 'svelte-adapter-uws/sim';

const { summary } = await runSimSwarm({
  count: 500,                 // 500 consecutive integer seeds...
  startSeed: 1,               // ...from seed 1 (or pass an explicit `seeds` list)
  faultMode: 'random',           // fault a per-seed seeded subset (off | on | random)
  faultProfile: { drop: 0.25, reorder: 0.5, maxJitterMs: 30 },
  checkRatio: 0.05            // replay 5% of seeds and assert they reproduce
});

summary.ok;               // false if any seed failed or a re-check did not reproduce
summary.firstFailingSeed; // e.g. '237' - reproduce with runSim({ seed: '237' })
summary.failingSeeds;     // every failing seed
```

`faultMode` sets how fault injection is applied across the swarm: `'off'` runs each seed unfaulted, `'on'` layers `faultProfile` on every run, and `'random'` flips a per-seed seeded coin (`faultProbability`, default `0.25`) so one swarm covers both quiet and chaotic interleavings reproducibly. `checkRatio` re-runs a deterministically-chosen fraction through `replaySim` so a determinism regression fails the swarm distinctly from an invariant violation. Each run also carries an 8-hex-char structural `fingerprint`: if it ever changes for a fixed seed, determinism has regressed.

The bundled runner reads the swarm config from the environment, stamps wall-clock metadata, writes a result JSON, and exits non-zero on any failure - the shape a scheduled CI job runs:

```sh
DST_COUNT=1000 DST_FAULTS=random DST_CHECK_RATIO=0.05 GIT_COMMIT=$(git rev-parse HEAD) \
  npm run sim:swarm        # writes sim-swarm-result.json; exit 1 on a failing seed
```

#### Golden-set regression gate

The swarm proves each seed reproduces *itself*, but a code change that deterministically alters sim behavior still reproduces the new behavior - so the swarm passes it unnoticed. The golden gate pins the fingerprints to a committed baseline. `buildSimGoldens` projects a swarm result into a corpus (per-seed `{ seed, weight, fingerprint, digest }` plus the swarm config the fingerprints are only comparable under); `checkSimGoldens` re-runs those seeds and fails when the weighted sum of drifted fingerprints exceeds a budget (default `0` - any drift on a weighted seed fails).

```js
import { runSimSwarm, buildSimGoldens, checkSimGoldens } from 'svelte-adapter-uws/sim';

// Bless a corpus from a clean swarm (a runner does this on --update):
const swarm = await runSimSwarm({ seeds: ['1', '2', '3'], checkRatio: 1 });
const corpus = buildSimGoldens(swarm, { swarm: { faultMode: 'off' } });

// Later, gate HEAD against it:
const report = checkSimGoldens(corpus, await runSimSwarm({ seeds: ['1', '2', '3'] }));
report.ok;         // false if any weighted seed's fingerprint drifted
report.drifts;     // [{ seed, weight, kind: 'changed'|'missing', golden, actual }], weight-desc
```

A per-seed `weight` sets how much its drift counts against `maxDriftWeight`; `weight: 0` is a watch-list seed (drift is reported but never gates). The bundled runner verifies a committed corpus and re-blesses on demand:

```sh
npm run sim:golden               # verify HEAD against test/dst-goldens/*.json; exit 1 on drift
npm run sim:golden -- --update   # regenerate + bless (refuses a broken or nondeterministic swarm)
```

An intentional behavior change is blessed by re-running `--update` and committing the corpus diff - the reviewable record of exactly what moved.

### Resource-leak harness

`svelte-adapter-uws/sim` also ships a reusable leak detector. Its core is a pure, deterministic trend kernel: give `detectGrowth` a numeric series (successive samples of some bookkeeping size) and it votes three ways - least-squares **slope**, **monotonic fraction**, and total **delta** - so a flat or sawtooth series is never mistaken for a leak, only a sustained climb is.

```js
import {
  createResourceTracker,
  structuralResourceProbes,
  assertNoResourceGrowth
} from 'svelte-adapter-uws/sim';

// Trend the live sizes of your own registries across a churn workload.
const tracker = createResourceTracker(structuralResourceProbes({ mySubs, myRooms }));
for (const _ of cycles) { churn(); tracker.sample(); }
assertNoResourceGrowth(tracker); // throws LeakError (with .leaks) if any series climbs
```

In the simulator, pass `leakProbe: true` to sample the server's structural sizes each step; the result carries a per-series `resourceGrowth`, and because the samples are structural (Map/Set sizes only) it stays inside the determinism gate - `replaySim` reproduces it bit-for-bit. The bundled `churnScenario` (open+subscribe+publish+close cycles) is a ready workload: a healthy close path sheds every entry, so a clean run reports zero leaks and a regression that retains per-connection state surfaces as a climbing series.

```js
import { runSim, churnScenario } from 'svelte-adapter-uws/sim';

const r = await runSim({ scenario: churnScenario, leakProbe: true, clients: 4 });
r.resourceGrowth.every((s) => !s.leaking); // true when the close path is clean
```

For the non-deterministic memory dimension, `processResourceProbes({ forceGc })` trends `heapUsed` / `rss` / `external` / `arrayBuffers` and active handle/request counts - drive it from a real server under `node --expose-gc`. And for production, the opt-in `resourceGrowthAuditIntervalMs` ws option installs an observe-only trend auditor (a metric plus one throttled warning, never fatal).

---

## Related projects

- [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions) - Redis-backed extensions for multi-server deployments: persistent presence, distributed pub/sub, session storage, and more.
- [svelte-realtime](https://github.com/lanteanio/svelte-realtime) - Opinionated full-stack starter built on this adapter. Auth, database, real-time CRUD, and deployment config out of the box.
- [svelte-realtime-demo](https://github.com/lanteanio/svelte-realtime-demo) - Live demo of svelte-realtime. [Try it here.](https://svelte-realtime-demo.lantean.io/)

## License

[MIT](LICENSE)
