import { HmacAuthenticator, NonceStore } from "./auth.js";
import { loadConfig } from "./config.js";
import { DockerJobExecutor } from "./docker-executor.js";
import { createRunnerHttpServer } from "./http-server.js";
import { NodeProcessExecutor } from "./process-executor.js";
import { verifyInheritedProcessLock } from "./process-lock.js";
import { RunnerService } from "./service.js";

verifyInheritedProcessLock(
  process.env.RUNNER_STATE_ROOT ?? "/var/lib/learncoding-runner",
);

const config = loadConfig();
const processExecutor = new NodeProcessExecutor();
const jobExecutor = new DockerJobExecutor(config, processExecutor);
const service = new RunnerService(config, jobExecutor, {
  onFatalError: () => {
    process.stderr.write(
      "runner state persistence failed; terminating fail-closed\n",
    );
    process.exit(1);
  },
});
const authenticator = new HmacAuthenticator(
  config.sharedSecret,
  config.authMaxSkewSeconds,
  new NonceStore(config.nonceTtlSeconds),
);
const server = createRunnerHttpServer(config, service, authenticator);

process.once("exit", () => service.close());

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `runner listening on ${config.host}:${config.port}\n`,
  );
});

const shutdown = (signal: string): void => {
  process.stdout.write(`runner received ${signal}; stopping intake\n`);
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write("runner shutdown failed\n");
      process.exitCode = 1;
    }
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
