export type PostgresCommitAckLossProxy = Readonly<{
  host: "127.0.0.1";
  port: number;
  armNextCommitAckLoss(): void;
  snapshot(): Readonly<{
    acceptedConnections: number;
    armed: boolean;
    droppedCommitAcknowledgements: number;
    openSockets: number;
  }>;
  close(): Promise<void>;
}>;

export function createPostgresCommitAckLossProxy(
  input: Readonly<{
    targetHost: "127.0.0.1" | "::1" | "localhost";
    targetPort: number;
  }>,
): Promise<PostgresCommitAckLossProxy>;
