import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import { callProvider } from "@/lib/ai/providers";
import { ProviderError, type SupportedProvider } from "@/lib/ai/types";
import { db } from "@/lib/db/client";
import { modelCall, providerPolicy } from "@/lib/db/schema";

export type CredentialValidationStatus =
  | "active"
  | "invalid"
  | "rate_limited"
  | "pending_validation";

export async function validateProviderCredential(input: {
  userId: string;
  credentialId: string;
  provider: SupportedProvider;
  secret: string;
}) {
  const [policy] = await db
    .select()
    .from(providerPolicy)
    .where(
      and(
        eq(providerPolicy.provider, input.provider),
        eq(providerPolicy.operation, "credential_validation"),
        eq(providerPolicy.enabled, true),
      ),
    )
    .orderBy(asc(providerPolicy.priority))
    .limit(1);
  const model =
    policy?.model ??
    (input.provider === "nvidia_nim"
      ? process.env.NVIDIA_NIM_VALIDATION_MODEL ?? "meta/llama-3.1-8b-instruct"
      : null);

  if (!model) {
    return {
      status: "pending_validation" as const,
      failureCode: null,
      model: null,
    };
  }

  const startedAt = Date.now();
  const requestHash = createHash("sha256").update("credential-probe-v1").digest("hex");
  let result: Awaited<ReturnType<typeof callProvider>>;
  try {
    result = await callProvider({
      provider: input.provider,
      apiKey: input.secret,
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      maxOutputTokens: 4,
      timeoutMs: policy?.timeoutMs ?? 15_000,
    });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const status: CredentialValidationStatus =
      providerError?.code === "AUTHENTICATION"
        ? "invalid"
        : providerError?.code === "RATE_LIMIT"
          ? "rate_limited"
          : "pending_validation";
    const failureCode = providerError?.code ?? "UNKNOWN";
    await db.insert(modelCall).values({
      userId: input.userId,
      credentialId: input.credentialId,
      provider: input.provider,
      model,
      operation: "credential_validation",
      promptVersion: "credential-probe-v1",
      contextManifest: { included: [], excluded: ["learner_data"] },
      latencyMs: Date.now() - startedAt,
      status: "failed",
      errorCode: failureCode,
      requestHash,
    });
    return { status, failureCode, model };
  }
  // Provider and persistence outcomes are deliberately separated. A failed
  // audit/model-call write after a successful probe is infrastructure failure,
  // not evidence that the learner's credential is invalid.
  await db.insert(modelCall).values({
    userId: input.userId,
    credentialId: input.credentialId,
    provider: input.provider,
    model: result.model,
    operation: "credential_validation",
    promptVersion: "credential-probe-v1",
    contextManifest: { included: [], excluded: ["learner_data"] },
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    status: "succeeded",
    requestHash,
    responseHash: createHash("sha256").update(result.content).digest("hex"),
  });
  return { status: "active" as const, failureCode: null, model: result.model };
}
