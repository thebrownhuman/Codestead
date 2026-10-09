import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireAuth } from "@/lib/http/authz";
import { loadLearningProfile, saveLearningProfile } from "@/lib/preferences/profile-settings";
import { profileSettingsSchema, ProfileSettingsError } from "@/lib/preferences/profile-settings-values";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import { withRateLimit } from "@/lib/security/rate-limit";
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
function failed(error: unknown, mutation = false) {
  return NextResponse.json({ error: error instanceof ProfileSettingsError ? error.message : mutation ? "Profile could not be fully saved. Some changes may already be saved; reload before retrying." : "Profile unavailable. Try loading it again." }, { status: error instanceof ProfileSettingsError ? error.status : 503, headers });
}
export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try { return NextResponse.json({ profile: await loadLearningProfile(authz.session.user.id, authz.session.user.name, authz.account.role) }, { headers }); } catch (error) { return failed(error); }
}
export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const origin = evaluateRequestOrigin({ method: request.method, headers: request.headers, appUrl: process.env.APP_URL, production: process.env.NODE_ENV === "production" });
  if (!origin.allowed) return NextResponse.json({ error: origin.code }, { status: origin.status, headers });
  return withRateLimit({ policy: "social_profile_user", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const jsonBody = await readBoundedJson(request);
    if (jsonBody.response?.status === 413) return jsonBody.response;
    const body = profileSettingsSchema.safeParse(jsonBody.value);
    if (!body.success) return NextResponse.json({ error: "Enter a name of 1–120 characters, a bio of at most 280 characters, and valid preferences." }, { status: 400, headers });
    try {
      await saveLearningProfile(authz.session.user.id, authz.account.role, body.data);
      // Keep name changes within Better Auth; no additional raw auth endpoint
      // is exposed, and the client refreshes the server-rendered shell.
      await auth.api.updateUser({ headers: request.headers, body: { name: body.data.name } });
      return NextResponse.json({ profile: await loadLearningProfile(authz.session.user.id, body.data.name, authz.account.role) }, { headers });
    } catch (error) { return failed(error, true); }
  });
}
