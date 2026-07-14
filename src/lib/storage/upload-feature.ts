export function uploadsEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.UPLOADS_ENABLED === "true";
}
