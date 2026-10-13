import { pool } from "@/lib/db/client";
import { learnerModelSettings, type LearnerModelPolicy } from "./learner-model-choice";

export class ModelChoiceError extends Error {}

export async function loadLearnerModelSettings(userId: string) {
  const [policies, profile] = await Promise.all([
    pool.query<LearnerModelPolicy>("SELECT id,provider,model,operation,enabled,priority FROM provider_policy WHERE operation = 'tutor' ORDER BY priority,id"),
    pool.query<{ preferred_ai_model_policy_id: string | null }>("SELECT preferred_ai_model_policy_id FROM learner_profile WHERE user_id=$1", [userId]),
  ]);
  return learnerModelSettings(policies.rows, profile.rows[0]?.preferred_ai_model_policy_id ?? null);
}

export async function saveLearnerModelChoice(userId: string, key: string | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (key !== null) {
      const enabled = await client.query("SELECT id FROM provider_policy WHERE id=$1 AND operation='tutor' AND enabled=true FOR SHARE", [key]);
      if (enabled.rowCount !== 1) throw new ModelChoiceError("Choose a currently enabled tutor model.");
    }
    await client.query(`INSERT INTO learner_profile(user_id,preferred_ai_model_policy_id) VALUES ($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET preferred_ai_model_policy_id=EXCLUDED.preferred_ai_model_policy_id,
      updated_at=now(),row_version=learner_profile.row_version+1`, [userId, key]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
