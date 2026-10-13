import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const LIMITS = Object.freeze({
    sourceBytes: 131072, stdinBytes: 16384, frameBytes: 143360,
    outputBytes: 65536, wallMs: 300000, cpuMs: 3000,
    compileMs: 10000, memoryBytes: 134217728,
    compileMemoryBytes: 536870912, bufferedBytes: 131072,
});
const LANGUAGES = new Set(['c', 'c++', 'java', 'python', 'javascript']);

function inputForJob(message) {
    const keys = ['type', 'language', 'version', 'files'];
    if (!message || Object.keys(message).some(key => !keys.includes(key))
        || !LANGUAGES.has(message.language) || typeof message.version !== 'string'
        || !Array.isArray(message.files) || message.files.length < 1 || message.files.length > 8) {
        throw new Error('INVALID_INIT');
    }
    let bytes = 0;
    for (const file of message.files) {
        if (!file || Object.keys(file).some(key => !['name', 'content'].includes(key))
            || typeof file.name !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(file.name)
            || file.name === '.' || file.name === '..' || typeof file.content !== 'string') {
            throw new Error('INVALID_SOURCE');
        }
        bytes += Buffer.byteLength(file.content);
    }
    if (bytes < 1 || bytes > LIMITS.sourceBytes) throw new Error('SOURCE_LIMIT');
    return {
        language: message.language, version: message.version, files: message.files,
        args: [], stdin: '', run_timeout: LIMITS.wallMs, run_cpu_time: LIMITS.cpuMs,
        compile_timeout: LIMITS.compileMs, compile_cpu_time: LIMITS.compileMs,
        run_memory_limit: LIMITS.memoryBytes, compile_memory_limit: LIMITS.compileMemoryBytes,
    };
}

function connect(ws, getJob) {
    const events = new EventEmitter();
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let job;
    let initialized = false;
    let cancelled = false;
    let outputBytes = 0;
    let forwardedBytes = 0;
    let stdinBytes = 0;
    let stdinClosed = false;
    let stage;
    let wallTimer;
    const send = message => {
        if (ws.readyState !== 1) return;
        const encoded = JSON.stringify(message);
        if (ws.bufferedAmount + Buffer.byteLength(encoded) > LIMITS.bufferedBytes) return cancel('SLOW_CONSUMER');
        try { ws.send(encoded); } catch { cancel('DISCONNECTED'); }
    };
    function cancel(reason) {
        if (cancelled) return;
        cancelled = true;
        job?.cancel();
        // Only fixed reason codes are exposed; never raw isolate exceptions.
        if (reason !== 'DISCONNECTED' && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'error', code: reason })); } catch { /* closed */ }
        }
    }
    function sendData(stream, data) {
        forwardedBytes += Buffer.byteLength(data);
        if (forwardedBytes > LIMITS.outputBytes) return cancel('OUTPUT_LIMIT');
        if (data) send({ type: 'data', stream, data });
    }
    for (const stream of ['stdout', 'stderr']) {
        events.on(stream, bytes => {
            if (cancelled) return;
            outputBytes += bytes.length;
            if (outputBytes > LIMITS.outputBytes) return cancel('OUTPUT_LIMIT');
            const data = decoders[stream].write(bytes);
            sendData(stream, data);
        });
    }
    events.on('stage', value => {
        stage = value;
        send({ type: 'stage', stage });
    });
    events.on('exit', (value, result) => {
        for (const stream of ['stdout', 'stderr']) {
            const data = decoders[stream].end();
            if (!cancelled) sendData(stream, data);
            decoders[stream] = new StringDecoder('utf8');
        }
        send({ type: 'exit', stage: value, ...result });
    });
    const initializeTimer = setTimeout(() => {
        cancel('INITIALIZATION_TIMEOUT');
        ws.close(4001, 'INITIALIZATION_TIMEOUT');
    }, 1000);
    initializeTimer.unref?.();
    ws.on('close', () => cancel('DISCONNECTED'));
    ws.on('error', () => cancel('DISCONNECTED'));
    ws.on('message', async (raw, binary) => {
        try {
            if (binary || (typeof raw !== 'string' && !(Buffer.isBuffer(raw) && binary === false))
                || Buffer.byteLength(raw) > LIMITS.frameBytes) {
                throw new Error('INVALID_FRAME');
            }
            const message = JSON.parse(raw.toString());
            if (message.type === 'init') {
                if (initialized || cancelled) throw new Error('ALREADY_INITIALIZED');
                initialized = true;
                clearTimeout(initializeTimer);
                const input = inputForJob(message);
                wallTimer = setTimeout(() => cancel('WALL_LIMIT'), LIMITS.wallMs);
                wallTimer.unref?.();
                try {
                    job = await getJob(input);
                    if (cancelled) job.cancel();
                    const box = await job.prime();
                    if (cancelled) throw new Error('CANCELLED');
                    send({ type: 'runtime', language: job.runtime.language, version: job.runtime.version.raw });
                    await job.execute(box, events);
                } catch {
                    if (!cancelled) cancel('EXECUTION_FAILED');
                } finally {
                    clearTimeout(wallTimer);
                    try { await job?.cleanup(); }
                    catch {
                        cancelled = true;
                        send({ type: 'error', code: 'CLEANUP_FAILED' });
                    }
                    clearTimeout(initializeTimer);
                    if (ws.readyState === 1) ws.close(cancelled ? 4000 : 4999, cancelled ? 'JOB_CANCELLED' : 'Job Completed');
                }
                return;
            }
            if (!job || cancelled) throw new Error('NOT_RUNNING');
            if (message.type === 'stop'
                || (message.type === 'signal' && message.signal === 'SIGINT')) {
                cancel('STOPPED');
                return;
            }
            if (message.type === 'eof' && Object.keys(message).length === 1 && stage === 'run' && !stdinClosed) {
                stdinClosed = true;
                events.emit('stdin_end');
                return;
            }
            if (message.type !== 'data' || message.stream !== 'stdin' || typeof message.data !== 'string'
                || Object.keys(message).some(key => !['type', 'stream', 'data'].includes(key))
                || stage !== 'run' || stdinClosed) throw new Error('INVALID_STDIN');
            if (message.data.includes('\u0003')) return cancel('STOPPED');
            stdinBytes += Buffer.byteLength(message.data);
            if (stdinBytes > LIMITS.stdinBytes) return cancel('STDIN_LIMIT');
            events.emit('stdin', message.data);
        } catch {
            cancel('PROTOCOL_ERROR');
            // No isolate exists until init. Close invalid uninitialized peers immediately.
            if (!job && ws.readyState === 1) ws.close(4002, 'PROTOCOL_ERROR');
        }
    });
    return { cancel };
}

export { LIMITS, inputForJob, connect };
