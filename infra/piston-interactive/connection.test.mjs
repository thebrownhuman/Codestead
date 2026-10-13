import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { connect, inputForJob, LIMITS } from './connection.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
const init = { type: 'init', language: 'python', version: '3.14.8', files: [{ name: 'main.py', content: 'print(1)' }] };

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages = [];
  send(message) { this.messages.push(JSON.parse(message)); }
  close() { this.readyState = 3; this.emit('close'); }
  input(message) { this.emit('message', JSON.stringify(message)); }
}
async function fixture() {
  const ws = new Socket();
  let events;
  let finish;
  let cancelled = 0;
  let cleaned = 0;
  const job = {
    runtime: { language: 'python', version: { raw: '3.14.8' } },
    prime: async () => ({}),
    execute: async (_, bus) => {
      events = bus;
      bus.emit('stage', 'run');
      await new Promise(resolve => { finish = resolve; });
    },
    cancel: () => { cancelled++; finish?.(); },
    cleanup: async () => { cleaned++; },
  };
  connect(ws, async () => job);
  ws.input(init);
  await turn();
  return { ws, job, events, finish, cancelled: () => cancelled, cleaned: () => cleaned };
}

test('init fixes wall, CPU and memory caps; rejects caller overrides, traversal and source bytes', () => {
  const input = inputForJob(init);
  assert.equal(input.run_timeout, 300000);
  assert.equal(input.run_cpu_time, 3000);
  assert.equal(input.compile_timeout, 10000);
  assert.equal(input.run_memory_limit, 134217728);
  for (const bad of [{ ...init, run_cpu_time: 0 }, { ...init, args: ['unsafe'] },
    { ...init, files: [{ name: '../main.py', content: 'a' }] },
    { ...init, files: [{ name: 'main.py', content: '😀'.repeat(32769) }] }]) {
    assert.throws(() => inputForJob(bad));
  }
});

test('combined stdout/stderr byte cap cancels without forwarding the overflowing chunk', async () => {
  const f = await fixture();
  f.events.emit('stdout', Buffer.alloc(LIMITS.outputBytes - 1, 65));
  f.events.emit('stderr', Buffer.from('é'));
  await turn();
  assert.equal(f.cancelled(), 1);
  assert.equal(f.cleaned(), 1);
  assert.ok(f.ws.messages.some(message => message.code === 'OUTPUT_LIMIT'));
  assert.equal(f.ws.messages.filter(message => message.type === 'data').reduce((sum, message) => sum + Buffer.byteLength(message.data), 0), LIMITS.outputBytes - 1);
});

test('split UTF-8 output stays intact and stdin is counted in bytes', async () => {
  const f = await fixture();
  const bytes = Buffer.from('😀');
  f.events.emit('stdout', bytes.subarray(0, 2));
  f.events.emit('stdout', bytes.subarray(2));
  assert.equal(f.ws.messages.filter(message => message.type === 'data').map(message => message.data).join(''), '😀');
  let received = '';
  f.events.on('stdin', input => { received += input; });
  f.ws.input({ type: 'data', stream: 'stdin', data: 'é' });
  assert.equal(received, 'é');
  f.ws.input({ type: 'data', stream: 'stdin', data: 'é'.repeat(8192) });
  await turn();
  assert.equal(f.cancelled(), 1);
  assert.ok(f.ws.messages.some(message => message.code === 'STDIN_LIMIT'));
});

test('invalid UTF-8 cannot amplify forwarded output beyond the byte cap', async () => {
  const f = await fixture();
  f.events.emit('stdout', Buffer.alloc(30000, 255));
  await turn();
  assert.equal(f.cancelled(), 1);
  assert.ok(f.ws.messages.some(message => message.code === 'OUTPUT_LIMIT'));
  assert.equal(f.ws.messages.filter(message => message.type === 'data').length, 0);
});

test('EOF closes only the run input; later writes cannot reach the process', async () => {
  const f = await fixture();
  let eof = 0;
  let writes = 0;
  f.events.on('stdin_end', () => eof++);
  f.events.on('stdin', () => writes++);
  f.ws.input({ type: 'eof' });
  assert.equal(eof, 1);
  assert.equal(f.cancelled(), 0);
  f.ws.input({ type: 'data', stream: 'stdin', data: 'late' });
  await turn();
  assert.equal(writes, 0);
  assert.equal(f.cancelled(), 1);
});

test('JSON escaping is charged before send so one frame cannot exceed the send buffer cap', async () => {
  const f = await fixture();
  f.events.emit('stdout', Buffer.alloc(30000, 0));
  await turn();
  assert.equal(f.cancelled(), 1);
  assert.ok(f.ws.messages.some(message => message.code === 'SLOW_CONSUMER'));
  assert.equal(f.ws.messages.filter(message => message.type === 'data').length, 0);
});

test('Stop, Ctrl+C, signal, disconnect and socket error cancel once and finish cleanup', async () => {
  for (const action of [ws => ws.input({ type: 'stop' }),
    ws => ws.input({ type: 'data', stream: 'stdin', data: '\u0003' }),
    ws => ws.input({ type: 'signal', signal: 'SIGINT' }),
    ws => ws.close(), ws => ws.emit('error', new Error('socket failure'))]) {
    const f = await fixture();
    action(f.ws);
    await turn();
    assert.equal(f.cancelled(), 1);
    assert.equal(f.cleaned(), 1);
  }
});

test('disconnect during asynchronous initialization never executes the job', async () => {
  const ws = new Socket();
  let provide;
  let cancelled = false;
  let cleaned = false;
  let executed = false;
  connect(ws, () => new Promise(resolve => { provide = resolve; }));
  ws.input(init);
  ws.close();
  provide({ cancel: () => { cancelled = true; }, prime: async () => { if (cancelled) throw new Error('cancelled'); },
    execute: async () => { executed = true; }, cleanup: async () => { cleaned = true; } });
  await turn();
  assert.equal(cancelled, true);
  assert.equal(cleaned, true);
  assert.equal(executed, false);
});

test('second init, slow consumers and malformed frames terminate rather than allocate another job', async () => {
  for (const action of [f => f.ws.input(init),
    f => { f.ws.bufferedAmount = LIMITS.bufferedBytes + 1; f.events.emit('stdout', Buffer.from('data')); },
    f => f.ws.emit('message', '{'),
    f => f.ws.emit('message', Buffer.from('{}'), true)]) {
    const f = await fixture();
    action(f);
    await turn();
    assert.equal(f.cancelled(), 1);
    assert.equal(f.cleaned(), 1);
  }
});
