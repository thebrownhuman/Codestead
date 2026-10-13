import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const programs = {
  c: { language: 'c', version: '14.2.0', name: 'main.c', content: '#include <stdio.h>\nint main(void){int a,b;printf("Enter first number:");scanf("%d",&a);printf("Enter second number:");scanf("%d",&b);printf("Result: %d\\n",a+b);return 0;}' },
  cpp: { language: 'c++', version: '14.2.0', name: 'main.cpp', content: '#include <iostream>\nint main(){int a,b;std::cout<<"Enter first number:";std::cin>>a;std::cout<<"Enter second number:";std::cin>>b;std::cout<<"Result: "<<a+b<<"\\n";}' },
  java: { language: 'java', version: '21.0.12', name: 'Main.java', content: 'import java.util.Scanner; public class Main {public static void main(String[] args){Scanner s=new Scanner(System.in);System.out.print("Enter first number:");int a=s.nextInt();System.out.print("Enter second number:");int b=s.nextInt();System.out.println("Result: "+(a+b));}}' },
  python: { language: 'python', version: '3.14.8', name: 'main.py', content: 'a=int(input("Enter first number:"))\nb=int(input("Enter second number:"))\nprint("Result:",a+b)' },
  javascript: { language: 'javascript', version: '22.23.3', name: 'main.js', content: 'const r=require("node:readline").createInterface({input:process.stdin,output:process.stdout});r.question("Enter first number:",a=>r.question("Enter second number:",b=>{console.log("Result:",Number(a)+Number(b));r.close();process.stdin.destroy();}));' },
};

function session(url, program) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/api/v2/connect');
  const messages = [];
  let ended = false;
  let stdinBytes = 0;
  let failure;
  ws.addEventListener('error', () => { failure = new Error('WebSocket transport failed'); });
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'init', language: program.language,
    version: program.version, files: [{ name: program.name, content: program.content }] })));
  ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  ws.addEventListener('close', () => { ended = true; });
  return {
    ws, messages, ended: () => ended,
    stdout: () => messages.filter(message => message.type === 'data' && message.stream === 'stdout').map(message => message.data).join(''),
    outputBytes: () => messages.filter(message => message.type === 'data').reduce((sum, message) => sum + Buffer.byteLength(message.data), 0),
    stdinBytes: () => stdinBytes,
    input(data) { stdinBytes += Buffer.byteLength(data); ws.send(JSON.stringify({ type: 'data', stream: 'stdin', data })); },
    async until(predicate, deadlineMs = 15000) {
      const deadline = Date.now() + deadlineMs;
      while (!predicate()) {
        if (failure) throw failure;
        if (Date.now() >= deadline) throw new Error('Interactive integration deadline exceeded: ' + JSON.stringify({
          stages: messages.filter(message => message.type !== 'data'),
          fixtureOutputTail: messages.filter(message => message.type === 'data').map(message => message.data).join('').slice(-120),
        }));
        await wait(20);
      }
    },
    dispose() { if (ws.readyState < 2) ws.close(); },
  };
}

export async function liveTests(url, countProcesses) {
  const results = [];
  async function check(name, run) {
    await run();
    results.push({ name, passed: true });
  }
  await check('interactive image rejects REST execution and package mutations', async () => {
    for (const [method, endpoint] of [['POST', '/execute'], ['POST', '/packages'], ['DELETE', '/packages']]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(url + '/api/v2' + endpoint, { method, signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            language: 'python', version: '3.14.8', run_cpu_time: 0, files: [{ content: 'while True: pass' }],
          }) });
        assert.equal(response.status, 404, `${method} ${endpoint}`);
      } finally { clearTimeout(timeout); }
    }
  });
  for (const [language, program] of Object.entries(programs)) {
    await check(`${language}: two prompts arrive before their corresponding input`, async () => {
      const s = session(url, program);
      try {
        await s.until(() => s.stdout().includes('Enter first number:') || s.ended());
        assert.ok(s.stdout().includes('Enter first number:'), 'first prompt must precede any stdin');
        assert.equal(s.stdinBytes(), 0);
        assert.equal(s.ended(), false);
        s.input('7\n');
        await s.until(() => s.stdout().includes('Enter second number:') || s.ended());
        assert.ok(s.stdout().includes('Enter second number:'));
        assert.equal(s.stdinBytes(), 2);
        assert.equal(s.ended(), false);
        s.input('8\n');
        await s.until(s.ended);
        assert.ok(s.stdout().includes('Result: 15'));
        assert.ok(s.messages.some(message => message.type === 'exit' && message.stage === 'run' && message.code === 0));
        assert.equal(s.messages.some(message => message.type === 'error'), false);
      } finally { s.dispose(); }
    });
  }
  const python = content => ({ ...programs.python, content });
  await check('EOF closes stdin while preserving buffered input and normal exit', async () => {
    const s = session(url, python('import sys\nprint("READY")\nprint("EOF:"+str(len(sys.stdin.read())))'));
    try {
      await s.until(() => s.stdout().includes('READY'));
      s.input('7\n');
      s.ws.send(JSON.stringify({ type: 'eof' }));
      await s.until(s.ended, 5000);
      assert.ok(s.stdout().includes('EOF:2'));
      assert.ok(s.messages.some(message => message.type === 'exit' && message.stage === 'run' && message.code === 0));
    } finally { s.dispose(); }
  });
  await check('combined stdout/stderr cap terminates the process', async () => {
    const s = session(url, python('import sys,time\nsys.stdout.write("a"*40000);sys.stdout.flush()\nsys.stderr.write("b"*40000);sys.stderr.flush()\ntime.sleep(120)'));
    try {
      await s.until(s.ended, 7000);
      assert.ok(s.messages.some(message => message.code === 'OUTPUT_LIMIT'));
      assert.ok(s.outputBytes() > 0 && s.outputBytes() <= 65536);
    } finally { s.dispose(); }
  });
  await check('stdin UTF-8 byte cap terminates the process', async () => {
    const s = session(url, python('import sys\nprint("READY")\nfor line in sys.stdin: print("received")'));
    try {
      await s.until(() => s.stdout().includes('READY') || s.ended());
      assert.equal(s.ended(), false);
      s.input('é'.repeat(8193));
      await s.until(s.ended, 5000);
      assert.ok(s.messages.some(message => message.code === 'STDIN_LIMIT'));
    } finally { s.dispose(); }
  });
  await check('the run CPU cap stays at three seconds', async () => {
    const s = session(url, python('while True: pass'));
    try {
      await s.until(s.ended, 12000);
      assert.ok(s.messages.some(message => message.type === 'exit' && message.stage === 'run' && message.signal === 'SIGKILL'));
    } finally { s.dispose(); }
  });
  for (const action of ['disconnect', 'stop', 'ctrl-c', 'signal']) {
    await check(`${action}: whole job dies, including a detached child ignoring signals`, async () => {
      const marker = 'interactive-' + randomUUID();
      const content = `import os,sys,signal,time\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid==0:\n os.setsid()\n os.execl(sys.executable,sys.executable,"-c","import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)","${marker}")\nelse:\n print("READY")\n while True: time.sleep(.1)`;
      const s = session(url, { ...python(content), name: marker + '.py' });
      try {
        await s.until(() => s.stdout().includes('READY') || s.ended());
        assert.equal(s.ended(), false);
        const appeared = Date.now() + 4000;
        while (countProcesses(marker) < 2 && Date.now() < appeared) await wait(50);
        assert.ok(countProcesses(marker) >= 2, 'the test must have a live parent and detached child');
        if (action === 'disconnect') s.ws.close();
        else if (action === 'stop') s.ws.send(JSON.stringify({ type: 'stop' }));
        else if (action === 'ctrl-c') s.input('\u0003');
        else s.ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
        await s.until(s.ended, 5000);
        const deadline = Date.now() + 5000;
        while (countProcesses(marker) !== 0 && Date.now() < deadline) await wait(50);
        assert.equal(countProcesses(marker), 0, 'all sandbox descendants must terminate');
      } finally { s.dispose(); }
    });
  }
  await check('cancelled jobs return both slots without disrupting another terminal', async () => {
    const blocked = python('print("READY")\ninput()\nprint("DONE")');
    for (let repeat = 0; repeat < 3; repeat++) {
      const one = session(url, blocked);
      const two = session(url, blocked);
      try {
        await Promise.all([one.until(() => one.stdout().includes('READY')), two.until(() => two.stdout().includes('READY'))]);
        one.ws.send(JSON.stringify({ type: 'stop' }));
        await one.until(one.ended, 5000);
        assert.equal(two.ended(), false);
        const next = session(url, blocked);
        try {
          await next.until(() => next.stdout().includes('READY'), 5000);
          two.input('\n'); next.input('\n');
          await Promise.all([two.until(two.ended), next.until(next.ended)]);
          assert.ok(two.stdout().includes('DONE') && next.stdout().includes('DONE'));
        } finally { next.dispose(); }
      } finally { one.dispose(); two.dispose(); }
    }
  });
  return results;
}
