// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../admin-models-store", () => ({ adminModelsStore: {} }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: vi.fn() }));
import { executeAdminModelCommand, listAdminModels, platformVaultOwner } from "../admin-models-service";
import { openCredential } from "@/lib/security/credential-vault";
import type { AdminModelsStore, PolicyRow, ConnectionChange } from "../admin-models-store";
const master = Buffer.alloc(32, 7);
const actor = { actorId: "admin", sessionId: "session" };
let row: PolicyRow | undefined;
const store: AdminModelsStore = {
  list: async () => row ? [row] : [], connection: async () => row,
  configure: vi.fn(async (_actor: string, change: ConnectionChange) => { row = { ...change, configurationVersion: change.version + 1, operation: "provider_configuration" } as unknown as PolicyRow; }),
  save: vi.fn(async () => {}),
};
it("returns only aggregate learner choice counts for each current model", async () => {
  row = { id: "chosen-policy", provider: "openai", operation: "tutor", enabled: true, model: "chosen", priority: 1 } as PolicyRow;
  const countedStore = { ...store, learnerChoiceCounts: async () => ({ "chosen-policy": 3 }) };
  const rows = await listAdminModels(countedStore);
  expect(rows.find((value) => value.provider === "openai")?.learnerChoiceCount).toBe(3);
  expect(rows.find((value) => value.provider === "google")?.learnerChoiceCount).toBe(0);
});
const deps = { store, request: vi.fn(async (_url: string, _init?: RequestInit) => { void _url; void _init; return new Response(JSON.stringify({ data: [{ id: "model" }] }), { status: 200 }); }),
  resolve: vi.fn(async (url: string) => ({ url: new URL(url), hostname: "api.example.com", addresses: [{ address: "8.8.8.8", family: 4 }] })),
  probe: vi.fn(async () => ({ content: "Hello", latencyMs: 23, httpStatus: 200, model: "model-resolved", provider: "openai" as const, finishReason: "stop", inputTokens: 1, outputTokens: 1, requestId: null })), audit: vi.fn(async () => ({ correlationId: "audit", eventHash: "hash" })) };
beforeEach(() => { row = undefined; vi.clearAllMocks(); deps.request.mockReset().mockImplementation(async (_url: string, _init?: RequestInit) => { void _url; void _init; return new Response(JSON.stringify({ data: [{ id: "model" }] }), { status: 200 }); }); vi.stubEnv("CREDENTIAL_MASTER_KEY", master.toString("base64")); });
afterEach(() => vi.unstubAllEnvs());
async function configure() { await executeAdminModelCommand(actor, { action: "configure", provider: "openai", version: 0, baseUrl: "https://api.example.com/v1", platformKey: "platform-secret-123" }, deps); }
it("encrypts the platform key with platform identity and never exposes the envelope to the browser", async () => {
  await configure();
  expect(JSON.stringify(row)).not.toContain("platform-secret-123");
  expect(openCredential(row!.platformCredential!, { userId: platformVaultOwner, credentialId: row!.id, provider: "openai", keyVersion: 1 }, master)).toBe("platform-secret-123");
  expect(() => openCredential(row!.platformCredential!, { userId: "learner", credentialId: row!.id, provider: "openai", keyVersion: 1 }, master)).toThrow();
  const view = JSON.stringify(await listAdminModels(store));
  expect(view).not.toContain("ciphertext"); expect(view).not.toContain("lastFour"); expect(view).not.toContain("platform-secret-123");
});
it("allows a no-key typed untested model and public listing, but refuses a no-key test", async () => {
  vi.stubEnv("CREDENTIAL_MASTER_KEY", "");
  await executeAdminModelCommand(actor, { action: "save", provider: "openai", version: 0, model: "model", priority: 2, verification: "untested" }, deps);
  expect(store.save).toHaveBeenCalledWith("admin", expect.objectContaining({ verified: false }));
  await executeAdminModelCommand(actor, { action: "load", provider: "nvidia_nim", version: 0 }, deps);
  expect(deps.request.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: { accept: "application/json" } }));
  await expect(executeAdminModelCommand(actor, { action: "test", provider: "openai", version: 0, model: "model", message: "hi" }, deps)).rejects.toMatchObject({ code: "AUTHENTICATION" });
});
it("requires a successful exact test and binds its reported model, session and endpoint revision", async () => {
  await configure();
  const result = await executeAdminModelCommand(actor, { action: "test", provider: "openai", version: 1, model: "model", message: "private prompt" }, deps);
  expect(deps.probe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "platform-secret-123", baseUrl: "https://api.example.com/v1", transport: deps.request }));
  const save = { action: "save" as const, provider: "openai" as const, version: 1, model: "model", priority: 1, verification: "verified" as const, proof: "proof" in result ? result.proof : "", reportedModel: "model-resolved" };
  await executeAdminModelCommand(actor, save, deps);
  expect(store.save).toHaveBeenCalledWith("admin", expect.objectContaining({ verified: true, reportedModel: "model-resolved" }));
  for (const change of [{ model: "other" }, { reportedModel: "forged" }, { proof: "forged" }]) await expect(executeAdminModelCommand(actor, { ...save, ...change }, deps)).rejects.toMatchObject({ code: "POLICY" });
  await expect(executeAdminModelCommand({ ...actor, sessionId: "other" }, save, deps)).rejects.toMatchObject({ code: "POLICY" });
  expect(JSON.stringify(deps.audit.mock.calls)).not.toContain("private prompt");
  expect(JSON.stringify(deps.audit.mock.calls)).not.toContain("platform-secret-123");
});
it("prevents a saved key from silently following an endpoint change", async () => {
  await configure();
  await expect(executeAdminModelCommand(actor, { action: "configure", provider: "openai", version: 1, baseUrl: "https://other.example.com/v1" }, deps)).rejects.toMatchObject({ code: "POLICY" });
  await executeAdminModelCommand(actor, { action: "configure", provider: "openai", version: 1, baseUrl: "https://other.example.com/v1", removeKey: true }, deps);
  expect(row!.platformCredential).toBeNull();
});
it("blocks a provider echoing its credential and never mints verification proof", async () => {
  await configure(); deps.probe.mockResolvedValueOnce({ content: "platform-secret-123", latencyMs: 1, httpStatus: 200, model: "model", provider: "openai" as const, finishReason: "stop", inputTokens: 1, outputTokens: 1, requestId: null });
  await expect(executeAdminModelCommand(actor, { action: "test", provider: "openai", version: 1, model: "model", message: "hi" }, deps)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  expect(deps.audit).not.toHaveBeenCalled();
});



it("loads every Google page without trusting a provider-supplied URL", async () => {
 await executeAdminModelCommand(actor, { action: "configure", provider: "google", version: 0, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", platformKey: "platform-secret-123" }, deps);
 deps.request.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "models/first", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "https://127.0.0.1/private" })))
  .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "models/second", supportedGenerationMethods: ["generateContent"] }] })));
 const result = await executeAdminModelCommand(actor, { action: "load", provider: "google", version: 1 }, deps);
 expect(result).toMatchObject({ models: [{ id: "first" }, { id: "second" }] });
 const next = new URL(deps.request.mock.calls[1][0]); expect(next.hostname).toBe("generativelanguage.googleapis.com"); expect(next.searchParams.get("pageToken")).toBe("https://127.0.0.1/private");
});
it("loads Anthropic display names and cursor pagination", async () => {
 await executeAdminModelCommand(actor, { action: "configure", provider: "anthropic", version: 0, baseUrl: "https://api.anthropic.com/v1", platformKey: "platform-secret-123" }, deps);
 deps.request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-first", display_name: "First" }], has_more: true, last_id: "claude-first" })))
  .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-second", display_name: "Second" }], has_more: false })));
 const result = await executeAdminModelCommand(actor, { action: "load", provider: "anthropic", version: 1 }, deps);
 expect(result).toMatchObject({ models: [{ id: "claude-first", name: "First" }, { id: "claude-second", name: "Second" }] });
 expect(new URL(deps.request.mock.calls[1][0]).searchParams.get("after_id")).toBe("claude-first");
});

it.each(['bytes', 'models'])('rejects oversized public catalogs with a clear limit error: %s', async (kind) => {
 deps.request.mockResolvedValue(new Response(JSON.stringify({ data: Array.from({ length: kind === 'models' ? 10001 : 1 }, (_, i) => ({ id: `model-${i}`, description: kind === 'bytes' ? 'x'.repeat(8_388_608) : '' })) })));
 await expect(executeAdminModelCommand(actor, { action: 'load', provider: 'openrouter', version: 0 }, deps)).rejects.toMatchObject({ code: 'MODEL_LIST_LIMIT' });
});
it('bounds the entire catalog operation even if transport ignores abort', async () => {
 vi.useFakeTimers();
 try {
  deps.request.mockImplementation(() => new Promise(() => {}));
  const pending = executeAdminModelCommand(actor, { action: 'load', provider: 'openrouter', version: 0 }, deps);
  const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(60000);
  await assertion;
 } finally { vi.useRealTimers(); }
});

it('reports the ten-page catalog limit without returning a partial list', async () => {
 await executeAdminModelCommand(actor, { action: 'configure', provider: 'anthropic', version: 0, baseUrl: 'https://api.anthropic.com/v1', platformKey: 'platform-secret-123' }, deps);
 let page = 0;
 deps.request.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: `claude-${++page}` }], has_more: true, last_id: `claude-${page}` })));
 await expect(executeAdminModelCommand(actor, { action: 'load', provider: 'anthropic', version: 1 }, deps)).rejects.toMatchObject({ code: 'MODEL_LIST_LIMIT' });
 expect(deps.request).toHaveBeenCalledTimes(10);
});
it('turns malformed model JSON into a safe provider error', async () => {
 deps.request.mockResolvedValue(new Response('<html>upstream details</html>'));
 await expect(executeAdminModelCommand(actor, { action: 'load', provider: 'openrouter', version: 0 }, deps)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
});
