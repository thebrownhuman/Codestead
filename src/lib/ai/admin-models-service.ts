import { randomUUID } from "node:crypto";
import { openCredential, parseMasterKey, sealCredential } from "@/lib/security/credential-vault";
import { containsCredentialOrHiddenEvidence, containsExposedCredentialVariant } from "@/lib/security/sensitive-text";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { AI_PROVIDER_CATALOG, defaultModelForProvider } from "./provider-catalog";
import { providerDefinitions, callProvider } from "./providers";
import { adminModelsStore, type AdminModelsStore } from "./admin-models-store";
import { createModelProof, verifyModelProof, modelListUrl, nextModelListUrl, parseModelList, modelProviders, type ModelCommand } from "./admin-models-domain";
import { resolvePublicProviderUrl, safeProviderRequest } from "./safe-provider-http";
import { ProviderError, type SupportedProvider } from "./types";
import { safeTutorResponse } from "./response-safety";

type Actor = { actorId: string; sessionId: string };
async function boundedModelList(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("Provider returned an empty model list.", "BAD_RESPONSE");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 8_388_608) {
      void reader.cancel().catch(() => undefined);
      throw new ProviderError("Provider model list exceeds the size limit.", "MODEL_LIST_LIMIT");
    }
    chunks.push(next.value);
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProviderError("Provider returned an invalid model list.", "BAD_RESPONSE"); }
  if (payload && typeof payload === "object") {
    const list = payload as { data?: unknown; models?: unknown };
    if ([list.data, list.models].some((entries) => Array.isArray(entries) && entries.length > 10_000)) {
      throw new ProviderError("Provider model list exceeds the size limit.", "MODEL_LIST_LIMIT");
    }
  }
  return payload;
}
export const platformVaultOwner = "platform-ai-models";
function masterKey() { return parseMasterKey(process.env.CREDENTIAL_MASTER_KEY ?? ""); }
export function defaultBaseUrl(provider: SupportedProvider) {
  return provider === "custom_openai_compatible" ? process.env.CUSTOM_OPENAI_BASE_URL ?? "" : providerDefinitions[provider].baseUrl;
}
export async function listAdminModels(store: AdminModelsStore = adminModelsStore) {
  const rows = await store.list();
  const counts = await store.learnerChoiceCounts?.() ?? {};
  return modelProviders.map((provider) => {
    const connection = rows.find((row) => row.provider === provider && row.operation === "provider_configuration");
    const policy = rows.find((row) => row.provider === provider && row.operation === "tutor" && row.enabled);
    return { provider, label: AI_PROVIDER_CATALOG.find((entry) => entry.id === provider)?.label ?? "Custom OpenAI-compatible",
      baseUrl: connection?.baseUrl ?? policy?.baseUrl ?? defaultBaseUrl(provider), version: connection?.configurationVersion ?? 0,
      hasPlatformKey: Boolean(connection?.platformCredential),
      model: policy?.model ?? (provider === "custom_openai_compatible" ? "" : defaultModelForProvider(provider)),
      priority: policy?.priority ?? 100, verification: policy?.verificationStatus ?? "untested", verifiedAt: policy?.verifiedAt ?? null,
      source: policy ? "admin" : "environment_or_fallback", learnerChoiceCount: policy ? counts[policy.id] ?? 0 : 0 };
  });
}
function assertSafeOutput(text: string, key?: string) {
  if (containsCredentialOrHiddenEvidence(text) || (key && containsExposedCredentialVariant(text, [key]))) {
    throw new ProviderError("Provider response was blocked by the credential boundary.", "BAD_RESPONSE");
  }
}
export async function executeAdminModelCommand(actor: Actor, command: ModelCommand, deps = {
  store: adminModelsStore as AdminModelsStore, request: safeProviderRequest, probe: callProvider, resolve: resolvePublicProviderUrl, audit: writeAuditEvent,
}) {
  const connection = await deps.store.connection(command.provider);
  const version = connection?.configurationVersion ?? 0;
  if (command.version !== version) throw new ProviderError("Connection changed. Reload before continuing.", "POLICY", 409);
  const baseUrl = connection?.baseUrl ?? defaultBaseUrl(command.provider);
  if (command.action === "configure") {
    const resolved = await deps.resolve(command.baseUrl);
    const id = connection?.id ?? randomUUID();
    let envelope = command.removeKey ? null : connection?.platformCredential ?? null;
    if (command.platformKey) envelope = sealCredential(command.platformKey, { userId: platformVaultOwner, credentialId: id, provider: command.provider, keyVersion: (envelope?.keyVersion ?? 0) + 1 }, masterKey());
    // A stored credential must never silently follow an endpoint edit.
    if (baseUrl !== resolved.url.href.replace(/\/+$/, "") && envelope && !command.platformKey) {
      throw new ProviderError("Replace or remove the platform key when changing its endpoint.", "POLICY", 409);
    }
    await deps.store.configure(actor.actorId, { id, provider: command.provider, baseUrl: resolved.url.href.replace(/\/+$/, ""), platformCredential: envelope, version });
    return { ok: true };
  }
  if (!baseUrl) throw new ProviderError("Save a connection base URL first.", "POLICY", 409);
  const binding = { ...actor, provider: command.provider, model: "model" in command ? command.model : "", baseUrl, version, reportedModel: command.action === "save" ? command.reportedModel : undefined };
  if (command.action === "save") {
    const verified = command.verification === "verified";
    if (verified && !verifyModelProof(command.proof, binding, masterKey())) throw new ProviderError("Test this exact model and connection before saving it as verified.", "POLICY", 409);
    await deps.store.save(actor.actorId, { provider: command.provider, model: command.model, priority: command.priority, baseUrl, version, verified, reportedModel: command.reportedModel });
    return { ok: true };
  }
  const envelope = connection?.platformCredential;
  const publicList = command.action === "load" && ["openrouter", "nvidia_nim"].includes(command.provider);
  if (!envelope && !publicList) throw new ProviderError("Set a platform API key to load or test this provider, or save a typed model as untested.", "AUTHENTICATION", 409);
  const key = envelope ? openCredential(envelope, { userId: platformVaultOwner, credentialId: connection!.id, provider: command.provider, keyVersion: envelope.keyVersion }, masterKey()) : "";
  if (command.action === "load") {
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) {
      if (command.provider === "google") headers["x-goog-api-key"] = key;
      else if (command.provider === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
      else headers.authorization = `Bearer ${key}`;
    }
    const initialUrl = modelListUrl(command.provider, baseUrl);
    let url: string | null = initialUrl;
    const models = new Map<string, ReturnType<typeof parseModelList>[number]>();
    const visited = new Set<string>();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderError("Provider model listing timed out.", "TIMEOUT"));
        controller.abort();
      }, 60_000);
    });
    let httpStatus = 200;
    try {
      for (let page = 0; url && page < 10; page++) {
        if (visited.has(url)) throw new ProviderError("Provider pagination did not advance.", "BAD_RESPONSE");
        visited.add(url);
        const response = await Promise.race([deps.request(url, { headers, redirect: "error", signal: controller.signal }), deadline]);
        httpStatus = response.status;
        if (!response.ok) throw new ProviderError("Provider model listing failed.", response.status === 401 || response.status === 403 ? "AUTHENTICATION" : response.status === 404 || response.status === 410 ? "MODEL_NOT_FOUND" : "UNAVAILABLE", response.status);
        const payload = await Promise.race([boundedModelList(response), deadline]);
        let entries: ReturnType<typeof parseModelList>;
        try { entries = parseModelList(command.provider, payload); }
        catch { throw new ProviderError("Provider returned an invalid model list.", "BAD_RESPONSE"); }
        for (const model of entries) {
          assertSafeOutput(`${model.id} ${model.name}`, key);
          models.set(model.id, model);
        }
        if (models.size > 10_000) throw new ProviderError("Provider model list exceeds the size limit.", "MODEL_LIST_LIMIT");
        url = nextModelListUrl(command.provider, initialUrl, payload);
      }
      if (url) throw new ProviderError("Provider model list exceeds the page limit.", "MODEL_LIST_LIMIT");
      return { models: [...models.values()], httpStatus };
    } finally { clearTimeout(timer!); }
  }
  const reply = await deps.probe({ provider: command.provider, apiKey: key, baseUrl, transport: deps.request,
    model: command.model, messages: [{ role: "user", content: command.message }], maxOutputTokens: 1500, timeoutMs: 60_000 });
  const safe = safeTutorResponse(reply.content);
  reply.content = safe.content;
  assertSafeOutput(reply.content, key);
  assertSafeOutput(reply.model, key);
  await deps.audit({ actorUserId: actor.actorId, action: "ai_models.test", resourceType: "provider_policy", outcome: "success", metadata: { provider: command.provider, model: command.model, httpStatus: reply.httpStatus ?? 200 } });
  return { content: reply.content, reasoningDetected: reply.reasoningDetected || safe.reasoningDetected, latencyMs: reply.latencyMs, httpStatus: reply.httpStatus ?? 200, reportedModel: reply.model, proof: createModelProof({ ...binding, reportedModel: reply.model }, masterKey()) };
}
