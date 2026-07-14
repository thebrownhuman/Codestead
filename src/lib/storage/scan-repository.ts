import { randomUUID } from "node:crypto";

import { pool } from "@/lib/db/client";

import type {
  ScanErrorCode,
  ScanLease,
  ScanVerdict,
  UploadScanRepository,
} from "./upload-scanner";

interface ClaimedRow {
  id: string;
  storage_key: string;
  size_bytes: string | number;
  sha256: string;
  scan_attempts: number;
}

export class PostgresUploadScanRepository implements UploadScanRepository {
  async claimBatch(input: { now: Date; limit: number; leaseMs: number }): Promise<readonly ScanLease[]> {
    const client = await pool.connect();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    try {
      await client.query("begin");
      const result = await client.query<ClaimedRow>(
        `with candidates as (
           select id
             from stored_object
            where deleted_at is null
              and (
                (scan_status = 'pending' and scan_next_attempt_at <= $1)
                or (scan_status = 'scanning' and scan_lease_expires_at <= $1)
              )
            order by scan_next_attempt_at asc, created_at asc, id asc
            for update skip locked
            limit $2
         )
         update stored_object as object
            set scan_status = 'scanning',
                scan_lease_token = $3,
                scan_lease_expires_at = $4,
                scan_attempts = object.scan_attempts + 1,
                scan_error_code = null,
                updated_at = $1
           from candidates
          where object.id = candidates.id
         returning object.id, object.storage_key, object.size_bytes,
                   object.sha256, object.scan_attempts`,
        [input.now, input.limit, leaseToken, leaseExpiresAt],
      );
      await client.query("commit");
      return result.rows.map((row) => ({
        id: row.id,
        storageKey: row.storage_key,
        sizeBytes: Number(row.size_bytes),
        sha256: row.sha256,
        leaseToken,
        attempt: row.scan_attempts,
      }));
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(lease: ScanLease, verdict: ScanVerdict, now: Date) {
    const result = await pool.query(
      `update stored_object
          set scan_status = $1,
              scan_lease_token = null,
              scan_lease_expires_at = null,
              scan_error_code = null,
              scanned_at = $2,
              updated_at = $2
        where id = $3
          and deleted_at is null
          and scan_status = 'scanning'
          and scan_lease_token = $4`,
      [verdict === "clean" ? "safe" : "quarantined", now, lease.id, lease.leaseToken],
    );
    return result.rowCount === 1;
  }

  async fail(
    lease: ScanLease,
    input: {
      code: ScanErrorCode;
      terminal: boolean;
      retryAt: Date;
      now: Date;
    },
  ) {
    const result = await pool.query(
      `update stored_object
          set scan_status = $1,
              scan_lease_token = null,
              scan_lease_expires_at = null,
              scan_next_attempt_at = $2,
              scan_error_code = $3,
              updated_at = $4
        where id = $5
          and deleted_at is null
          and scan_status = 'scanning'
          and scan_lease_token = $6`,
      [input.terminal ? "scanner_error" : "pending", input.retryAt, input.code, input.now, lease.id, lease.leaseToken],
    );
    return result.rowCount === 1;
  }
}
