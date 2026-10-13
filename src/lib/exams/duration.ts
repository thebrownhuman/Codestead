export function examDurationMinutes(itemCount: number): number {
  if (!Number.isInteger(itemCount) || itemCount <= 0) {
    throw new RangeError("itemCount must be a positive integer");
  }
  return Math.min(45, Math.max(10, itemCount * 6));
}
