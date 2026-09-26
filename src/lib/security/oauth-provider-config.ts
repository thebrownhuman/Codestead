/**
 * Whether Google OAuth is configured on this deployment. Shared between the
 * Better Auth config (which registers the provider) and server components
 * that need to decide whether to show the "Continue with Google" control,
 * without ever exposing the client secret itself.
 */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
