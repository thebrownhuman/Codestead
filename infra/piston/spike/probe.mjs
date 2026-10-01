// Throwaway spike: containment probe run as a learner submission.
const [port, label] = process.argv.slice(2);
const code = `
import os, platform, socket
print("kernel", platform.release())
print("uid", os.getuid(), "caps", open("/proc/self/status").read().split("CapEff:")[1].split()[0])
print("meminfo", open("/proc/meminfo").readline().strip())
print("dev", sorted(os.listdir("/dev")))
try:
  socket.create_connection(("1.1.1.1", 53), 2); print("NET OPEN")
except Exception as e: print("net blocked:", e)
for p in ["/", "/etc", "/piston/packages"]:
  try: open(p + "/x_probe", "w").write("x"); print("WRITABLE", p)
  except Exception as e: print("ro", p, type(e).__name__)
print("pids visible", len([d for d in os.listdir("/proc") if d.isdigit()]))
`;
const res = await fetch(`http://127.0.0.1:${port}/api/v2/execute`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ language: "python", version: "3.12.0", files: [{ name: "main.py", content: code }] }),
});
const j = await res.json();
for (const line of (j.run?.stdout ?? "").trim().split("\n")) console.log(`probe ${label}: ${line}`);
if (j.run?.stderr) console.log(`probe ${label} stderr: ${j.run.stderr.slice(0, 300)}`);
