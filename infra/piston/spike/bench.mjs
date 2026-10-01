// Throwaway spike: latency + correctness + containment of one Piston endpoint.
const [port, label] = process.argv.slice(2);
const url = `http://127.0.0.1:${port}/api/v2/execute`;
const P = {
  c: ["c", "10.2.0", "main.c", {
    hello: `#include <stdio.h>\nint main(){puts("hello");return 0;}`,
    echo: `#include <stdio.h>\nint main(){char b[256];while(fgets(b,256,stdin))fputs(b,stdout);return 0;}`,
    cerr: `int main(){ return x; }`,
    inf: `int main(){for(;;);}`,
    mem: `#include <stdlib.h>\n#include <string.h>\nint main(){for(;;){char*p=malloc(1<<20);if(!p)return 3;memset(p,1,1<<20);}}`,
    fork: `#include <unistd.h>\n#include <stdio.h>\nint main(){int n=0;for(int i=0;i<10000;i++){if(fork()<0){printf("fork failed after %d\\n",n);return 4;}n++;}puts("unbounded");return 0;}`,
  }],
  java: ["java", "15.0.2", "Main.java", {
    hello: `public class Main{public static void main(String[] a){System.out.println("hello");}}`,
    echo: `import java.io.*;public class Main{public static void main(String[] a)throws Exception{BufferedReader r=new BufferedReader(new InputStreamReader(System.in));String l;while((l=r.readLine())!=null)System.out.println(l);}}`,
    mem: `import java.util.*;public class Main{public static void main(String[] a){List<byte[]> l=new ArrayList<>();while(true)l.add(new byte[1<<20]);}}`,
  }],
  python: ["python", "3.12.0", "main.py", {
    hello: `print("hello")`,
    echo: `import sys\nfor l in sys.stdin: sys.stdout.write(l)`,
    net: `import socket\ntry:\n  socket.create_connection(("1.1.1.1",53),2);print("NET OPEN")\nexcept Exception as e: print("net blocked:",e)`,
    inf: `while True: pass`,
    mem: `l=[]\nwhile True: l.append(bytearray(1<<20))`,
  }],
};
async function run(lang, kind) {
  const [language, version, name, programs] = P[lang];
  const t = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ language, version, files: [{ name, content: programs[kind] }], stdin: "a\nb\n" }) });
  const j = await res.json();
  const ms = Math.round(performance.now() - t);
  const r = j.run ?? {}, c = j.compile;
  return { ms, code: c?.code ? `compile:${c.code}` : r.code, status: r.status ?? "", out: (r.stdout ?? "").trim().slice(0, 30) };
}
if (label === "load") {
  await Promise.all([run("c", "hello"), run("java", "hello"), run("python", "hello")]);
  process.exit(0);
}
const p = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
for (const [lang, [, , , programs]] of Object.entries(P)) {
  for (const kind of Object.keys(programs)) {
    const n = kind === "hello" || kind === "echo" ? 10 : 1;
    const times = []; let first;
    for (let i = 0; i < n; i++) { const r = await run(lang, kind); times.push(r.ms); first ??= r; }
    console.log(`${label} ${lang} ${kind} first=${times[0]} p50=${p(times, 0.5)} p95=${p(times, 0.95)} code=${first.code} status=${first.status} out=${JSON.stringify(first.out)}`);
  }
}
