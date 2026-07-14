import { achievement, providerPolicy } from "../src/lib/db/schema";
import { db, pool } from "../src/lib/db/client";
import { stageFilesystemCurriculum } from "../src/lib/curriculum-publication/staging";
import { syncModuleProjectTemplates } from "../src/lib/projects/module-project-service";

const policies = [
  {
    provider: "nvidia_nim" as const,
    operation: "credential_validation",
    model: process.env.NVIDIA_NIM_VALIDATION_MODEL ?? "meta/llama-3.1-8b-instruct",
    priority: 1,
    maxInputTokens: 256,
    maxOutputTokens: 4,
    timeoutMs: 15_000,
  },
  {
    provider: "nvidia_nim" as const,
    operation: "tutor",
    model: process.env.NVIDIA_NIM_TUTOR_MODEL ?? "meta/llama-3.1-8b-instruct",
    priority: 1,
    maxInputTokens: 16_000,
    maxOutputTokens: 1_500,
    timeoutMs: 30_000,
  },
];

const achievements = [
  { slug: "first-independent-skill", title: "Own the idea", description: "Pass one skill without a hint or solution reveal.", icon: "spark", ruleVersion: "1", rule: { event: "skill_passed", independent: true, count: 1 } },
  { slug: "retained-one-week", title: "It stuck", description: "Retain a mastered skill on a delayed review after seven days.", icon: "brain", ruleVersion: "1", rule: { event: "review_passed", delayDays: 7 } },
  { slug: "mastery-95", title: "Mastery earned", description: "Score at least 95% with all critical criteria met on a mastery exam.", icon: "medal", ruleVersion: "1", rule: { event: "exam_mastery", score: 0.95 } },
  { slug: "project-evidence", title: "Built and explained", description: "Complete a reviewed project with reproducible evidence.", icon: "project", ruleVersion: "1", rule: { event: "project_review_passed" } },
  { slug: "review-rhythm-8", title: "Steady rhythm", description: "Complete meaningful learning on eight consecutive local dates.", icon: "flame", ruleVersion: "1", rule: { event: "streak", days: 8 } },
];

async function main() {
  for (const policy of policies) {
    await db
      .insert(providerPolicy)
      .values(policy)
      .onConflictDoUpdate({
        target: [providerPolicy.provider, providerPolicy.operation, providerPolicy.model],
        set: {
          priority: policy.priority,
          maxInputTokens: policy.maxInputTokens,
          maxOutputTokens: policy.maxOutputTokens,
          timeoutMs: policy.timeoutMs,
          enabled: true,
          updatedAt: new Date(),
        },
      });
  }
  for (const item of achievements) {
    await db
      .insert(achievement)
      .values(item)
      .onConflictDoUpdate({
        target: achievement.slug,
        set: {
          title: item.title,
          description: item.description,
          icon: item.icon,
          ruleVersion: item.ruleVersion,
          rule: item.rule,
          updatedAt: new Date(),
        },
      });
  }
  const curriculum = await stageFilesystemCurriculum();
  const moduleProjects = await syncModuleProjectTemplates();
  console.info(JSON.stringify({ event: "platform.seeded", policies: policies.length, achievements: achievements.length, curriculum, moduleProjects }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ event: "platform.seed_failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
