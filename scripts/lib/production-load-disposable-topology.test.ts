import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  configuration: {
    postgres: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      maximumConnections: 16,
    },
    tunnel: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      maximumConnections: 16,
    },
    provider: { listenHost: "127.0.0.1", listenPort: 0 },
  },
}));

vi.mock("./production-load-disposable-sandbox", () => ({
  assertProductionLoadDisposableNetworkSandbox: vi.fn(async () => sandbox.configuration),
}));

import { startProductionLoadDisposableFixtureTopology } from
  "./production-load-disposable-topology";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("missing_port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe("production load disposable fixture topology", () => {
  it("uses real isolated bytes, ten authenticated sessions, providers, and two-slot queueing", async () => {
    const [postgresPort, applicationPort] = await Promise.all([unusedPort(), unusedPort()]);
    sandbox.configuration.postgres.upstreamPort = postgresPort;
    sandbox.configuration.tunnel.upstreamPort = applicationPort;
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-fixture-topology-"));
    roots.push(fixtureRoot);
    const topology = await startProductionLoadDisposableFixtureTopology({
      testConfiguration: { fixtureRoot, postgresPort, applicationPort },
    });
    const signal = new AbortController().signal;
    try {
      await expect(topology.readinessEvidence(signal)).resolves.toMatchObject({
        postgresRoundTrip: true,
        providerStatuses: { gmail: 204, ai: 204, drive: 204 },
        authenticatedLearnerIds: Array.from(
          { length: 10 },
          (_, index) => `load-learner-${String(index + 1).padStart(2, "0")}`,
        ),
        runnerMaxConcurrentJobs: 2,
        runnerQueuedJobsObserved: 2,
      });
      await expect(topology.browserJourney(
        "fake_ai_provider_failure", "steady", signal,
      )).resolves.toBeUndefined();

      await topology.reset("fake_ai_provider_failure", signal);
      await topology.injectAndRelease("fake_ai_provider_failure", signal);
      await expect(topology.probe(
        "fake_ai_provider_failure", "recovery", signal,
      )).resolves.toEqual({ componentHealthy: true, alertOrDeadLetterVisible: true });

      await topology.reset("postgres_proxy_interruption", signal);
      await topology.injectAndRelease("postgres_proxy_interruption", signal);
      await expect(topology.probe(
        "postgres_proxy_interruption", "recovery", signal,
      )).resolves.toEqual({ componentHealthy: true, alertOrDeadLetterVisible: true });
      await expect(topology.invariantEvidence(
        "postgres_proxy_interruption", signal,
      )).resolves.toEqual({
        acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: 2,
        secretLeakFindings: 0,
      });
    } finally {
      await topology.close();
    }
  });

  it("rejects host-level faults because they require external Docker or VM evidence", async () => {
    const [postgresPort, applicationPort] = await Promise.all([unusedPort(), unusedPort()]);
    sandbox.configuration.postgres.upstreamPort = postgresPort;
    sandbox.configuration.tunnel.upstreamPort = applicationPort;
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codestead-fixture-topology-"));
    roots.push(fixtureRoot);
    const topology = await startProductionLoadDisposableFixtureTopology({
      testConfiguration: { fixtureRoot, postgresPort, applicationPort },
    });
    try {
      await expect(topology.injectAndRelease(
        "app_container_restart", new AbortController().signal,
      )).rejects.toThrow("external_fault_required");
    } finally {
      await topology.close();
    }
  });
});
