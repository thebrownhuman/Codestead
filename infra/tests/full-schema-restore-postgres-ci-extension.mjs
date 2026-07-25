const restorePostgresCiExtensionInput = Object.freeze({
  id: "full-schema-restore",
  kind: "restore",
  registrationScripts: Object.freeze([
    "test:full-schema-restore:registration",
  ]),
  productionPg17Scripts: Object.freeze([
    "test:full-schema-restore:pg17",
  ]),
  targetedPg18Scripts: Object.freeze([
    "test:full-schema-restore:pg18",
  ]),
  minimumTimeoutMinutes: 35,
});

export function defineFullSchemaRestorePostgresCiExtension(
  definePostgresCiProjectionExtension,
) {
  if (typeof definePostgresCiProjectionExtension !== "function") {
    throw new TypeError(
      "definePostgresCiProjectionExtension must be the canonical factory",
    );
  }

  return definePostgresCiProjectionExtension(
    restorePostgresCiExtensionInput,
  );
}
