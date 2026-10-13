import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const LIMITS = Object.freeze({ slots: 2, grantMs: 30000, idleMs: 60000,
  wallMs: 300000, sourceBytes: 131072, stdinBytes: 16384, outputBytes: 65536,
  frameBytes: 143360, bufferedBytes: 131072, cancellationMs: 5000 });
export const SOCKET_PROTOCOL = 'codestead-interactive-v1';
export const SOCKET_PATH = /^\/api\/code\/interactive\/([a-f0-9-]{36})\/socket$/;

export function canonicalOrigin(value, production = true) {
  try {
    const url = new URL(value);
    if (url.origin !== value || (production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))) return null;
    return value;
  } catch { return null; }
}

export function sameOrigin(headers, origin) {
  const get = name => typeof headers.get === 'function' ? headers.get(name) : headers[name];
  const site = get('sec-fetch-site');
  return Boolean(origin) && get('origin') === origin && (site == null || site === 'same-origin');
}

export function brokerSecret(env = process.env) {
  const value = env.INTERACTIVE_BROKER_SECRET_FILE
    ? readFileSync(env.INTERACTIVE_BROKER_SECRET_FILE, 'utf8').trim()
    : env.INTERACTIVE_BROKER_SECRET;
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096) throw new Error('BROKER_UNAVAILABLE');
  return value;
}

export const bodyHash = value => createHash('sha256').update(value).digest('hex');
export function signEnvelope(secret, purpose, payload, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, nonce: randomUUID(), iat: now, exp: now + LIMITS.grantMs })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(`${purpose}\n${body}`).digest('base64url')}`;
}

export function verifyEnvelope(secret, purpose, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('AUTH_REQUIRED');
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(`${purpose}\n${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('AUTH_REQUIRED');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.iat > now + 1000
    || data.exp <= now || data.exp - data.iat !== LIMITS.grantMs || typeof data.nonce !== 'string') throw new Error('AUTH_REQUIRED');
  return data;
}

export function practiceInput(value, runtimes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['language', 'source', 'mode'].includes(key))
    || value.mode !== 'practice' || typeof value.source !== 'string'
    || Buffer.byteLength(value.source) < 1 || Buffer.byteLength(value.source) > LIMITS.sourceBytes
    || !Object.hasOwn(runtimes, value.language)) throw new Error('PRACTICE_ONLY');
  const runtime = runtimes[value.language];
  const names = { c: 'main.c', cpp: 'main.cpp', java: 'Main.java', python: 'main.py', javascript: 'main.js' };
  return { type: 'init', language: value.language === 'cpp' ? 'c++' : value.language,
    version: runtime.version, files: [{ name: names[value.language], content: value.source }] };
}
