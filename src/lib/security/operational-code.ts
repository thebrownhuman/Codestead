const OPERATIONAL_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function boundedOperationalCode(value: unknown): string | null {
  return typeof value === "string" && OPERATIONAL_CODE.test(value)
    ? value
    : null;
}

export function operationalErrorCode(error: unknown) {
  if (!(error instanceof Error)) return "UNKNOWN";
  return boundedOperationalCode(error.name) ?? "ERROR";
}
