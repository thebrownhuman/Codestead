import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { pool } from "@/lib/db/client";
import { adminModelsStore } from "@/lib/ai/admin-models-store";
import { loadLearnerModelSettings, ModelChoiceError, saveLearnerModelChoice } from "@/lib/ai/learner-model-choice-store";

const users = ["choice-a-" + randomUUID(), "choice-b-" + randomUUID()];
const model = "integration-choice-" + randomUUID();
let key: string;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.INTEGRATION_TEST !== "1" || url.hostname !== "127.0.0.1" || url.pathname !== "/learncoding_integration") throw new Error("Disposable integration harness required.");
  for (const id of users) await pool.query('INSERT INTO "user"(id,name,email) VALUES ($1,$2,$3)', [id, "Model choice integration", id + "@example.invalid"]);
});
beforeEach(async () => {
  await pool.query("DELETE FROM provider_policy WHERE model=$1", [model]);
  key = randomUUID();
  await pool.query("INSERT INTO provider_policy(id,provider,operation,model,priority,enabled) VALUES ($1,'openai','tutor',$2,1,true)", [key, model]);
  for (const id of users) await saveLearnerModelChoice(id, null);
});
afterAll(async () => {
  await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users]);
  await pool.query("DELETE FROM provider_policy WHERE model=$1", [model]);
  await pool.end();
});
it("matches the replayed 0073 physical column inventory, including the learner preference", async () => {
  const manifest = JSON.parse(await readFile("drizzle/meta/0073_public_column_attnums.json", "utf8")) as {
    tables: Array<{ identity: string; columns: Array<{ name: string; attnum: number }> }>;
  };
  const actual = await pool.query<{ identity: string; name: string; attnum: number }>(`
    SELECT namespace.nspname || '.' || relation.relname AS identity,
           attribute.attname AS name, attribute.attnum
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
     WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
     ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", attribute.attnum
  `);
  expect(actual.rows).toEqual(manifest.tables.flatMap(({ identity, columns }) =>
    columns.map(({ name, attnum }) => ({ identity, name, attnum })),
  ));
  expect(actual.rows).toContainEqual({
    identity: "public.learner_profile", name: "preferred_ai_model_policy_id", attnum: 19,
  });
});
it("enforces the foreign key and sets saved choices to NULL when a model row is deleted", async () => {
  await saveLearnerModelChoice(users[0], key);
  await expect(pool.query("UPDATE learner_profile SET preferred_ai_model_policy_id=$1 WHERE user_id=$2", [randomUUID(), users[1]])).rejects.toMatchObject({ code: "23503" });
  await pool.query("DELETE FROM provider_policy WHERE id=$1", [key]);
  const rows = await pool.query("SELECT preferred_ai_model_policy_id FROM learner_profile WHERE user_id=ANY($1::text[])", [users]);
  expect(rows.rows.map((row) => row.preferred_ai_model_policy_id)).toEqual([null, null]);
});
it("counts explicit learner selections without returning names or counting use-default", async () => {
  await saveLearnerModelChoice(users[0], key);
  expect((await adminModelsStore.learnerChoiceCounts!())[key]).toBe(1);
  await saveLearnerModelChoice(users[1], key);
  expect((await adminModelsStore.learnerChoiceCounts!())[key]).toBe(2);
  await saveLearnerModelChoice(users[0], null);
  expect((await adminModelsStore.learnerChoiceCounts!())[key]).toBe(1);
});
it("uses default and shows a notice after an administrator disables the saved model", async () => {
  await saveLearnerModelChoice(users[0], key);
  await pool.query("UPDATE provider_policy SET enabled=false WHERE id=$1", [key]);
  expect(await loadLearnerModelSettings(users[0])).toMatchObject({ selectedKey: null, unavailable: true });
  await expect(saveLearnerModelChoice(users[1], key)).rejects.toBeInstanceOf(ModelChoiceError);
});
it("rejects non-tutor and unknown policies without changing either learner", async () => {
  await pool.query("UPDATE provider_policy SET operation='provider_configuration' WHERE id=$1", [key]);
  await expect(saveLearnerModelChoice(users[0], key)).rejects.toBeInstanceOf(ModelChoiceError);
  await expect(saveLearnerModelChoice(users[0], randomUUID())).rejects.toBeInstanceOf(ModelChoiceError);
  const rows = await pool.query("SELECT preferred_ai_model_policy_id FROM learner_profile WHERE user_id=ANY($1::text[])", [users]);
  expect(rows.rows.map((row) => row.preferred_ai_model_policy_id)).toEqual([null, null]);
});
