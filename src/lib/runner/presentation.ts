import { PRACTICE_LIMITS } from "./practice-dispatch";
import { configuredCodeRunnerProvider, PISTON_LIMITS } from "./provider-config";

/** Called only by server pages; serialize the public label into CodeLab. */
export function configuredRunnerPresentation() {
  configuredCodeRunnerProvider();
  return {
    description: "isolated Piston runner",
    runnerLabel: "isolated Piston runner",
    concurrentJobs: PISTON_LIMITS.concurrentJobs,
    runSeconds: Math.min(PRACTICE_LIMITS.wallTimeMs, PISTON_LIMITS.runTimeoutMs) / 1_000,
    detail: `${PISTON_LIMITS.compileTimeoutMs / 1_000} sec compile limit · ${PRACTICE_LIMITS.memoryMb} MiB practice memory`,
  };
}
