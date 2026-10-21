import { describe, expect, it } from "vitest";

import basics from "../../../../content/sql-practice/basics.json";
import { sqlPracticeLessonSchema } from "../sql-practice";

describe("SQL practice content contract", () => {
  it("ships one beta lesson with SELECT, WHERE and JOIN exercises", () => {
    const lesson = sqlPracticeLessonSchema.parse(basics);
    expect(lesson.exercises.map((exercise) => exercise.id)).toEqual(["select", "where", "join"]);
    expect(lesson.exercises.every((exercise) => exercise.type === "sql")).toBe(true);
  });

  it("rejects unknown fields, incomplete results, invalid cells, and ambiguous IDs", () => {
    const exercise = basics.exercises[0]!;
    for (const value of [
      { ...basics, serverExecution: true },
      { ...basics, exercises: [{ ...exercise, type: "code" }] },
      { ...basics, exercises: [{ ...exercise, schemaSql: " " }] },
      { ...basics, exercises: [{ ...exercise, expected: { columns: ["x"], rows: [[1, 2]], orderSensitive: false } }] },
      { ...basics, exercises: [{ ...exercise, expected: { columns: ["x"], rows: [[{}]], orderSensitive: false } }] },
      { ...basics, exercises: [{ ...exercise, expected: { columns: [], rows: [] } }] },
      { ...basics, exercises: [exercise, exercise] },
    ]) expect(sqlPracticeLessonSchema.safeParse(value).success).toBe(false);
  });
});
