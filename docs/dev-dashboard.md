# The dev dashboard

`vite dev` serves a built-in diagnostics dashboard at `/__uws/dashboard`: live
connections, topics with subscriber counts, presence and cursor channels,
pressure and egress readings, and the adapter/protocol/sibling versions, kept
current over Server-Sent Events. It is a dev-only surface - the production
runtime, the build output, and deployed artifacts carry none of it.

The page is one server-rendered, self-contained HTML string: inline CSS,
inline vanilla JavaScript, and the snapshot embedded as an
`application/json` script tag. There is no build step, no static asset, and
no framework in the adapter's dependency graph. The page builds its DOM
through `textContent` exclusively, and the embedded JSON escapes `<`, U+2028,
and U+2029, so snapshot data can never become markup.

## Configuration

The dashboard is on by default. On the `uws()` Vite plugin:

```js
uws({ dashboard: false })              // disable
uws({ dashboard: { path: '/__diag' } }) // move the mount path
```

## The diagnostic report

`/__uws/dashboard/report` downloads the same page as a static HTML attachment
rendered by the same function with the live stream disabled. It opens from
disk with no server - a self-contained artifact for bug reports. It carries
the dev session's topic names, so review it before sharing.

## Access control

The endpoint is loopback-only on three layers, and a refused request has its
unread body drained first so the refusal actually reaches the client:

- the **socket** must be loopback - `vite dev --host` binds the listener
  wide, and diagnostics for every connection on the machine must not be
  readable from the network;
- the **`Host` header** must name a loopback host (`localhost`, `127.0.0.1`,
  or `[::1]`, with or without a port). This is the DNS-rebinding defense: a
  hostile page can point its own domain's DNS at `127.0.0.1`, and the
  victim's browser then reaches this listener over a genuine loopback socket
  - but it cannot forge the `Host` header, which still names the attacker's
  domain. A bare DNS name is refused even if it currently resolves to
  loopback, because what it resolves to is the attacker's choice;
- the **`Origin` header**, when the browser sends one, must itself be a
  loopback origin, closing cross-site fetches from pages already running on
  a non-loopback origin of the same machine.

## Snapshot consistency

Every snapshot carries a strictly increasing sequence number - one counter
shared by the page's embedded copy, the SSE frames, and the reconnect fetch
at `/__uws/dashboard/snapshot`. The client applies a snapshot only when its
sequence is newer than the one on screen, so a fetch answered late can never
race the stream backwards.

## Extension sections

An installed extensions package can add its own section to the snapshot
without the adapter importing it. The contributor registry lives in the
global symbol registry, so it is shared across bundler-duplicated module
copies and needs no import edge:

```js
const registry = (() => {
  const key = Symbol.for('svelte-adapter-uws.dashboard-contributors');
  let m = globalThis[key];
  if (m === undefined) globalThis[key] = m = new Map();
  return m;
})();
registry.set('cluster-health', (snapshot) => ({ nodes: 3, healthy: 3 }));
```

The contributor is called at snapshot-build time with the composed snapshot
core; its return value lands under `snapshot.sections['cluster-health']` and
renders as an additional section. Registering a name again replaces the
previous contributor, so a hot-reloaded module does not stack copies of
itself, and a contributor that throws loses its own section, never the page.
