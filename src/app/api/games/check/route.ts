import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createContentRepository } from "@/lib/content";
import { evaluateDraftQuest, type QuestResponse } from "@/lib/games/deterministic-quest";
import { requireAuth } from "@/lib/http/authz";
import { gateClosedBookCapability } from "@/lib/exams/capability-gate";
import { withRateLimit } from "@/lib/security/rate-limit";

const responseSchema = z.union([
  z.object({ selectedOptionIds: z.array(z.string().trim().min(1).max(100)).max(20) }),
  z.object({ gaps: z.record(z.string().min(1).max(100), z.string().max(2_000)) }),
  z.object({ trace: z.string().max(8_000) }),
]);

const bodySchema = z.object({
  skillId: z.string().trim().min(3).max(180),
  itemId: z.string().trim().min(3).max(240),
  response: responseSchema,
  hintIndex: z.number().int().min(0).max(20).default(0),
  clientRequestId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const examGate = await gateClosedBookCapability(authz.session.user.id, "practice_game");
  if (!examGate.allowed) {
    return NextResponse.json(
      { error: examGate.message, code: examGate.code },
      { status: examGate.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return withRateLimit(
    { policy: "game_check_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json({ error: "A bounded quest response is required." }, { status: 400 });
      }
      const repository = createContentRepository();
      const banks = await repository.listAssessmentBanks({ skillId: body.data.skillId });
      const bank = banks.find((candidate) => candidate.skillId === body.data.skillId);
      const item = bank?.items.find((candidate) => candidate.id === body.data.itemId);
      if (!bank || !item || item.skillId !== body.data.skillId || item.kind === "code") {
        return NextResponse.json({ error: "Quest item not found." }, { status: 404 });
      }
      const result = evaluateDraftQuest(
        item,
        body.data.response as QuestResponse,
        body.data.hintIndex,
      );
      return NextResponse.json(
        {
          ...result,
          itemId: item.id,
          publicationStage: bank.publication.stage,
          reviewRequired: true,
          notice: "Draft game practice never awards mastery, exam credit, badges, leaderboard points, or unlimited replay XP.",
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
  );
}
