/**
 * Authentication is fail-closed in production. AUTH_REQUIRED=false exists
 * only for the local demo experience and can never disable production auth.
 */
export function isApplicationAuthRequired(
  environment = process.env.NODE_ENV,
  configured = process.env.AUTH_REQUIRED,
) {
  if (environment === "production") return true;
  return configured !== "false";
}
