// Disposable Docker Desktop/CI only; never a deployment or Kata configuration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createBroker } from './server.mjs';
import { bodyHash, practiceInput, signEnvelope, SOCKET_PROTOCOL, verifyEnvelope } from '../../src/lib/runner/interactive-protocol.mjs';
import { PistonRunnerClient } from '../../src/lib/runner/piston-client.ts';
import { isTrustedRunnerJob, runtimeByLanguage } from '../../src/lib/runner/client.ts';

const [interactiveImage, batchImage] = process.argv.slice(2);
if (!interactiveImage || !batchImage || process.argv.length !== 4) throw new Error('Usage: node --import tsx test-image.mjs <interactive-image> <batch-image>');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
if (docker('info', '--format', '{{.OperatingSystem}}') !== 'Docker Desktop'
  && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) {
  throw new Error('DISPOSABLE_DOCKER_REQUIRED');
}
const runtimes = JSON.parse(readFileSync('infra/piston/image-inputs.lock.json')).runtimes;
const names = [];
let broker, app;
const secret = randomBytes(32).toString('hex');
let brokerUrl;
const origin = 'https://live-contract.test';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'live condition deadline'); await sleep(10); }
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function start(image, kind) {
  const name = `codestead-broker-live-${kind}-${process.pid}`;
  docker('run', '-d', '--name', name, '--privileged', '--cgroupns=private', '--read-only',
    '-p', '127.0.0.1::2000', '--tmpfs', '/piston/jobs', '--tmpfs', '/tmp:exec',
    '--tmpfs', '/var/local/lib/isolate:exec', '--tmpfs', '/run/isolate:rw,noexec,nosuid,nodev,size=8m',
    '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
    '-e', 'PISTON_DISABLE_NETWORKING=true', '-e', 'PISTON_LOG_LEVEL=ERROR',
    '-e', 'PISTON_MAX_CONCURRENT_JOBS=2', '-e', 'PISTON_RUN_TIMEOUT=300000',
    '-e', 'PISTON_RUN_CPU_TIME=3000', '-e', 'PISTON_OUTPUT_MAX_SIZE=65536', image);
  names.push(name);
  const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['2000/tcp'][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let retry = 0; retry < 60; retry++) {
    try {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 2000);
      try { ready = (await fetch(url + '/api/v2/runtimes', { signal: controller.signal })).ok; }
      finally { clearTimeout(timeout); }
      if (ready) break;
    } catch { /* bounded startup; no response or exception logs */ }
    await sleep(250);
  }
  assert.equal(ready, true);
  return { name, url };
}
async function rpc(payload) {
  const body = JSON.stringify(payload);
  const proof = signEnvelope(secret, 'control', { method: 'POST', path: '/control', bodyHash: bodyHash(body) });
  return fetch(brokerUrl + '/control', { method: 'POST', body, headers: { 'x-interactive-proof': proof } });
}
async function open(language, source, userId = randomUUID()) {
  const response = await rpc({ action: 'create', userId, authSessionId: userId, origin,
    init: practiceInput({ mode: 'practice', language, source }, runtimes) });
  assert.equal(response.status, 200);
  const grant = await response.json();
  const messages = [];
  const socket = new WebSocket(brokerUrl.replace('http:', 'ws:') + grant.socketPath,
    [SOCKET_PROTOCOL, `grant.${grant.grant}`], { headers: { origin, cookie: userId } });
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new Error('LIVE_UPGRADE_FAILED'))); });
  return { socket, messages, userId, grant, output: () => messages.filter(message => message.type === 'data').map(message => message.data).join('') };
}
const programs = {
  c: '#include <stdio.h>\nint main(){int a,b;printf("first:");scanf("%d",&a);printf("second:");scanf("%d",&b);printf("sum=%d\\n",a+b);}',
  cpp: '#include <iostream>\nint main(){int a,b;std::cout<<"first:";std::cin>>a;std::cout<<"second:";std::cin>>b;std::cout<<"sum="<<a+b<<"\\n";}',
  java: 'import java.util.Scanner;public class Main{public static void main(String[] args){Scanner s=new Scanner(System.in);System.out.print("first:");int a=s.nextInt();System.out.print("second:");int b=s.nextInt();System.out.println("sum="+(a+b));}}',
  python: 'a=int(input("first:"));b=int(input("second:"));print("sum="+str(a+b))',
  javascript: 'const r=require("readline").createInterface({input:process.stdin});process.stdout.write("first:");let a;r.on("line",s=>{if(a===undefined){a=Number(s);process.stdout.write("second:");}else{console.log("sum="+(a+Number(s)));r.close();process.stdin.destroy();}});',
};
try {
  const interactive = await start(interactiveImage, 'interactive');
  const batch = await start(batchImage, 'batch');
  app = createServer(async (request, response) => {
    try {
      const proof = verifyEnvelope(secret, 'authorize', request.headers['x-interactive-proof']);
      assert.equal(proof.userId, request.headers.cookie); assert.equal(proof.authSessionId, request.headers.cookie);
      if (proof.action === 'activate') {
        const result = await rpc({ action: 'activate', sessionId: proof.sessionId, userId: proof.userId, authSessionId: proof.authSessionId });
        assert.equal(result.status, 200);
      }
      response.writeHead(204); response.end();
    } catch { response.writeHead(401); response.end(); }
  });
  const appUrl = await listen(app);
  broker = createBroker({ enabled: true, origin, secret, appUrl, runtimes,
    upstreamUrl: interactive.url.replace('http:', 'ws:') + '/api/v2/connect' });
  brokerUrl = await listen(broker.server);
  for (const [language, source] of Object.entries(programs)) {
    const run = await open(language, source);
    await until(() => run.output().includes('first:'));
    assert.ok(!run.output().includes('second:'), `${language}: input must precede second prompt`);
    run.socket.send(JSON.stringify({ type: 'data', stream: 'stdin', data: '12\n' }));
    await until(() => run.output().includes('second:'));
    assert.ok(!run.output().includes('sum='), `${language}: input must precede result`);
    run.socket.send(JSON.stringify({ type: 'data', stream: 'stdin', data: '5\n' }));
    await until(() => broker.sessions.size === 0);
    assert.ok(run.output().includes('sum=17'));
    assert.ok(run.messages.some(message => message.type === 'exit' && message.stage === 'run' && message.code === 0));
  }
  const holders = await Promise.all([open('python', 'input("held:")'), open('python', 'input("held:")')]);
  await until(() => holders.every(run => run.output().includes('held:')));
  const batchClient = new PistonRunnerClient(batch.url, batchImage);
  const request = { submissionId: randomUUID(), correlationId: 'practice:live-batch', language: 'c', mode: 'RUN',
    runtimeVersion: runtimeByLanguage.c.version, entrypoint: 'main.c', stdin: '',
    sourceFiles: [{ path: 'main.c', content: '#include <stdio.h>\nint main(){puts("batch-ready");}' }],
    limits: { wallTimeMs: 5000, memoryMb: 128, outputBytes: 65536, pids: 32, cpuCount: 0.5 } };
  const result = await batchClient.submit(request, 'live-batch-separate-slots');
  assert.equal(isTrustedRunnerJob(result, request), true);
  assert.equal(result.result.status, 'ACCEPTED'); assert.equal(result.result.run.stdout, 'batch-ready\n');
  assert.equal(broker.sessions.size, 2);
  for (const run of holders) {
    const stopped = await rpc({ action: 'cancel-user', userId: run.userId });
    assert.equal(stopped.status, 200);
  }
  assert.equal(broker.sessions.size, 0);
  const marker = `broker_child_${randomUUID().replaceAll('-', '')}`;
  const source = `import os,sys,signal\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid==0:\n os.setsid()\n os.execl(sys.executable,sys.executable,"-c","import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(300)","${marker}")\nelse:\n input("parent:")`;
  const run = await open('python', source);
  await until(() => run.output().includes('parent:'));
  const count = () => Number(docker('exec', interactive.name, 'node', '-e',
    'const fs=require("fs");let n=0;for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p)||Number(p)===process.pid)continue;try{if(fs.readFileSync("/proc/"+p+"/cmdline").includes(process.argv[1]))n++;}catch{}}process.stdout.write(String(n));', marker));
  await until(() => count() > 0);
  run.socket.terminate(); await until(() => broker.sessions.size === 0 && count() === 0);
} catch (error) {
  for (const name of names) process.stderr.write(docker('logs', '--tail', '40', name));
  throw error;
} finally {
  await broker?.close();
  if (app) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  for (const name of names) docker('rm', '-f', name);
}
