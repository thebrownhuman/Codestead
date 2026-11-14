import { z } from "zod";

const uuidSchema = z.uuid();

/**
 * True when a path or body value is safe to compare against a Postgres uuid
 * column. Anything else must be answered with 400/404 before the query runs,
 * because Postgres rejects a malformed uuid with an error, not an empty result.
 */
export function isUuid(value: unknown): value is string {
  return uuidSchema.safeParse(value).success;
}
