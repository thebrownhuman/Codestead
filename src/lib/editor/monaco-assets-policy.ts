const SUPPORTED_AMD_VERSION = /^0\.52\.\d+(?:-|$)/;

/**
 * Codestead uses @monaco-editor/react's AMD loader so the editor can be
 * served from the app origin without a CDN. Monaco 0.53 deprecated that build
 * and changed its emitted module scope in a way that races during parallel
 * language loading. Keep the asset synchronizer on the final supported AMD
 * release line until the editor integration is migrated to ESM.
 */
export function assertSupportedMonacoAmdVersion(version: string): void {
  if (!SUPPORTED_AMD_VERSION.test(version)) {
    throw new Error(
      `Monaco ${version} is not approved for the self-hosted AMD loader. ` +
        "Use the pinned 0.52.x release or migrate the editor integration to ESM before upgrading.",
    );
  }
}
