import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { createBroker } from './server.mjs';
import { PistonRunnerClient } from '../../src/lib/runner/piston-client.ts';
import { isTrustedRunnerJob, runtimeByLanguage } from '../../src/lib/runner/client.ts';
import { bodyHash, LIMITS, practiceInput, signEnvelope, SOCKET_PROTOCOL, verifyEnvelope } from '../../src/lib/runner/interactive-protocol.mjs';

const runtimes = JSON.parse(readFileSync(new URL('../../infra/piston/image-inputs.lock.json', import.meta.url))).runtimes;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition did not become true'); await sleep(5); }
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, limits = {}) {
  const secret = randomBytes(32).toString('hex'); // ephemeral test-only, never logged
  const origin = 'https://learn.test';
  const upstreamServer = createServer();
  const peers = new WebSocketServer({ server: upstreamServer });
  const jobs = new Set();
  let killed = 0;
  let ignoreStop = false;
  let primeDelay = 0;
  peers.on('connection', peer => {
    peer.on('error', () => {});
    peer.on('message', raw => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'init') {
        setTimeout(() => {
          if (peer.readyState !== WebSocket.OPEN) return;
          jobs.add(peer);
          peer.send(JSON.stringify({ type: 'runtime', language: data.language, version: data.version }));
          peer.send(JSON.stringify({ type: 'stage', stage: 'run' }));
        }, primeDelay);
      }
      if (data.type === 'stop' && !ignoreStop) setTimeout(() => {
        jobs.delete(peer); killed++;
        peer.close(4000, 'JOB_CANCELLED');
      }, 10);
    });
    peer.on('close', () => jobs.delete(peer));
  });
  const upstream = await listen(upstreamServer);
  let brokerUrl;
  let denyExam = false;
  let pauseAuthorization;
  const rpc = async (payload, proofOverride) => {
    const body = JSON.stringify(payload);
    return fetch(`${brokerUrl}/control`, { method: 'POST', body,
      headers: { 'x-interactive-proof': proofOverride ?? signEnvelope(secret, 'control', { method: 'POST', path: '/control', bodyHash: bodyHash(body) }) } });
  };
  const app = createServer(async (request, response) => {
    try {
      const proof = verifyEnvelope(secret, 'authorize', request.headers['x-interactive-proof']);
      const actor = { a: ['alice', 'device-a'], b: ['bob', 'device-b'], a2: ['alice', 'other-device'] }[request.headers.cookie];
      if (!actor || actor[0] !== proof.userId || actor[1] !== proof.authSessionId || denyExam) { response.writeHead(403); response.end(); return; }
      if (pauseAuthorization) await pauseAuthorization;
      if (proof.action === 'activate') {
        const result = await rpc({ action: 'activate', sessionId: proof.sessionId, userId: proof.userId, authSessionId: proof.authSessionId });
        if (!result.ok) { response.writeHead(404); response.end(); return; }
      }
      response.writeHead(204); response.end();
    } catch { response.writeHead(401); response.end(); }
  });
  const appUrl = await listen(app);
  const broker = createBroker({ enabled: limits.enabled ?? true, secret, origin, appUrl,
    upstreamUrl: upstream.replace('http:', 'ws:') + '/api/v2/connect', runtimes,
    limits: { ...LIMITS, cancellationMs: 150, ...limits } });
  brokerUrl = await listen(broker.server);
  const create = async (userId = 'alice', authSessionId = 'device-a') => {
    const result = await rpc({ action: 'create', userId, authSessionId, origin,
      init: practiceInput({ language: 'python', source: 'input()', mode: 'practice' }, runtimes) });
    return { status: result.status, value: await result.json() };
  };
  const connect = async (grant, { cookie = 'a', requestOrigin = origin } = {}) => {
    const messages = [];
    const browser = new WebSocket(brokerUrl.replace('http:', 'ws:') + grant.socketPath,
      [SOCKET_PROTOCOL, `grant.${grant.grant}`], { headers: { ...(cookie ? { cookie } : {}),
        ...(requestOrigin ? { origin: requestOrigin } : {}) } });
    browser.on('message', raw => messages.push(JSON.parse(raw.toString())));
    browser.on('error', () => {});
    const status = await new Promise(resolve => {
      browser.once('open', () => resolve(101));
      browser.once('unexpected-response', (_request, response) => { response.resume(); browser.terminate(); resolve(response.statusCode); });
      browser.once('error', () => resolve(0));
    });
    return { browser, status, messages };
  };
  const run = async () => {
    const result = await create(); assert.equal(result.status, 200);
    const opened = await connect(result.value); assert.equal(opened.status, 101);
    await waitFor(() => opened.messages.some(message => message.type === 'stage'));
    return { ...opened, grant: result.value };
  };
  t.after(async () => {
    pauseAuthorization = undefined;
    await broker.close();
    for (const peer of peers.clients) peer.terminate();
    peers.close();
    upstreamServer.closeAllConnections(); app.closeAllConnections();
    await Promise.all([new Promise(resolve => upstreamServer.close(resolve)), new Promise(resolve => app.close(resolve))]);
  });
  return { broker, create, connect, run, rpc, jobs, secret,
    killed: () => killed, peer: () => [...jobs][0], denyExam: () => { denyExam = true; },
    pause: value => { pauseAuthorization = value; }, ignoreStop: () => { ignoreStop = true; }, delayPrime: value => { primeDelay = value; } };
}

test('flag off returns 404 for control and upgrades', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.create()).status, 404);
  const attempt = await f.connect({ socketPath: '/api/code/interactive/10000000-0000-4000-8000-000000000001/socket', grant: 'a'.repeat(43) });
  assert.equal(attempt.status, 404);
});
test('private control requires signed method, path and exact body; replay is rejected', async t => {
  const f = await fixture(t);
  const payload = { action: 'cancel-user', userId: 'alice' };
  assert.equal((await f.rpc(payload, 'invalid')).status, 401);
  const proof = signEnvelope(f.secret, 'control', { method: 'POST', path: '/control', bodyHash: bodyHash(JSON.stringify(payload)) });
  assert.equal((await f.rpc({ ...payload, userId: 'bob' }, proof)).status, 401);
  assert.equal((await f.rpc(payload, proof)).status, 200);
  assert.equal((await f.rpc(payload, proof)).status, 401);
});
for (const [name, options] of [ ['auth required', { cookie: '' }], ['cross-user rejected', { cookie: 'b' }],
  ['different login session rejected', { cookie: 'a2' }], ['Origin mismatch rejected', { requestOrigin: 'https://evil.test' }],
  ['missing Origin rejected', { requestOrigin: '' }] ]) {
  test(name, async t => {
    const f = await fixture(t); const grant = (await f.create()).value;
    const opened = await f.connect(grant, options);
    assert.equal(opened.status, name.includes('Origin') ? 403 : 401);
    assert.equal(f.jobs.size, 0);
  });
}
test('one interactive session per user includes pending grants; two-user pool admits no third', async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 200);
  assert.equal((await f.create('alice', 'other-device')).status, 409);
  assert.equal((await f.create('bob', 'device-b')).status, 200);
  assert.equal((await f.create('carol', 'device-c')).status, 429);
  assert.equal(f.broker.sessions.size, 2);
});
test('simultaneous creates atomically reserve one user and two total slots', async t => {
  const f = await fixture(t);
  const sameUser = await Promise.all([f.create(), f.create()]);
  assert.deepEqual(sameUser.map(result => result.status).sort(), [200, 409]);
  const otherUsers = await Promise.all([f.create('bob', 'device-b'), f.create('carol', 'device-c')]);
  assert.deepEqual(otherUsers.map(result => result.status).sort(), [200, 429]);
  assert.equal(f.broker.sessions.size, 2);
});
test('grant is single-use and runtime init cannot be supplied again by browser', async t => {
  const f = await fixture(t); const live = await f.run();
  assert.equal((await f.connect(live.grant)).status, 401);
  live.browser.send(JSON.stringify({ type: 'init', run_cpu_time: 999999 }));
  await waitFor(() => f.killed() === 1 && f.broker.sessions.size === 0);
});
test('pending grant expiry returns capacity; connected sessions outlive grant expiry', async t => {
  const f = await fixture(t, { grantMs: 120, idleMs: 1000 });
  await f.create(); await waitFor(() => f.broker.sessions.size === 0);
  const live = await f.run(); await sleep(180);
  assert.equal(live.browser.readyState, WebSocket.OPEN);
  assert.equal(f.jobs.size, 1);
});
for (const [name, message] of [['disconnect', null], ['Stop', { type: 'stop' }],
  ['Ctrl+C', { type: 'data', stream: 'stdin', data: '\u0003' }]]) {
  test(`${name} kills the upstream job before returning the slot`, async t => {
    const f = await fixture(t); const live = await f.run();
    if (message) live.browser.send(JSON.stringify(message)); else live.browser.terminate();
    await waitFor(() => f.killed() === 1 && f.broker.sessions.size === 0);
    assert.equal(f.jobs.size, 0);
    assert.equal((await f.create()).status, 200);
  });
}
test('idle timeout ignores output and empty input', async t => {
  const f = await fixture(t, { idleMs: 160 }); const live = await f.run();
  const output = setInterval(() => {
    if (f.peer()?.readyState === WebSocket.OPEN) f.peer().send(JSON.stringify({ type: 'data', stream: 'stdout', data: 'prompt' }));
    if (live.browser.readyState === WebSocket.OPEN) live.browser.send(JSON.stringify({ type: 'data', stream: 'stdin', data: '' }));
  }, 25);
  t.after(() => clearInterval(output));
  await waitFor(() => f.killed() === 1);
  assert.ok(live.messages.some(message => message.code === 'IDLE_TIMEOUT'));
});
test('wall cap persists despite frequent accepted input', async t => {
  const f = await fixture(t, { wallMs: 220, idleMs: 150 }); const live = await f.run();
  const input = setInterval(() => {
    if (live.browser.readyState === WebSocket.OPEN) live.browser.send(JSON.stringify({ type: 'data', stream: 'stdin', data: '1\n' }));
  }, 25);
  t.after(() => clearInterval(input));
  await waitFor(() => f.killed() === 1);
  assert.ok(live.messages.some(message => message.code === 'WALL_LIMIT'));
});
test('cumulative UTF-8 stdin cap kills without forwarding the oversized chunk', async t => {
  const f = await fixture(t); const live = await f.run();
  live.browser.send(JSON.stringify({ type: 'data', stream: 'stdin', data: '😀'.repeat(4097) }));
  await waitFor(() => f.killed() === 1);
  assert.ok(live.messages.some(message => message.code === 'STDIN_LIMIT'));
});
test('aggregate stdout/stderr cap kills without forwarding excess output', async t => {
  const f = await fixture(t); const live = await f.run();
  f.peer().send(JSON.stringify({ type: 'data', stream: 'stdout', data: 'a'.repeat(40000) }));
  f.peer().send(JSON.stringify({ type: 'data', stream: 'stderr', data: 'b'.repeat(30000) }));
  await waitFor(() => f.killed() === 1);
  assert.ok(live.messages.some(message => message.code === 'OUTPUT_LIMIT'));
  assert.equal(live.messages.filter(message => message.type === 'data').reduce((n, message) => n + Buffer.byteLength(message.data), 0), 40000);
});
test('exam state denies upgrade before an upstream process starts', async t => {
  const f = await fixture(t); const grant = (await f.create()).value; f.denyExam();
  assert.equal((await f.connect(grant)).status, 401);
  await waitFor(() => f.broker.sessions.size === 0);
  assert.equal(f.jobs.size, 0);
});
test('exam barrier cancels pending grants and waits for running job cleanup', async t => {
  const f = await fixture(t); await f.create();
  assert.equal((await f.rpc({ action: 'cancel-user', userId: 'alice' })).status, 200);
  assert.equal(f.broker.sessions.size, 0);
  await f.run();
  assert.equal((await f.rpc({ action: 'cancel-user', userId: 'alice' })).status, 200);
  assert.equal(f.killed(), 1); assert.equal(f.jobs.size, 0); assert.equal(f.broker.sessions.size, 0);
});
test('cancellation while the image is priming waits for job readiness and cleanup acknowledgement', async t => {
  const f = await fixture(t); f.delayPrime(60);
  const grant = (await f.create()).value;
  assert.equal((await f.connect(grant)).status, 101);
  await waitFor(() => [...f.broker.sessions.values()][0]?.initialized);
  assert.equal((await f.rpc({ action: 'cancel-user', userId: 'alice' })).status, 200);
  assert.equal(f.killed(), 1); assert.equal(f.jobs.size, 0); assert.equal(f.broker.sessions.size, 0);
});
test('exam cancellation during asynchronous upgrade cannot activate the cancelled grant', async t => {
  const f = await fixture(t); const grant = (await f.create()).value;
  let resume; f.pause(new Promise(resolve => { resume = resolve; }));
  const opening = f.connect(grant);
  await waitFor(() => [...f.broker.sessions.values()][0]?.state === 'claimed');
  assert.equal((await f.rpc({ action: 'cancel-user', userId: 'alice' })).status, 200);
  resume(); assert.notEqual((await opening).status, 101);
  assert.equal(f.jobs.size, 0); assert.equal(f.broker.sessions.size, 0);
});
test('cross-user cancellation is rejected and cannot kill another terminal', async t => {
  const f = await fixture(t); const live = await f.run();
  assert.equal((await f.rpc({ action: 'cancel', sessionId: live.grant.sessionId, userId: 'bob', authSessionId: 'device-b' })).status, 404);
  assert.equal(f.jobs.size, 1);
});
test('unconfirmed cancellation quarantines capacity and refuses exam acknowledgement', async t => {
  const f = await fixture(t); await f.run(); f.ignoreStop();
  assert.equal((await f.rpc({ action: 'cancel-user', userId: 'alice' })).status, 503);
  assert.equal(f.broker.sessions.size, 1);
  assert.equal((await f.create()).status, 409);
});
test('full interactive registry cannot consume the independent batch execution endpoint', async t => {
  const f = await fixture(t); await f.run();
  const second = (await f.create('bob', 'device-b')).value;
  assert.equal((await f.connect(second, { cookie: 'b' })).status, 101);
  await waitFor(() => f.jobs.size === 2);
  assert.equal((await f.create('carol', 'device-c')).status, 429);
  // A separate batch peer has its own two-slot pool, as the Compose contract
  // requires. No broker admission or upstream connection participates here.
  let batchSlots = 2;
  const batch = createServer(async (request, response) => {
    assert.ok(batchSlots > 0); batchSlots--;
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(request.url, '/api/v2/execute');
    assert.equal(JSON.parse(body).language, 'c');
    response.writeHead(200); response.end(JSON.stringify({
      compile: { code: 0, signal: null, stdout: '', stderr: '', wall_time: 1 },
      run: { code: 0, signal: null, stdout: '3\n', stderr: '', wall_time: 1 },
    }));
    batchSlots++;
  });
  const url = await listen(batch);
  t.after(() => new Promise(resolve => batch.close(resolve)));
  const request = { submissionId: '10000000-0000-4000-8000-000000000001', correlationId: 'practice:batch',
    language: 'c', runtimeVersion: runtimeByLanguage.c.version, mode: 'RUN', entrypoint: 'main.c',
    sourceFiles: [{ path: 'main.c', content: 'int main(){return 0;}' }], stdin: '',
    limits: { wallTimeMs: 5000, memoryMb: 128, outputBytes: 65536, pids: 32, cpuCount: 0.5 } };
  const client = new PistonRunnerClient(url, `codestead-piston@sha256:${'a'.repeat(64)}`);
  const result = await client.submit(request, 'batch-while-interactive-full');
  assert.equal(result.result.status, 'ACCEPTED');
  assert.equal(result.result.run.stdout, '3\n');
  assert.equal(isTrustedRunnerJob(result, request), true);
  assert.equal(f.jobs.size, 2);
  assert.equal(f.broker.sessions.size, 2);
});
