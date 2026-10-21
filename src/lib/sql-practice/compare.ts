import type { SqlExercise } from "@/lib/content/sql-practice";

export interface SqlResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** Compare typed cells, including duplicate rows; column order always matters. */
export function matchesSqlResult(actual: SqlResult, expected: SqlExercise["expected"]): boolean {
  if (actual.columns.length !== expected.columns.length ||
      actual.columns.some((column, index) => column !== expected.columns[index]) ||
      actual.rows.length !== expected.rows.length ||
      actual.rows.some((row) => row.length !== expected.columns.length)) return false;

  const sameRow = (left: readonly unknown[], right: readonly unknown[]) =>
    left.every((value, index) => value === right[index]);
  if (expected.orderSensitive) {
    return actual.rows.every((row, index) => sameRow(row, expected.rows[index]!));
  }
  const remaining = [...expected.rows];
  return actual.rows.every((row) => {
    const index = remaining.findIndex((candidate) => sameRow(row, candidate));
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}
