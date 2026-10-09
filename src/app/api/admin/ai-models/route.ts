import { readBoundedBody } from "@/lib/http/bounded-json";
import { NextRequest } from "next/server";
import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { requireAdmin } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { adminModelMfaIsFresh } from "@/lib/ai/admin-models-authorization";
import { modelCommandSchema } from "@/lib/ai/admin-models-domain";
import { executeAdminModelCommand, listAdminModels } from "@/lib/ai/admin-models-service";
import { isProviderError } from "@/lib/ai/types";
import { todayPlatformUsage } from "@/lib/ai/platform-quota";

export const runtime = "nodejs";
function logUnexpectedError(error: unknown) {
  // Never log arbitrary exception strings: they can include credentials,
  // provider response bodies, or URLs with secret query parameters.
  const names = ["Error", "SyntaxError", "TypeError", "RangeError", "ReferenceError", "ZodError", "AbortError"];
  const name = error instanceof Error && names.includes(error.name) ? error.name : "UnknownError";
  console.warn("Admin AI model unexpected error", {
    name,
    message: name === "SyntaxError" ? "Response could not be parsed as JSON." : name === "TypeError" ? "Operation failed due to an invalid value or transport error." : "Unexpected AI model operation failure.",
  });
}
export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "admin_ai_models_read", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    try {
      const [providers, platformUsage] = await Promise.all([listAdminModels(), todayPlatformUsage()]);
      return adminJson({ providers, platformUsage });
    }
    catch (error) {
      if (!isProviderError(error)) logUnexpectedError(error);
      return adminJson({ error: "AI model settings are temporarily unavailable." }, 503);
    }
  });
}
async function boundedBody(request: NextRequest) {
  const body = await readBoundedBody(request, 32768);
  if (body.response) return null;
  try { return JSON.parse(Buffer.from(body.value).toString("utf8")); } catch { return null; }
}
export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  // Enforce origin even for requests without cookies; this route is browser/session-only.
  const headers = new Headers(request.headers);
  if (!headers.has("cookie")) headers.set("cookie", "session-route=1");
  const origin = evaluateRequestOrigin({ method: "POST", headers, appUrl: process.env.APP_URL, production: process.env.NODE_ENV === "production" });
  if (!origin.allowed) return adminJson({ error: origin.code }, origin.status);
  return withRateLimit({ policy: "admin_ai_models_write", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const parsed = modelCommandSchema.safeParse(await boundedBody(request));
    if (!parsed.success) return adminJson({ error: "INVALID_REQUEST" }, 400);
    const command = parsed.data;
    if (!await adminModelMfaIsFresh(authz.session.user.id, authz.session.session.id)) {
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "ai_models." + command.action, resourceType: "provider_policy", outcome: "denied", metadata: { provider: command.provider, denialCode: "FRESH_MFA_REQUIRED" } });
      return adminJson({ error: "Verify your authenticator to manage AI model settings.", code: "FRESH_MFA_REQUIRED" }, 403);
    }
    const execute = async () => {
      try { return adminJson(await executeAdminModelCommand({ actorId: authz.session.user.id, sessionId: authz.session.session.id }, command)); }
      catch (error) {
        const normalized = isProviderError(error) ? error : null;
        const code = normalized?.code ?? "UNAVAILABLE";
        console.warn("Admin AI model operation failed", { provider: command.provider, code, httpStatus: normalized?.status ?? null });
        if (!normalized) logUnexpectedError(error);
        await writeAuditEvent({ actorUserId: authz.session.user.id, action: "ai_models." + command.action, resourceType: "provider_policy", outcome: "failure", metadata: { provider: command.provider, errorCode: code, httpStatus: normalized?.status ?? null } });
        const messages: Record<string, string> = {
          AUTHENTICATION: "Set or replace the platform API key before loading or testing this provider.",
          POLICY: "Check the public HTTPS endpoint, reload changed settings, and test this exact model before saving it as verified. Replace or remove the key when changing its endpoint.",
          MODEL_NOT_FOUND: "Model not found. It may have been retired. Choose another model.",
          BAD_REQUEST: "The provider rejected this request. Check its model and endpoint.",
          RATE_LIMIT: "The provider rate limit was reached. Try again later.",
          TIMEOUT: "The provider request timed out. Try again.",
          BAD_RESPONSE: "The provider returned an invalid or unsafe response.",
          REASONING_LEAK: "This model returns reasoning text. Its response was blocked.",
          MODEL_LIST_LIMIT: "The provider model list exceeds the size (8 MiB / 10,000 models) or page (10 pages) limit. Use a model ID directly or try a smaller provider catalog.",
        };
        return adminJson({ error: messages[code] ?? "AI model operation failed. Try again.", code, httpStatus: normalized?.status ?? null }, normalized?.status === 409 ? 409 : code === "POLICY" ? 400 : code === "UNAVAILABLE" || code === "TIMEOUT" ? 503 : 424);
      }
    };
    return command.action === "test"
      ? withRateLimit({ policy: "admin_ai_models_test", identity: { kind: "user", value: authz.session.user.id } }, execute)
      : execute();
  });
}
