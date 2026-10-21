// Public Piston service maxima for learner copy. The deployment contract test
// keeps these aligned with compose.yaml; exam-pinned execution code stays intact.
export const PISTON_LIMITS = Object.freeze({
  runTimeoutMs: 3_000,
  compileTimeoutMs: 10_000,
  runMemoryBytes: 256 * 1024 * 1024,
  concurrentJobs: 2,
});

export function configuredCodeRunnerProvider(): "piston" {
  const provider = process.env.CODE_RUNNER_PROVIDER || "piston";
  if (provider === "piston") return provider;
  throw new Error("CODE_RUNNER_PROVIDER must be piston; the legacy runner is retired.");
}
