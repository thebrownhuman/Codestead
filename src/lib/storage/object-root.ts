import { tmpdir } from "node:os";
import path from "node:path";

export function objectStorageRoot(): string {
  const configured = process.env.OBJECT_STORAGE_PATH;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("OBJECT_STORAGE_PATH must be absolute.");
    }
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    return "/var/lib/learncoding/objects";
  }
  // Keep the development fallback outside the source tree. Besides avoiding
  // accidental source tracing in standalone builds, this prevents learner
  // uploads from being mistaken for application assets.
  return path.join(tmpdir(), "learncoding-development-objects");
}
