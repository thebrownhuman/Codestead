import { z } from "zod";

const text = z.string().trim().min(1);
const cell = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** Local practice only: these answers never enter the assessment/grading contract. */
export const sqlExerciseSchema = z.object({
  type: z.literal("sql"),
  id: text,
  title: text,
  schemaSql: text,
  seedSql: text,
  task: text,
  starterSql: text,
  expected: z.object({
    columns: z.array(text).min(1),
    rows: z.array(z.array(cell)),
    orderSensitive: z.boolean(),
  }).strict(),
}).strict().superRefine((exercise, context) => {
  exercise.expected.rows.forEach((row, index) => {
    if (row.length !== exercise.expected.columns.length) {
      context.addIssue({ code: "custom", path: ["expected", "rows", index], message: "Row width must match columns." });
    }
  });
});

export const sqlPracticeLessonSchema = z.object({
  format: z.literal("practice-lesson"),
  status: z.literal("beta"),
  id: text,
  title: text,
  exercises: z.array(sqlExerciseSchema).min(1),
}).strict().superRefine((lesson, context) => {
  if (new Set(lesson.exercises.map((exercise) => exercise.id)).size !== lesson.exercises.length) {
    context.addIssue({ code: "custom", path: ["exercises"], message: "Exercise IDs must be unique." });
  }
});

export type SqlExercise = z.infer<typeof sqlExerciseSchema>;
export type SqlPracticeLesson = z.infer<typeof sqlPracticeLessonSchema>;
