# Upload scanning runbook

All accepted source, text, and PDF uploads begin with `scan_status='pending'` and are not downloadable. The upload-profile scanner atomically leases rows with `FOR UPDATE SKIP LOCKED`, opens only a server-generated `<owner-id>/<object-uuid>` path, verifies size and SHA-256 while streaming, and sends the byte stream to clamd using its `INSTREAM` protocol. An independent always-on worker drains bounded learner-deletion batches using pinned directory handles and unlink-plus-directory-fsync durability. Clean objects become `safe`; detected objects become `quarantined`. No scanner result can overwrite a deleted object or a newer worker lease.

## Service boundary

- `file-erasure-worker` is always on, including pilot mode, so accepted deletion jobs survive restarts and are physically erased. It uses the least-privilege worker PostgreSQL role, only the dedicated writable `/var/lib/learncoding/objects` bind, and only the internal data network.
- `scan-worker` exists only in the `uploads` profile, uses the worker PostgreSQL role, mounts the same dedicated object root read-only, and reaches clamd only on the internal scanner network. No parent app-data path is mounted.
- `clamav` can receive streams only on the internal `scanner` network. It cannot read object storage or PostgreSQL. Its second network exists only to refresh malware signatures. Clamd TCP has no native authentication or encryption, which is why port 3310 must never leave this isolated Docker network.
- Neither service publishes a host port. The ClamAV signature cache is reproducible and is not part of learner-data backups.
- The web app permits download only for the exact `safe` status. Pending, scanning, quarantined, scanner-error, deleted, and legacy statuses fail closed.

Before each release, set `CLAMAV_IMAGE` to a reviewed version-specific `clamav/clamav:<version>_base` image with an immutable `@sha256:<64 hex>` digest. Runtime validation rejects a tag-only reference. The persistent `/var/lib/clamav` volume is required for the base image and avoids downloading the full database after every restart. Reserve at least 4 GB memory for the service, per the official [ClamAV Docker guidance](https://docs.clamav.net/manual/Installing/Docker.html). The [clamd protocol documentation](https://docs.clamav.net/manual/Usage/ClamdProtocol.html) is the authority for the `INSTREAM` framing used by the worker.
Before either pilot or full-mode startup, systemd runs `prepare-object-storage.mjs` as root. The host parent must be `root:root` mode `0750`; the object root must be `root:1000` mode `01770`; and `.codestead-object-root-v1` must be a one-link `root:1000` mode `0440` regular file with the exact reviewed content. App, scanner, and lifecycle containers mount only that nested source, so UID 1000 has no writable parent path from which it could replace the root. Any mismatch fails startup and keeps uploads unavailable.

```bash
sudo env UPLOADS_ENABLED=false LEARN_DATA_ROOT=/srv/learncoding \
  /usr/bin/node /opt/learncoding/infra/ops/prepare-object-storage.mjs
```

## Routine checks

```bash
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps file-erasure-worker
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml logs --since 30m file-erasure-worker
sudo docker compose --profile uploads --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml ps clamav scan-worker
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml exec -T postgres \
  psql -U learncoding -d learncoding -c "select scan_status, count(*) from stored_object where deleted_at is null group by scan_status order by scan_status;"
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml exec -T postgres \
  psql -U learncoding -d learncoding -c "select count(*) as overdue from stored_object where deleted_at is null and scan_status in ('pending','scanning') and created_at < now() - interval '5 minutes';"
```

Do not paste database rows or raw scanner logs into public issues. Operational logs intentionally contain only aggregate counts and stable error codes.

## State and retry behavior

The default lease is 180 seconds. A crashed worker's expired `scanning` lease is reclaimed. Transient clamd, socket, timeout, and protocol failures retry with exponential backoff from 5 seconds to 15 minutes. After eight attempts the object remains unavailable with `scanner_error`. Invalid paths, missing files, symlinks, size changes, or digest changes become `scanner_error` immediately because retrying cannot safely repair them.

Changing retry settings requires an operator review. Keep the lease longer than `CLAMD_TIMEOUT_SECONDS` plus worst-case database latency. Never mount the parent app-data directory or widen write access beyond the exact reviewed objects bind.

## Safe smoke test

1. Upload a harmless small `.txt` file through a non-admin learner account.
2. Confirm the API initially reports `pending` and download returns HTTP 423.
3. Confirm a later list reports `safe`, download succeeds with attachment/no-store headers, and scanner logs contain only aggregate counters.
4. In a maintenance window, optionally upload the official EICAR anti-malware test string from a disposable learner account. Confirm the row becomes `quarantined`, download remains HTTP 423, then delete the object through the app. Never email or commit the EICAR fixture.

## Scanner outage

If clamd is unhealthy, uploads remain quarantined and learning features continue. The upload scanner fails health with ClamAV while the independent file-erasure worker continues consuming deletions; an exhausted erasure job makes that worker unhealthy and emits only an aggregate exhausted-count event. Check container health, signature-volume capacity, DNS and outbound access for signature updates, then inspect aggregate logs. Do not update rows to `safe` manually. Once clamd is healthy, restart only `scan-worker` if it has not recovered automatically; pending jobs retain their attempt count and retry schedule.

If objects reached `scanner_error` solely because of a verified scanner outage, an operator may requeue them after incident resolution:

```sql
update stored_object
   set scan_status = 'pending',
       scan_attempts = 0,
       scan_error_code = null,
       scan_next_attempt_at = now(),
       scan_lease_token = null,
       scan_lease_expires_at = null,
       updated_at = now()
 where deleted_at is null
   and scan_status = 'scanner_error'
   and scan_error_code in ('scanner_unavailable', 'scanner_protocol');
```

Run that statement only through an audited admin database session and record the incident. Never requeue `path_invalid`, `file_missing`, or `file_changed` without reconciling storage from a verified backup.

## Detected malware

Treat any `quarantined` object as untrusted. Do not download, inspect, copy, email, or submit its contents to an AI provider. Record only the object ID in a restricted incident record, notify the learner without disclosing a malware signature, and delete through the application after review. If multiple detections occur, follow the incident-response runbook and assess account compromise. The current release leaves bytes in the protected object store so quota accounting and audited deletion remain consistent; it never moves or executes them.
