import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { bodyHash, brokerSecret, canonicalOrigin, LIMITS, sameOrigin, signEnvelope,
  SOCKET_PATH, SOCKET_PROTOCOL, verifyEnvelope, practiceInput } from '../../src/lib/runner/interactive-protocol.mjs';

class Failure extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
const sendJson = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(value));
};
async function boundedBody(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > LIMITS.frameBytes) throw new Failure('INVALID_INPUT', 400);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createBroker({ enabled = false, origin, secret, upstreamUrl, appUrl, runtimes,
  limits = LIMITS, now = Date.now } = {}) {
  const sessions = new Map();
  const users = new Map();
  const nonces = new Map();
  const canonical = canonicalOrigin(origin, process.env.NODE_ENV === 'production');
  if (enabled && (!canonical || typeof secret !== 'string' || Buffer.byteLength(secret) < 32)) throw new Failure('BROKER_UNAVAILABLE');
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes,
    perMessageDeflate: false, handleProtocols: protocols => protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false });

  function release(entry) {
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    sessions.delete(entry.id);
    if (users.get(entry.userId) === entry.id) users.delete(entry.userId);
    entry.cookie = undefined;
    entry.init = undefined;
    entry.state = 'closed';
    if (entry.browser?.readyState === WebSocket.OPEN) entry.browser.close(1000, 'SESSION_ENDED');
    entry.resolve?.();
  }
  function timer(entry, callback, ms) {
    const handle = setTimeout(() => { entry.timers.delete(handle); void callback(); }, ms);
    handle.unref?.();
    entry.timers.add(handle);
    return handle;
  }
  function resetIdle(entry) {
    clearTimeout(entry.idle);
    entry.timers.delete(entry.idle);
    entry.idle = timer(entry, () => { void cancel(entry, 'IDLE_TIMEOUT').catch(() => {}); }, limits.idleMs);
  }
  function cancel(entry, reason) {
    if (entry.state === 'closed') return Promise.resolve();
    if (entry.cancellation) return entry.cancellation;
    entry.state = 'cancelling';
    entry.cookie = undefined;
    entry.cancellation = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    // Attach before a browser disconnect's fire-and-forget cancellation.
    entry.cancellation.catch(() => {});
    if (entry.browser?.readyState === WebSocket.OPEN) {
      entry.browser.send(JSON.stringify({ type: 'error', code: reason }));
      entry.browser.close(4000, reason);
    }
    if (!entry.upstream || !entry.initialized) {
      entry.upstream?.terminate();
      release(entry);
    } else {
      // Runtime is emitted only after prime succeeds and the patched image has
      // assigned its job. Sending Stop earlier would close an uninitialized
      // upstream before its asynchronous cleanup can acknowledge cancellation.
      if (entry.readyForStop && entry.upstream.readyState === WebSocket.OPEN) entry.upstream.send(JSON.stringify({ type: 'stop' }));
      timer(entry, () => {
        // Transport loss is not cleanup acknowledgement. Keep this user/slot
        // quarantined and reject exam admission until the broker is restarted.
        entry.quarantined = true;
        entry.upstream.terminate();
        entry.reject(new Failure('CANCELLATION_UNCONFIRMED'));
      }, limits.cancellationMs);
    }
    return entry.cancellation;
  }
  const owned = payload => {
    const entry = sessions.get(payload.sessionId);
    if (!entry || entry.userId !== payload.userId || entry.authSessionId !== payload.authSessionId) throw new Failure('SESSION_NOT_FOUND', 404);
    return entry;
  };
  async function control(payload) {
    if (payload.action === 'create') {
      if (payload.origin !== canonical || typeof payload.userId !== 'string' || !payload.userId
        || typeof payload.authSessionId !== 'string' || !payload.authSessionId) throw new Failure('INVALID_INPUT', 400);
      if (users.has(payload.userId)) throw new Failure('USER_SESSION_EXISTS', 409);
      if (sessions.size >= limits.slots) throw new Failure('INTERACTIVE_CAPACITY', 429);
      const candidate = payload.init;
      const language = candidate?.language === 'c++' ? 'cpp' : candidate?.language;
      let init;
      try {
        init = practiceInput({ language, mode: 'practice', source: candidate?.files?.[0]?.content }, runtimes);
        if (JSON.stringify(init) !== JSON.stringify(candidate)) throw new Error();
      } catch { throw new Failure('INVALID_INPUT', 400); }
      const id = randomUUID();
      const grant = randomBytes(32).toString('base64url');
      const entry = { id, userId: payload.userId, authSessionId: payload.authSessionId, origin: canonical,
        init, grantHash: bodyHash(grant), state: 'pending', timers: new Set(), stdinBytes: 0, outputBytes: 0 };
      // Reserve synchronously before any await: pending grants occupy capacity.
      sessions.set(id, entry);
      users.set(entry.userId, id);
      entry.grantTimer = timer(entry, () => { void cancel(entry, 'GRANT_EXPIRED'); }, limits.grantMs);
      timer(entry, () => { void cancel(entry, 'WALL_LIMIT'); }, limits.wallMs);
      resetIdle(entry);
      return { sessionId: id, grant, protocol: SOCKET_PROTOCOL,
        socketPath: `/api/code/interactive/${id}/socket`, expiresAt: now() + limits.grantMs };
    }
    if (payload.action === 'cancel-user') {
      if (typeof payload.userId !== 'string') throw new Failure('INVALID_INPUT', 400);
      const entry = sessions.get(users.get(payload.userId));
      if (entry) await cancel(entry, 'EXAM_STARTED');
      return {};
    }
    const entry = owned(payload);
    if (payload.action === 'activate') {
      if (entry.state !== 'claimed') throw new Failure('SESSION_NOT_FOUND', 404);
      entry.state = 'authorized';
      return {};
    }
    if (payload.action === 'cancel') { await cancel(entry, 'STOPPED'); return {}; }
    throw new Failure('INVALID_INPUT', 400);
  }

  async function authorize(entry, cookie, action) {
    const proof = signEnvelope(secret, 'authorize', { action, sessionId: entry.id,
      userId: entry.userId, authSessionId: entry.authSessionId });
    const response = await fetch(new URL(`/api/code/interactive/${entry.id}/authorize`, appUrl), {
      headers: { cookie, origin: canonical, 'sec-fetch-site': 'same-origin', 'x-interactive-proof': proof },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 204) throw new Failure('AUTH_REQUIRED', 401);
  }
  function forward(entry, message) {
    const encoded = JSON.stringify(message);
    if (entry.browser.readyState !== WebSocket.OPEN) return;
    if (entry.browser.bufferedAmount + Buffer.byteLength(encoded) > limits.bufferedBytes) {
      void cancel(entry, 'SLOW_CONSUMER'); return;
    }
    entry.browser.send(encoded);
  }
  function attach(entry, browser) {
    entry.browser = browser;
    entry.state = 'connecting';
    const upstream = new WebSocket(upstreamUrl, { maxPayload: limits.frameBytes,
      perMessageDeflate: false, handshakeTimeout: 5000, followRedirects: false });
    entry.upstream = upstream;
    upstream.on('open', () => {
      if (entry.state !== 'connecting') { upstream.terminate(); return; }
      entry.state = 'running';
      entry.initialized = true;
      upstream.send(JSON.stringify(entry.init));
      entry.init = undefined;
    });
    upstream.on('message', (raw, binary) => {
      try {
        if (binary || entry.state === 'closed') throw new Error();
        const message = JSON.parse(raw.toString());
        if (message.type === 'data' && ['stdout', 'stderr'].includes(message.stream) && typeof message.data === 'string') {
          entry.outputBytes += Buffer.byteLength(message.data);
          if (entry.outputBytes > limits.outputBytes) { void cancel(entry, 'OUTPUT_LIMIT'); return; }
          forward(entry, { type: 'data', stream: message.stream, data: message.data });
        } else if (message.type === 'stage' && ['compile', 'run'].includes(message.stage)) {
          entry.stage = message.stage;
          forward(entry, { type: 'stage', stage: message.stage });
        } else if (message.type === 'exit') {
          forward(entry, { type: 'exit', stage: message.stage,
            code: Number.isSafeInteger(message.code) ? message.code : null,
            signal: typeof message.signal === 'string' && /^SIG[A-Z]{2,10}$/.test(message.signal) ? message.signal : null });
        } else if (message.type === 'runtime') {
          entry.readyForStop = true;
          if (entry.state === 'cancelling' && upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'stop' }));
          forward(entry, { type: 'runtime', language: message.language, version: message.version });
        } else if (message.type === 'error' && typeof message.code === 'string' && /^[A-Z_]{1,40}$/.test(message.code)) {
          if (message.code === 'CLEANUP_FAILED') entry.quarantined = true;
          forward(entry, { type: 'error', code: message.code });
        } else throw new Error();
      } catch { void cancel(entry, 'UPSTREAM_PROTOCOL'); }
    });
    upstream.on('error', () => { void cancel(entry, 'UPSTREAM_UNAVAILABLE'); });
    upstream.on('close', code => {
      if (!entry.initialized || (!entry.quarantined && [4000, 4999].includes(code))) release(entry);
      else {
        entry.quarantined = true;
        void cancel(entry, 'CANCELLATION_UNCONFIRMED');
        entry.reject?.(new Failure('CANCELLATION_UNCONFIRMED'));
      }
    });
    browser.on('error', () => { void cancel(entry, 'DISCONNECTED'); });
    browser.on('close', () => { void cancel(entry, 'DISCONNECTED'); });
    browser.on('message', (raw, binary) => {
      try {
        if (binary || entry.state !== 'running') throw new Error();
        const message = JSON.parse(raw.toString());
        if ((message.type === 'stop' && Object.keys(message).length === 1)
          || (message.type === 'signal' && message.signal === 'SIGINT' && Object.keys(message).length === 2)) {
          void cancel(entry, 'STOPPED'); return;
        }
        if (message.type === 'eof' && Object.keys(message).length === 1 && entry.stage === 'run' && !entry.stdinClosed) {
          entry.stdinClosed = true;
        } else if (message.type === 'data' && message.stream === 'stdin' && typeof message.data === 'string'
          && Object.keys(message).every(key => ['type', 'stream', 'data'].includes(key))
          && entry.stage === 'run' && !entry.stdinClosed) {
          if (message.data.includes('\u0003')) { void cancel(entry, 'STOPPED'); return; }
          entry.stdinBytes += Buffer.byteLength(message.data);
          if (entry.stdinBytes > limits.stdinBytes) { void cancel(entry, 'STDIN_LIMIT'); return; }
          if (message.data.length > 0) resetIdle(entry);
        } else throw new Error();
        const encoded = JSON.stringify(message);
        if (upstream.bufferedAmount + Buffer.byteLength(encoded) > limits.bufferedBytes) throw new Error();
        upstream.send(encoded);
      } catch { void cancel(entry, 'PROTOCOL_ERROR'); }
    });
    function check() {
      timer(entry, async () => {
        if (entry.state !== 'running') return;
        try { await authorize(entry, entry.cookie, 'check'); }
        catch { void cancel(entry, 'AUTH_REQUIRED'); return; }
        if (entry.state === 'running') check();
      }, 10000);
    }
    check();
    function ping() {
      timer(entry, () => {
        if (entry.state !== 'running') return;
        if (entry.awaitingPong) { void cancel(entry, 'DISCONNECTED'); return; }
        entry.awaitingPong = true;
        browser.ping();
        ping();
      }, 15000);
    }
    browser.on('pong', () => { entry.awaitingPong = false; });
    ping();
  }

  const server = createServer(async (request, response) => {
    if (!enabled || request.method !== 'POST' || request.url !== '/control') { sendJson(response, 404, {}); return; }
    try {
      const body = await boundedBody(request);
      const proof = verifyEnvelope(secret, 'control', request.headers['x-interactive-proof'], now());
      if (proof.method !== request.method || proof.path !== request.url || proof.bodyHash !== bodyHash(body)) throw new Failure('AUTH_REQUIRED', 401);
      for (const [nonce, expires] of nonces) if (expires <= now()) nonces.delete(nonce);
      if (nonces.has(proof.nonce) || nonces.size >= 4096) throw new Failure('AUTH_REQUIRED', 401);
      nonces.set(proof.nonce, proof.exp);
      sendJson(response, 200, await control(JSON.parse(body)));
    } catch (error) {
      sendJson(response, error instanceof Failure ? error.status : 401,
        { code: error instanceof Failure ? error.code : 'AUTH_REQUIRED' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 128;
  server.on('upgrade', async (request, socket, head) => {
    const reject = status => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!enabled) { reject(404); return; }
    const match = SOCKET_PATH.exec(request.url ?? '');
    if (!match || request.method !== 'GET') { reject(404); return; }
    if (!sameOrigin(request.headers, canonical)) { reject(403); return; }
    const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
    if (protocols.length !== 2 || !protocols.includes(SOCKET_PROTOCOL)) { reject(401); return; }
    const token = protocols.find(value => /^grant\.[A-Za-z0-9_-]{43}$/.test(value));
    const entry = sessions.get(match[1]);
    if (!entry || entry.state !== 'pending' || !token || bodyHash(token.slice(6)) !== entry.grantHash) { reject(401); return; }
    if (typeof request.headers.cookie !== 'string' || request.headers.cookie.length > 8192) { reject(401); return; }
    entry.state = 'claimed';
    clearTimeout(entry.grantTimer);
    entry.timers.delete(entry.grantTimer);
    entry.grantHash = undefined; // single use, even if durable authorization fails
    entry.cookie = request.headers.cookie;
    socket.once('close', () => { void cancel(entry, 'DISCONNECTED'); });
    socket.on('error', () => { void cancel(entry, 'DISCONNECTED'); });
    try {
      await authorize(entry, entry.cookie, 'activate');
      if (entry.state !== 'authorized' || socket.destroyed) throw new Failure('AUTH_REQUIRED', 401);
      sockets.handleUpgrade(request, socket, head, browser => attach(entry, browser));
    } catch {
      reject(401);
      void cancel(entry, 'AUTH_REQUIRED');
    }
  });
  return { server, sessions, async close() {
    await Promise.allSettled([...sessions.values()].map(entry => cancel(entry, 'SHUTDOWN')));
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const enabled = process.env.INTERACTIVE_RUNNER_ENABLED === 'true';
  const runtimes = JSON.parse(readFileSync(new URL('../../infra/piston/image-inputs.lock.json', import.meta.url))).runtimes;
  const broker = createBroker({ enabled, origin: process.env.APP_URL, secret: enabled ? brokerSecret() : undefined,
    upstreamUrl: 'ws://piston-interactive:2000/api/v2/connect', appUrl: 'http://app:3000', runtimes });
  broker.server.listen(3100, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void broker.close().finally(() => process.exit(0)); });
}
