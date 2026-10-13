import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const upstreamHashes = Object.freeze({
  'job.js': '163a68e17bc577eaf165391f460b976a6555105351b1658f86d331bc12eccd24',
  'api/v2.js': 'f7b155d34b3ba7d48358334a0c4c7497c518e09ab58a186040050f1652d99c48',
  'index.js': 'a94d1bd65af2a8bec2f3c3181b4eda63b20228565e98a87e274b6361c3c52d9b',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function replaceExactly(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Pinned patch context drifted');
  return source.replace(before, after);
}

export function patchJob(source) {
  source = replaceExactly(source, 'const get_next_box_id = () => ++box_id % MAX_BOX_ID;', `const active_box_ids = new Set();
const get_next_box_id = () => {
    for (let attempt = 0; attempt < MAX_BOX_ID; attempt++) {
        const candidate = ++box_id % MAX_BOX_ID;
        if (!active_box_ids.has(candidate)) {
            active_box_ids.add(candidate);
            return candidate;
        }
    }
    throw new Error('No unused sandbox ID');
};`);
  source = replaceExactly(source, '                    if (error) {\n                        rej(',
    '                    if (error) {\n                        active_box_ids.delete(box_id);\n                        return rej(');
  source = replaceExactly(source, "                        rej('Received empty stdout from isolate --init');",
    "                        active_box_ids.delete(box_id);\n                        return rej('Received empty stdout from isolate --init');");
  source = replaceExactly(source, '        this.#dirty_boxes = [];', `        this.#dirty_boxes = [];
        this.cancelled = false;
        this.slot_acquired = false;
        this.live_process = null;
        this.pending_start = null;
        this.cleanup_result = null;`);
  const start = source.indexOf('    async prime() {');
  const end = source.indexOf("        this.logger.debug('Running isolate --init');", start);
  if (start < 0 || end < start) throw new Error('Prime context drifted');
  source = source.slice(0, start) + `    cancel() {
        this.cancelled = true;
        if (this.pending_start) {
            const index = job_queue.indexOf(this.pending_start.start);
            if (index >= 0) job_queue.splice(index, 1);
            this.pending_start.reject(new Error('Interactive job cancelled'));
            this.pending_start = null;
        }
        // SIGTERM to the isolate supervisor makes isolate SIGKILL its sandbox
        // process group and cgroup, including descendants which ignore SIGINT.
        this.live_process?.kill('SIGTERM');
    }
    async prime() {
        if (this.cancelled) throw new Error('Interactive job cancelled');
        if (remaining_job_spaces < 1) {
            await new Promise((resolve, reject) => {
                const start = () => {
                    this.pending_start = null;
                    remaining_job_spaces--;
                    this.slot_acquired = true;
                    resolve();
                };
                this.pending_start = { start, reject };
                job_queue.push(start);
            });
        } else {
            remaining_job_spaces--;
            this.slot_acquired = true;
        }
        if (this.cancelled) throw new Error('Interactive job cancelled');
` + source.slice(end);
  source = replaceExactly(source, "        let stdout = '';", "        if (this.cancelled) throw new Error('Interactive job cancelled');\n        let stdout = '';");
  const stdinStart = source.indexOf('        if (event_bus === null) {');
  const stdinEnd = source.indexOf("        proc.stderr.on('data'", stdinStart);
  if (stdinStart < 0 || stdinEnd < stdinStart) throw new Error('Stdin context drifted');
  source = source.slice(0, stdinStart) + `        this.live_process = proc;
        proc.stdin.on('error', () => this.cancel());
        if (event_bus === null) {
            proc.stdin.end(this.stdin);
        } else {
            const input = data => { if (!this.cancelled && !proc.stdin.destroyed) proc.stdin.write(data); };
            const endInput = () => { if (!proc.stdin.destroyed) proc.stdin.end(); };
            event_bus.on('stdin', input);
            event_bus.on('stdin_end', endInput);
            proc.once('close', () => {
                event_bus.removeListener('stdin', input);
                event_bus.removeListener('stdin_end', endInput);
            });
        }
        proc.once('close', () => { if (this.live_process === proc) this.live_process = null; });
        if (this.cancelled) proc.kill('SIGTERM');
` + source.slice(stdinEnd);
  source = replaceExactly(source, "            proc.on('exit', (_, signal) => {", "            proc.on('close', (_, signal) => {");
  const cleanupStart = source.indexOf('    async cleanup() {');
  const classEnd = source.lastIndexOf('\n}\n');
  if (cleanupStart < 0 || classEnd < cleanupStart) throw new Error('Cleanup context drifted');
  source = source.slice(0, cleanupStart) + `    async cleanup() {
        if (this.cleanup_result) return this.cleanup_result;
        this.cleanup_result = (async () => {
            await Promise.all(this.#dirty_boxes.map(async box => {
                await new Promise((resolve, reject) => {
                    cp.exec('isolate --cleanup --cg -b' + box.id, error => error ? reject(error) : resolve());
                });
                try { await fs.rm(box.metadata_file_path); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                active_box_ids.delete(box.id);
            }));
            // Never advertise capacity before sandbox teardown has finished.
            if (this.slot_acquired) {
                this.slot_acquired = false;
                remaining_job_spaces++;
                if (job_queue.length > 0) job_queue.shift()();
            }
        })();
        return this.cleanup_result;
    }
` + source.slice(classEnd);
  return source;
}

export async function applyPatch(root, packageRoot, moduleFile) {
  const originals = {};
  for (const [file, expected] of Object.entries(upstreamHashes)) {
    const bytes = await readFile(path.join(root, file));
    if (hash(bytes) !== expected) throw new Error(`Unreviewed upstream source: ${file}`);
    originals[file] = bytes.toString('utf8');
  }
  const v2 = originals['api/v2.js'];
  const begin = v2.indexOf("router.ws('/connect'");
  const end = v2.indexOf("router.post('/execute'", begin);
  if (begin < 0 || end < begin) throw new Error('WebSocket route context drifted');
  let interactiveRoutes = v2.slice(0, begin) + "router.ws('/connect', ws => require('../interactive-connection.mjs').connect(ws, get_job));\n\n" + v2.slice(end);
  const executeStart = interactiveRoutes.indexOf("router.post('/execute'");
  const inventoryStart = interactiveRoutes.indexOf("router.get('/runtimes'", executeStart);
  if (executeStart < 0 || inventoryStart < executeStart) throw new Error('Execution route context drifted');
  interactiveRoutes = interactiveRoutes.slice(0, executeStart)
    + "router.post('/execute', (_req, res) => res.status(404).end());\n"
    + interactiveRoutes.slice(inventoryStart);
  const mutationsStart = interactiveRoutes.indexOf("router.post('/packages'");
  const exportStart = interactiveRoutes.indexOf('module.exports = router;', mutationsStart);
  if (mutationsStart < 0 || exportStart < mutationsStart) throw new Error('Package route context drifted');
  interactiveRoutes = interactiveRoutes.slice(0, mutationsStart)
    + "router.post('/packages', (_req, res) => res.status(404).end());\n"
    + "router.delete('/packages', (_req, res) => res.status(404).end());\n\n"
    + interactiveRoutes.slice(exportStart);
  const patched = {
    'job.js': patchJob(originals['job.js']),
    'api/v2.js': interactiveRoutes,
    'index.js': replaceExactly(replaceExactly(originals['index.js'],
      "const Logger = require('logplease');", "const Logger = require('logplease');\nLogger.setLogLevel('ERROR');"), 'expressWs(app);',
      'expressWs(app, null, { wsOptions: { maxPayload: 143360, perMessageDeflate: false } });'),
  };
  const wrappers = {
    'gcc/14.2.0/run': ['shift; exec ./program "$@"', 'shift; exec /usr/bin/stdbuf -o0 -e0 ./program "$@"'],
    'python/3.14.8/run': ['exec /usr/local/bin/python3 -I -B "$@"', 'exec /usr/local/bin/python3 -u -I -B "$@"'],
  };
  // Validate all inputs before replacing any source.
  const runs = {};
  for (const [file, [before, after]] of Object.entries(wrappers)) {
    runs[file] = replaceExactly(await readFile(path.join(packageRoot, file), 'utf8'), before, after);
  }
  for (const [file, text] of Object.entries(patched)) await writeFile(path.join(root, file), text);
  for (const [file, text] of Object.entries(runs)) await writeFile(path.join(packageRoot, file), text);
  await copyFile(moduleFile, path.join(root, 'interactive-connection.mjs'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: patch.mjs <api-src> <packages> <connection-module>');
  await applyPatch(...process.argv.slice(2));
}
