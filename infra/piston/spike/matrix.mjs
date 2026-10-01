// Throwaway spike: per-language latency for one Piston endpoint.
// usage: node matrix.mjs <baseUrl> <label>
const [base, label] = process.argv.slice(2);
const url = `${base}/api/v2/execute`;
const programs = {
  c: ["c", "10.2.0", "main.c", `#include <stdio.h>\nint main(){char b[64];if(fgets(b,64,stdin))fputs(b,stdout);puts("hello");return 0;}`],
  cpp: ["c++", "10.2.0", "main.cpp", `#include <iostream>\n#include <string>\nint main(){std::string l;std::getline(std::cin,l);std::cout<<l<<"\\nhello\\n";}`],
  java: ["java", "15.0.2", "Main.java", `import java.util.*;public class Main{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.println(s.nextLine());System.out.println("hello");}}`],
  python: ["python", "3.12.0", "main.py", `print(input())\nprint("hello")`],
  javascript: ["javascript", "20.11.1", "main.js", `const l=require("fs").readFileSync(0,"utf8").split("\\n")[0];console.log(l);console.log("hello");`],
};
async function once(lang) {
  const [language, version, name, content] = programs[lang];
  const t = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ language, version, files: [{ name, content }], stdin: "x\n" }) });
  const j = await res.json();
  return { ms: performance.now() - t, ok: (j.run?.stdout ?? "") === "x\nhello\n", err: j.message ?? j.run?.stderr ?? j.compile?.stderr };
}
const pct = (a, q) => Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]);
for (const lang of Object.keys(programs)) {
  const times = []; let bad;
  for (let i = 0; i < 12; i++) { const r = await once(lang); times.push(r.ms); if (!r.ok) bad ??= String(r.err).slice(0, 120); }
  console.log(`MATRIX ${label} ${lang} first=${Math.round(times[0])} p50=${pct(times.slice(2), 0.5)} p95=${pct(times.slice(2), 0.95)}${bad ? " FAIL " + bad : ""}`);
}
