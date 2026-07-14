export class TrackPrerequisiteExpressionError extends Error {
  readonly expression: string;

  constructor(expression: string, message: string) {
    super(`Invalid track prerequisite '${expression}': ${message}`);
    this.name = "TrackPrerequisiteExpressionError";
    this.expression = expression;
  }
}

export function parseTrackPrerequisiteExpression(expression: string): readonly string[] {
  const alternatives = expression.split("|").map((value) => value.trim());
  if (!alternatives.length || alternatives.some((value) => !value)) {
    throw new TrackPrerequisiteExpressionError(expression, "every alternative must name a track");
  }
  if (new Set(alternatives).size !== alternatives.length) {
    throw new TrackPrerequisiteExpressionError(expression, "alternatives must be unique");
  }
  return alternatives;
}
