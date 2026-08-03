import { c as create_ssr_component, s as subscribe } from "../../chunks/ssr.js";
import { w as writable } from "../../chunks/index.js";
import { e as escape } from "../../chunks/escape.js";
const WIRE_BINARY_TAG = 3;
new TextEncoder();
const DEC = new TextDecoder();
const FRAME_IO = Object.freeze({
  allocate: (length) => new Uint8Array(length),
  copy: (target, source, offset) => target.set(source, offset)
});
let activeFrameIO = FRAME_IO;
class ByteReader {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this._buf = buf;
    this._view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  get done() {
    return this.pos >= this._buf.length;
  }
  /** @returns {number} */
  u8() {
    if (this.pos >= this._buf.length) throw new RangeError("wire: read past end");
    return this._buf[this.pos++];
  }
  /** @returns {number} */
  varint() {
    const first = this._buf[this.pos];
    if (first === void 0) throw new RangeError("wire: read past end");
    if (first < 128) {
      this.pos++;
      return first;
    }
    let result = 0;
    let mul = 1;
    let b;
    do {
      b = this._buf[this.pos++];
      if (b === void 0) throw new RangeError("wire: read past end");
      result += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    return result;
  }
  /** @returns {number} big-endian float32 */
  f32() {
    if (this.pos + 4 > this._buf.length) throw new RangeError("wire: read past end");
    const v = this._view.getFloat32(this.pos, false);
    this.pos += 4;
    return v;
  }
  /** @returns {number} big-endian float64 */
  f64() {
    if (this.pos + 8 > this._buf.length) throw new RangeError("wire: read past end");
    const v = this._view.getFloat64(this.pos, false);
    this.pos += 8;
    return v;
  }
  /** @returns {string} length-prefixed UTF-8 string */
  str() {
    const len = this.varint();
    if (this.pos + len > this._buf.length) throw new RangeError("wire: read past end");
    const s = DEC.decode(this._buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  /** @returns {Uint8Array} a zero-copy view of the bytes from the cursor to the
   * end - a codec whose tail is a differently-framed region (e.g. a bit stream)
   * reads the byte-aligned head, then hands the remainder off. */
  rest() {
    return this._buf.subarray(this.pos);
  }
}
function buildBinaryFrame(schemaVersion, topicId, seq, payload, io = activeFrameIO) {
  const lengthOfVarint = (value) => {
    let length = 1;
    while (value > 127) {
      value = Math.floor(value / 128);
      length++;
    }
    return length;
  };
  const headerLength = 2 + lengthOfVarint(topicId) + lengthOfVarint(seq);
  const frame = io.allocate(headerLength + payload.length);
  let at = 0;
  frame[at++] = WIRE_BINARY_TAG;
  frame[at++] = schemaVersion & 255;
  const writeVarint = (value) => {
    while (value > 127) {
      frame[at++] = value & 127 | 128;
      value = Math.floor(value / 128);
    }
    frame[at++] = value & 127;
  };
  writeVarint(topicId);
  writeVarint(seq);
  io.copy(frame, payload, at);
  return frame;
}
function parseBinaryFrame(bytes) {
  if (bytes.length < 2 || bytes[0] !== WIRE_BINARY_TAG) return null;
  try {
    const r = new ByteReader(bytes);
    r.u8();
    const schemaVersion = r.u8();
    const topicId = r.varint();
    const seq = r.varint();
    return { schemaVersion, topicId, seq, payload: bytes.subarray(r.pos) };
  } catch {
    return null;
  }
}
function requestNFrame(n) {
  return '{"type":"request-n","n":' + (n | 0) + "}";
}
const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_ARRAY = 6;
const TAG_OBJECT = 7;
function readValue(r) {
  const tag = r.u8();
  switch (tag) {
    case TAG_NULL:
      return null;
    case TAG_FALSE:
      return false;
    case TAG_TRUE:
      return true;
    case TAG_INT: {
      const u = r.varint();
      return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
    }
    case TAG_FLOAT:
      return r.f64();
    case TAG_STRING:
      return r.str();
    case TAG_ARRAY: {
      const n = r.varint();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r);
      return out;
    }
    case TAG_OBJECT: {
      const n = r.varint();
      const out = {};
      for (let i = 0; i < n; i++) {
        const key = r.str();
        const val = readValue(r);
        if (key === "__proto__") {
          Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true });
        } else {
          out[key] = val;
        }
      }
      return out;
    }
    default:
      throw new RangeError("wire-value: unknown tag " + tag);
  }
}
function decodeValue(bytes) {
  return readValue(new ByteReader(bytes));
}
const _hasPerf = typeof globalThis.performance !== "undefined" && typeof globalThis.performance.now === "function";
const _processStartEpoch = _hasPerf ? Date.now() - globalThis.performance.now() : 0;
const _webcrypto = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : void 0;
function _uuidFallback(rngFloat) {
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
      continue;
    }
    if (i === 14) {
      out += "4";
      continue;
    }
    const r = rngFloat() * 16 | 0;
    out += (i === 19 ? r & 3 | 8 : r).toString(16);
  }
  return out;
}
const defaultEnv = Object.freeze({
  clock: Object.freeze({
    now: () => Date.now(),
    // exact wall clock; direct read
    monotonic: _hasPerf ? () => _processStartEpoch + globalThis.performance.now() : () => Date.now(),
    // duration math
    wallEpoch: () => Date.now()
    // exact wall clock; process-identity baseline
  }),
  rng: Object.freeze({
    float: () => Math.random(),
    u32: () => Math.random() * 4294967296 >>> 0,
    uuid: _webcrypto && typeof _webcrypto.randomUUID === "function" ? () => _webcrypto.randomUUID() : () => _uuidFallback(() => Math.random()),
    bytes: _webcrypto && typeof _webcrypto.getRandomValues === "function" ? (n) => _webcrypto.getRandomValues(new Uint8Array(n)) : (n) => {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = Math.random() * 256 | 0;
      return a;
    }
  }),
  timers: Object.freeze({
    set: (cb, ms, ...a) => setTimeout(cb, ms, ...a),
    setInterval: (cb, ms, ...a) => setInterval(cb, ms, ...a),
    // No setImmediate in the browser: a zero-delay macrotask is the closest.
    setImmediate: (cb, ...a) => setTimeout(cb, 0, ...a),
    clear: (h) => clearTimeout(h),
    clearInterval: (h) => clearInterval(h),
    queueMicrotask: typeof globalThis.queueMicrotask === "function" ? (cb) => globalThis.queueMicrotask(cb) : (cb) => Promise.resolve().then(cb)
  }),
  tz: void 0
  // effective timezone for cron evaluation; undefined = real local TZ
});
let current = defaultEnv;
const now = () => current.clock.now();
const monotonicNow = () => current.clock.monotonic();
const randomFloat = () => current.rng.float();
const setTimer = (cb, ms, ...a) => current.timers.set(cb, ms, ...a);
const setIntervalTimer = (cb, ms, ...a) => current.timers.setInterval(cb, ms, ...a);
const clearTimer = (h) => current.timers.clear(h);
const clearIntervalTimer = (h) => current.timers.clearInterval(h);
const microtask = (cb) => current.timers.queueMicrotask(cb);
function nextReconnectDelay(base, maxDelay, attempt, randFactor = randomFloat()) {
  const capped = Math.min(base * Math.pow(2.2, attempt), maxDelay);
  return capped * (0.75 + randFactor * 0.5);
}
function dispersedReconnectDelay(afterMs, windowMs, randFactor = randomFloat()) {
  const floor = afterMs > 0 ? afterMs : 0;
  const width = windowMs > 0 ? windowMs : 0;
  const r = randFactor >= 0 && randFactor < 1 ? randFactor : 0;
  return floor + width * r;
}
let singleton = null;
const wireCodecs = /* @__PURE__ */ new Map();
const managedTopics = /* @__PURE__ */ new Set();
function buildHelloCaps() {
  const caps = ["batch", "lease", "wire.ingress:1", "game.fanout:1"];
  for (const codec of wireCodecs.values()) {
    const tokens = codec.capabilities || [codec.capability];
    for (let i = 0; i < tokens.length; i++) caps.push(tokens[i]);
  }
  return caps;
}
function wireCodecForTopic(topic) {
  let best = null;
  let bestLen = -1;
  for (const [prefix, codec] of wireCodecs) {
    if (topic.startsWith(prefix) && prefix.length > bestLen) {
      best = { prefix, codec };
      bestLen = prefix.length;
    }
  }
  return best;
}
function ensureConnection(options, explicit = false) {
  if (!singleton) {
    singleton = createConnection({});
  }
  return singleton;
}
function on(topic, event) {
  const conn = ensureConnection();
  const store = conn.on(topic);
  return store;
}
const status = {
  subscribe(fn) {
    return ensureConnection().status.subscribe(fn);
  }
};
const TERMINAL_CLOSE_CODES = /* @__PURE__ */ new Set([
  1008,
  // Policy Violation
  4401,
  // Unauthorized (custom)
  4403
  // Forbidden (custom)
]);
const THROTTLE_CLOSE_CODES = /* @__PURE__ */ new Set([
  4429
  // Rate limited (custom)
]);
function classifyCloseCode(code) {
  if (TERMINAL_CLOSE_CODES.has(code)) return "TERMINAL";
  if (THROTTLE_CLOSE_CODES.has(code)) return "THROTTLE";
  return "RETRY";
}
function createConnection(options) {
  const {
    url,
    path = "/ws",
    reconnectInterval = 3e3,
    maxReconnectInterval = 3e5,
    maxReconnectAttempts = Infinity,
    debug = false,
    auth = false
  } = options;
  const authPath = auth === true ? "/__ws/auth" : typeof auth === "string" && auth ? auth : null;
  let ws = null;
  let reconnectTimer = null;
  let activityTimer = null;
  let authInFlight = null;
  let attempt = 0;
  let intentionallyClosed = false;
  let terminalClosed = false;
  let reconnectAdvisory = null;
  let lastServerMessage = now();
  const SERVER_TIMEOUT_MS = 15e4;
  const ACTIVITY_INTERVAL_MS = 3e4;
  const SUSPEND_GAP_MS = 6e4;
  let gapRefWall = now();
  let gapRefMono = monotonicNow();
  let lastActivityTickWall = now();
  function readSuspendGap() {
    const wall = now();
    const mono = monotonicNow();
    const excess = wall - gapRefWall - (mono - gapRefMono);
    gapRefWall = wall;
    gapRefMono = mono;
    return excess;
  }
  const subscribedTopics = /* @__PURE__ */ new Set();
  const topicRefCounts = /* @__PURE__ */ new Map();
  const wireIdMap = /* @__PURE__ */ new Map();
  const wireDecoderStates = /* @__PURE__ */ new Map();
  function ensureDecoderState(prefix, codec) {
    if (!codec.state || typeof codec.state.onAttach !== "function") return null;
    let st = wireDecoderStates.get(prefix);
    if (st === void 0) {
      try {
        st = codec.state.onAttach();
      } catch {
        st = null;
      }
      wireDecoderStates.set(prefix, st);
    }
    return st;
  }
  function resetWireDecoderStates() {
    for (const [prefix, st] of wireDecoderStates) {
      const codec = wireCodecs.get(prefix);
      if (codec && codec.state && typeof codec.state.onDetach === "function") {
        try {
          codec.state.onDetach(st);
        } catch {
        }
      }
    }
    wireDecoderStates.clear();
  }
  let ingressSupported = false;
  let ingressNextId = 1;
  const ingressBindings = /* @__PURE__ */ new Map();
  const INGRESS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
  function sendIngressAnnounce(id, binding) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ingress-bind", id, kind: binding.kind, target: binding.target }));
  }
  function resetIngress() {
    ingressSupported = false;
    for (const b of ingressBindings.values()) {
      b.bound = false;
      b.seq = 0;
    }
  }
  function onIngressOk() {
    ingressSupported = true;
    for (const [id, b] of ingressBindings) sendIngressAnnounce(id, b);
  }
  function onIngressBound(id) {
    const b = ingressBindings.get(id);
    if (b) b.bound = true;
  }
  function bindIngressDest(kind, target) {
    const id = ingressNextId++;
    const binding = { kind, target, bound: false, seq: 0 };
    ingressBindings.set(id, binding);
    if (ingressSupported) sendIngressAnnounce(id, binding);
    return {
      live() {
        return binding.bound && ws?.readyState === WebSocket.OPEN;
      },
      // Re-send the announce if this binding is not yet live. The first
      // announce (on `ingress-ok`) can lose a race against the server's
      // lazy load of the destination's ingress handler; a consumer that
      // reaches a point where the server is known-ready (the smooth channel
      // after a sync reply) calls this to converge the binding to binary.
      // A no-op once bound, or before the server confirmed ingress support.
      reannounce() {
        if (!binding.bound && ingressSupported) sendIngressAnnounce(id, binding);
      },
      /** @param {number} schemaVersion @param {Uint8Array} payload */
      send(schemaVersion, payload) {
        if (!binding.bound || ws?.readyState !== WebSocket.OPEN) return false;
        if ((ws.bufferedAmount ?? 0) > INGRESS_BACKPRESSURE_BYTES) return true;
        binding.seq++;
        ws.send(buildBinaryFrame(schemaVersion, id, binding.seq, payload));
        return true;
      },
      dispose() {
        ingressBindings.delete(id);
      }
    };
  }
  const lastSeenSeqs = /* @__PURE__ */ new Map();
  const lastSeenEpochs = /* @__PURE__ */ new Map();
  const sessionStorageKey = "svelte-adapter-uws.session." + path;
  function storeSessionId(id) {
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem(sessionStorageKey, id);
    } catch {
    }
  }
  const sendQueue = [];
  const MAX_QUEUE_SIZE = 1e3;
  const eventsStore = writable(null);
  const topicStores = /* @__PURE__ */ new Map();
  const eventStores = /* @__PURE__ */ new Map();
  const statusStore = writable("disconnected");
  function setStatusOpen() {
    if (typeof document !== "undefined" && document.hidden) {
      statusStore.set("suspended");
    } else {
      statusStore.set("open");
    }
  }
  let nextSubscribeRef = 1;
  const denialsStore = writable(null);
  let _flowActive = false;
  let _flowAvail = 0;
  let _flowExpiresAt = 0;
  const _FLOW_LOW_WATER = 64;
  const _FLOW_REQUEST_N = 256;
  const _FLOW_MAX_QUEUE = 256;
  const _flowQueue = [];
  let _flowDegraded = false;
  let _flowReplenishSent = false;
  let _onFlowDegraded = null;
  function _flowFresh() {
    return _flowAvail > 0 && now() < _flowExpiresAt;
  }
  function _setFlowDegraded(d) {
    if (d === _flowDegraded) return;
    _flowDegraded = d;
    if (_onFlowDegraded) _onFlowDegraded(d);
  }
  function _maybeReplenish() {
    if (!_flowActive) return;
    if (_flowReplenishSent) return;
    if (_flowQueue.length > 0 || !_flowFresh() || _flowAvail <= _FLOW_LOW_WATER) {
      _flowReplenishSent = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(requestNFrame(_FLOW_REQUEST_N));
      }
    }
  }
  function _flowSend(doSend) {
    if (!_flowActive) {
      doSend();
      return true;
    }
    if (_flowFresh()) {
      _flowAvail--;
      doSend();
      _maybeReplenish();
      return true;
    }
    if (_flowQueue.length < _FLOW_MAX_QUEUE) {
      _flowQueue.push(doSend);
      _setFlowDegraded(true);
      _maybeReplenish();
      return false;
    }
    _setFlowDegraded(true);
    return false;
  }
  function _applyFlowWindow(count, ttlMs) {
    _flowActive = true;
    _flowExpiresAt = now() + ttlMs;
    _flowAvail = count;
    _flowReplenishSent = false;
    while (_flowAvail > 0 && _flowQueue.length > 0) {
      const doSend = _flowQueue.shift();
      _flowAvail--;
      if (doSend) doSend();
    }
    if (_flowQueue.length === 0) _setFlowDegraded(false);
  }
  const SUBSCRIBE_BATCH_ENVELOPE_BYTES = 50;
  const SUBSCRIBE_BATCH_MAX_BYTES = 8e3;
  const SUBSCRIBE_BATCH_MAX_TOPICS = 200;
  const subscribeBatchEncoder = new TextEncoder();
  function chunkTopicsForBatch(topics) {
    const out = [];
    let chunk = [];
    let chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
    for (const t of topics) {
      const entryBytes = subscribeBatchEncoder.encode(JSON.stringify(t)).length + 1;
      if (chunk.length > 0 && (chunk.length >= SUBSCRIBE_BATCH_MAX_TOPICS || chunkBytes + entryBytes > SUBSCRIBE_BATCH_MAX_BYTES)) {
        out.push(chunk);
        chunk = [];
        chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
      }
      chunk.push(t);
      chunkBytes += entryBytes;
    }
    if (chunk.length > 0) out.push(chunk);
    return out;
  }
  function chunkResubscribe(topics) {
    const out = [];
    let chunk = [];
    let recover = null;
    let chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
    for (const t of topics) {
      let entryBytes = subscribeBatchEncoder.encode(JSON.stringify(t)).length + 1;
      let entry = null;
      const offset = lastSeenSeqs.get(t);
      if (offset !== void 0) {
        const epoch = lastSeenEpochs.get(t);
        entry = epoch !== void 0 ? { offset, epoch } : { offset };
        entryBytes += subscribeBatchEncoder.encode(JSON.stringify(t) + ":" + JSON.stringify(entry)).length + 1;
      }
      if (chunk.length > 0 && (chunk.length >= SUBSCRIBE_BATCH_MAX_TOPICS || chunkBytes + entryBytes > SUBSCRIBE_BATCH_MAX_BYTES)) {
        out.push({ topics: chunk, recover });
        chunk = [];
        recover = null;
        chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
      }
      chunk.push(t);
      if (entry !== null) {
        if (recover === null) recover = {};
        recover[t] = entry;
      }
      chunkBytes += entryBytes;
    }
    if (chunk.length > 0) out.push({ topics: chunk, recover });
    return out;
  }
  let pendingSubscribes = null;
  function flushPendingSubscribes() {
    const batch = pendingSubscribes;
    pendingSubscribes = null;
    if (!batch || batch.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (batch.length === 1) {
      const topic = batch[0];
      if (debug) console.log("[ws] subscribe ->", topic);
      _flowSend(() => ws.send(JSON.stringify({ type: "subscribe", topic, ref: nextSubscribeRef++ })));
      return;
    }
    for (const chunk of chunkTopicsForBatch(batch)) {
      if (debug) console.log("[ws] subscribe-batch ->", chunk);
      _flowSend(() => ws.send(JSON.stringify({ type: "subscribe-batch", topics: chunk, ref: nextSubscribeRef++ })));
    }
  }
  const failureStore = writable(null);
  let lastCloseCode = 0;
  let lastCloseReason = "";
  let requestHandler = null;
  const permaClosedStore = writable(false);
  function getUrl() {
    if (url) return url;
    if (typeof window === "undefined") return "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
  }
  function getAuthUrl() {
    if (!authPath) return null;
    if (url) {
      try {
        const wsUrl = new URL(url);
        const httpScheme = wsUrl.protocol === "wss:" ? "https:" : "http:";
        return httpScheme + "//" + wsUrl.host + authPath;
      } catch {
        return null;
      }
    }
    if (typeof window === "undefined") return null;
    return window.location.origin + authPath;
  }
  function runAuth() {
    if (!authPath) return Promise.resolve({ outcome: "ok", status: 0, reason: "" });
    if (authInFlight) return authInFlight;
    const target = getAuthUrl();
    if (!target) return Promise.resolve({ outcome: "ok", status: 0, reason: "" });
    authInFlight = (async () => {
      try {
        const resp = await fetch(target, {
          method: "POST",
          credentials: "include",
          headers: { "x-requested-with": "svelte-adapter-uws" }
        });
        if (debug) console.log("[ws] auth preflight status=%d", resp.status);
        if (resp.ok) return { outcome: "ok", status: resp.status, reason: "" };
        if (resp.status >= 400 && resp.status < 500) {
          return { outcome: "unauthorized", status: resp.status, reason: resp.statusText || "unauthorized" };
        }
        return { outcome: "transient", status: resp.status, reason: resp.statusText || "service unavailable" };
      } catch (err) {
        if (debug) console.warn("[ws] auth preflight network error:", err);
        return { outcome: "transient", status: 0, reason: "network error" };
      } finally {
        authInFlight = null;
      }
    })();
    return authInFlight;
  }
  function doConnect() {
    if (!url && typeof window === "undefined") return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    statusStore.set("connecting");
    if (authPath) {
      runAuth().then((result) => {
        if (intentionallyClosed || terminalClosed) return;
        if (result.outcome === "unauthorized") {
          if (debug) console.warn("[ws] auth preflight rejected (4xx), not opening WebSocket");
          failureStore.set({
            kind: "auth-preflight",
            class: "AUTH",
            status: result.status,
            reason: result.reason
          });
          statusStore.set("failed");
          terminalClosed = true;
          permaClosedStore.set(true);
          return;
        }
        if (result.outcome === "transient") {
          if (debug) console.warn("[ws] auth preflight transient failure, scheduling reconnect");
          failureStore.set({
            kind: "auth-preflight",
            class: "AUTH",
            status: result.status,
            reason: result.reason
          });
          statusStore.set("disconnected");
          scheduleReconnect();
          return;
        }
        openSocket();
      });
      return;
    }
    openSocket();
  }
  function openSocket() {
    try {
      ws = new WebSocket(getUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    const sock = ws;
    ws.binaryType = "arraybuffer";
    wireIdMap.clear();
    resetWireDecoderStates();
    resetIngress();
    ws.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      reconnectAdvisory = null;
      lastServerMessage = now();
      failureStore.set(null);
      setStatusOpen();
      if (debug) console.log("[ws] connected");
      ws?.send(JSON.stringify({ type: "hello", caps: buildHelloCaps() }));
      if (subscribedTopics.size > 0) {
        for (const { topics, recover } of chunkResubscribe([...subscribedTopics])) {
          const frame = { type: "subscribe-batch", topics, ref: nextSubscribeRef++ };
          if (recover !== null) frame.recover = recover;
          if (debug) console.log("[ws] resubscribe-batch ->", topics, recover ? "(+recover)" : "");
          ws?.send(JSON.stringify(frame));
        }
      }
      while (sendQueue.length > 0) {
        const msg = sendQueue.shift();
        if (debug) console.log("[ws] flush ->", msg);
        if (msg !== void 0) ws?.send(msg);
      }
    };
    function dispatchEvent(msg) {
      const wsEvent = { topic: msg.topic, event: msg.event, data: msg.data };
      if (typeof msg.t === "number") wsEvent.t = msg.t;
      if (typeof msg.seq === "number") wsEvent.seq = msg.seq;
      if (typeof msg.j === "number") wsEvent.j = msg.j;
      if (debug) console.log("[ws] <-", msg.topic, msg.event, msg.data);
      if (typeof msg.seq === "number") {
        const prev = lastSeenSeqs.get(msg.topic);
        if (prev === void 0 || msg.seq > prev) lastSeenSeqs.set(msg.topic, msg.seq);
      } else if ((msg.event === "truncated" || msg.event === "rehydrate") && typeof msg.topic === "string" && msg.topic.charCodeAt(0) === 95 && msg.topic.charCodeAt(1) === 95 && msg.topic.startsWith("__replay:")) {
        const baseTopic = msg.topic.slice("__replay:".length);
        lastSeenSeqs.delete(baseTopic);
        lastSeenEpochs.delete(baseTopic);
      }
      eventsStore.set(wsEvent);
      const tStore = topicStores.get(msg.topic);
      if (tStore) tStore.set(wsEvent);
      const eStore = eventStores.get(`${msg.topic}\0${msg.event}`);
      if (eStore) eStore.set({ data: msg.data });
    }
    ws.onmessage = (rawEvent) => {
      if (ws !== sock) return;
      lastServerMessage = now();
      try {
        if (rawEvent.data instanceof ArrayBuffer) {
          if (rawEvent.data.byteLength > 1048576) {
            if (debug) console.warn("[ws] binary frame too large, dropped:", rawEvent.data.byteLength, "bytes");
            return;
          }
          const parsed = parseBinaryFrame(new Uint8Array(rawEvent.data));
          if (parsed) {
            const topic = wireIdMap.get(parsed.topicId);
            if (topic !== void 0) {
              const match = wireCodecForTopic(topic);
              const decoded = match ? match.codec.decode(parsed.payload, ensureDecoderState(match.prefix, match.codec), parsed.schemaVersion, parsed.seq, topic) : null;
              if (decoded && !match.codec.sink) {
                const out = { topic, event: decoded.event, data: decoded.data };
                if (parsed.seq > 0) out.seq = parsed.seq;
                if (decoded.t !== void 0) out.t = decoded.t;
                dispatchEvent(out);
              } else if (!match) {
                let value;
                try {
                  value = decodeValue(parsed.payload);
                } catch {
                  value = null;
                }
                if (Array.isArray(value) && typeof value[0] === "string") {
                  const out = { topic, event: value[0], data: value[1] };
                  if (parsed.seq > 0) out.seq = parsed.seq;
                  dispatchEvent(out);
                }
              }
            } else if (debug) {
              console.warn("[ws] 0x03 frame for unknown topicId", parsed.topicId);
            }
          }
          return;
        }
        if (typeof rawEvent.data === "string" && rawEvent.data.length > 1048576) {
          if (debug) console.warn("[ws] message too large, dropped:", rawEvent.data.length, "bytes");
          return;
        }
        const msg = JSON.parse(rawEvent.data);
        if (msg.topic && msg.event !== void 0) {
          dispatchEvent(msg);
          return;
        }
        if (msg.type === "batch" && Array.isArray(msg.events)) {
          for (let i = 0; i < msg.events.length; i++) {
            const e = msg.events[i];
            if (e && typeof e.topic === "string" && e.event !== void 0) {
              dispatchEvent(e);
            }
          }
          return;
        }
        if (msg.type === "welcome" && typeof msg.sessionId === "string") {
          storeSessionId(msg.sessionId);
          if (debug) console.log("[ws] welcome sessionId=%s", msg.sessionId);
          return;
        }
        if (msg.type === "resumed") {
          if (debug) console.log("[ws] resumed");
          return;
        }
        if (msg.type === "lease-ok") {
          _flowActive = true;
          return;
        }
        if (msg.type === "lease" && typeof msg.count === "number" && typeof msg.ttlMs === "number") {
          _applyFlowWindow(msg.count, msg.ttlMs);
          return;
        }
        if (msg.type === "subscribed" && typeof msg.topic === "string") {
          if (typeof msg.epoch === "number") lastSeenEpochs.set(msg.topic, msg.epoch);
          if (debug) console.log("[ws] subscribed topic=%s ref=%s epoch=%s", msg.topic, msg.ref, msg.epoch);
          return;
        }
        if (msg.type === "wire-id" && typeof msg.topic === "string" && typeof msg.id === "number") {
          wireIdMap.set(msg.id, msg.topic);
          if (debug) console.log("[ws] wire-id topic=%s id=%d", msg.topic, msg.id);
          return;
        }
        if (msg.type === "ingress-ok") {
          onIngressOk();
          if (debug) console.log("[ws] ingress-ok");
          return;
        }
        if (msg.type === "ingress-bound" && typeof msg.id === "number") {
          onIngressBound(msg.id);
          if (debug) console.log("[ws] ingress-bound id=%d", msg.id);
          return;
        }
        if (msg.type === "subscribe-denied" && typeof msg.topic === "string" && typeof msg.reason === "string") {
          console.warn("[ws] subscribe denied topic=%s reason=%s\n  See: https://svti.me/subscribe-denied", msg.topic, msg.reason);
          denialsStore.set({ topic: msg.topic, reason: msg.reason, ref: msg.ref });
          return;
        }
        if (msg.type === "error" && typeof msg.code === "string") {
          console.warn(
            "[ws] protocol error code=%s%s%s",
            msg.code,
            typeof msg.limit === "number" ? " (limit " + msg.limit + " bytes)" : "",
            typeof msg.size === "number" ? " (frame was " + msg.size + " bytes)" : ""
          );
          return;
        }
        if (msg.type === "request" && (typeof msg.ref === "number" || typeof msg.ref === "string") && typeof msg.event === "string") {
          if (!requestHandler) {
            if (debug) console.warn("[ws] request received but no handler installed - dropping (server will time out)");
            return;
          }
          const ref = msg.ref;
          Promise.resolve().then(() => requestHandler(msg.event, msg.data)).then((result) => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "reply", ref, data: result ?? null }));
            }
          }).catch((err) => {
            const message = err && err.message ? String(err.message) : String(err);
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "reply", ref, error: message }));
            }
          });
          return;
        }
        if (msg.type === "reconnect") {
          const windowMs = typeof msg.windowMs === "number" && msg.windowMs > 0 ? msg.windowMs : 0;
          if (windowMs > 0) {
            const afterMs = typeof msg.afterMs === "number" && msg.afterMs > 0 ? msg.afterMs : 0;
            const graceMs = 5e3;
            reconnectAdvisory = { afterMs, windowMs, deadline: now() + afterMs + windowMs + graceMs };
          }
          return;
        }
      } catch {
      }
    };
    ws.onclose = (event) => {
      if (ws !== sock) return;
      ws = null;
      if (debug) console.log("[ws] disconnected");
      lastCloseCode = event?.code || 0;
      lastCloseReason = event?.reason || "";
      if (intentionallyClosed) {
        failureStore.set(null);
        statusStore.set("failed");
        return;
      }
      const cls = classifyCloseCode(event?.code);
      const code = lastCloseCode;
      const reason = lastCloseReason;
      if (cls === "TERMINAL") {
        if (debug) console.warn("[ws] connection permanently closed by server (code " + event?.code + ")");
        terminalClosed = true;
        permaClosedStore.set(true);
        failureStore.set({ kind: "ws-close", class: "TERMINAL", code, reason });
        statusStore.set("failed");
        return;
      }
      const advisory = reconnectAdvisory;
      reconnectAdvisory = null;
      if (advisory && now() < advisory.deadline) {
        failureStore.set({ kind: "ws-close", class: "DRAIN", code, reason });
        statusStore.set("disconnected");
        attempt = 0;
        scheduleReconnect(dispersedReconnectDelay(advisory.afterMs, advisory.windowMs));
        return;
      }
      if (cls === "THROTTLE") {
        attempt = Math.max(attempt, 5);
        failureStore.set({ kind: "ws-close", class: "THROTTLE", code, reason });
      } else {
        failureStore.set({ kind: "ws-close", class: "RETRY", code, reason });
      }
      statusStore.set("disconnected");
      scheduleReconnect();
    };
    ws.onerror = () => {
    };
  }
  function scheduleReconnect(overrideDelayMs) {
    if (reconnectTimer) return;
    if (attempt >= maxReconnectAttempts) {
      failureStore.set({
        kind: "ws-close",
        class: "EXHAUSTED",
        code: lastCloseCode,
        reason: lastCloseReason || "max reconnect attempts exhausted"
      });
      statusStore.set("failed");
      terminalClosed = true;
      permaClosedStore.set(true);
      return;
    }
    let delay;
    if (typeof overrideDelayMs === "number") {
      delay = overrideDelayMs;
    } else {
      delay = nextReconnectDelay(reconnectInterval, maxReconnectInterval, attempt);
      attempt++;
    }
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      doConnect();
    }, delay);
  }
  function subscribe2(topic) {
    const count = topicRefCounts.get(topic) || 0;
    topicRefCounts.set(topic, count + 1);
    if (count > 0) return;
    if (topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95 || managedTopics.has(topic)) return;
    subscribedTopics.add(topic);
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!pendingSubscribes) {
      pendingSubscribes = [];
      microtask(flushPendingSubscribes);
    }
    pendingSubscribes.push(topic);
  }
  function release(topic) {
    const count = topicRefCounts.get(topic) || 0;
    if (count <= 1) {
      topicRefCounts.delete(topic);
      doUnsubscribe(topic);
    } else {
      topicRefCounts.set(topic, count - 1);
    }
  }
  function unsubscribe(topic) {
    topicRefCounts.delete(topic);
    doUnsubscribe(topic);
  }
  function doUnsubscribe(topic) {
    managedTopics.delete(topic);
    subscribedTopics.delete(topic);
    topicStores.delete(topic);
    for (const key of eventStores.keys()) {
      if (key.startsWith(topic + "\0")) eventStores.delete(key);
    }
    if (debug) console.log("[ws] unsubscribe ->", topic);
    if (topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", topic }));
    }
  }
  function makeScan(source) {
    return function scan(initial, reducer) {
      let acc = initial;
      const accumulated = writable(initial);
      let sourceUnsub = null;
      let subCount = 0;
      return {
        subscribe(fn) {
          if (subCount === 0) {
            sourceUnsub = source.subscribe((value) => {
              if (value !== null) {
                acc = reducer(acc, value);
                accumulated.set(acc);
              }
            });
          }
          subCount++;
          const unsub = accumulated.subscribe(fn);
          return () => {
            unsub();
            subCount--;
            if (subCount === 0 && sourceUnsub) {
              sourceUnsub();
              sourceUnsub = null;
            }
          };
        }
      };
    };
  }
  function onTopic(topic) {
    let store = topicStores.get(topic);
    if (!store) {
      store = writable(null);
      topicStores.set(topic, store);
      const ownStore = store;
      microtask(() => {
        if (subs === 0 && !topicRefCounts.has(topic) && topicStores.get(topic) === ownStore) {
          topicStores.delete(topic);
        }
      });
    }
    let subs = 0;
    function wrappedSubscribe(fn) {
      if (subs++ === 0) {
        const current2 = topicStores.get(topic);
        if (!current2) {
          store = writable(null);
          topicStores.set(topic, store);
        } else if (current2 !== store) {
          store = current2;
        }
        subscribe2(topic);
      }
      const unsub = store.subscribe(fn);
      return () => {
        unsub();
        if (--subs === 0) release(topic);
      };
    }
    const wrapped = { subscribe: wrappedSubscribe };
    return { subscribe: wrappedSubscribe, scan: makeScan(wrapped) };
  }
  function onEvent(topic, event) {
    const key = `${topic}\0${event}`;
    let store = eventStores.get(key);
    if (!store) {
      store = writable(null);
      eventStores.set(key, store);
      const ownStore = store;
      microtask(() => {
        if (subs === 0 && !topicRefCounts.has(topic) && eventStores.get(key) === ownStore) {
          eventStores.delete(key);
        }
      });
    }
    let subs = 0;
    function wrappedSubscribe(fn) {
      if (subs++ === 0) {
        const current2 = eventStores.get(key);
        if (!current2) {
          store = writable(null);
          eventStores.set(key, store);
        } else if (current2 !== store) {
          store = current2;
        }
        subscribe2(topic);
      }
      const unsub = store.subscribe(fn);
      return () => {
        unsub();
        if (--subs === 0) release(topic);
      };
    }
    const wrapped = { subscribe: wrappedSubscribe };
    return { subscribe: wrappedSubscribe, scan: makeScan(wrapped) };
  }
  function serializeForSend(data) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return (
        /** @type {ArrayBuffer | ArrayBufferView} */
        data
      );
    }
    return JSON.stringify(data);
  }
  function send(data) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (debug) console.log("[ws] send ->", data);
      ws.send(serializeForSend(data));
    } else if (debug) {
      console.warn("[ws] send dropped (not connected) - use sendQueued() to queue messages for reconnect:", data, "\n  See: https://svti.me/send-dropped");
    }
  }
  function sendQueued(data) {
    const serialized = serializeForSend(data);
    if (ws?.readyState === WebSocket.OPEN) {
      if (debug) console.log("[ws] send ->", data);
      ws.send(serialized);
    } else {
      if (sendQueue.length >= MAX_QUEUE_SIZE) {
        console.warn("[ws] queue full (" + MAX_QUEUE_SIZE + "), dropping oldest message\n  See: https://svti.me/client-queue");
        sendQueue.shift();
      }
      if (debug) console.log("[ws] queued ->", data);
      sendQueue.push(serialized);
    }
  }
  let visibilityHandler = null;
  let offlineHandler = null;
  let onlineHandler = null;
  function close() {
    intentionallyClosed = true;
    permaClosedStore.set(true);
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    if (activityTimer) {
      clearIntervalTimer(activityTimer);
      activityTimer = null;
    }
    if (visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
    if (typeof window !== "undefined") {
      if (offlineHandler) {
        window.removeEventListener("offline", offlineHandler);
        offlineHandler = null;
      }
      if (onlineHandler) {
        window.removeEventListener("online", onlineHandler);
        onlineHandler = null;
      }
    }
    ws?.close();
    ws = null;
    singleton = null;
    failureStore.set(null);
    statusStore.set("failed");
  }
  doConnect();
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.hidden) {
        const gapAtHide = readSuspendGap();
        if (intentionallyClosed || terminalClosed) return;
        if (ws?.readyState === WebSocket.OPEN) {
          if (gapAtHide > SUSPEND_GAP_MS && now() - lastServerMessage > 5e3) {
            if (debug) console.log("[ws] suspend gap detected at hide, reconnecting");
            attempt = 0;
            ws.close();
            return;
          }
          statusStore.set("suspended");
        }
        return;
      }
      if (intentionallyClosed || terminalClosed) return;
      if (ws?.readyState === WebSocket.OPEN) {
        if (readSuspendGap() > SUSPEND_GAP_MS && now() - lastServerMessage > 5e3) {
          if (debug) console.log("[ws] suspend gap detected on resume, reconnecting");
          attempt = 0;
          ws.close();
          return;
        }
        statusStore.set("open");
        return;
      }
      attempt = 0;
      if (reconnectTimer) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      doConnect();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    offlineHandler = () => {
      if (intentionallyClosed || terminalClosed) return;
      if (debug) console.log("[ws] browser reported offline, dropping the socket");
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      } else {
        statusStore.set("disconnected");
      }
    };
    onlineHandler = () => {
      if (intentionallyClosed || terminalClosed) return;
      if (ws?.readyState === WebSocket.OPEN) return;
      if (debug) console.log("[ws] browser reported online, reconnecting now");
      attempt = 0;
      if (reconnectTimer) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      doConnect();
    };
    window.addEventListener("offline", offlineHandler);
    window.addEventListener("online", onlineHandler);
  }
  if (typeof window !== "undefined") {
    activityTimer = setIntervalTimer(() => {
      const nowMs = now();
      const suspendGap = readSuspendGap();
      const silence = nowMs - lastServerMessage;
      const timerThrottled = nowMs - lastActivityTickWall > ACTIVITY_INTERVAL_MS * 1.5;
      lastActivityTickWall = nowMs;
      if (ws?.readyState === WebSocket.OPEN && (silence > SERVER_TIMEOUT_MS && !timerThrottled || suspendGap > SUSPEND_GAP_MS && silence > 5e3)) {
        if (debug) console.log("[ws] server silent for", silence, "ms (suspend gap", suspendGap, "ms), reconnecting");
        ws.close();
      }
    }, ACTIVITY_INTERVAL_MS);
  }
  function onRequest(handler) {
    requestHandler = typeof handler === "function" ? handler : null;
    return () => {
      if (requestHandler === handler) requestHandler = null;
    };
  }
  function resendHello() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "hello", caps: buildHelloCaps() }));
    }
  }
  return {
    events: { subscribe: eventsStore.subscribe },
    status: { subscribe: statusStore.subscribe },
    denials: { subscribe: denialsStore.subscribe },
    failure: { subscribe: failureStore.subscribe },
    _permaClosed: { subscribe: permaClosedStore.subscribe },
    _hasUrl: !!url,
    on: onTopic,
    _onEvent: onEvent,
    _release: release,
    subscribe: subscribe2,
    unsubscribe,
    send,
    sendQueued,
    // Bytes the browser has accepted via `ws.send` but not yet flushed
    // to the OS socket buffer. Mirrors the native WebSocket property.
    // Returns 0 when the underlying socket does not exist (pre-connect
    // or post-close). Use this for client-side paced sending: after
    // each chunk, check `conn.bufferedAmount` against a high-water
    // mark and back off until it drops below a low-water mark.
    get bufferedAmount() {
      return ws?.bufferedAmount ?? 0;
    },
    onRequest,
    _resendHello: resendHello,
    // Internal: bind a client->server binary ingress destination. A plugin
    // consumer (e.g. the smooth command channel) calls this to negotiate an
    // id-addressed `0x03` ingress binding and gets back a handle that sends
    // binary when the binding is live and reports when it is not (so the
    // consumer can fall back to its JSON path). See `bindIngressDest`.
    _bindIngress: bindIngressDest,
    // Internal: the resolved WebSocket URL this connection dials. A plugin
    // that opens its own dedicated socket (the cursor render worker) must
    // reach the same endpoint the main connection negotiated - including a
    // custom `url` / `path` option - so the derivation is exposed here
    // rather than re-derived from window.location in the plugin.
    _url: getUrl,
    // Internal-only subscription to the connection's flow-control health.
    // A boolean (degraded yes/no) is the only thing that crosses this
    // accessor - no window count, deadline, or any internal accounting
    // value. The realtime layer folds it into realtime.health. Emits the
    // current value on subscribe; returns an unsubscribe.
    _onLeaseDegraded(cb) {
      _onFlowDegraded = typeof cb === "function" ? cb : null;
      if (_onFlowDegraded) _onFlowDegraded(_flowDegraded);
      return () => {
        _onFlowDegraded = null;
      };
    },
    close
  };
}
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $status, $$unsubscribe_status;
  let $events, $$unsubscribe_events;
  $$unsubscribe_status = subscribe(status, (value) => $status = value);
  let { data } = $$props;
  const events = on("svelte4-floor");
  $$unsubscribe_events = subscribe(events, (value) => $events = value);
  if ($$props.data === void 0 && $$bindings.data && data !== void 0) $$bindings.data(data);
  $$unsubscribe_status();
  $$unsubscribe_events();
  return `<h1>${escape(data.message)}</h1> <p id="status">${escape($status)}</p> <p id="store">${escape($events ? JSON.stringify($events) : "none")}</p>`;
});
export {
  Page as default
};
